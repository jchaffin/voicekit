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
  createDelegationStore,
  type DelegationSnapshot,
  type DelegationStore,
  type DelegationStoreOptions,
} from './delegation.js';

const DelegationContext = createContext<DelegationStore | null>(null);

export type DelegationProviderProps = PropsWithChildren<
  | { store: DelegationStore; options?: never }
  | { store?: never; options?: DelegationStoreOptions }
>;

export function DelegationProvider(props: DelegationProviderProps) {
  const storeRef = useRef<DelegationStore | null>(null);
  storeRef.current ??= props.store ?? createDelegationStore(props.options);
  if (props.store && storeRef.current !== props.store) {
    throw new Error('DelegationProvider store cannot change after mount');
  }
  useEffect(() => () => storeRef.current?.destroy(), []);
  return createElement(DelegationContext.Provider, { value: storeRef.current }, props.children);
}

export function useDelegationStore(): DelegationStore {
  const store = useContext(DelegationContext);
  if (!store) throw new Error('Delegation hooks must be used inside DelegationProvider');
  return store;
}

export function useDelegation(): DelegationSnapshot {
  const store = useDelegationStore();
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
}

export function useDelegationSelector<T>(
  selector: (snapshot: DelegationSnapshot) => T,
  isEqual: (left: T, right: T) => boolean = Object.is,
): T {
  const store = useDelegationStore();
  const selectedRef = useRef<T | undefined>(undefined);
  const initializedRef = useRef(false);
  const select = (snapshot: DelegationSnapshot): T => {
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
