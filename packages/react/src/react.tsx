import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useRef,
  useSyncExternalStore,
  type PropsWithChildren,
} from 'react';
import {
  createVoiceSessionStore,
  type VoiceSessionSnapshot,
  type VoiceSessionStore,
  type VoiceSessionStoreOptions,
  type VoiceSessionTransport,
} from './store.js';

const VoiceSessionContext = createContext<VoiceSessionStore | null>(null);

export interface VoiceSessionProviderProps extends PropsWithChildren {
  transport: VoiceSessionTransport;
  options?: VoiceSessionStoreOptions;
}

export function VoiceSessionProvider({ transport, options, children }: VoiceSessionProviderProps) {
  const storeRef = useRef<VoiceSessionStore | null>(null);
  const transportRef = useRef(transport);
  if (transportRef.current !== transport) {
    throw new Error('VoiceSessionProvider transport cannot change after mount');
  }
  storeRef.current ??= createVoiceSessionStore(transport, options);

  useEffect(() => () => storeRef.current?.destroy(), []);
  return createElement(VoiceSessionContext.Provider, { value: storeRef.current }, children);
}

export function useVoiceSessionStore(): VoiceSessionStore {
  const store = useContext(VoiceSessionContext);
  if (!store) throw new Error('VoiceSession hooks must be used inside VoiceSessionProvider');
  return store;
}

export function useVoiceSession(): VoiceSessionSnapshot {
  const store = useVoiceSessionStore();
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
}

export function useVoiceSelector<T>(
  selector: (snapshot: VoiceSessionSnapshot) => T,
  isEqual: (left: T, right: T) => boolean = Object.is,
): T {
  const store = useVoiceSessionStore();
  const selectedRef = useRef<T | undefined>(undefined);
  const initializedRef = useRef(false);

  const select = (snapshot: VoiceSessionSnapshot): T => {
    const next = selector(snapshot);
    if (initializedRef.current && isEqual(selectedRef.current as T, next)) return selectedRef.current as T;
    initializedRef.current = true;
    selectedRef.current = next;
    return next;
  };

  return useSyncExternalStore(
    store.subscribe,
    () => select(store.getSnapshot()),
    () => select(store.getServerSnapshot()),
  );
}
