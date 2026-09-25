import { WingValueError } from "./wing-errors.js";
import { parseWingDescribeParams } from "./wing-value-codec.js";
import type { WingPluginContext } from "./wing-plugin.js";

/**
 * Verified against real hardware: describing the *leaf* "/$ctl/lib/$scenes" directly never replies
 * (neither "?" nor "#") — describing the *parent branch* "/$ctl/lib" instead works, and its reply's
 * inline enum for the $scenes field IS the full scene list in order (e.g. "$scenes list [entree-
 * epoux, AMI REPET, AMI INSTALL, AMI]"), with array position matching $actidx.
 */
export const SCENES_LIB_BASE = "/$ctl/lib";

export interface SceneListEntry {
  index: number;
  name: string;
}

export async function getSceneList(ctx: WingPluginContext): Promise<SceneListEntry[]> {
  const description = await ctx.client.describe(SCENES_LIB_BASE);
  const scenesParam = parseWingDescribeParams(description.lines).find((p) => p.key === "$scenes");
  return (scenesParam?.options ?? []).map((name, index) => ({ index, name }));
}

export interface CurrentScene {
  index: number;
  name: string;
  show: string;
  tagId: number;
}

export async function getCurrentScene(ctx: WingPluginContext): Promise<CurrentScene> {
  const [actIdx, active, actShow, activeId] = await Promise.all([
    ctx.client.get(`${SCENES_LIB_BASE}/$actidx`),
    ctx.client.get(`${SCENES_LIB_BASE}/$active`),
    ctx.client.get(`${SCENES_LIB_BASE}/$actshow`),
    ctx.client.get(`${SCENES_LIB_BASE}/$activeid`),
  ]);
  return {
    index: actIdx.kind === "leaf" ? Number(actIdx.value) : NaN,
    name: active.kind === "leaf" ? String(active.value) : "",
    show: actShow.kind === "leaf" ? String(actShow.value) : "",
    tagId: activeId.kind === "leaf" ? Number(activeId.value) : NaN,
  };
}

export interface SceneAck {
  status: string;
  ok: boolean;
  raw: string;
}

/**
 * Recalls a scene by list index or by numeric tag. Throws `WingValueError` for a missing/empty
 * `target` — an unvalidated REST body used to silently send the literal OSC string
 * "$actionidx=undefined,$action=GO" to the console.
 */
export async function recallScene(ctx: WingPluginContext, target: number | string, byTag: boolean): Promise<SceneAck> {
  if (target === undefined || target === null || (typeof target === "string" && target.trim() === "")) {
    throw new WingValueError("target is required to recall a scene (a scene index, or a tag number when byTag is true)");
  }
  return afterSceneLoad(ctx, await ctx.client.bulkSet(SCENES_LIB_BASE, { $actionidx: target, $action: byTag ? "GOTAG" : "GO" }), `${byTag ? "tag" : "index"} ${target}`);
}

export async function stepScene(ctx: WingPluginContext, direction: "next" | "prev"): Promise<SceneAck> {
  return afterSceneLoad(ctx, await ctx.client.bulkSet(SCENES_LIB_BASE, { $action: direction === "next" ? "NEXT" : "PREV" }), direction);
}

/**
 * A scene load rewrites most of the console at once. The plugin also reacts to the console's own
 * scene-change pushes (which cover a load from the surface), but a load this server asked for is
 * handled here directly rather than trusting a push to arrive: the cache is dropped, and the
 * unsaved-changes count restarts from this scene.
 */
function afterSceneLoad(ctx: WingPluginContext, ack: SceneAck, detail: string): SceneAck {
  if (ack.ok) {
    ctx.cache.clear();
    ctx.journal.noteSceneEvent("load", detail);
  }
  return ack;
}
