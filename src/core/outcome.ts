/** Event the recorder sends when an outcome is recorded. */
export type OutcomeRecordedEvent<Outcome extends string = string> = {
  type: 'OUTCOME_RECORDED';
  outcome: Outcome;
};

/** Any actor whose machine handles `OUTCOME_RECORDED` (e.g. an XState actor). */
export type OutcomeActor<Outcome extends string = string> = {
  send: (event: OutcomeRecordedEvent<Outcome>) => void;
};

export type OutcomeRecorderOptions<Outcome extends string, Details extends Record<string, unknown>, Id> = {
  /** Call actor to notify; the recorder sends `OUTCOME_RECORDED` itself. */
  actor: OutcomeActor<Outcome>;
  /** Persists the outcome and returns its storage id. */
  persist: (outcome: Outcome, details: Details) => Promise<Id>;
  /** Emits the structured `final_outcome` log entry. */
  log: (entry: { outcomeId: Id; outcome: Outcome }, details: Details) => void;
};

/**
 * The one way any outcome gets recorded, regardless of domain:
 * sends `OUTCOME_RECORDED` to the call actor, persists, and logs.
 */
export class OutcomeRecorder<
  Outcome extends string = string,
  Details extends Record<string, unknown> = Record<string, unknown>,
  Id = unknown,
> {
  private latest?: Outcome;

  constructor(private readonly options: OutcomeRecorderOptions<Outcome, Details, Id>) {}

  /** Latest recorded outcome, if the call has resolved to one. */
  get resolution(): Outcome | undefined {
    return this.latest;
  }

  async record(outcome: Outcome, details: Details): Promise<Id> {
    this.latest = outcome;
    this.options.actor.send({ type: 'OUTCOME_RECORDED', outcome });
    const outcomeId = await this.options.persist(outcome, details);
    this.options.log({ outcomeId, outcome }, details);
    return outcomeId;
  }
}
