import type { CSSProperties, JSX } from "react";
interface SliderControlProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format?: (value: number) => string;
  onChange: (value: number) => void;
  disabled?: boolean;
  /** Where a double-click puts the slider back (unity gain, centre pan). No reset when omitted. */
  resetValue?: number;
  /** The slider's accessible name, when the visible label leans on its surroundings ("Gain" under "Band 2"). */
  ariaLabel?: string;
  /** Tick marks along the track, in slider units; a mark with a label prints it under the tick. */
  marks?: readonly { value: number; label?: string }[];
}

/**
 * Fully controlled — the caller owns the value (typically an optimistically-updated local map,
 * corrected later by the live "wing:param-change" topic) and decides how/when to actually write
 * it to the console (usually via useThrottledCommit).
 */
export function SliderControl({
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
  disabled,
  resetValue,
  ariaLabel = label,
  marks,
}: SliderControlProps): JSX.Element {
  const input = (
    <input
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      disabled={disabled}
      aria-label={ariaLabel}
      aria-valuetext={format ? format(value) : undefined}
      title={resetValue !== undefined ? `Double-click to reset to ${format ? format(resetValue) : resetValue}` : undefined}
      onDoubleClick={resetValue !== undefined && !disabled ? () => onChange(resetValue) : undefined}
      onChange={(event) => onChange(Number(event.target.value))}
    />
  );
  return (
    <div className="slider-control">
      <span className="slider-control__label">{label}</span>
      {marks ? (
        <span className="slider-control__track">
          {input}
          {marks.map((mark) => (
            <span
              key={mark.value}
              className={mark.label ? "slider-control__mark slider-control__mark--labelled" : "slider-control__mark"}
              style={{ "--at": (mark.value - min) / (max - min) } as CSSProperties}
              aria-hidden="true"
            >
              {mark.label}
            </span>
          ))}
        </span>
      ) : (
        input
      )}
      <span className="slider-control__value">{format ? format(value) : value}</span>
    </div>
  );
}

export function formatDb(value: number): string {
  return value <= -144 ? "-∞ dB" : value.toFixed(1) + " dB";
}

export function formatPan(value: number): string {
  if (value === 0) return "C";
  return value < 0 ? "L" + Math.abs(value) : "R" + value;
}

/**
 * Fader travel, as printed beside the WING's own faders (measured off its scale: +5 at 0.875, 0 at
 * 0.75, -10 at 0.5, -20 at 0.375, -30 at 0.25, -40 at 0.1875, -60 at 0.0625): the top quarter covers
 * +10…0 dB, the next 0…-10 dB, and the tail below gets less and less room, so unity sits three
 * quarters of the way up rather than at 94% of a straight -144…+10 line. Below -60 the scale only
 * prints -∞; the last stretch runs on to -90 here. Positions are 0…1, 0 being -∞ (-144 on the wire).
 */
const FADER_SEGMENTS = [
  { from: 0.5, dbPerUnit: 40, offset: -30 }, // -10 … +10 dB
  { from: 0.25, dbPerUnit: 80, offset: -50 }, // -30 … -10 dB
  { from: 0.0625, dbPerUnit: 160, offset: -70 }, // -60 … -30 dB
  { from: 0, dbPerUnit: 480, offset: -90 }, // -90 … -60 dB
] as const;
export const FADER_MIN_DB = -144;
export const FADER_MAX_DB = 10;
const FADER_STEPS = 1000;

export function faderDbToPosition(db: number): number {
  if (db <= -90) return 0;
  const clamped = Math.min(FADER_MAX_DB, db);
  for (const seg of FADER_SEGMENTS) {
    const position = (clamped - seg.offset) / seg.dbPerUnit;
    if (position >= seg.from) return position;
  }
  return 0;
}

export function faderPositionToDb(position: number): number {
  if (position <= 0) return FADER_MIN_DB;
  const seg = FADER_SEGMENTS.find((s) => position >= s.from) ?? FADER_SEGMENTS[FADER_SEGMENTS.length - 1];
  // Hundredths: near unity one step is 0.04 dB, so tenths would round a nudge straight back.
  return Math.round((position * seg.dbPerUnit + seg.offset) * 100) / 100;
}

/** The console's own graduations; only unity is numbered, the track is too short for the rest. */
const FADER_MARKS = [5, 0, -5, -10, -20, -30, -40, -50, -60].map((db) => ({
  value: faderDbToPosition(db) * FADER_STEPS,
  label: db === 0 ? "0" : undefined,
}));

/** A fader or send level in dB (-∞…+10), on the console's travel; double-click goes back to 0 dB. */
export function FaderControl({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: number;
  onChange: (db: number) => void;
  disabled?: boolean;
}): JSX.Element {
  const position = Math.round(faderDbToPosition(value) * FADER_STEPS);
  return (
    <SliderControl
      label={label}
      value={position}
      min={0}
      max={FADER_STEPS}
      step={1}
      disabled={disabled}
      marks={FADER_MARKS}
      resetValue={Math.round(faderDbToPosition(0) * FADER_STEPS)}
      // Untouched, show the console's own value rather than its round trip through a slider step.
      format={(p) => formatDb(p === position ? value : faderPositionToDb(p / FADER_STEPS))}
      onChange={(p) => onChange(faderPositionToDb(p / FADER_STEPS))}
    />
  );
}
