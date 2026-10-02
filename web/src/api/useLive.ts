import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { decodeMeterFrames, decodeRtaBands, type MeterReading, type MetersAck, type MetersWireFrame, type RtaWireFrame } from "./live-codec.js";
import { liveConnection, type LiveChannel, type LiveStatus } from "./liveSocket.js";

// React hooks over liveSocket.ts. Handlers are kept in refs, so a component re-rendering never
// re-subscribes; only a change of topic or of the requested strips does.

export function useLiveStatus(channel: LiveChannel): LiveStatus {
  const connection = liveConnection(channel);
  const [status, setStatus] = useState<LiveStatus>(connection.getStatus());
  useEffect(() => {
    setStatus(connection.getStatus());
    return connection.onStatus(setStatus);
  }, [connection]);
  return status;
}

/**
 * Subscribes to a control topic (`wing:param-change`, `wing:connection`, `wing:cache-invalidated`).
 * `onReconnected` runs after the connection came back: events published while it was down were
 * missed, so state built from them should be reloaded.
 */
export function useLiveTopic<T>(topic: string, onEvent: (data: T) => void, onReconnected?: () => void): void {
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;
  const onReconnectedRef = useRef(onReconnected);
  onReconnectedRef.current = onReconnected;

  useEffect(() => {
    const connection = liveConnection("control");
    const unsubscribe = connection.subscribe(topic, { params: undefined, onEvent: (data) => onEventRef.current(data as T) });
    const offReconnected = connection.onReconnected(() => onReconnectedRef.current?.());
    return () => {
      unsubscribe();
      offReconnected();
    };
  }, [topic]);
}

export interface StripRef {
  type: string;
  index: number;
}

/** Every subscriber's strips, as one `wing:meters` subscription: "all" wins, otherwise the union. */
function mergeStrips(all: unknown[]): unknown {
  if (all.some((strips) => strips === "all")) return { strips: "all" };
  const seen = new Map<string, StripRef>();
  for (const strips of all as StripRef[][]) {
    for (const strip of strips) seen.set(`${strip.type}:${strip.index}`, { type: strip.type, index: strip.index });
  }
  return { strips: [...seen.values()].sort((a, b) => a.type.localeCompare(b.type) || a.index - b.index) };
}

/**
 * Meter readings for the given strips (or "all"), about 10 times a second. The connection carries
 * the union of what every mounted component asked for; each handler only sees its own strips.
 * Pass `null` to subscribe to nothing.
 */
export function useStripMeters(strips: StripRef[] | "all" | null, onReadings: (readings: MeterReading[]) => void): void {
  const onReadingsRef = useRef(onReadings);
  onReadingsRef.current = onReadings;
  const key = strips === null ? null : strips === "all" ? "all" : strips.map((s) => `${s.type}:${s.index}`).sort().join(",");

  useEffect(() => {
    if (key === null || strips === null) return;
    const wanted = strips === "all" ? null : new Set(strips.map((s) => `${s.type}:${s.index}`));
    return liveConnection("stream").subscribe(
      "wing:meters",
      {
        params: strips,
        onEvent: (data, ack) => {
          if (!ack) return;
          const readings = decodeMeterFrames(data as MetersWireFrame, ack as MetersAck);
          onReadingsRef.current(wanted ? readings.filter((r) => wanted.has(`${r.type}:${r.index}`)) : readings);
        },
      },
      mergeStrips,
    );
    // Keyed on `key`, which captures `strips`' content: the array itself is usually a fresh literal
    // on every render, and re-subscribing on each one would churn the wire.
  }, [key]);
}

export interface RtaFrame {
  bandsDb: Float32Array;
  receivedAt: number;
}

/**
 * The RTA spectrum, about 20 times a second, written into a ref rather than state: whoever draws
 * it (a canvas, on requestAnimationFrame) reads the latest frame without a React render per frame.
 * `hasData` flips once, when the first frame arrives.
 */
export function useRta(): { frameRef: MutableRefObject<RtaFrame | null>; hasData: boolean } {
  const frameRef = useRef<RtaFrame | null>(null);
  const [hasData, setHasData] = useState(false);
  useEffect(
    () =>
      liveConnection("stream").subscribe("wing:rta", {
        params: undefined,
        onEvent: (data) => {
          const frame = data as RtaWireFrame;
          frameRef.current = { bandsDb: decodeRtaBands(frame), receivedAt: frame.receivedAt };
          setHasData(true);
        },
      }),
    [],
  );
  return { frameRef, hasData };
}
