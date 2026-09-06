import { WingValueError } from "./wing-errors.js";
import { ioInPath } from "./wing-node-paths.js";
import type { WingBranchResult, WingBulkSetResult, WingGetResult } from "./wing-osc-client.js";
import { wingColorName, wingIconName } from "./wing-param-catalog.js";
import type { WingPluginContext } from "./wing-plugin.js";
import { assertColIconInRange } from "./wing-scribble.js";

/**
 * A physical input source's own console-surface identity + preamp settings, carried on
 * `/io/in/<GROUP>/<n>` (verified against real hardware — see the `/io/in/:group/:index` route doc
 * in http-routes.ts): `name` / `col` / `icon`, plus preamp `g` (gain trim, dB), `vph` (48V phantom),
 * `pol` (polarity invert), and `mute`.
 *
 * This is the same name/color/icon you assign to a channel/bus strip via `wing_set_scribble`, but on
 * the physical socket itself — and it is exactly what a channel/aux shows when its
 * name/customization is linked to its source (`clink`, see wing-input-patch.ts). Unlike a strip's
 * scribble there is NO `led`: a physical input has no scribble light.
 *
 * `gain` / `phantom48v` / `polarityInverted` / `mute` come back as `null` when the leaf does not
 * exist for that group (e.g. a digital input has no 48V) rather than being invented as a value.
 */
export interface SourceProps {
  group: string;
  index: number;
  name: string;
  col: number;
  colorName: string | undefined;
  icon: number;
  iconName: string | undefined;
  gain: number | null;
  phantom48v: boolean | null;
  polarityInverted: boolean | null;
  mute: boolean | null;
}

export interface SetSourcePropsOptions {
  group: string;
  index: number;
  name?: string;
  col?: number;
  icon?: number;
  gain?: number;
  phantom48v?: boolean;
  polarityInverted?: boolean;
  mute?: boolean;
}

export interface SourcePropsAck {
  group: string;
  index: number;
  ack: WingBulkSetResult;
}

function asLeaf(result: WingGetResult | WingBranchResult | null): WingGetResult | null {
  return result !== null && result.kind === "leaf" ? result : null;
}

function leafBool(result: WingGetResult | WingBranchResult | null): boolean | null {
  const leaf = asLeaf(result);
  return leaf ? Number(leaf.value) === 1 : null;
}

/**
 * Reads a physical input source's identity + preamp settings in one shot. Each leaf is fetched
 * independently and a missing/unreadable one degrades to a null-ish default rather than failing the
 * whole call (a given group may simply not expose `vph`/`pol`/etc.).
 */
export async function getSourceProps(ctx: WingPluginContext, group: string, index: number): Promise<SourceProps> {
  const base = ioInPath(group, index);
  const [nameR, colR, iconR, gR, vphR, polR, muteR] = await Promise.all([
    ctx.client.get(`${base}/name`).catch(() => null),
    ctx.client.get(`${base}/col`).catch(() => null),
    ctx.client.get(`${base}/icon`).catch(() => null),
    ctx.client.get(`${base}/g`).catch(() => null),
    ctx.client.get(`${base}/vph`).catch(() => null),
    ctx.client.get(`${base}/pol`).catch(() => null),
    ctx.client.get(`${base}/mute`).catch(() => null),
  ]);

  const nameLeaf = asLeaf(nameR);
  const colLeaf = asLeaf(colR);
  const iconLeaf = asLeaf(iconR);
  const gainLeaf = asLeaf(gR);

  // `col`'s wire "int" arg is 0-indexed while its `display` (and the console's 1..18 palette
  // numbering) is 1-indexed — read `display`, falling back to `value + 1`. Same off-by-one already
  // handled for strip scribble in getScribble() and for `in/conn/in` in tools/physical-source.ts.
  const col = colLeaf ? Number(colLeaf.display ?? Number(colLeaf.value) + 1) : 1;
  const icon = iconLeaf ? Number(iconLeaf.display ?? iconLeaf.value) : 0;

  return {
    group,
    index,
    name: nameLeaf ? String(nameLeaf.value) : "",
    col,
    colorName: wingColorName(col),
    icon,
    iconName: wingIconName(icon),
    gain: gainLeaf ? Number(gainLeaf.value) : null,
    phantom48v: leafBool(vphR),
    polarityInverted: leafBool(polR),
    mute: leafBool(muteR),
  };
}

/**
 * Sets any subset of a physical input source's name/color/icon/gain/48V/polarity/mute in one
 * ACK'd bulk-set on `/io/in/<group>/<n>`.
 *
 * The `group` is deliberately NOT validated against a fixed list — group names and counts vary by
 * console model and are discovered live, exactly like `setInputConnection` in wing-input-patch.ts.
 * An unknown group, or a `vph` write on a group with no phantom power, is rejected by the console
 * itself (`ack.ok === false`), not here.
 */
export async function setSourceProps(ctx: WingPluginContext, opts: SetSourcePropsOptions): Promise<SourcePropsAck> {
  const { group, index, name, col, icon, gain, phantom48v, polarityInverted, mute } = opts;

  if (
    name === undefined &&
    col === undefined &&
    icon === undefined &&
    gain === undefined &&
    phantom48v === undefined &&
    polarityInverted === undefined &&
    mute === undefined
  ) {
    throw new WingValueError(
      "At least one of name, col, icon, gain, phantom48v, polarityInverted, or mute must be provided.",
    );
  }
  if (!Number.isInteger(index) || index < 1) {
    throw new WingValueError(`Physical input index must be a positive integer (1-based) — got ${index}.`);
  }
  assertColIconInRange(col, icon);

  const assignments: Record<string, number | string> = {};
  if (name !== undefined) assignments.name = name;
  if (col !== undefined) assignments.col = col;
  if (icon !== undefined) assignments.icon = icon;
  if (gain !== undefined) assignments.g = gain;
  if (phantom48v !== undefined) assignments.vph = phantom48v ? 1 : 0;
  if (polarityInverted !== undefined) assignments.pol = polarityInverted ? 1 : 0;
  if (mute !== undefined) assignments.mute = mute ? 1 : 0;

  const ack = await ctx.client.bulkSet(ioInPath(group, index), assignments);
  return { group, index, ack };
}
