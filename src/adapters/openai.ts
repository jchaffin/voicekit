/**
 * OpenAI Realtime API adapter for VoiceKit.
 *
 * Usage:
 * ```ts
 * import { openai } from '@jchaffin/voicekit/openai';
 *
 * <VoiceProvider adapter={openai({ model: 'gpt-realtime-2.1' })} agent={agent}>
 * ```
 *
 * Peer dependency: @openai/agents (>= 0.0.15)
 */

import {
  RealtimeSession,
  RealtimeAgent,
  OpenAIRealtimeWebRTC,
  tool as sdkTool,
} from '@openai/agents/realtime';
import { EventEmitter } from '../core/EventEmitter';
import { VoiceError } from '../core/errors';
import { emitToolResult } from '../tools';
import type {
  VoiceAdapter,
  VoiceSession,
  VoiceAgentConfig,
  SessionOptions,
  SessionEvents,
  ConnectConfig,
  ServerSessionConfig,
  ServerAdapter,
  HistoryItem,
  RequestResponseOptions,
  ResponseStatus,
} from '../core/types';
import type { ToolDefinition } from '../types';
import type { ToolMiddleware } from '../core/types';

/** Server errors that are expected during normal barge-in / overlapping turns. */
const BENIGN_ERROR_CODES = new Set([
  'response_cancel_not_active',
  'conversation_already_has_active_response',
]);

function contentText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((c) => {
      if (!c || typeof c !== 'object') return '';
      const part = c as Record<string, unknown>;
      if (part.type === 'input_text' || part.type === 'output_text') return (part.text as string) ?? '';
      if (part.type === 'audio' || part.type === 'input_audio' || part.type === 'output_audio') {
        return (part.transcript as string) ?? '';
      }
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function toHistoryItem(raw: unknown): HistoryItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Record<string, unknown>;
  if (item.type !== 'message') return null;
  const itemId = (item.itemId as string) || (item.id as string);
  if (!itemId || (item.role !== 'user' && item.role !== 'assistant')) return null;
  const status = item.status as HistoryItem['status'];
  return { itemId, role: item.role, text: contentText(item.content), ...(status && { status }) };
}

function toResponseStatus(status: unknown): ResponseStatus {
  return status === 'cancelled' || status === 'failed' || status === 'incomplete' ? status : 'completed';
}

function toOpenAIError(err: unknown): VoiceError {
  if (err instanceof VoiceError) return err;
  // SDK wraps server errors as { type: 'error', error: { type: 'error', error: { code, message } } }
  let node: unknown = err;
  for (let i = 0; i < 3 && node && typeof node === 'object' && !(node instanceof Error); i++) {
    const inner = (node as Record<string, unknown>).error;
    if (!inner || typeof inner !== 'object') break;
    node = inner;
  }
  const obj = (node && typeof node === 'object' ? node : {}) as Record<string, unknown>;
  const message =
    node instanceof Error ? node.message
      : typeof obj.message === 'string' ? obj.message
        : typeof err === 'string' ? err
          : JSON.stringify(err);
  const code = typeof obj.code === 'string' ? obj.code : undefined;
  return new VoiceError(message, { code, provider: 'openai', cause: err });
}

function extractAssistantTextFromOutput(output: unknown): { itemId: string; text: string } | null {
  if (!Array.isArray(output)) return null;
  for (let i = output.length - 1; i >= 0; i--) {
    const item = output[i] as Record<string, unknown>;
    if (item.type !== 'message' || item.role !== 'assistant') continue;
    const itemId = (item.id as string) || '';
    if (!itemId) continue;
    const content = item.content;
    if (!Array.isArray(content)) continue;
    for (let j = content.length - 1; j >= 0; j--) {
      const part = content[j] as Record<string, unknown>;
      if (part.type === 'output_text' && typeof part.text === 'string' && part.text.trim()) {
        return { itemId, text: part.text };
      }
      if (part.type === 'output_audio' && typeof part.transcript === 'string' && part.transcript.trim()) {
        return { itemId, text: part.transcript };
      }
    }
  }
  return null;
}

// ============================================================================
// Tool conversion: VoiceKit ToolDefinition -> OpenAI SDK tool
// ============================================================================

function applyMiddleware(
  toolName: string,
  execute: (input: unknown) => Promise<unknown> | unknown,
  middleware: ToolMiddleware[] | undefined,
): (input: unknown) => Promise<unknown> {
  if (!middleware?.length) return (input) => Promise.resolve(execute(input));
  return (input) =>
    middleware.reduceRight<(params: unknown) => Promise<unknown>>(
      (next, mw) => (params) => mw(toolName, params, next),
      (params) => Promise.resolve(execute(params)),
    )(input);
}

function convertTool(def: ToolDefinition, middleware?: ToolMiddleware[]) {
  const wrappedExecute = applyMiddleware(def.name, def.execute as (input: unknown) => unknown, middleware);
  return sdkTool({
    name: def.name,
    description: def.description,
    parameters: {
      type: 'object',
      properties: def.parameters.properties,
      required: def.parameters.required || [],
      additionalProperties: false,
    },
    execute: async (input: unknown) => {
      try {
        const result = await wrappedExecute(input);
        emitToolResult(def.name, input, result);
        return result;
      } catch (error) {
        const errorResult = { success: false, error: String(error) };
        emitToolResult(def.name, input, errorResult);
        return errorResult;
      }
    },
  });
}

// ============================================================================
// OpenAI Session
// ============================================================================

class OpenAISession
  extends EventEmitter<SessionEvents>
  implements VoiceSession
{
  private session: RealtimeSession | null = null;
  private agent: RealtimeAgent;
  private options: SessionOptions;
  private responseInFlight = false;
  /** itemId of the assistant response currently streaming audio/transcript deltas. */
  private currentSpeakingItemId: string | null = null;
  private userSpeechStartMs: number | null = null;

  constructor(agent: RealtimeAgent, options: SessionOptions) {
    super();
    this.agent = agent;
    this.options = options;
  }

  async connect(config: ConnectConfig): Promise<void> {
    const audioElement = config.audioElement;

    const transcription: Record<string, unknown> = {
      model: (this.options.transcriptionModel as string) || 'gpt-4o-transcribe',
      language: (this.options.language as string) || 'en',
    };
    if (this.options.transcriptionPrompt) {
      transcription.prompt = this.options.transcriptionPrompt;
    }

    const sessionConfig: Record<string, unknown> = {
      inputAudioFormat: this.options.codec === 'g711' ? 'g711_ulaw' : 'pcm16',
      outputAudioFormat: this.options.codec === 'g711' ? 'g711_ulaw' : 'pcm16',
      inputAudioTranscription: transcription,
    };
    if (this.options.turnDetection) {
      const turnDetection = this.options.turnDetection;
      sessionConfig.turnDetection =
        typeof turnDetection === 'object'
          ? { type: 'server_vad', ...turnDetection }
          : { type: turnDetection };
    }

    this.session = new RealtimeSession(this.agent, {
      transport: new OpenAIRealtimeWebRTC({
        audioElement,
        ...(this.options.codec === 'g711' && {
          changePeerConnection: async (pc: RTCPeerConnection) => {
            pc.getTransceivers().forEach((transceiver) => {
              if (transceiver.sender.track?.kind === 'audio') {
                transceiver.setCodecPreferences([
                  { mimeType: 'audio/PCMU', clockRate: 8000 },
                  { mimeType: 'audio/PCMA', clockRate: 8000 },
                ]);
              }
            });
            return pc;
          },
        }),
      }),
      model: (this.options.model as string) || 'gpt-realtime-2.1',
      config: sessionConfig,
      outputGuardrails: (config.outputGuardrails ?? []) as any,
      context: config.context ?? {},
    });

    this.wireEvents(this.session);
    this.wireTransportDisconnect(this.session);
    await this.session.connect({ apiKey: config.authToken });
    this.emit('status_change', 'CONNECTED');
  }

  async disconnect(): Promise<void> {
    const s = this.session;
    this.session = null;
    this.removeAllListeners();
    if (s) {
      try { s.close(); } catch {}
    }
  }

  async sendMessage(text: string): Promise<void> {
    if (!this.session) throw new Error('Session not connected');

    // Stop audio only — do not synthesize truncation (that was wiping prior turns).
    this.session.interrupt();

    if (this.responseInFlight) {
      await new Promise<void>((resolve) => {
        const onDone = () => {
          clearTimeout(timeoutId);
          this.off('response_done', onDone);
          resolve();
        };
        this.on('response_done', onDone);
        const timeoutId = setTimeout(onDone, 1500);
      });
    }

    this.session.sendMessage(text);
  }

  interrupt(): void {
    this.session?.interrupt();
  }

  mute(muted: boolean): void {
    this.session?.mute(muted);
  }

  requestResponse(options?: RequestResponseOptions): void {
    this.sendRawEvent({
      type: 'response.create',
      ...(options?.instructions && { response: { instructions: options.instructions } }),
    });
  }

  pushToTalkStart(): void {
    this.sendRawEvent({ type: 'input_audio_buffer.clear' });
  }

  pushToTalkStop(): void {
    this.sendRawEvent({ type: 'input_audio_buffer.commit' });
    this.sendRawEvent({ type: 'response.create' });
  }

  sendRawEvent(event: Record<string, unknown>): void {
    this.session?.transport.sendEvent(event as any);
  }

  /**
   * The SDK's RealtimeSession doesn't propagate transport-level connection
   * state changes. Listen directly on the transport so we detect drops
   * (ICE failure, server-side close, network loss) and surface them.
   */
  private wireTransportDisconnect(session: RealtimeSession): void {
    const transport = session.transport as any;
    if (typeof transport?.on !== 'function') return;

    transport.on('connection_change', (status: string) => {
      if (status === 'disconnected' && this.session === session) {
        this.session = null;
        this.emit('status_change', 'DISCONNECTED', { reason: 'transport' });
        this.removeAllListeners();
      }
    });
  }

  // Map OpenAI SDK events -> normalized SessionEvents
  private wireEvents(session: RealtimeSession): void {
    session.on('transport_event', (event: Record<string, unknown>) => {
      const type = event.type as string;
      // High-frequency events already fully represented by normalized events
      // are not echoed to raw_event; everything else is, for logging/debugging.
      let echoRaw = true;

      switch (type) {
        case 'input_audio_buffer.speech_started':
          echoRaw = false;
          this.userSpeechStartMs = typeof event.audio_start_ms === 'number' ? event.audio_start_ms : null;
          this.emit('user_speech_started');
          break;

        case 'input_audio_buffer.speech_stopped': {
          const end = typeof event.audio_end_ms === 'number' ? event.audio_end_ms : null;
          const start = this.userSpeechStartMs;
          this.userSpeechStartMs = null;
          this.emit('user_speech_ended', start !== null && end !== null ? Math.max(0, end - start) : 0);
          break;
        }

        case 'conversation.item.input_audio_transcription.delta':
          echoRaw = false;
          this.emit('user_transcript', {
            itemId: event.item_id as string,
            delta: (event.delta as string) || '',
            isFinal: false,
          });
          break;

        case 'conversation.item.input_audio_transcription.completed':
          echoRaw = false;
          this.emit('user_transcript', {
            itemId: event.item_id as string,
            text: (event.transcript as string) || '',
            isFinal: true,
          });
          break;

        case 'response.audio_transcript.delta':
        case 'response.output_audio_transcript.delta':
        case 'response.output_text.delta': {
          echoRaw = false;
          const itemId = event.item_id as string;
          if (!itemId) break;
          this.currentSpeakingItemId = itemId;
          this.emit('assistant_transcript', {
            itemId,
            delta: (event.delta as string) || '',
            isFinal: false,
          });
          break;
        }

        case 'response.audio_transcript.done':
        case 'response.output_audio_transcript.done':
        case 'response.output_text.done': {
          echoRaw = false;
          const itemId = event.item_id as string;
          if (!itemId) break;
          this.currentSpeakingItemId = null;
          this.emit('assistant_transcript', {
            itemId,
            text: (event.transcript as string) || (event.text as string) || '',
            isFinal: true,
          });
          break;
        }

        case 'response.audio.delta':
        case 'response.output_audio.delta':
          echoRaw = false;
          this.emit('audio_delta', event.item_id as string, event.delta as string);
          break;

        case 'output_audio_buffer.started':
          this.emit('assistant_speech_started', {
            itemId: this.currentSpeakingItemId ?? undefined,
            responseId: event.response_id as string | undefined,
          });
          break;

        case 'output_audio_buffer.stopped':
        case 'output_audio_buffer.cleared':
          this.emit('assistant_speech_ended', {
            itemId: this.currentSpeakingItemId ?? undefined,
            responseId: event.response_id as string | undefined,
          });
          break;

        case 'response.created': {
          this.responseInFlight = true;
          const response = event.response as Record<string, unknown> | undefined;
          this.emit('response_started', { responseId: response?.id as string | undefined });
          break;
        }

        case 'response.done': {
          this.responseInFlight = false;
          const response = event.response as Record<string, unknown> | undefined;
          const assistant = extractAssistantTextFromOutput(response?.output);
          if (assistant) {
            this.currentSpeakingItemId = null;
            this.emit('assistant_transcript', {
              itemId: assistant.itemId,
              text: assistant.text,
              isFinal: true,
            });
          }
          this.emit('response_done', {
            responseId: response?.id as string | undefined,
            status: toResponseStatus(response?.status),
          });
          break;
        }

        case 'conversation.item.truncated': {
          const itemId = event.item_id as string;
          if (itemId) {
            this.emit('interrupted', {
              itemId,
              audioEndMs: typeof event.audio_end_ms === 'number' ? event.audio_end_ms : undefined,
            });
          }
          break;
        }
      }

      if (echoRaw) this.emit('raw_event', event);
    });

    session.on('agent_tool_start', ((...args: unknown[]) => {
      const functionCall = args[2] as Record<string, unknown> | undefined;
      if (functionCall) {
        this.emit('tool_call_start', functionCall.name as string, functionCall.arguments);
      }
    }) as any);

    session.on('agent_tool_end', ((...args: unknown[]) => {
      const functionCall = args[2] as Record<string, unknown> | undefined;
      const result = args[3];
      if (functionCall) {
        this.emit('tool_call_end', functionCall.name as string, functionCall.arguments, result);
      }
    }) as any);

    session.on('agent_handoff', ((...args: unknown[]) => {
      const item = args[0] as Record<string, unknown>;
      const context = item?.context as Record<string, unknown>;
      const history = context?.history as Record<string, unknown>[];
      if (history?.length) {
        const lastMessage = history[history.length - 1];
        const agentName = ((lastMessage.name as string) || '').split('transfer_to_').pop() || '';
        this.emit('agent_handoff', '', agentName);
      }
    }) as any);

    session.on('guardrail_tripped', ((...args: unknown[]) => {
      this.emit('guardrail_tripped', args);
    }) as any);

    session.on('history_updated', ((items: unknown) => {
      if (!Array.isArray(items)) return;
      const normalized = items.map(toHistoryItem).filter((i): i is HistoryItem => i !== null);
      this.emit('history_updated', normalized);
    }) as any);

    session.on('history_added', ((item: unknown) => {
      const normalized = toHistoryItem(item);
      if (normalized) this.emit('history_updated', [normalized]);
    }) as any);

    session.on('error', (error: unknown) => {
      const voiceError = toOpenAIError(error);
      if (voiceError.code && BENIGN_ERROR_CODES.has(voiceError.code)) return;
      if (!voiceError.code && Array.from(BENIGN_ERROR_CODES).some((c) => voiceError.message.includes(c))) return;
      this.emit('error', voiceError);
    });
  }
}

// ============================================================================
// Adapter factory
// ============================================================================

export interface OpenAIAdapterOptions extends SessionOptions {
  model?: string;
  language?: string;
  codec?: string;
  voice?: string;
  transcriptionModel?: string;
  /** Vocabulary hint for input transcription (domain terms, names, etc.). */
  transcriptionPrompt?: string;
  /** Server VAD turn detection config. */
  turnDetection?: {
    type?: 'server_vad';
    threshold?: number;
    prefix_padding_ms?: number;
    silence_duration_ms?: number;
    create_response?: boolean;
  };
}

/**
 * Create an OpenAI Realtime adapter.
 *
 * ```ts
 * import { openai } from '@jchaffin/voicekit/openai';
 * <VoiceProvider adapter={openai()} agent={agent} />
 * ```
 */
export function openai(options: OpenAIAdapterOptions = {}): VoiceAdapter {
  return {
    name: 'openai',

    createSession(agentConfig: VoiceAgentConfig, sessionOpts?: SessionOptions): VoiceSession {
      const merged: SessionOptions = { ...options, ...sessionOpts };
      const agent = buildRealtimeAgent(agentConfig);
      return new OpenAISession(agent, merged);
    },
  };
}

function buildRealtimeAgent(config: VoiceAgentConfig): RealtimeAgent {
  const tools = (config.tools || []).map((t) => convertTool(t, config.toolMiddleware));
  const handoffs = (config.handoffs || []).map(buildRealtimeAgent);
  return new RealtimeAgent({
    name: config.name,
    instructions: config.instructions,
    tools,
    ...(handoffs.length > 0 && { handoffs }),
  });
}

// ============================================================================
// Server adapter
// ============================================================================

export interface OpenAIServerConfig extends ServerSessionConfig {
  apiKey?: string;
  model?: string;
  voice?: string;
  instructions?: string;
  expiresIn?: number;
}

export function openaiServer(config: OpenAIServerConfig = {}): ServerAdapter {
  const getSessionToken = async (overrides: ServerSessionConfig = {}) => {
    const merged = { ...config, ...overrides };
    const apiKey = merged.apiKey || process.env.OPENAI_API_KEY;

    if (!apiKey) return { error: 'OpenAI API key not configured' };

    try {
      const response = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          expires_after: {
            anchor: 'created_at',
            seconds: (merged.expiresIn as number) || 600,
          },
          session: {
            type: 'realtime',
            model: (merged.model as string) || 'gpt-realtime-2.1',
            ...(merged.voice && { audio: { output: { voice: merged.voice } } }),
            ...(merged.instructions && { instructions: merged.instructions }),
          },
        }),
      });

      if (!response.ok) {
        const text = await response.text();
        console.error('OpenAI client_secrets error:', text);
        return { error: `OpenAI API error: ${response.status}` };
      }

      const data = await response.json();
      if (!data.value) return { error: 'Invalid response from OpenAI' };
      return { token: data.value };
    } catch (err) {
      return { error: String(err) };
    }
  };

  return {
    getSessionToken,

    createSessionHandler(overrides?: ServerSessionConfig) {
      return async (_request?: Request): Promise<Response> => {
        const result = await getSessionToken(overrides);
        if (result.error) {
          return Response.json({ error: result.error }, { status: 500 });
        }
        return Response.json({ ephemeralKey: result.token });
      };
    },
  };
}

export default openai;
