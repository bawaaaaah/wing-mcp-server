import type { WingParamMeta } from "./wing-param-catalog.js";
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
 * Builds the compact "key=val,key2=val2" assignment string used by the
 * bulk-set command. Callers are responsible for flattening nested keys with
 * "." (e.g. "eq.on") before calling this — this helper only joins.
 *
 * Known protocol limitation: string values containing "," or "=" cannot be
 * represented in this format; none of the WING param catalog's string/enum
 * values are expected to contain those characters.
 */
export function buildBulkSetString(assignments: Record<string, number | string>): string {
  return Object.entries(assignments)
    .map(([key, value]) => `${key}=${value}`)
    .join(",");
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
