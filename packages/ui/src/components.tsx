import {
  Component,
  useId,
  useState,
  type ButtonHTMLAttributes,
  type ComponentPropsWithoutRef,
  type CSSProperties,
  type ErrorInfo,
  type FormEvent,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
} from 'react';
import {
  VoiceSessionProvider,
  useVoiceSelector,
  useVoiceSession,
  type VoiceSessionProviderProps,
} from '@jchaffin/voicekit-react';

function classes(base: string, className?: string): string {
  return className ? `${base} ${className}` : base;
}

export interface VoiceSessionShellProps extends VoiceSessionProviderProps, Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  children: ReactNode;
}

export function VoiceSessionShell({ transport, options, children, className, ...props }: VoiceSessionShellProps) {
  return (
    <VoiceSessionProvider transport={transport} {...(options ? { options } : {})}>
      <div {...props} className={classes('vk-shell', className)} data-voicekit="">
        {children}
      </div>
    </VoiceSessionProvider>
  );
}

export function VoiceConnectButton({ className, children, disabled, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  const { status, connect } = useVoiceSession();
  const busy = status === 'connecting' || status === 'reconnecting';
  return (
    <button
      type="button"
      {...props}
      className={classes('vk-button vk-connect-button', className)}
      data-state={status}
      disabled={disabled || busy || status === 'connected'}
      aria-busy={busy}
      onClick={event => { props.onClick?.(event); if (!event.defaultPrevented) void connect(); }}
    >
      {children ?? (busy ? 'Connecting…' : 'Connect')}
    </button>
  );
}

export function EndCallButton({ className, children, disabled, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  const { status, disconnect } = useVoiceSession();
  const busy = status === 'disconnecting';
  return (
    <button
      type="button"
      {...props}
      className={classes('vk-button vk-end-button', className)}
      data-state={status}
      disabled={disabled || busy || status === 'disconnected'}
      aria-busy={busy}
      onClick={event => { props.onClick?.(event); if (!event.defaultPrevented) void disconnect(); }}
    >
      {children ?? (busy ? 'Ending…' : 'End call')}
    </button>
  );
}

export function MicrophoneToggle({ className, children, disabled, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  const { muted, mute, status } = useVoiceSession();
  return (
    <button
      type="button"
      {...props}
      className={classes('vk-button vk-microphone-toggle', className)}
      data-state={muted ? 'muted' : 'unmuted'}
      aria-pressed={muted}
      aria-label={props['aria-label'] ?? (muted ? 'Unmute microphone' : 'Mute microphone')}
      disabled={disabled || status !== 'connected'}
      onClick={event => { props.onClick?.(event); if (!event.defaultPrevented) void mute(); }}
    >
      {children ?? (muted ? 'Unmute' : 'Mute')}
    </button>
  );
}

export interface DevicePickerProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'children' | 'value' | 'onChange'> {
  label?: ReactNode;
}

export function DevicePicker({ className, label = 'Microphone', ...props }: DevicePickerProps) {
  const { devices, selectedDeviceId, selectDevice, refreshDevices } = useVoiceSession();
  const id = useId();
  return (
    <label className="vk-field" htmlFor={id}>
      <span className="vk-label">{label}</span>
      <select
        {...props}
        id={id}
        className={classes('vk-device-picker', className)}
        data-state={devices.length ? 'ready' : 'empty'}
        value={selectedDeviceId ?? ''}
        onFocus={() => { void refreshDevices(); }}
        onChange={event => { void selectDevice(event.currentTarget.value); }}
      >
        <option value="" disabled>Select a microphone</option>
        {devices.map((device, index) => (
          <option key={device.deviceId} value={device.deviceId}>
            {device.label || `Microphone ${index + 1}`}
          </option>
        ))}
      </select>
    </label>
  );
}

export interface AgentStatusProps extends HTMLAttributes<HTMLDivElement> {
  labels?: Partial<Record<ReturnType<typeof useVoiceSession>['phase'], string>>;
}

export function AgentStatus({ className, labels, ...props }: AgentStatusProps) {
  const phase = useVoiceSelector(state => state.phase);
  return (
    <div {...props} className={classes('vk-agent-status', className)} data-state={phase} role="status" aria-live="polite">
      {labels?.[phase] ?? phase.replace('-', ' ')}
    </div>
  );
}

export interface TranscriptProps extends HTMLAttributes<HTMLOListElement> {
  empty?: ReactNode;
}

export function Transcript({ className, empty = 'No transcript yet.', ...props }: TranscriptProps) {
  const transcript = useVoiceSelector(state => state.transcript);
  return (
    <ol {...props} className={classes('vk-transcript', className)} data-state={transcript.length ? 'populated' : 'empty'} aria-live="polite" aria-label={props['aria-label'] ?? 'Conversation transcript'}>
      {transcript.length === 0
        ? <li className="vk-transcript-empty">{empty}</li>
        : transcript.map(item => (
          <li key={item.id} className="vk-transcript-entry" data-role={item.role} data-state={item.isFinal ? 'final' : 'partial'}>
            <span className="vk-visually-hidden">{item.role === 'agent' ? 'Agent' : 'You'}: </span>
            {item.text}
          </li>
        ))}
    </ol>
  );
}

export interface AudioVisualizerProps extends HTMLAttributes<HTMLDivElement> {
  levels?: readonly number[];
  barCount?: number;
}

export function AudioVisualizer({ levels, barCount = 12, className, ...props }: AudioVisualizerProps) {
  const speaking = useVoiceSelector(state => state.speaking);
  const values = Array.from({ length: barCount }, (_, index) => Math.max(0.08, Math.min(1, levels?.[index] ?? (speaking ? 0.5 : 0.08))));
  return (
    <div {...props} className={classes('vk-visualizer', className)} data-state={speaking ? 'active' : 'idle'} role="img" aria-label={props['aria-label'] ?? (speaking ? 'Agent is speaking' : 'Audio is idle')}>
      {values.map((level, index) => <span key={index} className="vk-visualizer-bar" style={{ '--vk-level': level } as CSSProperties} />)}
    </div>
  );
}

export interface TextInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'onSubmit'> {
  onSubmit?: (value: string) => void;
  submitLabel?: string;
}

export function TextInput({ className, onSubmit, submitLabel = 'Send', disabled, ...props }: TextInputProps) {
  const { sendText, status } = useVoiceSession();
  const [value, setValue] = useState('');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const text = value.trim();
    if (!text) return;
    onSubmit?.(text);
    void sendText(text);
    setValue('');
  };
  return (
    <form className="vk-text-form" onSubmit={submit}>
      <input {...props} className={classes('vk-text-input', className)} value={value} disabled={disabled || status !== 'connected'} onChange={event => setValue(event.currentTarget.value)} />
      <button className="vk-button vk-send-button" type="submit" disabled={disabled || status !== 'connected' || !value.trim()}>{submitLabel}</button>
    </form>
  );
}

export interface SuggestionChipsProps extends Omit<HTMLAttributes<HTMLDivElement>, 'onSelect'> {
  suggestions: readonly string[];
  onSelect?: (suggestion: string) => void;
}

export function SuggestionChips({ suggestions, onSelect, className, ...props }: SuggestionChipsProps) {
  const sendText = useVoiceSelector(state => state.sendText);
  return (
    <div {...props} className={classes('vk-suggestions', className)} data-state={suggestions.length ? 'visible' : 'empty'} role="group" aria-label={props['aria-label'] ?? 'Suggested responses'}>
      {suggestions.map(suggestion => (
        <button key={suggestion} className="vk-chip" type="button" onClick={() => { onSelect?.(suggestion); void sendText(suggestion); }}>
          {suggestion}
        </button>
      ))}
    </div>
  );
}

export interface ToolApprovalDialogProps extends Omit<ComponentPropsWithoutRef<'dialog'>, 'title'> {
  title?: ReactNode;
}

export function ToolApprovalDialog({ title = 'Approve tool action?', className, ...props }: ToolApprovalDialogProps) {
  const { approvals, approve, reject } = useVoiceSession();
  const pending = approvals.find(item => item.status === 'pending');
  if (!pending) return null;
  return (
    <dialog {...props} open className={classes('vk-approval-dialog', className)} data-state="open" aria-labelledby={`vk-tool-${pending.callId}`}>
      <h2 id={`vk-tool-${pending.callId}`}>{title}</h2>
      <p><strong>{pending.name}</strong> requested permission.</p>
      <pre className="vk-tool-arguments">{JSON.stringify(pending.arguments, null, 2)}</pre>
      <div className="vk-dialog-actions">
        <button className="vk-button" type="button" onClick={() => { void reject(pending.callId); }}>Reject</button>
        <button className="vk-button vk-approve-button" type="button" autoFocus onClick={() => { void approve(pending.callId); }}>Approve</button>
      </div>
    </dialog>
  );
}

export function HandoffNotice({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  const handoff = useVoiceSelector(state => state.handoff);
  if (!handoff) return null;
  return (
    <div {...props} className={classes('vk-handoff', className)} data-state={handoff.status} role="status" aria-live="polite">
      {handoff.status === 'completed' ? `Connected to ${handoff.target}.` : `Handoff to ${handoff.target}: ${handoff.status}.`}
    </div>
  );
}

export function ConnectionQuality({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  const quality = useVoiceSelector(state => state.quality);
  return (
    <div {...props} className={classes('vk-quality', className)} data-state={quality.level} role="status" aria-label={`Connection quality: ${quality.level}`}>
      <span aria-hidden="true" className="vk-quality-dot" />
      <span>{quality.level}</span>
      {quality.latencyMs !== undefined && <span className="vk-quality-latency">{quality.latencyMs} ms</span>}
    </div>
  );
}

export interface VoiceErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode | ((error: Error, reset: () => void) => ReactNode);
  onError?: (error: Error, info: ErrorInfo) => void;
}

interface VoiceErrorBoundaryState { error: Error | null }

export class VoiceErrorBoundary extends Component<VoiceErrorBoundaryProps, VoiceErrorBoundaryState> {
  state: VoiceErrorBoundaryState = { error: null };
  static getDerivedStateFromError(error: Error): VoiceErrorBoundaryState { return { error }; }
  componentDidCatch(error: Error, info: ErrorInfo): void { this.props.onError?.(error, info); }
  private reset = (): void => { this.setState({ error: null }); };
  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (typeof this.props.fallback === 'function') return this.props.fallback(error, this.reset);
    return this.props.fallback ?? (
      <div className="vk-error" data-state="error" role="alert">
        <p>{error.message}</p>
        <button className="vk-button" type="button" onClick={this.reset}>Try again</button>
      </div>
    );
  }
}

export interface EventTimelineProps extends HTMLAttributes<HTMLOListElement> {
  limit?: number;
}

export function EventTimeline({ limit = 50, className, ...props }: EventTimelineProps) {
  const events = useVoiceSelector(state => state.events);
  return (
    <ol {...props} className={classes('vk-event-timeline', className)} data-state={events.length ? 'populated' : 'empty'} aria-label={props['aria-label'] ?? 'Voice session event timeline'}>
      {events.slice(-limit).map(envelope => (
        <li key={envelope.id} data-event={envelope.event.type}>
          <time dateTime={envelope.timestamp}>{new Date(envelope.timestamp).toLocaleTimeString()}</time>
          <code>{envelope.event.type}</code>
        </li>
      ))}
    </ol>
  );
}

export interface OrbProps extends HTMLAttributes<HTMLDivElement> {
  label?: string;
}

export function Orb({ label, className, ...props }: OrbProps) {
  const { phase, speaking, listening } = useVoiceSession();
  const state = speaking ? 'speaking' : listening ? 'listening' : phase;
  return (
    <div {...props} className={classes('vk-orb', className)} data-state={state} role="img" aria-label={label ?? `Voice agent: ${state}`}>
      <span className="vk-orb-core" aria-hidden="true" />
    </div>
  );
}
