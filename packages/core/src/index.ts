import {
  VOICEKIT_PROTOCOL_VERSION,
  type EventEnvelope,
  type EventMetadata,
  type VoiceKitEvent,
} from "@jchaffin/voicekit-protocol";

export class OptimisticSequenceError extends Error {
  readonly sessionId: string;
  readonly expectedSequence: number;
  readonly actualSequence: number;

  constructor(sessionId: string, expectedSequence: number, actualSequence: number) {
    super(
      `Sequence conflict for session "${sessionId}": expected ${expectedSequence}, current sequence is ${actualSequence}`,
    );
    this.name = "OptimisticSequenceError";
    this.sessionId = sessionId;
    this.expectedSequence = expectedSequence;
    this.actualSequence = actualSequence;
  }
}

export interface AppendOptions {
  expectedSequence?: number;
  id?: string;
  timestamp?: string;
  metadata?: EventMetadata;
}

export interface JournalReadOptions {
  fromSequence?: number;
  toSequence?: number;
  limit?: number;
}

export interface JournalSubscriptionOptions {
  sessionId?: string;
  fromSequence?: number;
  signal?: AbortSignal;
}

export type JournalSubscriber = (event: EventEnvelope) => void;
export type Unsubscribe = () => void;

export interface EventJournal {
  append(sessionId: string, event: VoiceKitEvent, options?: AppendOptions): EventEnvelope;
  read(sessionId: string, options?: JournalReadOptions): readonly EventEnvelope[];
  latestSequence(sessionId: string): number;
  subscribe(subscriber: JournalSubscriber, options?: JournalSubscriptionOptions): Unsubscribe;
}

interface Subscription {
  subscriber: JournalSubscriber;
  options: JournalSubscriptionOptions;
  abortHandler?: () => void;
}

export class InMemoryEventJournal implements EventJournal {
  readonly #events: EventEnvelope[] = [];
  readonly #bySession = new Map<string, EventEnvelope[]>();
  readonly #subscriptions = new Set<Subscription>();

  append(sessionId: string, event: VoiceKitEvent, options: AppendOptions = {}): EventEnvelope {
    const currentSequence = this.latestSequence(sessionId);
    if (
      options.expectedSequence !== undefined
      && options.expectedSequence !== currentSequence
    ) {
      throw new OptimisticSequenceError(sessionId, options.expectedSequence, currentSequence);
    }

    const envelope: EventEnvelope = {
      protocolVersion: VOICEKIT_PROTOCOL_VERSION,
      id: options.id ?? crypto.randomUUID(),
      sessionId,
      sequence: currentSequence + 1,
      timestamp: options.timestamp ?? new Date().toISOString(),
      event,
    };
    if (options.metadata !== undefined) envelope.metadata = options.metadata;

    this.#events.push(envelope);
    const sessionEvents = this.#bySession.get(sessionId);
    if (sessionEvents) sessionEvents.push(envelope);
    else this.#bySession.set(sessionId, [envelope]);

    for (const subscription of [...this.#subscriptions]) {
      if (
        (subscription.options.sessionId === undefined
          || subscription.options.sessionId === sessionId)
        && envelope.sequence >= (subscription.options.fromSequence ?? 1)
      ) {
        subscription.subscriber(envelope);
      }
    }
    return envelope;
  }

  read(sessionId: string, options: JournalReadOptions = {}): readonly EventEnvelope[] {
    const from = options.fromSequence ?? 1;
    const to = options.toSequence ?? Number.POSITIVE_INFINITY;
    const limit = options.limit ?? Number.POSITIVE_INFINITY;
    if (from < 1) throw new RangeError("fromSequence must be at least 1");
    if (to < from) throw new RangeError("toSequence must be greater than or equal to fromSequence");
    if (limit < 0) throw new RangeError("limit cannot be negative");
    return (this.#bySession.get(sessionId) ?? [])
      .filter((event) => event.sequence >= from && event.sequence <= to)
      .slice(0, limit);
  }

  latestSequence(sessionId: string): number {
    const events = this.#bySession.get(sessionId);
    return events?.[events.length - 1]?.sequence ?? 0;
  }

  subscribe(
    subscriber: JournalSubscriber,
    options: JournalSubscriptionOptions = {},
  ): Unsubscribe {
    if (options.signal?.aborted) return () => undefined;

    const subscription: Subscription = { subscriber, options };
    const unsubscribe = (): void => {
      if (!this.#subscriptions.delete(subscription)) return;
      if (subscription.abortHandler && options.signal) {
        options.signal.removeEventListener("abort", subscription.abortHandler);
      }
    };
    if (options.signal) {
      subscription.abortHandler = unsubscribe;
      options.signal.addEventListener("abort", unsubscribe, { once: true });
    }
    this.#subscriptions.add(subscription);
    return unsubscribe;
  }

  get size(): number {
    return this.#events.length;
  }
}

export function throwIfAbortedOrExpired(
  signal?: AbortSignal,
  deadline?: string | Date,
  now: Date = new Date(),
): void {
  signal?.throwIfAborted();
  if (deadline !== undefined) {
    const parsed = deadline instanceof Date ? deadline : new Date(deadline);
    if (Number.isNaN(parsed.getTime())) throw new RangeError("Invalid deadline");
    if (parsed.getTime() <= now.getTime()) {
      throw new DeadlineExceededError(parsed);
    }
  }
}

export class DeadlineExceededError extends Error {
  readonly deadline: Date;

  constructor(deadline: Date) {
    super(`Command deadline exceeded at ${deadline.toISOString()}`);
    this.name = "DeadlineExceededError";
    this.deadline = deadline;
  }
}
