import { createActor, waitFor, type Actor } from 'xstate';
import { EventBus } from './EventEmitter';
import { VoiceError } from './errors';
import { VoiceStatusEnum } from './types';
import {
  sessionMachine,
  selectIsConnected,
  selectProvider,
  selectSession,
  selectStatus,
  teardown,
  type ControllerConnectOptions,
  type SessionCommand,
  type SessionMachineEmitted,
} from './sessionMachine';
import type {
  VoiceSession,
  VoiceStatus,
  VoiceKitEvents,
  DisconnectReason,
  RequestResponseOptions,
  VoiceEventSource,
} from './types';

export type { ControllerConnectOptions } from './sessionMachine';

/**
 * Provider-agnostic session lifecycle manager: a thin event interface over
 * `sessionMachine`. Every decision about what is allowed when lives in the graph.
 *
 * Subscribe once with `on()` and keep receiving events across sessions.
 */
export class SessionController implements VoiceEventSource<VoiceKitEvents> {
  private readonly bus = new EventBus<VoiceKitEvents>();
  /** The underlying XState actor, for inspection and devtools. */
  readonly actor: Actor<typeof sessionMachine> = createActor(sessionMachine, { input: { bus: this.bus } }).start();

  constructor() {
    this.actor.on('*', (event) => this.relay(event));
  }

  get status(): VoiceStatus {
    return selectStatus(this.actor.getSnapshot());
  }

  get isConnected(): boolean {
    return selectIsConnected(this.actor.getSnapshot());
  }

  /** Name of the active adapter, or '' when idle. */
  get providerName(): string {
    return selectProvider(this.actor.getSnapshot());
  }

  /** The active adapter session, for provider-specific escape hatches. */
  get activeSession(): VoiceSession | null {
    return selectSession(this.actor.getSnapshot());
  }

  /** Bound, so it can be passed around detached from the controller. */
  readonly on = <E extends string & keyof VoiceKitEvents>(event: E, handler: VoiceKitEvents[E]): void => {
    this.bus.on(event, handler);
  };

  readonly off = <E extends string & keyof VoiceKitEvents>(event: E, handler: VoiceKitEvents[E]): void => {
    this.bus.off(event, handler);
  };

  /** Resolves once connected; rejects with the cause if the attempt fails. */
  async connect(options: ControllerConnectOptions): Promise<void> {
    const event = { type: 'CONNECT', options } as const;
    if (!this.actor.getSnapshot().can(event)) return;

    this.actor.send(event);
    const snapshot = await waitFor(this.actor, (s) => !s.matches(VoiceStatusEnum.CONNECTING));
    if (snapshot.matches(VoiceStatusEnum.DISCONNECTED) && snapshot.context.connectError) {
      throw snapshot.context.connectError;
    }
  }

  async disconnect(reason: DisconnectReason = 'client'): Promise<void> {
    const session = this.activeSession;
    this.actor.send({ type: 'DISCONNECT', reason });
    if (session) await teardown(session);
  }

  /** Throws when the current state does not accept messages. */
  sendMessage(text: string): void {
    const event = { type: 'SEND_MESSAGE', text } as const;
    if (!this.actor.getSnapshot().can(event)) {
      throw new VoiceError('Session not connected', { code: 'not_connected', provider: this.providerName });
    }
    this.actor.send(event);
  }

  interrupt(): void {
    this.command({ type: 'INTERRUPT' });
  }

  mute(muted: boolean): void {
    this.command({ type: 'MUTE', muted });
  }

  requestResponse(options?: RequestResponseOptions): void {
    this.command({ type: 'REQUEST_RESPONSE', options });
  }

  /** Have the assistant say `text` verbatim. */
  greet(text: string): void {
    this.requestResponse({ instructions: `Say exactly: "${text}"` });
  }

  pushToTalkStart(): void {
    this.command({ type: 'PUSH_TO_TALK_START' });
  }

  pushToTalkStop(): void {
    this.command({ type: 'PUSH_TO_TALK_STOP' });
  }

  sendRawEvent(event: Record<string, unknown>): void {
    this.command({ type: 'SEND_RAW_EVENT', event });
  }

  /** Disconnect and drop every subscriber. */
  async dispose(): Promise<void> {
    await this.disconnect('client');
    this.bus.removeAllListeners();
  }

  private command(event: SessionCommand): void {
    this.actor.send(event);
  }

  private relay(event: SessionMachineEmitted): void {
    switch (event.type) {
      case 'status_change':
        return this.bus.emit('status_change', event.status, event.detail);
      case 'connected':
        return this.bus.emit('connected');
      case 'reconnecting':
        return this.bus.emit('reconnecting', { attempt: event.attempt });
      case 'reconnected':
        return this.bus.emit('reconnected');
      case 'disconnected':
        return this.bus.emit('disconnected', event.info);
      case 'error':
        return this.bus.emit('error', event.error);
    }
  }
}
