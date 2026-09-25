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
    // A value taken from a dump comes in the console's own shorthand ("1k50" = 1500 Hz), which is
    // what the channel copy and the undo journal write back.
    num = parseDumpNumber(value) ?? NaN;
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
  const validated = meta ? clampAndValidate(meta, value) : value;
  if (typeof validated === "string") {
    requireSafeBulkSetValue(validated, path);
    assertStringFits(path, validated);
  }
  return validated;
}

/**
 * Byte budgets of the free-text leaves every strip and source shares (protocol reference: "16 chars
 * max" for `name`, "80 chars max" for `tags`). Verified against real hardware that the budget is in
 * UTF-8 bytes, not characters — sixteen "é" were stored as eight — and that the console truncates
 * an over-long value silently while still acking OK, so the only place to refuse it is here.
 */
const STRING_LEAF_MAX_BYTES: Record<string, number> = { name: 16, tags: 80 };

export function stringLeafMaxBytes(path: string): number | undefined {
  // Accepts a path ("/ch/1/name") or a bulk-set key ("user.name") alike.
  return STRING_LEAF_MAX_BYTES[path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf(".")) + 1)];
}

export function assertStringFits(path: string, value: string): void {
  const max = stringLeafMaxBytes(path);
  if (max === undefined) return;
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes > max) {
    throw new WingValueError(
      `${JSON.stringify(value)} is ${bytes} bytes long; ${path} holds at most ${max} UTF-8 bytes ` +
        `(an accented letter counts as 2, so a name can hold fewer than ${max} characters). The console ` +
        "would silently truncate it.",
    );
  }
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
 * The integer a `,sfi` reply stands for. Verified against real hardware: the third argument is not
 * the value but its offset from the parameter's minimum — `/ch/5/in/conn/in` (range 1..64) patched to
 * input 10 replies `("10", 0.1428, 9)`, and a `col` of 10 (Salmon, range 1..18) replies `("10", …, 9)`.
 * For a range starting at 0 (icon, mute, on) the two coincide, which is why reading the third
 * argument looked right almost everywhere and silently read every 1-based index one low. The display
 * string is what the console shows, so it wins whenever it is a plain integer; the offset is only a
 * fallback for a display that is not one.
 */
function decodeIntReply(display: string, offsetFromMin: number): number {
  return /^[+-]?\d+$/.test(display.trim()) ? Number(display.trim()) : offsetFromMin;
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
    const display = String(args[0].value);
    return {
      valueKind: "int",
      display,
      raw: Number(args[1].value),
      value: decodeIntReply(display, Number(args[2].value)),
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
  let escaped = false;
  for (const char of raw) {
    if (escaped) {
      escaped = false;
      current += char;
      continue;
    }
    if (inQuotes && char === "\\") {
      escaped = true;
      current += char;
      continue;
    }
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
    const quoted = rawValue.length >= 2 && rawValue.startsWith("'") && rawValue.endsWith("'");
    if (quoted) {
      // Verified against real hardware: the console escapes a quote inside a quoted value as `\'`
      // (`name='L\'orgue'`), and writes any other backslash through as-is.
      rawValue = rawValue.slice(1, -1).replace(/\\'/g, "'");
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
    // A quoted value is a string even when it looks numeric: a name of "12" must stay "12".
    const looksNumeric = !quoted && /^-?\d+(\.\d+)?$/.test(rawValue);
    result[fullPath] = looksNumeric ? Number(rawValue) : rawValue;
  }

  return result;
}

/**
 * Rejects a free-text value the console cannot store faithfully. Verified against real hardware: a
 * control character (tab, newline, ...) is dropped even inside a quoted value, so a name containing
 * one would be written as something else while the console still acks OK. Everything else — spaces,
 * commas, "=", quotes, backslashes, UTF-8 — round-trips once `encodeBulkSetValue` quotes it.
 */
export function requireSafeBulkSetValue(value: string, label: string): string {
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new WingValueError(`${label} cannot contain control characters (tab, newline, ...) — the console drops them.`);
  }
  return value;
}

/**
 * Characters that can go unquoted in a bulk-set value. Deliberately narrow: every catalog enum
 * ("L+R", "M/S", "-oo", "A", ...) and every number fits, so those go on the wire byte-for-byte as they
 * always have, and anything else is quoted.
 */
const UNQUOTED_BULK_SET_VALUE_RE = /^[A-Za-z0-9_.+\-/]+$/;

/**
 * Encodes one value of a bulk-set assignment. Verified against real hardware (2026-09-25, on a user
 * signal's name): the console strips every whitespace character from an unquoted value — "TB Samuel"
 * was stored as "TBSamuel" while the console acked OK — and a comma or "=" splits the assignment.
 * Inside single quotes all of those survive, which is also how the console writes such a value in its
 * own dumps (`name='DM Karina'`). Within the quotes, `\` escapes the next character: `\'` for a quote,
 * `\\` for a backslash (an unescaped backslash swallows what follows it). The empty string is sent as
 * `''`, which stores an empty value.
 */
export function encodeBulkSetValue(value: number | string): string {
  if (typeof value === "number") {
    return String(value);
  }
  if (UNQUOTED_BULK_SET_VALUE_RE.test(value)) {
    return value;
  }
  requireSafeBulkSetValue(value, "A bulk-set value");
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
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
 * Values go through `encodeBulkSetValue`, which quotes anything that is not a bare token.
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
    parts.push(`${encodedKey}=${encodeBulkSetValue(value)}`);

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
 * A numeric value as it appears in a dump or describe reply: plain ("-6.0"), "k" shorthand ("1k50",
 * "20k00"), or the fader floor "-oo" (-144 dB, the floor used everywhere in this project). `null` for
 * anything that is not a number (an enum member, a name).
 */
export function parseDumpNumber(value: string | number): number | null {
  if (typeof value === "number") return value;
  const t = value.trim();
  if (/^-oo$/i.test(t)) return -144;
  if (!/^[+-]?(\d+(\.\d+)?|\d+k\d+)$/.test(t)) return null;
  return parseWingDescribeNumber(t);
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
