import { WingValueError } from "./wing-errors.js";
import { joinNodePath } from "./wing-osc-client.js";
import type { WingPluginContext } from "./wing-plugin.js";
import { parseDumpNumber, validateNodeValue } from "./wing-value-codec.js";
import { isAudiblePath } from "./wing-write-journal.js";

/** What happened to one key of a verified write. */
export interface WingWriteKeyResult {
  key: string;
  path: string;
  /** What the caller asked for. */
  requested: number | string;
  /** What was actually sent, after catalog validation/clamping. */
  sent: number | string;
  /** The value before the write (`null` if it could not be read). */
  previous: number | string | null;
  /** Read back after the write; absent on a dry run or with `verify: false`. */
  stored?: number | string | null;
  /** `stored` equals `sent` (numbers within the console's quantization). Absent when not verified. */
  match?: boolean;
  audible: boolean;
}

export interface WingWriteResult {
  /** "OK", "MISMATCH", "DRY RUN", or the console's own error ack ("NODE NOT FOUND", ...). */
  status: string;
  ok: boolean;
  dryRun: boolean;
  /** True if any written key changes the sound (see `isAudiblePath`). */
  audible: boolean;
  /** Journal batch the write was recorded in — pass it to `wing_undo`. */
  batchId?: string;
  results: WingWriteKeyResult[];
  raw?: string;
}

export interface WingWriteOptions {
  /** Read every key back after writing and compare. Default true. */
  verify?: boolean;
  /** Report current vs target for every key without writing anything. */
  dryRun?: boolean;
  /** Required for an audible write while `showMode` is on. */
  confirm?: boolean;
}

/**
 * Whether a value read back matches what was sent. Strings must match exactly (that is the whole
 * point: "TBSamuel" is not "TB Samuel"). Numbers are compared within the console's quantization —
 * a low-cut sent as 100 Hz is stored as 100.2, a fader as the nearest of its 1024 steps — so the
 * tolerance is 2% of the value or 0.06 absolute, whichever is larger. A numeric string ("1", "1k50",
 * "-oo") and the number it stands for are the same value.
 */
export function valuesMatch(sent: number | string, stored: number | string | null | undefined): boolean {
  if (stored === null || stored === undefined) return false;
  if (String(sent) === String(stored)) return true;
  // Dumps use the console's shorthand ("1k50", "-oo"), GETs plain numbers — compare as numbers
  // whenever both sides read as one.
  const sentNum = parseDumpNumber(sent);
  const storedNum = parseDumpNumber(stored);
  if (sentNum !== null && storedNum !== null) {
    return Math.abs(sentNum - storedNum) <= Math.max(0.06, Math.abs(sentNum) * 0.02);
  }
  return String(sent) === String(stored);
}

async function readLeaf(ctx: WingPluginContext, path: string): Promise<number | string | null> {
  try {
    const result = await ctx.client.get(path);
    return result.kind === "leaf" ? result.value : null;
  } catch {
    return null;
  }
}

export function assertShowModeAllows(ctx: WingPluginContext, audiblePaths: string[], confirm: boolean | undefined): void {
  if (!ctx.getConfig().showMode || confirm || audiblePaths.length === 0) return;
  throw new WingValueError(
    `Show mode is on and this write is audible (${audiblePaths.slice(0, 5).join(", ")}` +
      `${audiblePaths.length > 5 ? ", …" : ""}). Confirm with the operator, then call again with confirm: true.`,
  );
}

/**
 * The verified write every generic and identity tool goes through: validate, refuse an unconfirmed
 * audible write in show mode, read the current values, write in one ACK'd bulk-set, then read every
 * key back. The console's "OK" ack is not trusted on its own — verified against real hardware that
 * it acks values it then stores differently (see `encodeBulkSetValue`).
 */
export async function writeAssignments(
  ctx: WingPluginContext,
  baseNode: string,
  assignments: Record<string, number | string>,
  opts: WingWriteOptions = {},
): Promise<WingWriteResult> {
  const keys = Object.keys(assignments);
  if (keys.length === 0) {
    throw new WingValueError("Nothing to write: assignments is empty.");
  }
  const planned = keys.map((key) => {
    const path = joinNodePath(baseNode, key);
    const requested = assignments[key] as number | string;
    return { key, path, requested, sent: validateNodeValue(path, requested), audible: isAudiblePath(path) };
  });
  const audiblePaths = planned.filter((p) => p.audible).map((p) => p.path);
  if (!opts.dryRun) {
    assertShowModeAllows(ctx, audiblePaths, opts.confirm);
  }

  const results: WingWriteKeyResult[] = [];
  for (const p of planned) {
    results.push({ ...p, previous: await readLeaf(ctx, p.path) });
  }
  const audible = audiblePaths.length > 0;
  if (opts.dryRun) {
    return { status: "DRY RUN", ok: true, dryRun: true, audible, results };
  }

  const sent = Object.fromEntries(planned.map((p) => [p.key, p.sent]));
  const knownPrevious = Object.fromEntries(results.map((r) => [r.key, r.previous]));
  // Text keys are re-read below with everything else, so the client's own text check is redundant.
  const ack = await ctx.client.bulkSet(baseNode, sent, { verifyText: false, knownPrevious });
  const batchId = ctx.journal.currentBatch()?.batchId;
  if (!ack.ok) {
    return { status: ack.status, ok: false, dryRun: false, audible, batchId, results, raw: ack.raw };
  }
  if (opts.verify === false) {
    return { status: ack.status, ok: true, dryRun: false, audible, batchId, results, raw: ack.raw };
  }
  for (const r of results) {
    r.stored = await readLeaf(ctx, r.path);
    r.match = valuesMatch(r.sent, r.stored);
  }
  const allMatch = results.every((r) => r.match);
  return {
    status: allMatch ? "OK" : "MISMATCH",
    ok: allMatch,
    dryRun: false,
    audible,
    batchId,
    results,
    raw: ack.raw,
  };
}

/** One line per key, for a tool's text content. */
export function describeWriteResult(result: WingWriteResult): string {
  const lines = result.results.map((r) => {
    const fmt = (v: number | string | null | undefined) => (v === undefined ? "?" : JSON.stringify(v));
    if (result.dryRun) return `  ${r.path}: ${fmt(r.previous)} -> ${fmt(r.sent)}${r.audible ? " (audible)" : ""}`;
    const check = r.match === undefined ? "" : r.match ? " ✓" : ` ✗ stored ${fmt(r.stored)}`;
    return `  ${r.path}: ${fmt(r.previous)} -> ${fmt(r.sent)}${check}`;
  });
  const batch = result.batchId ? ` [batch ${result.batchId}]` : "";
  return `${result.status}${batch}\n${lines.join("\n")}`;
}
