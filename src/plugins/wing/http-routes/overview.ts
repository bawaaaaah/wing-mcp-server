// Discovery, the cached state snapshot and the RTA.
// Part of the dashboard's REST API — see ./index.ts for how the modules are mounted.

import express, { type Request, type Response, type Router } from "express";
import { discoverWingConsoles } from "../wing-discovery.js";
import { WingValueError } from "../wing-errors.js";
import {
  getRtaSource,
  RTA_SOURCE_TYPES,
  setRtaSource,
  type RtaSourceType,
  type RtaTap,
} from "../wing-rta-source.js";
import type { WingPluginContext } from "../wing-plugin.js";

export function registerOverviewRoutes(router: Router, ctx: WingPluginContext): void {
  router.get("/discover", async (_req: Request, res: Response) => {
    try {
      const config = ctx.getConfig();
      const results = await discoverWingConsoles({ port: config.discoveryPort });
      res.json(results);
    } catch (err) {
      res.status(502).json({ error: String(err) });
    }
  });

  router.get("/state", (_req: Request, res: Response) => {
    try {
      res.json(ctx.cache.snapshotChannels());
    } catch (err) {
      res.status(502).json({ error: String(err) });
    }
  });

  /** One-shot snapshot mirroring the `wing_get_rta` MCP tool — the live view (Meters tab) instead
   * reads RTA frames off the "meters" SSE stream, since RTA is a push-only 20Hz feed with no
   * request/response primitive to poll on demand. */
  router.get("/rta", (_req: Request, res: Response) => {
    const snapshot = ctx.getLastRta();
    if (!snapshot) {
      res.json({ available: false });
      return;
    }
    res.json({ available: true, bandsDb: snapshot.bandsDb, receivedAt: snapshot.receivedAt, ageMs: Date.now() - snapshot.receivedAt });
  });

  /** Mirrors the `wing_get_rta_source`/`wing_set_rta_source` MCP tools — see wing-rta-source.ts for
   * the (inferred, not officially documented) rtasrc index mapping. */
  router.get("/rta/source", async (_req: Request, res: Response) => {
    try {
      res.json(await getRtaSource(ctx));
    } catch (err) {
      res.status(502).json({ error: String(err) });
    }
  });

  router.post("/rta/source", express.json(), async (req: Request, res: Response) => {
    const { type, index, tap } = (req.body ?? {}) as { type?: string; index?: number; tap?: string };
    if (!RTA_SOURCE_TYPES.includes(type as RtaSourceType) || typeof index !== "number") {
      res.status(400).json({ error: `expected { type: one of ${RTA_SOURCE_TYPES.join(", ")}, index: number, tap?: string }` });
      return;
    }
    try {
      res.json(await setRtaSource(ctx, { type: type as RtaSourceType, index }, tap as RtaTap | undefined));
    } catch (err) {
      if (err instanceof WingValueError) {
        res.status(422).json({ error: err.message });
        return;
      }
      res.status(502).json({ error: String(err) });
    }
  });
}
