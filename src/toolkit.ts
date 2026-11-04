/**
 * Provider-agnostic tool catalog + toolkit.
 *
 * Tools are declared once as `{ name, parameters (zod), description }` and turned
 * into provider tool objects through a `ToolkitBinding`:
 *   - `toolDefinitionBinding` → VoiceKit `ToolDefinition` (any client adapter)
 *   - `livekitToolBinding`    → `llm.tool` (from `@jchaffin/voicekit/livekit-agents`)
 *
 * ```ts
 * const catalog = createCatalog(
 *   defineCatalogTool('lookup_order', z.object({ id: z.string() }), 'Look up an order'),
 *   defineCatalogTool('end_call', z.object({}), 'End the call'),
 * );
 * const kit = createToolkit({ catalog, invoke: (key, input) => api[key](input), binding });
 * const tools = { lookup_order: kit.register('lookup_order', kit.plain), end_call: kit.register('end_call', kit.terminal) };
 * ```
 */

import type { z } from 'zod';
import type { ToolDefinition } from './types';

export type ToolExecutor<Input, Ctx = unknown> = (
  input: Input,
  opts: { ctx: Ctx },
) => Promise<unknown>;

export type ToolCatalog = Record<string, { description: string; parameters: z.ZodType }>;

export type CatalogTool<
  Name extends string = string,
  S extends z.ZodType = z.ZodType,
  D extends string | ((...args: never[]) => string) = string | ((...args: never[]) => string),
> = { name: Name; parameters: S; description: D };

/** Defines one named tool; `description` may be a function of domain values, resolved before `createToolkit`. */
export function defineCatalogTool<
  Name extends string,
  S extends z.ZodType,
  D extends string | ((...args: never[]) => string),
>(name: Name, parameters: S, description: D): CatalogTool<Name, S, D> {
  return { name, parameters, description };
}

/** Collects tool definitions into one catalog object keyed by tool name. */
export function createCatalog<T extends readonly CatalogTool[]>(
  ...tools: T
): { [D in T[number] as D['name']]: D } {
  return Object.fromEntries(tools.map((t) => [t.name, t])) as {
    [D in T[number] as D['name']]: D;
  };
}

/** Adapts catalog tools to a specific provider's tool object and run context. */
export interface ToolkitBinding<Ctx, Tool> {
  createTool(
    def: { name: string; description: string; parameters: z.ZodType },
    execute: ToolExecutor<any, Ctx>,
  ): Tool;
  /** Make the agent's current speech uninterruptible; used by `terminal` tools. */
  lockSpeech?(ctx: Ctx): void;
}

export type ToolkitOptions<Catalog extends ToolCatalog, Ctx, Tool> = {
  /** Description and parameter schema per tool key. */
  catalog: Catalog;
  /** Invokes the domain action behind a tool key. */
  invoke: <K extends keyof Catalog>(key: K, input: z.infer<Catalog[K]['parameters']>) => Promise<unknown>;
  binding: ToolkitBinding<Ctx, Tool>;
  /** Returns true when a tool result terminated the call; the result is then withheld from the model. */
  intercept?: (result: unknown, ctx: Ctx) => Promise<boolean> | boolean;
  /** Wraps every invocation. Default: `runToolSafely`. */
  run?: (action: () => Promise<unknown>) => Promise<unknown>;
};

/** Default tool runner: thrown errors become `{ success: false, error }` so the model can recover. */
export async function runToolSafely(action: () => Promise<unknown>): Promise<unknown> {
  try {
    return await action();
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Composable tool builders over a keyed schema/description catalog:
 * - `plain(key)`: run the action, surface the result.
 * - `endable(key)`: run, then let the interceptor end the call on terminal results.
 * - `terminal(key)`: endable, with agent speech made uninterruptible first.
 * - `register(key, executor)`: build the provider tool from the catalog entry.
 */
export function createToolkit<Catalog extends ToolCatalog, Ctx, Tool>(
  options: ToolkitOptions<Catalog, Ctx, Tool>,
) {
  const { catalog, invoke, intercept, binding, run: runner = runToolSafely } = options;

  type Key = keyof Catalog & string;
  type Input<K extends Key> = z.infer<Catalog[K]['parameters']>;

  /** Validates against the catalog schema before invoking; malformed input fails through the runner. */
  const run = <K extends Key>(key: K, input: Input<K>) =>
    runner(async () => {
      const result = catalog[key].parameters.safeParse(input);
      if (!result.success) {
        const issues = result.error.issues
          .map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`)
          .join('; ');
        throw new Error(`Invalid input for ${key}: ${issues}`);
      }
      return invoke(key, result.data as Input<K>);
    });

  const plain = <K extends Key>(key: K): ToolExecutor<Input<K>, Ctx> =>
    async (input) => run(key, input);

  const endable = <K extends Key>(key: K): ToolExecutor<Input<K>, Ctx> =>
    async (input, { ctx }) => {
      const result = await run(key, input);
      if (intercept && (await intercept(result, ctx))) return;
      return result;
    };

  const terminal = <K extends Key>(key: K): ToolExecutor<Input<K>, Ctx> =>
    async (input, { ctx }) => {
      binding.lockSpeech?.(ctx);
      return endable(key)(input, { ctx });
    };

  const register = <K extends Key>(key: K, executor: (key: K) => ToolExecutor<Input<K>, Ctx>): Tool => {
    const def = catalog[key];
    return binding.createTool(
      { name: key, description: def.description, parameters: def.parameters },
      executor(key),
    );
  };

  return { plain, endable, terminal, register };
}

// ============================================================================
// Built-in binding: VoiceKit ToolDefinition (works with every client adapter)
// ============================================================================

/**
 * Produces VoiceKit `ToolDefinition`s, so catalog tools can be passed to
 * `createAgent({ tools })` for any adapter. Requires zod >= 4 (`z.toJSONSchema`).
 * Client adapters have no run context, so `ctx` is `undefined`.
 */
export function toolDefinitionBinding(zod: { toJSONSchema: (schema: z.ZodType) => unknown }): ToolkitBinding<undefined, ToolDefinition> {
  return {
    createTool(def, execute) {
      const schema = zod.toJSONSchema(def.parameters) as {
        properties?: ToolDefinition['parameters']['properties'];
        required?: string[];
      };
      return {
        name: def.name,
        description: def.description,
        parameters: {
          type: 'object',
          properties: schema.properties ?? {},
          required: schema.required ?? [],
        },
        execute: (params) => execute(def.parameters.parse(params), { ctx: undefined }),
      };
    },
  };
}
