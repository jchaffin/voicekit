import { and, assign, emit, enqueueActions, fromPromise, setup, type SnapshotFrom } from 'xstate';
import type { EventBus } from './EventEmitter';
import { VoiceError, toVoiceError } from './errors';
import { VoiceStatusEnum } from './types';
import type {
  VoiceAdapter,
  VoiceAgentConfig,
  VoiceSession,
  VoiceStatus,
  VoiceKitEvents,
  SessionEvents,
  SessionOptions,
  StatusChangeDetail,
  DisconnectInfo,
  DisconnectReason,
  RequestResponseOptions,
} from './types';

/** Session events relayed verbatim from the adapter session to subscribers. */
const RELAYED_EVENTS = [
  'user_speech_started',
  'user_speech_ended',
  'user_transcript',
  'assistant_transcript',
  'assistant_speech_started',
  'assistant_speech_ended',
  'response_started',
  'response_done',
  'interrupted',
  'history_updated',
  'tool_call_start',
  'tool_call_end',
  'agent_handoff',
  'guardrail_tripped',
  'audio_delta',
  'vad',
  'barge_in',
  'raw_event',
] as const satisfies readonly (keyof SessionEvents)[];

const { DISCONNECTED, CONNECTING, CONNECTED } = VoiceStatusEnum;

/** Substates of the top-level status states. */
export const SessionPhase = {
  IDLE: 'IDLE',
  ENDING: 'ENDING',
  AUTHORIZING: 'AUTHORIZING',
  OPENING: 'OPENING',
  STABLE: 'STABLE',
  RECONNECTING: 'RECONNECTING',
} as const;

type SessionPhase = (typeof SessionPhase)[keyof typeof SessionPhase];

/** Absolute target; each top-level state's `id` is its status. */
const at = (status: VoiceStatus, phase?: SessionPhase) => (phase ? `#${status}.${phase}` : `#${status}`) as `#${string}`;

export interface ControllerConnectOptions {
  adapter: VoiceAdapter;
  agent: VoiceAgentConfig;
  /** Returns the credential from your session endpoint (ephemeral key, JWT, signed URL...). */
  getAuthToken: () => Promise<string | null | undefined>;
  audioElement?: HTMLAudioElement;
  context?: Record<string, unknown>;
  outputGuardrails?: unknown[];
  sessionOptions?: SessionOptions;
  /** Speak `agent.greeting` once connected. Default: false */
  greet?: boolean;
}

export interface SessionMachineContext {
  /** Receives adapter session events, which bypass the machine. */
  bus: EventBus<VoiceKitEvents>;
  /** Options of the current or most recent connect; kept so ENDING can run `onDisconnect`. */
  options: ControllerConnectOptions | null;
  session: VoiceSession | null;
  token: string | null;
  provider: string;
  /** Why the most recent connect attempt failed, if it did. */
  connectError: VoiceError | null;
  /** `provider:method` pairs already warned about. */
  warned: readonly string[];
}

/** Commands forwarded to the adapter session in states that have one. */
export type SessionCommand =
  | { type: 'SEND_MESSAGE'; text: string }
  | { type: 'INTERRUPT' }
  | { type: 'MUTE'; muted: boolean }
  | { type: 'REQUEST_RESPONSE'; options?: RequestResponseOptions }
  | { type: 'PUSH_TO_TALK_START' }
  | { type: 'PUSH_TO_TALK_STOP' }
  | { type: 'SEND_RAW_EVENT'; event: Record<string, unknown> };

export type SessionMachineEvent =
  | SessionCommand
  | { type: 'CONNECT'; options: ControllerConnectOptions }
  | { type: 'DISCONNECT'; reason: DisconnectReason }
  | { type: 'SESSION.STATUS'; session: VoiceSession; status: VoiceStatus; detail?: StatusChangeDetail }
  | { type: 'SESSION.FATAL'; session: VoiceSession; error: VoiceError }
  | { type: 'SESSION.UNSUPPORTED'; provider: string; method: string }
  | { type: 'SESSION.ERROR'; error: unknown };

/** Lifecycle events, delivered after the snapshot they describe is committed. */
export type SessionMachineEmitted =
  | { type: 'status_change'; status: VoiceStatus; detail?: StatusChangeDetail }
  | { type: 'connected' }
  | { type: 'reconnecting'; attempt?: number }
  | { type: 'reconnected' }
  | { type: 'disconnected'; info: DisconnectInfo }
  | { type: 'error'; error: VoiceError };

type Hook = (() => void | Promise<void>) | undefined;

const teardowns = new WeakMap<VoiceSession, Promise<void>>();

/** Disconnect `session` once; concurrent callers share the same promise. */
export function teardown(session: VoiceSession): Promise<void> {
  let pending = teardowns.get(session);
  if (!pending) {
    pending = safeDisconnect(session);
    teardowns.set(session, pending);
  }
  return pending;
}

async function safeDisconnect(session: VoiceSession): Promise<void> {
  try {
    await session.disconnect();
  } catch {
    // Session teardown is best-effort.
  }
}

function disconnectInfo(event: { type: string }, context: SessionMachineContext): DisconnectInfo {
  const e = event as SessionMachineEvent;
  switch (e.type) {
    case 'DISCONNECT':
      return { reason: e.reason };
    case 'SESSION.STATUS':
      return { reason: e.detail?.reason ?? (e.detail?.error ? 'error' : 'server'), error: e.detail?.error };
    case 'SESSION.FATAL':
      return { reason: 'error', error: e.error };
    default:
      return { reason: 'error', error: context.connectError ?? undefined };
  }
}

/** Commands accepted by every state that holds a session; SEND_MESSAGE is CONNECTED.STABLE only. */
const sessionCommands = {
  INTERRUPT: { actions: 'forward' },
  MUTE: { actions: 'forward' },
  REQUEST_RESPONSE: { actions: 'forward' },
  PUSH_TO_TALK_START: { actions: 'forward' },
  PUSH_TO_TALK_STOP: { actions: 'forward' },
  SEND_RAW_EVENT: { actions: 'forward' },
} as const;

/**
 * Provider-agnostic session lifecycle.
 *
 *   DISCONNECTED.IDLE → CONNECTING.AUTHORIZING → CONNECTING.OPENING → CONNECTED.STABLE ⇄ CONNECTED.RECONNECTING
 *   CONNECTED → DISCONNECTED.ENDING (runs onDisconnect) → DISCONNECTED.IDLE
 *
 * Each leaf is tagged with the `VoiceStatus` it reports. Commands are only
 * accepted by states that hold a session; elsewhere they are not transitions.
 */
export const sessionMachine = setup({
  types: {
    context: {} as SessionMachineContext,
    events: {} as SessionMachineEvent,
    emitted: {} as SessionMachineEmitted,
    tags: {} as VoiceStatus,
    input: {} as { bus: EventBus<VoiceKitEvents> },
  },
  actors: {
    prepare: fromPromise<{ token: string; session: VoiceSession }, ControllerConnectOptions>(async ({ input }) => {
      const token = await input.getAuthToken();
      if (!token) {
        throw new VoiceError('Failed to obtain session auth token', {
          code: 'auth_token_missing',
          provider: input.adapter.name,
          fatal: true,
        });
      }
      return { token, session: input.adapter.createSession(input.agent, input.sessionOptions) };
    }),
    open: fromPromise<void, { session: VoiceSession; token: string; options: ControllerConnectOptions }>(
      async ({ input, signal }) => {
        const { session, token, options } = input;
        await session.connect({
          authToken: token,
          audioElement: options.audioElement,
          context: options.context,
          outputGuardrails: options.outputGuardrails,
        });
        // Cancelled mid-connect: the exit teardown may have run before the transport was up.
        if (signal.aborted) await safeDisconnect(session);
      },
    ),
    hook: fromPromise<void, Hook>(async ({ input }) => {
      await input?.();
    }),
  },
  guards: {
    isCurrentSession: ({ context, event }) => 'session' in event && event.session === context.session,
    reportsConnected: ({ event }) => event.type === 'SESSION.STATUS' && event.status === CONNECTED,
    reportsConnecting: ({ event }) => event.type === 'SESSION.STATUS' && event.status === CONNECTING,
    reportsDisconnected: ({ event }) => event.type === 'SESSION.STATUS' && event.status === DISCONNECTED,
    notWarned: ({ context, event }) =>
      event.type === 'SESSION.UNSUPPORTED' && !context.warned.includes(`${event.provider}:${event.method}`),
  },
  actions: {
    wireSession: ({ context, self }) => {
      const { session, bus, provider } = context;
      if (!session) return;
      const isCurrent = () => self.getSnapshot().context.session === session;

      for (const name of RELAYED_EVENTS) {
        session.on(name, ((...args: unknown[]) => {
          if (isCurrent()) (bus.emit as (e: string, ...a: unknown[]) => void)(name, ...args);
        }) as SessionEvents[typeof name]);
      }

      session.on('status_change', (status: VoiceStatus, detail?: StatusChangeDetail) => {
        self.send({ type: 'SESSION.STATUS', session, status, detail });
      });

      session.on('error', (err: Error) => {
        if (!isCurrent()) return;
        const error = toVoiceError(err, { provider });
        bus.emit('error', error);
        if (error.fatal) self.send({ type: 'SESSION.FATAL', session, error });
      });
    },
    forward: ({ context, event, self }) => {
      const session = context.session!;
      const report = (error: unknown) => self.send({ type: 'SESSION.ERROR', error });
      const optional = <K extends keyof VoiceSession>(method: K, call: (fn: NonNullable<VoiceSession[K]>) => void) => {
        const fn = session[method];
        if (fn) call((fn as Function).bind(session));
        else self.send({ type: 'SESSION.UNSUPPORTED', provider: context.provider, method });
      };
      try {
        switch (event.type) {
          case 'SEND_MESSAGE':
            Promise.resolve(session.sendMessage(event.text)).catch(report);
            break;
          case 'INTERRUPT':
            session.interrupt();
            break;
          case 'MUTE':
            session.mute(event.muted);
            break;
          case 'REQUEST_RESPONSE':
            optional('requestResponse', (fn) => fn(event.options));
            break;
          case 'PUSH_TO_TALK_START':
            optional('pushToTalkStart', (fn) => fn());
            break;
          case 'PUSH_TO_TALK_STOP':
            optional('pushToTalkStop', (fn) => fn());
            break;
          case 'SEND_RAW_EVENT':
            optional('sendRawEvent', (fn) => fn(event.event));
            break;
        }
      } catch (err) {
        report(err);
      }
    },
    greet: enqueueActions(({ context, enqueue }) => {
      const greeting = context.options?.agent.greeting;
      if (context.options?.greet && typeof greeting === 'string') {
        enqueue.raise({ type: 'REQUEST_RESPONSE', options: { instructions: `Say exactly: "${greeting}"` } });
      }
    }),
    warnUnsupported: enqueueActions(({ context, event, enqueue }) => {
      if (event.type !== 'SESSION.UNSUPPORTED') return;
      const { provider, method } = event;
      enqueue.assign({ warned: [...context.warned, `${provider}:${method}`] });
      enqueue(() => console.warn(`VoiceKit: the "${provider}" adapter does not support ${method}().`));
    }),
    reportError: emit(({ context, event }) => ({
      type: 'error' as const,
      error: toVoiceError((event as { error?: unknown }).error, { provider: context.options?.adapter.name }),
    })),
    teardownSession: ({ context }) => {
      if (context.session) void teardown(context.session);
    },
    announceConnecting: emit({ type: 'status_change', status: CONNECTING }),
    announceConnected: enqueueActions(({ enqueue }) => {
      enqueue.emit({ type: 'status_change', status: CONNECTED });
      enqueue.emit({ type: 'connected' });
    }),
    announceReconnecting: enqueueActions(({ event, enqueue }) => {
      const detail = event.type === 'SESSION.STATUS' ? event.detail : undefined;
      enqueue.emit({ type: 'status_change', status: CONNECTING, detail });
      enqueue.emit({ type: 'reconnecting', attempt: detail?.attempt });
    }),
    announceReconnected: enqueueActions(({ enqueue }) => {
      enqueue.emit({ type: 'status_change', status: CONNECTED });
      enqueue.emit({ type: 'reconnected' });
    }),
    announceDisconnected: emit(({ context, event }) => ({
      type: 'status_change' as const,
      status: DISCONNECTED,
      detail: disconnectInfo(event, context),
    })),
    announceEnded: emit(({ context, event }) => ({
      type: 'disconnected' as const,
      info: disconnectInfo(event, context),
    })),
    recordConnectError: assign({
      connectError: ({ context, event }) =>
        toVoiceError((event as { error?: unknown }).error, { provider: context.provider, fatal: true }),
    }),
    reportConnectError: enqueueActions(({ context, enqueue }) => {
      if (context.connectError) enqueue.emit({ type: 'error', error: context.connectError });
    }),
    reset: assign({ session: null, token: null, provider: '' }),
  },
}).createMachine({
  initial: DISCONNECTED,
  context: ({ input }) => ({
    bus: input.bus,
    options: null,
    session: null,
    token: null,
    provider: '',
    connectError: null,
    warned: [],
  }),
  on: {
    'SESSION.ERROR': { actions: 'reportError' },
    'SESSION.UNSUPPORTED': { guard: 'notWarned', actions: 'warnUnsupported' },
  },
  states: {
    [DISCONNECTED]: {
      id: DISCONNECTED,
      tags: DISCONNECTED,
      initial: SessionPhase.IDLE,
      on: {
        CONNECT: {
          target: CONNECTING,
          actions: assign({
            options: ({ event }) => event.options,
            provider: ({ event }) => event.options.adapter.name,
            connectError: null,
          }),
        },
      },
      states: {
        [SessionPhase.IDLE]: {},
        [SessionPhase.ENDING]: {
          invoke: {
            src: 'hook',
            input: ({ context }) => context.options?.agent.onDisconnect,
            onDone: SessionPhase.IDLE,
            onError: { target: SessionPhase.IDLE, actions: 'reportError' },
          },
        },
      },
    },
    [CONNECTING]: {
      id: CONNECTING,
      tags: CONNECTING,
      entry: 'announceConnecting',
      initial: SessionPhase.AUTHORIZING,
      on: {
        DISCONNECT: {
          target: DISCONNECTED,
          actions: ['teardownSession', 'announceDisconnected', 'reset'],
        },
        'SESSION.FATAL': {
          guard: 'isCurrentSession',
          target: DISCONNECTED,
          actions: ['teardownSession', 'announceDisconnected', 'reset'],
        },
        'SESSION.STATUS': {
          guard: and(['isCurrentSession', 'reportsDisconnected']),
          target: DISCONNECTED,
          actions: ['teardownSession', 'announceDisconnected', 'reset'],
        },
      },
      states: {
        [SessionPhase.AUTHORIZING]: {
          invoke: {
            src: 'prepare',
            input: ({ context }) => context.options!,
            onDone: {
              target: SessionPhase.OPENING,
              actions: [
                assign({ session: ({ event }) => event.output.session, token: ({ event }) => event.output.token }),
                'wireSession',
              ],
            },
            onError: {
              target: at(DISCONNECTED),
              actions: ['recordConnectError', 'reportConnectError', 'announceDisconnected', 'reset'],
            },
          },
        },
        [SessionPhase.OPENING]: {
          invoke: {
            src: 'open',
            input: ({ context }) => ({ session: context.session!, token: context.token!, options: context.options! }),
            onDone: at(CONNECTED),
            onError: {
              target: at(DISCONNECTED),
              actions: ['recordConnectError', 'reportConnectError', 'teardownSession', 'announceDisconnected', 'reset'],
            },
          },
          on: sessionCommands,
        },
      },
    },
    [CONNECTED]: {
      id: CONNECTED,
      entry: ['announceConnected', 'greet'],
      invoke: {
        src: 'hook',
        input: ({ context }) => context.options?.agent.onConnect,
        onError: { actions: 'reportError' },
      },
      initial: SessionPhase.STABLE,
      on: {
        DISCONNECT: {
          target: at(DISCONNECTED, SessionPhase.ENDING),
          actions: ['teardownSession', 'announceDisconnected', 'announceEnded', 'reset'],
        },
        'SESSION.FATAL': {
          guard: 'isCurrentSession',
          target: at(DISCONNECTED, SessionPhase.ENDING),
          actions: ['teardownSession', 'announceDisconnected', 'announceEnded', 'reset'],
        },
        'SESSION.STATUS': {
          guard: and(['isCurrentSession', 'reportsDisconnected']),
          target: at(DISCONNECTED, SessionPhase.ENDING),
          actions: ['teardownSession', 'announceDisconnected', 'announceEnded', 'reset'],
        },
        ...sessionCommands,
      },
      states: {
        [SessionPhase.STABLE]: {
          tags: CONNECTED,
          on: {
            SEND_MESSAGE: { actions: 'forward' },
            'SESSION.STATUS': {
              guard: and(['isCurrentSession', 'reportsConnecting']),
              target: SessionPhase.RECONNECTING,
            },
          },
        },
        [SessionPhase.RECONNECTING]: {
          tags: CONNECTING,
          entry: 'announceReconnecting',
          on: {
            'SESSION.STATUS': {
              guard: and(['isCurrentSession', 'reportsConnected']),
              target: SessionPhase.STABLE,
              actions: 'announceReconnected',
            },
          },
        },
      },
    },
  },
});

export type SessionSnapshot = SnapshotFrom<typeof sessionMachine>;

const STATUSES = Object.values(VoiceStatusEnum);

/** Selectors for `useSelector(controller.actor, ...)` and direct snapshot reads. */
export const selectStatus = (snapshot: SessionSnapshot): VoiceStatus =>
  STATUSES.find((status) => snapshot.hasTag(status))!;

export const selectIsConnected = (snapshot: SessionSnapshot): boolean => snapshot.hasTag(CONNECTED);

export const selectProvider = (snapshot: SessionSnapshot): string => snapshot.context.provider;

export const selectSession = (snapshot: SessionSnapshot): VoiceSession | null => snapshot.context.session;

export const selectConnectError = (snapshot: SessionSnapshot): VoiceError | null => snapshot.context.connectError;
