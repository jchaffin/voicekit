import { eventId, hmacFraction, immutable } from "./crypto.js";
import type { AssignmentStore } from "./store.js";
import type {
  AllocationEpoch,
  Assignment,
  AssignmentDecision,
  AssignmentKey,
  AssignmentUnit,
  EligibilityPredicate,
  ExperimentRevision,
  ExposureLedgerEvent,
  OutcomeLedgerEvent,
  RoutingDeviation,
  RoutingOwner,
  VariantManifest,
} from "./types.js";

export interface AssignOptions {
  readonly now?: Date;
  readonly routingOwner?: RoutingOwner;
  readonly reconnectOf?: string;
  readonly skipLayerCheck?: boolean;
}

function assertFraction(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new TypeError(`${name} must be between 0 and 1`);
}

export function validateRevision(revision: ExperimentRevision): void {
  if (!revision.experimentId.trim() || !revision.salt.trim()) throw new TypeError("experimentId and salt are required");
  if (!Number.isInteger(revision.revision) || revision.revision < 1) throw new TypeError("revision must be a positive integer");
  if (revision.variants.length < 2) throw new TypeError("At least two variants are required");
  const ids = new Set<string>();
  for (const variant of revision.variants) {
    if (!variant.id.trim() || ids.has(variant.id)) throw new TypeError(`Invalid or duplicate variant id "${variant.id}"`);
    if (!Number.isFinite(variant.weight) || variant.weight < 0) throw new TypeError(`Invalid weight for "${variant.id}"`);
    ids.add(variant.id);
  }
  if (revision.variants.reduce((sum, variant) => sum + variant.weight, 0) <= 0) {
    throw new TypeError("Variant weights must have a positive total");
  }
  if (!revision.allocationEpochs.length) throw new TypeError("At least one allocation epoch is required");
  let prior = "";
  const epochIds = new Set<string>();
  for (const epoch of revision.allocationEpochs) {
    if (epochIds.has(epoch.id)) throw new TypeError(`Duplicate epoch id "${epoch.id}"`);
    epochIds.add(epoch.id);
    assertFraction(epoch.allocation, `allocation for epoch "${epoch.id}"`);
    const timestamp = new Date(epoch.startsAt).toISOString();
    if (prior && timestamp <= prior) throw new TypeError("Allocation epochs must be strictly chronological");
    prior = timestamp;
    if (epoch.variantWeights) {
      for (const [id, weight] of Object.entries(epoch.variantWeights)) {
        if (!ids.has(id) || !Number.isFinite(weight) || weight < 0) throw new TypeError(`Invalid epoch weight for "${id}"`);
      }
    }
  }
  if (revision.layerAllocation !== undefined) assertFraction(revision.layerAllocation, "layerAllocation");
  if (revision.holdout) assertFraction(revision.holdout.allocation, "holdout allocation");
  const metricIds = new Set<string>();
  for (const metric of revision.metrics) {
    if (!metric.id.trim() || metricIds.has(metric.id)) throw new TypeError(`Invalid or duplicate metric id "${metric.id}"`);
    metricIds.add(metric.id);
    if (metric.kind === "currency" && !metric.unit) throw new TypeError(`Currency metric "${metric.id}" requires a unit`);
  }
}

export function isEligible(predicate: EligibilityPredicate, unit: AssignmentUnit): boolean {
  const value = "attribute" in predicate ? unit.attributes?.[predicate.attribute] : undefined;
  switch (predicate.op) {
    case "always": return true;
    case "eq": return value === predicate.value;
    case "neq": return value !== predicate.value;
    case "in": return predicate.values.includes(value ?? null);
    case "not_in": return !predicate.values.includes(value ?? null);
    case "exists": return value !== undefined;
    case "and": return predicate.predicates.every((child) => isEligible(child, unit));
    case "or": return predicate.predicates.some((child) => isEligible(child, unit));
    case "not": return !isEligible(predicate.predicate, unit);
  }
}

function activeEpoch(revision: ExperimentRevision, now: Date): AllocationEpoch | undefined {
  const timestamp = now.getTime();
  return [...revision.allocationEpochs].reverse().find((epoch) => new Date(epoch.startsAt).getTime() <= timestamp);
}

function pickVariant(revision: ExperimentRevision, epoch: AllocationEpoch, fraction: number): VariantManifest {
  const weighted = revision.variants.map((variant) => ({
    variant,
    weight: epoch.variantWeights?.[variant.id] ?? variant.weight,
  }));
  const total = weighted.reduce((sum, item) => sum + item.weight, 0);
  if (total <= 0) throw new Error(`Epoch "${epoch.id}" has no positive variant weights`);
  let cursor = fraction * total;
  for (const item of weighted) {
    cursor -= item.weight;
    if (cursor < 0) return item.variant;
  }
  return weighted[weighted.length - 1]!.variant;
}

function keyFor(revision: ExperimentRevision, unit: AssignmentUnit): AssignmentKey {
  return {
    experimentId: revision.experimentId,
    tenantId: unit.tenantId,
    unitType: unit.type,
    unitId: unit.id,
  };
}

export class ExperimentAssigner {
  constructor(
    readonly store: AssignmentStore,
    readonly hmacSecret: string,
  ) {
    if (!hmacSecret) throw new TypeError("hmacSecret is required");
  }

  async assign(
    revision: ExperimentRevision,
    unit: AssignmentUnit,
    options: AssignOptions = {},
  ): Promise<AssignmentDecision> {
    validateRevision(revision);
    const key = keyFor(revision, unit);
    const existing = await this.store.getAssignment(key);
    if (existing) return { kind: "assigned", assignment: existing, existing: true };
    if (revision.status !== "running") return { kind: "ineligible", reason: "not_running" };
    if (unit.type !== revision.assignmentUnitType) return { kind: "ineligible", reason: "unit_type" };
    if (!isEligible(revision.eligibility, unit)) return { kind: "ineligible", reason: "predicate" };
    const now = options.now ?? new Date();
    const epoch = activeEpoch(revision, now);
    if (!epoch) return { kind: "excluded", reason: "allocation", epochId: "not_started" };
    const identity = [unit.tenantId, unit.type, unit.id];
    if (revision.holdout && hmacFraction(this.hmacSecret, [revision.salt, "holdout", ...identity]) < revision.holdout.allocation) {
      return { kind: "excluded", reason: "holdout", epochId: epoch.id };
    }
    if (!options.skipLayerCheck && revision.layerId && revision.layerAllocation !== undefined) {
      const layerFraction = hmacFraction(this.hmacSecret, [revision.salt, "layer", revision.layerId, ...identity]);
      if (layerFraction >= revision.layerAllocation) return { kind: "excluded", reason: "layer", epochId: epoch.id };
    }
    const allocationFraction = hmacFraction(this.hmacSecret, [revision.salt, "allocation", ...identity]);
    if (allocationFraction >= epoch.allocation) return { kind: "excluded", reason: "allocation", epochId: epoch.id };
    const variant = pickVariant(
      revision,
      epoch,
      hmacFraction(this.hmacSecret, [revision.salt, "variant", epoch.id, ...identity]),
    );
    const assignedAt = now.toISOString();
    const assignment: Assignment = immutable({
      experimentId: revision.experimentId,
      revision: revision.revision,
      tenantId: unit.tenantId,
      unitType: unit.type,
      unitId: unit.id,
      variantId: variant.id,
      epochId: epoch.id,
      assignedAt,
      routingOwner: options.routingOwner ?? "voicekit",
      ...(revision.layerId ? { layerId: revision.layerId } : {}),
      ...(options.reconnectOf ? { reconnectOf: options.reconnectOf } : {}),
    });
    const event = immutable({
      id: eventId(),
      idempotencyKey: `assignment:${revision.experimentId}:${unit.tenantId}:${unit.type}:${unit.id}`,
      type: "assignment" as const,
      experimentId: revision.experimentId,
      revision: revision.revision,
      tenantId: unit.tenantId,
      unitType: unit.type,
      unitId: unit.id,
      variantId: variant.id,
      epochId: epoch.id,
      occurredAt: assignedAt,
    });
    const saved = await this.store.putAssignmentIfAbsent(key, assignment, event);
    return { kind: "assigned", assignment: saved, existing: saved !== assignment };
  }

  /**
   * Coordinates experiments in one mutually-exclusive layer. Allocation values
   * are relative weights; at most one experiment is selected for a unit.
   */
  async assignLayer(
    revisions: readonly ExperimentRevision[],
    unit: AssignmentUnit,
    options: AssignOptions = {},
  ): Promise<Readonly<Record<string, AssignmentDecision>>> {
    if (!revisions.length) return {};
    const layerId = revisions[0]!.layerId;
    if (!layerId || revisions.some((revision) => revision.layerId !== layerId)) {
      throw new TypeError("All revisions must share a layerId");
    }
    const candidates = revisions.filter((revision) =>
      revision.status === "running" &&
      revision.assignmentUnitType === unit.type &&
      isEligible(revision.eligibility, unit),
    );
    const total = candidates.reduce((sum, revision) => sum + (revision.layerAllocation ?? 1), 0);
    const fraction = hmacFraction(this.hmacSecret, ["layer", layerId, unit.tenantId, unit.type, unit.id]) * total;
    let cursor = fraction;
    let selected: ExperimentRevision | undefined;
    for (const revision of [...candidates].sort((a, b) => a.experimentId.localeCompare(b.experimentId))) {
      cursor -= revision.layerAllocation ?? 1;
      if (cursor < 0) { selected = revision; break; }
    }
    const results: Record<string, AssignmentDecision> = {};
    for (const revision of revisions) {
      const epochId = activeEpoch(revision, options.now ?? new Date())?.id ?? "not_started";
      results[revision.experimentId] = revision === selected
        ? await this.assign(revision, unit, { ...options, skipLayerCheck: true })
        : { kind: "excluded", reason: "layer", epochId };
    }
    return results;
  }

  async recordExposure(input: {
    readonly assignment: Assignment;
    readonly idempotencyKey: string;
    readonly occurredAt?: Date;
    readonly sessionId?: string;
    readonly deviation?: RoutingDeviation;
    readonly metadata?: Readonly<Record<string, unknown>>;
  }): Promise<ExposureLedgerEvent> {
    const event: ExposureLedgerEvent = immutable({
      id: eventId(),
      idempotencyKey: input.idempotencyKey,
      type: "exposure",
      experimentId: input.assignment.experimentId,
      revision: input.assignment.revision,
      tenantId: input.assignment.tenantId,
      unitType: input.assignment.unitType,
      unitId: input.assignment.unitId,
      variantId: input.assignment.variantId,
      occurredAt: (input.occurredAt ?? new Date()).toISOString(),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.deviation ? { deviation: input.deviation } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
    });
    return this.store.appendEventIfAbsent(event) as Promise<ExposureLedgerEvent>;
  }

  async recordOutcome(input: {
    readonly assignment: Assignment;
    readonly metricId: string;
    readonly value: number;
    readonly idempotencyKey: string;
    readonly occurredAt?: Date;
    readonly metadata?: Readonly<Record<string, unknown>>;
  }): Promise<OutcomeLedgerEvent> {
    if (!Number.isFinite(input.value)) throw new TypeError("Outcome value must be finite");
    const event: OutcomeLedgerEvent = immutable({
      id: eventId(),
      idempotencyKey: input.idempotencyKey,
      type: "outcome",
      experimentId: input.assignment.experimentId,
      revision: input.assignment.revision,
      tenantId: input.assignment.tenantId,
      unitType: input.assignment.unitType,
      unitId: input.assignment.unitId,
      metricId: input.metricId,
      value: input.value,
      occurredAt: (input.occurredAt ?? new Date()).toISOString(),
      ...(input.metadata ? { metadata: input.metadata } : {}),
    });
    return this.store.appendEventIfAbsent(event) as Promise<OutcomeLedgerEvent>;
  }
}
