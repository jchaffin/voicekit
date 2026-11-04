export type Awaitable<T> = T | Promise<T>;
export type TokenSource = (signal?: AbortSignal) => Awaitable<string>;

export const assemblyAICapabilities = {
  realtime: false,
  stt: true,
  llm: false,
  tts: false,
  interruption: false,
  tools: false,
} as const;

export interface AssemblyAIProviderOptions {
  sampleRate?: number;
  languageCode?: string;
  speechModel?: string;
  formatTurns?: boolean;
  endOfTurnConfidenceThreshold?: number;
  minEndOfTurnSilenceWhenConfident?: number;
  maxTurnSilence?: number;
  providerOptions?: Record<string, unknown>;
}

export type AssemblyAISTTEvent =
  | { type: "session"; id: string }
  | { type: "transcript"; text: string; isFinal: boolean; turnIsFormatted?: boolean; confidence?: number; words?: unknown[] }
  | { type: "error"; error: Error }
  | { type: "raw"; raw: unknown };

export interface AssemblyAITranscriber {
  connect(config: Record<string, unknown>): Awaitable<void>;
  sendAudio(audio: Uint8Array): Awaitable<void>;
  onEvent(listener: (event: unknown) => void): (() => void) | void;
  close(): Awaitable<void>;
  forceEndpoint?(): Awaitable<void>;
  raw?: unknown;
}

export type AssemblyAITranscriberFactory = (input: {
  token: string;
  options: Readonly<AssemblyAIProviderOptions>;
  signal: AbortSignal | undefined;
}) => Awaitable<AssemblyAITranscriber>;

export function createAssemblyAISTTProvider(config: {
  token: TokenSource;
  transcriberFactory: AssemblyAITranscriberFactory;
  providerOptions?: AssemblyAIProviderOptions;
}) {
  const providerOptions = Object.freeze({ ...config.providerOptions });
  return {
    name: "assemblyai",
    capabilities: { streaming: true, interimResults: true, wordTimestamps: true, forceEndpoint: true } as const,
    providerOptions,
    async open(input: { signal?: AbortSignal } = {}) {
      const token = await config.token(input.signal);
      throwIfAborted(input.signal);
      const transcriber = await config.transcriberFactory({ token, options: providerOptions, signal: input.signal });
      const listeners = new Set<(event: AssemblyAISTTEvent) => void>();
      const off = transcriber.onEvent((raw) => {
        const event = normalizeAssemblyAIEvent(raw);
        for (const listener of listeners) listener(event);
      });
      try {
        await transcriber.connect({
          token,
          sampleRate: providerOptions.sampleRate ?? 16_000,
          languageCode: providerOptions.languageCode,
          speechModel: providerOptions.speechModel,
          ...providerOptions.providerOptions,
        });
      } catch (error) {
        off?.();
        await transcriber.close();
        throw error;
      }
      let closed = false;
      return {
        raw: transcriber.raw ?? transcriber,
        onEvent(listener: (event: AssemblyAISTTEvent) => void) { listeners.add(listener); return () => listeners.delete(listener); },
        async write(audio: Uint8Array) {
          if (closed) throw new Error("AssemblyAI transcriber is closed");
          await transcriber.sendAudio(audio);
        },
        async forceEndpoint() {
          if (!transcriber.forceEndpoint) throw new Error("Injected AssemblyAI transcriber does not support forceEndpoint");
          await transcriber.forceEndpoint();
        },
        async close() {
          if (closed) return;
          closed = true;
          off?.();
          listeners.clear();
          await transcriber.close();
        },
      };
    },
  };
}

export function normalizeAssemblyAIEvent(raw: unknown): AssemblyAISTTEvent {
  const value = asRecord(raw);
  const type = String(value.type ?? value.message_type ?? "");
  if (type === "Begin" || type === "SessionBegins" || type === "session") {
    return { type: "session", id: String(value.id ?? value.session_id ?? "") };
  }
  if (type === "Turn" || type === "PartialTranscript" || type === "FinalTranscript" || type === "transcript") {
    const final = type === "FinalTranscript" || value.end_of_turn === true || value.is_final === true;
    const result: AssemblyAISTTEvent = {
      type: "transcript",
      text: String(value.transcript ?? value.text ?? ""),
      isFinal: final,
    };
    if (typeof value.turn_is_formatted === "boolean") result.turnIsFormatted = value.turn_is_formatted;
    if (typeof value.end_of_turn_confidence === "number") result.confidence = value.end_of_turn_confidence;
    if (Array.isArray(value.words)) result.words = value.words;
    return result;
  }
  if (type === "Error" || type === "error") return { type: "error", error: toError(value.error ?? value.message ?? raw) };
  return { type: "raw", raw };
}

function asRecord(value: unknown): Record<string, unknown> { return value && typeof value === "object" ? value as Record<string, unknown> : {}; }
function toError(value: unknown): Error { return value instanceof Error ? value : new Error(typeof value === "string" ? value : JSON.stringify(value)); }
function throwIfAborted(signal?: AbortSignal): void { if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError"); }
