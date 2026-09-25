import { WingValueError } from "./wing-errors.js";
import type { WingBulkSetResult } from "./wing-osc-client.js";
import { resolveStripPath, type StripType } from "./wing-node-paths.js";
import type { WingPluginContext } from "./wing-plugin.js";
import { wingColorName, wingIconName } from "./wing-param-catalog.js";

/**
 * Scribble strip identity — `led` (scribble light on/off), `col` (palette color), and `icon` — is
 * already catalogued in wing-param-catalog.ts as individual leaves for wing_get/wing_set, but never
 * exposed as one validated call. Verified against docs/WING_Remote-Protocols-3.1-03.pdf that every
 * strip type carries all three EXCEPT mutegroup, which only has `name`/`mute` — no scribble light,
 * color, or icon field at all.
 */
export type ScribbleStripType = Exclude<StripType, "mutegroup">;
export const SCRIBBLE_STRIP_TYPES: readonly ScribbleStripType[] = ["channel", "aux", "bus", "main", "matrix", "dca"];

export interface ScribbleStatus {
  type: ScribbleStripType;
  index: number;
  led: number;
  col: number;
  colorName: string | undefined;
  icon: number;
  iconName: string | undefined;
}

/** Reads a strip's scribble light on/off, color, and icon in one call. */
export async function getScribble(ctx: WingPluginContext, type: ScribbleStripType, index: number): Promise<ScribbleStatus> {
  const basePath = resolveStripPath(type, index);
  const [ledResult, colResult, iconResult] = await Promise.all([
    ctx.client.get(`${basePath}/led`),
    ctx.client.get(`${basePath}/col`),
    ctx.client.get(`${basePath}/icon`),
  ]);
  const led = ledResult.kind === "leaf" ? Number(ledResult.display ?? ledResult.value) : 0;
  // 1-based, as displayed: `value` is decoded from the display string (decodeIntReply).
  const col = colResult.kind === "leaf" ? Number(colResult.value) : 1;
  const icon = iconResult.kind === "leaf" ? Number(iconResult.display ?? iconResult.value) : 0;
  return { type, index, led, col, colorName: wingColorName(col), icon, iconName: wingIconName(icon) };
}

/**
 * Shared 1..18 `col` / 0..999 `icon` range guard. Used by `setScribble` (strips) and
 * `setSourceProps` (physical inputs, wing-source.ts) so the two paths reject the same
 * out-of-range values with the same message.
 */
export function assertColIconInRange(col?: number, icon?: number): void {
  if (col !== undefined && (!Number.isInteger(col) || col < 1 || col > 18)) {
    throw new WingValueError(`col must be an integer between 1 and 18 (got ${col}).`);
  }
  if (icon !== undefined && (!Number.isInteger(icon) || icon < 0 || icon > 999)) {
    throw new WingValueError(`icon must be an integer between 0 and 999 (got ${icon}).`);
  }
}

export interface SetScribbleOptions {
  type: ScribbleStripType;
  index: number;
  led?: number;
  col?: number;
  icon?: number;
}

export interface ScribbleAck {
  type: ScribbleStripType;
  index: number;
  ack: WingBulkSetResult;
}

/** Sets any subset of a strip's scribble light on/off, color, and icon in a single bulk-set call. */
export async function setScribble(ctx: WingPluginContext, opts: SetScribbleOptions): Promise<ScribbleAck> {
  const { type, index, led, col, icon } = opts;
  if (led === undefined && col === undefined && icon === undefined) {
    throw new WingValueError("At least one of led, col, or icon must be provided.");
  }
  if (led !== undefined && (!Number.isInteger(led) || led < 0 || led > 1)) {
    throw new WingValueError(`led must be 0 or 1 (got ${led}).`);
  }
  assertColIconInRange(col, icon);
  const basePath = resolveStripPath(type, index);
  const assignments: Record<string, number> = {};
  if (led !== undefined) assignments.led = led;
  if (col !== undefined) assignments.col = col;
  if (icon !== undefined) assignments.icon = icon;
  const ack = await ctx.client.bulkSet(basePath, assignments);
  return { type, index, ack };
}
