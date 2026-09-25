import { WingValueError } from "./wing-errors.js";
import { matrixPath } from "./wing-node-paths.js";
import type { WingPluginContext } from "./wing-plugin.js";
import type { ReportedValue } from "./wing-value-codec.js";

/** Matrix-exclusive "Direct Input" sub-mixer: taps a signal (AES or a monitor bus/phones/speaker
 * feed) directly into the matrix, ahead of its normal bus/main sends. */
export const MATRIX_DIR_IN_VALUES = ["OFF", "AES", "MON.PH", "MON.SPK", "MON.BUS"] as const;
export type MatrixDirIn = (typeof MATRIX_DIR_IN_VALUES)[number];

export interface MatrixDirectInputStatus {
  index: number;
  on: boolean;
  levelDb: number;
  invert: boolean;
  input: ReportedValue<MatrixDirIn>;
}

function asNumber(value: string | number | undefined, fallback = 0): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** Reads a matrix's Direct Input status: on/off, level (dB), invert, and source. */
export async function getMatrixDirectInput(ctx: WingPluginContext, index: number): Promise<MatrixDirectInputStatus> {
  const flat = await ctx.client.dump(matrixPath(index, "dir"));
  return {
    index,
    on: asNumber(flat.on) === 1,
    levelDb: asNumber(flat.lvl),
    invert: asNumber(flat.inv) === 1,
    input: flat.in === undefined ? "OFF" : String(flat.in),
  };
}

export interface SetMatrixDirectInputOptions {
  index: number;
  on?: boolean;
  levelDb?: number;
  invert?: boolean;
  input?: MatrixDirIn;
}

export interface MatrixDirectInputAck {
  index: number;
  ack: { status: string; ok: boolean; raw: string };
}

/** Sets a matrix's Direct Input on/off, level, invert, and/or source — any subset of the four. */
export async function setMatrixDirectInput(ctx: WingPluginContext, opts: SetMatrixDirectInputOptions): Promise<MatrixDirectInputAck> {
  const { index, on, levelDb, invert, input } = opts;
  if (on === undefined && levelDb === undefined && invert === undefined && input === undefined) {
    throw new WingValueError("At least one of on, levelDb, invert, or input must be provided.");
  }
  if (levelDb !== undefined && (levelDb < -144 || levelDb > 10)) {
    throw new WingValueError(`levelDb must be between -144 and 10 (got ${levelDb}).`);
  }
  if (input !== undefined && !MATRIX_DIR_IN_VALUES.includes(input)) {
    throw new WingValueError(`input must be one of ${MATRIX_DIR_IN_VALUES.join(", ")} (got ${input}).`);
  }
  const assignments: Record<string, number | string> = {};
  if (on !== undefined) assignments.on = on ? 1 : 0;
  if (levelDb !== undefined) assignments.lvl = levelDb;
  if (invert !== undefined) assignments.inv = invert ? 1 : 0;
  if (input !== undefined) assignments.in = input;
  const ack = await ctx.client.bulkSet(matrixPath(index, "dir"), assignments);
  return { index, ack };
}
