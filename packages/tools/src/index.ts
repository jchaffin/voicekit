import type { ZodType, output as ZodOutput } from "zod";

export type ToolEffect = "read" | "write";
export type ToolExecutionLocation = "server" | "client";
export type MaybePromise<T> = T | Promise<T>;

export interface ToolProgress {
  message: string;
  speak: boolean;
  percent?: number;
}

export interface ToolExecutionContext {
  callId: string;
  sessionId: string;
  scopes: ReadonlySet<string>;
  signal: AbortSignal;
  idempotencyKey?: string;
  reportProgress(progress: ToolProgress): MaybePromise<void>;
  metadata: Readonly<Record<string, unknown>>;
}

export interface ToolDefinition<
  TName extends string = string,
  TInputSchema extends ZodType = ZodType,
  TOutputSchema extends ZodType = ZodType,
> {
  name: TName;
  description: string;
  input: TInputSchema;
  output: TOutputSchema;
  execution: ToolExecutionLocation;
  effect: ToolEffect;
  scopes?: readonly string[];
  timeoutMs?: number;
  idempotent?: boolean;
  progressSpeech?: string | ((input: ZodOutput<TInputSchema>) => string | undefined);
  execute?: (
    input: ZodOutput<TInputSchema>,
    context: ToolExecutionContext,
  ) => MaybePromise<ZodOutput<TOutputSchema>>;
}

export function defineTool<
  const TName extends string,
  TInputSchema extends ZodType,
  TOutputSchema extends ZodType,
>(
  definition: ToolDefinition<TName, TInputSchema, TOutputSchema>,
): Readonly<ToolDefinition<TName, TInputSchema, TOutputSchema>> {
  if (!definition.name.trim()) throw new TypeError("Tool name must not be empty");
  if (!definition.description.trim()) throw new TypeError("Tool description must not be empty");
  if (definition.execution === "server" && !definition.execute) {
    throw new TypeError(`Server tool "${definition.name}" requires an execute handler`);
  }
  if (definition.timeoutMs !== undefined && definition.timeoutMs <= 0) {
    throw new RangeError("timeoutMs must be positive");
  }
  return Object.freeze({
    ...definition,
    ...(definition.scopes
      ? { scopes: Object.freeze([...definition.scopes]) }
      : {}),
  });
}

export interface ToolPolicyInput {
  tool: Readonly<ToolDefinition>;
  input: unknown;
  context: Omit<ToolExecutionContext, "signal" | "reportProgress">;
}

export type ToolPolicyDecision =
  | { kind: "allow" }
  | { kind: "deny"; reason: string }
  | { kind: "require-approval"; reason: string; approvalId?: string };

export interface ToolPolicyHook {
  (input: ToolPolicyInput): MaybePromise<ToolPolicyDecision>;
}

export interface ToolApprovalRequest {
  toolName: string;
  effect: ToolEffect;
  input: unknown;
  reason: string;
  approvalId?: string;
  context: ToolPolicyInput["context"];
}

export interface ToolExecutorOptions {
  policy?: ToolPolicyHook;
  approve?: (request: ToolApprovalRequest) => MaybePromise<boolean>;
  clientExecutor?: (
    tool: Readonly<ToolDefinition>,
    input: unknown,
    context: ToolExecutionContext,
  ) => MaybePromise<unknown>;
  onProgress?: (progress: ToolProgress & { toolName: string; callId: string }) => MaybePromise<void>;
  defaultTimeoutMs?: number;
  dedupeTtlMs?: number;
}

export interface ExecuteToolOptions {
  callId: string;
  sessionId: string;
  scopes?: Iterable<string>;
  signal?: AbortSignal;
  idempotencyKey?: string;
  metadata?: Readonly<Record<string, unknown>>;
}

interface DedupeEntry {
  expiresAt: number;
  value: Promise<unknown>;
}

export class ToolDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolDeniedError";
  }
}

export class ToolApprovalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolApprovalError";
  }
}

export class ToolExecutor {
  readonly #options: Required<Pick<ToolExecutorOptions, "defaultTimeoutMs" | "dedupeTtlMs">> &
    Omit<ToolExecutorOptions, "defaultTimeoutMs" | "dedupeTtlMs">;
  readonly #dedupe = new Map<string, DedupeEntry>();

  constructor(options: ToolExecutorOptions = {}) {
    this.#options = {
      ...options,
      defaultTimeoutMs: options.defaultTimeoutMs ?? 15_000,
      dedupeTtlMs: options.dedupeTtlMs ?? 5 * 60_000,
    };
    if (this.#options.defaultTimeoutMs <= 0 || this.#options.dedupeTtlMs <= 0) {
      throw new RangeError("Tool executor timeouts must be positive");
    }
  }

  execute<I extends ZodType, O extends ZodType>(
    tool: Readonly<ToolDefinition<string, I, O>>,
    rawInput: unknown,
    options: ExecuteToolOptions,
  ): Promise<ZodOutput<O>> {
    this.#prune();
    const key =
      tool.idempotent && options.idempotencyKey
        ? `${tool.name}:${options.sessionId}:${options.idempotencyKey}`
        : undefined;
    if (key) {
      const existing = this.#dedupe.get(key);
      if (existing) return existing.value as Promise<ZodOutput<O>>;
    }

    const execution = this.#execute(tool, rawInput, options);
    if (key) {
      this.#dedupe.set(key, {
        expiresAt: Date.now() + this.#options.dedupeTtlMs,
        value: execution,
      });
      execution.catch(() => this.#dedupe.delete(key));
    }
    return execution;
  }

  clearDedupe(): void {
    this.#dedupe.clear();
  }

  async #execute<I extends ZodType, O extends ZodType>(
    tool: Readonly<ToolDefinition<string, I, O>>,
    rawInput: unknown,
    options: ExecuteToolOptions,
  ): Promise<ZodOutput<O>> {
    const input = await tool.input.parseAsync(rawInput);
    const scopes = new Set(options.scopes ?? []);
    const missing = (tool.scopes ?? []).filter((scope) => !scopes.has(scope));
    if (missing.length) throw new ToolDeniedError(`Missing required scopes: ${missing.join(", ")}`);

    const policyContext: ToolPolicyInput["context"] = {
      callId: options.callId,
      sessionId: options.sessionId,
      scopes,
      ...(options.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey }),
      metadata: options.metadata ?? {},
    };
    const decision = (await this.#options.policy?.({ tool, input, context: policyContext })) ?? {
      kind: "allow" as const,
    };
    if (decision.kind === "deny") throw new ToolDeniedError(decision.reason);
    if (decision.kind === "require-approval") {
      if (!this.#options.approve) throw new ToolApprovalError("Approval is required but unavailable");
      const approved = await this.#options.approve({
        toolName: tool.name,
        effect: tool.effect,
        input,
        reason: decision.reason,
        ...(decision.approvalId === undefined ? {} : { approvalId: decision.approvalId }),
        context: policyContext,
      });
      if (!approved) throw new ToolApprovalError("Tool execution was not approved");
    }

    const controller = new AbortController();
    const abort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", abort, { once: true });
    const timeoutMs = tool.timeoutMs ?? this.#options.defaultTimeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error(`Tool "${tool.name}" timed out after ${timeoutMs}ms`);
        controller.abort(error);
        reject(error);
      }, timeoutMs);
    });
    const reportProgress = async (progress: ToolProgress): Promise<void> => {
      await this.#options.onProgress?.({ ...progress, toolName: tool.name, callId: options.callId });
    };
    const context: ToolExecutionContext = {
      ...policyContext,
      signal: controller.signal,
      reportProgress,
    };

    try {
      const speech =
        typeof tool.progressSpeech === "function"
          ? tool.progressSpeech(input)
          : tool.progressSpeech;
      if (speech) await reportProgress({ message: speech, speak: true });
      if (controller.signal.aborted) throw controller.signal.reason;
      const handler =
        tool.execution === "client"
          ? this.#options.clientExecutor
          : tool.execute;
      if (!handler) throw new TypeError(`No ${tool.execution} executor for tool "${tool.name}"`);
      const execution =
        tool.execution === "client"
          ? this.#options.clientExecutor!(tool, input, context)
          : tool.execute!(input, context);
      const output = await Promise.race([execution, deadline]);
      if (controller.signal.aborted) throw controller.signal.reason;
      return await tool.output.parseAsync(output);
    } finally {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    }
  }

  #prune(): void {
    const now = Date.now();
    for (const [key, entry] of this.#dedupe) {
      if (entry.expiresAt <= now) this.#dedupe.delete(key);
    }
  }
}
