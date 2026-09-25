// Processing order, inserts, processing-block bypass and delay.
// Part of the dashboard's REST API — see ./index.ts for how the modules are mounted.

import express, { type Request, type Response, type Router } from "express";
import { WingValueError } from "../wing-errors.js";
import {
  getInsertStatus,
  setInsert,
  type InsertSlot,
  type InsertStripType,
  type SetInsertOptions,
} from "../wing-insert.js";
import {
  getProcessingBlockOn,
  setProcessingBlockOn,
  type ProcessingBlock,
  type ProcessingToggleType,
} from "../wing-processing-toggle.js";
import { getProcOrder, setProcOrder } from "../wing-proc-order.js";
import { getDelay, setDelay, type DelayStripType, type SetDelayOptions } from "../wing-delay.js";
import type { WingPluginContext } from "../wing-plugin.js";
import { channelIndexOrNull, auxIndexOrNull } from "./shared.js";

export function registerProcessingRoutes(router: Router, ctx: WingPluginContext): void {
  /**
   * Processing order (Gate/EQ/Dynamics/Insert reordering) — channel-exclusive, verified against
   * real hardware: aux/bus/main/matrix branch listings have no "proc" field at all (consistent with
   * them lacking a Gate stage in the first place). describe() on this address never replies (same
   * "list []"-typed dead end as $scenes/$songs), but a plain GET works and returns one of the 24
   * permutations of "G"/"E"/"D"/"I" (e.g. "EDGI") — that fixed set is generated in code below rather
   * than sourced from the console, since it's pure combinatorics (4! orderings of 4 fixed letters),
   * not something that varies by firmware.
   */
  router.get("/channels/:index/proc", async (req: Request, res: Response) => {
    const channel = channelIndexOrNull(req);
    if (channel === null) {
      res.status(400).json({ error: `channel index out of range: ${String(req.params.index)}` });
      return;
    }
    try {
      const status = await getProcOrder(ctx, channel);
      res.json({ value: status.order });
    } catch (err) {
      if (err instanceof WingValueError) {
        res.status(422).json({ error: err.message });
        return;
      }
      res.status(502).json({ error: String(err) });
    }
  });

  router.post("/channels/:index/proc", express.json(), async (req: Request, res: Response) => {
    const channel = channelIndexOrNull(req);
    if (channel === null) {
      res.status(400).json({ error: `channel index out of range: ${String(req.params.index)}` });
      return;
    }
    const { order } = req.body as { order?: unknown };
    if (typeof order !== "string") {
      res.status(400).json({ error: "body must include string `order`" });
      return;
    }
    try {
      res.json(await setProcOrder(ctx, channel, order));
    } catch (err) {
      if (err instanceof WingValueError) {
        res.status(422).json({ error: err.message });
        return;
      }
      res.status(502).json({ error: String(err) });
    }
  });

  /**
   * Pre/post insert — business logic lives in wing-insert.ts, shared with the `wing_get_insert`/
   * `wing_set_insert` MCP tools (see tools/insert.ts). `slot` ("pre"/"post") comes from the route's
   * own param rather than the request body, matching the auto-gate/auto-compress routes' convention
   * of encoding the fixed part of the request in the URL. Aux has no post-insert stage — `getInsertStatus`/
   * `setInsert` reject it with a `WingValueError`, mapped to 422 like every other validation failure here.
   */
  function insertSlotOrNull(req: Request): InsertSlot | null {
    const slot = req.params.slot;
    return slot === "pre" || slot === "post" ? slot : null;
  }

  function insertRoute(
    routePath: string,
    resolve: (req: Request) => { type: InsertStripType; index: number } | null,
  ): void {
    router.get(`${routePath}/insert/:slot`, async (req: Request, res: Response) => {
      const resolved = resolve(req);
      const slot = insertSlotOrNull(req);
      if (resolved === null || slot === null) {
        res.status(400).json({ error: `invalid path parameters for ${routePath}/insert/:slot` });
        return;
      }
      try {
        res.json(await getInsertStatus(ctx, { ...resolved, slot }));
      } catch (err) {
        if (err instanceof WingValueError) {
          res.status(422).json({ error: err.message });
          return;
        }
        res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    router.post(`${routePath}/insert/:slot`, express.json(), async (req: Request, res: Response) => {
      const resolved = resolve(req);
      const slot = insertSlotOrNull(req);
      if (resolved === null || slot === null) {
        res.status(400).json({ error: `invalid path parameters for ${routePath}/insert/:slot` });
        return;
      }
      const { on, fx, mode, w } = req.body as Partial<Pick<SetInsertOptions, "on" | "fx" | "mode" | "w">>;
      try {
        res.json(await setInsert(ctx, { ...resolved, slot, on, fx, mode, w }));
      } catch (err) {
        if (err instanceof WingValueError) {
          res.status(422).json({ error: err.message });
          return;
        }
        res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
      }
    });
  }

  insertRoute("/channels/:index", (req) => {
    const n = channelIndexOrNull(req);
    return n === null ? null : { type: "channel", index: n };
  });

  insertRoute("/aux/:index", (req) => {
    const n = auxIndexOrNull(req);
    return n === null ? null : { type: "aux", index: n };
  });

  insertRoute("/strips/:type/:index", (req) => {
    const type = req.params.type;
    if (type !== "bus" && type !== "main" && type !== "mtx") return null;
    const n = Number(req.params.index);
    if (!Number.isInteger(n)) return null;
    return { type: type === "mtx" ? "matrix" : type, index: n };
  });

  /**
   * EQ/Gate/Dyn on-off — business logic lives in wing-processing-toggle.ts, shared with the
   * `wing_get_processing_block`/`wing_set_processing_block` MCP tools (see tools/processing-toggle.ts).
   * The generic wing_get/wing_set tools already cover the raw path; this gives the dashboard and any
   * REST caller the same validated, block-named shortcut. `block` ("eq"/"gate"/"dyn") comes from the
   * route's own param. The "gate" block only exists on channel strips — getProcessingBlockOn/
   * setProcessingBlockOn reject it elsewhere with a WingValueError, mapped to 422 below.
   */
  function processingBlockOrNull(req: Request): ProcessingBlock | null {
    const block = req.params.block;
    return block === "eq" || block === "gate" || block === "dyn" ? block : null;
  }

  function processingToggleRoute(
    routePath: string,
    resolve: (req: Request) => { type: ProcessingToggleType; index: number } | null,
  ): void {
    router.get(`${routePath}/:block/on`, async (req: Request, res: Response) => {
      const resolved = resolve(req);
      const block = processingBlockOrNull(req);
      if (resolved === null || block === null) {
        res.status(400).json({ error: `invalid path parameters for ${routePath}/:block/on` });
        return;
      }
      try {
        res.json(await getProcessingBlockOn(ctx, { ...resolved, block }));
      } catch (err) {
        if (err instanceof WingValueError) {
          res.status(422).json({ error: err.message });
          return;
        }
        res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    router.post(`${routePath}/:block/on`, express.json(), async (req: Request, res: Response) => {
      const resolved = resolve(req);
      const block = processingBlockOrNull(req);
      if (resolved === null || block === null) {
        res.status(400).json({ error: `invalid path parameters for ${routePath}/:block/on` });
        return;
      }
      const { on } = req.body as { on?: unknown };
      if (typeof on !== "boolean") {
        res.status(400).json({ error: "body must include boolean `on`" });
        return;
      }
      try {
        res.json(await setProcessingBlockOn(ctx, { ...resolved, block, on }));
      } catch (err) {
        if (err instanceof WingValueError) {
          res.status(422).json({ error: err.message });
          return;
        }
        res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
      }
    });
  }

  processingToggleRoute("/channels/:index", (req) => {
    const n = channelIndexOrNull(req);
    return n === null ? null : { type: "channel", index: n };
  });

  processingToggleRoute("/aux/:index", (req) => {
    const n = auxIndexOrNull(req);
    return n === null ? null : { type: "aux", index: n };
  });

  processingToggleRoute("/strips/:type/:index", (req) => {
    const type = req.params.type;
    if (type !== "bus" && type !== "main" && type !== "mtx") return null;
    const n = Number(req.params.index);
    if (!Number.isInteger(n)) return null;
    return { type: type === "mtx" ? "matrix" : type, index: n };
  });

  /**
   * Delay line — business logic lives in wing-delay.ts, shared with the `wing_get_delay`/
   * `wing_set_delay` MCP tools (see tools/delay.ts). Channel/aux delay lives on the input stage
   * (`in/set/dly*`); bus/main/matrix delay is its own `dly/*` node — wing-delay.ts picks the right
   * shape per type, this route just forwards type/index the same way the routes above do.
   */
  function delayRoute(routePath: string, resolve: (req: Request) => { type: DelayStripType; index: number } | null): void {
    router.get(`${routePath}/delay`, async (req: Request, res: Response) => {
      const resolved = resolve(req);
      if (resolved === null) {
        res.status(400).json({ error: `invalid path parameters for ${routePath}/delay` });
        return;
      }
      try {
        res.json(await getDelay(ctx, resolved.type, resolved.index));
      } catch (err) {
        if (err instanceof WingValueError) {
          res.status(422).json({ error: err.message });
          return;
        }
        res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    router.post(`${routePath}/delay`, express.json(), async (req: Request, res: Response) => {
      const resolved = resolve(req);
      if (resolved === null) {
        res.status(400).json({ error: `invalid path parameters for ${routePath}/delay` });
        return;
      }
      const { on, mode, value } = req.body as Partial<Pick<SetDelayOptions, "on" | "mode" | "value">>;
      try {
        res.json(await setDelay(ctx, { ...resolved, on, mode, value }));
      } catch (err) {
        if (err instanceof WingValueError) {
          res.status(422).json({ error: err.message });
          return;
        }
        res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
      }
    });
  }

  delayRoute("/channels/:index", (req) => {
    const n = channelIndexOrNull(req);
    return n === null ? null : { type: "channel", index: n };
  });

  delayRoute("/aux/:index", (req) => {
    const n = auxIndexOrNull(req);
    return n === null ? null : { type: "aux", index: n };
  });

  delayRoute("/strips/:type/:index", (req) => {
    const type = req.params.type;
    if (type !== "bus" && type !== "main" && type !== "mtx") return null;
    const n = Number(req.params.index);
    if (!Number.isInteger(n)) return null;
    return { type: type === "mtx" ? "matrix" : type, index: n };
  });
}
