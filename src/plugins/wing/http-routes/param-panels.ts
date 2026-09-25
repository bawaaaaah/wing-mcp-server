// Describe-driven parameter panels (EQ, dynamics, inputs...) for channels, auxes, buses and I/O.
// Part of the dashboard's REST API — see ./index.ts for how the modules are mounted.

import type { Request, Response, Router } from "express";
import { FX_COUNT, auxPath, channelPath, fxPath, ioInPath, ioOutPath } from "../wing-node-paths.js";
import {
  parseWingDescribeNumber,
  parseWingDescribeParams,
  type WingDescribeParam,
} from "../wing-value-codec.js";
import type { WingPluginContext } from "../wing-plugin.js";
import {
  channelIndexOrNull,
  auxIndexOrNull,
  ioGroupOrNull,
  ioIndexOrNull,
  stripPathOrNull,
} from "./shared.js";

export function registerParamPanelsRoutes(router: Router, ctx: WingPluginContext): void {
  /**
   * Describe (types/ranges/enums) + dump (current values) for a single processing node — the
   * generic mechanism behind the EQ/Gate/Dynamics/FX panels. A node's parameter *set* varies by
   * firmware version and, for FX, by the currently-loaded effect model — verified against real
   * hardware to diverge meaningfully from the hand-transcribed catalog for gate/dyn — so this
   * drives the UI from the console's own live description instead of a static schema.
   */
  async function describeAndDump(path: string): Promise<{ params: WingDescribeParam[]; values: Record<string, string | number> }> {
    const PARAM_PANEL_BUDGET_MS = 3000;
    const loadAll = Promise.all([ctx.client.describe(path), ctx.client.dump(path)]);
    const budget = new Promise<"timeout">((resolve) => {
      const timer = setTimeout(() => resolve("timeout"), PARAM_PANEL_BUDGET_MS);
      timer.unref?.();
    });
    const result = await Promise.race([loadAll, budget]);
    if (result === "timeout") {
      throw new Error(`Timed out loading ${path} from the console.`);
    }
    const [description, values] = result;
    const params = parseWingDescribeParams(description.lines);

    // Verified against real hardware: some numeric fields (observed on FX frequency parameters,
    // e.g. "hc") come back from dump() as WING's "k" shorthand string ("7k0" = 7000) rather than a
    // plain number — the same notation describe() uses for range bounds. Normalize those here so
    // the dashboard always receives a plain number for anything describe() calls numeric.
    const numericKinds = new Set<WingDescribeParam["kind"]>(["int", "lin", "log", "fader"]);
    const normalizedValues: Record<string, string | number> = { ...values };
    for (const param of params) {
      const raw = normalizedValues[param.key];
      if (numericKinds.has(param.kind) && typeof raw === "string") {
        const parsed = parseWingDescribeNumber(raw);
        if (parsed !== null) {
          normalizedValues[param.key] = parsed;
        }
      }
    }

    return { params, values: normalizedValues };
  }

  function registerParamPanelRoute(routePath: string, resolvePath: (req: Request) => string | null): void {
    router.get(routePath, async (req: Request, res: Response) => {
      const path = resolvePath(req);
      if (path === null) {
        res.status(400).json({ error: `invalid path parameters for ${routePath}` });
        return;
      }
      try {
        res.json(await describeAndDump(path));
      } catch (err) {
        res.status(504).json({ error: String(err) });
      }
    });
  }

  function channelParamPath(req: Request, suffix: string): string | null {
    const n = channelIndexOrNull(req);
    return n === null ? null : channelPath(n, suffix);
  }

  registerParamPanelRoute("/channels/:index/eq", (req) => channelParamPath(req, "eq"));

  registerParamPanelRoute("/channels/:index/gate", (req) => channelParamPath(req, "gate"));

  registerParamPanelRoute("/channels/:index/dyn", (req) => channelParamPath(req, "dyn"));

  /**
   * A channel's physical input mapping — verified against real hardware: {grp, in, altgrp, altin},
   * where grp is an enum of physical source groups (LCL, AUX, A/B/C AES50 ports, SC, USB, CRD, MOD,
   * PLAY, AES, USR, OSC, or an internal BUS/MAIN/MTX tap) and `in` is the 1-based index within that
   * group. This is how "map channel 3 to AES input 7" is actually expressed on the wire.
   */
  registerParamPanelRoute("/channels/:index/in/conn", (req) => channelParamPath(req, "in/conn"));

  function auxParamPath(req: Request, suffix: string): string | null {
    const n = auxIndexOrNull(req);
    return n === null ? null : auxPath(n, suffix);
  }

  // Aux has EQ and Dynamics like a channel, but verified against real hardware to have no Gate
  // stage at all (its branch listing lacks "gate"/"gatesc" entirely) — no /aux/:index/gate route.
  registerParamPanelRoute("/aux/:index/eq", (req) => auxParamPath(req, "eq"));

  registerParamPanelRoute("/aux/:index/dyn", (req) => auxParamPath(req, "dyn"));

  /** Aux shares the exact same {grp,in,altgrp,altin} input-mapping shape as a channel. */
  registerParamPanelRoute("/aux/:index/in/conn", (req) => auxParamPath(req, "in/conn"));

  registerParamPanelRoute("/strips/:type/:index/eq", (req) => stripPathOrNull(req, "eq"));

  registerParamPanelRoute("/strips/:type/:index/dyn", (req) => stripPathOrNull(req, "dyn"));

  registerParamPanelRoute("/fx/:index", (req) => {
    const n = Number(req.params.index);
    return Number.isInteger(n) && n >= 1 && n <= FX_COUNT ? fxPath(n) : null;
  });

  /**
   * A single physical input's own properties — verified against real hardware to include gain trim
   * (`g`), 48V phantom power (`vph`, only present on LCL/analog groups), polarity (`pol`), mute,
   * and name/color/icon (`name`/`col`/`icon`) — exactly what's needed to "map channel 3 to AES input
   * 7 and name it Guitar, green, guitar icon" once combined with the channel's in/conn mapping above.
   */
  registerParamPanelRoute("/io/in/:group/:index", (req) => {
    const group = ioGroupOrNull(req);
    const n = ioIndexOrNull(req);
    return group === null || n === null ? null : ioInPath(group, n);
  });

  /**
   * A single physical output's patch — verified against real hardware to be just {grp, in}: which
   * internal source (a bus/main/matrix/send/monitor tap, or a loopback of another physical group)
   * feeds this physical output.
   */
  registerParamPanelRoute("/io/out/:group/:index", (req) => {
    const group = ioGroupOrNull(req);
    const n = ioIndexOrNull(req);
    return group === null || n === null ? null : ioOutPath(group, n);
  });
}
