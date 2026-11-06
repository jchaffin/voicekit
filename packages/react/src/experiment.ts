export type ExperimentStatus = 'draft' | 'running' | 'paused' | 'promoted' | 'rolled-back' | 'completed';
export type GuardrailStatus = 'unknown' | 'healthy' | 'warning' | 'breached';

export interface ExperimentVariant {
  id: string;
  name: string;
  weight: number;
  description?: string;
  provider?: string;
}

export interface ExperimentMetricDefinition {
  id: string;
  name: string;
  unit?: string;
  goal?: 'increase' | 'decrease';
}

export interface ExperimentGuardrailDefinition {
  id: string;
  name: string;
  threshold: number;
  operator: 'lt' | 'lte' | 'gt' | 'gte';
  unit?: string;
}

export interface ExperimentDefinition {
  id: string;
  name: string;
  hypothesis?: string;
  variants: readonly ExperimentVariant[];
  metrics?: readonly ExperimentMetricDefinition[];
  guardrails?: readonly ExperimentGuardrailDefinition[];
}

export interface ExperimentAssignment {
  subjectId: string;
  variantId: string;
  assignedAt: string;
  expectedVariantId?: string;
  reason?: string;
}

export interface ExperimentExposure {
  id: string;
  subjectId: string;
  variantId: string;
  timestamp: string;
}

export interface ExperimentOutcome {
  id: string;
  subjectId: string;
  variantId: string;
  metricId: string;
  value: number;
  timestamp: string;
}

export interface ExperimentGuardrailState {
  id: string;
  value?: number;
  status: GuardrailStatus;
  message?: string;
}

export interface ExperimentAdapter {
  rollout?(definition: ExperimentDefinition): void | Promise<void>;
  pause?(experimentId: string): void | Promise<void>;
  promote?(experimentId: string, variantId: string): void | Promise<void>;
  rollback?(experimentId: string): void | Promise<void>;
  updateVariants?(experimentId: string, variants: readonly ExperimentVariant[]): void | Promise<void>;
  recordAssignment?(experimentId: string, assignment: ExperimentAssignment): void | Promise<void>;
  recordExposure?(experimentId: string, exposure: ExperimentExposure): void | Promise<void>;
  recordOutcome?(experimentId: string, outcome: ExperimentOutcome): void | Promise<void>;
}

export interface ExperimentState {
  definition: ExperimentDefinition;
  status: ExperimentStatus;
  assignments: readonly ExperimentAssignment[];
  exposures: readonly ExperimentExposure[];
  outcomes: readonly ExperimentOutcome[];
  guardrails: readonly ExperimentGuardrailState[];
  promotedVariantId: string | null;
  pendingAction: ExperimentAction | null;
  error: Error | null;
}

export type ExperimentAction = 'rollout' | 'pause' | 'promote' | 'rollback' | 'update-variants';

export interface ExperimentActions {
  rollout(): Promise<void>;
  pause(): Promise<void>;
  promote(variantId: string): Promise<void>;
  rollback(): Promise<void>;
  updateVariants(variants: readonly ExperimentVariant[]): Promise<void>;
  recordAssignment(assignment: ExperimentAssignment): Promise<void>;
  recordExposure(exposure: ExperimentExposure): Promise<void>;
  recordOutcome(outcome: ExperimentOutcome): Promise<void>;
  setGuardrails(guardrails: readonly ExperimentGuardrailState[]): void;
  clearError(): void;
}

export type ExperimentSnapshot = ExperimentState & ExperimentActions;

export interface ExperimentStoreOptions {
  status?: ExperimentStatus;
  adapter?: ExperimentAdapter;
  assignments?: readonly ExperimentAssignment[];
  exposures?: readonly ExperimentExposure[];
  outcomes?: readonly ExperimentOutcome[];
  guardrails?: readonly ExperimentGuardrailState[];
}

function validateVariants(variants: readonly ExperimentVariant[]): void {
  if (variants.length === 0) throw new Error('An experiment requires at least one variant.');
  if (variants.some(variant => !Number.isFinite(variant.weight) || variant.weight < 0 || variant.weight > 100)) {
    throw new Error('Variant weights must be between 0 and 100.');
  }
  const total = variants.reduce((sum, variant) => sum + variant.weight, 0);
  if (Math.abs(total - 100) > 0.001) throw new Error(`Variant weights must total 100; received ${total}.`);
  if (new Set(variants.map(variant => variant.id)).size !== variants.length) {
    throw new Error('Variant IDs must be unique.');
  }
}

export class ExperimentStore {
  private state: ExperimentState;
  private snapshot: ExperimentSnapshot;
  private readonly serverSnapshot: ExperimentSnapshot;
  private readonly listeners = new Set<() => void>();
  private readonly adapter: ExperimentAdapter;
  private readonly actions: ExperimentActions;

  constructor(definition: ExperimentDefinition, options: ExperimentStoreOptions = {}) {
    validateVariants(definition.variants);
    this.adapter = options.adapter ?? {};
    this.actions = {
      rollout: () => this.transition('rollout', 'running', () => this.adapter.rollout?.(this.state.definition)),
      pause: () => this.transition('pause', 'paused', () => this.adapter.pause?.(this.state.definition.id)),
      promote: variantId => this.promote(variantId),
      rollback: () => this.transition('rollback', 'rolled-back', () => this.adapter.rollback?.(this.state.definition.id)),
      updateVariants: variants => this.updateVariants(variants),
      recordAssignment: assignment => this.recordAssignment(assignment),
      recordExposure: exposure => this.recordExposure(exposure),
      recordOutcome: outcome => this.recordOutcome(outcome),
      setGuardrails: guardrails => this.patch({ guardrails: [...guardrails] }),
      clearError: () => this.patch({ error: null }),
    };
    this.state = {
      definition,
      status: options.status ?? 'draft',
      assignments: options.assignments ?? [],
      exposures: options.exposures ?? [],
      outcomes: options.outcomes ?? [],
      guardrails: options.guardrails ?? [],
      promotedVariantId: null,
      pendingAction: null,
      error: null,
    };
    this.snapshot = Object.assign({}, this.state, this.actions);
    this.serverSnapshot = this.snapshot;
  }

  getSnapshot = (): ExperimentSnapshot => this.snapshot;
  getServerSnapshot = (): ExperimentSnapshot => this.serverSnapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  destroy(): void { this.listeners.clear(); }

  private patch(patch: Partial<ExperimentState>): void {
    this.state = { ...this.state, ...patch };
    this.snapshot = Object.assign({}, this.state, this.actions);
    this.listeners.forEach(listener => listener());
  }

  private async transition(
    action: ExperimentAction,
    status: ExperimentStatus,
    operation: () => void | Promise<void>,
  ): Promise<void> {
    if (this.state.pendingAction) return;
    this.patch({ pendingAction: action, error: null });
    try {
      await operation();
      this.patch({ status, pendingAction: null });
    } catch (error) {
      this.patch({ pendingAction: null, error: error instanceof Error ? error : new Error(String(error)) });
      throw error;
    }
  }

  private async promote(variantId: string): Promise<void> {
    if (!this.state.definition.variants.some(variant => variant.id === variantId)) {
      throw new Error(`Unknown experiment variant: ${variantId}`);
    }
    await this.transition('promote', 'promoted', () => this.adapter.promote?.(this.state.definition.id, variantId));
    this.patch({ promotedVariantId: variantId });
  }

  private async updateVariants(variants: readonly ExperimentVariant[]): Promise<void> {
    validateVariants(variants);
    await this.transition(
      'update-variants',
      this.state.status,
      () => this.adapter.updateVariants?.(this.state.definition.id, variants),
    );
    this.patch({ definition: { ...this.state.definition, variants: [...variants] } });
  }

  private async recordAssignment(assignment: ExperimentAssignment): Promise<void> {
    await this.adapter.recordAssignment?.(this.state.definition.id, assignment);
    const assignments = this.state.assignments.filter(item => item.subjectId !== assignment.subjectId);
    this.patch({ assignments: [...assignments, assignment] });
  }

  private async recordExposure(exposure: ExperimentExposure): Promise<void> {
    await this.adapter.recordExposure?.(this.state.definition.id, exposure);
    if (!this.state.exposures.some(item => item.id === exposure.id)) {
      this.patch({ exposures: [...this.state.exposures, exposure] });
    }
  }

  private async recordOutcome(outcome: ExperimentOutcome): Promise<void> {
    await this.adapter.recordOutcome?.(this.state.definition.id, outcome);
    if (!this.state.outcomes.some(item => item.id === outcome.id)) {
      this.patch({ outcomes: [...this.state.outcomes, outcome] });
    }
  }
}

export function createExperimentStore(
  definition: ExperimentDefinition,
  options?: ExperimentStoreOptions,
): ExperimentStore {
  return new ExperimentStore(definition, options);
}

export function getExperimentAssignmentDeviation(assignment: ExperimentAssignment): boolean {
  return assignment.expectedVariantId !== undefined && assignment.expectedVariantId !== assignment.variantId;
}
