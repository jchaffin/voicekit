import {
  useEffect,
  useId,
  useMemo,
  useState,
  type ButtonHTMLAttributes,
  type FormEvent,
  type HTMLAttributes,
  type ReactNode,
} from 'react';
import {
  getExperimentAssignmentDeviation,
  useDelegation,
  useDelegationSelector,
  useExperiment,
  useExperimentSelector,
  type DelegationTask,
  type ExperimentAssignment,
  type ExperimentGuardrailState,
  type ExperimentStatus,
  type ExperimentVariant,
  type GuardrailStatus,
} from '@jchaffin/voicekit-react';

function classes(base: string, className?: string): string {
  return className ? `${base} ${className}` : base;
}

function displayStatus(status: string): string {
  return status.replaceAll('-', ' ');
}

export function ExperimentStatusRegion({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  const { status, pendingAction, error } = useExperiment();
  const message = error
    ? `Experiment action failed: ${error.message}`
    : pendingAction
      ? `${displayStatus(pendingAction)} in progress`
      : `Experiment is ${displayStatus(status)}`;
  return (
    <div
      {...props}
      className={classes('vk-live-region vk-experiment-status', className)}
      data-state={error ? 'error' : pendingAction ?? status}
      role={error ? 'alert' : 'status'}
      aria-live={error ? 'assertive' : 'polite'}
      aria-atomic="true"
    >
      {message}
    </div>
  );
}

export interface ExperimentOverviewProps extends HTMLAttributes<HTMLElement> {
  headingLevel?: 2 | 3 | 4;
}

export function ExperimentOverview({ headingLevel = 2, className, ...props }: ExperimentOverviewProps) {
  const { definition, status, assignments, exposures, outcomes } = useExperiment();
  const Heading = `h${headingLevel}` as const;
  return (
    <section {...props} className={classes('vk-card vk-experiment-overview', className)} data-state={status} aria-labelledby={`${definition.id}-overview-title`}>
      <div className="vk-card-header">
        <Heading id={`${definition.id}-overview-title`}>{definition.name}</Heading>
        <span className="vk-status-badge" data-state={status}>{displayStatus(status)}</span>
      </div>
      {definition.hypothesis && <p className="vk-muted">{definition.hypothesis}</p>}
      <dl className="vk-stat-list">
        <div><dt>Assignments</dt><dd>{assignments.length}</dd></div>
        <div><dt>Exposures</dt><dd>{exposures.length}</dd></div>
        <div><dt>Outcomes</dt><dd>{outcomes.length}</dd></div>
        <div><dt>Variants</dt><dd>{definition.variants.length}</dd></div>
      </dl>
    </section>
  );
}

export interface VariantTrafficEditorProps extends Omit<HTMLAttributes<HTMLFormElement>, 'onSubmit'> {
  submitLabel?: string;
  onSaved?: (variants: readonly ExperimentVariant[]) => void;
}

export function VariantTrafficEditor({
  submitLabel = 'Save traffic',
  onSaved,
  className,
  ...props
}: VariantTrafficEditorProps) {
  const { definition, updateVariants, pendingAction } = useExperiment();
  const [weights, setWeights] = useState<Record<string, string>>(
    () => Object.fromEntries(definition.variants.map(variant => [variant.id, String(variant.weight)])),
  );
  const [touched, setTouched] = useState(false);
  const errorId = useId();
  useEffect(() => {
    setWeights(Object.fromEntries(definition.variants.map(variant => [variant.id, String(variant.weight)])));
    setTouched(false);
  }, [definition.variants]);

  const total = definition.variants.reduce((sum, variant) => sum + (Number(weights[variant.id]) || 0), 0);
  const weightsValid = definition.variants.every(variant => {
    const weight = Number(weights[variant.id]);
    return Number.isFinite(weight) && weight >= 0 && weight <= 100;
  });
  const valid = weightsValid && Math.abs(total - 100) < 0.001;
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setTouched(true);
    if (!valid) return;
    const variants = definition.variants.map(variant => ({ ...variant, weight: Number(weights[variant.id]) }));
    void updateVariants(variants).then(() => onSaved?.(variants));
  };

  return (
    <form {...props} className={classes('vk-card vk-traffic-editor', className)} onSubmit={submit} noValidate>
      <fieldset disabled={pendingAction === 'update-variants'}>
        <legend>Variant traffic</legend>
        <div className="vk-traffic-fields">
          {definition.variants.map(variant => (
            <label key={variant.id} className="vk-field">
              <span className="vk-label">{variant.name}</span>
              <span className="vk-number-field">
                <input
                  type="number"
                  min="0"
                  max="100"
                  step="0.1"
                  value={weights[variant.id] ?? ''}
                  aria-describedby={errorId}
                  aria-invalid={touched && !valid}
                  onChange={event => { setWeights(current => ({ ...current, [variant.id]: event.currentTarget.value })); setTouched(true); }}
                />
                <span aria-hidden="true">%</span>
              </span>
            </label>
          ))}
        </div>
        <div className="vk-traffic-total" data-state={valid ? 'valid' : 'invalid'}>
          Total: <strong>{Number.isFinite(total) ? total : 0}%</strong>
        </div>
        <p id={errorId} className="vk-field-message" role={touched && !valid ? 'alert' : undefined}>
          {touched && !valid ? 'Traffic percentages must each be between 0 and 100 and total exactly 100.' : 'Traffic must total 100%.'}
        </p>
        <button className="vk-button" type="submit" disabled={!valid || pendingAction !== null} aria-busy={pendingAction === 'update-variants'}>
          {pendingAction === 'update-variants' ? 'Saving…' : submitLabel}
        </button>
      </fieldset>
    </form>
  );
}

type LifecycleAction = 'rollout' | 'pause' | 'promote' | 'rollback';

export interface ExperimentLifecycleControlsProps extends HTMLAttributes<HTMLDivElement> {
  confirmAction?: (action: LifecycleAction, variantId?: string) => boolean | Promise<boolean>;
  labels?: Partial<Record<LifecycleAction, ReactNode>>;
}

export function ExperimentLifecycleControls({
  confirmAction,
  labels,
  className,
  ...props
}: ExperimentLifecycleControlsProps) {
  const { definition, status, pendingAction, rollout, pause, promote, rollback } = useExperiment();
  const [confirmation, setConfirmation] = useState<LifecycleAction | null>(null);
  const [variantId, setVariantId] = useState(definition.variants[0]?.id ?? '');
  const confirmationId = useId();
  const run = async (action: LifecycleAction) => {
    if (confirmation !== action) {
      setConfirmation(action);
      return;
    }
    if (confirmAction && !await confirmAction(action, action === 'promote' ? variantId : undefined)) return;
    setConfirmation(null);
    if (action === 'rollout') await rollout();
    if (action === 'pause') await pause();
    if (action === 'promote') await promote(variantId);
    if (action === 'rollback') await rollback();
  };
  const button = (
    action: LifecycleAction,
    disabled: boolean,
    extraProps: ButtonHTMLAttributes<HTMLButtonElement> = {},
  ) => (
    <button
      {...extraProps}
      className={classes(`vk-button vk-lifecycle-${action}`, extraProps.className)}
      type="button"
      disabled={disabled || pendingAction !== null}
      aria-describedby={confirmation === action ? confirmationId : undefined}
      aria-pressed={confirmation === action}
      onClick={() => { void run(action); }}
    >
      {confirmation === action ? `Confirm ${displayStatus(action)}` : labels?.[action] ?? displayStatus(action)}
    </button>
  );
  return (
    <div {...props} className={classes('vk-lifecycle-controls', className)} role="group" aria-label={props['aria-label'] ?? 'Experiment lifecycle controls'}>
      {button('rollout', status !== 'draft' && status !== 'paused')}
      {button('pause', status !== 'running')}
      <label className="vk-field vk-promote-field">
        <span className="vk-label">Variant to promote</span>
        <select value={variantId} disabled={pendingAction !== null} onChange={event => setVariantId(event.currentTarget.value)}>
          {definition.variants.map(variant => <option key={variant.id} value={variant.id}>{variant.name}</option>)}
        </select>
      </label>
      {button('promote', !['running', 'paused'].includes(status) || !variantId)}
      {button('rollback', status !== 'running' && status !== 'paused' && status !== 'promoted')}
      <span id={confirmationId} className="vk-confirmation-message" role="status" aria-live="polite">
        {confirmation ? `Press confirm ${displayStatus(confirmation)} again to continue, or choose another action to cancel.` : ''}
      </span>
    </div>
  );
}

export interface ExposureFunnelProps extends HTMLAttributes<HTMLOListElement> {
  assignmentLabel?: string;
  exposureLabel?: string;
  outcomeLabel?: string;
}

export function ExposureFunnel({
  assignmentLabel = 'Assigned',
  exposureLabel = 'Exposed',
  outcomeLabel = 'Outcome recorded',
  className,
  ...props
}: ExposureFunnelProps) {
  const { assignments, exposures, outcomes } = useExperiment();
  const steps = [
    { label: assignmentLabel, count: new Set(assignments.map(item => item.subjectId)).size },
    { label: exposureLabel, count: new Set(exposures.map(item => item.subjectId)).size },
    { label: outcomeLabel, count: new Set(outcomes.map(item => item.subjectId)).size },
  ];
  const maximum = Math.max(1, ...steps.map(step => step.count));
  return (
    <ol {...props} className={classes('vk-funnel', className)} aria-label={props['aria-label'] ?? 'Experiment exposure funnel'}>
      {steps.map(step => (
        <li key={step.label}>
          <div className="vk-funnel-label"><span>{step.label}</span><strong>{step.count}</strong></div>
          <div className="vk-semantic-bar" aria-hidden="true"><span style={{ width: `${(step.count / maximum) * 100}%` }} /></div>
        </li>
      ))}
    </ol>
  );
}

export interface MetricCardProps extends HTMLAttributes<HTMLElement> {
  name: string;
  value: number | string;
  unit?: string;
  change?: number;
  goal?: 'increase' | 'decrease';
  sampleSize?: number;
}

export function MetricCard({ name, value, unit, change, goal, sampleSize, className, ...props }: MetricCardProps) {
  const favorable = change === undefined || goal === undefined ? undefined : goal === 'increase' ? change >= 0 : change <= 0;
  return (
    <article {...props} className={classes('vk-card vk-metric-card', className)} data-state={favorable === undefined ? 'neutral' : favorable ? 'favorable' : 'unfavorable'}>
      <h3>{name}</h3>
      <p className="vk-metric-value">{value}{unit && <span> {unit}</span>}</p>
      {change !== undefined && <p><span className="vk-visually-hidden">Change: </span>{change > 0 ? '+' : ''}{change}%</p>}
      {sampleSize !== undefined && <p className="vk-muted">n={sampleSize}</p>}
    </article>
  );
}

export interface GuardrailCardProps extends HTMLAttributes<HTMLElement> {
  name: string;
  guardrail: ExperimentGuardrailState;
  threshold?: ReactNode;
}

export function GuardrailCard({ name, guardrail, threshold, className, ...props }: GuardrailCardProps) {
  const labels: Record<GuardrailStatus, string> = {
    unknown: 'Not measured',
    healthy: 'Healthy',
    warning: 'Warning',
    breached: 'Breached',
  };
  return (
    <article {...props} className={classes('vk-card vk-guardrail-card', className)} data-state={guardrail.status}>
      <div className="vk-card-header"><h3>{name}</h3><span className="vk-status-badge" data-state={guardrail.status}>{labels[guardrail.status]}</span></div>
      {guardrail.value !== undefined && <p className="vk-metric-value">{guardrail.value}</p>}
      {threshold && <p className="vk-muted">Threshold: {threshold}</p>}
      {guardrail.message && <p role={guardrail.status === 'breached' ? 'alert' : undefined}>{guardrail.message}</p>}
    </article>
  );
}

export interface AssignmentDetailProps extends HTMLAttributes<HTMLElement> {
  assignment: ExperimentAssignment;
}

export function AssignmentDetail({ assignment, className, ...props }: AssignmentDetailProps) {
  const variants = useExperimentSelector(state => state.definition.variants);
  const variant = variants.find(item => item.id === assignment.variantId);
  const expected = variants.find(item => item.id === assignment.expectedVariantId);
  const deviated = getExperimentAssignmentDeviation(assignment);
  return (
    <article {...props} className={classes('vk-card vk-assignment-detail', className)} data-state={deviated ? 'deviated' : 'assigned'}>
      <div className="vk-card-header">
        <h3>Assignment</h3>
        <span className="vk-status-badge" data-state={deviated ? 'warning' : 'healthy'}>{deviated ? 'Deviation' : 'Expected'}</span>
      </div>
      <dl>
        <div><dt>Subject</dt><dd>{assignment.subjectId}</dd></div>
        <div><dt>Assigned variant</dt><dd>{variant?.name ?? assignment.variantId}</dd></div>
        {assignment.expectedVariantId && <div><dt>Expected variant</dt><dd>{expected?.name ?? assignment.expectedVariantId}</dd></div>}
        <div><dt>Assigned at</dt><dd><time dateTime={assignment.assignedAt}>{new Date(assignment.assignedAt).toLocaleString()}</time></dd></div>
      </dl>
      {deviated && <p role="status">This assignment differs from the expected routing decision.</p>}
      {assignment.reason && <p className="vk-muted">{assignment.reason}</p>}
    </article>
  );
}

export type ProviderRoutingMode = 'direct' | 'fallback' | 'shadow' | 'experiment' | 'delegated';

export interface ProviderRoutingModeBadgeProps extends HTMLAttributes<HTMLSpanElement> {
  mode: ProviderRoutingMode;
  provider?: string;
}

export function ProviderRoutingModeBadge({ mode, provider, className, ...props }: ProviderRoutingModeBadgeProps) {
  return (
    <span {...props} className={classes('vk-routing-badge', className)} data-state={mode} aria-label={`Provider routing: ${displayStatus(mode)}${provider ? ` via ${provider}` : ''}`}>
      <span aria-hidden="true" className="vk-routing-dot" />
      {displayStatus(mode)}{provider ? ` · ${provider}` : ''}
    </span>
  );
}

export function DelegationLiveRegion({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  const { conversationStatus, listening, speaking, tasks, error } = useDelegation();
  const activeTasks = tasks.filter(task => task.status === 'queued' || task.status === 'running' || task.status === 'cancelling').length;
  const channels = [listening ? 'listening' : '', speaking ? 'speaking' : ''].filter(Boolean).join(' and ');
  return (
    <div
      {...props}
      className={classes('vk-live-region vk-delegation-status', className)}
      role={error ? 'alert' : 'status'}
      aria-live={error ? 'assertive' : 'polite'}
      aria-atomic="true"
      data-state={error ? 'error' : conversationStatus}
    >
      {error ? `Delegation failed: ${error.message}` : `Conversation ${displayStatus(conversationStatus)}${channels ? `, ${channels}` : ''}. ${activeTasks} active ${activeTasks === 1 ? 'task' : 'tasks'}.`}
    </div>
  );
}

export interface DelegationTaskCardProps extends HTMLAttributes<HTMLElement> {
  task: DelegationTask;
  showCancel?: boolean;
}

export function DelegationTaskCard({ task, showCancel = true, className, ...props }: DelegationTaskCardProps) {
  const cancelTask = useDelegationSelector(state => state.cancelTask);
  const cancellable = task.status === 'queued' || task.status === 'running';
  return (
    <article {...props} className={classes('vk-card vk-delegation-task', className)} data-state={task.status}>
      <div className="vk-card-header">
        <h3>{task.title}</h3>
        <span className="vk-status-badge" data-state={task.status}>{displayStatus(task.status)}</span>
      </div>
      {task.backend && <p className="vk-muted">Backend: {task.backend}</p>}
      {task.detail && <p>{task.detail}</p>}
      {task.error && <p role="alert">{task.error}</p>}
      {showCancel && cancellable && (
        <button className="vk-button" type="button" onClick={() => { void cancelTask(task.id); }}>Cancel task</button>
      )}
    </article>
  );
}

export interface DelegationTimelineProps extends HTMLAttributes<HTMLOListElement> {
  limit?: number;
  empty?: ReactNode;
}

export function DelegationTimeline({ limit = 50, empty = 'No delegation activity yet.', className, ...props }: DelegationTimelineProps) {
  const timeline = useDelegationSelector(state => state.timeline);
  const events = useMemo(() => timeline.slice(-limit), [timeline, limit]);
  return (
    <ol {...props} className={classes('vk-delegation-timeline', className)} aria-label={props['aria-label'] ?? 'Delegation timeline'} aria-live="polite">
      {events.length === 0
        ? <li className="vk-muted">{empty}</li>
        : events.map(event => (
          <li key={event.id} data-event={event.type} data-state={event.status}>
            <time dateTime={event.timestamp}>{new Date(event.timestamp).toLocaleTimeString()}</time>
            <span>{event.label}</span>
          </li>
        ))}
    </ol>
  );
}
