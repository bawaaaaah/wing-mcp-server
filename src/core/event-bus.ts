import { EventEmitter } from "node:events";

export interface PluginEvent {
  pluginId: string;
  type: string;
  payload: unknown;
  timestamp: number;
}

const EVENT_CHANNEL = "event";

/**
 * Every open SSE stream is one listener, plus the plugins' own. Node warns past 10, which a few
 * dashboard tabs reach legitimately; the warning is still worth having past this, where it would
 * mean streams are leaking rather than being used.
 */
const MAX_LISTENERS = 100;

export class EventBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(MAX_LISTENERS);
  }

  publish(event: PluginEvent): void {
    this.emit(EVENT_CHANNEL, event);
  }

  subscribe(fn: (event: PluginEvent) => void): () => void {
    this.on(EVENT_CHANNEL, fn);
    return () => {
      this.off(EVENT_CHANNEL, fn);
    };
  }
}
