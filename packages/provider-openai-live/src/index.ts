import {
  VOICEKIT_PROTOCOL_VERSION,
  type CapabilityOffer,
  type ErrorDescriptor,
  type EventEnvelope,
  type JsonValue,
  type VoiceKitEvent,
} from "@jchaffin/voicekit-protocol";

export const OPENAI_LIVE_MODEL = "gpt-live-1" as const;
export const OPENAI_LIVE_ENDPOINT = "live" as const;

export const openAILiveCapabilities = {
  protocolVersions: [VOICEKIT_PROTOCOL_VERSION],
  capabilities: [
    { name: "voice.full_duplex", version: "1.0", required: true },
    { name: "voice.interruption", version: "1.0" },
    { name: "voice.transcripts", version: "1.0" },
    { name: "delegation.responses", version: "1.0" },
    { name: "delegation.client", version: "1.0" },
    { name: "tools", version: "1.0" },
    { name: "confirmations", version: "1.0" },
    { name: "usage.duration", version: "1.0" },
    { name: "transport.webrtc", version: "1.0" },
    { name: "transport.websocket", version: "1.0" },
    { name: "transport.sip", version: "1.0" },
    { name: "transport.sideband", version: "1.0" },
  ],
} as const satisfies CapabilityOffer;

export type Awaitable<T> = T | Promise<T>;
export type DelegationMode = "responses" | "client";
export type ControllerState = "idle" | "starting" | "active" | "closing" | "closed" | "failed";

export interface OpenAILiveTool {
  name: string;
  description?: string;
  parameters?: Readonly<Record<string, JsonValue>>;
}

export interface ResponsesBackendConfig {
  type: "responses";
  /** The backend model is independent of the fixed gpt-live-1 voice model. */
  model: string;
  instructions?: string;
  tools?: readonly Readonly<Record<string, JsonValue>>[];
  toolChoice?: "auto" | "required" | "none" | Readonly<Record<string, JsonValue>>;
  parallelToolCalls?: boolean;
  maxOutputTokens?: number;
  serviceTier?: "auto" | "default" | "flex" | "priority";
  reasoning?: Readonly<Record<string, JsonValue>>;
  text?: Readonly<Record<string, JsonValue>>;
}

export interface ClientBackendConfig {
  type: "client";
  /** Informational identity for an application-owned model, agent, or service. */
  agent: string;
  model?: string;
  metadata?: Readonly<Record<string, JsonValue>>;
}

export type OpenAILiveBackendConfig = ResponsesBackendConfig | ClientBackendConfig;

export interface DelegationCancellationPolicy {
  /** Interruption affects voice playback only unless explicitly set to cancel. */
  onInterruption: "continue" | "cancel";
  /**
   * Responses work follows OpenAI close semantics. This setting controls
   * application-owned client tasks when the voice session closes.
   */
  onSessionClose: "cancel" | "detach";
}

export const defaultDelegationCancellationPolicy: Readonly<DelegationCancellationPolicy> = Object.freeze({
  onInterruption: "continue",
  onSessionClose: "cancel",
});

export interface OpenAILiveSessionOptions {
  backend: OpenAILiveBackendConfig;
  instructions?: string;
  voice?: string;
  language?: string;
  tools?: readonly OpenAILiveTool[];
  acknowledgementDelayMs?: number;
  providerOptions?: Readonly<Record<string, JsonValue>>;
  cancellation?: Partial<DelegationCancellationPolicy>;
}

export interface WebRTCConnectionDescriptor {
  kind: "webrtc";
  sessionId: string;
  answerSdp: string;
  callId?: string;
  sideband?: SidebandConnectionDescriptor;
}

export interface WebSocketConnectionDescriptor {
  kind: "websocket";
  sessionId?: string;
  url: string;
  protocols?: readonly string[];
}

export interface SIPConnectionDescriptor {
  kind: "sip";
  sessionId: string;
  callId: string;
  controlUrl?: string;
  sideband?: SidebandConnectionDescriptor;
}

export interface SidebandConnectionDescriptor {
  kind: "sideband";
  sessionId: string;
  url: string;
}

export type PrimaryConnectionDescriptor =
  | WebRTCConnectionDescriptor
  | WebSocketConnectionDescriptor
  | SIPConnectionDescriptor;

export type OpenAILiveConnectionDescriptor = PrimaryConnectionDescriptor | SidebandConnectionDescriptor;

export interface OpenAILiveSessionCreateRequest {
  endpoint: typeof OPENAI_LIVE_ENDPOINT;
  session: {
    model: typeof OPENAI_LIVE_MODEL;
    delegation:
      | { type: "responses"; responses: Omit<ResponsesBackendConfig, "type"> }
      | { type: "client" };
    instructions?: string;
    voice?: string;
    language?: string;
    tools?: readonly OpenAILiveTool[];
    acknowledgement_delay_ms?: number;
    provider_options?: Readonly<Record<string, JsonValue>>;
  };
  connection: OpenAILiveConnectionRequest;
  signal?: AbortSignal;
}

export type OpenAILiveConnectionRequest =
  | { kind: "webrtc"; offerSdp: string }
  | { kind: "websocket" }
  | { kind: "sip"; callId: string };

export interface OpenAILiveTransport {
  readonly descriptor: PrimaryConnectionDescriptor;
  send(event: OpenAILiveClientEvent): Awaitable<void>;
  close(): Awaitable<void>;
  onEvent(listener: (event: unknown) => void): (() => void) | void;
}

/**
 * Implement this interface with an official SDK, fetch/WebRTC, WebSocket, or
 * telephony integration. This package deliberately does not pretend to own a
 * network stack.
 */
export interface OpenAILiveClient {
  createSession(request: OpenAILiveSessionCreateRequest): Awaitable<OpenAILiveTransport>;
  attachSideband?(descriptor: SidebandConnectionDescriptor, signal?: AbortSignal): Awaitable<OpenAILiveTransport>;
}

export type OpenAILiveClientEvent =
  | { type: "session.input_audio.append"; audio: string; event_id?: string }
  | { type: "session.instructions.append"; content: string; delegation_id: string | null; event_id?: string }
  | { type: "session.thinking.append"; content: string; delegation_id: string | null; event_id?: string }
  | { type: "session.commentary.append"; content: string; delegation_id: string | null; event_id?: string }
  | { type: "response.item.create"; item: Readonly<Record<string, JsonValue>>; event_id?: string }
  | { type: "response.create"; event_id?: string }
  | { type: "session.close"; event_id?: string };

export type NormalizedOpenAILiveServerEvent =
  | { type: "session.started"; eventId: string; sessionId: string; session?: JsonValue }
  | { type: "session.closing"; eventId: string; reason?: string }
  | { type: "session.closed"; eventId: string; reason: string; usageSeconds?: number; session?: JsonValue }
  | { type: "input.speech.started"; eventId: string; turnId: string; offsetMs?: number }
  | { type: "input.speech.stopped"; eventId: string; turnId: string; offsetMs?: number }
  | { type: "output.speech.started"; eventId: string; turnId: string; offsetMs?: number }
  | { type: "output.speech.stopped"; eventId: string; turnId: string; reason: "completed" | "interrupted" | "cancelled"; offsetMs?: number }
  | { type: "transcript.delta"; eventId: string; participant: "user" | "agent"; turnId: string; text: string; startMs?: number; endMs?: number }
  | { type: "delegation.created"; eventId: string; delegationId: string; target: DelegationMode; responseId?: string; offsetMs?: number }
  | { type: "delegation.progress"; eventId: string; delegationId: string; content: string; responseEvent?: JsonValue }
  | { type: "delegation.completed"; eventId: string; delegationId: string; responseId?: string; usage?: BackendUsage }
  | { type: "delegation.failed"; eventId: string; delegationId: string; error: ErrorDescriptor }
  | { type: "delegation.cancelled"; eventId: string; delegationId: string; reason?: string }
  | { type: "tool.requested"; eventId: string; delegationId: string; callId: string; name: string; arguments: JsonValue; toolType: string }
  | { type: "confirmation.requested"; eventId: string; delegationId: string; requestId: string; name?: string; details?: JsonValue }
  | { type: "interruption"; eventId: string; turnId?: string; by: "user" | "agent" | "system" }
  | { type: "usage.updated"; eventId: string; seconds: number; contextUsageRatio?: number }
  | { type: "error"; eventId: string; error: ErrorDescriptor; fatal: boolean }
  | { type: "unknown"; eventId: string; raw: JsonValue };

export interface BackendUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  raw?: JsonValue;
}

export interface ClientDelegationContext {
  delegationId: string;
  sessionId: string;
  backend: ClientBackendConfig;
  transcripts: readonly TranscriptFragment[];
  signal: AbortSignal;
  progress(update: ClientDelegationUpdate): Promise<void>;
}

export interface TranscriptFragment {
  participant: "user" | "agent";
  turnId: string;
  text: string;
  startMs?: number;
  endMs?: number;
}

export interface ClientDelegationUpdate {
  content: string;
  delivery: "thinking" | "commentary";
}

export interface ClientDelegationResult {
  content?: string;
  delivery?: "thinking" | "commentary";
  usage?: BackendUsage;
}

export interface ClientDelegationExecutor {
  execute(context: ClientDelegationContext): Promise<ClientDelegationResult>;
}

export type OpenAILivePackageEvent =
  | { type: "session.started"; sessionId: string; connection: PrimaryConnectionDescriptor }
  | { type: "session.closing"; reason?: string }
  | { type: "session.closed"; reason: string; clean: boolean; finalUsageConfirmed: boolean }
  | { type: "voice.listening"; active: boolean; turnId: string }
  | { type: "voice.speaking"; active: boolean; turnId: string; reason?: "completed" | "interrupted" | "cancelled" }
  | { type: "delegation.requested"; delegationId: string; target: DelegationMode; responseId?: string }
  | { type: "delegation.started"; delegationId: string; target: DelegationMode; responseId?: string }
  | { type: "delegation.progress"; delegationId: string; content?: string; responseEvent?: JsonValue }
  | { type: "delegation.completed"; delegationId: string; responseId?: string; usage?: BackendUsage }
  | { type: "delegation.failed"; delegationId: string; error: ErrorDescriptor }
  | { type: "delegation.cancelled"; delegationId: string; reason: string }
  | { type: "interruption"; turnId?: string; by: "user" | "agent" | "system"; cancelledDelegations: readonly string[] }
  | { type: "tool.requested"; delegationId: string; callId: string; name: string; arguments: JsonValue; toolType: string }
  | { type: "confirmation.requested"; delegationId: string; requestId: string; name?: string; details?: JsonValue }
  | { type: "usage"; voiceSeconds: number; final: boolean; confirmed: boolean; contextUsageRatio?: number }
  | { type: "backend.usage"; delegationId: string; usage: BackendUsage }
  | { type: "error"; error: ErrorDescriptor; fatal: boolean }
  | { type: "provider.unknown"; raw: JsonValue };

export type OpenAILiveAdapterEvent =
  | { kind: "openai.live"; eventId: string; timestamp: string; event: OpenAILivePackageEvent }
  | { kind: "voicekit"; envelope: EventEnvelope };

export interface OpenAILiveControllerConfig {
  client: OpenAILiveClient;
  options: OpenAILiveSessionOptions;
  clientExecutor?: ClientDelegationExecutor;
  now?: () => Date;
  idFactory?: () => string;
}

interface DelegationRecord {
  id: string;
  target: DelegationMode;
  state: "requested" | "running" | "completed" | "failed" | "cancelled";
  responseId?: string;
  abortController?: AbortController;
}

export class OpenAILiveController {
  readonly capabilities = openAILiveCapabilities;
  readonly model = OPENAI_LIVE_MODEL;
  readonly endpoint = OPENAI_LIVE_ENDPOINT;

  #state: ControllerState = "idle";
  #sessionId: string | undefined;
  #transport: OpenAILiveTransport | undefined;
  #unsubscribe: (() => void) | undefined;
  #listeners = new Set<(event: OpenAILiveAdapterEvent) => void>();
  #seenEventIds = new Set<string>();
  #delegations = new Map<string, DelegationRecord>();
  #transcripts: TranscriptFragment[] = [];
  #sequence = 0;
  #lastVoiceSeconds = 0;
  #finalUsageConfirmed = false;
  #config: OpenAILiveControllerConfig;
  #cancellation: Readonly<DelegationCancellationPolicy>;
  #now: () => Date;
  #idFactory: () => string;

  constructor(config: OpenAILiveControllerConfig) {
    if (config.options.backend.type === "client" && !config.clientExecutor) {
      // Monitoring and manual result delivery remain valid without an executor.
    }
    this.#config = config;
    this.#cancellation = Object.freeze({
      ...defaultDelegationCancellationPolicy,
      ...config.options.cancellation,
    });
    this.#now = config.now ?? (() => new Date());
    this.#idFactory = config.idFactory ?? (() => crypto.randomUUID());
  }

  get state(): ControllerState {
    return this.#state;
  }

  get sessionId(): string | undefined {
    return this.#sessionId;
  }

  get connection(): PrimaryConnectionDescriptor | undefined {
    return this.#transport?.descriptor;
  }

  get cancellationPolicy(): Readonly<DelegationCancellationPolicy> {
    return this.#cancellation;
  }

  onEvent(listener: (event: OpenAILiveAdapterEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async start(connection: OpenAILiveConnectionRequest, signal?: AbortSignal): Promise<PrimaryConnectionDescriptor> {
    if (this.#state !== "idle") throw new Error(`Cannot start an OpenAI Live controller in state ${this.#state}`);
    throwIfAborted(signal);
    this.#state = "starting";
    try {
      const transport = await this.#config.client.createSession(this.#createRequest(connection, signal));
      throwIfAborted(signal);
      this.#transport = transport;
      const unsubscribe = transport.onEvent((raw) => this.consume(raw));
      this.#unsubscribe = typeof unsubscribe === "function" ? unsubscribe : undefined;
      return transport.descriptor;
    } catch (error) {
      this.#state = "failed";
      throw error;
    }
  }

  /**
   * Consumes either a normalized event or a raw GPT-Live server event.
   * Duplicate event_id values and duplicate terminal delegation transitions are no-ops.
   */
  consume(input: NormalizedOpenAILiveServerEvent | unknown): void {
    const event = isNormalizedEvent(input) ? input : normalizeOpenAILiveServerEvent(input);
    if (this.#seenEventIds.has(event.eventId)) return;
    this.#seenEventIds.add(event.eventId);

    switch (event.type) {
      case "session.started":
        this.#handleStarted(event);
        break;
      case "session.closing":
        this.#handleClosing(event);
        break;
      case "session.closed":
        this.#handleClosed(event);
        break;
      case "input.speech.started":
        this.#emitPackage(event.eventId, { type: "voice.listening", active: true, turnId: event.turnId });
        this.#emitCanonical({ type: "turn.started", data: { turnId: event.turnId, participant: "user" } }, event.eventId);
        break;
      case "input.speech.stopped":
        this.#emitPackage(event.eventId, { type: "voice.listening", active: false, turnId: event.turnId });
        this.#emitCanonical({ type: "turn.ended", data: { turnId: event.turnId, participant: "user", reason: "completed" } }, event.eventId);
        break;
      case "output.speech.started":
        this.#emitPackage(event.eventId, { type: "voice.speaking", active: true, turnId: event.turnId });
        this.#emitCanonical({ type: "turn.started", data: { turnId: event.turnId, participant: "agent" } }, event.eventId);
        break;
      case "output.speech.stopped":
        this.#emitPackage(event.eventId, { type: "voice.speaking", active: false, turnId: event.turnId, reason: event.reason });
        this.#emitCanonical({ type: "turn.ended", data: { turnId: event.turnId, participant: "agent", reason: event.reason } }, event.eventId);
        break;
      case "transcript.delta":
        this.#handleTranscript(event);
        break;
      case "delegation.created":
        this.#handleDelegationCreated(event);
        break;
      case "delegation.progress":
        this.#handleDelegationProgress(event);
        break;
      case "delegation.completed":
        this.#finishDelegation(event.delegationId, "completed", event.eventId, event);
        break;
      case "delegation.failed":
        this.#finishDelegation(event.delegationId, "failed", event.eventId, event);
        break;
      case "delegation.cancelled":
        this.#finishDelegation(event.delegationId, "cancelled", event.eventId, event);
        break;
      case "tool.requested":
        this.#emitPackage(event.eventId, {
          type: "tool.requested",
          delegationId: event.delegationId,
          callId: event.callId,
          name: event.name,
          arguments: event.arguments,
          toolType: event.toolType,
        });
        this.#emitCanonical({
          type: "tool.call_started",
          data: { callId: event.callId, name: event.name, arguments: event.arguments },
        }, event.eventId);
        break;
      case "confirmation.requested":
        this.#emitPackage(event.eventId, compact({
          type: "confirmation.requested",
          delegationId: event.delegationId,
          requestId: event.requestId,
          name: event.name,
          details: event.details,
        }) as OpenAILivePackageEvent);
        break;
      case "interruption":
        this.#handleInterruption(event);
        break;
      case "usage.updated":
        this.#recordVoiceUsage(event.eventId, event.seconds, false, true, event.contextUsageRatio);
        break;
      case "error":
        this.#emitPackage(event.eventId, { type: "error", error: event.error, fatal: event.fatal });
        this.#emitCanonical({ type: "error.occurred", data: { ...event.error, fatal: event.fatal } }, event.eventId);
        if (event.fatal) this.#state = "failed";
        break;
      case "unknown":
        this.#emitPackage(event.eventId, { type: "provider.unknown", raw: event.raw });
        this.#emitCanonical({
          type: "provider.raw",
          data: { provider: "openai-live", eventType: "unknown", payload: event.raw, receivedAt: this.#now().toISOString() },
        }, event.eventId);
        break;
    }
  }

  async appendAudio(audioBase64: string, eventId = this.#idFactory()): Promise<void> {
    await this.#send({ type: "session.input_audio.append", audio: audioBase64, event_id: eventId });
  }

  async appendDelegationUpdate(
    delegationId: string,
    content: string,
    delivery: "thinking" | "commentary",
    eventId = this.#idFactory(),
  ): Promise<void> {
    this.#requireClientDelegation(delegationId);
    await this.#send({
      type: delivery === "commentary" ? "session.commentary.append" : "session.thinking.append",
      delegation_id: delegationId,
      content,
      event_id: eventId,
    });
  }

  async submitToolResult(
    callId: string,
    output: JsonValue,
    options: { toolType?: string; eventId?: string; continueResponse?: boolean } = {},
  ): Promise<void> {
    this.#requireResponsesMode();
    const type = `${options.toolType ?? "function_call"}_output`;
    await this.#send({
      type: "response.item.create",
      event_id: options.eventId ?? this.#idFactory(),
      item: { type, call_id: callId, output },
    });
    if (options.continueResponse ?? true) {
      await this.#send({ type: "response.create", event_id: this.#idFactory() });
    }
  }

  async submitConfirmation(
    requestId: string,
    approve: boolean,
    eventId = this.#idFactory(),
  ): Promise<void> {
    this.#requireResponsesMode();
    await this.#send({
      type: "response.item.create",
      event_id: eventId,
      item: { type: "mcp_approval_response", approval_request_id: requestId, approve },
    });
    await this.#send({ type: "response.create", event_id: this.#idFactory() });
  }

  cancelDelegation(delegationId: string, reason = "application_cancelled"): boolean {
    const record = this.#delegations.get(delegationId);
    if (!record || isTerminal(record.state)) return false;
    record.state = "cancelled";
    record.abortController?.abort(new Error(reason));
    this.#emitPackage(this.#idFactory(), { type: "delegation.cancelled", delegationId, reason });
    return true;
  }

  async close(reason = "application_requested"): Promise<void> {
    if (this.#state === "closed" || this.#state === "closing") return;
    if (!this.#transport) {
      this.#state = "closed";
      return;
    }
    this.#state = "closing";
    this.#emitPackage(this.#idFactory(), { type: "session.closing", reason });
    if (this.#cancellation.onSessionClose === "cancel") this.#cancelClientDelegations("session_closing");
    await this.#send({ type: "session.close", event_id: this.#idFactory() });
  }

  async forceClose(): Promise<void> {
    if (this.#state === "closed") return;
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    await this.#transport?.close();
    this.#state = "closed";
  }

  #createRequest(connection: OpenAILiveConnectionRequest, signal?: AbortSignal): OpenAILiveSessionCreateRequest {
    const options = this.#config.options;
    const delegation = options.backend.type === "responses"
      ? { type: "responses" as const, responses: omitType(options.backend) }
      : { type: "client" as const };
    return compact({
      endpoint: OPENAI_LIVE_ENDPOINT,
      connection,
      signal,
      session: compact({
        model: OPENAI_LIVE_MODEL,
        delegation,
        instructions: options.instructions,
        voice: options.voice,
        language: options.language,
        tools: options.tools,
        acknowledgement_delay_ms: options.acknowledgementDelayMs,
        provider_options: options.providerOptions,
      }),
    }) as unknown as OpenAILiveSessionCreateRequest;
  }

  #handleStarted(event: Extract<NormalizedOpenAILiveServerEvent, { type: "session.started" }>): void {
    if (this.#state === "closed") return;
    this.#sessionId = event.sessionId;
    this.#state = "active";
    const descriptor = this.#transport?.descriptor;
    if (!descriptor) return;
    this.#emitPackage(event.eventId, { type: "session.started", sessionId: event.sessionId, connection: descriptor });
    this.#emitCanonical({
      type: "lifecycle.session_created",
      data: event.session === undefined ? {} : { configuration: event.session },
    }, event.eventId);
    this.#emitCanonical({
      type: "lifecycle.phase_changed",
      data: { from: "connecting", to: "ready" },
    }, `${event.eventId}:phase`);
  }

  #handleClosing(event: Extract<NormalizedOpenAILiveServerEvent, { type: "session.closing" }>): void {
    if (this.#state === "closed") return;
    this.#state = "closing";
    this.#emitPackage(event.eventId, compact({ type: "session.closing", reason: event.reason }) as OpenAILivePackageEvent);
    this.#emitCanonical({
      type: "lifecycle.phase_changed",
      data: compact({ from: "ready", to: "draining", reason: event.reason }),
    } as VoiceKitEvent, event.eventId);
    if (this.#cancellation.onSessionClose === "cancel") this.#cancelClientDelegations("session_closing");
  }

  #handleClosed(event: Extract<NormalizedOpenAILiveServerEvent, { type: "session.closed" }>): void {
    if (this.#state === "closed") return;
    this.#state = "closed";
    this.#finalUsageConfirmed = event.usageSeconds !== undefined;
    if (event.usageSeconds !== undefined) {
      this.#recordVoiceUsage(`${event.eventId}:usage`, event.usageSeconds, true, true);
    }
    this.#emitPackage(event.eventId, {
      type: "session.closed",
      reason: event.reason,
      clean: event.reason !== "connection_lost",
      finalUsageConfirmed: this.#finalUsageConfirmed,
    });
    this.#emitCanonical({
      type: "lifecycle.session_closed",
      data: { reason: event.reason, clean: event.reason !== "connection_lost" },
    }, event.eventId);
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    void this.#transport?.close();
  }

  #handleTranscript(event: Extract<NormalizedOpenAILiveServerEvent, { type: "transcript.delta" }>): void {
    const fragment = compact({
      participant: event.participant,
      turnId: event.turnId,
      text: event.text,
      startMs: event.startMs,
      endMs: event.endMs,
    }) as TranscriptFragment;
    this.#transcripts.push(fragment);
    this.#emitCanonical({
      type: "transcript.partial",
      data: { turnId: event.turnId, text: event.text },
    }, event.eventId);
  }

  #handleDelegationCreated(event: Extract<NormalizedOpenAILiveServerEvent, { type: "delegation.created" }>): void {
    if (this.#delegations.has(event.delegationId)) return;
    if (event.target !== this.#config.options.backend.type) {
      const error: ErrorDescriptor = {
        code: "DELEGATION_MODE_MISMATCH",
        message: `Session is configured for ${this.#config.options.backend.type} delegation, received ${event.target}`,
        retryable: false,
      };
      this.#emitPackage(event.eventId, { type: "delegation.failed", delegationId: event.delegationId, error });
      return;
    }
    const record: DelegationRecord = compact({
      id: event.delegationId,
      target: event.target,
      state: "requested",
      responseId: event.responseId,
    }) as DelegationRecord;
    this.#delegations.set(record.id, record);
    const requested = compact({
      type: "delegation.requested",
      delegationId: record.id,
      target: record.target,
      responseId: record.responseId,
    }) as OpenAILivePackageEvent;
    const started = { ...requested, type: "delegation.started" } as OpenAILivePackageEvent;
    this.#emitPackage(event.eventId, requested);
    record.state = "running";
    this.#emitPackage(`${event.eventId}:started`, started);
    if (record.target === "client" && this.#config.clientExecutor) void this.#executeClientDelegation(record);
  }

  async #executeClientDelegation(record: DelegationRecord): Promise<void> {
    const backend = this.#config.options.backend;
    if (backend.type !== "client" || !this.#config.clientExecutor || !this.#sessionId) return;
    const abortController = new AbortController();
    record.abortController = abortController;
    try {
      const result = await this.#config.clientExecutor.execute({
        delegationId: record.id,
        sessionId: this.#sessionId,
        backend,
        transcripts: [...this.#transcripts],
        signal: abortController.signal,
        progress: async (update) => {
          if (record.state !== "running") return;
          await this.appendDelegationUpdate(record.id, update.content, update.delivery);
          this.#emitPackage(this.#idFactory(), {
            type: "delegation.progress",
            delegationId: record.id,
            content: update.content,
          });
        },
      });
      if (record.state !== "running") return;
      if (result.content) {
        await this.appendDelegationUpdate(record.id, result.content, result.delivery ?? "commentary");
      }
      this.#finishDelegation(record.id, "completed", this.#idFactory(), {
        type: "delegation.completed",
        eventId: this.#idFactory(),
        delegationId: record.id,
        ...(result.usage ? { usage: result.usage } : {}),
      });
    } catch (cause) {
      if (record.state === "cancelled" || abortController.signal.aborted) return;
      this.#finishDelegation(record.id, "failed", this.#idFactory(), {
        type: "delegation.failed",
        eventId: this.#idFactory(),
        delegationId: record.id,
        error: toErrorDescriptor(cause, "CLIENT_DELEGATION_FAILED"),
      });
    }
  }

  #handleDelegationProgress(event: Extract<NormalizedOpenAILiveServerEvent, { type: "delegation.progress" }>): void {
    const record = this.#delegations.get(event.delegationId);
    if (!record || isTerminal(record.state)) return;
    this.#emitPackage(event.eventId, compact({
      type: "delegation.progress",
      delegationId: event.delegationId,
      content: event.content,
      responseEvent: event.responseEvent,
    }) as OpenAILivePackageEvent);
  }

  #finishDelegation(
    delegationId: string,
    state: "completed" | "failed" | "cancelled",
    eventId: string,
    event: Extract<NormalizedOpenAILiveServerEvent, { type: `delegation.${typeof state}` }>,
  ): void {
    const record = this.#delegations.get(delegationId);
    if (!record || isTerminal(record.state)) return;
    record.state = state;
    if (state === "completed") {
      const completed = event as Extract<NormalizedOpenAILiveServerEvent, { type: "delegation.completed" }>;
      this.#emitPackage(eventId, compact({
        type: "delegation.completed",
        delegationId,
        responseId: completed.responseId ?? record.responseId,
        usage: completed.usage,
      }) as OpenAILivePackageEvent);
      if (completed.usage) {
        this.#emitPackage(`${eventId}:usage`, { type: "backend.usage", delegationId, usage: completed.usage });
      }
    } else if (state === "failed") {
      const failed = event as Extract<NormalizedOpenAILiveServerEvent, { type: "delegation.failed" }>;
      this.#emitPackage(eventId, { type: "delegation.failed", delegationId, error: failed.error });
    } else {
      const cancelled = event as Extract<NormalizedOpenAILiveServerEvent, { type: "delegation.cancelled" }>;
      this.#emitPackage(eventId, {
        type: "delegation.cancelled",
        delegationId,
        reason: cancelled.reason ?? "provider_cancelled",
      });
    }
  }

  #handleInterruption(event: Extract<NormalizedOpenAILiveServerEvent, { type: "interruption" }>): void {
    const cancelled: string[] = [];
    if (this.#cancellation.onInterruption === "cancel") {
      for (const record of this.#delegations.values()) {
        if (record.target === "client" && this.cancelDelegation(record.id, "voice_interrupted")) cancelled.push(record.id);
      }
    }
    this.#emitPackage(event.eventId, compact({
      type: "interruption",
      turnId: event.turnId,
      by: event.by,
      cancelledDelegations: cancelled,
    }) as OpenAILivePackageEvent);
    if (event.turnId) {
      this.#emitCanonical({ type: "turn.interrupted", data: { turnId: event.turnId, by: event.by } }, event.eventId);
    }
  }

  #recordVoiceUsage(
    eventId: string,
    seconds: number,
    final: boolean,
    confirmed: boolean,
    contextUsageRatio?: number,
  ): void {
    if (!Number.isFinite(seconds) || seconds < this.#lastVoiceSeconds) return;
    this.#lastVoiceSeconds = seconds;
    this.#emitPackage(eventId, compact({
      type: "usage",
      voiceSeconds: seconds,
      final,
      confirmed,
      contextUsageRatio,
    }) as OpenAILivePackageEvent);
    this.#emitCanonical({
      type: "usage.recorded",
      data: { metric: "audio_input_ms", quantity: seconds * 1000, unit: "ms" },
    }, eventId);
  }

  #cancelClientDelegations(reason: string): void {
    for (const record of this.#delegations.values()) {
      if (record.target === "client") this.cancelDelegation(record.id, reason);
    }
  }

  #requireResponsesMode(): void {
    if (this.#config.options.backend.type !== "responses") {
      throw new Error("Responses tool results and confirmations require responses delegation");
    }
  }

  #requireClientDelegation(delegationId: string): void {
    if (this.#config.options.backend.type !== "client") {
      throw new Error("Delegation updates require client delegation");
    }
    const record = this.#delegations.get(delegationId);
    if (!record || record.target !== "client") throw new Error(`Unknown client delegation: ${delegationId}`);
    if (isTerminal(record.state)) throw new Error(`Client delegation ${delegationId} is ${record.state}`);
  }

  async #send(event: OpenAILiveClientEvent): Promise<void> {
    if (!this.#transport || this.#state === "idle" || this.#state === "failed" || this.#state === "closed") {
      throw new Error(`OpenAI Live session is not writable in state ${this.#state}`);
    }
    if (this.#state === "closing" && event.type !== "session.close") {
      throw new Error("OpenAI Live session is closing");
    }
    await this.#transport.send(event);
  }

  #emitPackage(eventId: string, event: OpenAILivePackageEvent): void {
    const emitted: OpenAILiveAdapterEvent = {
      kind: "openai.live",
      eventId,
      timestamp: this.#now().toISOString(),
      event,
    };
    for (const listener of this.#listeners) listener(emitted);
  }

  #emitCanonical(event: VoiceKitEvent, causationId: string): void {
    if (!this.#sessionId) return;
    const envelope: EventEnvelope = {
      protocolVersion: VOICEKIT_PROTOCOL_VERSION,
      id: this.#idFactory(),
      sessionId: this.#sessionId,
      sequence: this.#sequence++,
      timestamp: this.#now().toISOString(),
      event,
      metadata: { provider: "openai-live", causationId },
    };
    for (const listener of this.#listeners) listener({ kind: "voicekit", envelope });
  }
}

export function createOpenAILiveController(config: OpenAILiveControllerConfig): OpenAILiveController {
  return new OpenAILiveController(config);
}

export function normalizeOpenAILiveServerEvent(raw: unknown): NormalizedOpenAILiveServerEvent {
  const value = asRecord(raw);
  const type = string(value.type);
  const eventId = string(value.event_id) || string(value.eventId) || stableFallbackId(raw);

  if (type === "session.started") {
    const session = asRecord(value.session);
    return compact({
      type,
      eventId,
      sessionId: string(session.id) || string(value.session_id),
      session: jsonOrUndefined(value.session),
    }) as Extract<NormalizedOpenAILiveServerEvent, { type: "session.started" }>;
  }
  if (type === "session.closing") {
    return compact({ type, eventId, reason: stringOrUndefined(value.reason) }) as Extract<NormalizedOpenAILiveServerEvent, { type: "session.closing" }>;
  }
  if (type === "session.closed") {
    return compact({
      type,
      eventId,
      reason: string(value.reason) || "unknown",
      usageSeconds: numberOrUndefined(asRecord(value.usage).seconds),
      session: jsonOrUndefined(value.session),
    }) as Extract<NormalizedOpenAILiveServerEvent, { type: "session.closed" }>;
  }
  if (type === "session.input_transcript.delta" || type === "session.output_transcript.delta") {
    return compact({
      type: "transcript.delta",
      eventId,
      participant: type.includes("input_") ? "user" : "agent",
      turnId: string(value.item_id) || string(value.turn_id) || eventId,
      text: string(value.delta),
      startMs: numberOrUndefined(value.start_ms),
      endMs: numberOrUndefined(value.end_ms),
    }) as Extract<NormalizedOpenAILiveServerEvent, { type: "transcript.delta" }>;
  }
  if (type === "session.input_audio.speech_started" || type === "input_audio_buffer.speech_started") {
    return compact({
      type: "input.speech.started",
      eventId,
      turnId: string(value.item_id) || string(value.turn_id) || eventId,
      offsetMs: numberOrUndefined(value.offset_ms ?? value.audio_start_ms),
    }) as Extract<NormalizedOpenAILiveServerEvent, { type: "input.speech.started" }>;
  }
  if (type === "session.input_audio.speech_stopped" || type === "input_audio_buffer.speech_stopped") {
    return compact({
      type: "input.speech.stopped",
      eventId,
      turnId: string(value.item_id) || string(value.turn_id) || eventId,
      offsetMs: numberOrUndefined(value.offset_ms ?? value.audio_end_ms),
    }) as Extract<NormalizedOpenAILiveServerEvent, { type: "input.speech.stopped" }>;
  }
  if (type === "session.output_audio.started" || type === "response.output_audio.started") {
    return compact({
      type: "output.speech.started",
      eventId,
      turnId: string(value.item_id) || string(value.turn_id) || eventId,
      offsetMs: numberOrUndefined(value.offset_ms),
    }) as Extract<NormalizedOpenAILiveServerEvent, { type: "output.speech.started" }>;
  }
  if (type === "session.output_audio.stopped" || type === "response.output_audio.done") {
    return compact({
      type: "output.speech.stopped",
      eventId,
      turnId: string(value.item_id) || string(value.turn_id) || eventId,
      reason: normalizeTurnEndReason(value.reason),
      offsetMs: numberOrUndefined(value.offset_ms),
    }) as Extract<NormalizedOpenAILiveServerEvent, { type: "output.speech.stopped" }>;
  }
  if (type === "session.interrupted" || type === "session.output_audio.interrupted") {
    return compact({
      type: "interruption",
      eventId,
      turnId: stringOrUndefined(value.item_id ?? value.turn_id),
      by: normalizeInterrupter(value.by),
    }) as Extract<NormalizedOpenAILiveServerEvent, { type: "interruption" }>;
  }
  if (type === "session.delegation.created") {
    const delegation = asRecord(value.delegation);
    return compact({
      type: "delegation.created",
      eventId,
      delegationId: string(delegation.id),
      target: delegation.target === "client" ? "client" : "responses",
      responseId: stringOrUndefined(value.response_id ?? delegation.response_id),
      offsetMs: numberOrUndefined(value.offset_ms),
    }) as Extract<NormalizedOpenAILiveServerEvent, { type: "delegation.created" }>;
  }
  if (type === "response.event") return normalizeNestedResponseEvent(value, eventId);
  if (type === "session.delegation.cancelled") {
    return compact({
      type: "delegation.cancelled",
      eventId,
      delegationId: string(value.delegation_id),
      reason: stringOrUndefined(value.reason),
    }) as Extract<NormalizedOpenAILiveServerEvent, { type: "delegation.cancelled" }>;
  }
  if (type === "session.usage.updated") {
    return compact({
      type: "usage.updated",
      eventId,
      seconds: number(asRecord(value.usage).seconds),
      contextUsageRatio: numberOrUndefined(asRecord(value.context_window).usage_ratio),
    }) as Extract<NormalizedOpenAILiveServerEvent, { type: "usage.updated" }>;
  }
  if (type === "error") {
    const error = asRecord(value.error);
    const details = jsonOrUndefined(error.details);
    return {
      type: "error",
      eventId,
      error: {
        code: string(error.code) || "OPENAI_LIVE_ERROR",
        message: string(error.message) || "OpenAI Live error",
        retryable: Boolean(error.retryable),
        ...(details !== undefined ? { details } : {}),
      },
      fatal: Boolean(error.fatal),
    };
  }
  return { type: "unknown", eventId, raw: toJson(raw) };
}

function normalizeNestedResponseEvent(
  outer: Record<string, unknown>,
  eventId: string,
): NormalizedOpenAILiveServerEvent {
  const delegationId = string(outer.delegation_id);
  const nested = asRecord(outer.event);
  const nestedType = string(nested.type);
  if (nestedType === "response.output_item.done") {
    const item = asRecord(nested.item);
    const itemType = string(item.type);
    if (itemType === "mcp_approval_request") {
      return compact({
        type: "confirmation.requested",
        eventId,
        delegationId,
        requestId: string(item.id),
        name: stringOrUndefined(item.name ?? item.server_label),
        details: jsonOrUndefined(item),
      }) as Extract<NormalizedOpenAILiveServerEvent, { type: "confirmation.requested" }>;
    }
    if (itemType.endsWith("_call")) {
      return {
        type: "tool.requested",
        eventId,
        delegationId,
        callId: string(item.call_id) || string(item.id),
        name: string(item.name) || itemType,
        arguments: parseJsonValue(item.arguments ?? item.input),
        toolType: itemType,
      };
    }
  }
  if (nestedType === "response.completed") {
    const response = asRecord(nested.response);
    return compact({
      type: "delegation.completed",
      eventId,
      delegationId,
      responseId: stringOrUndefined(response.id),
      usage: normalizeBackendUsage(response.usage),
    }) as Extract<NormalizedOpenAILiveServerEvent, { type: "delegation.completed" }>;
  }
  if (nestedType === "response.failed" || nestedType === "response.incomplete") {
    const response = asRecord(nested.response);
    const error = asRecord(response.error ?? nested.error);
    return {
      type: "delegation.failed",
      eventId,
      delegationId,
      error: {
        code: string(error.code) || nestedType.toUpperCase().replace(".", "_"),
        message: string(error.message) || `Backend ${nestedType}`,
        retryable: Boolean(error.retryable),
      },
    };
  }
  return {
    type: "delegation.progress",
    eventId,
    delegationId,
    content: string(nested.delta ?? nested.text),
    responseEvent: toJson(nested),
  };
}

function normalizeBackendUsage(value: unknown): BackendUsage | undefined {
  const usage = asRecord(value);
  if (Object.keys(usage).length === 0) return undefined;
  const inputDetails = asRecord(usage.input_tokens_details);
  return compact({
    inputTokens: numberOrUndefined(usage.input_tokens),
    outputTokens: numberOrUndefined(usage.output_tokens),
    totalTokens: numberOrUndefined(usage.total_tokens),
    cachedInputTokens: numberOrUndefined(inputDetails.cached_tokens),
    raw: toJson(usage),
  }) as BackendUsage;
}

function omitType(config: ResponsesBackendConfig): Omit<ResponsesBackendConfig, "type"> {
  const { type: _type, ...rest } = config;
  return rest;
}

function isNormalizedEvent(value: unknown): value is NormalizedOpenAILiveServerEvent {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.eventId === "string" && typeof record.type === "string";
}

function isTerminal(state: DelegationRecord["state"]): boolean {
  return state === "completed" || state === "failed" || state === "cancelled";
}

function normalizeTurnEndReason(value: unknown): "completed" | "interrupted" | "cancelled" {
  return value === "interrupted" || value === "cancelled" ? value : "completed";
}

function normalizeInterrupter(value: unknown): "user" | "agent" | "system" {
  return value === "agent" || value === "system" ? value : "user";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseJsonValue(value: unknown): JsonValue {
  if (typeof value === "string") {
    try {
      return toJson(JSON.parse(value));
    } catch {
      return value;
    }
  }
  return toJson(value);
}

function jsonOrUndefined(value: unknown): JsonValue | undefined {
  return value === undefined ? undefined : toJson(value);
}

function toJson(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (Array.isArray(value)) return value.map(toJson);
  if (value && typeof value === "object") {
    const output: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined) output[key] = toJson(item);
    }
    return output;
  }
  return String(value);
}

function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}

function stableFallbackId(raw: unknown): string {
  const text = JSON.stringify(toJson(raw));
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `synthetic_${(hash >>> 0).toString(16)}`;
}

function toErrorDescriptor(value: unknown, code: string): ErrorDescriptor {
  return {
    code,
    message: value instanceof Error ? value.message : String(value),
    retryable: false,
  };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
}
