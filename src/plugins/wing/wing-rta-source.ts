import { WingValueError } from "./wing-errors.js";
import { AUX_COUNT, BUS_COUNT, CHANNEL_COUNT, MAIN_COUNT, MATRIX_COUNT } from "./wing-node-paths.js";
import type { WingPluginContext } from "./wing-plugin.js";

/**
 * `/cfg/rta/rtasrc` (and the read-only mirror `/cfg/rta/$src`) select what feeds the RTA using a
 * single flat "channel number" index (documented range 0..76, no accompanying enum/label list) —
 * the same 1..76 numbering the protocol reference reuses all over the control-surface assignment
 * tables (USER button/encoder targets, FSND's send-channel field, `$ctl/$stat/selidx`, etc.), so
 * it's a real, central convention, not an RTA-specific quirk.
 *
 * The reference does NOT publish a table saying which sub-range maps to which strip type. This
 * ordering is inferred, not officially confirmed, from converging evidence within the same
 * document:
 *  - The total (76) exactly matches CHANNEL_COUNT + AUX_COUNT + BUS_COUNT + MAIN_COUNT +
 *    MATRIX_COUNT (40+8+16+4+8).
 *  - `<OSC e_pattern>/ch` for FSND is explicitly documented as "I 1..48 Channel number" — 48 =
 *    40+8, confirming channels occupy 1..40 and aux immediately follows at 41..48.
 *  - `$ctl/layer/L/sel`'s bank list orders categories as Ch, Aux, Bus, Main, Matrix, (Dca) — the
 *    same relative order assumed here for the bus/main/matrix tail (49..64, 65..68, 69..76).
 * This has not been visually confirmed against a console screen (no camera/screen access from
 * this integration) — if it's ever found to be wrong, only the RTA_SOURCE_RANGES table below needs
 * to change; every caller goes through encode/decode rather than hardcoding offsets.
 */
export type RtaSourceType = "channel" | "aux" | "bus" | "main" | "matrix";

export const RTA_SOURCE_TYPES: readonly RtaSourceType[] = ["channel", "aux", "bus", "main", "matrix"];

export const RTA_SOURCE_PATH = "/cfg/rta/rtasrc";
export const RTA_TAP_PATH = "/cfg/rta/rtatap";

export interface RtaSource {
  type: RtaSourceType;
  index: number;
}

const RTA_SOURCE_RANGES: ReadonlyArray<{ type: RtaSourceType; count: number }> = [
  { type: "channel", count: CHANNEL_COUNT },
  { type: "aux", count: AUX_COUNT },
  { type: "bus", count: BUS_COUNT },
  { type: "main", count: MAIN_COUNT },
  { type: "matrix", count: MATRIX_COUNT },
];

export const RTA_SOURCE_INDEX_MAX = RTA_SOURCE_RANGES.reduce((sum, r) => sum + r.count, 0);

/** The console's documented tap-point enum for `/cfg/rta/rtatap` — verified live against real
 * hardware (matches `wing_describe` output exactly). */
export const RTA_TAP_VALUES = [
  "IN", "POST", "FILT", "PREEQ", "POSTEQ", "PREFDR", "GATEK", "DYNK", "DYNXO", "PRETAP", "SOLO",
  "MON.PH", "MON.SPK", "FXIN", "FXOUT",
] as const;
export type RtaTap = (typeof RTA_TAP_VALUES)[number];

/** Decodes a raw `rtasrc` value into a `{type, index}` pair. Returns `null` for 0 or any value
 * outside 1..RTA_SOURCE_INDEX_MAX — the console accepts 0 as a value (its meaning isn't documented;
 * possibly "none") but it doesn't decode to any real strip. */
export function decodeRtaSourceIndex(rawIndex: number): RtaSource | null {
  let offset = 0;
  for (const range of RTA_SOURCE_RANGES) {
    if (rawIndex > offset && rawIndex <= offset + range.count) {
      return { type: range.type, index: rawIndex - offset };
    }
    offset += range.count;
  }
  return null;
}

/** Encodes a `{type, index}` pair into the raw `rtasrc` value. Throws `WingValueError` if `index`
 * is out of range for `type`. */
export function encodeRtaSource(source: RtaSource): number {
  let offset = 0;
  for (const range of RTA_SOURCE_RANGES) {
    if (range.type === source.type) {
      if (!Number.isInteger(source.index) || source.index < 1 || source.index > range.count) {
        throw new WingValueError(`${source.type} index out of range for RTA source: ${source.index} (expected 1..${range.count})`);
      }
      return offset + source.index;
    }
    offset += range.count;
  }
  throw new WingValueError(`Unknown RTA source type: ${String(source.type)}`);
}

export interface RtaSourceStatus {
  rawIndex: number;
  source: RtaSource | null;
  tap: string | null;
}

export async function getRtaSource(ctx: WingPluginContext): Promise<RtaSourceStatus> {
  const [srcResult, tapResult] = await Promise.all([ctx.client.get(RTA_SOURCE_PATH), ctx.client.get(RTA_TAP_PATH)]);
  const rawIndex = srcResult.kind === "leaf" ? Number(srcResult.value) : NaN;
  const tap = tapResult.kind === "leaf" ? String(tapResult.value) : null;
  return { rawIndex, source: Number.isFinite(rawIndex) ? decodeRtaSourceIndex(rawIndex) : null, tap };
}

export interface SetRtaSourceResult {
  type: RtaSourceType;
  index: number;
  rawIndex: number;
  tap: RtaTap | null;
  status: string;
  ok: boolean;
  raw: string;
}

/** Sets the RTA's source and, if given, its tap point in a single bulk-set. Throws `WingValueError`
 * (via `encodeRtaSource`) for an out-of-range index. */
export async function setRtaSource(ctx: WingPluginContext, source: RtaSource, tap?: RtaTap): Promise<SetRtaSourceResult> {
  const rawIndex = encodeRtaSource(source);
  const assignments: Record<string, number | string> = { rtasrc: rawIndex };
  if (tap) assignments.rtatap = tap;
  const ack = await ctx.client.bulkSet("/cfg/rta", assignments);
  return { type: source.type, index: source.index, rawIndex, tap: tap ?? null, ...ack };
}
