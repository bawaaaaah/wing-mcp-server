import { WingValueError } from "./wing-errors.js";
import { splitLeafPath } from "./tools/generic.js";
import { parseWingDescribeParams } from "./wing-value-codec.js";
import type { WingPluginContext } from "./wing-plugin.js";

/**
 * Generic path-based value memory: a pure client-side layer over already-readable/writable OSC
 * leaves, no new console capability. Process-lifetime state (not per-session, not persisted) — one
 * shared `Map` keyed by OSC path. Each entry tracks two INDEPENDENT slots that must never overwrite
 * each other: `checkpoint` (written only by `storeValue`, read only by `restoreValue`) and
 * `lastAdjust` (written only by `adjustValueByDelta`, consumed once by `undoLastAdjust`). An earlier
 * version shared one field for both, which meant an `adjustValueByDelta` between `storeValue` and
 * `restoreValue` silently clobbered the original checkpoint with the just-adjusted value (so
 * `restoreValue` became a no-op instead of going back to what was stored), and `undoLastAdjust`
 * couldn't tell a store-only entry from a real adjustment (so it would "undo" an adjustment that
 * never happened). Keeping the two slots separate, and deleting `lastAdjust` once consumed, fixes
 * both: `undoLastAdjust` only ever reverts the single most recent `adjustValueByDelta` call (not a
 * full history stack, matching the roadmap's scope), and a second undo with nothing new adjusted
 * correctly throws rather than silently repeating.
 */
interface MemoryEntry {
  checkpoint?: number | string;
  lastAdjust?: { oldValue: number; newValue: number };
}
const memory = new Map<string, MemoryEntry>();

interface WingAck {
  status: string;
  ok: boolean;
  raw: string;
}

export interface StoredValue {
  path: string;
  value: number | string;
}

/** Reads a leaf's current value and remembers it as this path's checkpoint. */
export async function storeValue(ctx: WingPluginContext, path: string): Promise<StoredValue> {
  const result = await ctx.client.get(path);
  if (result.kind !== "leaf") {
    throw new WingValueError(`${path} is a branch, not a leaf — nothing to store.`);
  }
  memory.set(path, { ...memory.get(path), checkpoint: result.value });
  return { path, value: result.value };
}

export interface RestoreValueResult {
  path: string;
  value: number | string;
  ack: WingAck;
}

/** Writes back the value last remembered for this path via `storeValue`. */
export async function restoreValue(ctx: WingPluginContext, path: string): Promise<RestoreValueResult> {
  const entry = memory.get(path);
  if (entry?.checkpoint === undefined) {
    throw new WingValueError(`No stored value for ${path} — call storeValue first.`);
  }
  const { baseNode, key } = splitLeafPath(path);
  const ack = await ctx.client.bulkSet(baseNode, { [key]: entry.checkpoint });
  return { path, value: entry.checkpoint, ack };
}

export interface AdjustValueResult {
  path: string;
  oldValue: number;
  newValue: number;
  clamped: boolean;
  ack: WingAck;
}

/**
 * Nudges a numeric leaf by `delta`, clamped to the console's own describe()-reported min/max for
 * that node when available — a leaf whose describe() reply doesn't parse (or has no range) is
 * written unclamped, relying on the console's own ack to reject a genuinely invalid value.
 * Remembers the pre-adjust value so `undoLastAdjust` can revert exactly this one step.
 *
 * describe() is called on the leaf's PARENT block (e.g. `/ch/1` for `/ch/1/fdr`), not the bare leaf
 * itself — describe() on a bare leaf genuinely fails on real hardware (confirmed live), the same
 * quirk wing-auto-compress.ts/wing-auto-gate.ts already work around by describing a block path and
 * picking out the one param they need by key. Describing the leaf itself here would make `param`
 * always undefined on real hardware and silently disable clamping entirely.
 */
export async function adjustValueByDelta(ctx: WingPluginContext, path: string, delta: number): Promise<AdjustValueResult> {
  const { baseNode, key } = splitLeafPath(path);
  const [description, current] = await Promise.all([ctx.client.describe(baseNode).catch(() => null), ctx.client.get(path)]);
  if (current.kind !== "leaf" || typeof current.value !== "number") {
    throw new WingValueError(`${path} is not a numeric leaf — adjustValueByDelta only works on numeric values.`);
  }
  const param = description ? parseWingDescribeParams(description.lines).find((p) => p.key === key) : undefined;
  const oldValue = current.value;
  let newValue = oldValue + delta;
  let clamped = false;
  if (param?.min !== undefined && newValue < param.min) {
    newValue = param.min;
    clamped = true;
  }
  if (param?.max !== undefined && newValue > param.max) {
    newValue = param.max;
    clamped = true;
  }
  const ack = await ctx.client.bulkSet(baseNode, { [key]: newValue });
  memory.set(path, { ...memory.get(path), lastAdjust: { oldValue, newValue } });
  return { path, oldValue, newValue, clamped, ack };
}

export interface UndoAdjustResult {
  path: string;
  value: number | string;
  ack: WingAck;
}

/** Reverts the single most recent `adjustValueByDelta` call for this path. */
export async function undoLastAdjust(ctx: WingPluginContext, path: string): Promise<UndoAdjustResult> {
  const entry = memory.get(path);
  if (!entry?.lastAdjust) {
    throw new WingValueError(`No adjustment recorded for ${path} — call adjustValueByDelta first.`);
  }
  const { oldValue } = entry.lastAdjust;
  const { baseNode, key } = splitLeafPath(path);
  const ack = await ctx.client.bulkSet(baseNode, { [key]: oldValue });
  memory.set(path, { ...entry, lastAdjust: undefined });
  return { path, value: oldValue, ack };
}
