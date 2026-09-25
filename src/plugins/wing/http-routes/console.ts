// Console administration and surface: flash/autosave, selected strip, talkback, GPIO, lighting, scribble strips, OSC mirror.
// Part of the dashboard's REST API — see ./index.ts for how the modules are mounted.

import express, { type Request, type Response, type Router } from "express";
import { WingValueError } from "../wing-errors.js";
import { getAutoSaveConfig, saveToFlash, setAutoSaveConfig } from "../wing-console-admin.js";
import { getSelectedStrip, setSelectedStrip } from "../wing-selected-strip.js";
import { configureOscMirror, getOscMirrorStatus, type OscMirrorConfig } from "../wing-osc-mirror.js";
import {
  getTalkbackStatus,
  setTalkbackAssign,
  setTalkbackDestination,
  setTalkbackSource,
  type SetTalkbackDestinationOptions,
  type SetTalkbackSourceOptions,
  type TalkbackAssign,
} from "../wing-talkback.js";
import { getAllGpioStatus, getGpioStatus, setGpioMode, setGpioState, type GpioMode } from "../wing-gpio.js";
import { getLightingStatus, setLighting, type SetLightingOptions } from "../wing-lighting.js";
import {
  getScribble,
  setScribble,
  type ScribbleStripType,
  type SetScribbleOptions,
} from "../wing-scribble.js";
import { RTA_SOURCE_TYPES, type RtaSourceType } from "../wing-rta-source.js";
import type { WingPluginContext } from "../wing-plugin.js";
import { channelIndexOrNull, auxIndexOrNull } from "./shared.js";

export function registerConsoleRoutes(router: Router, ctx: WingPluginContext): void {
  router.post("/console/save-flash", async (_req: Request, res: Response) => {
    try {
      res.json(await saveToFlash(ctx));
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get("/console/autosave", async (_req: Request, res: Response) => {
    try {
      res.json(await getAutoSaveConfig(ctx));
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/console/autosave", express.json(), async (req: Request, res: Response) => {
    const { enabled } = (req.body ?? {}) as { enabled?: unknown };
    if (typeof enabled !== "boolean") {
      res.status(400).json({ error: "`enabled` must be a boolean" });
      return;
    }
    try {
      res.json(await setAutoSaveConfig(ctx, enabled));
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /** Mirrors the `wing_get_selected_strip`/`wing_set_selected_strip` MCP tools — see
   * wing-selected-strip.ts for the GET(0..75)/SET(1..76) off-by-one this wraps. */
  router.get("/selected-strip", async (_req: Request, res: Response) => {
    try {
      res.json(await getSelectedStrip(ctx));
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/selected-strip", express.json(), async (req: Request, res: Response) => {
    const { type, index } = (req.body ?? {}) as { type?: string; index?: number };
    if (!RTA_SOURCE_TYPES.includes(type as RtaSourceType) || typeof index !== "number") {
      res.status(400).json({ error: `expected { type: one of ${RTA_SOURCE_TYPES.join(", ")}, index: number }` });
      return;
    }
    try {
      res.json(await setSelectedStrip(ctx, { type: type as RtaSourceType, index }));
    } catch (err) {
      if (err instanceof WingValueError) {
        res.status(422).json({ error: err.message });
        return;
      }
      res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * Talkback config — business logic lives in wing-talkback.ts, shared with the `wing_*talkback*`
   * MCP tools (see tools/talkback.ts).
   */
  router.get("/talkback", async (_req: Request, res: Response) => {
    try {
      res.json(await getTalkbackStatus(ctx));
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/talkback/assign", express.json(), async (req: Request, res: Response) => {
    const { assign } = (req.body ?? {}) as { assign?: TalkbackAssign };
    if (!assign) {
      res.status(400).json({ error: "body must include `assign`" });
      return;
    }
    try {
      res.json(await setTalkbackAssign(ctx, assign));
    } catch (err) {
      if (err instanceof WingValueError) {
        res.status(422).json({ error: err.message });
        return;
      }
      res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/talkback/:source", express.json(), async (req: Request, res: Response) => {
    const { source } = req.params;
    const { on, mode, mondim, busdim, indiv } = (req.body ?? {}) as Partial<Omit<SetTalkbackSourceOptions, "source">>;
    try {
      res.json(await setTalkbackSource(ctx, { source: source as SetTalkbackSourceOptions["source"], on, mode, mondim, busdim, indiv }));
    } catch (err) {
      if (err instanceof WingValueError) {
        res.status(422).json({ error: err.message });
        return;
      }
      res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/talkback/:source/destination", express.json(), async (req: Request, res: Response) => {
    const { source } = req.params;
    const { type, index, on } = (req.body ?? {}) as Partial<Omit<SetTalkbackDestinationOptions, "source">>;
    if (type === undefined || index === undefined || on === undefined) {
      res.status(400).json({ error: "body must include `type`, `index`, and `on`" });
      return;
    }
    try {
      res.json(await setTalkbackDestination(ctx, { source: source as SetTalkbackDestinationOptions["source"], type, index, on }));
    } catch (err) {
      if (err instanceof WingValueError) {
        res.status(422).json({ error: err.message });
        return;
      }
      res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * Hardware GPIO — business logic lives in wing-gpio.ts, shared with the `wing_*gpio*` MCP tools
   * (see tools/gpio.ts).
   */
  router.get("/gpio", async (_req: Request, res: Response) => {
    try {
      res.json(await getAllGpioStatus(ctx));
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get("/gpio/:index", async (req: Request, res: Response) => {
    const index = Number(req.params.index);
    try {
      res.json(await getGpioStatus(ctx, index));
    } catch (err) {
      if (err instanceof WingValueError) {
        res.status(422).json({ error: err.message });
        return;
      }
      res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/gpio/:index/mode", express.json(), async (req: Request, res: Response) => {
    const index = Number(req.params.index);
    const { mode } = (req.body ?? {}) as { mode?: GpioMode };
    if (!mode) {
      res.status(400).json({ error: "body must include `mode`" });
      return;
    }
    try {
      res.json(await setGpioMode(ctx, { index, mode }));
    } catch (err) {
      if (err instanceof WingValueError) {
        res.status(422).json({ error: err.message });
        return;
      }
      res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/gpio/:index/state", express.json(), async (req: Request, res: Response) => {
    const index = Number(req.params.index);
    const { on } = (req.body ?? {}) as { on?: boolean };
    if (on === undefined) {
      res.status(400).json({ error: "body must include `on`" });
      return;
    }
    try {
      res.json(await setGpioState(ctx, { index, on }));
    } catch (err) {
      if (err instanceof WingValueError) {
        res.status(422).json({ error: err.message });
        return;
      }
      res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * Console lighting — business logic lives in wing-lighting.ts, shared with the `wing_*lighting`
   * MCP tools (see tools/lighting.ts).
   */
  router.get("/lighting", async (_req: Request, res: Response) => {
    try {
      res.json(await getLightingStatus(ctx));
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/lighting", express.json(), async (req: Request, res: Response) => {
    const opts = (req.body ?? {}) as SetLightingOptions;
    try {
      res.json(await setLighting(ctx, opts));
    } catch (err) {
      if (err instanceof WingValueError) {
        res.status(422).json({ error: err.message });
        return;
      }
      res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * Scribble strip identity (led/color/icon) — business logic lives in wing-scribble.ts, shared
   * with the `wing_get_scribble`/`wing_set_scribble` MCP tools (see tools/scribble.ts). `type` is
   * fixed by which route matched rather than accepted as a body field. Mutegroup has no
   * scribble/color/icon field at all, so unlike `/strips/:type/:index/delay` this pattern accepts
   * "dca" as a fourth type alongside bus/main/mtx, but still never "mgrp".
   */
  function scribbleRoute(routePath: string, resolve: (req: Request) => { type: ScribbleStripType; index: number } | null): void {
    router.get(`${routePath}/scribble`, async (req: Request, res: Response) => {
      const resolved = resolve(req);
      if (resolved === null) {
        res.status(400).json({ error: `invalid path parameters for ${routePath}/scribble` });
        return;
      }
      try {
        res.json(await getScribble(ctx, resolved.type, resolved.index));
      } catch (err) {
        if (err instanceof WingValueError) {
          res.status(422).json({ error: err.message });
          return;
        }
        res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    router.post(`${routePath}/scribble`, express.json(), async (req: Request, res: Response) => {
      const resolved = resolve(req);
      if (resolved === null) {
        res.status(400).json({ error: `invalid path parameters for ${routePath}/scribble` });
        return;
      }
      const { led, col, icon } = req.body as Partial<Pick<SetScribbleOptions, "led" | "col" | "icon">>;
      try {
        res.json(await setScribble(ctx, { ...resolved, led, col, icon }));
      } catch (err) {
        if (err instanceof WingValueError) {
          res.status(422).json({ error: err.message });
          return;
        }
        res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
      }
    });
  }

  scribbleRoute("/channels/:index", (req) => {
    const n = channelIndexOrNull(req);
    return n === null ? null : { type: "channel", index: n };
  });

  scribbleRoute("/aux/:index", (req) => {
    const n = auxIndexOrNull(req);
    return n === null ? null : { type: "aux", index: n };
  });

  scribbleRoute("/strips/:type/:index", (req) => {
    const type = req.params.type;
    if (type !== "bus" && type !== "main" && type !== "mtx" && type !== "dca") return null;
    const n = Number(req.params.index);
    if (!Number.isInteger(n)) return null;
    return { type: type === "mtx" ? "matrix" : type, index: n };
  });

  /**
   * Raw OSC/meter mirror — business logic lives in wing-osc-mirror.ts, shared with the
   * `wing_get_osc_mirror_status`/`wing_set_osc_mirror` MCP tools (see tools/osc-mirror.ts).
   */
  router.get("/osc-mirror", (_req: Request, res: Response) => {
    res.json(getOscMirrorStatus(ctx));
  });

  router.post("/osc-mirror", express.json(), (req: Request, res: Response) => {
    const { enabled, host, port } = (req.body ?? {}) as Partial<OscMirrorConfig>;
    try {
      res.json(configureOscMirror(ctx, { enabled, host, port }));
    } catch (err) {
      if (err instanceof WingValueError) {
        res.status(422).json({ error: err.message });
        return;
      }
      res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
