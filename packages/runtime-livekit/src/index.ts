export type Awaitable<T> = T | Promise<T>;

export const liveKitAgentSdkMinimums = {
  python: "1.6.0",
  node: "1.7.1",
  nodePackage: "@livekit/agents",
} as const;

export const liveKitDeploymentSemantics = {
  defaultEnvironment: "production",
  nonProductionColdStart: true,
  redeployBehavior: "disconnect-immediately",
  rollbackSupported: false,
  secretsScope: "shared",
  insightsMetrics: "production-only",
  sdkMinimums: liveKitAgentSdkMinimums,
} as const;

export type LiveKitRuntimeJson =
  | null
  | boolean
  | number
  | string
  | readonly LiveKitRuntimeJson[]
  | { readonly [key: string]: LiveKitRuntimeJson };

export interface LiveKitRuntimeDeployment {
  agentName: string;
  deploymentName: string;
  environment: "production" | "non-production";
  metadata: Readonly<Record<string, LiveKitRuntimeJson>>;
  experimentAssignmentId?: string;
}

export function defineLiveKitRuntimeDeployment(
  input: Omit<LiveKitRuntimeDeployment, "environment" | "metadata"> & {
    environment?: LiveKitRuntimeDeployment["environment"];
    metadata?: Readonly<Record<string, LiveKitRuntimeJson>>;
  },
): Readonly<LiveKitRuntimeDeployment> {
  if (!input.agentName) throw new Error("LiveKit runtime deployment requires an agent name");
  if (!input.deploymentName) throw new Error("LiveKit runtime deployment requires a deployment name");
  assertJson(input.metadata ?? {}, "metadata");
  return Object.freeze({
    ...input,
    environment: input.environment ?? "production",
    metadata: Object.freeze({ ...(input.metadata ?? {}) }),
  });
}

export const liveKitRuntimeCapabilities = {
  hosted: true,
  audio: true,
  interruption: true,
  tools: true,
  transport: "livekit",
  deployment: liveKitDeploymentSemantics,
} as const;

export interface LiveKitRuntimeOptions {
  protocolVersion?: "1";
  dataTopic?: string;
  agentName?: string;
  deploymentName?: string;
  environment?: LiveKitRuntimeDeployment["environment"];
  metadata?: Readonly<Record<string, LiveKitRuntimeJson>>;
  experimentAssignmentId?: string;
  instructions?: string;
  providerOptions?: Record<string, unknown>;
}

export interface LiveKitRuntimeTransport {
  send(payload: Record<string, unknown>, options?: { reliable?: boolean; topic?: string }): Awaitable<void>;
  onEvent(listener: (event: unknown) => void): () => void;
  close(): Awaitable<void>;
  raw?: unknown;
}

export interface RuntimeTool {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  execute(input: unknown, context: { signal: AbortSignal }): Awaitable<unknown>;
}

export type LiveKitRuntimeEvent =
  | { type: "ready"; sessionId?: string }
  | { type: "transcript"; role: "user" | "assistant"; text: string; isFinal: boolean; itemId?: string }
  | { type: "audio"; audio: Uint8Array; itemId?: string }
  | { type: "speech.start" | "speech.end"; role: "user" | "assistant" }
  | { type: "tool.start"; id: string; name: string; input: unknown }
  | { type: "tool.end"; id: string; name: string; output: unknown }
  | { type: "interrupted"; itemId?: string }
  | { type: "error"; error: Error }
  | { type: "raw"; raw: unknown };

export function createLiveKitRuntime(config: {
  transport: LiveKitRuntimeTransport;
  tools?: readonly RuntimeTool[];
  providerOptions?: LiveKitRuntimeOptions;
}) {
  const providerOptions = Object.freeze({ protocolVersion: "1" as const, ...config.providerOptions });
  const tools = new Map((config.tools ?? []).map((tool) => [tool.name, tool]));
  const listeners = new Set<(event: LiveKitRuntimeEvent) => void>();
  const toolControllers = new Map<string, AbortController>();
  let closed = false;

  const send = async (payload: Record<string, unknown>) => {
    if (closed) throw new Error("LiveKit runtime is closed");
    await config.transport.send(
      { voicekit: providerOptions.protocolVersion, ...payload },
      { reliable: true, topic: providerOptions.dataTopic ?? "voicekit.v1" },
    );
  };

  const off = config.transport.onEvent((transportEvent) => {
    const record = asRecord(transportEvent);
    if (record.type !== "data") {
      if (record.type === "error") emit({ type: "error", error: toError(record.error) });
      return;
    }
    const message = decodeMessage(record.payload);
    if (!message || message.voicekit !== providerOptions.protocolVersion) {
      emit({ type: "raw", raw: transportEvent });
      return;
    }
    void handleMessage(message);
  });

  async function handleMessage(message: Record<string, unknown>): Promise<void> {
    const event = normalizeRuntimeMessage(message);
    emit(event);
    if (event.type !== "tool.start") return;
    const tool = tools.get(event.name);
    if (!tool) {
      await send({ type: "tool.result", id: event.id, error: `Unknown tool: ${event.name}` });
      return;
    }
    const controller = new AbortController();
    toolControllers.set(event.id, controller);
    try {
      const output = await tool.execute(event.input, { signal: controller.signal });
      emit({ type: "tool.end", id: event.id, name: event.name, output });
      await send({ type: "tool.result", id: event.id, output });
    } catch (error) {
      await send({ type: "tool.result", id: event.id, error: toError(error).message });
    } finally {
      toolControllers.delete(event.id);
    }
  }

  function emit(event: LiveKitRuntimeEvent): void {
    for (const listener of listeners) listener(event);
  }

  return {
    name: "livekit-runtime",
    capabilities: liveKitRuntimeCapabilities,
    providerOptions,
    raw: config.transport.raw ?? config.transport,
    onEvent(listener: (event: LiveKitRuntimeEvent) => void) { listeners.add(listener); return () => listeners.delete(listener); },
    async start() {
      if (providerOptions.metadata) assertJson(providerOptions.metadata, "metadata");
      await send({
        type: "session.configure",
        agent: {
          name: providerOptions.agentName,
          deployment: providerOptions.deploymentName,
          environment: providerOptions.environment ?? "production",
          metadata: providerOptions.metadata,
          experimentAssignmentId: providerOptions.experimentAssignmentId,
          instructions: providerOptions.instructions,
        },
        tools: [...tools.values()].map(({ name, description, parameters }) => ({ name, description, parameters })),
        ...providerOptions.providerOptions,
      });
    },
    sendText(text: string) { return send({ type: "input.text", text }); },
    sendAudio(audio: Uint8Array) { return send({ type: "input.audio", audio: toBase64(audio) }); },
    async interrupt() {
      for (const controller of toolControllers.values()) controller.abort(new Error("Interrupted"));
      toolControllers.clear();
      await send({ type: "response.interrupt" });
    },
    async close() {
      if (closed) return;
      await send({ type: "session.close" });
      closed = true;
      off();
      for (const controller of toolControllers.values()) controller.abort(new Error("Runtime closed"));
      toolControllers.clear();
      listeners.clear();
      await config.transport.close();
    },
  };
}

export function normalizeRuntimeMessage(message: Record<string, unknown>): LiveKitRuntimeEvent {
  const type = String(message.type ?? "");
  if (type === "session.ready") {
    const sessionId = stringValue(message.sessionId ?? message.session_id);
    return sessionId ? { type: "ready", sessionId } : { type: "ready" };
  }
  if (type === "transcript") {
    const itemId = stringValue(message.itemId ?? message.item_id);
    const event: LiveKitRuntimeEvent = {
      type: "transcript",
      role: message.role === "user" ? "user" : "assistant",
      text: String(message.text ?? message.delta ?? ""),
      isFinal: Boolean(message.isFinal ?? message.is_final),
    };
    if (itemId) event.itemId = itemId;
    return event;
  }
  if (type === "audio") {
    const itemId = stringValue(message.itemId ?? message.item_id);
    return itemId
      ? { type: "audio", audio: fromBase64(String(message.audio ?? "")), itemId }
      : { type: "audio", audio: fromBase64(String(message.audio ?? "")) };
  }
  if (type === "speech.start" || type === "speech.end") return { type, role: message.role === "assistant" ? "assistant" : "user" };
  if (type === "tool.call") return { type: "tool.start", id: String(message.id ?? ""), name: String(message.name ?? ""), input: parseJson(message.input ?? message.arguments) };
  if (type === "interrupted") {
    const itemId = stringValue(message.itemId ?? message.item_id);
    return itemId ? { type: "interrupted", itemId } : { type: "interrupted" };
  }
  if (type === "error") return { type: "error", error: toError(message.error ?? message.message) };
  return { type: "raw", raw: message };
}

function decodeMessage(value: unknown): Record<string, unknown> | null {
  try {
    if (value instanceof Uint8Array) return asRecord(JSON.parse(new TextDecoder().decode(value)));
    if (typeof value === "string") return asRecord(JSON.parse(value));
    return value && typeof value === "object" ? asRecord(value) : null;
  } catch { return null; }
}
function asRecord(value: unknown): Record<string, unknown> { return value && typeof value === "object" ? value as Record<string, unknown> : {}; }
function stringValue(value: unknown): string | undefined { return typeof value === "string" && value ? value : undefined; }
function parseJson(value: unknown): unknown { if (typeof value !== "string") return value; try { return JSON.parse(value); } catch { return value; } }
function toError(value: unknown): Error { return value instanceof Error ? value : new Error(typeof value === "string" ? value : JSON.stringify(value)); }
function toBase64(value: Uint8Array): string { return typeof Buffer !== "undefined" ? Buffer.from(value).toString("base64") : btoa(String.fromCharCode(...value)); }
function fromBase64(value: string): Uint8Array { return typeof Buffer !== "undefined" ? Uint8Array.from(Buffer.from(value, "base64")) : Uint8Array.from(atob(value), (char) => char.charCodeAt(0)); }
function assertJson(value: unknown, path: string): asserts value is LiveKitRuntimeJson {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return;
    throw new Error(`LiveKit runtime ${path} must contain finite JSON numbers`);
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJson(item, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) assertJson(item, `${path}.${key}`);
    return;
  }
  throw new Error(`LiveKit runtime ${path} must be JSON-serializable`);
}
