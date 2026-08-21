import { EventEmitter } from "node:events";

export interface PluginEvent {
  pluginId: string;
  type: string;
  payload: unknown;
  timestamp: number;
}

const EVENT_CHANNEL = "event";

export class EventBus extends EventEmitter {
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
