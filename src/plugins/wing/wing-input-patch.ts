import { WingValueError } from "./wing-errors.js";
import { resolveStripPath, type StripType } from "./wing-node-paths.js";
import type { WingPluginContext } from "./wing-plugin.js";
import { resolveAltSource, resolvePhysicalSource } from "./tools/physical-source.js";

/** Only channel/aux strips have a physical input to patch — bus/main/matrix/dca/mutegroup don't. */
export type InputPatchStripType = Extract<StripType, "channel" | "aux">;
export const INPUT_PATCH_STRIP_TYPES: readonly InputPatchStripType[] = ["channel", "aux"];

export type InputSlot = "main" | "alt";
export const INPUT_SLOTS: readonly InputSlot[] = ["main", "alt"];

function requireInputPatchStripType(type: string): asserts type is InputPatchStripType {
  if (type !== "channel" && type !== "aux") {
    throw new WingValueError(
      `Physical input patching only applies to channel/aux strips (only they have a physical input) — got "${type}".`,
    );
  }
}

export interface InputPatchOptions {
  type: InputPatchStripType;
  index: number;
}

export interface PhysicalSource {
  group: string;
  index: number;
}

export interface InputPatchStatus extends InputPatchOptions {
  main: PhysicalSource | null;
  alt: PhysicalSource | null;
  /** true = the Alt source is currently active, false = Main is active. */
  altActive: boolean;
  /**
   * `clink` — true = the strip's name (and, per the console UI, its other identity customization)
   * is linked to its connected physical source rather than kept independently; see
   * `resolveInputNameTarget()` in tools/physical-source.ts for the name-mirroring behavior. An
   * earlier pass wrongly assumed this was `in/set/srcauto` (a real, distinct OSC node whose actual
   * purpose is unrelated) — corrected 2026-08-28 from a live packet capture of the console app's
   * own "link customization to source" toggle, which sends `{path: "/ch/{n}/clink", value: "1"}`.
   * Kept the field/tool name `srcAuto` for API stability rather than renaming call sites.
   */
  srcAuto: boolean;
}

export interface InputPatchAck extends InputPatchOptions {
  ack: { status: string; ok: boolean; raw: string };
}

export interface SetInputConnectionOptions extends InputPatchOptions {
  slot: InputSlot;
  grp: string;
  in: number;
}

export interface SetAltSourceActiveOptions extends InputPatchOptions {
  active: boolean;
}

export interface SetSrcAutoOptions extends InputPatchOptions {
  linked: boolean;
}

export async function getInputPatch(ctx: WingPluginContext, opts: InputPatchOptions): Promise<InputPatchStatus> {
  requireInputPatchStripType(opts.type);
  const stripPath = resolveStripPath(opts.type, opts.index);
  const [main, alt, altsrc, srcauto] = await Promise.all([
    resolvePhysicalSource(ctx, stripPath),
    resolveAltSource(ctx, stripPath),
    ctx.client.get(`${stripPath}/in/set/altsrc`).catch(() => null),
    ctx.client.get(`${stripPath}/clink`).catch(() => null),
  ]);
  const altActive = altsrc !== null && altsrc.kind === "leaf" && Number(altsrc.value) === 1;
  const srcAuto = srcauto !== null && srcauto.kind === "leaf" && Number(srcauto.value) === 1;
  return { ...opts, main, alt, altActive, srcAuto };
}

/**
 * Patches a channel/aux's Main or Alt physical input source. `grp` is one of the console's physical
 * source groups (LCL, AUX, A/B/C AES50, SC, USB, CRD, MOD, PLAY, AES, USR, OSC, ...) — deliberately
 * not validated against a fixed enum here since, like `ioInPath`, group names and counts vary by
 * console model and are discovered live rather than hardcoded; an invalid group is rejected by the
 * console itself (ack.ok === false) rather than by this function. `in` is the 1-based physical input
 * index within that group, matching what `getInputPatch`/`resolvePhysicalSource` report back (they
 * decode the console's 0-based wire value via its `display` field) — confirm this round-trips
 * correctly during the feature's live test, since the Alt slot's encoding hasn't been independently
 * verified against real hardware the way Main's has.
 */
export async function setInputConnection(
  ctx: WingPluginContext,
  opts: SetInputConnectionOptions,
): Promise<InputPatchAck> {
  const { type, index, slot, grp, in: inputIndex } = opts;
  requireInputPatchStripType(type);
  if (!Number.isInteger(inputIndex) || inputIndex < 1) {
    throw new WingValueError(`Physical input index must be a positive integer (1-based) — got ${inputIndex}.`);
  }
  const basePath = `${resolveStripPath(type, index)}/in/conn`;
  const assignments: Record<string, string | number> =
    slot === "main" ? { grp, in: inputIndex } : { altgrp: grp, altin: inputIndex };
  const ack = await ctx.client.bulkSet(basePath, assignments);
  return { type, index, ack };
}

/**
 * Verified live against real hardware: `in/set/altsrc` only has any effect while the console-wide
 * `/io/altsw` switch is on — while it's off, every strip reads/behaves as Main regardless of its
 * own stored `altsrc` bit (a per-strip selection made while the global switch was off stays stored
 * but dormant, and re-surfaces once the global switch turns back on). Also verified live: writing
 * `active: true` (Main→Alt) reliably sticks, but on this firmware writing `active: false` back
 * (Alt→Main) did NOT take effect via any OSC write method tried (bulkSet, fire-and-forget set, or
 * the `toggle`/-1 convention) once a strip had already been switched to Alt — the console
 * acknowledges the write as OK without applying it. The only confirmed-reliable way to force Main
 * behavior console-wide is turning the global `/io/altsw` switch off via `setGlobalAltSwitch`.
 */
export async function setAltSourceActive(
  ctx: WingPluginContext,
  opts: SetAltSourceActiveOptions,
): Promise<InputPatchAck> {
  const { type, index, active } = opts;
  requireInputPatchStripType(type);
  const basePath = `${resolveStripPath(type, index)}/in/set`;
  const ack = await ctx.client.bulkSet(basePath, { altsrc: active ? 1 : 0 });
  return { type, index, ack };
}

/**
 * Sets `clink` — whether a channel/aux's name (and, per the console UI, its other identity
 * customization) is linked to its connected physical source. Linking it (true) means a future rename
 * via `wing_channel_set_name` silently redirects to renaming the source instead — see
 * `resolveInputNameTarget()` in tools/physical-source.ts, which already reads this same node for that
 * purpose but never writes it.
 */
export async function setSrcAuto(ctx: WingPluginContext, opts: SetSrcAutoOptions): Promise<InputPatchAck> {
  const { type, index, linked } = opts;
  requireInputPatchStripType(type);
  const basePath = resolveStripPath(type, index);
  const ack = await ctx.client.bulkSet(basePath, { clink: linked ? 1 : 0 });
  return { type, index, ack };
}

export interface GlobalAltSwitchStatus {
  on: boolean;
  autoOverride: boolean;
}

export interface GlobalAltSwitchAck {
  ack: { status: string; ok: boolean; raw: string };
}

export interface SetGlobalAltSwitchOptions {
  on?: boolean;
  autoOverride?: boolean;
}

/** Console-wide Alt switch — independent of any single channel/aux's own Main/Alt selector. */
export async function getGlobalAltSwitch(ctx: WingPluginContext): Promise<GlobalAltSwitchStatus> {
  const [altsw, autoaltovr] = await Promise.all([ctx.client.get("/io/altsw"), ctx.client.get("/io/autoaltovr")]);
  return {
    on: altsw.kind === "leaf" && Number(altsw.value) === 1,
    autoOverride: autoaltovr.kind === "leaf" && Number(autoaltovr.value) === 1,
  };
}

export async function setGlobalAltSwitch(
  ctx: WingPluginContext,
  opts: SetGlobalAltSwitchOptions,
): Promise<GlobalAltSwitchAck> {
  const assignments: Record<string, number> = {};
  if (opts.on !== undefined) assignments.altsw = opts.on ? 1 : 0;
  if (opts.autoOverride !== undefined) assignments.autoaltovr = opts.autoOverride ? 1 : 0;
  if (Object.keys(assignments).length === 0) {
    throw new WingValueError("Nothing to set — pass at least one of on/autoOverride.");
  }
  const ack = await ctx.client.bulkSet("/io", assignments);
  return { ack };
}
