import { eventId, immutable } from "./crypto.js";
import { validateRevision } from "./experiment.js";
import type { AssignmentStore } from "./store.js";
import type {
  ApprovalContext,
  ApprovalHook,
  AuditRecord,
  ExperimentRevision,
  ExperimentStatus,
  StoredRevision,
} from "./types.js";

const transitions: Readonly<Record<ExperimentStatus, readonly ExperimentStatus[]>> = {
  draft: ["approved"],
  approved: ["running"],
  running: ["paused", "completed", "rolled_back"],
  paused: ["running", "completed", "rolled_back"],
  completed: ["rolled_back"],
  rolled_back: [],
};

const actionFor: Readonly<Record<Exclude<ExperimentStatus, "draft">, AuditRecord["action"]>> = {
  approved: "approve",
  running: "start",
  paused: "pause",
  completed: "complete",
  rolled_back: "rollback",
};

export class RoleApprovalHook implements ApprovalHook {
  constructor(
    readonly requiredRoles: Readonly<Partial<Record<AuditRecord["action"], readonly string[]>>> = {
      approve: ["experiment:approve"],
      start: ["experiment:operate"],
      pause: ["experiment:operate"],
      complete: ["experiment:operate"],
      rollback: ["experiment:operate"],
    },
  ) {}

  authorize({ action, context }: Parameters<ApprovalHook["authorize"]>[0]): boolean {
    const required = this.requiredRoles[action] ?? [];
    return required.length === 0 || required.some((role) => context.roles.includes(role));
  }
}

export class ExperimentLifecycle {
  constructor(
    readonly store: AssignmentStore,
    readonly approvalHook: ApprovalHook = new RoleApprovalHook(),
  ) {}

  async create(revision: ExperimentRevision, context: ApprovalContext): Promise<StoredRevision> {
    validateRevision(revision);
    if (revision.status !== "draft") throw new TypeError("New revisions must start in draft");
    const revisions = await this.store.listRevisions(revision.experimentId);
    const expected = revisions.length ? revisions[revisions.length - 1]!.revision.revision + 1 : 1;
    if (revision.revision !== expected) throw new Error(`Expected revision ${expected}`);
    const authorized = await this.approvalHook.authorize({ action: "create_revision", revision, context });
    if (!authorized) throw new Error("Not authorized to create experiment revision");
    const stored = await this.store.createRevision(immutable(structuredClone(revision)));
    await this.store.appendAuditRecord(immutable({
      id: eventId(),
      experimentId: revision.experimentId,
      revision: revision.revision,
      actorId: context.actorId,
      action: "create_revision",
      toStatus: "draft",
      occurredAt: new Date().toISOString(),
      ...(context.reason ? { reason: context.reason } : {}),
      ...(context.metadata ? { metadata: context.metadata } : {}),
    }));
    return stored;
  }

  async transition(
    experimentId: string,
    revisionNumber: number,
    toStatus: Exclude<ExperimentStatus, "draft">,
    context: ApprovalContext,
    now: Date = new Date(),
  ): Promise<StoredRevision> {
    const stored = await this.store.getRevision(experimentId, revisionNumber);
    if (!stored) throw new Error(`Unknown revision ${experimentId}:${revisionNumber}`);
    const fromStatus = stored.revision.status;
    if (!transitions[fromStatus].includes(toStatus)) throw new Error(`Invalid transition ${fromStatus} → ${toStatus}`);
    const action = actionFor[toStatus];
    if (!await this.approvalHook.authorize({ action, revision: stored.revision, context })) {
      throw new Error(`Not authorized to ${action}`);
    }
    const next: ExperimentRevision = immutable({
      ...stored.revision,
      status: toStatus,
      ...(toStatus === "approved"
        ? { approvedAt: now.toISOString(), approvedBy: context.actorId }
        : {}),
    });
    const audit: AuditRecord = immutable({
      id: eventId(),
      experimentId,
      revision: revisionNumber,
      actorId: context.actorId,
      action,
      fromStatus,
      toStatus,
      occurredAt: now.toISOString(),
      ...(context.reason ? { reason: context.reason } : {}),
      ...(context.metadata ? { metadata: context.metadata } : {}),
    });
    return this.store.transitionRevision(experimentId, revisionNumber, fromStatus, next, audit);
  }
}
