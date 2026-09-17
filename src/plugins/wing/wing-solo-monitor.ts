import { WingValueError } from "./wing-errors.js";
import { AUX_COUNT, BUS_COUNT, CHANNEL_COUNT, MAIN_COUNT, MATRIX_COUNT, resolveStripPath, type StripType } from "./wing-node-paths.js";
import type { WingBulkSetResult, WingGetResult } from "./wing-osc-client.js";
import type { WingPluginContext } from "./wing-plugin.js";

/**
 * "Control room" solo & monitoring: the per-strip solo switch, the global solo-behavior config node
 * (`/cfg/solo`), and the two control-room monitor buses (`/cfg/mon/1` = Monitor A, `/cfg/mon/2` =
 * Monitor B). Verified against `docs/WING_Remote-Protocols-3.1-03.pdf` (p.33-35).
 *
 * Monitor bus EQ (`/cfg/mon/{1,2}/eq/*`, 23 leaves) is deliberately NOT modeled here — it's a plain
 * parametric EQ, readable/writable via the generic `wing_get`/`wing_set`/`wing_dump` tools, so a
 * dedicated wrapper would add validation/UX value nowhere near what the per-strip and config-node
 * fields below need. Its shape is its own, though (confirmed live 2026-09-16): `on`, six full bands
 * (`1g/1f/1q` .. `6g/6f/6q`) and two TRUE shelves — `lsg`/`lsf` (20 Hz - 2 kHz) and `hsg`/`hsf`
 * (200 Hz - 20 kHz), with no Q and no band-type selector, plus no `mdl`, `mix` or `tilt`. So it is
 * NOT the same node shape as a channel EQ (`lg/lf/lq/leq` .. `hg/hf/hq/heq`) or a bus/main/matrix
 * EQ (that plus bands 5-6 and `tilt`) — don't reuse either one's field names against it.
 *
 * The monitor bus level field carries a documented footnote: it is READ-ONLY (as `$lvl`) when a
 * physical monitor level knob drives it, and settable (as plain `lvl`, no `$`) when it doesn't —
 * confirmed live to vary PER BUS on the same console (this unit's Monitor A/bus 1 has a knob, its
 * Monitor B/bus 2 doesn't). getMonitorBus() detects which shape applies per read; this module exposes
 * it for reading only — no setter — since a per-bus-conditional writer is more machinery than this
 * one field is worth. Use the generic `wing_set` tool for the rare case of writing bus 2's plain
 * `lvl` directly (`levelReadOnly: false` in the read result signals that it's settable).
 */

export type SoloStripType = Exclude<StripType, "mutegroup">;
export const SOLO_STRIP_TYPES: readonly SoloStripType[] = ["channel", "aux", "bus", "main", "matrix", "dca"];

const SOLO_SAFE_STRIP_TYPES: readonly SoloStripType[] = ["channel", "aux"];

function asNumber(value: string | number | undefined, fallback = 0): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function asString(value: string | number | undefined, fallback = ""): string {
  return value === undefined ? fallback : String(value);
}

function leafValue(result: WingGetResult | { kind: string }, fallback = 0): number {
  return result.kind === "leaf" ? Number((result as WingGetResult).display ?? (result as WingGetResult).value) : fallback;
}

export interface StripSoloStatus {
  type: SoloStripType;
  index: number;
  solo: boolean;
  soloLed: number;
  soloSafe?: boolean;
  preSolo?: boolean;
}

/** Reads a strip's solo switch, solo LED state, and (channel/aux only) solo-safe and presolo. */
export async function getStripSolo(ctx: WingPluginContext, type: SoloStripType, index: number): Promise<StripSoloStatus> {
  const basePath = resolveStripPath(type, index);
  const hasSoloSafe = SOLO_SAFE_STRIP_TYPES.includes(type);
  const [soloResult, soloLedResult, soloSafeResult, preSoloResult] = await Promise.all([
    ctx.client.get(`${basePath}/$solo`),
    ctx.client.get(`${basePath}/$sololed`),
    hasSoloSafe ? ctx.client.get(`${basePath}/solosafe`) : Promise.resolve(undefined),
    type === "channel" ? ctx.client.get(`${basePath}/$presolo`) : Promise.resolve(undefined),
  ]);
  return {
    type,
    index,
    solo: leafValue(soloResult) === 1,
    soloLed: leafValue(soloLedResult),
    ...(soloSafeResult !== undefined ? { soloSafe: leafValue(soloSafeResult) === 1 } : {}),
    ...(preSoloResult !== undefined ? { preSolo: leafValue(preSoloResult) === 1 } : {}),
  };
}

export interface SetStripSoloOptions {
  type: SoloStripType;
  index: number;
  solo?: boolean;
  soloSafe?: boolean;
}

export interface StripSoloAck {
  type: SoloStripType;
  index: number;
  ack: WingBulkSetResult;
}

/** Sets a strip's solo switch and/or (channel/aux only) solo-safe flag in a single bulk-set call. */
export async function setStripSolo(ctx: WingPluginContext, opts: SetStripSoloOptions): Promise<StripSoloAck> {
  const { type, index, solo, soloSafe } = opts;
  if (solo === undefined && soloSafe === undefined) {
    throw new WingValueError("At least one of solo or soloSafe must be provided.");
  }
  if (soloSafe !== undefined && !SOLO_SAFE_STRIP_TYPES.includes(type)) {
    throw new WingValueError(`soloSafe is not available on "${type}" strips (only ${SOLO_SAFE_STRIP_TYPES.join(", ")}).`);
  }
  const basePath = resolveStripPath(type, index);
  const assignments: Record<string, number> = {};
  if (solo !== undefined) assignments.$solo = solo ? 1 : 0;
  if (soloSafe !== undefined) assignments.solosafe = soloSafe ? 1 : 0;
  const ack = await ctx.client.bulkSet(basePath, assignments);
  return { type, index, ack };
}

export const SOLO_MODE_VALUES = ["LIVE", "STUDIO", "SIP"] as const;
export type SoloMode = (typeof SOLO_MODE_VALUES)[number];

export const SOLO_MONITOR_DEST_VALUES = ["PH", "SPK", "PH+SPK"] as const;
export type SoloMonitorDest = (typeof SOLO_MONITOR_DEST_VALUES)[number];

export const SOLO_TAP_VALUES = ["PFL", "AFL"] as const;
export type SoloTap = (typeof SOLO_TAP_VALUES)[number];

export const SOURCE_SOLO_ASSIGN_VALUES = ["OFF", "CH39", "AUX7"] as const;
export type SourceSoloAssign = (typeof SOURCE_SOLO_ASSIGN_VALUES)[number];

export interface SoloConfig {
  mode: SoloMode | string;
  monitor: SoloMonitorDest | string;
  mute: boolean;
  dim: boolean;
  mono: boolean;
  flip: boolean;
  channelTap: SoloTap | string;
  busTap: SoloTap | string;
  mainTap: SoloTap | string;
  matrixTap: SoloTap | string;
  sourceSoloAssign: SourceSoloAssign | string;
  sourceSoloOn: boolean;
  sourceSoloGroup: number;
  sourceSoloIn: number;
}

/**
 * Reads the global solo-behavior config node: mode, monitor destination, dim/mono/flip, tap points,
 * and source-solo assignment. Verified live against real hardware: `/cfg/solo`'s six `$`-prefixed
 * fields ($dim, $mono, $flip, $srcsolo, $srcsgrp, $srcsin) are silently omitted from a `dump()` reply
 * (same class of firmware behavior already documented for the USB player's `$`-prefixed status
 * fields in wing-usb-player.ts) even though they read and write fine individually — dump() alone
 * would make every one of them look permanently stuck at its fallback default. Read individually via
 * `get()` instead, alongside the single `dump()` for the other eight (non-`$`) fields.
 */
export async function getSoloConfig(ctx: WingPluginContext): Promise<SoloConfig> {
  const [flat, dim, mono, flip, srcSoloOn, srcSoloGroup, srcSoloIn] = await Promise.all([
    ctx.client.dump("/cfg/solo"),
    ctx.client.get("/cfg/solo/$dim"),
    ctx.client.get("/cfg/solo/$mono"),
    ctx.client.get("/cfg/solo/$flip"),
    ctx.client.get("/cfg/solo/$srcsolo"),
    ctx.client.get("/cfg/solo/$srcsgrp"),
    ctx.client.get("/cfg/solo/$srcsin"),
  ]);
  return {
    mode: asString(flat.mode, "LIVE"),
    monitor: asString(flat.mon, "PH"),
    mute: asNumber(flat.mute) === 1,
    dim: leafValue(dim) === 1,
    mono: leafValue(mono) === 1,
    flip: leafValue(flip) === 1,
    channelTap: asString(flat.chtap, "PFL"),
    busTap: asString(flat.bustap, "PFL"),
    mainTap: asString(flat.maintap, "PFL"),
    matrixTap: asString(flat.mtxtap, "PFL"),
    sourceSoloAssign: asString(flat.srcsolo, "OFF"),
    sourceSoloOn: leafValue(srcSoloOn) === 1,
    sourceSoloGroup: leafValue(srcSoloGroup, 1),
    sourceSoloIn: leafValue(srcSoloIn, 1),
  };
}

export interface SetSoloConfigOptions {
  mode?: SoloMode;
  monitor?: SoloMonitorDest;
  mute?: boolean;
  dim?: boolean;
  mono?: boolean;
  flip?: boolean;
  channelTap?: SoloTap;
  busTap?: SoloTap;
  mainTap?: SoloTap;
  matrixTap?: SoloTap;
  sourceSoloAssign?: SourceSoloAssign;
  sourceSoloOn?: boolean;
  sourceSoloGroup?: number;
  sourceSoloIn?: number;
}

export interface SoloConfigAck {
  ack: WingBulkSetResult;
}

/** Sets any subset of the global solo-behavior config node in a single bulk-set call. */
export async function setSoloConfig(ctx: WingPluginContext, opts: SetSoloConfigOptions): Promise<SoloConfigAck> {
  const { mode, monitor, mute, dim, mono, flip, channelTap, busTap, mainTap, matrixTap, sourceSoloAssign, sourceSoloOn, sourceSoloGroup, sourceSoloIn } = opts;
  const entries = Object.values(opts).filter((v) => v !== undefined);
  if (entries.length === 0) {
    throw new WingValueError(
      "At least one of mode, monitor, mute, dim, mono, flip, channelTap, busTap, mainTap, matrixTap, " +
        "sourceSoloAssign, sourceSoloOn, sourceSoloGroup, or sourceSoloIn must be provided.",
    );
  }
  if (sourceSoloGroup !== undefined && (!Number.isInteger(sourceSoloGroup) || sourceSoloGroup < 1 || sourceSoloGroup > 13)) {
    throw new WingValueError(`sourceSoloGroup must be an integer between 1 and 13 (got ${sourceSoloGroup}).`);
  }
  if (sourceSoloIn !== undefined && (!Number.isInteger(sourceSoloIn) || sourceSoloIn < 1 || sourceSoloIn > 64)) {
    throw new WingValueError(`sourceSoloIn must be an integer between 1 and 64 (got ${sourceSoloIn}).`);
  }
  const assignments: Record<string, number | string> = {};
  if (mode !== undefined) assignments.mode = mode;
  if (monitor !== undefined) assignments.mon = monitor;
  if (mute !== undefined) assignments.mute = mute ? 1 : 0;
  if (dim !== undefined) assignments.$dim = dim ? 1 : 0;
  if (mono !== undefined) assignments.$mono = mono ? 1 : 0;
  if (flip !== undefined) assignments.$flip = flip ? 1 : 0;
  if (channelTap !== undefined) assignments.chtap = channelTap;
  if (busTap !== undefined) assignments.bustap = busTap;
  if (mainTap !== undefined) assignments.maintap = mainTap;
  if (matrixTap !== undefined) assignments.mtxtap = matrixTap;
  if (sourceSoloAssign !== undefined) assignments.srcsolo = sourceSoloAssign;
  if (sourceSoloOn !== undefined) assignments.$srcsolo = sourceSoloOn ? 1 : 0;
  if (sourceSoloGroup !== undefined) assignments.$srcsgrp = sourceSoloGroup;
  if (sourceSoloIn !== undefined) assignments.$srcsin = sourceSoloIn;
  const ack = await ctx.client.bulkSet("/cfg/solo", assignments);
  return { ack };
}

function expandOscRange(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => `${prefix}.${i + 1}`);
}

/** Valid `/cfg/mon/{n}/src` tokens: "OFF" or "<TYPE>.<N>" for MAIN/MTX/BUS/AUX. */
export const MONITOR_BUS_SRC_VALUES = [
  "OFF",
  ...expandOscRange("MAIN", MAIN_COUNT),
  ...expandOscRange("MTX", MATRIX_COUNT),
  ...expandOscRange("BUS", BUS_COUNT),
  ...expandOscRange("AUX", AUX_COUNT),
] as const;

/** Valid `/cfg/mon/{n}/dirin` tokens: "OFF" or "<TYPE>.<N>" for CH/AUX/BUS/MAIN/MTX. */
export const MONITOR_BUS_DIRIN_VALUES = [
  "OFF",
  ...expandOscRange("CH", CHANNEL_COUNT),
  ...expandOscRange("AUX", AUX_COUNT),
  ...expandOscRange("BUS", BUS_COUNT),
  ...expandOscRange("MAIN", MAIN_COUNT),
  ...expandOscRange("MTX", MATRIX_COUNT),
] as const;

export type MonitorBusIndex = 1 | 2;

export interface MonitorBusStatus {
  bus: MonitorBusIndex;
  levelDb: number;
  levelReadOnly: boolean;
  invert: boolean;
  pan: number;
  width: number;
  limiterDb: number;
  delayOn: boolean;
  delayMeters: number;
  dimLevelDb: number;
  pflDimDb: number;
  bandSoloTrimDb: number;
  sourceLevelDb: number;
  sourceMixDb: number;
  source: string;
  directIn: string;
  faderLevelDb: number;
  tags: string;
}

/**
 * Reads a control-room monitor bus's core routing/level/dynamics fields (Monitor A = 1, Monitor B =
 * 2). Does not include the EQ node — see this module's header comment. Verified live against real
 * hardware: like `/cfg/solo`'s `$`-prefixed fields (see getSoloConfig's doc comment), `$lvlact` is
 * silently omitted from a `dump()` reply on this node — read individually via `get()`.
 *
 * The level field itself is even more inconsistent than that: on this console, Monitor A (bus 1) has
 * a dedicated physical knob, so its level field is `$lvl` — `$`-prefixed (dropped from dump(), same
 * as above) AND documented+confirmed read-only (per the PDF's `$lvl` footnote: "considered RO on the
 * full-size WING... settable for other devices where the actual surface control potentiometer is not
 * present"). Monitor B (bus 2) apparently has no such dedicated knob on this unit, so its level field
 * is instead the plain, settable `lvl` (no `$`, appears in dump() normally, no RO marker in
 * describe()). A hardcoded assumption of one shape for both buses made bus 2 reads either silently
 * wrong (reading the nonexistent `$lvl` returns nothing) or, worse, hang for a full request timeout
 * (a GET for an address the console has nothing bound to on that bus never gets a reply at all) —
 * confirmed both live. Detecting which shape applies from dump()'s own reply (whether `lvl` shows up
 * there or not) avoids ever guessing wrong or eating that timeout.
 */
export async function getMonitorBus(ctx: WingPluginContext, bus: MonitorBusIndex): Promise<MonitorBusStatus> {
  const [flat, lvlAct] = await Promise.all([ctx.client.dump(`/cfg/mon/${bus}`), ctx.client.get(`/cfg/mon/${bus}/$lvlact`)]);
  const hasPlainLvl = "lvl" in flat;
  const levelDb = hasPlainLvl ? asNumber(flat.lvl) : leafValue(await ctx.client.get(`/cfg/mon/${bus}/$lvl`));
  return {
    bus,
    levelDb,
    levelReadOnly: !hasPlainLvl,
    invert: asNumber(flat.inv) === 1,
    pan: asNumber(flat.pan),
    width: asNumber(flat.wid, 100),
    limiterDb: asNumber(flat.lim),
    delayOn: asNumber(flat["dly.on"]) === 1,
    delayMeters: asNumber(flat["dly.m"]),
    dimLevelDb: asNumber(flat.dim),
    pflDimDb: asNumber(flat.pfldim),
    bandSoloTrimDb: asNumber(flat.eqbdtrim),
    sourceLevelDb: asNumber(flat.srclvl),
    sourceMixDb: asNumber(flat.srcmix),
    source: asString(flat.src, "OFF"),
    directIn: asString(flat.dirin, "OFF"),
    faderLevelDb: leafValue(lvlAct),
    tags: asString(flat.tags),
  };
}

export interface SetMonitorBusOptions {
  bus: MonitorBusIndex;
  invert?: boolean;
  pan?: number;
  width?: number;
  limiterDb?: number;
  delayOn?: boolean;
  delayMeters?: number;
  dimLevelDb?: number;
  pflDimDb?: number;
  bandSoloTrimDb?: number;
  sourceLevelDb?: number;
  sourceMixDb?: number;
  source?: string;
  directIn?: string;
  tags?: string;
}

export interface MonitorBusAck {
  bus: MonitorBusIndex;
  ack: WingBulkSetResult;
}

/**
 * Sets any subset of a control-room monitor bus's core fields in a single bulk-set call.
 * `$lvl`/`$lvlact` have no setter here — `$lvl` is documented read-only on the full-size WING (see
 * this module's header comment); adjust it from the physical monitor knob instead.
 */
export async function setMonitorBus(ctx: WingPluginContext, opts: SetMonitorBusOptions): Promise<MonitorBusAck> {
  const { bus, invert, pan, width, limiterDb, delayOn, delayMeters, dimLevelDb, pflDimDb, bandSoloTrimDb, sourceLevelDb, sourceMixDb, source, directIn, tags } =
    opts;
  const fieldsProvided = [invert, pan, width, limiterDb, delayOn, delayMeters, dimLevelDb, pflDimDb, bandSoloTrimDb, sourceLevelDb, sourceMixDb, source, directIn, tags];
  if (fieldsProvided.every((v) => v === undefined)) {
    throw new WingValueError(
      "At least one of invert, pan, width, limiterDb, delayOn, delayMeters, dimLevelDb, pflDimDb, " +
        "bandSoloTrimDb, sourceLevelDb, sourceMixDb, source, directIn, or tags must be provided.",
    );
  }
  if (pan !== undefined && (pan < -100 || pan > 100)) {
    throw new WingValueError(`pan must be between -100 and 100 (got ${pan}).`);
  }
  if (width !== undefined && (width < -150 || width > 150)) {
    throw new WingValueError(`width must be between -150 and 150 (got ${width}).`);
  }
  if (limiterDb !== undefined && (limiterDb < -40 || limiterDb > 0)) {
    throw new WingValueError(`limiterDb must be between -40 and 0 (got ${limiterDb}).`);
  }
  if (delayMeters !== undefined && (delayMeters < 0.1 || delayMeters > 100)) {
    throw new WingValueError(`delayMeters must be between 0.1 and 100 (got ${delayMeters}).`);
  }
  if (dimLevelDb !== undefined && (dimLevelDb < 0 || dimLevelDb > 40)) {
    throw new WingValueError(`dimLevelDb must be between 0 and 40 (got ${dimLevelDb}).`);
  }
  if (pflDimDb !== undefined && (pflDimDb < 0 || pflDimDb > 40)) {
    throw new WingValueError(`pflDimDb must be between 0 and 40 (got ${pflDimDb}).`);
  }
  if (bandSoloTrimDb !== undefined && (bandSoloTrimDb < 0 || bandSoloTrimDb > 24)) {
    throw new WingValueError(`bandSoloTrimDb must be between 0 and 24 (got ${bandSoloTrimDb}).`);
  }
  if (sourceLevelDb !== undefined && (sourceLevelDb < -144 || sourceLevelDb > 10)) {
    throw new WingValueError(`sourceLevelDb must be between -144 and 10 (got ${sourceLevelDb}).`);
  }
  if (sourceMixDb !== undefined && (sourceMixDb < -144 || sourceMixDb > 10)) {
    throw new WingValueError(`sourceMixDb must be between -144 and 10 (got ${sourceMixDb}).`);
  }
  if (source !== undefined && !(MONITOR_BUS_SRC_VALUES as readonly string[]).includes(source)) {
    throw new WingValueError(`source must be "OFF" or "<TYPE>.<N>" for MAIN/MTX/BUS/AUX (got "${source}").`);
  }
  if (directIn !== undefined && !(MONITOR_BUS_DIRIN_VALUES as readonly string[]).includes(directIn)) {
    throw new WingValueError(`directIn must be "OFF" or "<TYPE>.<N>" for CH/AUX/BUS/MAIN/MTX (got "${directIn}").`);
  }
  if (tags !== undefined && tags.length > 80) {
    throw new WingValueError(`tags must be at most 80 characters (got ${tags.length}).`);
  }
  const assignments: Record<string, number | string> = {};
  if (invert !== undefined) assignments.inv = invert ? 1 : 0;
  if (pan !== undefined) assignments.pan = pan;
  if (width !== undefined) assignments.wid = width;
  if (limiterDb !== undefined) assignments.lim = limiterDb;
  if (delayOn !== undefined) assignments["dly.on"] = delayOn ? 1 : 0;
  if (delayMeters !== undefined) assignments["dly.m"] = delayMeters;
  if (dimLevelDb !== undefined) assignments.dim = dimLevelDb;
  if (pflDimDb !== undefined) assignments.pfldim = pflDimDb;
  if (bandSoloTrimDb !== undefined) assignments.eqbdtrim = bandSoloTrimDb;
  if (sourceLevelDb !== undefined) assignments.srclvl = sourceLevelDb;
  if (sourceMixDb !== undefined) assignments.srcmix = sourceMixDb;
  if (source !== undefined) assignments.src = source;
  if (directIn !== undefined) assignments.dirin = directIn;
  if (tags !== undefined) assignments.tags = tags;
  const ack = await ctx.client.bulkSet(`/cfg/mon/${bus}`, assignments);
  return { bus, ack };
}
