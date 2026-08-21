import { useEffect, useRef, useState } from "react";
import { getToken } from "../auth/token-store.js";

const EVENT_TYPES = ["meters", "param-change", "connection", "scene"] as const;

export type EventSourceStatus = "connecting" | "open" | "closed";

/**
 * Subscribes to a core/plugin SSE endpoint (token passed as a query param since
 * EventSource cannot set custom headers) and forwards parsed events to onEvent.
 */
export function useEventSource(
  path: string,
  onEvent: (type: string, data: unknown) => void
): EventSourceStatus {
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  const [status, setStatus] = useState<EventSourceStatus>("connecting");

  useEffect(() => {
    const url = path + "?token=" + encodeURIComponent(getToken() ?? "");
    const source = new EventSource(url);
    setStatus("connecting");

    source.onopen = () => setStatus("open");
    source.onerror = () => setStatus("connecting");

    const listeners = EVENT_TYPES.map((type) => {
      const listener = (event: MessageEvent<string>) => {
        try {
          onEventRef.current(type, JSON.parse(event.data));
        } catch (err) {
          console.error("useEventSource: failed to parse event payload", err);
        }
      };
      source.addEventListener(type, listener as EventListener);
      return { type, listener };
    });

    return () => {
      for (const { type, listener } of listeners) {
        source.removeEventListener(type, listener as EventListener);
      }
      source.close();
      setStatus("closed");
    };
  }, [path]);

  return status;
}
