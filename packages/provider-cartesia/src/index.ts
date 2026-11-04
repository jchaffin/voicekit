export type Awaitable<T> = T | Promise<T>;
export type TokenSource = (signal?: AbortSignal) => Awaitable<string>;

export const cartesiaCapabilities = {
  realtime: false,
  stt: false,
  llm: false,
  tts: true,
  interruption: true,
  tools: false,
} as const;

export interface CartesiaProviderOptions {
  modelId?: string;
  voiceId?: string;
  language?: string;
  outputFormat?: {
    container?: string;
    encoding?: string;
    sampleRate?: number;
  };
  speed?: number | "slowest" | "slow" | "normal" | "fast" | "fastest";
  emotion?: string[];
  providerOptions?: Record<string, unknown>;
}

export type CartesiaTTSEvent =
  | { type: "audio"; audio: Uint8Array }
  | { type: "timestamps"; words: string[]; start: number[]; end: number[] }
  | { type: "done" }
  | { type: "error"; error: Error }
  | { type: "raw"; raw: unknown };

export interface CartesiaTTSContext {
  send(input: Record<string, unknown>): Awaitable<void>;
  onEvent(listener: (event: unknown) => void): (() => void) | void;
  close(): Awaitable<void>;
  cancel?(): Awaitable<void>;
  raw?: unknown;
}

export type CartesiaContextFactory = (input: {
  token: string;
  options: Readonly<CartesiaProviderOptions>;
  signal: AbortSignal | undefined;
}) => Awaitable<CartesiaTTSContext>;

export function createCartesiaTTSProvider(config: {
  token: TokenSource;
  contextFactory: CartesiaContextFactory;
  providerOptions?: CartesiaProviderOptions;
}) {
  const providerOptions = Object.freeze({ ...config.providerOptions });
  return {
    name: "cartesia",
    capabilities: { streaming: true, interruption: true, wordTimestamps: true } as const,
    providerOptions,
    async open(input: { signal?: AbortSignal } = {}) {
      const token = await config.token(input.signal);
      throwIfAborted(input.signal);
      const context = await config.contextFactory({ token, options: providerOptions, signal: input.signal });
      const listeners = new Set<(event: CartesiaTTSEvent) => void>();
      const off = context.onEvent((raw) => {
        const event = normalizeCartesiaEvent(raw);
        for (const listener of listeners) listener(event);
      });
      let closed = false;
      return {
        raw: context.raw ?? context,
        onEvent(listener: (event: CartesiaTTSEvent) => void) { listeners.add(listener); return () => listeners.delete(listener); },
        async synthesize(text: string, continuation = false) {
          if (closed) throw new Error("Cartesia context is closed");
          await context.send({
            model_id: providerOptions.modelId ?? "sonic",
            transcript: text,
            continue: continuation,
            voice: providerOptions.voiceId ? { mode: "id", id: providerOptions.voiceId } : undefined,
            language: providerOptions.language,
            output_format: providerOptions.outputFormat,
            generation_config: {
              speed: providerOptions.speed,
              emotion: providerOptions.emotion,
            },
            ...providerOptions.providerOptions,
          });
        },
        async flush() {
          if (closed) throw new Error("Cartesia context is closed");
          await context.send({ transcript: "", continue: false });
        },
        async interrupt() {
          if (closed) return;
          if (context.cancel) await context.cancel();
          else await context.close();
        },
        async close() {
          if (closed) return;
          closed = true;
          off?.();
          listeners.clear();
          await context.close();
        },
      };
    },
  };
}

export function normalizeCartesiaEvent(raw: unknown): CartesiaTTSEvent {
  const value = asRecord(raw);
  const type = String(value.type ?? "");
  if (type === "chunk" || type === "audio") return { type: "audio", audio: bytes(value.data ?? value.audio) };
  if (type === "timestamps" || type === "word_timestamps") {
    const timestamps = asRecord(value.word_timestamps ?? value);
    return {
      type: "timestamps",
      words: stringArray(timestamps.words),
      start: numberArray(timestamps.start ?? timestamps.start_times),
      end: numberArray(timestamps.end ?? timestamps.end_times),
    };
  }
  if (type === "done") return { type: "done" };
  if (type === "error") return { type: "error", error: toError(value.error ?? value.message ?? raw) };
  return { type: "raw", raw };
}

function asRecord(value: unknown): Record<string, unknown> { return value && typeof value === "object" ? value as Record<string, unknown> : {}; }
function stringArray(value: unknown): string[] { return Array.isArray(value) ? value.map(String) : []; }
function numberArray(value: unknown): number[] { return Array.isArray(value) ? value.filter((item): item is number => typeof item === "number") : []; }
function toError(value: unknown): Error { return value instanceof Error ? value : new Error(typeof value === "string" ? value : JSON.stringify(value)); }
function bytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (typeof value === "string" && typeof Buffer !== "undefined") return Uint8Array.from(Buffer.from(value, "base64"));
  return new Uint8Array();
}
function throwIfAborted(signal?: AbortSignal): void { if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError"); }
