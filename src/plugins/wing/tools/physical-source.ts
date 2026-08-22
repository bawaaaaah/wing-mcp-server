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
