import { fingerprint, immutable } from "./crypto.js";
import type {
  Assignment,
  AssignmentKey,
  AuditRecord,
  ExperimentRevision,
  LedgerEvent,
  StoredRevision,
} from "./types.js";

export interface AssignmentStore {
  createRevision(revision: ExperimentRevision): Promise<StoredRevision>;
  getRevision(experimentId: string, revision: number): Promise<StoredRevision | undefined>;
  listRevisions(experimentId: string): Promise<readonly StoredRevision[]>;
  transitionRevision(
    experimentId: string,
    revision: number,
    expectedStatus: ExperimentRevision["status"],
    next: ExperimentRevision,
    audit: AuditRecord,
  ): Promise<StoredRevision>;
  getAssignment(key: AssignmentKey): Promise<Assignment | undefined>;
  putAssignmentIfAbsent(key: AssignmentKey, assignment: Assignment, event: LedgerEvent): Promise<Assignment>;
  appendEventIfAbsent(event: LedgerEvent): Promise<LedgerEvent>;
  listEvents(experimentId: string): Promise<readonly LedgerEvent[]>;
  appendAuditRecord(record: AuditRecord): Promise<AuditRecord>;
  listAuditRecords(experimentId: string): Promise<readonly AuditRecord[]>;
}

function assignmentKey(key: AssignmentKey): string {
  return [key.experimentId, key.tenantId, key.unitType, key.unitId].map((part) => `${part.length}:${part}`).join("|");
}

function revisionKey(experimentId: string, revision: number): string {
  return `${experimentId}:${revision}`;
}

/**
 * Atomic within one JavaScript process. Production distributed stores should
 * implement the same compare-and-set and uniqueness semantics transactionally.
 */
export class InMemoryAssignmentStore implements AssignmentStore {
  readonly #revisions = new Map<string, StoredRevision>();
  readonly #assignments = new Map<string, Assignment>();
  readonly #events = new Map<string, LedgerEvent>();
  readonly #audits: AuditRecord[] = [];
  #queue: Promise<void> = Promise.resolve();

  async #atomic<T>(operation: () => T): Promise<T> {
    const previous = this.#queue;
    let release!: () => void;
    this.#queue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return operation();
    } finally {
      release();
    }
  }

  async createRevision(revision: ExperimentRevision): Promise<StoredRevision> {
    return this.#atomic(() => {
      const key = revisionKey(revision.experimentId, revision.revision);
      if (this.#revisions.has(key)) throw new Error(`Revision ${key} already exists`);
      const stored = immutable({ revision: immutable(structuredClone(revision)), fingerprint: fingerprint(revision) });
      this.#revisions.set(key, stored);
      return stored;
    });
  }

  async getRevision(experimentId: string, revision: number): Promise<StoredRevision | undefined> {
    return this.#revisions.get(revisionKey(experimentId, revision));
  }

  async listRevisions(experimentId: string): Promise<readonly StoredRevision[]> {
    return [...this.#revisions.values()]
      .filter(({ revision }) => revision.experimentId === experimentId)
      .sort((a, b) => a.revision.revision - b.revision.revision);
  }

  async transitionRevision(
    experimentId: string,
    revision: number,
    expectedStatus: ExperimentRevision["status"],
    next: ExperimentRevision,
    audit: AuditRecord,
  ): Promise<StoredRevision> {
    return this.#atomic(() => {
      const key = revisionKey(experimentId, revision);
      const current = this.#revisions.get(key);
      if (!current) throw new Error(`Unknown revision ${key}`);
      if (current.revision.status !== expectedStatus) {
        throw new Error(`Status conflict: expected ${expectedStatus}, found ${current.revision.status}`);
      }
      const stored = immutable({ revision: immutable(structuredClone(next)), fingerprint: fingerprint(next) });
      this.#revisions.set(key, stored);
      this.#audits.push(immutable(structuredClone(audit)));
      return stored;
    });
  }

  async getAssignment(key: AssignmentKey): Promise<Assignment | undefined> {
    return this.#assignments.get(assignmentKey(key));
  }

  async putAssignmentIfAbsent(key: AssignmentKey, assignment: Assignment, event: LedgerEvent): Promise<Assignment> {
    return this.#atomic(() => {
      const keyString = assignmentKey(key);
      const existing = this.#assignments.get(keyString);
      if (existing) return existing;
      const saved = immutable(structuredClone(assignment));
      this.#assignments.set(keyString, saved);
      if (!this.#events.has(event.idempotencyKey)) {
        this.#events.set(event.idempotencyKey, immutable(structuredClone(event)));
      }
      return saved;
    });
  }

  async appendEventIfAbsent(event: LedgerEvent): Promise<LedgerEvent> {
    return this.#atomic(() => {
      const existing = this.#events.get(event.idempotencyKey);
      if (existing) return existing;
      const saved = immutable(structuredClone(event));
      this.#events.set(event.idempotencyKey, saved);
      return saved;
    });
  }

  async listEvents(experimentId: string): Promise<readonly LedgerEvent[]> {
    return [...this.#events.values()].filter((event) => event.experimentId === experimentId);
  }

  async appendAuditRecord(record: AuditRecord): Promise<AuditRecord> {
    return this.#atomic(() => {
      if (this.#audits.some((audit) => audit.id === record.id)) throw new Error(`Audit record "${record.id}" already exists`);
      const saved = immutable(structuredClone(record));
      this.#audits.push(saved);
      return saved;
    });
  }

  async listAuditRecords(experimentId: string): Promise<readonly AuditRecord[]> {
    return this.#audits.filter((audit) => audit.experimentId === experimentId);
  }
}
