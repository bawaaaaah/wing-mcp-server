import { WingValueError } from "./wing-errors.js";
import { channelPath } from "./wing-node-paths.js";
import type { WingPluginContext } from "./wing-plugin.js";

/**
 * Channel processing order (Gate/EQ/Dynamics/Insert reordering) — channel-exclusive, verified
 * against real hardware: aux/bus/main/matrix branch listings have no "proc" field at all
 * (consistent with them lacking a Gate stage in the first place). The console reports one of the
 * 24 permutations of the four fixed letters G/E/D/I — that fixed set is pure combinatorics, not
 * something that varies by firmware, so it's generated here once rather than sourced from the
 * console (describe() on this address never replies, the same "list []"-typed dead end as
 * $scenes/$songs — a plain GET/SET works fine).
 *
 * The letter order IS the signal-flow order on the console, left to right = first to last:
 *   G = Gate
 *   E = Equalisation (EQ)
 *   D = Dynamics (compressor)
 *   I = Insert
 * E.g. the default "GEDI" processes Gate, then EQ, then Dynamics, then Insert; "EDGI" processes
 * EQ, then Dynamics, then Gate, then Insert.
 */
export const GEDI_PERMUTATIONS = [
  "GEDI",
  "GEID",
  "GIED",
  "IGED",
  "GDEI",
  "GDIE",
  "GIDE",
  "IGDE",
  "EGDI",
  "EGID",
  "EIGD",
  "IEGD",
  "EDGI",
  "EDIG",
  "EIDG",
  "IEDG",
  "DEGI",
  "DEIG",
  "DIEG",
  "IDEG",
  "DGEI",
  "DGIE",
  "DIGE",
  "IDGE",
] as const;

export type ProcOrder = (typeof GEDI_PERMUTATIONS)[number];

const PROC_ORDER_SET: ReadonlySet<string> = new Set(GEDI_PERMUTATIONS);

export function isProcOrder(value: string): value is ProcOrder {
  return PROC_ORDER_SET.has(value);
}

function requireProcOrder(value: string): asserts value is ProcOrder {
  if (!isProcOrder(value)) {
    throw new WingValueError(
      `Invalid processing order "${value}" — must be one of the 24 permutations of G/E/D/I ` +
        `(e.g. "GEDI", "EDGI"), one letter each for Gate/Equalisation/Dynamics/Insert, in signal-flow order.`,
    );
  }
}

export interface ProcOrderStatus {
  channel: number;
  order: ProcOrder;
}

export interface ProcOrderAck extends ProcOrderStatus {
  ack: { status: string; ok: boolean; raw: string };
}

export async function getProcOrder(ctx: WingPluginContext, channel: number): Promise<ProcOrderStatus> {
  const result = await ctx.client.get(channelPath(channel, "proc"));
  const raw = result.kind === "leaf" ? String(result.value) : "";
  requireProcOrder(raw);
  return { channel, order: raw };
}

export async function setProcOrder(ctx: WingPluginContext, channel: number, order: string): Promise<ProcOrderAck> {
  requireProcOrder(order);
  const ack = await ctx.client.bulkSet(channelPath(channel), { proc: order });
  return { channel, order, ack };
}
