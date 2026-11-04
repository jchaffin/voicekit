type Handler = (...args: any[]) => void;

type EventMap = { [event: string]: Handler };

/**
 * Minimal typed event emitter for adapter session implementations.
 */
export class EventEmitter<Events extends EventMap = EventMap> {
  private handlers = new Map<string, Set<Handler>>();

  on<E extends string & keyof Events>(event: E, handler: Events[E]): void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler as Handler);
  }

  off<E extends string & keyof Events>(event: E, handler: Events[E]): void {
    this.handlers.get(event)?.delete(handler as Handler);
  }

  protected emit<E extends string & keyof Events>(event: E, ...args: Parameters<Events[E]>): void {
    this.handlers.get(event)?.forEach(fn => {
      try { fn(...args); } catch (e) { console.error(`EventEmitter error in "${event}":`, e); }
    });
  }

  removeAllListeners(): void {
    this.handlers.clear();
  }
}

/** EventEmitter whose `emit` is public, for relaying events to subscribers. */
export class EventBus<Events extends EventMap = EventMap> extends EventEmitter<Events> {
  public override emit<E extends string & keyof Events>(event: E, ...args: Parameters<Events[E]>): void {
    super.emit(event, ...args);
  }
}
