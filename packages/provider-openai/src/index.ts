export type Awaitable<T> = T | Promise<T>;
export type TokenSource = (signal?: AbortSignal) => Awaitable<string>;

export interface ProviderCapabilities {
  readonly realtime: boolean;
  readonly stt: boolean;
  readonly llm: boolean;
  readonly tts: boolean;
  readonly interruption: boolean;
  readonly tools: boolean;
}

export const openAICapabilities = {
  realtime: true, stt: true, llm: true, tts: true, interruption: true, tools: true,
} as const satisfies ProviderCapabilities;

export interface OpenAIProviderOptions {
  model?: string;
  voice?: string;
  language?: string;
  instructions?: string;
  temperature?: number;
  providerOptions?: Record<string, unknown>;
}

export interface RealtimeTool {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

export type OpenAIRealtimeEvent =
  | { type: "connected" }
  | { type: "disconnected"; reason?: string }
  | { type: "speech.start" | "speech.end" }
  | { type: "transcript.delta" | "transcript.final"; role: "user" | "assistant"; text: string; itemId?: string }
  | { type: "audio.delta"; audio: Uint8Array; itemId?: string }
  | { type: "tool.call"; id: string; name: string; input: unknown }
  | { type: "response.done"; responseId?: string }
  | { type: "error"; error: Error }
  | { type: "raw"; raw: unknown };

export interface OpenAIRealtimeClient {
  connect(config: Record<string, unknown>): Awaitable<void>;
  onEvent(listener: (event: unknown) => void): (() => void) | void;
  send(event: unknown): Awaitable<void>;
  close(): Awaitable<void>;
  interrupt?(): Awaitable<void>;
  raw?: unknown;
}

export type OpenAIRealtimeClientFactory = (input: {
  token: string;
  signal: AbortSignal | undefined;
  providerOptions: Readonly<OpenAIProviderOptions>;
}) => Awaitable<OpenAIRealtimeClient>;

export interface OpenAIRealtimeSession {
  readonly capabilities: typeof openAICapabilities;
  readonly raw: OpenAIRealtimeClient;
  sendText(text: string): Promise<void>;
  sendAudio(audio: Uint8Array): Promise<void>;
  sendToolResult(callId: string, result: unknown): Promise<void>;
  interrupt(): Promise<void>;
  close(): Promise<void>;
  onEvent(listener: (event: OpenAIRealtimeEvent) => void): () => void;
}

export function createOpenAIRealtimeProvider(config: {
  token: TokenSource;
  clientFactory: OpenAIRealtimeClientFactory;
  providerOptions?: OpenAIProviderOptions;
}) {
  const providerOptions = Object.freeze({ ...config.providerOptions });
  return {
    name: "openai",
    capabilities: openAICapabilities,
    providerOptions,
    async connect(input: { tools?: RealtimeTool[]; signal?: AbortSignal } = {}): Promise<OpenAIRealtimeSession> {
      throwIfAborted(input.signal);
      const token = await config.token(input.signal);
      throwIfAborted(input.signal);
      const client = await config.clientFactory({ token, signal: input.signal, providerOptions });
      const listeners = new Set<(event: OpenAIRealtimeEvent) => void>();
      let closed = false;
      const unsubscribe = client.onEvent((raw) => {
        const event = normalizeOpenAIRealtimeEvent(raw);
        for (const listener of listeners) listener(event);
      });
      try {
        await client.connect({
          model: providerOptions.model ?? "gpt-realtime",
          voice: providerOptions.voice,
          language: providerOptions.language,
          instructions: providerOptions.instructions,
          temperature: providerOptions.temperature,
          tools: input.tools,
          ...providerOptions.providerOptions,
        });
      } catch (error) {
        unsubscribe?.();
        await client.close();
        throw error;
      }
      const send = async (event: unknown) => {
        if (closed) throw new Error("OpenAI realtime session is closed");
        await client.send(event);
      };
      return {
        capabilities: openAICapabilities,
        raw: client,
        sendText: (text) => send({ type: "input_text", text }),
        sendAudio: (audio) => send({ type: "input_audio", audio }),
        sendToolResult: (callId, result) => send({ type: "tool_result", callId, result }),
        interrupt: async () => {
          if (closed) return;
          if (client.interrupt) await client.interrupt();
          else await client.send({ type: "response.cancel" });
        },
        close: async () => {
          if (closed) return;
          closed = true;
          unsubscribe?.();
          listeners.clear();
          await client.close();
        },
        onEvent(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      };
    },
  };
}

export interface OpenAILLMClient {
  stream(input: {
    token: string;
    messages: readonly { role: "system" | "user" | "assistant" | "tool"; content: string }[];
    tools?: readonly RealtimeTool[];
    options: Readonly<OpenAIProviderOptions>;
    signal: AbortSignal | undefined;
  }): AsyncIterable<unknown>;
  raw?: unknown;
}

export type LLMEvent =
  | { type: "text.delta"; text: string }
  | { type: "tool.call"; id: string; name: string; input: unknown }
  | { type: "finish"; reason?: string }
  | { type: "raw"; raw: unknown };

export function createOpenAILLMProvider(config: {
  token: TokenSource;
  client: OpenAILLMClient;
  providerOptions?: OpenAIProviderOptions;
}) {
  const providerOptions = Object.freeze({ ...config.providerOptions });
  return {
    name: "openai",
    capabilities: { streaming: true, tools: true } as const,
    providerOptions,
    raw: config.client.raw ?? config.client,
    async *stream(input: Parameters<OpenAILLMClient["stream"]>[0] extends infer _ ? {
      messages: readonly { role: "system" | "user" | "assistant" | "tool"; content: string }[];
      tools?: readonly RealtimeTool[];
      signal?: AbortSignal;
    } : never): AsyncIterable<LLMEvent> {
      const token = await config.token(input.signal);
      for await (const raw of config.client.stream({
        messages: input.messages,
        ...(input.tools ? { tools: input.tools } : {}),
        signal: input.signal,
        token,
        options: providerOptions,
      })) {
        throwIfAborted(input.signal);
        yield normalizeLLMEvent(raw);
      }
    },
  };
}

export function normalizeOpenAIRealtimeEvent(raw: unknown): OpenAIRealtimeEvent {
  const value = asRecord(raw);
  const type = String(value.type ?? "");
  if (type === "session.created" || type === "connected") return { type: "connected" };
  if (type === "disconnected" || type === "session.closed") {
    const reason = stringOrUndefined(value.reason);
    return reason ? { type: "disconnected", reason } : { type: "disconnected" };
  }
  if (type.includes("speech_started")) return { type: "speech.start" };
  if (type.includes("speech_stopped")) return { type: "speech.end" };
  if (type.includes("transcription") || type.includes("transcript") || type.includes("output_text")) {
    const final = type.endsWith(".done") || type.endsWith(".completed") || value.isFinal === true;
    const event: OpenAIRealtimeEvent = {
      type: final ? "transcript.final" : "transcript.delta",
      role: type.includes("input_audio") ? "user" : "assistant",
      text: String(value.delta ?? value.transcript ?? value.text ?? ""),
    };
    const itemId = stringOrUndefined(value.item_id ?? value.itemId);
    if (itemId) event.itemId = itemId;
    return event;
  }
  if (type.includes("audio.delta")) {
    const itemId = stringOrUndefined(value.item_id);
    return itemId
      ? { type: "audio.delta", audio: decodeAudio(value.delta ?? value.audio), itemId }
      : { type: "audio.delta", audio: decodeAudio(value.delta ?? value.audio) };
  }
  if (type.includes("function_call") || type === "tool.call") {
    return { type: "tool.call", id: String(value.call_id ?? value.id ?? ""), name: String(value.name ?? ""), input: parseJson(value.arguments ?? value.input) };
  }
  if (type === "response.done") {
    const responseId = stringOrUndefined(asRecord(value.response).id);
    return responseId ? { type: "response.done", responseId } : { type: "response.done" };
  }
  if (type === "error") return { type: "error", error: toError(value.error ?? raw) };
  return { type: "raw", raw };
}

function normalizeLLMEvent(raw: unknown): LLMEvent {
  const value = asRecord(raw);
  const type = String(value.type ?? "");
  if (type.includes("function") || type === "tool.call") return { type: "tool.call", id: String(value.id ?? value.call_id ?? ""), name: String(value.name ?? ""), input: parseJson(value.input ?? value.arguments) };
  if (type.includes("delta") && typeof (value.text ?? value.delta) === "string") return { type: "text.delta", text: String(value.text ?? value.delta) };
  if (type.includes("done") || type === "finish") {
    const reason = stringOrUndefined(value.reason);
    return reason ? { type: "finish", reason } : { type: "finish" };
  }
  return { type: "raw", raw };
}

function asRecord(value: unknown): Record<string, unknown> { return value && typeof value === "object" ? value as Record<string, unknown> : {}; }
function stringOrUndefined(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }
function parseJson(value: unknown): unknown { if (typeof value !== "string") return value; try { return JSON.parse(value); } catch { return value; } }
function toError(value: unknown): Error { return value instanceof Error ? value : new Error(typeof value === "string" ? value : JSON.stringify(value)); }
function decodeAudio(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (typeof value !== "string") return new Uint8Array();
  if (typeof Buffer !== "undefined") return Uint8Array.from(Buffer.from(value, "base64"));
  const decoded = atob(value); return Uint8Array.from(decoded, (char) => char.charCodeAt(0));
}
function throwIfAborted(signal?: AbortSignal): void { if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError"); }
