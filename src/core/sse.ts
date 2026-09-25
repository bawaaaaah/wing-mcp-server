import type { Request, RequestHandler, Response } from "express";
import type { EventBus, PluginEvent } from "./event-bus.js";

const PING_INTERVAL_MS = 15_000;

/**
 * A client that stops reading (a laptop lid closed on a dashboard tab, a stalled proxy) used to make
 * every event pile up in this process's memory for as long as the TCP connection stayed open —
 * meters alone are ten publishes a second. Past the soft limit, meter frames for that client are
 * skipped (the next one supersedes them anyway); past the hard limit the stream is cut, and the
 * dashboard reconnects with a fresh ticket and reloads its state.
 */
export const SSE_SOFT_LIMIT_BYTES = 256 * 1024;
export const SSE_HARD_LIMIT_BYTES = 4 * 1024 * 1024;
const SUPERSEDED_EVENT_TYPES = new Set(["meters"]);

export function sendSseHeaders(res: Response): void {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
}

export function writeSseEvent(res: Response, type: string, data: unknown): void {
  res.write("event: " + type + "\n");
  res.write("data: " + JSON.stringify(data) + "\n\n");
}

export function createSseRoute(eventBus: EventBus, opts?: { pluginId?: string }): RequestHandler {
  return (req: Request, res: Response) => {
    sendSseHeaders(res);

    let closed = false;
    const close = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(pingTimer);
      unsubscribe();
    };

    const unsubscribe = eventBus.subscribe((event: PluginEvent) => {
      if (opts?.pluginId && event.pluginId !== opts.pluginId) return;
      const backlog = res.writableLength ?? 0;
      if (backlog > SSE_HARD_LIMIT_BYTES) {
        close();
        res.destroy();
        return;
      }
      if (backlog > SSE_SOFT_LIMIT_BYTES && SUPERSEDED_EVENT_TYPES.has(event.type)) return;
      writeSseEvent(res, event.type, event);
    });

    const pingTimer = setInterval(() => {
      res.write(":ping\n\n");
    }, PING_INTERVAL_MS);

    req.on("close", close);
  };
}
