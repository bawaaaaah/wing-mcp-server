import { useEffect, useRef, useState } from "react";
import { apiFetch } from "./client.js";

const EVENT_TYPES = ["meters", "param-change", "connection", "scene"] as const;

export type EventSourceStatus = "connecting" | "open" | "closed";

/** Retry delays after a stream drops, capped at the last one. */
const RECONNECT_DELAYS_MS = [1000, 2000, 5000, 10_000, 15_000];

/**
 * Subscribes to a core/plugin SSE endpoint and forwards parsed events to onEvent. EventSource can't
 * set custom headers, so instead of putting the long-lived bearer token directly in the URL (where
 * it would land in server/proxy access logs and browser history), this first exchanges it for a
 * short-lived, single-use ticket via an authenticated POST (see core/auth.ts's SseTicketStore), then
 * opens the EventSource with that ticket in the URL instead.
 *
 * Because the ticket is single-use, the browser's own automatic reconnect can never succeed: it
 * replays the same URL, gets a 401, and gives up for good — which is what used to leave a dashboard
 * silently frozen after a network blip, a server restart, or the server cutting a stream that had
 * stopped reading. So every drop is handled here: close, wait, fetch a fresh ticket, reopen. Events
 * published while the stream was down are lost, so after a *re*-open this reports a synthetic
 * "reconnected" event, for consumers that hold state built from the stream to reload it.
 */
export function useEventSource(
  path: string,
  onEvent: (type: string, data: unknown) => void,
): EventSourceStatus {
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  const [status, setStatus] = useState<EventSourceStatus>("connecting");

  useEffect(() => {
    let cancelled = false;
    let source: EventSource | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    let everOpened = false;
    setStatus("connecting");

    const scheduleReconnect = (): void => {
      if (cancelled) return;
      const delay = RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)];
      attempt += 1;
      retryTimer = setTimeout(() => void connect(), delay);
    };

    const connect = async (): Promise<void> => {
      let ticket: string;
      try {
        ({ ticket } = await apiFetch<{ ticket: string }>("/api/auth/sse-ticket", { method: "POST" }));
      } catch (err) {
        console.error("useEventSource: failed to obtain an SSE ticket", err);
        scheduleReconnect();
        return;
      }
      if (cancelled) return;

      const url = path + (path.includes("?") ? "&" : "?") + "ticket=" + encodeURIComponent(ticket);
      const opened = new EventSource(url);
      source = opened;

      opened.onopen = () => {
        attempt = 0;
        setStatus("open");
        if (everOpened) onEventRef.current("reconnected", null);
        everOpened = true;
      };
      opened.onerror = () => {
        // Never let the browser retry with the spent ticket; start over with a new one.
        opened.close();
        if (source === opened) source = undefined;
        setStatus("connecting");
        scheduleReconnect();
      };

      for (const type of EVENT_TYPES) {
        opened.addEventListener(type, ((event: MessageEvent<string>) => {
          try {
            onEventRef.current(type, JSON.parse(event.data));
          } catch (err) {
            console.error("useEventSource: failed to parse event payload", err);
          }
        }) as EventListener);
      }
    };

    void connect();

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      source?.close();
      setStatus("closed");
    };
  }, [path]);

  return status;
}
