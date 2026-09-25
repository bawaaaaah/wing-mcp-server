import type { WingBoxMap } from "./wing-config.js";
import { WingValueError } from "./wing-errors.js";
import {
  describeSourceRef,
  isSourceGroup,
  readSourceIdentity,
  readStripIdentity,
  type SourceIdentity,
  type SourceRef,
  type StripKind,
} from "./wing-identity.js";
import { ioInPath, ioOutPath } from "./wing-node-paths.js";
import { wingColorName, wingIconName } from "./wing-param-catalog.js";
import type { WingPluginContext } from "./wing-plugin.js";

/**
 * Internal taps a strip input or an output can be fed from. Verified against real hardware
 * (2026-09-25): each is numbered in L/R pairs — `/io/in/$BUS/7` and `/8` both carry bus 4's name
 * ("Karina"), `$BUS/1`-`2` bus 1's — so tap n is strip ⌈n/2⌉, left when n is odd. `$SEND` pairs are
 * the FX sends ("FX SEND 1" on 1-2), `$MON` pairs the monitor outs (1-2 PHONES, 3-4 SPEAKERS).
 */
export const TAP_GROUPS: Record<string, { strip: string; count: number }> = {
  BUS: { strip: "bus", count: 16 },
  MAIN: { strip: "main", count: 4 },
  MTX: { strip: "mtx", count: 8 },
  SEND: { strip: "fxsend", count: 16 },
  MON: { strip: "monitor", count: 2 },
};

export interface TapSignal {
  strip: string;
  stripIndex: number;
  side: "L" | "R";
}

export function decodeTap(group: string, rawIn: number): TapSignal | null {
  const tap = TAP_GROUPS[group];
  if (!tap || !Number.isInteger(rawIn) || rawIn < 1) return null;
  return { strip: tap.strip, stripIndex: Math.ceil(rawIn / 2), side: rawIn % 2 === 1 ? "L" : "R" };
}

/** Memoizes source/tap name lookups for the duration of one listing. */
class NameLookup {
  private readonly sources = new Map<string, Promise<SourceIdentity | null>>();
  private readonly taps = new Map<string, Promise<string | null>>();

  constructor(private readonly ctx: WingPluginContext) {}

  source(group: string, index: number): Promise<SourceIdentity | null> {
    const key = `${group}/${index}`;
    let p = this.sources.get(key);
    if (!p) {
      p = readSourceIdentity(this.ctx, group, index).catch(() => null);
      this.sources.set(key, p);
    }
    return p;
  }

  /** `/io/in/$BUS/7` etc. carry the tapped strip's name — cheaper than resolving the strip. */
  tap(group: string, index: number): Promise<string | null> {
    const key = `${group}/${index}`;
    let p = this.taps.get(key);
    if (!p) {
      p = this.ctx.client
        .dump(`/io/in/$${group}/${index}`)
        .then((d) => (d.name === undefined ? "" : String(d.name)))
        .catch(() => null);
      this.taps.set(key, p);
    }
    return p;
  }
}

/** Number of ports/entries in an I/O group, discovered live (it varies by model: LCL is 24 on a Rack). */
export async function ioGroupCount(ctx: WingPluginContext, direction: "in" | "out", group: string): Promise<number> {
  const result = await ctx.client.get(`/io/${direction}/${group}`);
  if (result.kind !== "branch") {
    throw new WingValueError(`/io/${direction}/${group} is not an I/O group on this console.`);
  }
  return result.children.length;
}

function clampRange(count: number, from?: number, to?: number): number[] {
  const start = Math.max(1, from ?? 1);
  const end = Math.min(count, to ?? count);
  return Array.from({ length: Math.max(0, end - start + 1) }, (_, i) => start + i);
}

/** Which physical box connector a port of an I/O group is, per the configured box map. */
export function boxPortFor(boxMap: WingBoxMap, group: string, port: number): { device: string; devicePort: number; model?: string } | null {
  const aliases = [group, group === "A" || group === "B" || group === "C" ? `AES50-${group}` : "", group === "SC" ? "StageConnect" : ""];
  for (const alias of aliases) {
    const boxes = alias ? boxMap[alias] : undefined;
    if (!boxes) continue;
    for (const box of boxes) {
      const [lo, hi] = box.range;
      if (port < lo || port > hi) continue;
      const firstLocal = box.localPorts?.[0] ?? 1;
      return { device: box.device, devicePort: firstLocal + (port - lo), ...(box.model ? { model: box.model } : {}) };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Sources

export interface SourceListEntry extends SourceIdentity {
  /** "M", "ST" or "M/S"; for a stereo pair, the pair it belongs to. */
  pair?: [number, number];
  box?: { device: string; devicePort: number; model?: string } | null;
}

export async function listSources(
  ctx: WingPluginContext,
  group: string,
  from?: number,
  to?: number,
): Promise<SourceListEntry[]> {
  if (!isSourceGroup(group)) {
    throw new WingValueError(`"${group}" is not an input source group. Expected one of LCL, AUX, A, B, C, SC, USB, CRD, MOD, PLAY, AES, USR, OSC.`);
  }
  const count = await ioGroupCount(ctx, "in", group);
  const boxMap = ctx.getConfig().boxMap ?? {};
  const out: SourceListEntry[] = [];
  for (const index of clampRange(count, from, to)) {
    const id = await readSourceIdentity(ctx, group, index);
    const ref = describeSourceRef(group, index, id.mode);
    out.push({ ...id, ...(ref.pair ? { pair: ref.pair } : {}), box: boxPortFor(boxMap, group, index) });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// User signals

export interface UserSignalLink {
  /** "strip" for user signals 1-24, "source" for user patches 25-56, "off" when unassigned. */
  kind: "strip" | "source" | "off";
  group?: string;
  index?: number;
  /** Strip links only. */
  tap?: string;
  lr?: string;
  /** The linked strip's effective name, or the linked source's name. */
  targetName?: string;
  /** "CH7", "LCL5". */
  label?: string;
}

export interface UserSignal {
  index: number;
  /** User signals (1-24) take a strip; user patches (25-56) take a physical source. */
  range: "signal" | "patch";
  name: string;
  col: number;
  colorName: string | undefined;
  icon: number;
  iconName: string | undefined;
  mode: string;
  mute: boolean;
  polarityInverted: boolean;
  link: UserSignalLink;
}

export const USER_SIGNAL_COUNT = 56;
/** Protocol reference: "1-24 are User Signals, 25-56 are User Patches". */
export const USER_SIGNAL_STRIP_RANGE_MAX = 24;

/** `user.grp` for a strip-linked user signal is the wire's strip-family name. */
const USR_STRIP_GROUP_TO_KIND: Record<string, StripKind> = { CH: "ch", AUX: "aux", BUS: "bus", MAIN: "main", MTX: "mtx" };

async function stripEffectiveName(ctx: WingPluginContext, kind: StripKind, index: number): Promise<string | undefined> {
  const r = await ctx.client.get(`/${kind}/${index}/$name`).catch(() => null);
  return r && r.kind === "leaf" ? String(r.value) : undefined;
}

export async function readUserSignal(ctx: WingPluginContext, index: number, lookup = new NameLookup(ctx)): Promise<UserSignal> {
  if (!Number.isInteger(index) || index < 1 || index > USER_SIGNAL_COUNT) {
    throw new WingValueError(`User signal index must be 1..${USER_SIGNAL_COUNT} — got ${index}.`);
  }
  const d = await ctx.client.dump(ioInPath("USR", index));
  const grp = String(d["user.grp"] ?? "OFF");
  const inIdx = Number(d["user.in"] ?? 1);
  const range = index <= USER_SIGNAL_STRIP_RANGE_MAX ? "signal" : "patch";
  let link: UserSignalLink = { kind: "off" };
  if (grp !== "OFF") {
    if (range === "signal") {
      const kind = USR_STRIP_GROUP_TO_KIND[grp];
      link = {
        kind: "strip",
        group: grp,
        index: inIdx,
        tap: d["user.tap"] === undefined ? undefined : String(d["user.tap"]),
        lr: d["user.lr"] === undefined ? undefined : String(d["user.lr"]),
        targetName: kind ? await stripEffectiveName(ctx, kind, inIdx) : undefined,
        label: `${grp}${inIdx}`,
      };
    } else {
      const src = await lookup.source(grp, inIdx);
      link = { kind: "source", group: grp, index: inIdx, targetName: src?.name, label: `${grp}${inIdx}` };
    }
  }
  const col = Number(d.col ?? 1);
  const icon = Number(d.icon ?? 0);
  return {
    index,
    range,
    name: d.name === undefined ? "" : String(d.name),
    col,
    colorName: wingColorName(col),
    icon,
    iconName: wingIconName(icon),
    mode: String(d.mode ?? "M"),
    mute: Number(d.mute) === 1,
    polarityInverted: Number(d.pol) === 1,
    link,
  };
}

export async function listUserSignals(ctx: WingPluginContext, from?: number, to?: number): Promise<UserSignal[]> {
  const lookup = new NameLookup(ctx);
  const out: UserSignal[] = [];
  for (const index of clampRange(USER_SIGNAL_COUNT, from, to)) {
    out.push(await readUserSignal(ctx, index, lookup));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Input patch

export interface InputPatchRow {
  strip: "ch" | "aux";
  index: number;
  effectiveName: string;
  ownName: string;
  nameLinkedToSource: boolean;
  source:
    | (SourceRef & {
        sourceName: string | null;
        phantom48v: boolean | null;
        gain: number | null;
        box?: { device: string; devicePort: number; model?: string } | null;
      })
    | { group: string; index: number; label: string; tap: TapSignal | null; tapName: string | null }
    | null;
  altSource: SourceRef | null;
}

export async function readInputPatch(ctx: WingPluginContext, strips: "ch" | "aux" | "all"): Promise<InputPatchRow[]> {
  const kinds: ("ch" | "aux")[] = strips === "all" ? ["ch", "aux"] : [strips];
  const boxMap = ctx.getConfig().boxMap ?? {};
  const lookup = new NameLookup(ctx);
  const rows: InputPatchRow[] = [];
  for (const kind of kinds) {
    const count = kind === "ch" ? 40 : 8;
    for (let index = 1; index <= count; index++) {
      const dump = await ctx.client.dump(`/${kind}/${index}`);
      const grp = String(dump["in.conn.grp"] ?? "OFF");
      const id = await readStripIdentity(ctx, kind, index, dump);
      let source: InputPatchRow["source"] = null;
      if (grp in TAP_GROUPS) {
        const n = Number(dump["in.conn.in"]);
        source = { group: grp, index: n, label: `${grp}${n}`, tap: decodeTap(grp, n), tapName: await lookup.tap(grp, n) };
      } else if (id.source) {
        const { identity: src, ...ref } = id.source;
        source = {
          ...ref,
          sourceName: src?.name ?? null,
          phantom48v: src?.phantom48v ?? null,
          gain: src?.gain ?? null,
          box: boxPortFor(boxMap, ref.group, ref.index),
        };
      }
      rows.push({
        strip: kind,
        index,
        effectiveName: id.effective.name,
        ownName: id.own.name,
        nameLinkedToSource: id.nameLinkedToSource,
        source,
        altSource: id.altSource,
      });
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------------------------
// Output patch

export interface OutputPatchRow {
  group: string;
  port: number;
  box: { device: string; devicePort: number; model?: string } | null;
  signal:
    | { kind: "off" }
    | { kind: "tap"; group: string; rawIn: number; strip: string; stripIndex: number; side: "L" | "R"; stripName: string | null }
    | { kind: "source"; group: string; rawIn: number; sourceName: string | null; mode: string | null; label: string };
}

export async function readOutputPatch(ctx: WingPluginContext, group: string, from?: number, to?: number): Promise<OutputPatchRow[]> {
  const count = await ioGroupCount(ctx, "out", group);
  const boxMap = ctx.getConfig().boxMap ?? {};
  const lookup = new NameLookup(ctx);
  const rows: OutputPatchRow[] = [];
  for (const port of clampRange(count, from, to)) {
    const d = await ctx.client.dump(ioOutPath(group, port));
    const grp = String(d.grp ?? "OFF");
    const rawIn = Number(d.in ?? 1);
    let signal: OutputPatchRow["signal"] = { kind: "off" };
    const tap = decodeTap(grp, rawIn);
    if (tap) {
      signal = { kind: "tap", group: grp, rawIn, ...tap, stripName: await lookup.tap(grp, rawIn) };
    } else if (grp !== "OFF") {
      const src = isSourceGroup(grp) ? await lookup.source(grp, rawIn) : null;
      signal = { kind: "source", group: grp, rawIn, sourceName: src?.name ?? null, mode: src?.mode ?? null, label: `${grp}${rawIn}` };
    }
    rows.push({ group, port, box: boxPortFor(boxMap, group, port), signal });
  }
  return rows;
}

export function describeOutputSignal(signal: OutputPatchRow["signal"]): string {
  switch (signal.kind) {
    case "off":
      return "—";
    case "tap":
      return `${signal.strip} ${signal.stripIndex} ${signal.side}${signal.stripName ? ` "${signal.stripName}"` : ""}`;
    case "source":
      return `${signal.label}${signal.sourceName ? ` "${signal.sourceName}"` : ""}`;
  }
}
