import type { BridgeSafes } from "./wing-config.js";

/**
 * Which console paths a bridged client may not write, given the strips marked safe. Pure: the
 * input sources come in through `sourceLookup`, so this file never talks to the console.
 *
 * Sends belong to their destination. A channel safe protects the strip and the physical input it
 * is patched from, but not its sends or main assigns: those are the mix of whoever owns the bus. A
 * bus, main or matrix safe protects what comes *into* it from every strip, and not its own outgoing
 * sends, for the same reason. Each row below is one declarative rule; changing a default is a
 * one-line change here.
 *
 * Every ambiguity resolves toward protecting: a path the rules cannot place (an unknown source, a
 * write on a branch above a protected node, a relative bulk-set key) is refused.
 */

export const SAFE_KINDS = ["ch", "aux", "bus", "main", "mtx", "dca"] as const;
export type SafeKind = (typeof SAFE_KINDS)[number];

export interface SourceRef {
  group: string;
  index: number;
}

/** A channel or aux's Main and Alt input. `null` for a slot patched to nothing. */
export interface StripSources {
  main: SourceRef | null;
  alt: SourceRef | null;
}

/** `undefined` while a strip's patch is not known yet: every input source is then protected. */
export type SourceLookup = (kind: "ch" | "aux", index: number) => StripSources | undefined;

export interface SafeRulesOptions {
  /** While any strip is safe, also protect scene recall (`/$ctl/lib`) and `/cfg`. */
  protectGlobal?: boolean;
}

export interface SafeRules {
  /** The safe that protects `path` ("ch 5", "bus 16 (incoming send)", ...), or null when writable. */
  protectedBy(path: string): string | null;
  isProtectedPath(path: string): boolean;
  /**
   * The roots of every protected subtree, as OSC paths with `*` for any index — what the native
   * proxy's node map covers (see walkPatterns for what it actually walks).
   */
  walkTargets(): string[];
  /**
   * The same subtrees spelled for `walkNodeMap`: alternatives expanded ("/*\/*\/send/16" becomes
   * "/ch/*\/send/16/**", "/aux/*\/send/16/**", "/bus/*\/send/16/**"), so the walk lists only the
   * branches a rule can reach.
   */
  walkPatterns(): string[];
  /** False while a safe channel/aux's input patch is unknown (so all of `/io/in` is protected). */
  readonly sourcesReady: boolean;
  /** True when nothing is safe: every write passes. */
  readonly empty: boolean;
}

/**
 * `/%9000/CH/01//$fdr` -> ["ch", "1", "fdr"]: the reply-port prefix and empty segments dropped,
 * lowercased, a leading `$` (shadow address) dropped, and leading zeros of a number removed. The
 * console is lenient about some of these, so treating them as the same node errs toward protecting.
 */
export function normalizeBridgePath(path: string): string[] {
  const segments = path.split("/").filter((segment) => segment.length > 0);
  if (segments[0]?.startsWith("%")) segments.shift();
  return segments.map((segment) => {
    let s = segment.toLowerCase();
    while (s.startsWith("$")) s = s.slice(1);
    if (/^\d+$/.test(s)) return String(Number(s));
    const mx = /^mx0*(\d+)$/.exec(s);
    if (mx) return `mx${Number(mx[1])}`;
    return s;
  });
}

/** A segment test; `values` lists what it accepts, absent for "any index". */
type SegmentTest = ((segment: string) => boolean) & { values?: readonly string[] };

interface Rule {
  /** Shown in status and block logs. */
  label: string;
  /** One test per segment; a path matching every test (or a prefix of them) is in this rule. */
  pattern: SegmentTest[];
  /** For display and `walkTargets`. */
  display: string;
  /** Subpaths that stay writable, judged on the segments past the pattern. */
  except?: (rest: string[]) => boolean;
}

const is = (...values: string[]): SegmentTest => Object.assign((segment: string) => values.includes(segment), { values });
const anyIndex: SegmentTest = () => true;

/** Outgoing sends and main assigns: "belongs to the destination". */
const OUTGOING = (rest: string[]) => rest[0] === "send" || rest[0] === "main";
const OUTGOING_SENDS = (rest: string[]) => rest[0] === "send";

function matchRule(rule: Rule, segments: string[]): boolean {
  const n = Math.min(rule.pattern.length, segments.length);
  for (let i = 0; i < n; i += 1) {
    if (!(rule.pattern[i] as SegmentTest)(segments[i] as string)) return false;
  }
  // Shorter than the pattern: a write on a branch above the protected node. Never meaningful from a
  // client, and a bulk-set on it has its keys judged one by one, so refusing it costs nothing.
  if (segments.length < rule.pattern.length) return true;
  return !rule.except?.(segments.slice(rule.pattern.length));
}

/** A stereo source is addressed by either half: protect both of an odd/even pair, whatever the mode. */
function pairOf(index: number): number {
  return index % 2 === 1 ? index + 1 : index - 1;
}

function sourceRules(owner: string, sources: StripSources): Rule[] {
  const rules: Rule[] = [];
  for (const [slot, ref] of [
    ["main", sources.main],
    ["alt", sources.alt],
  ] as const) {
    if (!ref) continue;
    const group = ref.group.toLowerCase();
    for (const index of [ref.index, pairOf(ref.index)]) {
      if (index < 1) continue;
      rules.push({
        label: `${owner} (${slot} source ${ref.group}${ref.index})`,
        pattern: [is("io"), is("in"), is(group), is(String(index))],
        display: `/io/in/${ref.group}/${index}`,
      });
    }
  }
  return rules;
}

function expandPattern(rule: Rule): string[] {
  let paths = [""];
  for (const test of rule.pattern) {
    const options = test.values ?? ["*"];
    paths = paths.flatMap((path) => options.map((option) => `${path}/${option}`));
  }
  return paths.map((path) => `${path}/**`);
}

function uniqueSorted(values: readonly number[]): number[] {
  return [...new Set(values.filter((n) => Number.isInteger(n) && n >= 1))].sort((a, b) => a - b);
}

export function buildSafeRules(safes: BridgeSafes, sourceLookup: SourceLookup, opts: SafeRulesOptions = {}): SafeRules {
  const rules: Rule[] = [];
  let sourcesReady = true;
  let unknownSourceOwner: string | null = null;

  for (const kind of ["ch", "aux"] as const) {
    for (const n of uniqueSorted(safes[kind] ?? [])) {
      const owner = `${kind} ${n}`;
      rules.push({ label: owner, pattern: [is(kind), is(String(n))], display: `/${kind}/${n}`, except: OUTGOING });
      const sources = sourceLookup(kind, n);
      if (sources === undefined) {
        sourcesReady = false;
        unknownSourceOwner ??= owner;
      } else {
        rules.push(...sourceRules(owner, sources));
      }
    }
  }
  if (unknownSourceOwner !== null) {
    rules.push({ label: `${unknownSourceOwner} (input patch not known yet)`, pattern: [is("io"), is("in")], display: "/io/in" });
  }

  for (const n of uniqueSorted(safes.bus ?? [])) {
    rules.push({ label: `bus ${n}`, pattern: [is("bus"), is(String(n))], display: `/bus/${n}`, except: OUTGOING });
    rules.push({
      label: `bus ${n} (incoming send)`,
      pattern: [is("ch", "aux", "bus"), anyIndex, is("send"), is(String(n))],
      display: `/*/*/send/${n}`,
    });
  }
  for (const n of uniqueSorted(safes.main ?? [])) {
    rules.push({ label: `main ${n}`, pattern: [is("main"), is(String(n))], display: `/main/${n}`, except: OUTGOING_SENDS });
    rules.push({
      label: `main ${n} (incoming assign)`,
      pattern: [is("ch", "aux", "bus"), anyIndex, is("main"), is(String(n))],
      display: `/*/*/main/${n}`,
    });
  }
  for (const n of uniqueSorted(safes.mtx ?? [])) {
    rules.push({ label: `mtx ${n}`, pattern: [is("mtx"), is(String(n))], display: `/mtx/${n}`, except: OUTGOING_SENDS });
    rules.push({
      label: `mtx ${n} (incoming send)`,
      pattern: [is("ch", "aux", "bus", "main"), anyIndex, is("send"), is(`mx${n}`)],
      display: `/*/*/send/MX${n}`,
    });
  }
  for (const n of uniqueSorted(safes.dca ?? [])) {
    rules.push({ label: `dca ${n}`, pattern: [is("dca"), is(String(n))], display: `/dca/${n}` });
  }

  const empty = rules.length === 0;
  if (!empty && (opts.protectGlobal ?? true)) {
    rules.push({ label: "scenes (global protection)", pattern: [is("ctl"), is("lib")], display: "/$ctl/lib" });
    rules.push({ label: "config (global protection)", pattern: [is("cfg")], display: "/cfg" });
  }

  const protectedBy = (path: string): string | null => {
    if (empty) return null;
    const segments = normalizeBridgePath(path);
    // The root itself: only a bulk-set can target it, and its keys are judged one by one.
    if (segments.length === 0) return null;
    for (const rule of rules) {
      if (matchRule(rule, segments)) return rule.label;
    }
    return null;
  };

  return {
    protectedBy,
    isProtectedPath: (path) => protectedBy(path) !== null,
    walkTargets: () => [...new Set(rules.map((rule) => rule.display))],
    walkPatterns: () => [...new Set(rules.flatMap(expandPattern))],
    sourcesReady,
    empty,
  };
}

export function countSafes(safes: BridgeSafes): number {
  return SAFE_KINDS.reduce((sum, kind) => sum + uniqueSorted(safes[kind] ?? []).length, 0);
}
