import type { ToolDefinition } from '../types';

// ============================================================================
// Voice Status
// ============================================================================

export const VoiceStatusEnum = {
  DISCONNECTED: 'DISCONNECTED',
  CONNECTING: 'CONNECTING',
  CONNECTED: 'CONNECTED',
} as const;

export type VoiceStatus = (typeof VoiceStatusEnum)[keyof typeof VoiceStatusEnum];

// ============================================================================
// Audio Format Metadata
// ============================================================================

export type AudioEncoding =
  | 'pcm16'
  | 'pcm32f'
  | 'g711_ulaw'
  | 'g711_alaw'
  | 'opus'
  | 'mp3'
  | 'aac';

export interface AudioFormat {
  encoding: AudioEncoding;
  sampleRate: number;
  channels: number;
}

// ============================================================================
// Voice Agent Configuration (provider-agnostic)
// ============================================================================

export interface VoiceAgentConfig {
  name: string;
  instructions: string;
  tools?: ToolDefinition[];
  voice?: string;
  handoffs?: VoiceAgentConfig[];
  /** Lifecycle hooks */
  onConnect?: () => void | Promise<void>;
  onDisconnect?: () => void | Promise<void>;
  /** Middleware that wraps every tool execution */
  toolMiddleware?: ToolMiddleware[];
  /** Initial greeting to send on connect (set to false to disable) */
  greeting?: string | false;
  /** Turn detection mode */
  turnDetection?: 'server_vad' | 'push_to_talk' | 'none';
  /** Input audio format hint */
  inputAudioFormat?: Partial<AudioFormat>;
  /** Output audio format hint */
  outputAudioFormat?: Partial<AudioFormat>;
}

export type ToolMiddleware = (
  toolName: string,
  params: unknown,
  next: (params: unknown) => Promise<unknown>
) => Promise<unknown>;

// ============================================================================
// Session Events (normalized across all providers)
// ============================================================================

export type DisconnectReason =
  /** The app called disconnect() */
  | 'client'
  /** The provider ended the session */
  | 'server'
  /** The network/transport dropped (ICE failure, socket closed unexpectedly) */
  | 'transport'
  /** A fatal error ended the session */
  | 'error';

export interface StatusChangeDetail {
  reason?: DisconnectReason;
  error?: Error;
  /** Set by adapters when CONNECTING is a reconnect attempt on a live session */
  reconnecting?: boolean;
  attempt?: number;
}

export interface DisconnectInfo {
  reason: DisconnectReason;
  error?: Error;
}

export type ResponseStatus = 'completed' | 'cancelled' | 'failed' | 'incomplete';

export interface ResponseInfo {
  responseId?: string;
}

export interface ResponseDoneInfo extends ResponseInfo {
  status: ResponseStatus;
}

export interface AssistantSpeechInfo {
  itemId?: string;
  responseId?: string;
}

export interface InterruptionInfo {
  /** Assistant item that was cut off */
  itemId: string;
  /** Milliseconds of assistant audio played before the cut, when known */
  audioEndMs?: number;
}

/** Provider-neutral conversation item, used to reconcile the transcript. */
export interface HistoryItem {
  itemId: string;
  role: 'user' | 'assistant';
  text: string;
  status?: 'in_progress' | 'completed' | 'incomplete';
}

export interface RequestResponseOptions {
  /** One-off instructions for this response only */
  instructions?: string;
}

/**
 * Events emitted by adapter sessions. Adapters signal connection changes via
 * `status_change`; the higher-level `connected` / `disconnected` lifecycle
 * events are derived by `SessionController` (see `VoiceKitEvents`).
 */
export interface SessionEvents {
  [event: string]: (...args: any[]) => void;
  status_change: (status: VoiceStatus, detail?: StatusChangeDetail) => void;
  user_speech_started: () => void;
  user_speech_ended: (durationMs: number) => void;
  user_transcript: (data: TranscriptData) => void;
  assistant_transcript: (data: TranscriptData) => void;
  assistant_speech_started: (info: AssistantSpeechInfo) => void;
  assistant_speech_ended: (info: AssistantSpeechInfo) => void;
  response_started: (info: ResponseInfo) => void;
  response_done: (info: ResponseDoneInfo) => void;
  interrupted: (info: InterruptionInfo) => void;
  history_updated: (items: HistoryItem[]) => void;
  tool_call_start: (name: string, input: unknown) => void;
  tool_call_end: (name: string, input: unknown, output: unknown) => void;
  agent_handoff: (from: string, to: string) => void;
  guardrail_tripped: (info: unknown) => void;
  audio_delta: (itemId: string, delta: string) => void;
  vad: (event: VADEvent) => void;
  barge_in: (info: BargeInEvent) => void;
  error: (error: Error) => void;
  /** Escape hatch for provider-specific events not covered by normalized types */
  raw_event: (event: unknown) => void;
}

/** Session lifecycle events emitted by `SessionController`, never by adapters. */
export interface LifecycleEvents {
  connected: () => void;
  disconnected: (info: DisconnectInfo) => void;
  reconnecting: (info: { attempt?: number }) => void;
  reconnected: () => void;
}

export type VoiceKitEvents = SessionEvents & LifecycleEvents;

/** Anything you can subscribe to: a raw session or a `SessionController`. */
export interface VoiceEventSource<Events extends SessionEvents = SessionEvents> {
  on<E extends string & keyof Events>(event: E, handler: Events[E]): void;
  off<E extends string & keyof Events>(event: E, handler: Events[E]): void;
}

export interface TranscriptData {
  itemId: string;
  delta?: string;
  text?: string;
  isFinal: boolean;
}

export interface VADEvent {
  type: 'speech_start' | 'speech_end' | 'silence';
  /** RMS energy level (0..1) at the time of the event */
  energy?: number;
  /** Duration of the speech or silence segment in ms */
  durationMs?: number;
  timestamp: number;
}

export interface BargeInEvent {
  /** ID of the assistant item that was interrupted */
  interruptedItemId: string;
  /** How many ms of audio the assistant had played before interruption */
  audioPlayedMs: number;
  /** Estimated fraction of the response that was spoken (0..1) */
  fractionSpoken: number;
  /** The full text the assistant intended to speak */
  fullText?: string;
  /** The truncated text that was actually heard by the user */
  spokenText?: string;
  timestamp: number;
}

// ============================================================================
// Voice Session (what the provider creates)
// ============================================================================

export interface VoiceSession extends VoiceEventSource<SessionEvents> {
  connect(config: ConnectConfig): Promise<void>;
  /**
   * Tear down the session. Must not emit `status_change` — the caller already
   * knows it disconnected. Emit `DISCONNECTED` only for drops the session
   * did not initiate.
   */
  disconnect(): Promise<void>;
  sendMessage(text: string): void | Promise<void>;
  interrupt(): void;
  mute(muted: boolean): void;

  /** Ask the assistant to speak now (e.g. a greeting) without user input. */
  requestResponse?(options?: RequestResponseOptions): void;
  /** Begin a push-to-talk turn (discard buffered input audio). */
  pushToTalkStart?(): void;
  /** End a push-to-talk turn and ask for a response. */
  pushToTalkStop?(): void;
  /** Escape hatch: send a provider-specific event. */
  sendRawEvent?(event: Record<string, unknown>): void;
}

export interface ConnectConfig {
  /** Authentication token/key obtained from server handler */
  authToken: string;
  /** HTML audio element for playback */
  audioElement?: HTMLAudioElement;
  /** Extra context passed to the session */
  context?: Record<string, unknown>;
  /** Output guardrails */
  outputGuardrails?: unknown[];
}

// ============================================================================
// Voice Adapter (the provider factory)
// ============================================================================

export interface SessionOptions {
  model?: string;
  language?: string;
  codec?: string;
  voice?: string;
  /** Provider-specific options */
  [key: string]: unknown;
}

export interface VoiceAdapter {
  /** Unique name for this adapter (e.g. 'openai', 'livekit') */
  readonly name: string;
  /** Create a session for the given agent */
  createSession(agent: VoiceAgentConfig, options?: SessionOptions): VoiceSession;
}

// ============================================================================
// Server-side types
// ============================================================================

export interface ServerSessionConfig {
  /** Provider-specific API key */
  apiKey?: string;
  model?: string;
  voice?: string;
  instructions?: string;
  expiresIn?: number;
  /** Provider-specific options */
  [key: string]: unknown;
}

export interface ServerAdapter {
  createSessionHandler(config?: ServerSessionConfig): (request?: Request) => Promise<Response>;
  getSessionToken(config?: ServerSessionConfig): Promise<
    { token: string; error?: string } | { token?: string; error: string }
  >;
}
