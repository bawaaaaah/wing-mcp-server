import { WingValueError } from "./wing-errors.js";
import { BUS_COUNT, MAIN_COUNT, MATRIX_COUNT } from "./wing-node-paths.js";
import type { WingBulkSetResult } from "./wing-osc-client.js";
import type { WingPluginContext } from "./wing-plugin.js";
import type { ReportedValue } from "./wing-value-codec.js";

/**
 * Talkback config node (`/cfg/talk`): a global assignment mode plus two independent talk sources
 * (A/B, e.g. a console mic vs. a footswitch-triggered one), each with its own on/off, trigger mode,
 * monitor/bus dim amount, and a per-destination (bus/matrix/main) assignment bit. Verified against
 * `docs/WING_Remote-Protocols-3.1-03.pdf` — `/cfg/talk/$lvl` is the only field marked `[RO]` in the
 * reference; `/cfg/talk/{A,B}/$on` has no such marker despite the `$` prefix, so it is writable.
 *
 * Verified live against real hardware: `{A,B}/$on` is silently omitted from a `dump()` reply on this
 * node (same class of firmware behavior already documented for `/cfg/solo`'s `$`-prefixed fields in
 * wing-solo-monitor.ts) even though it reads fine individually — read via `get()` instead. The PDF's
 * `$lvl` is more than just RO: it isn't an addressable leaf on this hardware at all (a `get()` for it
 * times out rather than replying); the actual live talk level is the plain, unprefixed `lvl` field,
 * which appears in `dump()` normally, same shape/failure mode already documented for the monitor
 * bus's level field in wing-solo-monitor.ts.
 */

export const TALKBACK_ASSIGN_VALUES = ["OFF", "CH40", "AUX8"] as const;
export type TalkbackAssign = (typeof TALKBACK_ASSIGN_VALUES)[number];

export const TALKBACK_SOURCES = ["A", "B"] as const;
export type TalkbackSource = (typeof TALKBACK_SOURCES)[number];

export const TALKBACK_MODE_VALUES = ["AUTO", "PUSH", "LATCH"] as const;
export type TalkbackMode = (typeof TALKBACK_MODE_VALUES)[number];

export const TALKBACK_DESTINATION_TYPES = ["bus", "mtx", "main"] as const;
export type TalkbackDestinationType = (typeof TALKBACK_DESTINATION_TYPES)[number];

const DESTINATION_COUNTS: Record<TalkbackDestinationType, number> = { bus: BUS_COUNT, mtx: MATRIX_COUNT, main: MAIN_COUNT };
const DESTINATION_PREFIXES: Record<TalkbackDestinationType, string> = { bus: "B", mtx: "MX", main: "M" };

function requireTalkbackSource(source: string): asserts source is TalkbackSource {
  if (!(TALKBACK_SOURCES as readonly string[]).includes(source)) {
    throw new WingValueError(`source must be one of ${TALKBACK_SOURCES.join(", ")} (got ${source}).`);
  }
}

function destinationKey(type: TalkbackDestinationType, index: number): string {
  if (!(TALKBACK_DESTINATION_TYPES as readonly string[]).includes(type)) {
    throw new WingValueError(`type must be one of ${TALKBACK_DESTINATION_TYPES.join(", ")} (got ${type}).`);
  }
  const max = DESTINATION_COUNTS[type];
  if (!Number.isInteger(index) || index < 1 || index > max) {
    throw new WingValueError(`${type} index out of range: ${index} (expected 1..${max})`);
  }
  return `${DESTINATION_PREFIXES[type]}${index}`;
}

function asString(value: string | number | undefined, fallback = ""): string {
  return value === undefined ? fallback : String(value);
}

function asNumber(value: string | number | undefined, fallback = 0): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

async function getLeafOrNull(ctx: WingPluginContext, path: string): Promise<string | number | null> {
  try {
    const result = await ctx.client.get(path);
    return result.kind === "leaf" ? result.value : null;
  } catch {
    return null;
  }
}

export interface TalkbackDestinationStatus {
  bus: boolean[];
  mtx: boolean[];
  main: boolean[];
}

export interface TalkbackSourceStatus {
  on: boolean;
  mode: ReportedValue<TalkbackMode>;
  mondim: number;
  busdim: number;
  indiv: boolean;
  destinations: TalkbackDestinationStatus;
}

export interface TalkbackStatus {
  assign: ReportedValue<TalkbackAssign>;
  levelDb: number;
  a: TalkbackSourceStatus;
  b: TalkbackSourceStatus;
}

function parseSourceStatus(flat: Record<string, string | number>, onValue: string | number | null): TalkbackSourceStatus {
  return {
    on: onValue !== null && asNumber(onValue) === 1,
    mode: asString(flat.mode, "AUTO"),
    mondim: asNumber(flat.mondim),
    busdim: asNumber(flat.busdim),
    indiv: asNumber(flat.indiv) === 1,
    destinations: {
      bus: Array.from({ length: BUS_COUNT }, (_, i) => asNumber(flat[`B${i + 1}`]) === 1),
      mtx: Array.from({ length: MATRIX_COUNT }, (_, i) => asNumber(flat[`MX${i + 1}`]) === 1),
      main: Array.from({ length: MAIN_COUNT }, (_, i) => asNumber(flat[`M${i + 1}`]) === 1),
    },
  };
}

/** Reads the full talkback config: global assign/level, plus source A and B status. */
export async function getTalkbackStatus(ctx: WingPluginContext): Promise<TalkbackStatus> {
  const [base, a, b, onA, onB] = await Promise.all([
    ctx.client.dump("/cfg/talk"),
    ctx.client.dump("/cfg/talk/A"),
    ctx.client.dump("/cfg/talk/B"),
    getLeafOrNull(ctx, "/cfg/talk/A/$on"),
    getLeafOrNull(ctx, "/cfg/talk/B/$on"),
  ]);
  return {
    assign: asString(base.assign, "OFF"),
    levelDb: asNumber(base.lvl),
    a: parseSourceStatus(a, onA),
    b: parseSourceStatus(b, onB),
  };
}

export interface TalkbackAck {
  ack: WingBulkSetResult;
}

/** Sets the global talkback assignment mode (OFF, or which channel/aux the two talk sources feed). */
export async function setTalkbackAssign(ctx: WingPluginContext, assign: TalkbackAssign): Promise<TalkbackAck> {
  if (!(TALKBACK_ASSIGN_VALUES as readonly string[]).includes(assign)) {
    throw new WingValueError(`assign must be one of ${TALKBACK_ASSIGN_VALUES.join(", ")} (got ${assign}).`);
  }
  const ack = await ctx.client.bulkSet("/cfg/talk", { assign });
  return { ack };
}

export interface SetTalkbackSourceOptions {
  source: TalkbackSource;
  on?: boolean;
  mode?: TalkbackMode;
  mondim?: number;
  busdim?: number;
  indiv?: boolean;
}

/** Sets one talk source's (A or B) on/off, trigger mode, monitor/bus dim, and/or individual-send flag. */
export async function setTalkbackSource(ctx: WingPluginContext, opts: SetTalkbackSourceOptions): Promise<TalkbackAck> {
  const { source, on, mode, mondim, busdim, indiv } = opts;
  requireTalkbackSource(source);
  if (on === undefined && mode === undefined && mondim === undefined && busdim === undefined && indiv === undefined) {
    throw new WingValueError("At least one of on, mode, mondim, busdim, or indiv must be provided.");
  }
  if (mode !== undefined && !(TALKBACK_MODE_VALUES as readonly string[]).includes(mode)) {
    throw new WingValueError(`mode must be one of ${TALKBACK_MODE_VALUES.join(", ")} (got ${mode}).`);
  }
  if (mondim !== undefined && (!Number.isInteger(mondim) || mondim < 0 || mondim > 40)) {
    throw new WingValueError(`mondim must be an integer between 0 and 40 (got ${mondim}).`);
  }
  if (busdim !== undefined && (busdim < 0 || busdim > 40)) {
    throw new WingValueError(`busdim must be between 0 and 40 (got ${busdim}).`);
  }
  const assignments: Record<string, number | string> = {};
  if (on !== undefined) assignments.$on = on ? 1 : 0;
  if (mode !== undefined) assignments.mode = mode;
  if (mondim !== undefined) assignments.mondim = mondim;
  if (busdim !== undefined) assignments.busdim = busdim;
  if (indiv !== undefined) assignments.indiv = indiv ? 1 : 0;
  const ack = await ctx.client.bulkSet(`/cfg/talk/${source}`, assignments);
  return { ack };
}

export interface SetTalkbackDestinationOptions {
  source: TalkbackSource;
  type: TalkbackDestinationType;
  index: number;
  on: boolean;
}

/** Turns one talk source's assignment to a single bus/matrix/main destination on or off. */
export async function setTalkbackDestination(ctx: WingPluginContext, opts: SetTalkbackDestinationOptions): Promise<TalkbackAck> {
  const { source, type, index, on } = opts;
  requireTalkbackSource(source);
  const key = destinationKey(type, index);
  const ack = await ctx.client.bulkSet(`/cfg/talk/${source}`, { [key]: on ? 1 : 0 });
  return { ack };
}
