import { WingValueError } from "./wing-errors.js";
import { resolveStripPath, type StripType } from "./wing-node-paths.js";
import type { WingPluginContext } from "./wing-plugin.js";

/**
 * EQ/Gate/Dyn processing-block on/off. The generic wing_get/wing_set tools already cover the raw
 * {prefix}/{block}/on path, but a dedicated tool is worth having: it names the three real blocks
 * explicitly for an LLM caller, and rejects "gate" on a strip type that doesn't have one with a
 * clear message instead of writing to (or timing out on) a path that doesn't exist. Aux has EQ and
 * Dyn like a channel, but no Gate slot at all — verified against real hardware (same restriction
 * already enforced by wing-auto-gate.ts/wing-dynamics-models.ts's identical check).
 */
export type ProcessingToggleType = Extract<StripType, "channel" | "aux" | "bus" | "main" | "matrix">;
export const PROCESSING_TOGGLE_TYPES: readonly ProcessingToggleType[] = ["channel", "aux", "bus", "main", "matrix"];

export type ProcessingBlock = "eq" | "gate" | "dyn";
export const PROCESSING_BLOCKS: readonly ProcessingBlock[] = ["eq", "gate", "dyn"];

export interface ProcessingBlockOptions {
  type: ProcessingToggleType;
  index: number;
  block: ProcessingBlock;
}

export interface ProcessingBlockStatus extends ProcessingBlockOptions {
  on: boolean;
}

export interface SetProcessingBlockOptions extends ProcessingBlockOptions {
  on: boolean;
}

export interface ProcessingBlockAck extends ProcessingBlockOptions {
  on: boolean;
  ack: { status: string; ok: boolean; raw: string };
}

function requireBlockAvailable(type: ProcessingToggleType, block: ProcessingBlock): void {
  if (block === "gate" && type !== "channel") {
    throw new WingValueError(
      `The "gate" block only exists on channel strips — ${type} strips have no gate stage (only "eq"/"dyn" ` +
        `are available). Use type: "channel", or block: "eq"/"dyn".`,
    );
  }
}

function blockPath(type: ProcessingToggleType, index: number, block: ProcessingBlock): string {
  requireBlockAvailable(type, block);
  return `${resolveStripPath(type, index)}/${block}`;
}

function asNumber(value: string | number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export async function getProcessingBlockOn(
  ctx: WingPluginContext,
  opts: ProcessingBlockOptions,
): Promise<ProcessingBlockStatus> {
  const path = `${blockPath(opts.type, opts.index, opts.block)}/on`;
  const result = await ctx.client.get(path);
  const on = result.kind === "leaf" ? asNumber(result.value, 0) === 1 : false;
  return { ...opts, on };
}

export async function setProcessingBlockOn(
  ctx: WingPluginContext,
  opts: SetProcessingBlockOptions,
): Promise<ProcessingBlockAck> {
  const { type, index, block, on } = opts;
  const base = blockPath(type, index, block);
  const ack = await ctx.client.bulkSet(base, { on: on ? 1 : 0 });
  return { type, index, block, on, ack };
}
