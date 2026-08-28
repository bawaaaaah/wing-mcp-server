import { resolvePhysicalSource } from "./tools/physical-source.js";
import { WingUnavailableError, WingValueError } from "./wing-errors.js";
import { auxPath, channelPath, ioInPath } from "./wing-node-paths.js";
import { parseWingDescribeParams } from "./wing-value-codec.js";
import type { WingPluginContext } from "./wing-plugin.js";

/**
 * Auto Gain: samples a channel/aux's own live meter (the only meter type/index verified against
 * real hardware to be reliable — see the abandoned "source" meter investigation in the session
 * notes for why a physical input isn't sampled directly) and adjusts a trim/gain field so its peak
 * lands on `targetDb`. Used for a channel/aux's own digital input trim (`in/set.trim`, range
 * ±18dB) and, via a physical input's own node path, for its analog preamp gain (`io/in/<group>/
 * <n>.g`, range -2.5..45dB) — same sampling/safety logic either way, just a different field and a
 * caller-supplied meter to watch.
 *
 * This is NOT the channel's gate/dynamics/compressor block (thr/depth/fast/cmode etc.) — those are
 * a separate processing stage with no "auto" mode of their own on this console. Auto Gain only ever
 * touches the input trim/preamp gain stage, which is what "automatic gain" means for this console.
 *
 * Originally lived inline in http-routes.ts (the dashboard's Auto Gain button); extracted so the
 * `wing_auto_gain` MCP tool can share the exact same algorithm instead of an AI having to
 * reconstruct it (or worse, guess at gate/dyn fields — verified to produce STACK EMPTY/NODE NOT
 * FOUND acks, since those fields don't do what "automatic gain" implies).
 */
export const AUTOGAIN_DEFAULT_TARGET_DB = -18;
const AUTOGAIN_SAMPLE_WINDOW_MS = 1200;
/**
 * Hard floor against acting on a strip with nothing meaningful plugged in — verified against real
 * hardware that an unpatched/silent input reads a flat -128dB (the meter's actual digital floor,
 * int16 min / 256). Below this, treat it as "nothing connected" rather than "very quiet", since
 * blindly computing an adjustment from noise-floor readings would produce a large, meaningless
 * jump the moment real signal does show up.
 */
const AUTOGAIN_NO_SIGNAL_FLOOR_DB = -90;
/**
 * A quiet-but-real signal is not itself a reason to give up — that is exactly what a wide-range
 * preamp gain field (-2.5..45dB) is for: a soft-spoken talker into an insensitive talkback mic can
 * legitimately need gain well past +37dB, and clamping at `fieldMax` (see below) already reports
 * that honestly via `clamped: true` rather than silently overshooting. What *is* still worth
 * rejecting is a signal so quiet that maxing out this field's own range wouldn't get anywhere near
 * a usable level — that's this floor, checked against the *achievable* level (peak + remaining
 * headroom to fieldMax), not the raw measured peak.
 */
const AUTOGAIN_UNREACHABLE_FLOOR_DB = -50;

export const TRIM_FALLBACK_RANGE: readonly [number, number] = [-18, 18];
export const GAIN_FALLBACK_RANGE: readonly [number, number] = [-2.5, 45];

function asNumber(value: string | number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export interface AutoGainOptions {
  targetNodePath: string;
  fieldKey: string;
  fieldFallbackRange: readonly [number, number];
  meterType: "channel" | "aux";
  meterIndex: number;
  targetDb?: number;
}

export interface AutoGainResult {
  measuredPeakDb: number;
  targetDb: number;
  oldValue: number;
  newValue: number;
  clamped: boolean;
  ack: { status: string; ok: boolean; raw: string };
}

/** Throws `WingUnavailableError`/`WingValueError` on failure — never returns a partial/error result. */
export async function runAutoGain(ctx: WingPluginContext, opts: AutoGainOptions): Promise<AutoGainResult> {
  const targetDb = opts.targetDb ?? AUTOGAIN_DEFAULT_TARGET_DB;
  let [fieldMin, fieldMax] = opts.fieldFallbackRange;

  const [description, values] = await Promise.all([
    ctx.client.describe(opts.targetNodePath),
    ctx.client.dump(opts.targetNodePath),
  ]);
  const fieldParam = parseWingDescribeParams(description.lines).find((p) => p.key === opts.fieldKey);
  if (fieldParam?.min !== undefined) fieldMin = fieldParam.min;
  if (fieldParam?.max !== undefined) fieldMax = fieldParam.max;
  const currentValue = asNumber(values[opts.fieldKey], 0);

  let peakDb = -Infinity;
  let sampleCount = 0;
  const onSnapshot = (snapshot: { frames: Array<Record<string, unknown>> }) => {
    for (const frame of snapshot.frames) {
      if (frame.type === opts.meterType && frame.index === opts.meterIndex) {
        sampleCount++;
        peakDb = Math.max(peakDb, Number(frame.inputL_dB), Number(frame.inputR_dB));
      }
    }
  };
  // Captured once: ctx.meterClient is a live getter that can re-resolve to a new instance across
  // this await (a host/config change mid-sample) — see wing-auto-compress.ts's sampleReduction for
  // the same fix and full rationale.
  const meterClient = ctx.meterClient;
  meterClient.on("snapshot", onSnapshot);
  await new Promise((resolve) => setTimeout(resolve, AUTOGAIN_SAMPLE_WINDOW_MS));
  meterClient.off("snapshot", onSnapshot);

  if (sampleCount === 0) {
    throw new WingUnavailableError("No live meter data received for this input — is the meter client connected?");
  }
  if (peakDb <= AUTOGAIN_NO_SIGNAL_FLOOR_DB) {
    throw new WingValueError(
      `No signal detected (measured peak ${peakDb.toFixed(1)} dB, at the meter's digital floor) — check that a source is actually connected and active before running Auto Gain.`,
    );
  }

  const delta = targetDb - peakDb;
  const rawNewValue = currentValue + delta;
  const newValue = Math.min(fieldMax, Math.max(fieldMin, rawNewValue));

  const achievableDb = peakDb + (fieldMax - currentValue);
  if (achievableDb <= AUTOGAIN_UNREACHABLE_FLOOR_DB) {
    throw new WingValueError(
      `Signal is present but too low (measured peak ${peakDb.toFixed(1)} dB) to reach a usable level even at ` +
        `this field's max (${fieldMax}) — raise the source level, check routing, or verify the mic/preamp itself ` +
        `before running Auto Gain again.`,
    );
  }

  const ack = await ctx.client.bulkSet(opts.targetNodePath, { [opts.fieldKey]: Number(newValue.toFixed(1)) });
  return {
    measuredPeakDb: peakDb,
    targetDb,
    oldValue: currentValue,
    newValue: Number(newValue.toFixed(1)),
    clamped: newValue !== rawNewValue,
    ack,
  };
}

export type AutoGainMode = "gain" | "trim" | "both";

export interface CombinedAutoGainOptions {
  type: "channel" | "aux";
  index: number;
  targetDb?: number;
  mode?: AutoGainMode;
}

export interface CombinedAutoGainResult {
  mode: AutoGainMode;
  physicalSource: { group: string; index: number } | null;
  gain: AutoGainResult | null;
  trim: AutoGainResult | null;
  /** True once gain has done its work and reached the target without help — trim was zeroed and left there. */
  trimLeftAtZero: boolean;
}

/**
 * The full Auto Gain behavior: gain-staging first, trim only "as needed". Shared by the
 * `wing_auto_gain` MCP tool and the dashboard's channel/aux Auto Gain button so both surfaces
 * behave identically — see `runAutoGain()` above for the single-field algorithm this orchestrates
 * twice (once for the connected physical input's preamp gain, once for the strip's own trim).
 *
 * Default mode "both": if a physical input is routed, zero the strip's digital trim first (so it
 * doesn't bias the gain measurement), then adjust that input's preamp gain (-2.5..45dB) alone to
 * get as close to `targetDb` as that range allows. Trim only steps in afterward if gain came back
 * clamped (couldn't fully reach target) or there's no physical input to run a gain pass on at all
 * — in both cases trim raises or lowers to make up the remainder. A failed gain pass (no/low
 * signal) restores the strip's original trim rather than leaving it quieter than before the
 * attempt. mode "gain"/"trim" restrict it to just that one stage; mode "gain" never touches trim
 * (not even a reset) and errors if no physical input is routed.
 */
export async function runCombinedAutoGain(
  ctx: WingPluginContext,
  opts: CombinedAutoGainOptions,
): Promise<CombinedAutoGainResult> {
  const stripPath = opts.type === "channel" ? channelPath(opts.index) : auxPath(opts.index);
  const mode = opts.mode ?? "both";
  const physicalSource = mode === "trim" ? null : await resolvePhysicalSource(ctx, stripPath);

  if (mode === "gain" && !physicalSource) {
    throw new WingValueError(
      `${opts.type} ${opts.index} has no physical input routed (source is OFF, or its routing couldn't be ` +
        `read) — nothing to adjust gain on. Use mode: "trim" instead, or connect/select a source first.`,
    );
  }

  let gain: AutoGainResult | null = null;
  let trim: AutoGainResult | null = null;

  if (mode !== "trim" && physicalSource) {
    const trimBefore = await ctx.client.get(`${stripPath}/in/set/trim`);
    const originalTrim = trimBefore.kind === "leaf" ? Number(trimBefore.value) : 0;
    await ctx.client.bulkSet(`${stripPath}/in/set`, { trim: 0 });
    try {
      gain = await runAutoGain(ctx, {
        targetNodePath: ioInPath(physicalSource.group, physicalSource.index),
        fieldKey: "g",
        fieldFallbackRange: GAIN_FALLBACK_RANGE,
        meterType: opts.type,
        meterIndex: opts.index,
        targetDb: opts.targetDb,
      });
    } catch (err) {
      await ctx.client.bulkSet(`${stripPath}/in/set`, { trim: originalTrim }).catch(() => {});
      throw err;
    }
  }

  const needsTrim = mode === "trim" || (mode === "both" && (!physicalSource || gain?.clamped));
  if (needsTrim) {
    trim = await runAutoGain(ctx, {
      targetNodePath: `${stripPath}/in/set`,
      fieldKey: "trim",
      fieldFallbackRange: TRIM_FALLBACK_RANGE,
      meterType: opts.type,
      meterIndex: opts.index,
      targetDb: opts.targetDb,
    });
  }

  return { mode, physicalSource, gain, trim, trimLeftAtZero: gain !== null && trim === null };
}
