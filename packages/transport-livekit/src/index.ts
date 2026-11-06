export type Awaitable<T> = T | Promise<T>;
export type TokenSource = (signal?: AbortSignal) => Awaitable<string>;

export type LiveKitJson =
  | null
  | boolean
  | number
  | string
  | readonly LiveKitJson[]
  | { readonly [key: string]: LiveKitJson };

export type LiveKitDeploymentEnvironment = "production" | "non-production";

export interface LiveKitExplicitDispatch {
  agentName: string;
  deploymentName: string;
  environment: LiveKitDeploymentEnvironment;
  metadata: Readonly<Record<string, LiveKitJson>>;
  experimentAssignmentId?: string;
}

export type LiveKitDispatchDescriptor =
  | {
      kind: "api-dispatch";
      dispatch: LiveKitExplicitDispatch;
      roomName?: string;
      participantIdentity?: string;
    }
  | {
      kind: "token-dispatch";
      dispatch: LiveKitExplicitDispatch;
      roomName?: string;
      participantIdentity?: string;
    }
  | {
      kind: "sip-dispatch";
      dispatch: LiveKitExplicitDispatch;
      trunkId?: string;
      calledNumber?: string;
    };

export function defineLiveKitDispatch(
  input: Omit<LiveKitExplicitDispatch, "environment" | "metadata"> & {
    environment?: LiveKitDeploymentEnvironment;
    metadata?: Readonly<Record<string, LiveKitJson>>;
  },
): Readonly<LiveKitExplicitDispatch> {
  if (!input.agentName) throw new Error("LiveKit dispatch requires an agent name");
  if (!input.deploymentName) throw new Error("LiveKit dispatch requires a named deployment");
  assertJson(input.metadata ?? {}, "metadata");
  return Object.freeze({
    ...input,
    environment: input.environment ?? "production",
    metadata: Object.freeze({ ...(input.metadata ?? {}) }),
  });
}

export function createLiveKitDispatchDescriptor<T extends LiveKitDispatchDescriptor>(
  descriptor: T,
): Readonly<T> {
  assertJson(descriptor.dispatch.metadata, "dispatch.metadata");
  return Object.freeze({ ...descriptor });
}

export const liveKitTransportCapabilities = {
  audioInput: true,
  audioOutput: true,
  data: true,
  interruption: false,
  tools: false,
  reconnect: true,
} as const;

export interface LiveKitTransportOptions {
  url: string;
  identity?: string;
  autoSubscribe?: boolean;
  publishMicrophone?: boolean;
  dataTopic?: string;
  providerOptions?: Record<string, unknown>;
}

export type LiveKitTransportEvent =
  | { type: "connected" }
  | { type: "reconnecting" }
  | { type: "disconnected"; reason?: string }
  | { type: "audio"; track: unknown; participant?: unknown }
  | { type: "data"; payload: Uint8Array; topic?: string; participant?: unknown }
  | { type: "error"; error: Error }
  | { type: "raw"; raw: unknown };

export interface LiveKitRoomClient {
  connect(url: string, token: string, options?: Record<string, unknown>): Awaitable<void>;
  onEvent(listener: (event: unknown) => void): (() => void) | void;
  publishData(payload: Uint8Array, options?: Record<string, unknown>): Awaitable<void>;
  setMicrophoneEnabled?(enabled: boolean): Awaitable<void>;
  disconnect(): Awaitable<void>;
  raw?: unknown;
}

export type LiveKitRoomFactory = (input: {
  signal: AbortSignal | undefined;
  providerOptions: Readonly<LiveKitTransportOptions>;
}) => Awaitable<LiveKitRoomClient>;

export function createLiveKitTransport(config: {
  token: TokenSource;
  roomFactory: LiveKitRoomFactory;
  providerOptions: LiveKitTransportOptions;
}) {
  const providerOptions = Object.freeze({ ...config.providerOptions });
  return {
    name: "livekit",
    capabilities: liveKitTransportCapabilities,
    providerOptions,
    async connect(input: { signal?: AbortSignal } = {}) {
      const token = await config.token(input.signal);
      throwIfAborted(input.signal);
      const room = await config.roomFactory({ signal: input.signal, providerOptions });
      const listeners = new Set<(event: LiveKitTransportEvent) => void>();
      const off = room.onEvent((raw) => {
        const event = normalizeLiveKitEvent(raw);
        for (const listener of listeners) listener(event);
      });
      try {
        await room.connect(providerOptions.url, token, {
          autoSubscribe: providerOptions.autoSubscribe ?? true,
          identity: providerOptions.identity,
          ...providerOptions.providerOptions,
        });
        if (providerOptions.publishMicrophone !== false) await room.setMicrophoneEnabled?.(true);
      } catch (error) {
        off?.();
        await room.disconnect();
        throw error;
      }
      let closed = false;
      return {
        raw: room.raw ?? room,
        capabilities: liveKitTransportCapabilities,
        onEvent(listener: (event: LiveKitTransportEvent) => void) { listeners.add(listener); return () => listeners.delete(listener); },
        async send(payload: Uint8Array | string | Record<string, unknown>, options: { reliable?: boolean; topic?: string } = {}) {
          if (closed) throw new Error("LiveKit transport is closed");
          const bytes = encodePayload(payload);
          await room.publishData(bytes, {
            reliable: options.reliable ?? true,
            topic: options.topic ?? providerOptions.dataTopic,
          });
        },
        async mute(muted: boolean) {
          if (closed) return;
          if (!room.setMicrophoneEnabled) throw new Error("Injected LiveKit room does not expose microphone control");
          await room.setMicrophoneEnabled(!muted);
        },
        async close() {
          if (closed) return;
          closed = true;
          off?.();
          listeners.clear();
          await room.disconnect();
        },
      };
    },
  };
}

export function normalizeLiveKitEvent(raw: unknown): LiveKitTransportEvent {
  const value = asRecord(raw);
  const type = String(value.type ?? value.event ?? "");
  const normalized = type.toLowerCase().replaceAll("_", "");
  if (normalized === "connected") return { type: "connected" };
  if (normalized === "reconnecting") return { type: "reconnecting" };
  if (normalized === "disconnected") {
    const reason = typeof value.reason === "string" ? value.reason : undefined;
    return reason ? { type: "disconnected", reason } : { type: "disconnected" };
  }
  if (normalized === "tracksubscribed" || normalized === "audio") {
    const participant = value.participant;
    return participant === undefined
      ? { type: "audio", track: value.track ?? value.audio }
      : { type: "audio", track: value.track ?? value.audio, participant };
  }
  if (normalized === "datareceived" || normalized === "data") {
    const event: LiveKitTransportEvent = { type: "data", payload: toBytes(value.payload ?? value.data) };
    if (typeof value.topic === "string") event.topic = value.topic;
    if (value.participant !== undefined) event.participant = value.participant;
    return event;
  }
  if (normalized === "error") return { type: "error", error: toError(value.error ?? value.message ?? raw) };
  return { type: "raw", raw };
}

function encodePayload(value: Uint8Array | string | Record<string, unknown>): Uint8Array {
  if (value instanceof Uint8Array) return value;
  return new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value));
}
function toBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (typeof value === "string") return new TextEncoder().encode(value);
  return new Uint8Array();
}
function asRecord(value: unknown): Record<string, unknown> { return value && typeof value === "object" ? value as Record<string, unknown> : {}; }
function toError(value: unknown): Error { return value instanceof Error ? value : new Error(typeof value === "string" ? value : JSON.stringify(value)); }
function throwIfAborted(signal?: AbortSignal): void { if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError"); }
function assertJson(value: unknown, path: string): asserts value is LiveKitJson {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return;
    throw new Error(`LiveKit ${path} must contain finite JSON numbers`);
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJson(item, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) assertJson(item, `${path}.${key}`);
    return;
  }
  throw new Error(`LiveKit ${path} must be JSON-serializable`);
}
