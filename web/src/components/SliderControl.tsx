import type { JSX } from "react";
interface SliderControlProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format?: (value: number) => string;
  onChange: (value: number) => void;
  disabled?: boolean;
}

/**
 * Fully controlled — the caller owns the value (typically an optimistically-updated local map,
 * corrected later by the live "param-change" SSE stream) and decides how/when to actually write
 * it to the console (usually via useThrottledCommit).
 */
export function SliderControl({ label, value, min, max, step, format, onChange, disabled }: SliderControlProps): JSX.Element {
  return (
    <div className="slider-control">
      <span className="slider-control__label">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
      />
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
