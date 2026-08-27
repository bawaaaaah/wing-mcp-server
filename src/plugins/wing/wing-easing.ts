import { WingValueError } from "./wing-errors.js";

/**
 * Easing curves for `wing-fade.ts`'s software ramp. The WING protocol has no notion of a fade
 * curve — this is a pure client-side reshaping of the 0..1 progress fraction before it's applied
 * to the from/to interpolation, so the ramp's perceived speed can front-load, back-load, or
 * ease through the middle of the fade instead of moving at a constant rate.
 */
export type EasingName =
  | "linear"
  | "quad-in"
  | "quad-out"
  | "quad-in-out"
  | "cubic-in"
  | "cubic-out"
  | "cubic-in-out"
  | "sine-in"
  | "sine-out"
  | "sine-in-out"
  | "expo-in"
  | "expo-out"
  | "expo-in-out";

export const EASING_NAMES: readonly EasingName[] = [
  "linear",
  "quad-in",
  "quad-out",
  "quad-in-out",
  "cubic-in",
  "cubic-out",
  "cubic-in-out",
  "sine-in",
  "sine-out",
  "sine-in-out",
  "expo-in",
  "expo-out",
  "expo-in-out",
];

const EASING_FUNCTIONS: Record<EasingName, (t: number) => number> = {
  linear: (t) => t,
  "quad-in": (t) => t * t,
  "quad-out": (t) => 1 - (1 - t) * (1 - t),
  "quad-in-out": (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),
  "cubic-in": (t) => t * t * t,
  "cubic-out": (t) => 1 - Math.pow(1 - t, 3),
  "cubic-in-out": (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  "sine-in": (t) => 1 - Math.cos((t * Math.PI) / 2),
  "sine-out": (t) => Math.sin((t * Math.PI) / 2),
  "sine-in-out": (t) => -(Math.cos(Math.PI * t) - 1) / 2,
  "expo-in": (t) => (t === 0 ? 0 : Math.pow(2, 10 * t - 10)),
  "expo-out": (t) => (t === 1 ? 1 : 1 - Math.pow(2, -10 * t)),
  "expo-in-out": (t) => {
    if (t === 0) return 0;
    if (t === 1) return 1;
    return t < 0.5 ? Math.pow(2, 20 * t - 10) / 2 : (2 - Math.pow(2, -20 * t + 10)) / 2;
  },
};

export function requireEasingName(name: string): asserts name is EasingName {
  if (!Object.hasOwn(EASING_FUNCTIONS, name)) {
    throw new WingValueError(`Unknown easing curve "${name}" — expected one of: ${EASING_NAMES.join(", ")}.`);
  }
}

/** Reshapes a 0..1 progress fraction through `name`'s curve. `t` is clamped to 0..1 first. */
export function applyEasing(name: EasingName, t: number): number {
  const clamped = Math.min(1, Math.max(0, t));
  return EASING_FUNCTIONS[name](clamped);
}
