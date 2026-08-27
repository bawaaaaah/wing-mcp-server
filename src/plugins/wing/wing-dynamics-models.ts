// Shared classification for models loadable into a "gate" or "dyn" dynamics-processing slot — see
// wing-auto-compress.ts's header for why either slot can host any of these interchangeably.

import { DEFAULT_GAIN_REDUCTION_FULL_SCALE_DB } from "./wing-meter-protocol.js";

/**
 * Every gate/compressor/ducker-type model verified against real hardware so far (CMB, 76LA, SBUS,
 * NSTR, GATE, COMP, ...) can only ever *cut* — its gain-reduction reading is negative (or a slight
 * positive idle-detector wobble that isn't a real boost, see GAIN_REDUCTION_ACTIVE_EPSILON_DB in
 * dynamics-status.ts). A Dynamic EQ model is different: it can legitimately *boost* a detected band
 * as well as cut it, so a positive reading there is real, not idle noise, and must not be clamped
 * away or mislabeled as "reducing". Confirmed live: channel 3's gate slot reported model "DEQ2" for a
 * Dynamic EQ plugin. Prefix-matched (not an exact-string list) since the console's own catalog
 * explicitly doesn't enumerate the 30+ gate/dyn models individually (wing-param-catalog.ts), so other
 * numbered Dynamic EQ variants (DEQ1, DEQ3, ...) are assumed to share the same bidirectional behavior
 * rather than only ever matching the one variant actually seen live.
 */
const BIDIRECTIONAL_MODEL_PREFIXES = ["DEQ"];

/** Whether `mdl` (the gate/dyn slot's model, e.g. from `dump()`'s `mdl` field) is a model known to
 * legitimately boost as well as cut — see BIDIRECTIONAL_MODEL_PREFIXES above. Unknown/undefined
 * models default to cut-only, matching every model verified against real hardware except Dynamic EQ. */
export function isBidirectionalDynModel(mdl: string | number | undefined): boolean {
  if (mdl === undefined) return false;
  const upper = String(mdl).toUpperCase();
  return BIDIRECTIONAL_MODEL_PREFIXES.some((prefix) => upper.startsWith(prefix));
}

/**
 * A gate/dyn slot's dumped OSC settings, as returned by `WingOscClient.dump()` — e.g. `{on, mdl, thr,
 * range, ...}`. Untyped beyond that (the actual field set varies wildly per model — CMB has
 * `depth`/`ingain`/`cpeak`, 76LA has `in`/`out`, GATE has `range`, COMP has none of those — see
 * wing-auto-compress.ts's header and the per-model appendices in WING_Remote-Protocols-3.1-03.pdf).
 */
export type DynSlotSettings = Record<string, string | number>;

/**
 * `wing-meter-protocol.ts`'s `toGainReductionDb()` bakes in the protocol doc's DEFAULT full-scale
 * range for gate/dyn gain-reduction words (20dB — "For most of them 1.0 (256) maps to 20 dB gain
 * reduction", WING_Remote-Protocols-3.1-03.pdf p.98) because that parsing layer has no way to know
 * which model occupies a given slot (that's OSC-side info from an entirely separate connection, and
 * from a completely separate GET/dump() call at that). The doc calls out exactly one documented
 * exception: "Standard Wing gate is 60 dB" for the model named exactly `"GATE"` — but 60dB isn't a
 * fixed constant to hardcode: it's that model's own `range` parameter (describe()'d as 3..60dB,
 * user-adjustable) at its default/maximum. Reading the slot's *current* `range` value here instead of
 * assuming 60 means this stays correct if the range knob is ever turned down — the metering full-scale
 * tracks the model's own configured ceiling, not a snapshot of it. Every other model name (including
 * Dynamic EQ "DEQ"/"DEQ2", and any model without its own documented range knob) uses the 20dB default.
 *
 * Always call this with the slot's OWN freshly-dumped settings (fetched via `dump()` before sampling
 * the live meter, never cached from an earlier call) — the `mdl` and `range` fields it reads can both
 * change at any time (a different plugin loaded, or the range knob turned), and a stale correction
 * factor would silently mis-scale a live reading using a slot's PREVIOUS model/range.
 */
export function gainReductionFullScaleDb(settings: DynSlotSettings | undefined): number {
  if (!settings || settings.mdl === undefined || String(settings.mdl).toUpperCase() !== "GATE") {
    return DEFAULT_GAIN_REDUCTION_FULL_SCALE_DB;
  }
  const range = Number(settings.range);
  return Number.isFinite(range) ? range : 60;
}

/** Multiply an already-parsed `gateGain_dB`/`dynGain_dB` value (which assumed the meter protocol's
 * DEFAULT 20dB full-scale range) by this to correct it for the slot's actual model/range — see
 * `gainReductionFullScaleDb` above for why this needs the slot's live settings, not just `mdl`. */
export function gainReductionScaleCorrection(settings: DynSlotSettings | undefined): number {
  return gainReductionFullScaleDb(settings) / DEFAULT_GAIN_REDUCTION_FULL_SCALE_DB;
}
