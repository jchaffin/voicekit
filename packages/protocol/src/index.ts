export const VOICEKIT_PROTOCOL_VERSION = "1.0" as const;
export type ProtocolVersion = typeof VOICEKIT_PROTOCOL_VERSION;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface TraceContext {
  traceId: string;
  spanId?: string;
  parentSpanId?: string;
}

export interface EventMetadata {
  causationId?: string;
  correlationId?: string;
  trace?: TraceContext;
  provider?: string;
  tags?: Readonly<Record<string, string>>;
}

export type SessionPhase =
  | "created"
  | "provisioning"
  | "connecting"
  | "ready"
  | "listening"
  | "thinking"
  | "speaking"
  | "handing-off"
  | "reconnecting"
  | "draining"
  | "closed"
  | "failed";

interface TypedEvent<TType extends string, TData> {
  type: TType;
  data: TData;
}

export type LifecycleEvent =
  | TypedEvent<"lifecycle.phase_changed", { from: SessionPhase; to: SessionPhase; reason?: string }>
  | TypedEvent<"lifecycle.session_created", { configuration?: JsonValue }>
  | TypedEvent<"lifecycle.session_closed", { reason: string; clean: boolean }>
  | TypedEvent<"lifecycle.command_accepted", { commandId: string; commandType: Command["type"]; noOp: true }>;

export type MediaEvent =
  | TypedEvent<"media.stream_started", { streamId: string; direction: "input" | "output"; codec: string; sampleRate: number }>
  | TypedEvent<"media.stream_stopped", { streamId: string; reason?: string }>
  | TypedEvent<"media.frame", { streamId: string; sequence: number; timestampMs: number; payload: string; encoding: "base64" }>;

export type TurnEvent =
  | TypedEvent<"turn.started", { turnId: string; participant: "user" | "agent" }>
  | TypedEvent<"turn.ended", { turnId: string; participant: "user" | "agent"; reason: "completed" | "interrupted" | "cancelled" }>
  | TypedEvent<"turn.interrupted", { turnId: string; by: "user" | "agent" | "system" }>;

export type TranscriptEvent =
  | TypedEvent<"transcript.partial", { turnId: string; text: string; language?: string; confidence?: number }>
  | TypedEvent<"transcript.final", { turnId: string; text: string; language?: string; confidence?: number }>;

export type AgentEvent =
  | TypedEvent<"agent.response_started", { turnId: string; responseId: string }>
  | TypedEvent<"agent.response_delta", { turnId: string; responseId: string; delta: string }>
  | TypedEvent<"agent.response_completed", { turnId: string; responseId: string; text?: string }>;

export type ToolEvent =
  | TypedEvent<"tool.call_started", { callId: string; name: string; arguments: JsonValue }>
  | TypedEvent<"tool.call_completed", { callId: string; name: string; result: JsonValue }>
  | TypedEvent<"tool.call_failed", { callId: string; name: string; error: ErrorDescriptor }>;

export type HandoffEvent =
  | TypedEvent<"handoff.requested", { handoffId: string; target: string; reason?: string }>
  | TypedEvent<"handoff.accepted", { handoffId: string; target: string }>
  | TypedEvent<"handoff.completed", { handoffId: string; target: string }>
  | TypedEvent<"handoff.failed", { handoffId: string; target: string; error: ErrorDescriptor }>;

export type PolicyEvent =
  | TypedEvent<"policy.decision", { policy: string; outcome: "allow" | "deny" | "redact"; reason?: string }>
  | TypedEvent<"policy.violation", { policy: string; severity: "info" | "warning" | "critical"; detail?: string }>;

export type UsageEvent = TypedEvent<
  "usage.recorded",
  { metric: "audio_input_ms" | "audio_output_ms" | "input_tokens" | "output_tokens" | "tool_calls"; quantity: number; unit: string }
>;

export interface ErrorDescriptor {
  code: string;
  message: string;
  retryable: boolean;
  details?: JsonValue;
}

export type ErrorEvent =
  | TypedEvent<"error.occurred", ErrorDescriptor & { fatal: boolean }>
  | TypedEvent<"error.recovered", { code: string; message?: string }>;

export type ProviderEvent = TypedEvent<
  "provider.raw",
  { provider: string; eventType: string; payload: JsonValue; receivedAt: string }
>;

export type VoiceKitEvent =
  | LifecycleEvent
  | MediaEvent
  | TurnEvent
  | TranscriptEvent
  | AgentEvent
  | ToolEvent
  | HandoffEvent
  | PolicyEvent
  | UsageEvent
  | ErrorEvent
  | ProviderEvent;

export interface EventEnvelope<TEvent extends VoiceKitEvent = VoiceKitEvent> {
  protocolVersion: ProtocolVersion;
  id: string;
  sessionId: string;
  sequence: number;
  timestamp: string;
  event: TEvent;
  metadata?: EventMetadata;
}

export type Command =
  | TypedEvent<"session.provision", { configuration?: JsonValue }>
  | TypedEvent<"session.connect", {}>
  | TypedEvent<"session.ready", {}>
  | TypedEvent<"session.listen", {}>
  | TypedEvent<"session.think", { turnId?: string }>
  | TypedEvent<"session.speak", { turnId?: string }>
  | TypedEvent<"session.handoff", { handoffId: string; target: string; reason?: string }>
  | TypedEvent<"session.reconnect", { reason?: string }>
  | TypedEvent<"session.drain", { reason?: string }>
  | TypedEvent<"session.close", { reason?: string }>
  | TypedEvent<"session.fail", { error: ErrorDescriptor }>
  | TypedEvent<"session.transition", { phase: SessionPhase; reason?: string }>
  | TypedEvent<"provider.emit_raw", { provider: string; eventType: string; payload: JsonValue }>;

export interface CommandEnvelope<TCommand extends Command = Command> {
  protocolVersion: ProtocolVersion;
  id: string;
  sessionId: string;
  timestamp: string;
  command: TCommand;
  deadline?: string;
  metadata?: EventMetadata;
}

export interface CapabilityDescriptor {
  name: string;
  version: string;
  required?: boolean;
  configuration?: Readonly<Record<string, JsonValue>>;
}

export interface CapabilityOffer {
  protocolVersions: readonly string[];
  capabilities: readonly CapabilityDescriptor[];
}

export interface NegotiatedCapabilities {
  protocolVersion: ProtocolVersion;
  capabilities: readonly CapabilityDescriptor[];
}

export type CapabilityNegotiationErrorCode =
  | "NO_COMMON_PROTOCOL_VERSION"
  | "MISSING_REQUIRED_CAPABILITY"
  | "CAPABILITY_VERSION_MISMATCH";

export class CapabilityNegotiationError extends Error {
  readonly code: CapabilityNegotiationErrorCode;
  readonly capability: string | undefined;

  constructor(code: CapabilityNegotiationErrorCode, message: string, capability?: string) {
    super(message);
    this.name = "CapabilityNegotiationError";
    this.code = code;
    this.capability = capability;
  }
}

export type CapabilityNegotiationResult =
  | { ok: true; value: NegotiatedCapabilities }
  | { ok: false; error: CapabilityNegotiationError };

function parseVersion(version: string): readonly number[] | undefined {
  if (!/^\d+(?:\.\d+)*$/.test(version)) return undefined;
  return version.split(".").map(Number);
}

function compareVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return left.localeCompare(right);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export function negotiateCapabilities(
  local: CapabilityOffer,
  remote: CapabilityOffer,
): CapabilityNegotiationResult {
  const commonVersions = local.protocolVersions
    .filter((version) => remote.protocolVersions.includes(version))
    .sort(compareVersions)
    .reverse();
  const selectedVersion = commonVersions[0];
  if (selectedVersion !== VOICEKIT_PROTOCOL_VERSION) {
    return {
      ok: false,
      error: new CapabilityNegotiationError(
        "NO_COMMON_PROTOCOL_VERSION",
        `VoiceKit protocol ${VOICEKIT_PROTOCOL_VERSION} is not supported by both peers`,
      ),
    };
  }

  const localByName = new Map(local.capabilities.map((capability) => [capability.name, capability]));
  const remoteByName = new Map(remote.capabilities.map((capability) => [capability.name, capability]));
  for (const capability of local.capabilities) {
    if (capability.required && !remoteByName.has(capability.name)) {
      return {
        ok: false,
        error: new CapabilityNegotiationError(
          "MISSING_REQUIRED_CAPABILITY",
          `Required capability "${capability.name}" is unavailable`,
          capability.name,
        ),
      };
    }
  }
  for (const capability of remote.capabilities) {
    if (capability.required && !localByName.has(capability.name)) {
      return {
        ok: false,
        error: new CapabilityNegotiationError(
          "MISSING_REQUIRED_CAPABILITY",
          `Required capability "${capability.name}" is unavailable`,
          capability.name,
        ),
      };
    }
  }

  const negotiated: CapabilityDescriptor[] = [];
  for (const localCapability of local.capabilities) {
    const remoteCapability = remoteByName.get(localCapability.name);
    if (!remoteCapability) continue;
    if (localCapability.version !== remoteCapability.version) {
      if (localCapability.required || remoteCapability.required) {
        return {
          ok: false,
          error: new CapabilityNegotiationError(
            "CAPABILITY_VERSION_MISMATCH",
            `Capability "${localCapability.name}" requires matching versions (${localCapability.version} vs ${remoteCapability.version})`,
            localCapability.name,
          ),
        };
      }
      continue;
    }
    negotiated.push(localCapability);
  }

  return {
    ok: true,
    value: { protocolVersion: VOICEKIT_PROTOCOL_VERSION, capabilities: negotiated },
  };
}

export function createCommandEnvelope<TCommand extends Command>(
  sessionId: string,
  command: TCommand,
  options: { id?: string; timestamp?: string; deadline?: string; metadata?: EventMetadata } = {},
): CommandEnvelope<TCommand> {
  const envelope: CommandEnvelope<TCommand> = {
    protocolVersion: VOICEKIT_PROTOCOL_VERSION,
    id: options.id ?? crypto.randomUUID(),
    sessionId,
    timestamp: options.timestamp ?? new Date().toISOString(),
    command,
  };
  if (options.deadline !== undefined) envelope.deadline = options.deadline;
  if (options.metadata !== undefined) envelope.metadata = options.metadata;
  return envelope;
}
