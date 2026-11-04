export type MaybePromise<T> = T | Promise<T>;

export interface AgentInitContext<TContext> {
  context: TContext;
  handoffId?: string;
  signal: AbortSignal;
}

export interface AgentDefinition<
  TId extends string = string,
  TContext extends Record<string, unknown> = Record<string, unknown>,
> {
  id: TId;
  description?: string;
  initialContext?: TContext | (() => MaybePromise<TContext>);
  initialize?: (input: AgentInitContext<TContext>) => MaybePromise<void>;
}

export function defineAgent<
  const TId extends string,
  TContext extends Record<string, unknown> = Record<string, unknown>,
>(definition: AgentDefinition<TId, TContext>): AgentDefinition<TId, TContext> {
  if (!definition.id.trim()) throw new TypeError("Agent id must not be empty");
  return Object.freeze({ ...definition });
}

export type HandoffMode = "replace" | "delegate" | "consult";

export interface HandoffLifecycle<TSourceContext, TTargetContext> {
  beforeFreeze?: (source: TSourceContext) => MaybePromise<void>;
  afterDrain?: (source: TSourceContext) => MaybePromise<void>;
  afterTargetInit?: (target: TTargetContext) => MaybePromise<void>;
  onCommit?: (target: TTargetContext) => MaybePromise<void>;
  onRollback?: (error: unknown) => MaybePromise<void>;
}

export interface HandoffDefinition<
  TFrom extends string = string,
  TTo extends string = string,
  TSourceContext = unknown,
  TTargetContext = unknown,
> {
  id: string;
  mode: HandoffMode;
  from: TFrom;
  to: TTo;
  projectContext: (source: TSourceContext) => MaybePromise<TTargetContext>;
  drainTimeoutMs?: number;
  lifecycle?: HandoffLifecycle<TSourceContext, TTargetContext>;
}

type HandoffInput<F extends string, T extends string, S, U> = Omit<
  HandoffDefinition<F, T, S, U>,
  "mode"
>;

function handoff<M extends HandoffMode, F extends string, T extends string, S, U>(
  mode: M,
  definition: HandoffInput<F, T, S, U>,
): HandoffDefinition<F, T, S, U> & { mode: M } {
  if (!definition.id.trim()) throw new TypeError("Handoff id must not be empty");
  if ((definition.from as string) === (definition.to as string)) {
    throw new TypeError(`Handoff "${definition.id}" must target another agent`);
  }
  if (definition.drainTimeoutMs !== undefined && definition.drainTimeoutMs <= 0) {
    throw new RangeError("drainTimeoutMs must be positive");
  }
  return Object.freeze({ ...definition, mode });
}

export const replace = <F extends string, T extends string, S, U>(
  definition: HandoffInput<F, T, S, U>,
) => handoff("replace", definition);

export const delegate = <F extends string, T extends string, S, U>(
  definition: HandoffInput<F, T, S, U>,
) => handoff("delegate", definition);

export const consult = <F extends string, T extends string, S, U>(
  definition: HandoffInput<F, T, S, U>,
) => handoff("consult", definition);

// `any` is intentional in these constraints: concrete context types remain
// preserved by the const generics instead of being rejected by function
// parameter variance.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyAgent = AgentDefinition<string, any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyHandoff = HandoffDefinition<string, string, any, any>;

export interface AgentGraph<
  TAgents extends readonly AnyAgent[] = readonly AnyAgent[],
  THandoffs extends readonly AnyHandoff[] = readonly AnyHandoff[],
> {
  entry: TAgents[number]["id"];
  agents: TAgents;
  handoffs: THandoffs;
  agentById: ReadonlyMap<TAgents[number]["id"], TAgents[number]>;
  handoffById: ReadonlyMap<string, THandoffs[number]>;
}

export function defineAgentGraph<
  const TAgents extends readonly AnyAgent[],
  const THandoffs extends readonly AnyHandoff[],
>(input: {
  entry: TAgents[number]["id"];
  agents: TAgents;
  handoffs?: THandoffs;
}): AgentGraph<TAgents, THandoffs> {
  if (input.agents.length === 0) throw new TypeError("Agent graph must contain an agent");
  const agents = new Map<string, AnyAgent>();
  for (const agent of input.agents) {
    if (agents.has(agent.id)) throw new TypeError(`Duplicate agent id "${agent.id}"`);
    agents.set(agent.id, agent);
  }
  if (!agents.has(input.entry)) throw new TypeError(`Unknown entry agent "${input.entry}"`);

  const handoffs = (input.handoffs ?? []) as readonly AnyHandoff[];
  const byId = new Map<string, AnyHandoff>();
  for (const edge of handoffs) {
    if (byId.has(edge.id)) throw new TypeError(`Duplicate handoff id "${edge.id}"`);
    if (!agents.has(edge.from)) throw new TypeError(`Unknown source agent "${edge.from}"`);
    if (!agents.has(edge.to)) throw new TypeError(`Unknown target agent "${edge.to}"`);
    byId.set(edge.id, edge);
  }

  return Object.freeze({
    entry: input.entry,
    agents: Object.freeze([...input.agents]) as unknown as TAgents,
    handoffs: Object.freeze([...handoffs]) as unknown as THandoffs,
    agentById: agents as ReadonlyMap<TAgents[number]["id"], TAgents[number]>,
    handoffById: byId as ReadonlyMap<string, THandoffs[number]>,
  });
}

export interface HandoffRuntime<TSourceContext, TTargetContext> {
  freeze(sourceAgentId: string): MaybePromise<void>;
  drain(sourceAgentId: string, signal: AbortSignal): MaybePromise<void>;
  initializeTarget(
    targetAgentId: string,
    context: TTargetContext,
    signal: AbortSignal,
  ): MaybePromise<void>;
  commit(input: {
    handoffId: string;
    mode: HandoffMode;
    sourceAgentId: string;
    targetAgentId: string;
    context: TTargetContext;
  }): MaybePromise<void>;
  rollback(input: {
    handoffId: string;
    sourceAgentId: string;
    targetAgentId: string;
    error: unknown;
  }): MaybePromise<void>;
  unfreeze(sourceAgentId: string): MaybePromise<void>;
}

export interface HandoffResult<TContext> {
  handoffId: string;
  mode: HandoffMode;
  targetAgentId: string;
  context: TContext;
  committed: true;
}

export class HandoffCoordinator {
  readonly #defaultDrainTimeoutMs: number;
  #tail: Promise<void> = Promise.resolve();

  constructor(options: { defaultDrainTimeoutMs?: number } = {}) {
    this.#defaultDrainTimeoutMs = options.defaultDrainTimeoutMs ?? 5_000;
    if (this.#defaultDrainTimeoutMs <= 0) {
      throw new RangeError("defaultDrainTimeoutMs must be positive");
    }
  }

  execute<S, T>(
    definition: HandoffDefinition<string, string, S, T>,
    sourceContext: S,
    runtime: HandoffRuntime<S, T>,
  ): Promise<HandoffResult<T>> {
    const operation = this.#tail.then(() =>
      this.#executeAtomic(definition, sourceContext, runtime),
    );
    this.#tail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async #executeAtomic<S, T>(
    definition: HandoffDefinition<string, string, S, T>,
    sourceContext: S,
    runtime: HandoffRuntime<S, T>,
  ): Promise<HandoffResult<T>> {
    let frozen = false;
    let targetContext: T | undefined;
    const controller = new AbortController();
    const drainTimeoutMs = definition.drainTimeoutMs ?? this.#defaultDrainTimeoutMs;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const drainDeadline = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        const error = new Error(`Handoff drain timed out after ${drainTimeoutMs}ms`);
        controller.abort(error);
        reject(error);
      }, drainTimeoutMs);
    });

    try {
      await definition.lifecycle?.beforeFreeze?.(sourceContext);
      await runtime.freeze(definition.from);
      frozen = true;
      await Promise.race([
        runtime.drain(definition.from, controller.signal),
        drainDeadline,
      ]);
      if (timeout) clearTimeout(timeout);
      await definition.lifecycle?.afterDrain?.(sourceContext);
      targetContext = await definition.projectContext(sourceContext);
      await runtime.initializeTarget(definition.to, targetContext, controller.signal);
      await definition.lifecycle?.afterTargetInit?.(targetContext);
      await runtime.commit({
        handoffId: definition.id,
        mode: definition.mode,
        sourceAgentId: definition.from,
        targetAgentId: definition.to,
        context: targetContext,
      });
      await definition.lifecycle?.onCommit?.(targetContext);
      if (definition.mode !== "replace") {
        await runtime.unfreeze(definition.from);
        frozen = false;
      }
      return {
        handoffId: definition.id,
        mode: definition.mode,
        targetAgentId: definition.to,
        context: targetContext,
        committed: true,
      };
    } catch (error) {
      if (timeout) clearTimeout(timeout);
      controller.abort(error);
      try {
        await runtime.rollback({
          handoffId: definition.id,
          sourceAgentId: definition.from,
          targetAgentId: definition.to,
          error,
        });
        await definition.lifecycle?.onRollback?.(error);
      } finally {
        if (frozen) await runtime.unfreeze(definition.from);
      }
      throw error;
    }
  }
}
