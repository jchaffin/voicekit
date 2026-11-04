/**
 * LiveKit Agents (server-side, Node) layer for VoiceKit.
 *
 * Peer dependency: @livekit/agents (>= 1.9.0)
 *
 * ```ts
 * import { createLiveKitToolkit, EndCallRecorder, VoiceAgent } from '@jchaffin/voicekit/livekit-agents';
 *
 * const endCall = new EndCallRecorder({ terminalReason, end, isEnding, closingInstruction });
 * const kit = createLiveKitToolkit({ catalog, invoke, intercept: (r, ctx) => endCall.intercept(r, ctx) });
 * const agent = new VoiceAgent({
 *   instructions,
 *   greeting,
 *   tools: new llm.ToolContext({
 *     lookup_order: kit.register('lookup_order', kit.plain),
 *     end_call: kit.register('end_call', kit.terminal),
 *   }),
 * });
 * ```
 */

import { llm, voice } from '@livekit/agents';
import { createToolkit, type ToolCatalog, type ToolkitBinding, type ToolkitOptions } from '../toolkit';

/** An anonymous `llm.tool`; the key it is registered under in the tool map becomes its name. */
export type LiveKitTool = llm.AnonFunctionTool<any, any, any>;

/** Make the agent's current speech uninterruptible. */
function lockSpeech(ctx: voice.RunContext): void {
  ctx.disallowInterruptions();
}

/** Wraps tool failures in `llm.ToolError` so the LLM receives a clean message. */
export async function runAgentTool<T>(fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw new llm.ToolError(error instanceof Error ? error.message : 'Tool execution failed.');
  }
}

export const livekitToolBinding: ToolkitBinding<voice.RunContext, LiveKitTool> = {
  createTool(def, execute) {
    return llm.tool({
      description: def.description,
      parameters: def.parameters,
      execute: (input: unknown, { ctx }: { ctx: voice.RunContext }) => execute(input, { ctx }),
    });
  },
  lockSpeech,
};

/** Toolkit bound to `llm.tool`; failures surface to the model as `llm.ToolError` by default. */
export function createLiveKitToolkit<Catalog extends ToolCatalog>(
  options: Omit<ToolkitOptions<Catalog, voice.RunContext, LiveKitTool>, 'binding'>,
) {
  return createToolkit({ run: runAgentTool, ...options, binding: livekitToolBinding });
}

// ============================================================================
// Agent
// ============================================================================

export type VoiceAgentOptions = {
  /** Fully-resolved system prompt. */
  instructions: string;
  /** Exact opening line to speak when the agent enters the session. */
  greeting: string;
  /** Tools for the agent: an `llm.ToolContext`, or a map of tool name to `kit.register(...)` result. */
  tools: llm.ToolContextLike;
  /** Invoked once when the agent enters the session, before the greeting is spoken. */
  onEnter?: () => void;
};

/** Generic greeting-first voice agent; all domain behavior arrives through tools. */
export class VoiceAgent extends voice.Agent {
  private readonly greeting: string;
  private readonly enterHook?: () => void;

  constructor(options: VoiceAgentOptions) {
    super({ instructions: options.instructions, tools: options.tools });
    this.greeting = options.greeting;
    this.enterHook = options.onEnter;
  }

  override async onEnter(): Promise<void> {
    this.enterHook?.();
    this.session.say(this.greeting);
  }
}

// ============================================================================
// End of call
// ============================================================================

export type EndCallRecorderOptions<Reason extends string> = {
  /** Extracts a terminal reason from a tool result, when present. */
  terminalReason: (result: unknown) => Reason | undefined;
  /** Runs the domain end-call action and returns its result. */
  end: (reason: Reason) => Promise<Record<string, unknown>> | Record<string, unknown>;
  /** Whether the end-call result confirms the session should close. */
  isEnding: (result: Record<string, unknown>) => boolean;
  /** Closing line instruction for the reason. */
  closingInstruction: (reason: Reason) => string;
  /** Records the end-call tool result after the goodbye has played out. */
  record?: (reason: Reason, result: Record<string, unknown>) => void;
  /** Notified once the call has ended (e.g. request session shutdown). */
  onEnded?: (reason: Reason) => void | Promise<void>;
};

/**
 * Records the end of a call: on a terminal tool result, runs the domain end
 * action, speaks the closing line, records the result, and notifies `onEnded`.
 */
export class EndCallRecorder<Reason extends string = string> {
  private endedWith?: Reason;

  constructor(private readonly options: EndCallRecorderOptions<Reason>) {}

  /** Reason the call ended with, once recorded. */
  get resolution(): Reason | undefined {
    return this.endedWith;
  }

  /** Returns true when the result was terminal and the call is now ending. */
  async intercept(result: unknown, ctx: voice.RunContext): Promise<boolean> {
    const reason = this.options.terminalReason(result);
    if (!reason) return false;

    lockSpeech(ctx);
    const endResult = await runAgentTool(() => this.options.end(reason));
    if (this.endedWith || !this.options.isEnding(endResult)) return false;

    this.endedWith = reason;
    ctx.session.generateReply({
      instructions: this.options.closingInstruction(reason),
      allowInterruptions: false,
    });
    await ctx.waitForPlayout();
    this.options.record?.(reason, endResult);
    await this.options.onEnded?.(reason);
    return true;
  }
}

// ============================================================================
// Infra events
// ============================================================================

/**
 * Re-exported from the client-safe `events` entry; import from
 * `@jchaffin/voicekit/events` in browser code.
 */
export { LIVEKIT_EVENT_SCHEMA, type LiveKitEventSchema } from '../events';
