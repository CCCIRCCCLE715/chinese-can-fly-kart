import type { GameEvent, EventHandler, IBus } from '../types';

/** Trivial synchronous pub/sub. Handlers must never throw; we swallow if they do. */
export class Bus implements IBus {
  private handlers = new Set<EventHandler>();

  emit(e: GameEvent) {
    for (const h of this.handlers) {
      try {
        h(e);
      } catch (err) {
        console.error('[bus] handler threw for', e.type, err);
      }
    }
  }

  on(h: EventHandler) {
    this.handlers.add(h);
    return () => this.handlers.delete(h);
  }
}
