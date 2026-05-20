'use client';

import { useRef } from 'react';
import { useTranscript } from '../contexts/TranscriptContext';
import { useEvent } from '../contexts/EventContext';

function hasText(text: string): boolean {
  return text.replace(/[\s.…]+/g, '').length > 0;
}

export function useSessionHistory() {
  const {
    transcriptItems,
    addTranscriptMessage,
    addTranscriptBreadcrumb,
    updateTranscriptMessage,
    updateTranscriptItem,
  } = useTranscript();

  const transcriptItemsRef = useRef(transcriptItems);
  transcriptItemsRef.current = transcriptItems;

  const { logServerEvent } = useEvent();
  const liveTextRef = useRef<Map<string, string>>(new Map());

  const extractMessageText = (content: unknown[] = []): string => {
    if (!Array.isArray(content)) return '';
    return content
      .map((c: unknown) => {
        if (!c || typeof c !== 'object') return '';
        const part = c as Record<string, unknown>;
        if (part.type === 'input_text' || part.type === 'output_text') {
          return (part.text as string) ?? '';
        }
        if (
          part.type === 'audio' ||
          part.type === 'output_audio' ||
          part.type === 'input_audio'
        ) {
          return (part.transcript as string) ?? '';
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  };

  const textForItem = (itemId: string, fromHistory: string): string => {
    const live = liveTextRef.current.get(itemId);
    if (live && hasText(live)) return live;
    const local = transcriptItemsRef.current.find(
      (i) => i.itemId === itemId && i.type === 'MESSAGE'
    );
    if (local?.title && hasText(local.title)) return local.title;
    return fromHistory;
  };

  function syncHistoryMessage(item: Record<string, unknown>) {
    if (!item || item.type !== 'message') return;

    const itemId = (item.itemId as string) || (item.id as string);
    const role = item.role as string | undefined;
    const content = (item.content as unknown[]) ?? [];

    if (!itemId || !role) return;

    const messageRole = role === 'assistant' ? 'assistant' : 'user';
    const historyText = extractMessageText(content);
    const text = textForItem(itemId, historyText);

    const guardrail = text.match(/Failure Details: (\{.*?\})/)?.[1];
    if (guardrail) {
      try {
        addTranscriptBreadcrumb('Output Guardrail Active', {
          details: JSON.parse(guardrail),
        });
      } catch {
        addTranscriptBreadcrumb('Output Guardrail Active', { raw: guardrail });
      }
      return;
    }

    const existing = transcriptItemsRef.current.find(
      (i) => i.itemId === itemId && i.type === 'MESSAGE'
    );

    if (!existing) {
      addTranscriptMessage(itemId, messageRole, text);
      return;
    }

    if (hasText(text)) {
      updateTranscriptMessage(itemId, text, false, messageRole);
    }

    const status = text ? 'DONE' : existing.status;
    updateTranscriptItem(itemId, {
      status,
      isHidden: hasText(text) || hasText(existing.title) ? false : existing.isHidden,
    });
  }

  function handleHistoryUpdated(items: Record<string, unknown>[]) {
    for (const item of items) {
      syncHistoryMessage(item);
    }
  }

  function handleHistoryAdded(item: Record<string, unknown>) {
    syncHistoryMessage(item);
  }

  function handleTranscriptionDelta(item: Record<string, unknown>) {
    const itemId = item.item_id as string;
    const role = (item.role as 'user' | 'assistant') || 'user';
    const delta = (item.delta as string) || '';
    if (!itemId || !delta) return;

    const text = (liveTextRef.current.get(itemId) || '') + delta;
    liveTextRef.current.set(itemId, text);
    if (!hasText(text)) return;

    updateTranscriptMessage(itemId, text, false, role);
  }

  function handleTranscriptionCompleted(item: Record<string, unknown>) {
    const itemId = item.item_id as string;
    const role = (item.role as 'user' | 'assistant') || 'user';
    if (!itemId) return;

    const finalText =
      liveTextRef.current.get(itemId) || (item.transcript as string) || '';
    liveTextRef.current.delete(itemId);

    if (!hasText(finalText)) {
      updateTranscriptItem(itemId, { status: 'DONE' });
      return;
    }

    if (role === 'user') {
      const words = finalText
        .trim()
        .split(/\s+/)
        .filter((w) => /[a-zA-Z0-9]/.test(w)).length;
      if (words < 2) {
        updateTranscriptItem(itemId, { isHidden: true, status: 'DONE' });
        return;
      }
    }

    updateTranscriptMessage(itemId, finalText, false, role);
    updateTranscriptItem(itemId, { status: 'DONE', isHidden: false });
  }

  function handleTruncation(itemId: string) {
    const existing = transcriptItemsRef.current.find(
      (i) => i.itemId === itemId && i.type === 'MESSAGE'
    );
    const role = existing?.role ?? 'assistant';
    const text = (liveTextRef.current.get(itemId) || existing?.title || '').trim();

    liveTextRef.current.delete(itemId);

    if (text) {
      const suffix = existing?.status === 'DONE' ? '' : '...';
      updateTranscriptMessage(itemId, text + suffix, false, role);
    }
    updateTranscriptItem(itemId, { status: 'DONE', isHidden: false });

    return { spokenText: text, fullText: text };
  }

  const handlersRef = useRef({
    handleAgentToolStart: (
      _details: Record<string, unknown>,
      _agent: unknown,
      fn: Record<string, unknown>
    ) => {
      addTranscriptBreadcrumb(`function call: ${fn.name}`);
    },
    handleAgentToolEnd: (
      _details: Record<string, unknown>,
      _agent: unknown,
      fn: Record<string, unknown>,
      result: unknown
    ) => {
      addTranscriptBreadcrumb(`function call result: ${fn.name}`, { result });
    },
    handleHistoryUpdated,
    handleHistoryAdded,
    handleTranscriptionDelta,
    handleTranscriptionCompleted,
    handleTruncation,
    handleGuardrailTripped: (
      _details: Record<string, unknown>,
      _agent: unknown,
      _guardrail: Record<string, unknown>
    ) => {},
    isInterrupted: (_itemId: string) => false,
  });

  return handlersRef;
}
