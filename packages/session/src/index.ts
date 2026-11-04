import {
  type Command,
  type CommandEnvelope,
  type ErrorDescriptor,
  type EventEnvelope,
  type JsonValue,
  type SessionPhase,
  type VoiceKitEvent,
} from "@jchaffin/voicekit-protocol";
import {
  type EventJournal,
  type InMemoryEventJournal,
  throwIfAbortedOrExpired,
} from "@jchaffin/voicekit-core";

export interface SessionState {
  sessionId: string;
  phase: SessionPhase;
  sequence: number;
  createdAt?: string;
  updatedAt?: string;
  closedReason?: string;
  failure?: ErrorDescriptor;
  configuration?: JsonValue;
}

export function initialSessionState(sessionId: string): SessionState {
  return { sessionId, phase: "created", sequence: 0 };
}

export function reduceSessionEvent(
  state: SessionState,
  envelope: EventEnvelope,
): SessionState {
  if (envelope.sessionId !== state.sessionId) return state;
  const next: SessionState = {
    ...state,
    sequence: envelope.sequence,
    updatedAt: envelope.timestamp,
  };
  switch (envelope.event.type) {
    case "lifecycle.session_created":
      next.createdAt = envelope.timestamp;
      if (envelope.event.data.configuration !== undefined) {
        next.configuration = envelope.event.data.configuration;
      }
      return next;
    case "lifecycle.phase_changed":
      next.phase = envelope.event.data.to;
      return next;
    case "lifecycle.session_closed":
      next.phase = "closed";
      next.closedReason = envelope.event.data.reason;
      return next;
    case "error.occurred":
      if (envelope.event.data.fatal) {
        next.phase = "failed";
        next.failure = envelope.event.data;
      }
      return next;
    default:
      return next;
  }
}

export function replaySession(
  sessionId: string,
  events: readonly EventEnvelope[],
): SessionState {
  return events.reduce(reduceSessionEvent, initialSessionState(sessionId));
}

const ALLOWED_TRANSITIONS: Readonly<Record<SessionPhase, readonly SessionPhase[]>> = {
  created: ["provisioning", "closed", "failed"],
  provisioning: ["connecting", "draining", "failed"],
  connecting: ["ready", "reconnecting", "draining", "failed"],
  ready: ["listening", "thinking", "speaking", "handing-off", "reconnecting", "draining", "closed", "failed"],
  listening: ["ready", "thinking", "speaking", "handing-off", "reconnecting", "draining", "failed"],
  thinking: ["ready", "listening", "speaking", "handing-off", "reconnecting", "draining", "failed"],
  speaking: ["ready", "listening", "thinking", "handing-off", "reconnecting", "draining", "failed"],
  "handing-off": ["ready", "reconnecting", "draining", "closed", "failed"],
  reconnecting: ["connecting", "ready", "listening", "draining", "failed"],
  draining: ["closed", "failed"],
  closed: [],
  failed: [],
};

export class InvalidSessionTransitionError extends Error {
  readonly from: SessionPhase;
  readonly to: SessionPhase;

  constructor(from: SessionPhase, to: SessionPhase) {
    super(`Invalid VoiceKit session transition: ${from} -> ${to}`);
    this.name = "InvalidSessionTransitionError";
    this.from = from;
    this.to = to;
  }
}

export interface HandleCommandOptions {
  signal?: AbortSignal;
}

export interface CommandResult {
  commandId: string;
  events: readonly EventEnvelope[];
  state: SessionState;
  idempotentReplay: boolean;
}

export interface SessionControllerOptions {
  initialize?: boolean;
  configuration?: JsonValue;
  now?: () => Date;
  idFactory?: () => string;
}

function commandTarget(command: Command): SessionPhase | undefined {
  switch (command.type) {
    case "session.provision": return "provisioning";
    case "session.connect": return "connecting";
    case "session.ready": return "ready";
    case "session.listen": return "listening";
    case "session.think": return "thinking";
    case "session.speak": return "speaking";
    case "session.handoff": return "handing-off";
    case "session.reconnect": return "reconnecting";
    case "session.drain": return "draining";
    case "session.close": return "closed";
    case "session.fail": return "failed";
    case "session.transition": return command.data.phase;
    case "provider.emit_raw": return undefined;
  }
}

function commandReason(command: Command): string | undefined {
  if ("reason" in command.data && typeof command.data.reason === "string") {
    return command.data.reason;
  }
  if (command.type === "session.fail") return command.data.error.message;
  return undefined;
}

export class SessionController {
  readonly sessionId: string;
  readonly #journal: EventJournal;
  readonly #now: () => Date;
  readonly #idFactory: () => string;

  constructor(
    sessionId: string,
    journal: EventJournal,
    options: SessionControllerOptions = {},
  ) {
    this.sessionId = sessionId;
    this.#journal = journal;
    this.#now = options.now ?? (() => new Date());
    this.#idFactory = options.idFactory ?? (() => crypto.randomUUID());
    if ((options.initialize ?? true) && journal.latestSequence(sessionId) === 0) {
      const data = options.configuration === undefined
        ? {}
        : { configuration: options.configuration };
      journal.append(
        sessionId,
        { type: "lifecycle.session_created", data },
        { expectedSequence: 0, id: this.#idFactory(), timestamp: this.#now().toISOString() },
      );
    }
  }

  get state(): SessionState {
    return replaySession(this.sessionId, this.#journal.read(this.sessionId));
  }

  get events(): readonly EventEnvelope[] {
    return this.#journal.read(this.sessionId);
  }

  async handle(
    envelope: CommandEnvelope,
    options: HandleCommandOptions = {},
  ): Promise<CommandResult> {
    if (envelope.sessionId !== this.sessionId) {
      throw new RangeError(
        `Command session "${envelope.sessionId}" does not match controller session "${this.sessionId}"`,
      );
    }
    throwIfAbortedOrExpired(options.signal, envelope.deadline, this.#now());

    const previous = this.#journal
      .read(this.sessionId)
      .filter((event) => event.metadata?.causationId === envelope.id);
    if (previous.length > 0) {
      return {
        commandId: envelope.id,
        events: previous,
        state: this.state,
        idempotentReplay: true,
      };
    }

    const state = this.state;
    const target = commandTarget(envelope.command);
    const emitted: EventEnvelope[] = [];
    const append = (event: VoiceKitEvent): EventEnvelope => {
      const appended = this.#journal.append(this.sessionId, event, {
        expectedSequence: this.#journal.latestSequence(this.sessionId),
        id: this.#idFactory(),
        timestamp: this.#now().toISOString(),
        metadata: {
          ...envelope.metadata,
          causationId: envelope.id,
          correlationId: envelope.metadata?.correlationId ?? envelope.id,
        },
      });
      emitted.push(appended);
      return appended;
    };

    if (envelope.command.type === "provider.emit_raw") {
      append({
        type: "provider.raw",
        data: {
          ...envelope.command.data,
          receivedAt: this.#now().toISOString(),
        },
      });
    } else if (target !== undefined) {
      if (target !== state.phase) {
        if (!ALLOWED_TRANSITIONS[state.phase].includes(target)) {
          throw new InvalidSessionTransitionError(state.phase, target);
        }
        const reason = commandReason(envelope.command);
        append({
          type: "lifecycle.phase_changed",
          data: {
            from: state.phase,
            to: target,
            ...(reason === undefined ? {} : { reason }),
          },
        });
      }
      if (envelope.command.type === "session.fail") {
        append({
          type: "error.occurred",
          data: { ...envelope.command.data.error, fatal: true },
        });
      }
      if (envelope.command.type === "session.close") {
        append({
          type: "lifecycle.session_closed",
          data: {
            reason: envelope.command.data.reason ?? "commanded",
            clean: state.phase === "draining" || state.phase === "ready",
          },
        });
      }
    }

    if (emitted.length === 0) {
      append({
        type: "lifecycle.command_accepted",
        data: {
          commandId: envelope.id,
          commandType: envelope.command.type,
          noOp: true,
        },
      });
    }

    return {
      commandId: envelope.id,
      events: emitted,
      state: this.state,
      idempotentReplay: false,
    };
  }

  subscribe(
    subscriber: (state: SessionState, event: EventEnvelope) => void,
    signal?: AbortSignal,
  ): () => void {
    let state = this.state;
    return this.#journal.subscribe(
      (event) => {
        state = reduceSessionEvent(state, event);
        subscriber(state, event);
      },
      {
        sessionId: this.sessionId,
        ...(signal === undefined ? {} : { signal }),
      },
    );
  }
}

export type { EventJournal, InMemoryEventJournal };
