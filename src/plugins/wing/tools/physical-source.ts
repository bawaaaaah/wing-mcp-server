import { auxPath, channelPath, ioInPath } from "../wing-node-paths.js";
import type { WingPluginContext } from "../wing-plugin.js";

/**
 * Resolves the physical input a channel/aux strip is currently routed from (`in/conn/grp` +
 * `in/conn/in`), or null if unrouted (source "OFF") or unreadable right now.
 *
 * `in/conn/in` is 1-based as displayed. Verified live against real hardware that the reply's wire
 * "int" argument reads one low (an aux wired to input 6 replied `display: "6", int: 5`) — it is the
 * offset from the range's minimum — which decodeIntReply in wing-value-codec.ts now resolves for
 * every integer read, so `value` here is the input number itself.
 */
async function resolveConn(
  ctx: WingPluginContext,
  grpPath: string,
  inPath: string,
): Promise<{ group: string; index: number } | null> {
  try {
    const [grp, inIdx] = await Promise.all([ctx.client.get(grpPath), ctx.client.get(inPath)]);
    if (grp.kind !== "leaf" || inIdx.kind !== "leaf" || String(grp.value) === "OFF") {
      return null;
    }
    const index = Number(inIdx.value);
    if (!Number.isFinite(index)) {
      return null;
    }
    return { group: String(grp.value), index };
  } catch {
    // Can't determine routing right now — treated the same as "not routed", not a hard failure.
    return null;
  }
}

export async function resolvePhysicalSource(
  ctx: WingPluginContext,
  stripPath: string,
): Promise<{ group: string; index: number } | null> {
  return resolveConn(ctx, `${stripPath}/in/conn/grp`, `${stripPath}/in/conn/in`);
}

/**
 * Same as resolvePhysicalSource but for the Alt source slot (in/conn/altgrp + altin) rather than
 * Main — used by the input-patch feature (wing-input-patch.ts) to show/restore both slots. Same
 * field pair shape under different leaf names, decoded the same way (every integer read goes
 * through decodeIntReply).
 */
export async function resolveAltSource(
  ctx: WingPluginContext,
  stripPath: string,
): Promise<{ group: string; index: number } | null> {
  return resolveConn(ctx, `${stripPath}/in/conn/altgrp`, `${stripPath}/in/conn/altin`);
}

/** The only two strip types wired to a physical input (and therefore capable of "auto-name-from-source" linking). */
export type PhysicallyRoutableStripType = "channel" | "aux";

const PHYSICALLY_ROUTABLE_PATH_BUILDERS: Record<PhysicallyRoutableStripType, (n: number, suffix?: string) => string> = {
  channel: channelPath,
  aux: auxPath,
};

/**
 * Where a rename of this channel/aux should actually be written. With `clink=1` the console mirrors
 * the connected physical input's own name as the strip's effective `$name`, ignoring the strip's own
 * `name` leaf entirely — so writing `name` on a linked strip is silently invisible (for channels;
 * assumed identical for aux, which wing-autogain.ts already treats as sharing the exact same
 * in/conn/in/set node shape as a channel, though aux isn't independently documented — there is no
 * aux.md in docs/wing-protocol at all). In that state the only way to change what's actually shown
 * is to rename the source itself, which is also what every other channel/aux linked to the same
 * input will then display — an inherent consequence of the console's own design, not something to
 * special-case. Falls back to renaming the strip directly if the link state can't be determined
 * (timeout) or it isn't linked (same as today).
 *
 * `clink` corrected 2026-08-28 from a live packet capture of the console app's "link customization
 * to source" toggle (`{path: "/ch/{n}/clink", value: "1"}`) — an earlier pass had wrongly assumed
 * this was `in/set/srcauto` (a real, distinct, undocumented OSC node unrelated to this feature).
 *
 * Shared by `wing_channel_set_name` (channel.ts) and the channel-preset engine (wing-preset-engine.ts)
 * for both channel and aux, rather than duplicating this logic per strip type.
 */
export async function resolveInputNameTarget(
  ctx: WingPluginContext,
  type: PhysicallyRoutableStripType,
  index: number,
): Promise<{ baseNode: string; cachePaths: string[]; viaSource: boolean }> {
  const pathFor = PHYSICALLY_ROUTABLE_PATH_BUILDERS[type];
  const direct = { baseNode: pathFor(index), cachePaths: [pathFor(index, "name")], viaSource: false };
  const srcauto = await ctx.client.get(pathFor(index, "clink")).catch(() => null);
  if (!srcauto || srcauto.kind !== "leaf" || Number(srcauto.value) !== 1) {
    return direct;
  }
  const source = await resolvePhysicalSource(ctx, pathFor(index));
  if (!source) {
    return direct;
  }
  return {
    baseNode: ioInPath(source.group, source.index),
    cachePaths: [ioInPath(source.group, source.index, "name"), pathFor(index, "name")],
    viaSource: true,
  };
}
