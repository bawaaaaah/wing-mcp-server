import { useCallback, useRef, type JSX } from "react";
import { useStripMeters } from "../api/useLive.js";

// A thin horizontal level meter per mixer row. Readings are written straight to each row's element
// (a CSS variable) rather than through React state: forty rows re-rendering ten times a second
// would cost far more than the meters are worth.

const MIN_DB = -60;
const MAX_DB = 6;
/** How long a peak marker holds before it starts falling back to the current level. */
const PEAK_HOLD_MS = 1500;
/** How fast a released peak falls, in meter fractions per second (the whole scale in ~2s). */
const PEAK_FALL_PER_S = 0.5;

/** The level a mixer row shows: after the fader (so it follows fader and mute), else the first one. */
function rowLevelDb(values: Record<string, number | null>): number | null {
  for (const key of ["outputL_dB", "postFaderL_dB"]) {
    const v = values[key];
    if (typeof v === "number") return v;
  }
  for (const [key, v] of Object.entries(values)) if (key.endsWith("_dB") && typeof v === "number") return v;
  return null;
}

/**
 * Subscribes to the meters of `type` strips `indices` and returns a ref callback per index for the
 * row's `<StripMeter>`. `type` is the meter stream's name: channel, aux, bus, main, matrix, dca.
 */
export function useRowMeters(type: string, indices: number[]): (index: number) => (el: HTMLElement | null) => void {
  const elements = useRef(new Map<number, HTMLElement>());
  const peaks = useRef(new Map<number, { level: number; at: number }>());

  useStripMeters(
    indices.length > 0 ? indices.map((index) => ({ type, index })) : null,
    (readings) => {
      for (const reading of readings) {
        const el = elements.current.get(reading.index);
        const db = rowLevelDb(reading.values);
        if (!el || db === null) continue;
        const fraction = Math.min(1, Math.max(0, (db - MIN_DB) / (MAX_DB - MIN_DB)));
        el.style.setProperty("--level", fraction.toFixed(3));
        const now = performance.now();
        const peak = peaks.current.get(reading.index);
        // Where the marker would be now: held, then falling once the hold time is over.
        const falling = peak ? now - peak.at - PEAK_HOLD_MS : 0;
        const previous = peak ? (falling > 0 ? peak.level - (falling / 1000) * PEAK_FALL_PER_S : peak.level) : 0;
        let held = previous;
        if (fraction >= previous) {
          held = fraction;
          peaks.current.set(reading.index, { level: fraction, at: now });
        }
        el.style.setProperty("--peak", held.toFixed(3));
        el.classList.toggle("strip-meter--clip", held >= (0 - MIN_DB) / (MAX_DB - MIN_DB));
        el.title = db <= -144 ? "-∞ dB" : `${db.toFixed(1)} dB`;
      }
    },
  );

  return useCallback(
    (index: number) => (el: HTMLElement | null) => {
      if (el) elements.current.set(index, el);
      else elements.current.delete(index);
    },
    [],
  );
}

export function StripMeter({ meterRef }: { meterRef: (el: HTMLElement | null) => void }): JSX.Element {
  return <span className="strip-meter" ref={meterRef} aria-hidden="true" />;
}
