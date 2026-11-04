export const PIPECAT_MANIFEST_VERSION = "1" as const;
export const PIPECAT_CONTROL_VERSION = "1" as const;

export interface PipecatRuntimeManifestV1 {
  schema: "voicekit.pipecat.runtime";
  version: "1";
  runtime: {
    python: string;
    pipecat: string;
    entrypoint: string;
  };
  transport: {
    kind: "websocket" | "daily" | "livekit" | "webrtc";
    audioInput: string;
    audioOutput: string;
  };
  capabilities: {
    interruption: boolean;
    tools: boolean;
    metrics: boolean;
  };
  metadata?: Record<string, string>;
}

export type ManifestValidation =
  | { ok: true; value: PipecatRuntimeManifestV1 }
  | { ok: false; errors: string[] };

export function validatePipecatRuntimeManifest(value: unknown): ManifestValidation {
  const errors: string[] = [];
  const record = object(value, "manifest", errors);
  if (!record) return { ok: false, errors };
  if (record.schema !== "voicekit.pipecat.runtime") errors.push("manifest.schema must be voicekit.pipecat.runtime");
  if (record.version !== PIPECAT_MANIFEST_VERSION) errors.push(`manifest.version must be ${PIPECAT_MANIFEST_VERSION}`);
  const runtime = object(record.runtime, "manifest.runtime", errors);
  requiredString(runtime, "python", "manifest.runtime.python", errors);
  requiredString(runtime, "pipecat", "manifest.runtime.pipecat", errors);
  requiredString(runtime, "entrypoint", "manifest.runtime.entrypoint", errors);
  const transport = object(record.transport, "manifest.transport", errors);
  if (transport && !["websocket", "daily", "livekit", "webrtc"].includes(String(transport.kind))) errors.push("manifest.transport.kind is unsupported");
  requiredString(transport, "audioInput", "manifest.transport.audioInput", errors);
  requiredString(transport, "audioOutput", "manifest.transport.audioOutput", errors);
  const capabilities = object(record.capabilities, "manifest.capabilities", errors);
  requiredBoolean(capabilities, "interruption", "manifest.capabilities.interruption", errors);
  requiredBoolean(capabilities, "tools", "manifest.capabilities.tools", errors);
  requiredBoolean(capabilities, "metrics", "manifest.capabilities.metrics", errors);
  if (record.metadata !== undefined) {
    const metadata = object(record.metadata, "manifest.metadata", errors);
    if (metadata) for (const [key, item] of Object.entries(metadata)) if (typeof item !== "string") errors.push(`manifest.metadata.${key} must be a string`);
  }
  return errors.length ? { ok: false, errors } : { ok: true, value: value as PipecatRuntimeManifestV1 };
}

export function parsePipecatRuntimeManifest(value: unknown): PipecatRuntimeManifestV1 {
  const result = validatePipecatRuntimeManifest(value);
  if (!result.ok) throw new TypeError(`Invalid Pipecat runtime manifest:\n- ${result.errors.join("\n- ")}`);
  return result.value;
}

export function emitPipecatRuntimeManifest(input: Omit<PipecatRuntimeManifestV1, "schema" | "version">): PipecatRuntimeManifestV1 {
  return parsePipecatRuntimeManifest({
    schema: "voicekit.pipecat.runtime",
    version: PIPECAT_MANIFEST_VERSION,
    ...input,
  });
}

export interface PipecatControlTransport {
  send(message: PipecatControlRequest): Promise<void> | void;
  onMessage(listener: (message: unknown) => void): () => void;
  close(): Promise<void> | void;
  raw?: unknown;
}

export type PipecatControlRequest =
  | { version: "1"; type: "configure"; id: string; config: Record<string, unknown> }
  | { version: "1"; type: "input.text"; id: string; text: string }
  | { version: "1"; type: "interrupt"; id: string }
  | { version: "1"; type: "tool.result"; id: string; callId: string; output?: unknown; error?: string }
  | { version: "1"; type: "close"; id: string };

type PipecatControlRequestBody =
  | { type: "configure"; config: Record<string, unknown> }
  | { type: "input.text"; text: string }
  | { type: "interrupt" }
  | { type: "tool.result"; callId: string; output?: unknown; error?: string }
  | { type: "close" };

export type PipecatControlEvent =
  | { version: "1"; type: "ready"; requestId?: string }
  | { version: "1"; type: "transcript"; role: "user" | "assistant"; text: string; isFinal: boolean; itemId?: string }
  | { version: "1"; type: "tool.call"; callId: string; name: string; input: unknown }
  | { version: "1"; type: "interrupted"; itemId?: string }
  | { version: "1"; type: "ack"; requestId: string }
  | { version: "1"; type: "error"; requestId?: string; message: string }
  | { version: "1"; type: "raw"; raw: unknown };

export function validatePipecatControlEvent(value: unknown): PipecatControlEvent {
  const record = object(value, "control event", []);
  if (!record || record.version !== PIPECAT_CONTROL_VERSION || typeof record.type !== "string") {
    throw new TypeError("Invalid Pipecat control event envelope");
  }
  const type = record.type;
  if (type === "ready") {
    return typeof record.requestId === "string"
      ? { version: "1", type: "ready", requestId: record.requestId }
      : { version: "1", type: "ready" };
  }
  if (type === "transcript") {
    if (record.role !== "user" && record.role !== "assistant") throw new TypeError("Invalid transcript role");
    if (typeof record.text !== "string" || typeof record.isFinal !== "boolean") throw new TypeError("Invalid transcript event");
    const result: PipecatControlEvent = { version: "1", type, role: record.role, text: record.text, isFinal: record.isFinal };
    if (typeof record.itemId === "string") result.itemId = record.itemId;
    return result;
  }
  if (type === "tool.call") {
    if (typeof record.callId !== "string" || typeof record.name !== "string") throw new TypeError("Invalid tool.call event");
    return { version: "1", type, callId: record.callId, name: record.name, input: record.input };
  }
  if (type === "interrupted") {
    return typeof record.itemId === "string"
      ? { version: "1", type, itemId: record.itemId }
      : { version: "1", type };
  }
  if (type === "ack") {
    if (typeof record.requestId !== "string") throw new TypeError("Invalid ack event");
    return { version: "1", type, requestId: record.requestId };
  }
  if (type === "error") {
    if (typeof record.message !== "string") throw new TypeError("Invalid error event");
    const result: PipecatControlEvent = { version: "1", type, message: record.message };
    if (typeof record.requestId === "string") result.requestId = record.requestId;
    return result;
  }
  return { version: "1", type: "raw", raw: value };
}

export function createPipecatControlClient(config: {
  transport: PipecatControlTransport;
  requestId?: () => string;
}) {
  const nextId = config.requestId ?? (() => globalThis.crypto?.randomUUID?.() ?? `request-${Date.now()}-${Math.random()}`);
  const listeners = new Set<(event: PipecatControlEvent) => void>();
  const pending = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
  let closed = false;
  const off = config.transport.onMessage((raw) => {
    let event: PipecatControlEvent;
    try { event = validatePipecatControlEvent(raw); }
    catch (error) { event = { version: "1", type: "error", message: toError(error).message }; }
    if (event.type === "ack") {
      pending.get(event.requestId)?.resolve();
      pending.delete(event.requestId);
    } else if (event.type === "error" && event.requestId) {
      pending.get(event.requestId)?.reject(new Error(event.message));
      pending.delete(event.requestId);
    }
    for (const listener of listeners) listener(event);
  });

  const send = async (message: PipecatControlRequestBody, waitForAck = false): Promise<void> => {
    if (closed) throw new Error("Pipecat control client is closed");
    const id = nextId();
    const ack = waitForAck
      ? new Promise<void>((resolve, reject) => pending.set(id, { resolve, reject }))
      : undefined;
    await config.transport.send({ version: "1", id, ...message } as PipecatControlRequest);
    await ack;
  };

  return {
    version: PIPECAT_CONTROL_VERSION,
    raw: config.transport.raw ?? config.transport,
    onEvent(listener: (event: PipecatControlEvent) => void) { listeners.add(listener); return () => listeners.delete(listener); },
    configure(configuration: Record<string, unknown>, waitForAck = false) { return send({ type: "configure", config: configuration }, waitForAck); },
    sendText(text: string) { return send({ type: "input.text", text }); },
    interrupt() { return send({ type: "interrupt" }); },
    sendToolResult(callId: string, output: unknown) { return send({ type: "tool.result", callId, output }); },
    sendToolError(callId: string, error: string) { return send({ type: "tool.result", callId, error }); },
    async close() {
      if (closed) return;
      await send({ type: "close" });
      closed = true;
      off();
      for (const request of pending.values()) request.reject(new Error("Pipecat control client closed"));
      pending.clear();
      listeners.clear();
      await config.transport.close();
    },
  };
}

function object(value: unknown, path: string, errors: string[]): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) { errors.push(`${path} must be an object`); return null; }
  return value as Record<string, unknown>;
}
function requiredString(record: Record<string, unknown> | null, key: string, path: string, errors: string[]): void {
  if (record && (typeof record[key] !== "string" || record[key] === "")) errors.push(`${path} must be a non-empty string`);
}
function requiredBoolean(record: Record<string, unknown> | null, key: string, path: string, errors: string[]): void {
  if (record && typeof record[key] !== "boolean") errors.push(`${path} must be a boolean`);
}
function toError(value: unknown): Error { return value instanceof Error ? value : new Error(String(value)); }
