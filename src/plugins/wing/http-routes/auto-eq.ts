// Auto-EQ balance and saved measurement-mic calibrations.
// Part of the dashboard's REST API — see ./index.ts for how the modules are mounted.

import express, { type Request, type Response, type Router } from "express";
import { runAutoEqBalance, undoAutoEqBalance } from "../wing-auto-eq.js";
import { slugifyStoreName } from "../wing-json-dir-store.js";
import { parseCalibrationFile, resolveMicCurveInput, type MicCurveInput } from "../wing-mic-calibration.js";
import { summarizeMicCalibration } from "../wing-mic-calibration-store.js";
import { WingValueError } from "../wing-errors.js";
import { autoEqBalanceShape } from "../wing-input-schemas.js";
import type { WingPluginContext } from "../wing-plugin.js";
import { parseBodyOr400 } from "./shared.js";

export function registerAutoEqRoutes(router: Router, ctx: WingPluginContext): void {
  // Auto EQ balance — shared with the wing_auto_eq_balance/wing_auto_eq_undo MCP tools, body parsed with
  // the tool's own schema (400 if it doesn't fit); same 422 (signal/value) vs 502 (console/transport)
  // split as auto-compress.
  async function respondAutoEq(res: Response, action: () => Promise<unknown>): Promise<void> {
    try {
      res.json(await action());
    } catch (err) {
      res.status(err instanceof WingValueError ? 422 : 502).json({ error: err instanceof Error ? err.message : String(err) });
    }
  }

  router.post("/auto-eq-balance", express.json(), async (req: Request, res: Response) => {
    const opts = parseBodyOr400(autoEqBalanceShape, req, res);
    if (opts === null) return;
    await respondAutoEq(res, () => runAutoEqBalance(ctx, opts));
  });

  router.post("/auto-eq-balance/undo", async (_req: Request, res: Response) => {
    await respondAutoEq(res, () => undoAutoEqBalance(ctx));
  });

  // Measurement mics and their calibration curves — shared with the wing_mic_calibration_* MCP tools
  // (tools/mic-calibration.ts). `parse` only previews what a file contains; nothing is saved until POST.
  router.post("/mic-calibrations/parse", express.json({ limit: "5mb" }), async (req: Request, res: Response) => {
    const { fileName, contentBase64 } = (req.body ?? {}) as { fileName?: unknown; contentBase64?: unknown };
    if (typeof fileName !== "string" || typeof contentBase64 !== "string" || contentBase64 === "") {
      res.status(400).json({ error: "expected { fileName: string, contentBase64: string }" });
      return;
    }
    await respondAutoEq(res, async () => ({ candidates: parseCalibrationFile(fileName, Buffer.from(contentBase64, "base64")) }));
  });

  router.get("/mic-calibrations", async (_req: Request, res: Response) => {
    await respondAutoEq(res, async () => ({ mics: await ctx.micCalibrationStore.list() }));
  });

  router.get("/mic-calibrations/:name", async (req: Request, res: Response) => {
    try {
      const file = await ctx.micCalibrationStore.get(String(req.params.name));
      if (!file) {
        res.status(404).json({ error: `No saved mic named "${String(req.params.name)}".` });
        return;
      }
      res.json(file);
    } catch (err) {
      res.status(err instanceof WingValueError ? 422 : 502).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * Body: { name, serial?, notes?, curves: { deg0, deg90 } (each null, {points, sourceFiles?} or
   * {fileName, content, encoding?, candidate?}), overwrite?, renameFrom? }. `renameFrom` is the mic being
   * edited: saving under the same name replaces it, saving under a new name removes the old one.
   */
  router.post("/mic-calibrations", express.json({ limit: "5mb" }), async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const curves = body.curves as { deg0?: unknown; deg90?: unknown } | undefined;
    if (typeof body.name !== "string" || !curves || typeof curves !== "object") {
      res.status(400).json({ error: "expected { name: string, curves: { deg0, deg90 }, serial?, notes?, overwrite?, renameFrom? }" });
      return;
    }
    const name = body.name;
    const renameFrom = typeof body.renameFrom === "string" ? body.renameFrom : undefined;
    await respondAutoEq(res, async () => {
      const curve = (v: unknown, label: string) => (v ? resolveMicCurveInput(v as MicCurveInput, label) : null);
      const sameMic = renameFrom !== undefined && slugifyStoreName(renameFrom, "Mic") === slugifyStoreName(name, "Mic");
      const file = await ctx.micCalibrationStore.save(
        {
          name,
          serial: typeof body.serial === "string" ? body.serial : undefined,
          notes: typeof body.notes === "string" ? body.notes : undefined,
          curves: { deg0: curve(curves.deg0, "0° curve"), deg90: curve(curves.deg90, "90° curve") },
        },
        { overwrite: body.overwrite === true || sameMic },
      );
      if (renameFrom !== undefined && !sameMic) await ctx.micCalibrationStore.delete(renameFrom);
      return summarizeMicCalibration(file);
    });
  });

  router.delete("/mic-calibrations/:name", async (req: Request, res: Response) => {
    await respondAutoEq(res, async () => {
      const deleted = await ctx.micCalibrationStore.delete(String(req.params.name));
      if (!deleted) throw new WingValueError(`No saved mic named "${String(req.params.name)}".`);
      return { name: req.params.name, deleted };
    });
  });
}
