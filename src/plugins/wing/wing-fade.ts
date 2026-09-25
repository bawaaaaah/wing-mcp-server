import { WingValueError } from "./wing-errors.js";
import { applyEasing, requireEasingName, type EasingName } from "./wing-easing.js";
import { FADER_DB_MAX, FADER_DB_MIN } from "./wing-node-paths.js";
import { splitLeafPath } from "./tools/generic.js";
import type { WingPluginContext } from "./wing-plugin.js";

/**
 * Software fade engine shared by the dashboard's `/fade` HTTP route and the `wing_fade`/
 * `wing_fade_cancel` MCP tools. There is no native "fade" concept in the WING OSC protocol — this
 * ramps a fader-shaped leaf by issuing a burst of fire-and-forget `set()` writes on a timer, so
 * both surfaces must share one `activeFades` map: starting a fade on a path from either surface
 * must cancel whatever is already running there, rather than the two fighting over the same fader.
 */

export const FADE_STEP_MS = 50;
export const FADE_MIN_DURATION_MS = 100;
export const FADE_MAX_DURATION_MS = 60_000;
export const FADE_FLOOR_DB = FADER_DB_MIN;

/**
 * What a fade may ramp: faders, and the send/assign/direct-tap levels that share their -144..+10 dB
 * scale. Anything else — a preamp gain, a pan, an EQ band — would be driven with fader numbers it
 * does not understand, and the default fade-out target (-144) is nonsense for all of them.
 */
const FADEABLE_LEAF_RE = /\/(fdr|lvl)$/;

export interface FadeOptions {
  path: string;
  durationMs: number;
  direction: "in" | "out";
  /** Absolute target in dB — takes precedence over `deltaDb` if both are somehow sent. */
  to?: number;
  /** Relative target: resolves to (value read at fade start) + deltaDb. */
  deltaDb?: number;
  /** Progress-shaping curve applied to each intermediate step. Defaults to "linear" (constant rate). */
  easing?: EasingName;
}

export interface FadeStartResult {
  path: string;
  from: number;
  to: number;
  durationMs: number;
  steps: number;
  easing: EasingName;
}

/** Keyed by leaf path — at most one fade may run on a given fader at a time. */
const activeFades = new Map<string, { cancel: () => void }>();

/**
 * Ramps a fader-shaped leaf from its current value to a resolved target over `durationMs`, taking
 * one of three forms depending on what the caller supplied — an absolute target ("fade in to
 * 0dB"), a relative one ("fade out by -6dB"), or, when neither is given, a sensible default per
 * direction (0dB for "in", -oo for "out"). Intermediate steps use the fire-and-forget `set()`
 * primitive (not `bulkSet`) so a smooth ~20 steps/sec ramp doesn't monopolize the client's single
 * in-flight request queue while other controls are in use; the final step is a proper ACK'd
 * `bulkSet` so the resting value is guaranteed to have actually landed. Resolves as soon as the
 * ramp has started — callers get `{from, to, durationMs, steps, easing}` immediately, not once it
 * finishes. `easing` (default "linear") reshapes each step's progress fraction via wing-easing.ts
 * before interpolating from/to — there's no protocol-level notion of a curve, this is purely
 * client-side timing of the same set() bursts.
 */
export async function startFade(ctx: WingPluginContext, opts: FadeOptions): Promise<FadeStartResult> {
  const durationMs = Math.min(FADE_MAX_DURATION_MS, Math.max(FADE_MIN_DURATION_MS, opts.durationMs));
  const easing = opts.easing ?? "linear";
  requireEasingName(easing);
  const { path } = opts;
  if (!FADEABLE_LEAF_RE.test(path)) {
    throw new WingValueError(`wing_fade only ramps a fader or a send level (a path ending in /fdr or /lvl), not ${path}.`);
  }
  const { baseNode, key } = splitLeafPath(path);

  const current = await ctx.client.get(path);
  const from = current.kind === "leaf" ? Number(current.value) : NaN;
  if (!Number.isFinite(from)) {
    throw new WingValueError(`Current value at ${path} is not numeric — wing_fade only works on fader-shaped leaves.`);
  }

  const requested =
    typeof opts.to === "number"
      ? opts.to
      : typeof opts.deltaDb === "number"
        ? from + opts.deltaDb
        : opts.direction === "out"
          ? FADE_FLOOR_DB
          : 0;
  if (!Number.isFinite(requested)) {
    throw new WingValueError(`A fade target must be a number of dB (got ${requested}).`);
  }
  // Above the top of the scale is refused rather than clamped: "+20 dB" is a mistake worth saying
  // out loud, and every intermediate step would otherwise be sent unchecked. Below the floor is
  // simply the floor — "fade out by 200 dB" means all the way down.
  if (requested > FADER_DB_MAX) {
    throw new WingValueError(
      `A fade target of ${requested} dB is above the console's +${FADER_DB_MAX} dB maximum for ${path}.`,
    );
  }
  const target = Math.max(FADER_DB_MIN, requested);

  activeFades.get(path)?.cancel();

  const steps = Math.max(1, Math.round(durationMs / FADE_STEP_MS));
  let step = 0;

  const stop = (): void => {
    clearInterval(timer);
    if (activeFades.get(path)?.cancel === stop) activeFades.delete(path);
  };
  const timer = setInterval(() => {
    step++;
    const value = from + (target - from) * applyEasing(easing, step / steps);
    if (step >= steps) {
      stop();
      ctx.client.bulkSet(baseNode, { [key]: target }).catch((err) => {
        console.error(`[wing-fade] final bulkSet failed for ${path}:`, err);
      });
      return;
    }
    // Always a float: these are dB values, and a whole number of dB sent as an int is not the same
    // message. A failed send (the client was closed or replaced mid-fade) ends the fade on the spot,
    // once, instead of becoming an unhandled rejection every 50 ms for the rest of the ramp.
    ctx.client.set(path, value, { type: "f" }).catch((err: unknown) => {
      if (activeFades.get(path)?.cancel !== stop) return;
      stop();
      console.error(`[wing-fade] fade on ${path} stopped: a step could not be sent:`, err);
    });
  }, FADE_STEP_MS);
  timer.unref?.();
  activeFades.set(path, { cancel: stop });

  return { path, from, to: target, durationMs, steps, easing };
}

/**
 * Stops an in-progress fade on `path`, leaving the fader wherever it currently is rather than
 * snapping to either end. Returns whether a fade was actually running (a no-op cancel on an idle
 * path isn't an error — both call sites treat it as a successful, if unremarkable, cancellation).
 */
export function cancelFade(path: string): boolean {
  const existing = activeFades.get(path);
  if (!existing) return false;
  existing.cancel();
  return true;
}
