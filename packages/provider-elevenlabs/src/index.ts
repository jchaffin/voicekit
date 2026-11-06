export type Awaitable<T> = T | Promise<T>;
export type TokenSource = (signal?: AbortSignal) => Awaitable<string>;

export type ElevenAgentsId = string;

export interface ElevenAgentsVersion {
  id: ElevenAgentsId;
  agentId: ElevenAgentsId;
  createdAt?: string;
  label?: string;
}

export interface ElevenAgentsBranch {
  id: ElevenAgentsId;
  agentId: ElevenAgentsId;
  name: string;
  currentVersionId?: ElevenAgentsId;
}

export interface ElevenAgentsDeployment {
  id: ElevenAgentsId;
  agentId: ElevenAgentsId;
  branchId: ElevenAgentsId;
  versionId: ElevenAgentsId;
  environment?: string;
}

export interface ElevenAgentsExperimentVariant {
  branchId: ElevenAgentsId;
  versionId: ElevenAgentsId;
  percentage: number;
  label?: string;
}

export interface ElevenAgentsExperiment {
  id: ElevenAgentsId;
  agentId: ElevenAgentsId;
  variants: readonly ElevenAgentsExperimentVariant[];
}

export type ElevenAgentsRouting =
  | {
      mode: "provider-assigned";
      agentId: ElevenAgentsId;
      experimentId?: ElevenAgentsId;
    }
  | {
      mode: "voicekit-explicit";
      agentId: ElevenAgentsId;
      branchId: ElevenAgentsId;
      versionId: ElevenAgentsId;
      experimentId?: ElevenAgentsId;
      assignmentId?: string;
    };

export interface ElevenAgentsAttribution {
  agentId: ElevenAgentsId;
  branchId: ElevenAgentsId;
  versionId: ElevenAgentsId;
  conversationId?: ElevenAgentsId;
  experimentId?: ElevenAgentsId;
  assignmentId?: string;
  routingMode: ElevenAgentsRouting["mode"];
}

export type ElevenAgentsRouteDescriptor =
  | {
      kind: "signed-url";
      method: "GET";
      agentId: ElevenAgentsId;
      routing: ElevenAgentsRouting;
    }
  | {
      kind: "webrtc-token";
      method: "POST";
      agentId: ElevenAgentsId;
      routing: ElevenAgentsRouting;
    }
  | {
      kind: "initiation-webhook";
      method: "POST";
      agentId: ElevenAgentsId;
      routing: ElevenAgentsRouting;
      webhookId?: ElevenAgentsId;
    };

export interface ElevenAgentsConversationFilters {
  agentId?: ElevenAgentsId;
  branchId?: ElevenAgentsId;
  versionId?: ElevenAgentsId;
  deploymentId?: ElevenAgentsId;
  experimentId?: ElevenAgentsId;
  assignmentId?: string;
  from?: string;
  to?: string;
  cursor?: string;
  limit?: number;
}

export interface ElevenAgentsAnalyticsFilters extends ElevenAgentsConversationFilters {
  groupBy?: "agent" | "branch" | "version" | "deployment" | "experiment";
}

export const elevenAgentsCustomToolVersionCaveat =
  "Custom tools are shared agent resources; changing one can affect multiple branches or versions. Version tool implementations separately when isolation is required.";

export interface ElevenAgentsCustomToolReference {
  toolId: ElevenAgentsId;
  sharedAcrossVersions: true;
  caveat: typeof elevenAgentsCustomToolVersionCaveat;
}

export function defineElevenAgentsExperiment(
  experiment: ElevenAgentsExperiment,
): Readonly<ElevenAgentsExperiment> {
  if (experiment.variants.length < 2) {
    throw new Error("ElevenAgents experiments require at least two variants");
  }
  const total = experiment.variants.reduce((sum, variant) => {
    if (!Number.isFinite(variant.percentage) || variant.percentage <= 0) {
      throw new Error("ElevenAgents experiment percentages must be positive finite numbers");
    }
    return sum + variant.percentage;
  }, 0);
  if (Math.abs(total - 100) > Number.EPSILON * 100) {
    throw new Error(`ElevenAgents experiment percentages must total 100; received ${total}`);
  }
  const targets = new Set(experiment.variants.map(({ branchId, versionId }) => `${branchId}\0${versionId}`));
  if (targets.size !== experiment.variants.length) {
    throw new Error("ElevenAgents experiment variants must target unique branch/version pairs");
  }
  return Object.freeze({
    ...experiment,
    variants: Object.freeze(experiment.variants.map((variant) => Object.freeze({ ...variant }))),
  });
}

export function createElevenAgentsRouteDescriptor<T extends ElevenAgentsRouteDescriptor>(
  descriptor: T,
): Readonly<T> {
  if (descriptor.agentId !== descriptor.routing.agentId) {
    throw new Error("ElevenAgents route agentId must match its routing agentId");
  }
  return Object.freeze({ ...descriptor });
}

export function readElevenAgentsAttribution(
  value: unknown,
  routingMode: ElevenAgentsRouting["mode"],
): ElevenAgentsAttribution {
  const record = asRecord(value);
  const attribution = asRecord(record.attribution ?? record);
  const agentId = requiredString(attribution.agentId ?? attribution.agent_id, "agentId");
  const branchId = requiredString(attribution.branchId ?? attribution.branch_id, "branchId");
  const versionId = requiredString(attribution.versionId ?? attribution.version_id, "versionId");
  return {
    agentId,
    branchId,
    versionId,
    routingMode,
    ...optionalStringFields(attribution),
  };
}

export const elevenLabsCapabilities = {
  realtime: true,
  stt: true,
  llm: true,
  tts: true,
  interruption: true,
  tools: true,
} as const;

export interface ElevenLabsProviderOptions {
  agentId?: string;
  voiceId?: string;
  modelId?: string;
  language?: string;
  outputFormat?: string;
  stability?: number;
  similarityBoost?: number;
  providerOptions?: Record<string, unknown>;
}

export type ElevenLabsEvent =
  | { type: "connected" }
  | { type: "transcript"; role: "user" | "assistant"; text: string; isFinal: boolean }
  | { type: "audio"; audio: Uint8Array }
  | { type: "tool.call"; id: string; name: string; input: unknown }
  | { type: "interrupted" }
  | { type: "error"; error: Error }
  | { type: "raw"; raw: unknown };

export interface ElevenLabsConversationClient {
  connect(config: Record<string, unknown>): Awaitable<void>;
  onEvent(listener: (event: unknown) => void): (() => void) | void;
  send(event: unknown): Awaitable<void>;
  close(): Awaitable<void>;
  interrupt?(): Awaitable<void>;
  raw?: unknown;
}

export type ElevenLabsConversationFactory = (input: {
  token: string;
  signal: AbortSignal | undefined;
  providerOptions: Readonly<ElevenLabsProviderOptions>;
}) => Awaitable<ElevenLabsConversationClient>;

export function createElevenLabsRealtimeProvider(config: {
  token: TokenSource;
  clientFactory: ElevenLabsConversationFactory;
  providerOptions?: ElevenLabsProviderOptions;
}) {
  const providerOptions = Object.freeze({ ...config.providerOptions });
  return {
    name: "elevenlabs",
    product: "eleven-realtime" as const,
    capabilities: elevenLabsCapabilities,
    providerOptions,
    async connect(input: { signal?: AbortSignal } = {}) {
      const token = await config.token(input.signal);
      throwIfAborted(input.signal);
      const client = await config.clientFactory({ token, signal: input.signal, providerOptions });
      const listeners = new Set<(event: ElevenLabsEvent) => void>();
      const off = client.onEvent((raw) => {
        const event = normalizeElevenLabsEvent(raw);
        for (const listener of listeners) listener(event);
      });
      try {
        await client.connect({ token, ...providerOptions.providerOptions, agentId: providerOptions.agentId });
      } catch (error) {
        off?.();
        await client.close();
        throw error;
      }
      let closed = false;
      const send = async (event: unknown) => {
        if (closed) throw new Error("ElevenLabs conversation is closed");
        await client.send(event);
      };
      return {
        capabilities: elevenLabsCapabilities,
        raw: client,
        onEvent(listener: (event: ElevenLabsEvent) => void) { listeners.add(listener); return () => listeners.delete(listener); },
        sendText: (text: string) => send({ type: "user_message", text }),
        sendAudio: (audio: Uint8Array) => send({ type: "user_audio_chunk", audio }),
        sendToolResult: (id: string, result: unknown) => send({ type: "client_tool_result", id, result }),
        async interrupt() {
          if (closed) return;
          if (client.interrupt) await client.interrupt();
          else await client.send({ type: "user_activity" });
        },
        async close() {
          if (closed) return;
          closed = true;
          off?.();
          listeners.clear();
          await client.close();
        },
      };
    },
  };
}

export interface ElevenLabsTTSClient {
  synthesize(input: {
    token: string;
    text: string;
    options: Readonly<ElevenLabsProviderOptions>;
    signal: AbortSignal | undefined;
  }): AsyncIterable<unknown>;
  raw?: unknown;
}

export function createElevenLabsTTSProvider(config: {
  token: TokenSource;
  client: ElevenLabsTTSClient;
  providerOptions?: ElevenLabsProviderOptions;
}) {
  const providerOptions = Object.freeze({ ...config.providerOptions });
  return {
    name: "elevenlabs",
    capabilities: { streaming: true, interruption: false } as const,
    providerOptions,
    raw: config.client.raw ?? config.client,
    async *synthesize(text: string, input: { signal?: AbortSignal } = {}): AsyncIterable<Uint8Array> {
      const token = await config.token(input.signal);
      for await (const chunk of config.client.synthesize({ token, text, options: providerOptions, signal: input.signal })) {
        throwIfAborted(input.signal);
        yield decodeAudio(asRecord(chunk).audio ?? asRecord(chunk).data ?? chunk);
      }
    },
  };
}

export function normalizeElevenLabsEvent(raw: unknown): ElevenLabsEvent {
  const value = asRecord(raw);
  const type = String(value.type ?? "");
  if (type === "conversation_initiation_metadata" || type === "connected") return { type: "connected" };
  if (type === "user_transcript" || type === "agent_response" || type === "agent_response_correction") {
    return {
      type: "transcript",
      role: type === "user_transcript" ? "user" : "assistant",
      text: String(value.text ?? asRecord(value[type]).text ?? ""),
      isFinal: value.is_final !== false,
    };
  }
  if (type === "audio" || type === "audio_chunk") return { type: "audio", audio: decodeAudio(value.audio ?? asRecord(value.audio_event).audio_base_64 ?? value.data) };
  if (type === "client_tool_call" || type === "tool.call") {
    const call = asRecord(value.client_tool_call ?? value);
    return { type: "tool.call", id: String(call.tool_call_id ?? call.id ?? ""), name: String(call.tool_name ?? call.name ?? ""), input: parseJson(call.parameters ?? call.input) };
  }
  if (type === "interruption" || type === "interrupted") return { type: "interrupted" };
  if (type === "error") return { type: "error", error: toError(value.error ?? value.message ?? raw) };
  return { type: "raw", raw };
}

function asRecord(value: unknown): Record<string, unknown> { return value && typeof value === "object" ? value as Record<string, unknown> : {}; }
function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value) throw new Error(`Missing ElevenAgents attribution ${name}`);
  return value;
}
function optionalStringFields(value: Record<string, unknown>): Pick<ElevenAgentsAttribution, "conversationId" | "experimentId" | "assignmentId"> {
  const result: Pick<ElevenAgentsAttribution, "conversationId" | "experimentId" | "assignmentId"> = {};
  const conversationId = value.conversationId ?? value.conversation_id;
  const experimentId = value.experimentId ?? value.experiment_id;
  const assignmentId = value.assignmentId ?? value.assignment_id;
  if (typeof conversationId === "string" && conversationId) result.conversationId = conversationId;
  if (typeof experimentId === "string" && experimentId) result.experimentId = experimentId;
  if (typeof assignmentId === "string" && assignmentId) result.assignmentId = assignmentId;
  return result;
}
function parseJson(value: unknown): unknown { if (typeof value !== "string") return value; try { return JSON.parse(value); } catch { return value; } }
function toError(value: unknown): Error { return value instanceof Error ? value : new Error(typeof value === "string" ? value : JSON.stringify(value)); }
function decodeAudio(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (typeof value !== "string") return new Uint8Array();
  if (typeof Buffer !== "undefined") return Uint8Array.from(Buffer.from(value, "base64"));
  const decoded = atob(value); return Uint8Array.from(decoded, (char) => char.charCodeAt(0));
}
function throwIfAborted(signal?: AbortSignal): void { if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError"); }
