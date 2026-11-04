import type { EventEnvelope, JsonValue, SessionPhase, VoiceKitEvent } from '@jchaffin/voicekit-protocol';

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'disconnecting' | 'error';
export type Participant = 'user' | 'agent';

export interface TranscriptEntry {
  id: string;
  turnId: string;
  role: Participant;
  text: string;
  isFinal: boolean;
  timestamp: string;
}

export interface ToolApproval {
  callId: string;
  name: string;
  arguments: JsonValue;
  status: 'pending' | 'approved' | 'rejected' | 'completed' | 'failed';
}

export interface HandoffState {
  id: string;
  target: string;
  status: 'requested' | 'accepted' | 'completed' | 'failed';
  reason?: string;
}

export interface ConnectionQualityState {
  level: 'unknown' | 'excellent' | 'good' | 'poor' | 'lost';
  latencyMs?: number;
  packetLoss?: number;
  jitterMs?: number;
}

export interface VoiceSessionError {
  code: string;
  message: string;
  retryable: boolean;
  fatal: boolean;
}

export interface VoiceSessionTransport {
  subscribe(listener: (event: EventEnvelope) => void): () => void;
  connect(): void | Promise<void>;
  disconnect(): void | Promise<void>;
  setMuted(muted: boolean): void | Promise<void>;
  interrupt(): void | Promise<void>;
  sendText(text: string): void | Promise<void>;
  setInputDevice?(deviceId: string): void | Promise<void>;
  resolveToolApproval?(callId: string, approved: boolean): void | Promise<void>;
}

export interface VoiceSessionState {
  status: ConnectionStatus;
  phase: SessionPhase;
  muted: boolean;
  devices: readonly MediaDeviceInfo[];
  selectedDeviceId: string | null;
  transcript: readonly TranscriptEntry[];
  approvals: readonly ToolApproval[];
  handoff: HandoffState | null;
  quality: ConnectionQualityState;
  errors: readonly VoiceSessionError[];
  events: readonly EventEnvelope[];
  speaking: boolean;
  listening: boolean;
}

export interface VoiceSessionActions {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  mute(muted?: boolean): Promise<void>;
  interrupt(): Promise<void>;
  sendText(text: string): Promise<void>;
  refreshDevices(): Promise<void>;
  selectDevice(deviceId: string): Promise<void>;
  approve(callId: string): Promise<void>;
  reject(callId: string): Promise<void>;
  clearErrors(): void;
}

export type VoiceSessionSnapshot = VoiceSessionState & VoiceSessionActions;

export interface VoiceSessionStoreOptions {
  maxEvents?: number;
  requiresApproval?: (event: Extract<VoiceKitEvent, { type: 'tool.call_started' }>) => boolean;
}

const INITIAL_STATE: VoiceSessionState = {
  status: 'disconnected',
  phase: 'created',
  muted: false,
  devices: [],
  selectedDeviceId: null,
  transcript: [],
  approvals: [],
  handoff: null,
  quality: { level: 'unknown' },
  errors: [],
  events: [],
  speaking: false,
  listening: false,
};

function errorFrom(value: unknown): VoiceSessionError {
  return {
    code: 'CLIENT_ERROR',
    message: value instanceof Error ? value.message : String(value),
    retryable: true,
    fatal: false,
  };
}

export class VoiceSessionStore {
  private state: VoiceSessionState = INITIAL_STATE;
  private snapshot: VoiceSessionSnapshot;
  private readonly serverSnapshot: VoiceSessionSnapshot;
  private readonly listeners = new Set<() => void>();
  private unsubscribeTransport: (() => void) | undefined;
  private readonly turns = new Map<string, Participant>();
  private readonly actions: VoiceSessionActions;

  constructor(
    private readonly transport: VoiceSessionTransport,
    private readonly options: VoiceSessionStoreOptions = {},
  ) {
    this.actions = {
      connect: () => this.connect(),
      disconnect: () => this.disconnect(),
      mute: value => this.mute(value),
      interrupt: () => this.run(() => this.transport.interrupt()),
      sendText: text => this.sendText(text),
      refreshDevices: () => this.refreshDevices(),
      selectDevice: id => this.selectDevice(id),
      approve: id => this.resolveApproval(id, true),
      reject: id => this.resolveApproval(id, false),
      clearErrors: () => this.patch({ errors: [] }),
    };
    this.snapshot = Object.assign({}, this.state, this.actions);
    this.serverSnapshot = Object.assign({}, INITIAL_STATE, this.actions);
  }

  getSnapshot = (): VoiceSessionSnapshot => this.snapshot;
  getServerSnapshot = (): VoiceSessionSnapshot => this.serverSnapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  destroy(): void {
    this.unsubscribeTransport?.();
    this.unsubscribeTransport = undefined;
    this.listeners.clear();
  }

  ingest = (envelope: EventEnvelope): void => {
    const maxEvents = this.options.maxEvents ?? 200;
    const events = [...this.state.events, envelope].slice(-maxEvents);
    this.reduceEvent(envelope);
    this.patch({ events });
  };

  private patch(patch: Partial<VoiceSessionState>): void {
    this.state = { ...this.state, ...patch };
    this.snapshot = Object.assign({}, this.state, this.actions);
    this.listeners.forEach(listener => listener());
  }

  private async run(operation: () => void | Promise<void>): Promise<void> {
    try {
      await operation();
    } catch (error) {
      this.patch({ errors: [...this.state.errors, errorFrom(error)] });
      throw error;
    }
  }

  private async connect(): Promise<void> {
    if (this.state.status === 'connected' || this.state.status === 'connecting') return;
    this.patch({ status: 'connecting' });
    this.unsubscribeTransport ??= this.transport.subscribe(this.ingest);
    try {
      await this.transport.connect();
    } catch (error) {
      this.patch({ status: 'error', errors: [...this.state.errors, errorFrom(error)] });
      throw error;
    }
  }

  private async disconnect(): Promise<void> {
    if (this.state.status === 'disconnected' || this.state.status === 'disconnecting') return;
    this.patch({ status: 'disconnecting' });
    await this.run(() => this.transport.disconnect());
    this.unsubscribeTransport?.();
    this.unsubscribeTransport = undefined;
    this.patch({ status: 'disconnected', phase: 'closed', speaking: false, listening: false });
  }

  private async mute(value = !this.state.muted): Promise<void> {
    await this.run(() => this.transport.setMuted(value));
    this.patch({ muted: value });
  }

  private async sendText(text: string): Promise<void> {
    const normalized = text.trim();
    if (!normalized) return;
    await this.run(() => this.transport.sendText(normalized));
  }

  private async refreshDevices(): Promise<void> {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) return;
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter(device => device.kind === 'audioinput');
    this.patch({ devices });
  }

  private async selectDevice(deviceId: string): Promise<void> {
    await this.run(() => this.transport.setInputDevice?.(deviceId));
    this.patch({ selectedDeviceId: deviceId });
  }

  private async resolveApproval(callId: string, approved: boolean): Promise<void> {
    await this.run(() => this.transport.resolveToolApproval?.(callId, approved));
    this.patch({
      approvals: this.state.approvals.map(item =>
        item.callId === callId ? { ...item, status: approved ? 'approved' : 'rejected' } : item,
      ),
    });
  }

  private reduceEvent(envelope: EventEnvelope): void {
    const event = envelope.event;
    switch (event.type) {
      case 'lifecycle.phase_changed': {
        const connected = !['created', 'provisioning', 'connecting', 'closed', 'failed'].includes(event.data.to);
        this.patch({
          phase: event.data.to,
          status: event.data.to === 'failed' ? 'error' : event.data.to === 'reconnecting' ? 'reconnecting' : connected ? 'connected' : event.data.to === 'closed' ? 'disconnected' : 'connecting',
          speaking: event.data.to === 'speaking',
          listening: event.data.to === 'listening',
        });
        break;
      }
      case 'lifecycle.session_closed':
        this.patch({ status: 'disconnected', phase: 'closed', speaking: false, listening: false });
        break;
      case 'turn.started':
        this.turns.set(event.data.turnId, event.data.participant);
        break;
      case 'transcript.partial':
      case 'transcript.final': {
        const isFinal = event.type === 'transcript.final';
        const existing = this.state.transcript.find(item => item.turnId === event.data.turnId && !item.isFinal);
        const entry: TranscriptEntry = {
          id: existing?.id ?? `${envelope.id}:${event.data.turnId}`,
          turnId: event.data.turnId,
          role: this.turns.get(event.data.turnId) ?? 'user',
          text: event.data.text,
          isFinal,
          timestamp: envelope.timestamp,
        };
        this.patch({
          transcript: existing
            ? this.state.transcript.map(item => item.id === existing.id ? entry : item)
            : [...this.state.transcript, entry],
        });
        break;
      }
      case 'tool.call_started':
        if (this.options.requiresApproval?.(event) ?? true) {
          this.patch({ approvals: [...this.state.approvals, { ...event.data, status: 'pending' }] });
        }
        break;
      case 'tool.call_completed':
      case 'tool.call_failed':
        this.patch({
          approvals: this.state.approvals.map(item =>
            item.callId === event.data.callId
              ? { ...item, status: event.type === 'tool.call_completed' ? 'completed' : 'failed' }
              : item,
          ),
        });
        break;
      case 'handoff.requested':
        this.patch({ handoff: { id: event.data.handoffId, target: event.data.target, status: 'requested', ...(event.data.reason ? { reason: event.data.reason } : {}) } });
        break;
      case 'handoff.accepted':
      case 'handoff.completed':
      case 'handoff.failed':
        this.patch({ handoff: { id: event.data.handoffId, target: event.data.target, status: event.type.split('.')[1] as HandoffState['status'] } });
        break;
      case 'error.occurred':
        this.patch({ errors: [...this.state.errors, { code: event.data.code, message: event.data.message, retryable: event.data.retryable, fatal: event.data.fatal }] });
        break;
      case 'provider.raw':
        this.reduceProviderData(event.data.payload);
        break;
    }
  }

  private reduceProviderData(payload: JsonValue): void {
    if (!payload || Array.isArray(payload) || typeof payload !== 'object') return;
    if (payload.kind !== 'connection_quality') return;
    const level = payload.level;
    if (level !== 'excellent' && level !== 'good' && level !== 'poor' && level !== 'lost' && level !== 'unknown') return;
    this.patch({
      quality: {
        level,
        ...(typeof payload.latencyMs === 'number' ? { latencyMs: payload.latencyMs } : {}),
        ...(typeof payload.packetLoss === 'number' ? { packetLoss: payload.packetLoss } : {}),
        ...(typeof payload.jitterMs === 'number' ? { jitterMs: payload.jitterMs } : {}),
      },
    });
  }
}

export function createVoiceSessionStore(
  transport: VoiceSessionTransport,
  options?: VoiceSessionStoreOptions,
): VoiceSessionStore {
  return new VoiceSessionStore(transport, options);
}
