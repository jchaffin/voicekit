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
  createExperimentStore,
  type ExperimentDefinition,
  type ExperimentSnapshot,
  type ExperimentStore,
  type ExperimentStoreOptions,
} from './experiment.js';

const ExperimentContext = createContext<ExperimentStore | null>(null);

export type ExperimentProviderProps = PropsWithChildren<
  | { store: ExperimentStore; definition?: never; options?: never }
  | { store?: never; definition: ExperimentDefinition; options?: ExperimentStoreOptions }
>;

export function ExperimentProvider(props: ExperimentProviderProps) {
  const storeRef = useRef<ExperimentStore | null>(null);
  storeRef.current ??= props.store ?? createExperimentStore(props.definition, props.options);
  if (props.store && storeRef.current !== props.store) {
    throw new Error('ExperimentProvider store cannot change after mount');
  }
  useEffect(() => () => storeRef.current?.destroy(), []);
  return createElement(ExperimentContext.Provider, { value: storeRef.current }, props.children);
}

export function useExperimentStore(): ExperimentStore {
  const store = useContext(ExperimentContext);
  if (!store) throw new Error('Experiment hooks must be used inside ExperimentProvider');
  return store;
}

export function useExperiment(): ExperimentSnapshot {
  const store = useExperimentStore();
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
}

export function useExperimentSelector<T>(
  selector: (snapshot: ExperimentSnapshot) => T,
  isEqual: (left: T, right: T) => boolean = Object.is,
): T {
  const store = useExperimentStore();
  const selectedRef = useRef<T | undefined>(undefined);
  const initializedRef = useRef(false);
  const select = (snapshot: ExperimentSnapshot): T => {
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
