import { findParamMeta, pathToTemplate, type WingParamMeta } from "./wing-param-catalog.js";
import { WingValueError } from "./wing-errors.js";

/**
 * How far past [min, max] a numeric value is allowed to drift before we give
 * up on clamping and reject it outright. A caller passing e.g. fdr=-200
 * clearly means "as low as possible" and gets silently clamped to -144; a
 * caller passing fdr=1e9 almost certainly has a bug and gets a hard error
 * instead of a silently-clamped, surprising -144.
 */
const WILD_OUT_OF_RANGE_MULTIPLIER = 3;

/**
 * Validates (and range-clamps) a value against a catalog entry before it is
 * sent to the console. Numbers within a bounded multiple of [min, max] are
 * clamped into range; numbers wildly outside that range throw
 * `WingValueError` instead of silently clamping to a boundary that the
 * caller likely did not intend. Enum values must be an exact member of
 * `enumValues`; free-form strings are passed through unchanged.
 */
export function clampAndValidate(meta: WingParamMeta, value: number | string): number | string {
  if (meta.type === "enum") {
    if (typeof value !== "string" || !meta.enumValues?.includes(value)) {
      const allowed = meta.enumValues?.join(", ") ?? "(no enum values declared)";
      throw new WingValueError(
        `Invalid value ${JSON.stringify(value)} for ${meta.pathTemplate}: expected one of ${allowed}`
      );
    }
    return value;
  }

  if (meta.type === "string") {
    if (typeof value !== "string") {
      throw new WingValueError(`Invalid value for ${meta.pathTemplate}: expected a string, got ${typeof value}`);
    }
    return value;
  }

  // float | int
  let num: number;
  if (typeof value === "string") {
    if (value.trim().toLowerCase() === "-oo" && meta.type === "float") {
      return meta.min ?? -144;
    }
    num = Number(value);
  } else {
    num = value;
  }

  if (!Number.isFinite(num)) {
    throw new WingValueError(`Invalid numeric value for ${meta.pathTemplate}: ${JSON.stringify(value)}`);
  }

  if (meta.type === "int") {
    num = Math.round(num);
  }

  if (meta.min !== undefined && meta.max !== undefined) {
    const span = meta.max - meta.min;
    const wildLow = meta.min - span * WILD_OUT_OF_RANGE_MULTIPLIER;
    const wildHigh = meta.max + span * WILD_OUT_OF_RANGE_MULTIPLIER;
    if (num < wildLow || num > wildHigh) {
      throw new WingValueError(
        `Value ${num} for ${meta.pathTemplate} is far outside the expected range [${meta.min}, ${meta.max}]`
      );
    }
    num = Math.min(meta.max, Math.max(meta.min, num));
  }

  return num;
}

/**
 * Validates/clamps a value against the catalog entry for `path` (via `pathToTemplate` +
 * `findParamMeta`) before it reaches `bulkSet`. Shared by the `wing_set`/`wing_bulk_set` MCP tools
 * and the mirrored `/set`/`/bulk-set` REST routes — same "one function, no MCP/REST duplication"
 * rule as the rest of this project. A path the catalog doesn't cover (e.g. "/aux/...", not yet
 * transcribed) has no meta to validate against and passes through unchanged — the catalog is a
 * best-effort subset of the full protocol, not exhaustive, so an uncovered path getting no
 * additional validation preserves today's behavior for it rather than inventing a stricter one.
 */
export function validateNodeValue(path: string, value: number | string): number | string {
  const meta = findParamMeta(pathToTemplate(path));
  return meta ? clampAndValidate(meta, value) : value;
}

interface OscMetadataArg {
  type: string;
  value: unknown;
}

export interface ParsedOscValue {
  valueKind: "float" | "int" | "string";
  display?: string;
  raw?: number;
  value: number | string;
}

/**
 * Parses the args of a WING OSC GET reply (read with osc.js `metadata: true`,
 * so each arg is `{type, value}`) into a normalized shape:
 *  - ",sff" -> float leaf: [display string, raw 0..1, real dB float]
 *  - ",sfi" -> int leaf:   [display string, raw 0..1, real integer]
 *  - ",s"   -> string/enum leaf: [value]
 * Any other shape is handled best-effort from the last argument, since the
 * protocol reference does not exhaustively document every leaf's tag combo.
 */
export function parseOscGetReply(args: OscMetadataArg[]): ParsedOscValue {
  if (args.length === 3 && args[0].type === "s" && args[1].type === "f" && args[2].type === "f") {
    return {
      valueKind: "float",
      display: String(args[0].value),
      raw: Number(args[1].value),
      value: Number(args[2].value),
    };
  }

  if (args.length === 3 && args[0].type === "s" && args[1].type === "f" && args[2].type === "i") {
    return {
      valueKind: "int",
      display: String(args[0].value),
      raw: Number(args[1].value),
      value: Number(args[2].value),
    };
  }

  if (args.length === 1 && args[0].type === "s") {
    return { valueKind: "string", value: String(args[0].value) };
  }

  const last = args[args.length - 1];
  if (!last) {
    throw new WingValueError("Empty OSC reply arguments; cannot parse a value");
  }
  if (last.type === "f" || last.type === "i") {
    return { valueKind: last.type === "f" ? "float" : "int", value: Number(last.value) };
  }
  return { valueKind: "string", value: String(last.value) };
}

/**
 * Splits a flat assignment string on top-level commas only — a comma inside a single-quoted value
 * (e.g. `tags='#D1,#M1'`, observed on real hardware) must not split the entry in two.
 */
function splitTopLevelAssignments(raw: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inQuotes = false;
  for (const char of raw) {
    if (char === "'") {
      inQuotes = !inQuotes;
    }
    if (char === "," && !inQuotes) {
      parts.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  if (current.length > 0) {
    parts.push(current);
  }
  return parts;
}

/**
 * Parses the flat assignment string returned by a `dump()` ('*') request.
 *
 * Verified against real hardware: nested keys are NOT simply dot-joined full paths from root — the
 * console emits a stateful, indentation-like delta encoding to keep the reply compact. Each entry's
 * key may carry zero or more leading dots; N leading dots means "pop N segments off the path context
 * built by the preceding entries, then descend via this entry's own (dot-separated) segments — all
 * but the last become the new context, the last is this entry's leaf name." A key with zero leading
 * dots and no internal dots is simply a sibling leaf of the current context.
 *
 * Confirmed end-to-end against a real channel's full dump (every nested section: in.set.*,
 * in.conn.*, flt.*, peq.*, gate.*, gatesc.*, eq.*, dyn.*, dynxo.*, dynsc.*, preins.*, main.N.*,
 * send.N.*, send.MXN.*, postins.*, tags) — e.g. the real wire sequence
 * `in.set.srcauto=1,altsrc=0,...,.conn.grp=A,in=1,...,..flt.lc=1,lcf=...,...,.clink=0,col=12,...`
 * expands correctly to in.set.srcauto, in.set.altsrc, ..., in.conn.grp, in.conn.in, ..., flt.lc,
 * flt.lcf, ..., clink, col, .... This same mechanism, not a `tags`-specific quirk, is also why a
 * lone `.tags=...` entry previously appeared mis-keyed — it is simply this general scheme's ordinary
 * "pop 1, no further segments" case, now handled correctly here rather than worked around per-caller.
 *
 * A value may be single-quoted when it contains a literal comma (observed for `tags`); quotes are
 * stripped from the stored value.
 */
export function parseFlatAssignmentString(raw: string): Record<string, string | number> {
  const result: Record<string, string | number> = {};
  const contextStack: string[] = [];

  for (const pair of splitTopLevelAssignments(raw)) {
    const trimmedPair = pair.trim();
    if (!trimmedPair) {
      continue;
    }
    const eqIdx = trimmedPair.indexOf("=");
    if (eqIdx < 0) {
      continue;
    }

    const rawKey = trimmedPair.slice(0, eqIdx).trim();
    let rawValue = trimmedPair.slice(eqIdx + 1).trim();
    if (rawValue.length >= 2 && rawValue.startsWith("'") && rawValue.endsWith("'")) {
      rawValue = rawValue.slice(1, -1);
    }

    let dotCount = 0;
    while (dotCount < rawKey.length && rawKey[dotCount] === ".") {
      dotCount++;
    }
    const segments = rawKey
      .slice(dotCount)
      .split(".")
      .filter((s) => s.length > 0);
    if (segments.length === 0) {
      continue;
    }

    if (dotCount > 0) {
      contextStack.length = Math.max(0, contextStack.length - dotCount);
    }
    const leaf = segments[segments.length - 1];
    contextStack.push(...segments.slice(0, -1));

    const fullPath = [...contextStack, leaf].join(".");
    const looksNumeric = /^-?\d+(\.\d+)?$/.test(rawValue);
    result[fullPath] = looksNumeric ? Number(rawValue) : rawValue;
  }

  return result;
}

/**
 * Rejects a free-text value that would corrupt a bulkSet() assignment string (see
 * buildBulkSetString's "Known protocol limitation" below) instead of silently letting it inject a
 * second, attacker/typo-chosen key=value pair into the same bulk-set call. Enum/catalog values never
 * need this (they're checked against a fixed member list instead), but any caller that forwards
 * genuine free text supplied by a user — a file path, a session/preset name — into a bulk-set
 * assignment must validate it with this first. Verified live against real hardware: a comma inside
 * an unquoted bulk-set value is parsed as a second assignment (confirmed both as a destination-node
 * "NODE NOT FOUND" ack for an unrelated field, and — worse — as a silently-accepted second write to
 * whatever key follows the comma).
 */
export function requireSafeBulkSetValue(value: string, label: string): string {
  if (value.includes(",") || value.includes("=")) {
    throw new WingValueError(`${label} cannot contain "," or "=" — these characters cannot be safely represented in a WING bulk-set assignment.`);
  }
  return value;
}

/**
 * Builds the compact assignment string used by the bulk-set command, applying the same
 * context-relative path encoding the console itself uses (see parseFlatAssignmentString's doc for
 * the read-side mirror of this). Verified against real hardware: repeating a shared prefix on every
 * sibling key (e.g. "eq.on=1,eq.mdl=STD") is NOT accepted — the console interprets the second
 * entry's leading "eq." as a *further* descent from the context the first entry already set to
 * "eq", resolving it to the nonsensical nested path "eq.eq.mdl" and acking NODE NOT FOUND. Each
 * key's leaf name is instead written with the minimal pop-count/descend delta relative to the
 * previous key: identical to how a plain, single flat key (no dots) has always been sent (0 pops,
 * no descend segments — this case is unchanged from before), multi-key nested assignments now
 * additionally reuse as much of the previous key's path as possible.
 *
 * Known protocol limitation: string values containing "," or "=" cannot be represented in this
 * format. Catalog enum/numeric values never contain those characters; free-text values (file paths,
 * session/preset names, ...) must be validated with `requireSafeBulkSetValue` by the caller before
 * reaching this function — this function itself does not and cannot detect the ambiguity once
 * multiple assignments are joined.
 */
export function buildBulkSetString(assignments: Record<string, number | string>): string {
  const contextStack: string[] = [];
  const parts: string[] = [];

  for (const [fullKey, value] of Object.entries(assignments)) {
    const segments = fullKey.split(".");
    const leaf = segments[segments.length - 1];
    const parentSegments = segments.slice(0, -1);

    let common = 0;
    while (common < contextStack.length && common < parentSegments.length && contextStack[common] === parentSegments[common]) {
      common++;
    }
    const popCount = contextStack.length - common;
    const descendSegments = parentSegments.slice(common);

    const encodedKey = ".".repeat(popCount) + [...descendSegments, leaf].join(".");
    parts.push(`${encodedKey}=${value}`);

    contextStack.length = common;
    contextStack.push(...descendSegments);
  }

  return parts.join(",");
}

const KNOWN_BULK_SET_ACK_STATUSES = [
  "OK",
  "NODE NOT FOUND",
  "VALUE ERROR",
  "BUFFER OVERFLOW",
  "NODE IS NOT PAR",
  "INCOMPLETE DATA",
  "STACK EMPTY",
] as const;

export function parseBulkSetAck(raw: string): { status: string; ok: boolean } {
  const status = raw.trim();
  return { status, ok: status === "OK" };
}

/** Exposed for callers that want to validate/display the known ack vocabulary. */
export { KNOWN_BULK_SET_ACK_STATUSES };

export interface WingDescribeParam {
  key: string;
  kind: "int" | "lin" | "log" | "list" | "string" | "fader" | "unknown";
  min?: number;
  max?: number;
  unit?: string;
  steps?: number;
  options?: string[];
  maxLength?: number;
}

/**
 * WING renders large frequency bounds in a "k" shorthand (e.g. "7k0" = 7000,
 * "20k00" = 20000) instead of plain decimal — verified against real hardware
 * describe() output for EQ frequency parameters. Returns `null` for the
 * "-oo"/"oo" infinity sentinel, which callers handle themselves (only the
 * "fader" kind uses it, and always as a lower bound).
 */
export function parseWingDescribeNumber(token: string): number | null {
  const t = token.trim();
  if (/^[+-]?oo$/i.test(t)) {
    return null;
  }
  const k = /^([+-]?\d+)k(\d+)$/.exec(t);
  if (k) {
    return Number(`${k[1]}.${k[2]}`) * 1000;
  }
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parses one line of a "?"/"#" describe reply into a typed parameter
 * descriptor. Verified against real hardware for all five observed kinds:
 *   "on             int [0 .. 1]"
 *   "lg             lin [-15.0 .. +15.0 dB], 301 steps"
 *   "lf             log [20.0 .. 20k00 Hz], 961 steps"
 *   "mdl            list [STD, SOUL, E88, ...]"
 *   "name           string [16]"
 *   "fdr            fader [-oo .. 10.0 dB], 1024 steps"
 * Unrecognized lines are dropped rather than surfaced as parse errors, since
 * this drives an optional UI affordance, not a protocol-correctness check.
 */
export function parseWingDescribeParams(lines: string[]): WingDescribeParam[] {
  const params: WingDescribeParam[] = [];
  for (const line of lines) {
    const m = /^(\S+)\s+(int|lin|log|list|string|fader)\b\s*(.*)$/.exec(line.trim());
    if (!m) {
      continue;
    }
    const [, key, kindRaw, rest] = m;
    const kind = kindRaw as WingDescribeParam["kind"];

    if (kind === "list") {
      const inner = /\[(.*)\]/.exec(rest)?.[1] ?? "";
      const options = inner
        .split(",")
        .map((o) => o.trim())
        .filter((o) => o.length > 0);
      params.push({ key, kind, options });
      continue;
    }

    if (kind === "string") {
      const len = /\[(\d+)\]/.exec(rest);
      params.push({ key, kind, maxLength: len ? Number(len[1]) : undefined });
      continue;
    }

    // int / lin / log / fader: "[min .. max unit?], N steps"
    const range = /\[([^\]]+)\]/.exec(rest);
    const steps = /,\s*(\d+)\s*steps/.exec(rest);
    let min: number | undefined;
    let max: number | undefined;
    let unit: string | undefined;
    if (range) {
      const parts = range[1].split("..").map((p) => p.trim());
      if (parts.length === 2) {
        const maxParts = /^([+-]?[\w.]+)\s*(.*)$/.exec(parts[1]);
        min = parseWingDescribeNumber(parts[0]) ?? undefined;
        max = parseWingDescribeNumber(maxParts?.[1] ?? parts[1]) ?? undefined;
        unit = maxParts?.[2]?.trim() || undefined;
      }
    }
    // "fader" always uses "-oo" as its lower bound on real hardware, which
    // parseWingDescribeNumber reports as undefined — default it to the same
    // floor used everywhere else in this project for a -oo fader value.
    if (kind === "fader" && min === undefined) {
      min = -144;
    }
    params.push({ key, kind, min, max, unit, steps: steps ? Number(steps[1]) : undefined });
  }
  return params;
}
