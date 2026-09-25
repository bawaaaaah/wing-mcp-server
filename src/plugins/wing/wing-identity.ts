import { WingValueError } from "./wing-errors.js";
import { ioInPath } from "./wing-node-paths.js";
import { wingColorName, wingIconName } from "./wing-param-catalog.js";
import type { WingPluginContext } from "./wing-plugin.js";

/**
 * The console I/O groups that are real, addressable input sources (`/io/in/<group>/<n>`, each with
 * a name/color/icon/mode). A strip's `in/conn/grp` can also be OFF or an internal BUS/MAIN/MTX tap,
 * which have no such node.
 */
export const SOURCE_GROUPS = ["LCL", "AUX", "A", "B", "C", "SC", "USB", "CRD", "MOD", "PLAY", "AES", "USR", "OSC"] as const;

export function isSourceGroup(group: string): boolean {
  return (SOURCE_GROUPS as readonly string[]).includes(group);
}

/** Strip families that carry a name/color/icon, as addressed on the wire. */
export const STRIP_KINDS = ["ch", "aux", "bus", "main", "mtx", "dca", "mgrp"] as const;
export type StripKind = (typeof STRIP_KINDS)[number];

export const STRIP_KIND_COUNTS: Record<StripKind, number> = { ch: 40, aux: 8, bus: 16, main: 4, mtx: 8, dca: 16, mgrp: 8 };

/** Only these have a `$name`/`$col`/`$icon` shadow reflecting a linked source (see readStripIdentity). */
const KINDS_WITH_SHADOW: readonly StripKind[] = ["ch", "aux", "bus", "main", "mtx"];
/** Only these have an input connection (`in/conn/*`) and a `clink` to it. */
export const KINDS_WITH_INPUT: readonly StripKind[] = ["ch", "aux"];

export function stripPath(kind: StripKind, index: number, suffix?: string): string {
  const max = STRIP_KIND_COUNTS[kind];
  if (!Number.isInteger(index) || index < 1 || index > max) {
    throw new WingValueError(`${kind} index must be an integer 1..${max} — got ${index}.`);
  }
  return suffix ? `/${kind}/${index}/${suffix}` : `/${kind}/${index}`;
}

/**
 * Where a strip's input is patched, decoded the way the console shows it.
 *
 * Stereo, verified against real hardware (2026-09-25): a stereo source is one of an odd/even pair
 * whose two members are both `mode=ST` (A9 and A10 on the test console). A strip can be patched to
 * either member — `in/conn/in` stores whichever was written (10, say) and the strip is stereo
 * (`in/set/$mode=ST`) either way — while the console shows the pair, "9/10". So `index` here is the
 * pair's first member, as displayed, and the stored value is kept separately as `storedIndex`
 * (which is what to write back to reproduce the exact same patch).
 */
export interface SourceRef {
  group: string;
  /** As the console displays it: the first member of a stereo pair. */
  index: number;
  /** What `in/conn/in` actually holds. Differs from `index` only for the even member of a pair. */
  storedIndex: number;
  stereo: boolean;
  /** "M", "ST" or "M/S" — the source's own mode. */
  mode: string | null;
  pair?: [number, number];
  /** "A9-10", "LCL5", "USR14". */
  label: string;
}

export function describeSourceRef(group: string, storedIndex: number, mode: string | null): SourceRef {
  const stereo = mode !== null && mode !== "M";
  if (!stereo) {
    return { group, index: storedIndex, storedIndex, stereo: false, mode, label: `${group}${storedIndex}` };
  }
  const first = storedIndex % 2 === 1 ? storedIndex : storedIndex - 1;
  const pair: [number, number] = [first, first + 1];
  return { group, index: first, storedIndex, stereo: true, mode, pair, label: `${group}${first}-${first + 1}` };
}

export interface Identity {
  name: string;
  col: number;
  colorName: string | undefined;
  icon: number;
  iconName: string | undefined;
}

function identity(name: unknown, col: unknown, icon: unknown): Identity {
  const c = Number(col);
  const i = Number(icon);
  return {
    name: name === undefined || name === null ? "" : String(name),
    col: c,
    colorName: wingColorName(c),
    icon: i,
    iconName: wingIconName(i),
  };
}

export interface SourceIdentity extends Identity {
  group: string;
  index: number;
  mode: string | null;
  gain: number | null;
  phantom48v: boolean | null;
  mute: boolean | null;
  polarityInverted: boolean | null;
}

function numOrNull(v: unknown): number | null {
  if (v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function boolOrNull(v: unknown): boolean | null {
  const n = numOrNull(v);
  return n === null ? null : n === 1;
}

/** One dump of `/io/in/<group>/<n>` — about a dozen keys, one round trip. */
export async function readSourceIdentity(ctx: WingPluginContext, group: string, index: number): Promise<SourceIdentity> {
  const d = await ctx.client.dump(ioInPath(group, index));
  return {
    group,
    index,
    ...identity(d.name, d.col ?? 1, d.icon ?? 0),
    mode: d.mode === undefined ? null : String(d.mode),
    gain: numOrNull(d.g),
    phantom48v: boolOrNull(d.vph),
    mute: boolOrNull(d.mute),
    polarityInverted: boolOrNull(d.pol),
  };
}

export interface StripIdentity {
  kind: StripKind;
  index: number;
  /** The strip's own name/col/icon leaves. */
  own: Identity;
  /**
   * What the console surface shows: the strip's `$name`/`$col`/`$icon` shadows, which the console
   * itself resolves — verified against real hardware that with `clink=1` they switch to the
   * connected source's name/color/icon (and follow a rename or re-patch of it), and back to the
   * strip's own with `clink=0`. DCAs and mute groups have no shadows; theirs is their own.
   */
  effective: Identity;
  /**
   * `clink` — "link customization to source". Not `in/set/srcauto`: per the protocol reference that
   * is the "input auto source switch", unrelated to naming, and a strip can have srcauto=1 while
   * showing its own name.
   */
  nameLinkedToSource: boolean;
  source: (SourceRef & { identity: SourceIdentity | null }) | null;
  altSource: SourceRef | null;
}

function connRef(group: unknown, idx: unknown, mode: string | null): SourceRef | null {
  if (group === undefined || String(group) === "OFF") return null;
  const n = Number(idx);
  if (!Number.isFinite(n)) return null;
  return describeSourceRef(String(group), n, mode);
}

/** Compact, flat form for summaries: own/source/effective side by side. */
export function flattenIdentity(id: StripIdentity) {
  const src = id.source?.identity ?? null;
  return {
    effectiveName: id.effective.name,
    ownName: id.own.name,
    sourceName: src ? src.name : null,
    effectiveCol: id.effective.col,
    effectiveColorName: id.effective.colorName,
    ownCol: id.own.col,
    sourceCol: src ? src.col : null,
    effectiveIcon: id.effective.icon,
    effectiveIconName: id.effective.iconName,
    ownIcon: id.own.icon,
    sourceIcon: src ? src.icon : null,
    nameLinkedToSource: id.nameLinkedToSource,
    source: id.source
      ? {
          group: id.source.group,
          index: id.source.index,
          storedIndex: id.source.storedIndex,
          stereo: id.source.stereo,
          pair: id.source.pair,
          label: id.source.label,
        }
      : null,
  };
}

/**
 * Everything about a strip's identity in one place: own vs effective name/color/icon, whether it is
 * linked to its source, and where its input comes from (with the source's own identity). One dump
 * of the strip, three shadow reads, and one dump of the source.
 */
export async function readStripIdentity(
  ctx: WingPluginContext,
  kind: StripKind,
  index: number,
  /** The strip's dump, when the caller already has it. */
  dump?: Record<string, string | number>,
): Promise<StripIdentity> {
  const base = stripPath(kind, index);
  const d = dump ?? (await ctx.client.dump(base));
  const own = identity(d.name, d.col ?? 1, d.icon ?? 0);

  let effective = own;
  if (KINDS_WITH_SHADOW.includes(kind)) {
    const [name, col, icon] = await Promise.all(
      ["$name", "$col", "$icon"].map((leaf) => ctx.client.get(`${base}/${leaf}`).catch(() => null)),
    );
    const v = (r: typeof name, fallback: unknown) => (r && r.kind === "leaf" ? r.value : fallback);
    effective = identity(v(name, own.name), v(col, own.col), v(icon, own.icon));
  }

  let source: StripIdentity["source"] = null;
  let altSource: SourceRef | null = null;
  if (KINDS_WITH_INPUT.includes(kind)) {
    const group = d["in.conn.grp"];
    let sourceIdentity: SourceIdentity | null = null;
    if (group !== undefined && isSourceGroup(String(group))) {
      sourceIdentity = await readSourceIdentity(ctx, String(group), Number(d["in.conn.in"])).catch(() => null);
    }
    const ref = connRef(group, d["in.conn.in"], sourceIdentity?.mode ?? null);
    source = ref ? { ...ref, identity: sourceIdentity } : null;
    // The alt source's mode would cost another dump; its pair is only reported once it is read.
    altSource = connRef(d["in.conn.altgrp"], d["in.conn.altin"], null);
  }

  return {
    kind,
    index,
    own,
    effective,
    nameLinkedToSource: Number(d.clink) === 1,
    source,
    altSource,
  };
}
