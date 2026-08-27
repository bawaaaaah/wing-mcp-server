import { WingUnavailableError, WingValueError } from "./wing-errors.js";
import { resolveStripPath } from "./wing-node-paths.js";
import { parseWingDescribeParams } from "./wing-value-codec.js";
import type { WingPluginContext } from "./wing-plugin.js";

/**
 * Auto Gate: measures a dynamics-processing slot's own detector ("key") level against real program
 * material to work out a sensible gate threshold automatically, instead of the caller having to guess
 * one — the console has no such "auto" mode of its own (same gap `wing-autogain.ts`/
 * `wing-auto-compress.ts` fill for other dynamics controls). Samples the slot's "key" field — what
 * THIS gate's own detector sees, post-sidechain-filter if any, the same reference a person tuning a
 * gate by watching its meter would use — over a window, splits the resulting distribution into a
 * "noise floor" (a low percentile — the quiet moments: room tone, bleed, breath) and a "signal peak"
 * (a high percentile — the loud moments: the actual wanted signal), and sets the threshold
 * `marginDb` above the noise floor so the gate opens for real signal and stays shut during
 * quiet/bleed. "gate" and "dyn" are both generic dynamics-processing slots on this console (see
 * wing-auto-compress.ts's header for why) — `block` picks which to drive, defaulting to "gate" (the
 * conventional placement), but a gate/ducker-type model loaded into "dyn" works identically. Not
 * every model has a settable "thr" field (see wing-auto-compress.ts's same check) — this fails
 * clearly, naming the model and listing its real parameters, rather than guessing.
 */
export type AutoGateType = "channel" | "aux" | "bus" | "main" | "matrix";
export type AutoGateBlock = "gate" | "dyn";

const AUTO_GATE_DEFAULT_SAMPLE_MS = 4000;
/** Gives the console a moment to start applying the new threshold before any caller re-samples. */
export const AUTO_GATE_SETTLE_MS = 200;
/** How far above the measured noise floor to place the new threshold, in dB — enough margin that
 * ordinary jitter in the noise floor doesn't cause chattering, without eating into quiet wanted
 * signal. A real hardware/software auto-gate feature typically defaults somewhere in this range. */
const AUTO_GATE_DEFAULT_MARGIN_DB = 6;
/** Percentile used for "noise floor" (low) and "signal peak" (high) instead of bare min/max — robust
 * against a handful of outlier samples (a brief dropout, one unusually loud transient) that a min/max
 * would be fully at the mercy of. */
const AUTO_GATE_NOISE_FLOOR_PERCENTILE = 0.2;
const AUTO_GATE_SIGNAL_PEAK_PERCENTILE = 0.9;
/** Below this gap between measured noise floor and signal peak, the program material during the
 * sampling window didn't have a clear enough quiet/loud contrast to set a confident threshold from —
 * mirrors AUTO_COMPRESS_NO_SIGNAL_FLOOR_DB's "don't guess from ambiguous data" reasoning. */
const AUTO_GATE_MIN_DYNAMIC_RANGE_DB = 6;

const BLOCK_METER_FIELDS: Record<AutoGateBlock, { keyField: string }> = {
  gate: { keyField: "gateKey_dB" },
  dyn: { keyField: "dynKey_dB" },
};

function asNumber(value: string | number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** `sorted` must already be ascending. Rounds to the nearest sample rather than interpolating —
 * plenty precise for a margin-based threshold, and avoids inventing a value no sample actually had. */
function percentile(sorted: number[], p: number): number {
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
  return sorted[idx];
}

export interface AutoGateOptions {
  type: AutoGateType;
  index: number;
  /** Which dynamics-processing slot to drive — defaults to "gate", the conventional placement, but
   * "dyn" is equally valid if that's where a gate/ducker-type model is loaded. */
  block?: AutoGateBlock;
  /** dB above the measured noise floor to place the new threshold. Defaults to 6dB. */
  marginDb?: number;
  sampleMs?: number;
}

export interface AutoGateResult {
  type: AutoGateType;
  index: number;
  block: AutoGateBlock;
  model: string | undefined;
  wasOn: boolean;
  measured: { noiseFloorDb: number; signalPeakDb: number; marginDb: number; sampleCount: number; sampleMs: number };
  threshold: { old: number; new: number; clamped: boolean };
  ack: { status: string; ok: boolean; raw: string };
}

/**
 * Throws `WingUnavailableError`/`WingValueError` on failure — nothing is changed on the console
 * unless a confident threshold was actually computed and successfully written.
 */
export async function runAutoGate(ctx: WingPluginContext, opts: AutoGateOptions): Promise<AutoGateResult> {
  const block = opts.block ?? "gate";
  if (block === "gate" && opts.type !== "channel") {
    throw new WingValueError(
      `The "gate" slot only exists on channel strips — ${opts.type} strips only have the "dyn" slot. Use ` +
        `block: "dyn" (or omit block), or type: "channel".`,
    );
  }
  const blockPath = `${resolveStripPath(opts.type, opts.index)}/${block}`;
  const keyField = BLOCK_METER_FIELDS[block].keyField;
  const sampleMs = opts.sampleMs ?? AUTO_GATE_DEFAULT_SAMPLE_MS;
  const marginDb = opts.marginDb ?? AUTO_GATE_DEFAULT_MARGIN_DB;

  const [description, values] = await Promise.all([ctx.client.describe(blockPath), ctx.client.dump(blockPath)]);
  const describeParams = parseWingDescribeParams(description.lines);
  const model = values.mdl !== undefined ? String(values.mdl) : undefined;

  // Same reasoning as wing-auto-compress.ts's equivalent check: not every gate/dyn model has a "thr"
  // field (e.g. 76LA/LA/NSTR/WAVE/ECL33/LMT/ONEC/L100/DS902 don't) — auto gate needs one to work at
  // all, so fail clearly against this model's actual live describe() instead of a hand-maintained
  // model->field table or a cryptic console rejection.
  const thrParam = describeParams.find((p) => p.key === "thr");
  if (!thrParam) {
    throw new WingValueError(
      `Model ${model ?? "(unknown)"} on ${opts.type} ${opts.index} ${block} has no "thr" field — auto gate needs ` +
        `a settable threshold, and this model doesn't have one. Available parameters: ` +
        `${describeParams.map((p) => p.key).join(", ")}.`,
    );
  }
  const thrMin = thrParam.min ?? -80;
  const thrMax = thrParam.max ?? 0;

  const wasOn = asNumber(values.on, 0) === 1;
  const oldThreshold = asNumber(values.thr, 0);

  const keySamples: number[] = [];
  const onSnapshot = (snapshot: { frames: Array<Record<string, unknown>> }) => {
    for (const frame of snapshot.frames) {
      if (frame.type === opts.type && frame.index === opts.index) {
        keySamples.push(Number(frame[keyField]));
      }
    }
  };
  ctx.meterClient.on("snapshot", onSnapshot);
  await new Promise((resolve) => setTimeout(resolve, sampleMs));
  ctx.meterClient.off("snapshot", onSnapshot);

  if (keySamples.length === 0) {
    throw new WingUnavailableError(
      `No live meter data was received for ${opts.type} ${opts.index} — is the meter client connected? ` +
        `Threshold was left unchanged.`,
    );
  }

  const sorted = [...keySamples].sort((a, b) => a - b);
  const noiseFloorDb = percentile(sorted, AUTO_GATE_NOISE_FLOOR_PERCENTILE);
  const signalPeakDb = percentile(sorted, AUTO_GATE_SIGNAL_PEAK_PERCENTILE);

  if (signalPeakDb - noiseFloorDb < AUTO_GATE_MIN_DYNAMIC_RANGE_DB) {
    throw new WingValueError(
      `${opts.type} ${opts.index}'s input didn't show a clear enough difference between quiet and loud moments ` +
        `while sampling (noise floor ${noiseFloorDb.toFixed(1)}dB, peak ${signalPeakDb.toFixed(1)}dB, only ` +
        `${(signalPeakDb - noiseFloorDb).toFixed(1)}dB apart) to set a confident threshold — send representative ` +
        `program material (talking/singing with real pauses, not a constant tone) and try again. Threshold was ` +
        `left unchanged.`,
    );
  }

  const rawNewThreshold = noiseFloorDb + marginDb;
  const newThreshold = Math.min(thrMax, Math.max(thrMin, rawNewThreshold));
  const roundedThreshold = Number(newThreshold.toFixed(1));

  const ack = await ctx.client.bulkSet(blockPath, { thr: roundedThreshold, on: 1 });

  return {
    type: opts.type,
    index: opts.index,
    block,
    model,
    wasOn,
    measured: { noiseFloorDb, signalPeakDb, marginDb, sampleCount: keySamples.length, sampleMs },
    threshold: { old: oldThreshold, new: roundedThreshold, clamped: newThreshold !== rawNewThreshold },
    ack,
  };
}
