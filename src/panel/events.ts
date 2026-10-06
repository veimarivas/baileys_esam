import { EventEmitter } from 'node:events';

export interface PanelEvent {
  type: string;
  payload: Record<string, unknown>;
}

/**
 * Bus de eventos en proceso para el panel (SSE). El SessionManager emite aquí
 * cada mensaje/estado y el panel los reenvía a los navegadores conectados.
 */
class PanelBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(0);
  }

  publish(type: string, payload: Record<string, unknown>): void {
    this.emit('event', { type, payload } satisfies PanelEvent);
  }
}

export const panelBus = new PanelBus();
