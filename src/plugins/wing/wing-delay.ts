import { WingValueError } from "./wing-errors.js";
import { resolveStripPath, type StripType } from "./wing-node-paths.js";
import type { WingPluginContext } from "./wing-plugin.js";

/**
 * Channel/aux delay lives under `in/set/dly*` (it's part of the input stage), while bus/main/matrix
 * delay is its own `dly/*` node on the output — genuinely two different node shapes in the protocol
 * reference, not one builder with an optional suffix. `delayBaseNode`/`delayFieldKeys` below pick
 * the right one per type.
 */
export type DelayStripType = Extract<StripType, "channel" | "aux" | "bus" | "main" | "matrix">;
export const DELAY_STRIP_TYPES: readonly DelayStripType[] = ["channel", "aux", "bus", "main", "matrix"];

/** M(eters), FT(feet), MS(milliseconds), SMP(samples) — the unit `value` below is expressed in. */
export const DELAY_MODES = ["M", "FT", "MS", "SMP"] as const;
export type DelayMode = (typeof DELAY_MODES)[number];

const CHANNEL_AUX_TYPES: ReadonlySet<DelayStripType> = new Set(["channel", "aux"]);

function delayBaseNode(type: DelayStripType, index: number): string {
  const stripPath = resolveStripPath(type, index);
  return CHANNEL_AUX_TYPES.has(type) ? `${stripPath}/in/set` : `${stripPath}/dly`;
}

function delayFieldKeys(type: DelayStripType): { on: string; mode: string; value: string } {
  return CHANNEL_AUX_TYPES.has(type) ? { on: "dlyon", mode: "dlymode", value: "dly" } : { on: "on", mode: "mode", value: "dly" };
}

export interface DelayStatus {
  type: DelayStripType;
  index: number;
  on: boolean;
  mode: DelayMode;
  value: number;
}

function asMode(value: string | number | undefined): DelayMode {
  return (DELAY_MODES as readonly string[]).includes(String(value)) ? (value as DelayMode) : "M";
}

/**
 * Reads a strip's delay on/off, unit (mode), and value. `value`'s valid range depends on `mode` —
 * the protocol reference documents 0..150 for M(eters), 0.5..500 for FT/MS, 16..500 for SMP — this
 * doesn't clamp client-side, the console's own ack on `setDelay` reports rejection.
 */
export async function getDelay(ctx: WingPluginContext, type: DelayStripType, index: number): Promise<DelayStatus> {
  const baseNode = delayBaseNode(type, index);
  const keys = delayFieldKeys(type);
  const [onResult, modeResult, valueResult] = await Promise.all([
    ctx.client.get(`${baseNode}/${keys.on}`),
    ctx.client.get(`${baseNode}/${keys.mode}`),
    ctx.client.get(`${baseNode}/${keys.value}`),
  ]);
  const on = onResult.kind === "leaf" ? Number(onResult.value) === 1 : false;
  const mode = modeResult.kind === "leaf" ? asMode(modeResult.value) : "M";
  const value = valueResult.kind === "leaf" ? Number(valueResult.value) : 0;
  return { type, index, on, mode, value };
}

export interface SetDelayOptions {
  type: DelayStripType;
  index: number;
  on?: boolean;
  mode?: DelayMode;
  /** Raw delay amount in whatever unit `mode` selects (or the strip's current mode if omitted). */
  value?: number;
}

export interface DelayAck {
  type: DelayStripType;
  index: number;
  ack: { status: string; ok: boolean; raw: string };
}

/** Sets a strip's delay on/off, unit (mode), and/or value — any subset of the three. */
export async function setDelay(ctx: WingPluginContext, opts: SetDelayOptions): Promise<DelayAck> {
  const { type, index, on, mode, value } = opts;
  if (on === undefined && mode === undefined && value === undefined) {
    throw new WingValueError("At least one of on, mode, or value must be provided.");
  }
  const baseNode = delayBaseNode(type, index);
  const keys = delayFieldKeys(type);
  const assignments: Record<string, number | string> = {};
  if (on !== undefined) assignments[keys.on] = on ? 1 : 0;
  if (mode !== undefined) assignments[keys.mode] = mode;
  if (value !== undefined) assignments[keys.value] = value;
  const ack = await ctx.client.bulkSet(baseNode, assignments);
  return { type, index, ack };
}
