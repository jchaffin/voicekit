export type Awaitable<T> = T | Promise<T>;
export type TokenSource = (signal?: AbortSignal) => Awaitable<string>;

export const deepgramCapabilities = {
  realtime: false,
  stt: true,
  llm: false,
  tts: true,
  interruption: false,
  tools: false,
} as const;

export interface DeepgramProviderOptions {
  model?: string;
  language?: string;
  encoding?: string;
  sampleRate?: number;
  channels?: number;
  interimResults?: boolean;
  punctuate?: boolean;
  endpointing?: number | boolean;
  utteranceEndMs?: number;
  providerOptions?: Record<string, unknown>;
}

export type DeepgramSTTEvent =
  | { type: "transcript"; text: string; isFinal: boolean; speechFinal: boolean; confidence?: number; words?: unknown[] }
  | { type: "speech.start" | "utterance.end" }
  | { type: "error"; error: Error }
  | { type: "raw"; raw: unknown };

export interface DeepgramSTTConnection {
  send(audio: Uint8Array): Awaitable<void>;
  onEvent(listener: (event: unknown) => void): (() => void) | void;
  finish(): Awaitable<void>;
  close?(): Awaitable<void>;
  raw?: unknown;
}

export type DeepgramSTTFactory = (input: {
  token: string;
  options: Readonly<DeepgramProviderOptions>;
  signal: AbortSignal | undefined;
}) => Awaitable<DeepgramSTTConnection>;

export function createDeepgramSTTProvider(config: {
  token: TokenSource;
  connectionFactory: DeepgramSTTFactory;
  providerOptions?: DeepgramProviderOptions;
}) {
  const providerOptions = Object.freeze({ ...config.providerOptions });
  return {
    name: "deepgram",
    capabilities: { streaming: true, interimResults: true, wordTimestamps: true } as const,
    providerOptions,
    async open(input: { signal?: AbortSignal } = {}) {
      const token = await config.token(input.signal);
      throwIfAborted(input.signal);
      const connection = await config.connectionFactory({ token, options: providerOptions, signal: input.signal });
      const listeners = new Set<(event: DeepgramSTTEvent) => void>();
      const off = connection.onEvent((raw) => {
        const event = normalizeDeepgramSTTEvent(raw);
        for (const listener of listeners) listener(event);
      });
      let closed = false;
      return {
        raw: connection.raw ?? connection,
        onEvent(listener: (event: DeepgramSTTEvent) => void) { listeners.add(listener); return () => listeners.delete(listener); },
        async write(audio: Uint8Array) {
          if (closed) throw new Error("Deepgram STT stream is closed");
          await connection.send(audio);
        },
        async close() {
          if (closed) return;
          closed = true;
          off?.();
          listeners.clear();
          await connection.finish();
          await connection.close?.();
        },
      };
    },
  };
}

export interface DeepgramTTSClient {
  synthesize(input: {
    token: string;
    text: string;
    options: Readonly<DeepgramProviderOptions>;
    signal: AbortSignal | undefined;
  }): AsyncIterable<unknown>;
  raw?: unknown;
}

export function createDeepgramTTSProvider(config: {
  token: TokenSource;
  client: DeepgramTTSClient;
  providerOptions?: DeepgramProviderOptions;
}) {
  const providerOptions = Object.freeze({ ...config.providerOptions });
  return {
    name: "deepgram",
    capabilities: { streaming: true, interruption: false } as const,
    providerOptions,
    raw: config.client.raw ?? config.client,
    async *synthesize(text: string, input: { signal?: AbortSignal } = {}): AsyncIterable<Uint8Array> {
      const token = await config.token(input.signal);
      for await (const chunk of config.client.synthesize({ token, text, options: providerOptions, signal: input.signal })) {
        throwIfAborted(input.signal);
        yield bytes(asRecord(chunk).audio ?? asRecord(chunk).data ?? chunk);
      }
    },
  };
}

export function normalizeDeepgramSTTEvent(raw: unknown): DeepgramSTTEvent {
  const value = asRecord(raw);
  const type = String(value.type ?? "");
  if (type === "SpeechStarted" || type === "speech_started") return { type: "speech.start" };
  if (type === "UtteranceEnd" || type === "utterance_end") return { type: "utterance.end" };
  if (type === "Results" || type === "transcript") {
    const alternative = asRecord(asArray(asRecord(asArray(asRecord(value.channel).alternatives)[0]).words).length >= 0
      ? asArray(asRecord(value.channel).alternatives)[0]
      : undefined);
    const alt = asRecord(alternative);
    const result: DeepgramSTTEvent = {
      type: "transcript",
      text: String(value.text ?? alt.transcript ?? ""),
      isFinal: Boolean(value.is_final ?? value.isFinal),
      speechFinal: Boolean(value.speech_final ?? value.speechFinal),
    };
    if (typeof alt.confidence === "number") result.confidence = alt.confidence;
    const words = asArray(alt.words);
    if (words.length) result.words = words;
    return result;
  }
  if (type === "Error" || type === "error") return { type: "error", error: toError(value.error ?? value.message ?? raw) };
  return { type: "raw", raw };
}

function asRecord(value: unknown): Record<string, unknown> { return value && typeof value === "object" ? value as Record<string, unknown> : {}; }
function asArray(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function toError(value: unknown): Error { return value instanceof Error ? value : new Error(typeof value === "string" ? value : JSON.stringify(value)); }
function bytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (typeof value === "string" && typeof Buffer !== "undefined") return Uint8Array.from(Buffer.from(value, "base64"));
  return new Uint8Array();
}
function throwIfAborted(signal?: AbortSignal): void { if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError"); }
