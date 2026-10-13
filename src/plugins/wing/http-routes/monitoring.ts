// Solo, solo configuration and the monitor buses.
// Part of the dashboard's REST API — see ./index.ts for how the modules are mounted.

import express, { type Request, type Response, type Router } from "express";
import { WingValueError } from "../wing-errors.js";
import {
  getMonitorBus,
  getSoloConfig,
  getStripSolo,
  setMonitorBus,
  setSoloConfig,
  setStripSolo,
  type MonitorBusIndex,
  type SetMonitorBusOptions,
  type SetSoloConfigOptions,
  type SetStripSoloOptions,
  type SoloStripType,
} from "../wing-solo-monitor.js";
import type { WingPluginContext } from "../wing-plugin.js";
import { AUX_COUNT, BUS_COUNT, CHANNEL_COUNT, DCA_COUNT, MAIN_COUNT, MATRIX_COUNT, resolveStripPath } from "../wing-node-paths.js";
import { boundedReads } from "../wing-read-budget.js";
import { channelIndexOrNull, auxIndexOrNull } from "./shared.js";

export function registerMonitoringRoutes(router: Router, ctx: WingPluginContext): void {
  /**
   * Control-room solo & monitoring — business logic lives in wing-solo-monitor.ts, shared with the
   * `wing_*strip_solo`/`wing_*solo_config`/`wing_*monitor_bus` MCP tools (see tools/solo-monitor.ts).
   * The per-strip solo route follows the same generic-resolver pattern as scribbleRoute() above,
   * but allows all six non-mutegroup strip types (unlike scribble, `$solo` needs no per-type carve-out).
   */
  function soloRoute(routePath: string, resolve: (req: Request) => { type: SoloStripType; index: number } | null): void {
    router.get(`${routePath}/solo`, async (req: Request, res: Response) => {
      const resolved = resolve(req);
      if (resolved === null) {
        res.status(400).json({ error: `invalid path parameters for ${routePath}/solo` });
        return;
      }
      try {
        res.json(await getStripSolo(ctx, resolved.type, resolved.index));
      } catch (err) {
        if (err instanceof WingValueError) {
          res.status(422).json({ error: err.message });
          return;
        }
        res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    router.post(`${routePath}/solo`, express.json(), async (req: Request, res: Response) => {
      const resolved = resolve(req);
      if (resolved === null) {
        res.status(400).json({ error: `invalid path parameters for ${routePath}/solo` });
        return;
      }
      const { solo, soloSafe } = req.body as Partial<Pick<SetStripSoloOptions, "solo" | "soloSafe">>;
      try {
        res.json(await setStripSolo(ctx, { ...resolved, solo, soloSafe }));
      } catch (err) {
        if (err instanceof WingValueError) {
          res.status(422).json({ error: err.message });
          return;
        }
        res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
      }
    });
  }

  soloRoute("/channels/:index", (req) => {
    const n = channelIndexOrNull(req);
    return n === null ? null : { type: "channel", index: n };
  });

  soloRoute("/aux/:index", (req) => {
    const n = auxIndexOrNull(req);
    return n === null ? null : { type: "aux", index: n };
  });

  soloRoute("/strips/:type/:index", (req) => {
    const type = req.params.type;
    if (type !== "bus" && type !== "main" && type !== "mtx" && type !== "dca") return null;
    const n = Number(req.params.index);
    if (!Number.isInteger(n)) return null;
    return { type: type === "mtx" ? "matrix" : type, index: n };
  });

  /**
   * Which strips are soloed right now, for the dashboard's Solo buttons: `$solo` of every channel,
   * aux, bus, main, matrix and DCA (92 reads, bounded like /mixer-state's), answered as the soloed
   * indices per type. Live changes then arrive on the param-change topic as ".../solo".
   */
  router.get("/solo-states", async (_req: Request, res: Response) => {
    const reads = boundedReads(8000);
    const types: [SoloStripType, number][] = [
      ["channel", CHANNEL_COUNT],
      ["aux", AUX_COUNT],
      ["bus", BUS_COUNT],
      ["main", MAIN_COUNT],
      ["matrix", MATRIX_COUNT],
      ["dca", DCA_COUNT],
    ];
    const loadAll = Promise.all(
      types.flatMap(([type, count]) =>
        Array.from({ length: count }, (_, i) => i + 1).map(async (index) => {
          try {
            const solo = await reads.run(() => ctx.client.get(resolveStripPath(type, index, "$solo")));
            return solo.kind === "leaf" && Number(solo.value) === 1 ? { type, index } : null;
          } catch {
            return null;
          }
        }),
      ),
    );
    const result = await reads.within(loadAll);
    if (result === "timeout") {
      res.status(504).json({ error: "Timed out reading solo states from the console." });
      return;
    }
    const soloed: Record<SoloStripType, number[]> = { channel: [], aux: [], bus: [], main: [], matrix: [], dca: [] };
    for (const entry of result) if (entry) soloed[entry.type].push(entry.index);
    res.json(soloed);
  });

  router.get("/solo-config", async (_req: Request, res: Response) => {
    try {
      res.json(await getSoloConfig(ctx));
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/solo-config", express.json(), async (req: Request, res: Response) => {
    const opts = (req.body ?? {}) as SetSoloConfigOptions;
    try {
      res.json(await setSoloConfig(ctx, opts));
    } catch (err) {
      if (err instanceof WingValueError) {
        res.status(422).json({ error: err.message });
        return;
      }
      res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get("/monitor-bus/:bus", async (req: Request, res: Response) => {
    const bus = Number(req.params.bus);
    if (bus !== 1 && bus !== 2) {
      res.status(400).json({ error: "bus must be 1 or 2" });
      return;
    }
    try {
      res.json(await getMonitorBus(ctx, bus as MonitorBusIndex));
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/monitor-bus/:bus", express.json(), async (req: Request, res: Response) => {
    const bus = Number(req.params.bus);
    if (bus !== 1 && bus !== 2) {
      res.status(400).json({ error: "bus must be 1 or 2" });
      return;
    }
    const opts = (req.body ?? {}) as Omit<SetMonitorBusOptions, "bus">;
    try {
      res.json(await setMonitorBus(ctx, { ...opts, bus: bus as MonitorBusIndex }));
    } catch (err) {
      if (err instanceof WingValueError) {
        res.status(422).json({ error: err.message });
        return;
      }
      res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
