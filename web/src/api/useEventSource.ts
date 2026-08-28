import { useEffect, useRef, useState } from "react";
import { apiFetch } from "./client.js";

const EVENT_TYPES = ["meters", "param-change", "connection", "scene"] as const;

export type EventSourceStatus = "connecting" | "open" | "closed";

/**
 * Subscribes to a core/plugin SSE endpoint and forwards parsed events to onEvent. EventSource can't
 * set custom headers, so instead of putting the long-lived bearer token directly in the URL (where
 * it would land in server/proxy access logs and browser history), this first exchanges it for a
 * short-lived, single-use ticket via an authenticated POST (see core/auth.ts's SseTicketStore), then
 * opens the EventSource with that ticket in the URL instead.
 */
export function useEventSource(
  path: string,
  onEvent: (type: string, data: unknown) => void
): EventSourceStatus {
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  const [status, setStatus] = useState<EventSourceStatus>("connecting");

  useEffect(() => {
    let cancelled = false;
    let source: EventSource | undefined;
    let listeners: Array<{ type: (typeof EVENT_TYPES)[number]; listener: EventListener }> = [];
    setStatus("connecting");

    (async () => {
      let ticket: string;
      try {
        ({ ticket } = await apiFetch<{ ticket: string }>("/api/auth/sse-ticket", { method: "POST" }));
      } catch (err) {
        console.error("useEventSource: failed to obtain an SSE ticket", err);
        return;
      }
      if (cancelled) return;

      const url = path + (path.includes("?") ? "&" : "?") + "ticket=" + encodeURIComponent(ticket);
      const opened = new EventSource(url);
      source = opened;

      opened.onopen = () => setStatus("open");
      opened.onerror = () => setStatus("connecting");

      listeners = EVENT_TYPES.map((type) => {
        const listener = (event: MessageEvent<string>) => {
          try {
            onEventRef.current(type, JSON.parse(event.data));
          } catch (err) {
            console.error("useEventSource: failed to parse event payload", err);
          }
        };
        opened.addEventListener(type, listener as EventListener);
        return { type, listener: listener as EventListener };
      });
    })();

    return () => {
      cancelled = true;
      if (source) {
        for (const { type, listener } of listeners) {
          source.removeEventListener(type, listener as EventListener);
        }
        source.close();
      }
      setStatus("closed");
    };
  }, [path]);

  return status;
}
