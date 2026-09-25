import { WingValueError } from "./wing-errors.js";
import { stripPath } from "./wing-identity.js";
import { ioInPath } from "./wing-node-paths.js";
import type { WingPluginContext } from "./wing-plugin.js";
import { USER_SIGNAL_STRIP_RANGE_MAX } from "./wing-patch.js";
import { valuesMatch } from "./wing-write.js";

export const CHANNEL_SCOPES = [
  "source", "preamp", "name", "color", "icon", "filters", "gate", "eq", "dyn", "inserts",
  "fader", "pan", "mute", "sends", "mains", "dcaTags", "muteGroups", "all",
] as const;
export type ChannelScope = (typeof CHANNEL_SCOPES)[number];

/**
 * Which keys of a strip's dump each scope covers. The dump is exactly what a snapshot stores (the
 * console leaves read-only state out), so "all" copies a strip the way a scene would recall it.
 * `name` carries `clink` with it: a copied name is only what the surface shows if the link state
 * travels too.
 */
const SCOPE_KEYS: Record<Exclude<ChannelScope, "all" | "dcaTags" | "muteGroups">, (key: string) => boolean> = {
  source: (k) => k.startsWith("in.conn."),
  preamp: (k) => k.startsWith("in.set."),
  name: (k) => k === "name" || k === "clink",
  color: (k) => k === "col",
  icon: (k) => k === "icon" || k === "led",
  filters: (k) => k.startsWith("flt."),
  gate: (k) => k.startsWith("gate.") || k.startsWith("gatesc."),
  eq: (k) => k.startsWith("eq.") || k.startsWith("peq."),
  dyn: (k) => k.startsWith("dyn.") || k.startsWith("dynxo.") || k.startsWith("dynsc."),
  inserts: (k) => k.startsWith("preins.") || k.startsWith("postins."),
  fader: (k) => k === "fdr",
  pan: (k) => k === "pan" || k === "wid",
  mute: (k) => k === "mute",
  sends: (k) => k.startsWith("send."),
  mains: (k) => k.startsWith("main."),
};

type Dump = Record<string, string | number>;

/** `tags` holds DCA ("#D3") and mute group ("#M2") membership in one comma-separated leaf. */
function mergeTags(fromTags: string, toTags: string, dca: boolean, mute: boolean): string {
  const split = (t: string) => t.split(",").map((s) => s.trim()).filter(Boolean);
  const moved = (tag: string) => (dca && /^#D\d+$/.test(tag)) || (mute && /^#M\d+$/.test(tag));
  return [...split(toTags).filter((t) => !moved(t)), ...split(fromTags).filter(moved)].join(",");
}

/** What `target` becomes when it takes `source`'s values for `scopes`, in dump (= wire) order. */
export function planTransfer(source: Dump, target: Dump, scopes: readonly ChannelScope[]): Record<string, number | string> {
  const all = scopes.includes("all");
  const out: Record<string, number | string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (key === "tags") continue;
    if (all || scopes.some((s) => s in SCOPE_KEYS && SCOPE_KEYS[s as keyof typeof SCOPE_KEYS](key))) {
      out[key] = value;
    }
  }
  const dca = all || scopes.includes("dcaTags");
  const mute = all || scopes.includes("muteGroups");
  if (dca || mute) {
    out.tags = mergeTags(String(source.tags ?? ""), String(target.tags ?? ""), dca, mute);
  }
  return out;
}

export interface KeyDiff {
  key: string;
  current: number | string | null;
  next: number | string;
}

function diff(target: Dump, planned: Record<string, number | string>): KeyDiff[] {
  return Object.entries(planned)
    .filter(([key, next]) => !valuesMatch(next, target[key] ?? null))
    .map(([key, next]) => ({ key, current: target[key] ?? null, next }));
}

/**
 * Groups a flat assignment map into one bulk-set per top-level section, keeping dump order within
 * each. One ~300-key string per strip would do, but a section at a time keeps each request small
 * and keeps a plugin's `mdl` in the same request as the parameters that only exist once it is set.
 */
function chunkBySection(assignments: Record<string, number | string>): Array<Record<string, number | string>> {
  const chunks = new Map<string, Record<string, number | string>>();
  for (const [key, value] of Object.entries(assignments)) {
    const section = key.includes(".") ? (key.split(".")[0] as string) : "";
    const chunk = chunks.get(section) ?? {};
    chunk[key] = value;
    chunks.set(section, chunk);
  }
  return [...chunks.values()];
}

export interface Reference {
  path: string;
  current: string | number;
  next: string | number;
  what: string;
}

/**
 * Everything elsewhere on the console that names channel `a` or `b`, and what it becomes once the
 * two trade places: user signals 1-24 tapping either strip, and every channel's gate/dyn sidechain
 * source (`CH.n`).
 */
export async function findSwapReferences(ctx: WingPluginContext, kind: "ch" | "aux", a: number, b: number): Promise<Reference[]> {
  const refs: Reference[] = [];
  const wireGroup = kind === "ch" ? "CH" : "AUX";
  for (let n = 1; n <= USER_SIGNAL_STRIP_RANGE_MAX; n++) {
    const d = await ctx.client.dump(ioInPath("USR", n)).catch(() => null);
    if (!d || d["user.grp"] !== wireGroup) continue;
    const idx = Number(d["user.in"]);
    if (idx === a || idx === b) {
      refs.push({ path: `${ioInPath("USR", n)}/user/in`, current: idx, next: idx === a ? b : a, what: `user signal ${n}` });
    }
  }
  if (kind === "ch") {
    for (let n = 1; n <= 40; n++) {
      for (const sc of ["gatesc", "dynsc"]) {
        const r = await ctx.client.get(`/ch/${n}/${sc}/src`).catch(() => null);
        const v = r && r.kind === "leaf" ? String(r.value) : "";
        if (v === `CH.${a}` || v === `CH.${b}`) {
          refs.push({ path: `/ch/${n}/${sc}/src`, current: v, next: v === `CH.${a}` ? `CH.${b}` : `CH.${a}`, what: `ch ${n} ${sc === "gatesc" ? "gate" : "dyn"} sidechain` });
        }
      }
    }
  }
  return refs;
}

export interface TransferResult {
  strip: string;
  planned: number;
  changed: KeyDiff[];
  mismatches: Array<{ key: string; expected: number | string; stored: number | string | null }>;
  status: string;
}

async function writeStrip(
  ctx: WingPluginContext,
  base: string,
  planned: Record<string, number | string>,
  before: Dump,
): Promise<TransferResult> {
  const changed = diff(before, planned);
  const toWrite = Object.fromEntries(changed.map((c) => [c.key, c.next]));
  let status = "OK";
  for (const chunk of chunkBySection(toWrite)) {
    const knownPrevious = Object.fromEntries(Object.keys(chunk).map((k) => [k, before[k] ?? null]));
    const ack = await ctx.client.bulkSet(base, chunk, { verifyText: false, knownPrevious });
    if (!ack.ok) status = ack.status;
  }
  const after = await ctx.client.dump(base);
  const mismatches = Object.entries(planned)
    .filter(([key, value]) => !valuesMatch(value, after[key] ?? null))
    .map(([key, expected]) => ({ key, expected, stored: after[key] ?? null }));
  if (status === "OK" && mismatches.length > 0) status = "MISMATCH";
  return { strip: base, planned: Object.keys(planned).length, changed, mismatches, status };
}

export interface TransferOptions {
  scopes: readonly ChannelScope[];
  dryRun?: boolean;
  /** Mute both strips while writing, then restore. */
  muteDuring?: boolean;
  /** Swap only: re-point user signals and sidechains that named either strip. Default true. */
  updateReferences?: boolean;
}

export interface TransferReport {
  mode: "copy" | "swap";
  dryRun: boolean;
  ok: boolean;
  strips: TransferResult[];
  references: Reference[];
  referencesUpdated: boolean;
  /** Present on a dry run: per strip, the keys that would change. */
  diffs?: Record<string, KeyDiff[]>;
  warnings: string[];
}

function insertWarnings(planned: Record<string, number | string>): string[] {
  const slots = Object.entries(planned)
    .filter(([k, v]) => (k === "preins.ins" || k === "postins.ins") && v !== "NONE")
    .map(([, v]) => v);
  return slots.length
    ? [`Inserts reference shared FX slots (${slots.join(", ")}): after a copy, both strips insert the same FX.`]
    : [];
}

export async function transferChannel(
  ctx: WingPluginContext,
  kind: "ch" | "aux",
  mode: "copy" | "swap",
  a: number,
  b: number,
  opts: TransferOptions,
): Promise<TransferReport> {
  if (a === b) throw new WingValueError(`Cannot ${mode} ${kind} ${a} with itself.`);
  if (opts.scopes.length === 0) throw new WingValueError("scope is empty.");
  const baseA = stripPath(kind, a);
  const baseB = stripPath(kind, b);
  const [dumpA, dumpB] = [await ctx.client.dump(baseA), await ctx.client.dump(baseB)];

  // copy: a -> b.  swap: a <- b and b <- a, both planned from the dumps taken before any write.
  const plans: Array<{ base: string; planned: Record<string, number | string>; before: Dump }> =
    mode === "copy"
      ? [{ base: baseB, planned: planTransfer(dumpA, dumpB, opts.scopes), before: dumpB }]
      : [
          { base: baseA, planned: planTransfer(dumpB, dumpA, opts.scopes), before: dumpA },
          { base: baseB, planned: planTransfer(dumpA, dumpB, opts.scopes), before: dumpB },
        ];

  const warnings = mode === "copy" ? insertWarnings(plans[0]?.planned ?? {}) : [];
  const wantsRefs = mode === "swap" && (opts.updateReferences ?? true);
  const references = mode === "swap" ? await findSwapReferences(ctx, kind, a, b) : [];
  if (mode === "swap" && references.length > 0 && !opts.scopes.includes("all") && !opts.scopes.includes("source")) {
    warnings.push("Only part of the strips was swapped, so references to them were reported but left alone.");
  }
  const updateRefs = wantsRefs && (opts.scopes.includes("all") || opts.scopes.includes("source"));

  if (opts.dryRun) {
    const diffs = Object.fromEntries(plans.map((p) => [p.base, diff(p.before, p.planned)]));
    return { mode, dryRun: true, ok: true, strips: [], references, referencesUpdated: false, diffs, warnings };
  }

  const touched = mode === "copy" ? [baseB] : [baseA, baseB];
  const originalMute: Record<string, number | string> = { [baseA]: dumpA.mute ?? 0, [baseB]: dumpB.mute ?? 0 };
  if (opts.muteDuring) {
    for (const base of touched) {
      await ctx.client.bulkSet(base, { mute: 1 }, { knownPrevious: { mute: originalMute[base] ?? null } });
    }
  }

  const strips: TransferResult[] = [];
  for (const p of plans) {
    // With muteDuring the strip is muted now; its mute is settled after all writes below.
    const planned = opts.muteDuring ? Object.fromEntries(Object.entries(p.planned).filter(([k]) => k !== "mute")) : p.planned;
    const before = opts.muteDuring ? { ...p.before, mute: 1 } : p.before;
    strips.push(await writeStrip(ctx, p.base, planned, before));
  }

  if (opts.muteDuring) {
    for (const p of plans) {
      const finalMute = p.planned.mute ?? originalMute[p.base] ?? 0;
      await ctx.client.bulkSet(p.base, { mute: finalMute }, { knownPrevious: { mute: 1 } });
    }
  }

  if (updateRefs) {
    for (const ref of references) {
      const idx = ref.path.lastIndexOf("/");
      await ctx.client.bulkSet(ref.path.slice(0, idx), { [ref.path.slice(idx + 1)]: ref.next }, { knownPrevious: { [ref.path.slice(idx + 1)]: ref.current } });
    }
  }

  return {
    mode,
    dryRun: false,
    ok: strips.every((s) => s.status === "OK"),
    strips,
    references,
    referencesUpdated: updateRefs,
    warnings,
  };
}
