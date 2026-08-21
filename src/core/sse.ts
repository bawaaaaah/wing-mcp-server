import type { Request, RequestHandler, Response } from "express";
import type { EventBus, PluginEvent } from "./event-bus.js";

const PING_INTERVAL_MS = 15_000;

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

    const unsubscribe = eventBus.subscribe((event: PluginEvent) => {
      if (opts?.pluginId && event.pluginId !== opts.pluginId) return;
      writeSseEvent(res, event.type, event);
    });

    const pingTimer = setInterval(() => {
      res.write(":ping\n\n");
    }, PING_INTERVAL_MS);

    req.on("close", () => {
      clearInterval(pingTimer);
      unsubscribe();
    });
  };
}
