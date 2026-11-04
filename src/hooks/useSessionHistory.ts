'use client';

import { useRef } from 'react';
import { useTranscript } from '../contexts/TranscriptContext';
import type { HistoryItem } from '../core/types';

type Role = 'user' | 'assistant';

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

  const liveTextRef = useRef<Map<string, string>>(new Map());

  const textForItem = (itemId: string, fromHistory: string): string => {
    const live = liveTextRef.current.get(itemId);
    if (live && hasText(live)) return live;
    const local = transcriptItemsRef.current.find(
      (i) => i.itemId === itemId && i.type === 'MESSAGE'
    );
    if (local?.title && hasText(local.title)) return local.title;
    return fromHistory;
  };

  function syncHistoryItem(item: HistoryItem) {
    const { itemId, role } = item;
    const text = textForItem(itemId, item.text);

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
      addTranscriptMessage(itemId, role, text);
      return;
    }

    if (hasText(text)) {
      updateTranscriptMessage(itemId, text, false, role);
    }

    const status = text ? 'DONE' : existing.status;
    updateTranscriptItem(itemId, {
      status,
      isHidden: hasText(text) || hasText(existing.title) ? false : existing.isHidden,
    });
  }

  function handleHistoryUpdated(items: HistoryItem[]) {
    for (const item of items) syncHistoryItem(item);
  }

  function handleTranscriptionDelta({ itemId, delta, role }: { itemId: string; delta: string; role: Role }) {
    if (!itemId || !delta) return;

    const text = (liveTextRef.current.get(itemId) || '') + delta;
    liveTextRef.current.set(itemId, text);
    if (!hasText(text)) return;

    updateTranscriptMessage(itemId, text, false, role);
  }

  function handleTranscriptionCompleted({ itemId, text, role }: { itemId: string; text: string; role: Role }) {
    if (!itemId) return;

    const finalText = liveTextRef.current.get(itemId) || text || '';
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

  function handleInterrupted(itemId: string) {
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

    return { spokenText: text };
  }

  const handlersRef = useRef({
    handleToolStart: (name: string, _input: unknown) => {
      addTranscriptBreadcrumb(`function call: ${name}`);
    },
    handleToolEnd: (name: string, _input: unknown, result: unknown) => {
      addTranscriptBreadcrumb(`function call result: ${name}`, { result });
    },
    handleHistoryUpdated,
    handleTranscriptionDelta,
    handleTranscriptionCompleted,
    handleInterrupted,
  });

  return handlersRef;
}
