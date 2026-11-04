'use client';

import { useCallback, useEffect, useRef } from 'react';
import { useSelector } from '@xstate/react';
import { useEvent } from '../contexts/EventContext';
import { useSessionHistory } from './useSessionHistory';
import { SessionController } from '../core/SessionController';
import { selectIsConnected, selectStatus } from '../core/sessionMachine';
import type {
  VoiceAdapter,
  VoiceAgentConfig,
  VoiceKitEvents,
  VoiceStatus,
  SessionOptions,
  RequestResponseOptions,
} from '../core/types';

export interface RealtimeSessionCallbacks {
  onConnectionChange?: (status: VoiceStatus) => void;
  onAgentHandoff?: (agentName: string) => void;
  /** Handlers for any VoiceKit event; kept subscribed across reconnects. */
  handlers?: Partial<VoiceKitEvents>;
}

export interface ConnectOptions {
  /** Provider adapter, e.g. openai() from @jchaffin/voicekit/openai. */
  adapter: VoiceAdapter;
  /** Agent configs. The first entry is the root agent. */
  initialAgents: VoiceAgentConfig[];
  /** Returns the credential from your session endpoint. */
  getAuthToken?: () => Promise<string | null | undefined>;
  /** @deprecated Use `getAuthToken`. */
  getEphemeralKey?: () => Promise<string>;
  audioElement?: HTMLAudioElement;
  extraContext?: Record<string, unknown>;
  outputGuardrails?: unknown[];
  /** Merged over the defaults `{ language: 'en', codec }`. */
  sessionOptions?: SessionOptions;
  /** Speak the root agent's `greeting` once connected. Default: false */
  greet?: boolean;
}

function codecFromUrl(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  return new URLSearchParams(window.location.search).get('codec')?.toLowerCase() || undefined;
}

export function useRealtimeSession(callbacks: RealtimeSessionCallbacks = {}) {
  const controllerRef = useRef<SessionController | null>(null);
  if (!controllerRef.current) controllerRef.current = new SessionController();
  const controller = controllerRef.current;

  const status = useSelector(controller.actor, selectStatus);
  const isConnected = useSelector(controller.actor, selectIsConnected);
  const { logClientEvent, logServerEvent } = useEvent();
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;

  const history = useSessionHistory().current;

  useEffect(() => {
    const subscriptions: [keyof VoiceKitEvents & string, (...args: any[]) => void][] = [
      ['status_change', (s: VoiceStatus) => {
        callbacksRef.current.onConnectionChange?.(s);
        logClientEvent({}, s);
      }],
      ['user_transcript', (data) => {
        if (data.isFinal) {
          const text = data.text || data.delta || '';
          if (text.replace(/[\s.…,!?]+/g, '').length === 0) return;
          history.handleTranscriptionCompleted({ itemId: data.itemId, text, role: 'user' });
        } else if (data.delta) {
          history.handleTranscriptionDelta({ itemId: data.itemId, delta: data.delta, role: 'user' });
        }
      }],
      ['assistant_transcript', (data) => {
        if (data.isFinal) {
          history.handleTranscriptionCompleted({ itemId: data.itemId, text: data.text || '', role: 'assistant' });
        } else if (data.delta) {
          history.handleTranscriptionDelta({ itemId: data.itemId, delta: data.delta, role: 'assistant' });
        }
      }],
      ['tool_call_start', (name, input) => history.handleToolStart(name, input)],
      ['tool_call_end', (name, input, output) => history.handleToolEnd(name, input, output)],
      ['agent_handoff', (_from, to) => callbacksRef.current.onAgentHandoff?.(to)],
      ['history_updated', (items) => history.handleHistoryUpdated(items)],
      ['interrupted', ({ itemId }) => {
        const { spokenText } = history.handleInterrupted(itemId);
        logServerEvent({ type: 'interrupted', itemId, spokenText });
      }],
      ['raw_event', (event) => {
        if (event && typeof event === 'object') logServerEvent(event as Record<string, unknown>);
      }],
      ['error', (error: Error) => {
        console.error('VoiceKit session error:', error);
        logServerEvent({ type: 'error', message: error.message });
      }],
    ];

    const userEvents = [
      'connected', 'disconnected', 'reconnecting', 'reconnected',
      'user_speech_started', 'user_speech_ended',
      'assistant_speech_started', 'assistant_speech_ended',
      'response_started', 'response_done',
      ...subscriptions.map(([name]) => name),
    ] as const;
    const forwarders = Array.from(new Set(userEvents)).map((name) => {
      const fn = (...args: unknown[]) => {
        const handler = callbacksRef.current.handlers?.[name] as ((...a: unknown[]) => void) | undefined;
        handler?.(...args);
      };
      return [name, fn] as const;
    });

    for (const [name, fn] of [...subscriptions, ...forwarders]) controller.on(name, fn);
    return () => {
      for (const [name, fn] of [...subscriptions, ...forwarders]) controller.off(name, fn);
    };
  }, [controller, history, logClientEvent, logServerEvent]);

  useEffect(() => () => { void controller.disconnect('client'); }, [controller]);

  const connect = useCallback(
    async ({
      adapter,
      initialAgents,
      getAuthToken,
      getEphemeralKey,
      audioElement,
      extraContext,
      outputGuardrails,
      sessionOptions,
      greet,
    }: ConnectOptions) => {
      if (!adapter) {
        throw new Error('useRealtimeSession: `adapter` is required in ConnectOptions.');
      }
      if (!initialAgents?.length) {
        throw new Error('useRealtimeSession: `initialAgents` must be a non-empty array.');
      }
      const tokenFn = getAuthToken ?? getEphemeralKey;
      if (!tokenFn) {
        throw new Error('useRealtimeSession: `getAuthToken` is required in ConnectOptions.');
      }

      const codec = codecFromUrl();
      await controller.connect({
        adapter,
        agent: initialAgents[0],
        getAuthToken: tokenFn,
        audioElement,
        context: extraContext,
        outputGuardrails,
        sessionOptions: { language: 'en', ...(codec && { codec }), ...sessionOptions },
        greet,
      });
    },
    [controller]
  );

  const disconnect = useCallback(() => controller.disconnect('client'), [controller]);
  const interrupt = useCallback(() => controller.interrupt(), [controller]);
  const sendUserText = useCallback((text: string) => controller.sendMessage(text), [controller]);
  const sendEvent = useCallback((ev: Record<string, unknown>) => controller.sendRawEvent(ev), [controller]);
  const requestResponse = useCallback(
    (options?: RequestResponseOptions) => controller.requestResponse(options),
    [controller]
  );
  const greet = useCallback((text: string) => controller.greet(text), [controller]);
  const mute = useCallback((m: boolean) => controller.mute(m), [controller]);
  const pushToTalkStart = useCallback(() => controller.pushToTalkStart(), [controller]);
  const pushToTalkStop = useCallback(() => controller.pushToTalkStop(), [controller]);

  return {
    status,
    isConnected,
    controller,
    on: controller.on,
    off: controller.off,
    connect,
    disconnect,
    sendUserText,
    sendEvent,
    requestResponse,
    greet,
    mute,
    pushToTalkStart,
    pushToTalkStop,
    interrupt,
  } as const;
}
