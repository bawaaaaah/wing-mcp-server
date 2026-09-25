// Scenes and channel presets.
// Part of the dashboard's REST API — see ./index.ts for how the modules are mounted.

import express, { type Request, type Response, type Router } from "express";
import { WingValueError } from "../wing-errors.js";
import { getCurrentScene, getSceneList, recallScene, stepScene } from "../wing-scenes.js";
import type { WingPluginContext } from "../wing-plugin.js";
import {
  performPresetDelete,
  performPresetLoad,
  performPresetSave,
  summarizeSlot,
  PRESET_SECTION_KEYS,
  type PresetSectionKey,
} from "../wing-preset-engine.js";
import { STRIP_TYPES, type StripType } from "../wing-node-paths.js";

export function registerScenesPresetsRoutes(router: Router, ctx: WingPluginContext): void {
  /** Mirrors the `wing_scene_list`/`wing_scene_get_current`/`wing_scene_recall`/`wing_scene_next`/
   * `wing_scene_prev` MCP tools — see wing-scenes.ts for the scene-enumeration quirk this wraps. */
  router.get("/scenes", async (_req: Request, res: Response) => {
    const [scenes, current] = await Promise.all([getSceneList(ctx).catch(() => null), getCurrentScene(ctx).catch(() => null)]);
    if (scenes === null && current === null) {
      res.status(502).json({ error: "Failed to reach the console for scene/library state." });
      return;
    }
    res.json({
      scenes: scenes ?? [],
      current: current ?? { index: null, name: "", show: "", tagId: null },
    });
  });

  router.post("/scenes/step", express.json(), async (req: Request, res: Response) => {
    const { direction } = (req.body ?? {}) as { direction?: "next" | "prev" };
    if (direction !== "next" && direction !== "prev") {
      res.status(400).json({ error: "expected { direction: 'next' | 'prev' }" });
      return;
    }
    try {
      res.json(await stepScene(ctx, direction));
    } catch (err) {
      res.status(502).json({ error: String(err) });
    }
  });

  router.post("/scenes/recall", express.json(), async (req: Request, res: Response) => {
    const { target, byTag } = (req.body ?? {}) as { target?: number | string; byTag?: boolean };
    try {
      res.json(await recallScene(ctx, target as number | string, Boolean(byTag)));
    } catch (err) {
      if (err instanceof WingValueError) {
        res.status(422).json({ error: err.message });
        return;
      }
      res.status(502).json({ error: String(err) });
    }
  });

  // Presets: thin REST wrappers around the same performPresetSave/Load/Delete orchestration used by
  // the wing_preset_* MCP tools (tools/presets.ts), so the dashboard and an LLM client behave
  // identically — same split already used by wing-autogain.ts's runCombinedAutoGain.
  const sendPresetError = (res: Response, err: unknown): void => {
    res.status(err instanceof WingValueError ? 422 : 502).json({ error: err instanceof Error ? err.message : String(err) });
  };

  router.get("/presets", async (_req: Request, res: Response) => {
    try {
      res.json({ presets: await ctx.presetStore.list() });
    } catch (err) {
      sendPresetError(res, err);
    }
  });

  router.get("/presets/:name", async (req: Request, res: Response) => {
    try {
      const file = await ctx.presetStore.get(String(req.params.name));
      if (!file) {
        res.status(404).json({ error: `No preset named "${String(req.params.name)}" exists.` });
        return;
      }
      res.json({
        name: file.name,
        type: file.type,
        createdAt: file.createdAt,
        updatedAt: file.updatedAt,
        slots: file.slots.map(summarizeSlot),
      });
    } catch (err) {
      sendPresetError(res, err);
    }
  });

  router.post("/presets", express.json(), async (req: Request, res: Response) => {
    try {
      const { name, type, indices, overwrite } = req.body as {
        name?: string;
        type?: StripType;
        indices?: number[];
        overwrite?: boolean;
      };
      if (!name || !Array.isArray(indices) || indices.length === 0) {
        res.status(400).json({ error: "expected { name: string, indices: number[], type?, overwrite? }" });
        return;
      }
      if (type !== undefined && !STRIP_TYPES.includes(type)) {
        res.status(400).json({ error: `type must be one of ${STRIP_TYPES.join(", ")}` });
        return;
      }
      if (overwrite !== undefined && typeof overwrite !== "boolean") {
        res.status(400).json({ error: "overwrite must be a boolean" });
        return;
      }
      const result = await performPresetSave(ctx, { name, type: type ?? "channel", indices, overwrite });
      res.json(result);
    } catch (err) {
      sendPresetError(res, err);
    }
  });

  router.post("/presets/:name/load", express.json(), async (req: Request, res: Response) => {
    try {
      const { targetIndex, targetIndices, sections } = req.body as {
        targetIndex?: number;
        targetIndices?: number[];
        sections?: PresetSectionKey[];
      };
      if (sections !== undefined && (!Array.isArray(sections) || !sections.every((s) => (PRESET_SECTION_KEYS as readonly string[]).includes(s)))) {
        res.status(400).json({ error: `sections must be an array whose entries are each one of ${PRESET_SECTION_KEYS.join(", ")}` });
        return;
      }
      const result = await performPresetLoad(ctx, { name: String(req.params.name), targetIndex, targetIndices, sections });
      res.json(result);
    } catch (err) {
      sendPresetError(res, err);
    }
  });

  router.delete("/presets/:name", async (req: Request, res: Response) => {
    try {
      const result = await performPresetDelete(ctx, String(req.params.name));
      res.json(result);
    } catch (err) {
      sendPresetError(res, err);
    }
  });
}
