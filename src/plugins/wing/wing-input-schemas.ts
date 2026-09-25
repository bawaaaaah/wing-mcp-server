// Input schemas shared by the MCP tools and the dashboard's REST routes that drive the same engines
// (auto-gain, auto-compress, auto-gate, auto-EQ, fade). Each is a zod raw shape: a tool spreads it
// into its `inputSchema`, a route wraps it in `z.object()` and parses the request body with it — so
// a value one side refuses, the other refuses too, instead of the REST side silently dropping it.
//
// Only the options carried in the request body live here. What a route takes from its URL (strip
// type, index, dynamics slot) stays in the tool's own schema and the route's own path parsing.

import { z } from "zod";
import { AUTO_EQ_MAX_ITERATIONS, AUTO_EQ_STRIP_TYPES } from "./wing-auto-eq.js";
import { EASING_NAMES, type EasingName } from "./wing-easing.js";
import { CUT_SLOPES } from "./wing-eq-math.js";
import { FADE_MAX_DURATION_MS, FADE_MIN_DURATION_MS } from "./wing-fade.js";
import { FADER_DB_MAX, FADER_DB_MIN } from "./wing-node-paths.js";

/** wing_auto_gain, POST /channels/:index/autogain and /aux/:index/autogain. */
export const autoGainOptionsShape = {
  targetDb: z.number().optional(),
  mode: z.enum(["gain", "trim", "both"]).optional(),
};

/** wing_auto_compress and the POST …/auto-compress routes. */
export const autoCompressOptionsShape = {
  // No fixed min/max: most thresholds are negative dB, but several models describe a positive
  // headroom (E88C `thr` -10..20, B560 -40..20) or a unitless `thr` altogether (B160 0.01..5
  // "logf", F670/2250 0..10) — runAutoCompress clamps to the control's own live range.
  thresholdDb: z.number().optional(),
  targetReductionDb: z.number().min(-80).max(0).optional(),
  targetMode: z.enum(["average", "peak"]).optional(),
  maxIterations: z
    .number()
    .int()
    .min(1)
    .max(15)
    .optional()
    .describe(
      "Measure-then-adjust rounds, default 5. Each round costs sampleMs + 200ms of settling, plus one " +
        "final verification sample — so the run lasts roughly (maxIterations + 1) x (sampleMs + 200ms). " +
        "A combination that would run past ~45s is refused rather than started.",
    ),
  // No fixed min/max: the input-drive control's units/range vary by model (dB -48..0 for 76LA,
  // unitless 0..10 for NSTR/L100/ONEC, 0..100 for LA-2A/LMT) — runAutoCompress clamps to the live range.
  inputGainDb: z.number().optional(),
  ratio: z.union([z.number(), z.string()]).optional(),
  sampleMs: z
    .number()
    .min(500)
    .max(15000)
    .optional()
    .describe("Length of each measurement window, default 3000. See maxIterations for what that costs."),
};

/** wing_auto_gate and the POST …/auto-gate routes. */
export const autoGateOptionsShape = {
  marginDb: z.number().min(0).max(40).optional(),
  sampleMs: z.number().min(500).max(20000).optional(),
};

const cutSchema = z.object({ hz: z.number().min(20).max(20000), slope: z.enum(CUT_SLOPES) }).optional();

/** wing_auto_eq_balance and POST /auto-eq-balance. */
export const autoEqBalanceShape = {
  micChannel: z.number().int().min(1).max(40),
  zones: z
    .array(
      z.object({
        type: z.enum(AUTO_EQ_STRIP_TYPES),
        index: z.number().int().min(1).max(16),
        fromHz: z.number().min(20).max(20000),
        toHz: z.number().min(20).max(20000),
        eq: z.enum(["auto", "geq", "peq"]).optional(),
        fxSlot: z.number().int().min(1).max(16).optional(),
        lowCut: cutSchema,
        highCut: cutSchema,
      }),
    )
    .min(1)
    .max(8),
  targetCurve: z.array(z.object({ hz: z.number().positive(), db: z.number().min(-24).max(24) })).optional(),
  maxBoostDb: z.number().min(0).max(15).optional(),
  maxCutDb: z.number().min(-15).max(0).optional(),
  iterations: z
    .number()
    .int()
    .min(1)
    .max(AUTO_EQ_MAX_ITERATIONS)
    .optional()
    .describe(
      "Measure-then-correct rounds, default 2. The run costs roughly (iterations + 2) x (sampleMs + " +
        "settling): one reference capture, one initial measurement, then one per round. A combination " +
        "that would run past ~45s is refused rather than started — lower this or sampleMs and call again, " +
        "which continues from the EQ the previous run left in place.",
    ),
  sampleMs: z
    .number()
    .min(1000)
    .max(20000)
    .optional()
    .describe("Length of each measurement window, default 4000. See iterations for what that costs."),
  apply: z.boolean().optional(),
  micCalibration: z.object({ name: z.string().min(1), orientation: z.union([z.literal(0), z.literal(90)]).optional() }).optional(),
  micCalibrationCurve: z.array(z.object({ hz: z.number().positive(), db: z.number() })).min(5).optional(),
};

/** wing_fade and POST /fade. */
export const fadeShape = {
  path: z.string().regex(/^\/.*\/(fdr|lvl)$/, "path must be a fader or send level, ending in /fdr or /lvl"),
  durationMs: z
    .number()
    .min(FADE_MIN_DURATION_MS)
    .max(FADE_MAX_DURATION_MS)
    .describe(`Fade duration in milliseconds (${FADE_MIN_DURATION_MS}..${FADE_MAX_DURATION_MS}).`),
  direction: z.enum(["in", "out"]),
  to: z
    .number()
    .min(FADER_DB_MIN)
    .max(FADER_DB_MAX)
    .optional()
    .describe(`Absolute target level in dB (${FADER_DB_MIN}..+${FADER_DB_MAX}). Takes precedence over deltaDb.`),
  deltaDb: z
    .number()
    .min(FADER_DB_MIN - FADER_DB_MAX)
    .max(FADER_DB_MAX - FADER_DB_MIN)
    .optional()
    .describe("Relative target: (level at fade start) + deltaDb. Refused if that lands above +10 dB."),
  easing: z
    .enum(EASING_NAMES as [EasingName, ...EasingName[]])
    .optional()
    .describe("Progress-shaping curve, default 'linear'."),
};
