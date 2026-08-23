import { auxPath, channelPath, ioInPath } from "../wing-node-paths.js";
import type { WingPluginContext } from "../wing-plugin.js";

/**
 * Resolves the physical input a channel/aux strip is currently routed from (`in/conn/grp` +
 * `in/conn/in`), or null if unrouted (source "OFF") or unreadable right now.
 *
 * Deliberately reads `in/conn/in`'s `display` field, not `value`: verified live against real
 * hardware that this parameter's OSC wire "int" arg is 0-indexed while its display string (and the
 * `/io/in/{group}/{n}` addressing convention used everywhere else) is 1-indexed — e.g. an aux wired
 * to physical input "6" read back as `display: "6", value: 5`. Using `value` directly resolves to
 * the wrong physical input, one slot below the real one — confirmed by cross-checking against the
 * independently-verified `/io/in/:group/:index/routed-channels` reverse lookup (see
 * http-routes.ts), which reported the aux as routed from index 6, not 5.
 */
export async function resolvePhysicalSource(
  ctx: WingPluginContext,
  stripPath: string,
): Promise<{ group: string; index: number } | null> {
  try {
    const [grp, inIdx] = await Promise.all([
      ctx.client.get(`${stripPath}/in/conn/grp`),
      ctx.client.get(`${stripPath}/in/conn/in`),
    ]);
    if (grp.kind !== "leaf" || inIdx.kind !== "leaf" || String(grp.value) === "OFF") {
      return null;
    }
    const index = Number(inIdx.display ?? Number(inIdx.value) + 1);
    if (!Number.isFinite(index)) {
      return null;
    }
    return { group: String(grp.value), index };
  } catch {
    // Can't determine routing right now — treated the same as "not routed", not a hard failure.
    return null;
  }
}

/** The only two strip types wired to a physical input (and therefore capable of "auto-name-from-source" linking). */
export type PhysicallyRoutableStripType = "channel" | "aux";

const PHYSICALLY_ROUTABLE_PATH_BUILDERS: Record<PhysicallyRoutableStripType, (n: number, suffix?: string) => string> = {
  channel: channelPath,
  aux: auxPath,
};

/**
 * Where a rename of this channel/aux should actually be written. Verified against real hardware
 * (for channels; assumed identical for aux, which wing-autogain.ts already treats as sharing the
 * exact same in/conn/in/set node shape as a channel): with `in/set/srcauto=1` the console mirrors
 * the connected physical input's own name as the strip's effective `$name`, ignoring the strip's own
 * `name` leaf entirely — so writing `name` on a linked strip is silently invisible. In that state the
 * only way to change what's actually shown is to rename the source itself, which is also what every
 * other channel/aux linked to the same input will then display — an inherent consequence of the
 * console's own design, not something to special-case. Falls back to renaming the strip directly if
 * the link state can't be determined (timeout) or it isn't linked (same as today).
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
  const srcauto = await ctx.client.get(pathFor(index, "in/set/srcauto")).catch(() => null);
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
