export type DelegationConversationStatus = 'idle' | 'active' | 'cancelling' | 'cancelled' | 'completed' | 'failed';
export type DelegationTaskStatus = 'queued' | 'running' | 'cancelling' | 'cancelled' | 'completed' | 'failed';

export interface DelegationTask {
  id: string;
  title: string;
  status: DelegationTaskStatus;
  createdAt: string;
  updatedAt: string;
  backend?: string;
  detail?: string;
  error?: string;
}

export interface DelegationTimelineEvent {
  id: string;
  type: 'conversation' | 'listening' | 'speaking' | 'task';
  timestamp: string;
  label: string;
  taskId?: string;
  status?: DelegationConversationStatus | DelegationTaskStatus;
}

export interface DelegationTransport {
  startTask?(input: { id: string; title: string; backend?: string; detail?: string }): void | Promise<void>;
  cancelTask?(taskId: string): void | Promise<void>;
  cancelConversation?(): void | Promise<void>;
}

export interface DelegationState {
  conversationStatus: DelegationConversationStatus;
  listening: boolean;
  speaking: boolean;
  tasks: readonly DelegationTask[];
  timeline: readonly DelegationTimelineEvent[];
  error: Error | null;
}

export interface DelegationActions {
  startConversation(timestamp?: string): void;
  completeConversation(timestamp?: string): void;
  failConversation(error: unknown, timestamp?: string): void;
  setListening(active: boolean, timestamp?: string): void;
  setSpeaking(active: boolean, timestamp?: string): void;
  startTask(input: { id: string; title: string; backend?: string; detail?: string }, timestamp?: string): Promise<void>;
  updateTask(taskId: string, update: Partial<Pick<DelegationTask, 'status' | 'detail' | 'error'>>, timestamp?: string): void;
  cancelTask(taskId: string, timestamp?: string): Promise<void>;
  cancelConversation(timestamp?: string): Promise<void>;
  clearError(): void;
}

export type DelegationSnapshot = DelegationState & DelegationActions;

export interface DelegationStoreOptions {
  transport?: DelegationTransport;
  initialTasks?: readonly DelegationTask[];
  maxTimelineEvents?: number;
}

function now(timestamp?: string): string {
  return timestamp ?? new Date().toISOString();
}

export class DelegationStore {
  private state: DelegationState;
  private snapshot: DelegationSnapshot;
  private readonly serverSnapshot: DelegationSnapshot;
  private readonly listeners = new Set<() => void>();
  private readonly transport: DelegationTransport;
  private readonly maxTimelineEvents: number;
  private readonly actions: DelegationActions;

  constructor(options: DelegationStoreOptions = {}) {
    this.transport = options.transport ?? {};
    this.maxTimelineEvents = options.maxTimelineEvents ?? 200;
    this.actions = {
      startConversation: timestamp => this.setConversation('active', timestamp),
      completeConversation: timestamp => this.setConversation('completed', timestamp),
      failConversation: (error, timestamp) => this.failConversation(error, timestamp),
      setListening: (active, timestamp) => this.setRealtime('listening', active, timestamp),
      setSpeaking: (active, timestamp) => this.setRealtime('speaking', active, timestamp),
      startTask: (input, timestamp) => this.startTask(input, timestamp),
      updateTask: (taskId, update, timestamp) => this.updateTask(taskId, update, timestamp),
      cancelTask: (taskId, timestamp) => this.cancelTask(taskId, timestamp),
      cancelConversation: timestamp => this.cancelConversation(timestamp),
      clearError: () => this.patch({ error: null }),
    };
    this.state = {
      conversationStatus: 'idle',
      listening: false,
      speaking: false,
      tasks: options.initialTasks ?? [],
      timeline: [],
      error: null,
    };
    this.snapshot = Object.assign({}, this.state, this.actions);
    this.serverSnapshot = this.snapshot;
  }

  getSnapshot = (): DelegationSnapshot => this.snapshot;
  getServerSnapshot = (): DelegationSnapshot => this.serverSnapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  destroy(): void { this.listeners.clear(); }

  private patch(patch: Partial<DelegationState>): void {
    this.state = { ...this.state, ...patch };
    this.snapshot = Object.assign({}, this.state, this.actions);
    this.listeners.forEach(listener => listener());
  }

  private append(event: DelegationTimelineEvent): void {
    this.patch({ timeline: [...this.state.timeline, event].slice(-this.maxTimelineEvents) });
  }

  private setConversation(status: DelegationConversationStatus, timestamp?: string): void {
    const at = now(timestamp);
    this.patch({
      conversationStatus: status,
      ...(status === 'completed' || status === 'cancelled' || status === 'failed'
        ? { listening: false, speaking: false }
        : {}),
    });
    this.append({ id: `conversation:${at}:${status}`, type: 'conversation', timestamp: at, label: `Conversation ${status}`, status });
  }

  private failConversation(error: unknown, timestamp?: string): void {
    this.patch({ error: error instanceof Error ? error : new Error(String(error)) });
    this.setConversation('failed', timestamp);
  }

  private setRealtime(channel: 'listening' | 'speaking', active: boolean, timestamp?: string): void {
    if (this.state[channel] === active) return;
    const at = now(timestamp);
    this.patch({ [channel]: active });
    this.append({
      id: `${channel}:${at}:${active}`,
      type: channel,
      timestamp: at,
      label: `${channel === 'listening' ? 'Listening' : 'Speaking'} ${active ? 'started' : 'stopped'}`,
    });
  }

  private async startTask(
    input: { id: string; title: string; backend?: string; detail?: string },
    timestamp?: string,
  ): Promise<void> {
    if (this.state.tasks.some(task => task.id === input.id)) throw new Error(`Task already exists: ${input.id}`);
    const at = now(timestamp);
    const task: DelegationTask = { ...input, status: 'queued', createdAt: at, updatedAt: at };
    this.patch({ tasks: [...this.state.tasks, task], error: null });
    this.append({ id: `task:${input.id}:${at}:queued`, type: 'task', taskId: input.id, timestamp: at, label: `${input.title} queued`, status: 'queued' });
    try {
      await this.transport.startTask?.(input);
      this.updateTask(input.id, { status: 'running' }, timestamp);
    } catch (error) {
      this.updateTask(input.id, { status: 'failed', error: error instanceof Error ? error.message : String(error) }, timestamp);
      this.patch({ error: error instanceof Error ? error : new Error(String(error)) });
      throw error;
    }
  }

  private updateTask(
    taskId: string,
    update: Partial<Pick<DelegationTask, 'status' | 'detail' | 'error'>>,
    timestamp?: string,
  ): void {
    const task = this.state.tasks.find(item => item.id === taskId);
    if (!task) throw new Error(`Unknown delegation task: ${taskId}`);
    const at = now(timestamp);
    const next = { ...task, ...update, updatedAt: at };
    this.patch({ tasks: this.state.tasks.map(item => item.id === taskId ? next : item) });
    if (update.status) {
      this.append({ id: `task:${taskId}:${at}:${update.status}`, type: 'task', taskId, timestamp: at, label: `${task.title} ${update.status}`, status: update.status });
    }
  }

  private async cancelTask(taskId: string, timestamp?: string): Promise<void> {
    const task = this.state.tasks.find(item => item.id === taskId);
    if (!task || ['cancelled', 'completed', 'failed'].includes(task.status)) return;
    this.updateTask(taskId, { status: 'cancelling' }, timestamp);
    try {
      await this.transport.cancelTask?.(taskId);
      this.updateTask(taskId, { status: 'cancelled' }, timestamp);
    } catch (error) {
      this.updateTask(taskId, { status: task.status, error: error instanceof Error ? error.message : String(error) }, timestamp);
      this.patch({ error: error instanceof Error ? error : new Error(String(error)) });
      throw error;
    }
  }

  private async cancelConversation(timestamp?: string): Promise<void> {
    if (['cancelled', 'completed', 'failed', 'idle'].includes(this.state.conversationStatus)) return;
    this.setConversation('cancelling', timestamp);
    try {
      await this.transport.cancelConversation?.();
      this.patch({
        tasks: this.state.tasks.map(task =>
          task.status === 'queued' || task.status === 'running' || task.status === 'cancelling'
            ? { ...task, status: 'cancelled', updatedAt: now(timestamp) }
            : task,
        ),
      });
      this.setConversation('cancelled', timestamp);
    } catch (error) {
      this.patch({ conversationStatus: 'active', error: error instanceof Error ? error : new Error(String(error)) });
      throw error;
    }
  }
}

export function createDelegationStore(options?: DelegationStoreOptions): DelegationStore {
  return new DelegationStore(options);
}
