'use client';

import React, {
  createContext,
  useContext,
  useState,
  useRef,
  FC,
  PropsWithChildren,
  useCallback,
} from 'react';

export interface TranscriptItem {
  itemId: string;
  type: 'MESSAGE' | 'BREADCRUMB';
  role?: 'user' | 'assistant';
  title: string;
  data?: Record<string, unknown>;
  expanded: boolean;
  timestamp: string;
  createdAtMs: number;
  /** Set once when the row is first created; never rewritten. */
  insertSeq: number;
  status: 'IN_PROGRESS' | 'DONE';
  isHidden: boolean;
  guardrailResult?: {
    status: 'IN_PROGRESS' | 'DONE';
    category: string;
    rationale: string;
    testText?: string;
  };
}

interface TranscriptContextValue {
  transcriptItems: TranscriptItem[];
  addTranscriptMessage: (
    itemId: string,
    role: 'user' | 'assistant',
    text: string,
    isHidden?: boolean
  ) => void;
  updateTranscriptMessage: (
    itemId: string,
    text: string,
    isDelta: boolean,
    role?: 'user' | 'assistant'
  ) => void;
  addTranscriptBreadcrumb: (title: string, data?: Record<string, unknown>) => void;
  toggleTranscriptItemExpand: (itemId: string) => void;
  updateTranscriptItem: (itemId: string, updatedProperties: Partial<TranscriptItem>) => void;
  clearTranscript: () => void;
}

const TranscriptContext = createContext<TranscriptContextValue | undefined>(undefined);

function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function hasText(text: string): boolean {
  return text.replace(/[\s.…]+/g, '').length > 0;
}

function generateId(): string {
  return Math.random().toString(36).substring(2, 15);
}

export const TranscriptProvider: FC<PropsWithChildren> = ({ children }) => {
  const [transcriptItems, setTranscriptItems] = useState<TranscriptItem[]>([]);
  const insertSeqRef = useRef(0);
  const createdAtByIdRef = useRef<Map<string, number>>(new Map());

  const nextInsertSeq = () => {
    insertSeqRef.current += 1;
    return insertSeqRef.current;
  };

  const createdAtFor = (itemId: string, existing?: TranscriptItem): number => {
    if (existing?.createdAtMs) return existing.createdAtMs;
    if (!createdAtByIdRef.current.has(itemId)) {
      createdAtByIdRef.current.set(itemId, Date.now());
    }
    return createdAtByIdRef.current.get(itemId)!;
  };

  const addTranscriptMessage = useCallback(
    (itemId: string, role: 'user' | 'assistant', text = '', isHidden = false) => {
      setTranscriptItems((prev) => {
        const idx = prev.findIndex((i) => i.itemId === itemId && i.type === 'MESSAGE');
        if (idx >= 0) {
          const cur = prev[idx]!;
          const title = hasText(text) ? text : cur.title;
          return prev.map((item, i) =>
            i === idx
              ? {
                  ...cur,
                  title,
                  role: role || cur.role,
                  isHidden: hasText(title) ? false : isHidden,
                }
              : item
          );
        }

        const ms = createdAtFor(itemId);
        const message: TranscriptItem = {
          itemId,
          type: 'MESSAGE',
          role,
          title: text,
          expanded: false,
          timestamp: formatTime(ms),
          createdAtMs: ms,
          insertSeq: nextInsertSeq(),
          status: 'IN_PROGRESS',
          isHidden: hasText(text) ? false : isHidden,
        };
        return [...prev, message];
      });
    },
    []
  );

  const updateTranscriptMessage = useCallback(
    (itemId: string, newText: string, append = false, role: 'user' | 'assistant' = 'user') => {
      setTranscriptItems((prev) => {
        const idx = prev.findIndex((i) => i.itemId === itemId && i.type === 'MESSAGE');
        if (idx >= 0) {
          return prev.map((item) => {
            if (item.itemId !== itemId || item.type !== 'MESSAGE') return item;
            const title = append
              ? (item.title ?? '') + newText
              : hasText(newText)
                ? newText
                : item.title;
            return {
              ...item,
              title,
              role: item.role ?? role,
              isHidden: hasText(title) ? false : item.isHidden,
            };
          });
        }

        if (!hasText(newText)) return prev;

        const ms = createdAtFor(itemId);
        return [
          ...prev,
          {
            itemId,
            type: 'MESSAGE',
            role,
            title: newText,
            expanded: false,
            timestamp: formatTime(ms),
            createdAtMs: ms,
            insertSeq: nextInsertSeq(),
            status: 'IN_PROGRESS',
            isHidden: false,
          },
        ];
      });
    },
    []
  );

  const addTranscriptBreadcrumb = useCallback((title: string, data?: Record<string, unknown>) => {
    const ms = Date.now();
    setTranscriptItems((prev) => [
      ...prev,
      {
        itemId: `breadcrumb-${generateId()}`,
        type: 'BREADCRUMB',
        title,
        data,
        expanded: false,
        timestamp: formatTime(ms),
        createdAtMs: ms,
        insertSeq: nextInsertSeq(),
        status: 'DONE',
        isHidden: false,
      },
    ]);
  }, []);

  const toggleTranscriptItemExpand = useCallback((itemId: string) => {
    setTranscriptItems((prev) =>
      prev.map((item) =>
        item.itemId === itemId ? { ...item, expanded: !item.expanded } : item
      )
    );
  }, []);

  const updateTranscriptItem = useCallback(
    (itemId: string, updatedProperties: Partial<TranscriptItem>) => {
      setTranscriptItems((prev) =>
        prev.map((item) => {
          if (item.itemId !== itemId) return item;
          const next = { ...item, ...updatedProperties };
          if (hasText(next.title)) next.isHidden = false;
          return next;
        })
      );
    },
    []
  );

  const clearTranscript = useCallback(() => {
    insertSeqRef.current = 0;
    createdAtByIdRef.current.clear();
    setTranscriptItems([]);
  }, []);

  return (
    <TranscriptContext
      value={{
        transcriptItems,
        addTranscriptMessage,
        updateTranscriptMessage,
        addTranscriptBreadcrumb,
        toggleTranscriptItemExpand,
        updateTranscriptItem,
        clearTranscript,
      }}
    >
      {children}
    </TranscriptContext>
  );
};

export function useTranscript() {
  const context = useContext(TranscriptContext);
  if (!context) {
    throw new Error('useTranscript must be used within a TranscriptProvider');
  }
  return context;
}
