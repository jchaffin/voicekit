'use client';

import React, {
  createContext,
  useContext,
  useState,
  useRef,
  useCallback,
  useEffect,
} from 'react';
import { useSelector } from '@xstate/react';
import { SessionController } from './core/SessionController';
import { selectIsConnected, selectStatus } from './core/sessionMachine';
import { VoiceStatusEnum } from './core/types';
import type { VoiceKitEvents, RequestResponseOptions } from './core/types';
import type {
  TranscriptMessage,
  VoiceContextValue,
  VoiceProviderProps,
} from './types';

const VoiceContext = createContext<VoiceContextValue | null>(null);

/**
 * Simple voice provider — self-contained transcript via `useVoice()`.
 *
 * For production apps that need rich transcript items, event logging,
 * or suggestion chips, use the **advanced** path instead:
 *   `<EventProvider>` + `<TranscriptProvider>` + `<SuggestionProvider>`
 *   with `useRealtimeSession` / `useSessionHistory`.
 *
 * Do **not** mix both — pick one integration path per app.
 */
export function VoiceProvider({
  children,
  adapter,
  agent,
  sessionEndpoint = '/api/session',
  model,
  language = 'en',
  sessionOptions,
  autoGreet = true,
  handlers,
  onStatusChange,
  onTranscriptUpdate,
  onToolCall,
  onError,
}: VoiceProviderProps) {
  const controllerRef = useRef<SessionController | null>(null);
  if (!controllerRef.current) controllerRef.current = new SessionController();
  const controller = controllerRef.current;

  const status = useSelector(controller.actor, selectStatus);
  const isConnected = useSelector(controller.actor, selectIsConnected);
  const [transcript, setTranscript] = useState<TranscriptMessage[]>([]);
  const [isMuted, setIsMuted] = useState(false);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const currentMsgIdRef = useRef<string | null>(null);
  const propsRef = useRef({ handlers, onStatusChange, onTranscriptUpdate, onToolCall, onError });
  propsRef.current = { handlers, onStatusChange, onTranscriptUpdate, onToolCall, onError };

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const audio = document.createElement('audio');
    audio.autoplay = true;
    audio.style.display = 'none';
    document.body.appendChild(audio);
    audioRef.current = audio;

    return () => {
      try {
        audio.pause();
        audio.srcObject = null;
        audio.remove();
      } catch {
        // Ignore cleanup errors
      }
    };
  }, []);

  const setTranscriptAndNotify = useCallback(
    (update: (prev: TranscriptMessage[]) => TranscriptMessage[]) => {
      setTranscript((prev) => {
        const next = update(prev);
        propsRef.current.onTranscriptUpdate?.(next);
        return next;
      });
    },
    []
  );

  const addMessage = useCallback((role: 'user' | 'assistant', text: string) => {
    const message: TranscriptMessage = {
      id: crypto.randomUUID(),
      role,
      text,
      timestamp: new Date(),
      status: 'pending',
    };
    setTranscriptAndNotify((prev) => [...prev, message]);
    return message.id;
  }, [setTranscriptAndNotify]);

  useEffect(() => {
    const appendToMessage = (id: string, delta: string) =>
      setTranscriptAndNotify((prev) => prev.map((m) => (m.id === id ? { ...m, text: m.text + delta } : m)));
    const completeMessage = (id: string) =>
      setTranscriptAndNotify((prev) => prev.map((m) => (m.id === id ? { ...m, status: 'complete' as const } : m)));

    const internal: Partial<VoiceKitEvents> = {
      status_change: (s) => {
        if (s === VoiceStatusEnum.DISCONNECTED) currentMsgIdRef.current = null;
        propsRef.current.onStatusChange?.(s);
      },
      user_transcript: (data) => {
        if (data.isFinal) addMessage('user', data.text || data.delta || '');
      },
      assistant_transcript: (data) => {
        if (data.isFinal) {
          if (currentMsgIdRef.current) {
            completeMessage(currentMsgIdRef.current);
            currentMsgIdRef.current = null;
          }
        } else if (data.delta) {
          if (!currentMsgIdRef.current) currentMsgIdRef.current = addMessage('assistant', data.delta);
          else appendToMessage(currentMsgIdRef.current, data.delta);
        }
      },
      tool_call_end: (name, input, output) => propsRef.current.onToolCall?.(name, input, output),
      error: (error) => {
        console.error('VoiceKit session error:', error);
        propsRef.current.onError?.(error);
      },
    };

    const forward = (name: keyof VoiceKitEvents & string) => (...args: unknown[]) => {
      (internal[name] as ((...a: unknown[]) => void) | undefined)?.(...args);
      (propsRef.current.handlers?.[name] as ((...a: unknown[]) => void) | undefined)?.(...args);
    };

    const names = [
      'status_change', 'connected', 'disconnected', 'reconnecting', 'reconnected',
      'user_speech_started', 'user_speech_ended', 'user_transcript',
      'assistant_transcript', 'assistant_speech_started', 'assistant_speech_ended',
      'response_started', 'response_done', 'interrupted', 'history_updated',
      'tool_call_start', 'tool_call_end', 'agent_handoff', 'guardrail_tripped',
      'error', 'raw_event',
    ] as const;
    const subs = names.map((name) => [name, forward(name)] as const);
    for (const [name, fn] of subs) controller.on(name, fn);
    return () => {
      for (const [name, fn] of subs) controller.off(name, fn);
    };
  }, [controller, addMessage, setTranscriptAndNotify]);

  useEffect(() => () => { void controller.disconnect('client'); }, [controller]);

  const fetchToken = useCallback(async (): Promise<string | null> => {
    const res = await fetch(sessionEndpoint, { method: 'POST' });
    if (!res.ok) return null;
    const data = await res.json();
    return data.ephemeralKey || data.token || null;
  }, [sessionEndpoint]);

  const connect = useCallback(async () => {
    if (!audioRef.current) return;
    try {
      await controller.connect({
        adapter,
        agent,
        getAuthToken: fetchToken,
        audioElement: audioRef.current,
        sessionOptions: { model, language, ...sessionOptions },
        greet: autoGreet,
      });
    } catch {
      // Already surfaced through the `error` event.
    }
  }, [controller, adapter, agent, model, language, sessionOptions, autoGreet, fetchToken]);

  const disconnect = useCallback(() => controller.disconnect('client'), [controller]);

  const sendMessage = useCallback((text: string) => {
    if (!isConnected) return;
    controller.interrupt();
    controller.sendMessage(text);
  }, [controller, isConnected]);

  const interrupt = useCallback(() => controller.interrupt(), [controller]);

  const requestResponse = useCallback(
    (options?: RequestResponseOptions) => controller.requestResponse(options),
    [controller]
  );

  const mute = useCallback((muted: boolean) => {
    setIsMuted(muted);
    controller.mute(muted);
    if (audioRef.current) audioRef.current.muted = muted;
  }, [controller]);

  const clearTranscript = useCallback(() => {
    setTranscriptAndNotify(() => []);
  }, [setTranscriptAndNotify]);

  const value: VoiceContextValue = {
    status,
    connect,
    disconnect,
    transcript,
    clearTranscript,
    sendMessage,
    interrupt,
    requestResponse,
    mute,
    isMuted,
    on: controller.on,
    off: controller.off,
    agent,
  };

  return (
    <VoiceContext value={value}>
      {children}
    </VoiceContext>
  );
}

/**
 * Hook to access voice functionality.
 * Must be used within a VoiceProvider.
 */
export function useVoice(): VoiceContextValue {
  const context = useContext(VoiceContext);
  if (!context) {
    throw new Error('useVoice must be used within a VoiceProvider');
  }
  return context;
}

/**
 * Subscribe to a VoiceKit event for the component's lifetime.
 * The latest `handler` is always called; no need to memoize it.
 */
export function useVoiceEvent<E extends string & keyof VoiceKitEvents>(
  event: E,
  handler: VoiceKitEvents[E]
): void {
  const { on, off } = useVoice();
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    const fn = ((...args: unknown[]) =>
      (handlerRef.current as (...a: unknown[]) => void)(...args)) as VoiceKitEvents[E];
    on(event, fn);
    return () => off(event, fn);
  }, [event, on, off]);
}
