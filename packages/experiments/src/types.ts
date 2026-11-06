export type ExperimentStatus =
  | "draft"
  | "approved"
  | "running"
  | "paused"
  | "completed"
  | "rolled_back";

export type AssignmentUnitType = "user" | "account" | "organization" | "device" | "session" | (string & {});
export type RoutingOwner = "native" | "voicekit";
export type MetricKind = "binary" | "count" | "duration" | "currency";

export interface AssignmentUnit {
  readonly type: AssignmentUnitType;
  readonly id: string;
  readonly tenantId: string;
  readonly attributes?: Readonly<Record<string, string | number | boolean | null>>;
}

export type EligibilityPredicate =
  | { readonly op: "always" }
  | { readonly op: "eq" | "neq"; readonly attribute: string; readonly value: string | number | boolean | null }
  | { readonly op: "in" | "not_in"; readonly attribute: string; readonly values: readonly (string | number | boolean | null)[] }
  | { readonly op: "exists"; readonly attribute: string }
  | { readonly op: "and" | "or"; readonly predicates: readonly EligibilityPredicate[] }
  | { readonly op: "not"; readonly predicate: EligibilityPredicate };

export interface VariantManifest {
  readonly id: string;
  readonly weight: number;
  readonly control?: boolean;
  readonly description?: string;
  readonly routing: ProviderRouting;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface AllocationEpoch {
  readonly id: string;
  readonly startsAt: string;
  readonly allocation: number;
  readonly variantWeights?: Readonly<Record<string, number>>;
}

export interface Holdout {
  readonly allocation: number;
  readonly id?: string;
}

export interface ExperimentRevision {
  readonly experimentId: string;
  readonly revision: number;
  readonly status: ExperimentStatus;
  readonly salt: string;
  readonly assignmentUnitType: AssignmentUnitType;
  readonly eligibility: EligibilityPredicate;
  readonly variants: readonly VariantManifest[];
  readonly allocationEpochs: readonly AllocationEpoch[];
  readonly layerId?: string;
  readonly layerAllocation?: number;
  readonly holdout?: Holdout;
  readonly metrics: readonly MetricDefinition[];
  readonly createdAt: string;
  readonly createdBy: string;
  readonly approvedAt?: string;
  readonly approvedBy?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface Assignment {
  readonly experimentId: string;
  readonly revision: number;
  readonly tenantId: string;
  readonly unitType: AssignmentUnitType;
  readonly unitId: string;
  readonly variantId: string;
  readonly epochId: string;
  readonly assignedAt: string;
  readonly routingOwner: RoutingOwner;
  readonly layerId?: string;
  readonly reconnectOf?: string;
}

export type AssignmentDecision =
  | { readonly kind: "assigned"; readonly assignment: Assignment; readonly existing: boolean }
  | { readonly kind: "ineligible"; readonly reason: "predicate" | "unit_type" | "not_running" }
  | { readonly kind: "excluded"; readonly reason: "allocation" | "holdout" | "layer"; readonly epochId: string };

export interface AssignmentKey {
  readonly experimentId: string;
  readonly tenantId: string;
  readonly unitType: AssignmentUnitType;
  readonly unitId: string;
}

export interface LedgerEventBase {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly experimentId: string;
  readonly revision: number;
  readonly tenantId: string;
  readonly unitType: AssignmentUnitType;
  readonly unitId: string;
  readonly occurredAt: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface AssignmentLedgerEvent extends LedgerEventBase {
  readonly type: "assignment";
  readonly variantId: string;
  readonly epochId: string;
}

export interface ExposureLedgerEvent extends LedgerEventBase {
  readonly type: "exposure";
  readonly variantId: string;
  readonly sessionId?: string;
  readonly deviation?: RoutingDeviation;
}

export interface OutcomeLedgerEvent extends LedgerEventBase {
  readonly type: "outcome";
  readonly metricId: string;
  readonly value: number;
}

export type LedgerEvent = AssignmentLedgerEvent | ExposureLedgerEvent | OutcomeLedgerEvent;

export interface RoutingDeviation {
  readonly reason: "fallback" | "provider_unavailable" | "manual_override" | "routing_error";
  readonly intendedVariantId: string;
  readonly actualProvider?: ProviderRouting["provider"];
  readonly details?: string;
}

export interface MetricDefinition {
  readonly id: string;
  readonly kind: MetricKind;
  readonly role: "primary" | "secondary" | "guardrail";
  readonly unit?: string;
  readonly direction?: "increase" | "decrease";
  readonly guardrail?: {
    readonly threshold: number;
    readonly comparison: "gt" | "gte" | "lt" | "lte";
  };
}

export type ProviderRouting =
  | {
      readonly provider: "elevenagents";
      readonly branchId: string;
      readonly conversationConfigOverride?: Readonly<Record<string, unknown>>;
    }
  | {
      readonly provider: "livekit";
      readonly agentName: string;
      readonly deploymentId?: string;
      readonly metadata?: Readonly<Record<string, unknown>>;
    }
  | {
      readonly provider: "openai";
      readonly api: "gpt-live" | "realtime";
      readonly session: Readonly<Record<string, unknown>>;
    }
  | {
      readonly provider: "pipecat";
      readonly agent: string;
      readonly body?: Readonly<Record<string, unknown>>;
    };

export interface RoutingPayload {
  readonly provider: ProviderRouting["provider"];
  readonly payload: Readonly<Record<string, unknown>>;
  readonly assignment: Assignment;
}

export interface AuditRecord {
  readonly id: string;
  readonly experimentId: string;
  readonly revision: number;
  readonly actorId: string;
  readonly action: "create_revision" | "approve" | "start" | "pause" | "complete" | "rollback";
  readonly fromStatus?: ExperimentStatus;
  readonly toStatus: ExperimentStatus;
  readonly occurredAt: string;
  readonly reason?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ApprovalContext {
  readonly actorId: string;
  readonly roles: readonly string[];
  readonly reason?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ApprovalHook {
  authorize(input: {
    readonly action: AuditRecord["action"];
    readonly revision: ExperimentRevision;
    readonly context: ApprovalContext;
  }): boolean | Promise<boolean>;
}

export interface StoredRevision {
  readonly revision: ExperimentRevision;
  readonly fingerprint: string;
}
