export const POLICY_STAGES = [
  "compile",
  "admission",
  "turn",
  "tool",
  "handoff",
  "output",
  "recording",
  "retention",
  "termination",
] as const;

export type PolicyStage = (typeof POLICY_STAGES)[number];
export type MaybePromise<T> = T | Promise<T>;

export type PolicyDecision<T = unknown> =
  | { kind: "allow"; reason?: string }
  | { kind: "deny"; reason: string; code?: string }
  | { kind: "require-approval"; reason: string; approvalId?: string }
  | { kind: "redact"; paths: readonly string[]; replacement?: string; reason?: string }
  | { kind: "transform"; value: T; reason?: string };

export interface PolicyContext {
  sessionId: string;
  actorId?: string;
  now: number;
  startedAt?: number;
  elapsedMs?: number;
  consent?: Readonly<Record<string, boolean>>;
  metadata?: Readonly<Record<string, unknown>>;
}

export interface PolicyEvaluationInput<T = unknown> {
  stage: PolicyStage;
  value: T;
  context: PolicyContext;
  signal: AbortSignal;
}

export interface Policy<T = unknown> {
  id: string;
  description?: string;
  stages?: readonly PolicyStage[];
  deadlineMs?: number;
  evaluate(input: PolicyEvaluationInput<T>): MaybePromise<PolicyDecision<T>>;
}

export interface AuditRecord {
  id: string;
  timestamp: number;
  sessionId: string;
  stage: PolicyStage;
  policyId: string;
  decision: PolicyDecision["kind"];
  reason?: string;
  durationMs: number;
  approvalToken?: string;
  error?: string;
}

export type AuditSink = (record: AuditRecord) => MaybePromise<void>;

export type PolicyEvaluation<T> =
  | { kind: "allow"; value: T; audit: readonly AuditRecord[] }
  | { kind: "deny"; reason: string; code?: string; value: T; audit: readonly AuditRecord[] }
  | {
      kind: "require-approval";
      reason: string;
      approvalToken: string;
      approvalId?: string;
      value: T;
      audit: readonly AuditRecord[];
    };

export interface PolicyEngineOptions {
  deadlineMs?: number;
  failClosed?: boolean;
  audit?: AuditSink;
  now?: () => number;
}

interface PendingApproval {
  stage: PolicyStage;
  value: unknown;
  context: PolicyContext;
  nextPolicyIndex: number;
  audit: AuditRecord[];
  approvalId?: string;
}

function decisionReason(decision: PolicyDecision): string | undefined {
  return "reason" in decision ? decision.reason : undefined;
}

function randomId(): string {
  return globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function redact(value: unknown, paths: readonly string[], replacement = "[REDACTED]"): unknown {
  const clone = structuredClone(value);
  for (const path of paths) {
    const parts = path.split(".").filter(Boolean);
    if (!parts.length) continue;
    let cursor: unknown = clone;
    for (let index = 0; index < parts.length - 1; index += 1) {
      if (cursor === null || typeof cursor !== "object") break;
      cursor = (cursor as Record<string, unknown>)[parts[index]!];
    }
    if (cursor !== null && typeof cursor === "object") {
      const key = parts.at(-1)!;
      if (Object.prototype.hasOwnProperty.call(cursor, key)) {
        (cursor as Record<string, unknown>)[key] = replacement;
      }
    }
  }
  return clone;
}

export class PolicyEngine {
  readonly #policies: readonly Policy[];
  readonly #options: Required<Pick<PolicyEngineOptions, "deadlineMs" | "failClosed" | "now">> &
    Pick<PolicyEngineOptions, "audit">;
  readonly #pending = new Map<string, PendingApproval>();

  constructor(policies: readonly Policy[], options: PolicyEngineOptions = {}) {
    const ids = new Set<string>();
    for (const policy of policies) {
      if (!policy.id.trim()) throw new TypeError("Policy id must not be empty");
      if (ids.has(policy.id)) throw new TypeError(`Duplicate policy id "${policy.id}"`);
      if (policy.deadlineMs !== undefined && policy.deadlineMs <= 0) {
        throw new RangeError(`Policy "${policy.id}" deadline must be positive`);
      }
      ids.add(policy.id);
    }
    this.#policies = Object.freeze([...policies]);
    this.#options = {
      deadlineMs: options.deadlineMs ?? 100,
      failClosed: options.failClosed ?? true,
      now: options.now ?? Date.now,
      ...(options.audit === undefined ? {} : { audit: options.audit }),
    };
  }

  evaluate<T>(stage: PolicyStage, value: T, context: PolicyContext): Promise<PolicyEvaluation<T>> {
    return this.#run(stage, value, context, 0, []);
  }

  compile<T>(value: T, context: PolicyContext) { return this.evaluate("compile", value, context); }
  admission<T>(value: T, context: PolicyContext) { return this.evaluate("admission", value, context); }
  turn<T>(value: T, context: PolicyContext) { return this.evaluate("turn", value, context); }
  tool<T>(value: T, context: PolicyContext) { return this.evaluate("tool", value, context); }
  handoff<T>(value: T, context: PolicyContext) { return this.evaluate("handoff", value, context); }
  output<T>(value: T, context: PolicyContext) { return this.evaluate("output", value, context); }
  recording<T>(value: T, context: PolicyContext) { return this.evaluate("recording", value, context); }
  retention<T>(value: T, context: PolicyContext) { return this.evaluate("retention", value, context); }
  termination<T>(value: T, context: PolicyContext) { return this.evaluate("termination", value, context); }

  async resume<T>(
    approvalToken: string,
    approved: boolean,
  ): Promise<PolicyEvaluation<T>> {
    const pending = this.#pending.get(approvalToken);
    if (!pending) throw new TypeError("Unknown or expired approval token");
    this.#pending.delete(approvalToken);
    if (!approved) {
      return {
        kind: "deny",
        reason: "Approval was rejected",
        code: "approval_rejected",
        value: pending.value as T,
        audit: pending.audit,
      };
    }
    return this.#run(
      pending.stage,
      pending.value as T,
      pending.context,
      pending.nextPolicyIndex,
      pending.audit,
    );
  }

  cancelApproval(approvalToken: string): boolean {
    return this.#pending.delete(approvalToken);
  }

  async #run<T>(
    stage: PolicyStage,
    initialValue: T,
    context: PolicyContext,
    startIndex: number,
    priorAudit: AuditRecord[],
  ): Promise<PolicyEvaluation<T>> {
    let value = initialValue;
    const audit = [...priorAudit];
    for (let index = startIndex; index < this.#policies.length; index += 1) {
      const policy = this.#policies[index]!;
      if (policy.stages && !policy.stages.includes(stage)) continue;
      const started = this.#options.now();
      let decision: PolicyDecision<T>;
      let errorMessage: string | undefined;
      try {
        decision = await this.#withDeadline(policy, { stage, value, context });
      } catch (error) {
        errorMessage = error instanceof Error ? error.message : String(error);
        decision = this.#options.failClosed
          ? { kind: "deny", reason: `Policy "${policy.id}" failed: ${errorMessage}`, code: "policy_failure" }
          : { kind: "allow", reason: `Policy "${policy.id}" failed open` };
      }

      const reason = decisionReason(decision);
      const record: AuditRecord = {
        id: randomId(),
        timestamp: started,
        sessionId: context.sessionId,
        stage,
        policyId: policy.id,
        decision: decision.kind,
        durationMs: Math.max(0, this.#options.now() - started),
        ...(reason === undefined ? {} : { reason }),
        ...(errorMessage === undefined ? {} : { error: errorMessage }),
      };

      if (decision.kind === "transform") value = decision.value;
      if (decision.kind === "redact") {
        value = redact(value, decision.paths, decision.replacement) as T;
      }
      if (decision.kind === "require-approval") {
        const approvalToken = randomId();
        record.approvalToken = approvalToken;
        audit.push(record);
        await this.#options.audit?.(record);
        this.#pending.set(approvalToken, {
          stage,
          value,
          context,
          nextPolicyIndex: index + 1,
          audit,
          ...(decision.approvalId === undefined ? {} : { approvalId: decision.approvalId }),
        });
        return {
          kind: "require-approval",
          reason: decision.reason,
          approvalToken,
          ...(decision.approvalId === undefined ? {} : { approvalId: decision.approvalId }),
          value,
          audit,
        };
      }

      audit.push(record);
      await this.#options.audit?.(record);
      if (decision.kind === "deny") {
        return {
          kind: "deny",
          reason: decision.reason,
          ...(decision.code === undefined ? {} : { code: decision.code }),
          value,
          audit,
        };
      }
    }
    return { kind: "allow", value, audit };
  }

  async #withDeadline<T>(
    policy: Policy,
    input: Omit<PolicyEvaluationInput<T>, "signal">,
  ): Promise<PolicyDecision<T>> {
    const controller = new AbortController();
    const deadline = policy.deadlineMs ?? this.#options.deadlineMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        policy.evaluate({ ...input, signal: controller.signal }) as Promise<PolicyDecision<T>>,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            const error = new Error(`Policy deadline exceeded after ${deadline}ms`);
            controller.abort(error);
            reject(error);
          }, deadline);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

export function composePolicies(id: string, policies: readonly Policy[]): Policy {
  return {
    id,
    async evaluate(input) {
      let value = input.value;
      for (const policy of policies) {
        if (policy.stages && !policy.stages.includes(input.stage)) continue;
        const decision = await policy.evaluate({ ...input, value });
        if (decision.kind === "transform") value = decision.value;
        else if (decision.kind === "redact") {
          value = redact(value, decision.paths, decision.replacement);
        } else if (decision.kind !== "allow") return decision;
      }
      return Object.is(value, input.value)
        ? { kind: "allow" }
        : { kind: "transform", value };
    },
  };
}

export function consentPolicy(options: {
  id?: string;
  consentKey?: string;
  stages?: readonly PolicyStage[];
  reason?: string;
} = {}): Policy {
  const key = options.consentKey ?? "voice";
  return {
    id: options.id ?? `consent:${key}`,
    stages: options.stages ?? ["admission", "recording"],
    evaluate: ({ context }) =>
      context.consent?.[key]
        ? { kind: "allow" }
        : { kind: "deny", reason: options.reason ?? `Consent "${key}" is required`, code: "consent_required" },
  };
}

export function toolAllowlistPolicy(
  allowedTools: Iterable<string>,
  options: { id?: string; requireApprovalForWrites?: boolean } = {},
): Policy {
  const allowed = new Set(allowedTools);
  return {
    id: options.id ?? "tool-allowlist",
    stages: ["tool"],
    evaluate: ({ value }) => {
      const call = value as { toolName?: string; tool?: { name?: string; effect?: string }; effect?: string };
      const name = call.toolName ?? call.tool?.name;
      if (!name || !allowed.has(name)) {
        return { kind: "deny", reason: `Tool "${name ?? "unknown"}" is not allowed`, code: "tool_not_allowed" };
      }
      if (options.requireApprovalForWrites && (call.effect ?? call.tool?.effect) === "write") {
        return { kind: "require-approval", reason: `Write tool "${name}" requires approval` };
      }
      return { kind: "allow" };
    },
  };
}

export function maxDurationPolicy(
  maxDurationMs: number,
  options: { id?: string; stages?: readonly PolicyStage[] } = {},
): Policy {
  if (maxDurationMs <= 0) throw new RangeError("maxDurationMs must be positive");
  return {
    id: options.id ?? "max-duration",
    stages: options.stages ?? ["admission", "turn", "tool", "handoff", "output"],
    evaluate: ({ context }) => {
      const elapsed = context.elapsedMs ??
        (context.startedAt === undefined ? 0 : context.now - context.startedAt);
      return elapsed < maxDurationMs
        ? { kind: "allow" }
        : { kind: "deny", reason: `Session exceeded ${maxDurationMs}ms`, code: "max_duration" };
    },
  };
}

export function retentionPolicy(
  maxRetentionMs: number,
  options: { id?: string; field?: string } = {},
): Policy {
  if (maxRetentionMs < 0) throw new RangeError("maxRetentionMs must not be negative");
  const field = options.field ?? "retentionMs";
  return {
    id: options.id ?? "retention-limit",
    stages: ["retention"],
    evaluate: ({ value }) => {
      if (value === null || typeof value !== "object") {
        return { kind: "deny", reason: "Retention request must be an object", code: "invalid_retention" };
      }
      const request = value as Record<string, unknown>;
      const requested = request[field];
      if (typeof requested !== "number" || !Number.isFinite(requested) || requested < 0) {
        return { kind: "deny", reason: `Invalid ${field}`, code: "invalid_retention" };
      }
      return requested <= maxRetentionMs
        ? { kind: "allow" }
        : {
            kind: "transform",
            value: { ...request, [field]: maxRetentionMs },
            reason: `Retention capped at ${maxRetentionMs}ms`,
          };
    },
  };
}
