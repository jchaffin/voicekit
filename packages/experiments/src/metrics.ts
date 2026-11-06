import type { ExperimentRevision, LedgerEvent, MetricDefinition } from "./types.js";

export interface VariantMetricSummary {
  readonly variantId: string;
  readonly assignedUnits: number;
  readonly observedUnits: number;
  readonly total: number;
  readonly meanPerAssignedUnit: number;
  readonly observedMean: number;
}

export interface MetricSummary {
  readonly metric: MetricDefinition;
  readonly analysis: "intention_to_treat";
  readonly variants: readonly VariantMetricSummary[];
  readonly guardrailBreaches: readonly string[];
}

export interface SampleRatioDiagnostic {
  readonly observed: Readonly<Record<string, number>>;
  readonly expected: Readonly<Record<string, number>>;
  readonly chiSquare: number;
  readonly degreesOfFreedom: number;
  readonly maxRelativeDeviation: number;
  readonly severity: "ok" | "review" | "severe";
  readonly note: string;
}

const unitKey = (event: LedgerEvent): string =>
  [event.tenantId, event.unitType, event.unitId].map((part) => `${part.length}:${part}`).join("|");

export function diagnoseSampleRatioMismatch(
  revision: ExperimentRevision,
  events: readonly LedgerEvent[],
  epochId?: string,
): SampleRatioDiagnostic {
  const assignments = events.filter((event) =>
    event.type === "assignment" &&
    event.revision === revision.revision &&
    (!epochId || event.epochId === epochId),
  );
  const epoch = epochId
    ? revision.allocationEpochs.find((candidate) => candidate.id === epochId)
    : revision.allocationEpochs[revision.allocationEpochs.length - 1];
  if (!epoch) throw new Error("Cannot diagnose a revision without an allocation epoch");
  const weights = revision.variants.map((variant) => epoch.variantWeights?.[variant.id] ?? variant.weight);
  const weightTotal = weights.reduce((sum, weight) => sum + weight, 0);
  const observed: Record<string, number> = {};
  const expected: Record<string, number> = {};
  let chiSquare = 0;
  let maxRelativeDeviation = 0;
  revision.variants.forEach((variant, index) => {
    const count = assignments.filter((event) => event.type === "assignment" && event.variantId === variant.id).length;
    const expectedCount = assignments.length * (weights[index]! / weightTotal);
    observed[variant.id] = count;
    expected[variant.id] = expectedCount;
    if (expectedCount > 0) {
      chiSquare += (count - expectedCount) ** 2 / expectedCount;
      maxRelativeDeviation = Math.max(maxRelativeDeviation, Math.abs(count - expectedCount) / expectedCount);
    }
  });
  const degreesOfFreedom = Math.max(0, revision.variants.length - 1);
  const normalized = degreesOfFreedom ? chiSquare / degreesOfFreedom : 0;
  const severity = assignments.length < 100 || normalized < 2
    ? "ok"
    : normalized < 5 || maxRelativeDeviation < 0.2 ? "review" : "severe";
  return {
    observed,
    expected,
    chiSquare,
    degreesOfFreedom,
    maxRelativeDeviation,
    severity,
    note: "Operational SRM diagnostic only; thresholds are heuristics and are not a statistical significance test.",
  };
}

function compare(value: number, guardrail: NonNullable<MetricDefinition["guardrail"]>): boolean {
  switch (guardrail.comparison) {
    case "gt": return value > guardrail.threshold;
    case "gte": return value >= guardrail.threshold;
    case "lt": return value < guardrail.threshold;
    case "lte": return value <= guardrail.threshold;
  }
}

export function summarizeIntentionToTreat(
  revision: ExperimentRevision,
  events: readonly LedgerEvent[],
): readonly MetricSummary[] {
  const assignmentByUnit = new Map<string, string>();
  for (const event of events) {
    if (event.type === "assignment" && event.revision === revision.revision) {
      assignmentByUnit.set(unitKey(event), event.variantId);
    }
  }
  return revision.metrics.map((metric) => {
    const variants = revision.variants.map((variant): VariantMetricSummary => {
      const assignedUnits = [...assignmentByUnit.values()].filter((id) => id === variant.id).length;
      const valuesByUnit = new Map<string, number>();
      for (const event of events) {
        if (event.type !== "outcome" || event.metricId !== metric.id || event.revision !== revision.revision) continue;
        const key = unitKey(event);
        if (assignmentByUnit.get(key) !== variant.id) continue;
        if (metric.kind === "binary" && event.value !== 0 && event.value !== 1) {
          throw new TypeError(`Binary metric "${metric.id}" only accepts 0 or 1`);
        }
        if ((metric.kind === "count" || metric.kind === "duration" || metric.kind === "currency") && event.value < 0) {
          throw new TypeError(`${metric.kind} metric "${metric.id}" cannot be negative`);
        }
        valuesByUnit.set(key, (valuesByUnit.get(key) ?? 0) + event.value);
      }
      const total = [...valuesByUnit.values()].reduce((sum, value) => sum + value, 0);
      return {
        variantId: variant.id,
        assignedUnits,
        observedUnits: valuesByUnit.size,
        total,
        meanPerAssignedUnit: assignedUnits ? total / assignedUnits : 0,
        observedMean: valuesByUnit.size ? total / valuesByUnit.size : 0,
      };
    });
    const guardrailBreaches = metric.guardrail
      ? variants.filter((variant) => compare(variant.meanPerAssignedUnit, metric.guardrail!)).map((variant) => variant.variantId)
      : [];
    return { metric, analysis: "intention_to_treat" as const, variants, guardrailBreaches };
  });
}
