import { WingValueError } from "./wing-errors.js";
import { FX_COUNT, resolveStripPath, type StripType } from "./wing-node-paths.js";
import type { WingPluginContext } from "./wing-plugin.js";

/**
 * Pre-insert exists on every strip type that has processing at all (channel/aux/bus/main/matrix).
 * Post-insert is verified against the protocol reference to NOT exist on aux (aux has no
 * post-processing insert stage) — every other type has both.
 */
export type InsertStripType = Extract<StripType, "channel" | "aux" | "bus" | "main" | "matrix">;
export const INSERT_STRIP_TYPES: readonly InsertStripType[] = ["channel", "aux", "bus", "main", "matrix"];

export type InsertSlot = "pre" | "post";
export const INSERT_SLOTS: readonly InsertSlot[] = ["pre", "post"];

/** "NONE" (bypassed) or one of the console's 16 FX engine slots. */
export const INSERT_FX_OPTIONS = ["NONE", ...Array.from({ length: FX_COUNT }, (_, i) => `FX${i + 1}`)] as const;
export type InsertFx = (typeof INSERT_FX_OPTIONS)[number];

/** Post-insert routing mode — pre-insert has no equivalent field. */
export const POST_INSERT_MODES = ["FX", "AUTO_X", "AUTO_Y"] as const;
export type PostInsertMode = (typeof POST_INSERT_MODES)[number];

export interface InsertOptions {
  type: InsertStripType;
  index: number;
  slot: InsertSlot;
}

export interface InsertStatus extends InsertOptions {
  on: boolean;
  fx: InsertFx  ;
  /** Only present for slot "post" — pre-insert has no mode field. */
  mode?: string;
  /** Wet/dry mix in dB, -12..12 — only present for slot "post". */
  w?: number;
  /** Read-only link/routing status reported by the console, if it replied. */
  status: string | null;
}

export interface SetInsertOptions extends InsertOptions {
  on?: boolean;
  fx?: InsertFx;
  mode?: PostInsertMode;
  w?: number;
}

export interface InsertAck extends InsertOptions {
  ack: { status: string; ok: boolean; raw: string };
}

function requirePostInsertAvailable(type: InsertStripType, slot: InsertSlot): void {
  if (slot === "post" && type === "aux") {
    throw new WingValueError('Aux strips have no post-insert stage — only "pre" insert exists on aux. Use slot: "pre".');
  }
}

function insertBasePath(type: InsertStripType, index: number, slot: InsertSlot): string {
  requirePostInsertAvailable(type, slot);
  return `${resolveStripPath(type, index)}/${slot === "pre" ? "preins" : "postins"}`;
}

function asNumber(value: string | number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export async function getInsertStatus(ctx: WingPluginContext, opts: InsertOptions): Promise<InsertStatus> {
  const basePath = insertBasePath(opts.type, opts.index, opts.slot);
  const [values, statResult] = await Promise.all([
    ctx.client.dump(basePath),
    ctx.client.get(`${basePath}/$stat`).catch(() => null),
  ]);
  const status: InsertStatus = {
    ...opts,
    on: asNumber(values.on, 0) === 1,
    fx: typeof values.ins === "string" ? values.ins : "NONE",
    status: statResult && statResult.kind === "leaf" ? String(statResult.value) : null,
  };
  if (opts.slot === "post") {
    status.mode = typeof values.mode === "string" ? values.mode : undefined;
    status.w = asNumber(values.w, 0);
  }
  return status;
}

export async function setInsert(ctx: WingPluginContext, opts: SetInsertOptions): Promise<InsertAck> {
  const { type, index, slot, on, fx, mode, w } = opts;
  const basePath = insertBasePath(type, index, slot);

  if (slot === "pre" && (mode !== undefined || w !== undefined)) {
    throw new WingValueError('Pre-insert has no "mode"/"w" fields — those only apply to slot: "post".');
  }

  const assignments: Record<string, number | string> = {};
  if (on !== undefined) assignments.on = on ? 1 : 0;
  if (fx !== undefined) assignments.ins = fx;
  if (mode !== undefined) assignments.mode = mode;
  if (w !== undefined) assignments.w = w;

  if (Object.keys(assignments).length === 0) {
    throw new WingValueError("Nothing to set — pass at least one of on/fx/mode/w.");
  }

  const ack = await ctx.client.bulkSet(basePath, assignments);
  return { type, index, slot, ack };
}
