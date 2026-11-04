/**
 * Typed structured-event catalogs.
 *
 * A catalog maps event names to zod payload schemas. Layers contribute their
 * own catalogs and the app composes them where its logger is created:
 *
 * ```ts
 * import { LIVEKIT_EVENT_SCHEMA, SESSION_EVENT_SCHEMA } from '@jchaffin/voicekit/events';
 *
 * const LOG_SCHEMA = { ...SESSION_EVENT_SCHEMA, ...LIVEKIT_EVENT_SCHEMA, ...DOMAIN_EVENT_SCHEMA };
 * ```
 *
 * This module is client-safe: schemas only, no provider SDK imports.
 */

import { z } from 'zod';

/** An event catalog: payload schema per event name. */
export type EventSchemaMap = Record<string, z.ZodType<Record<string, unknown>>>;

/** The discriminated union of typed events described by a catalog. */
export type EventOf<C extends EventSchemaMap> = {
  [K in keyof C & string]: { event: K; details: z.infer<C[K]> };
}[keyof C & string];

/**
 * Schema for a payload that allows extra keys. Spelled as `z.ZodType` so the
 * published declarations work with both zod 3 and zod 4 consumers.
 */
export type LooseEventSchema<T extends Record<string, unknown>> = z.ZodType<T & { [key: string]: unknown }>;

/** Typed details payload per event name in a catalog. */
export type EventDetailsOf<C extends EventSchemaMap> = {
  [K in keyof C & string]: z.infer<C[K]>;
};

/** Parses an untyped wire entry into a typed event; unknown names or invalid payloads yield undefined. */
export function parseEvent<C extends EventSchemaMap>(
  catalog: C,
  entry: { event: string; details: unknown },
): EventOf<C> | undefined {
  const schema = catalog[entry.event];
  if (!schema) return undefined;
  const parsed = schema.safeParse(entry.details);
  return parsed.success ? ({ event: entry.event, details: parsed.data } as EventOf<C>) : undefined;
}

export type SessionEventSchema = {
  readonly state_transition: LooseEventSchema<{ from?: string; to: string }>;
  readonly tool_call: LooseEventSchema<{ name: string; input: unknown }>;
  readonly tool_result: LooseEventSchema<{ name: string; result: unknown }>;
  readonly transcription: LooseEventSchema<{ speaker: string; text: string; id: string; timestamp: string }>;
  readonly end_call_failed: LooseEventSchema<{ reason: string; error?: string }>;
};

/** Provider-agnostic voice-session events. */
export const SESSION_EVENT_SCHEMA: SessionEventSchema = {
  state_transition: z.object({ from: z.string().optional(), to: z.string() }).passthrough(),
  tool_call: z.object({ name: z.string(), input: z.unknown() }).passthrough(),
  tool_result: z.object({ name: z.string(), result: z.unknown() }).passthrough(),
  transcription: z
    .object({
      speaker: z.string(),
      text: z.string(),
      id: z.string(),
      timestamp: z.string(),
    })
    .passthrough(),
  end_call_failed: z.object({ reason: z.string(), error: z.string().optional() }).passthrough(),
};

export type LiveKitEventSchema = {
  readonly egress_started: LooseEventSchema<{}>;
  readonly egress_stopped: LooseEventSchema<{}>;
  readonly egress_skipped: LooseEventSchema<{ reason: string }>;
  readonly egress_error: LooseEventSchema<{}>;
  readonly room_deleted: LooseEventSchema<{ reason: string; alreadyGone?: boolean }>;
};

/**
 * LiveKit infrastructure events (egress recording, room lifecycle). Defined
 * here rather than in the livekit-agents adapter so browser code can parse
 * these events without pulling the Node-only agent stack into the bundle.
 */
export const LIVEKIT_EVENT_SCHEMA: LiveKitEventSchema = {
  egress_started: z.object({}).passthrough(),
  egress_stopped: z.object({}).passthrough(),
  egress_skipped: z.object({ reason: z.string() }).passthrough(),
  egress_error: z.object({}).passthrough(),
  room_deleted: z.object({ reason: z.string(), alreadyGone: z.boolean().optional() }).passthrough(),
};
