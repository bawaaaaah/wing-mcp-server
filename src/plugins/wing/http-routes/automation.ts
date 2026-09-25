// Auto-gain, auto-compress and auto-gate.
// Part of the dashboard's REST API — see ./index.ts for how the modules are mounted.

import express, { type Request, type Response, type Router } from "express";
import { AUX_COUNT, CHANNEL_COUNT, ioInPath } from "../wing-node-paths.js";
import {
  type AutoGainMode,
  type AutoGainOptions,
  GAIN_FALLBACK_RANGE,
  runAutoGain,
  runCombinedAutoGain,
} from "../wing-autogain.js";
import { type AutoCompressBlock, type AutoCompressOptions, runAutoCompress } from "../wing-auto-compress.js";
import { type AutoGateBlock, type AutoGateOptions, runAutoGate } from "../wing-auto-gate.js";
import { WingValueError } from "../wing-errors.js";
import type { WingPluginContext } from "../wing-plugin.js";
import { channelIndexOrNull, auxIndexOrNull, ioGroupOrNull, ioIndexOrNull } from "./shared.js";

export function registerAutomationRoutes(router: Router, ctx: WingPluginContext): void {
  /**
   * HTTP adapter around the shared `runAutoGain()` algorithm (see wing-autogain.ts for the full
   * rationale — meter-sampling window, no-signal/low-signal safety floors, live-described field
   * bounds instead of hardcoded ones) — also used, independently, by the `wing_auto_gain` MCP tool.
   * Maps its thrown errors to HTTP status codes: a signal-condition failure (nothing plugged in, or
   * too quiet to compute a reliable adjustment) is a 422, anything else (console unreachable, read/
   * write failure) is a 502.
   */
  async function respondAutoGain(res: Response, opts: AutoGainOptions): Promise<void> {
    try {
      const result = await runAutoGain(ctx, opts);
      res.json(result);
    } catch (err) {
      if (err instanceof WingValueError) {
        res.status(422).json({ error: err.message });
        return;
      }
      res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    }
  }

  /** `undefined` (rather than a hardcoded default) so `runAutoGain()` applies its own default. */
  function parseAutogainTargetDb(req: Request): number | undefined {
    const body = req.body as { targetDb?: number } | undefined;
    return typeof body?.targetDb === "number" && Number.isFinite(body.targetDb) ? body.targetDb : undefined;
  }

  function parseAutogainMode(req: Request): AutoGainMode | undefined {
    const body = req.body as { mode?: unknown } | undefined;
    return body?.mode === "gain" || body?.mode === "trim" || body?.mode === "both" ? body.mode : undefined;
  }

  /**
   * HTTP adapter around `runCombinedAutoGain()` (gain-staging first, trim only as needed — see
   * wing-autogain.ts) — same algorithm as, and shares its implementation with, the `wing_auto_gain`
   * MCP tool. Backs the channel/aux Auto Gain button; the dedicated physical-input Auto Gain button
   * (below) stays a single-field `respondAutoGain()` since that view is about one specific preamp,
   * not a channel/aux's whole gain-staging chain.
   */
  async function respondCombinedAutoGain(res: Response, type: "channel" | "aux", index: number, req: Request): Promise<void> {
    try {
      const result = await runCombinedAutoGain(ctx, { type, index, targetDb: parseAutogainTargetDb(req), mode: parseAutogainMode(req) });
      res.json(result);
    } catch (err) {
      if (err instanceof WingValueError) {
        res.status(422).json({ error: err.message });
        return;
      }
      res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    }
  }

  router.post("/channels/:index/autogain", express.json(), async (req: Request, res: Response) => {
    const channel = channelIndexOrNull(req);
    if (channel === null) {
      res.status(400).json({ error: `channel index out of range: ${String(req.params.index)}` });
      return;
    }
    await respondCombinedAutoGain(res, "channel", channel, req);
  });

  router.post("/aux/:index/autogain", express.json(), async (req: Request, res: Response) => {
    const aux = auxIndexOrNull(req);
    if (aux === null) {
      res.status(400).json({ error: `aux index out of range: ${String(req.params.index)}` });
      return;
    }
    await respondCombinedAutoGain(res, "aux", aux, req);
  });

  /**
   * HTTP adapter around the shared `runAutoCompress()` algorithm (see wing-auto-compress.ts for the
   * full rationale — "gate" and "dyn" are both generic dynamics-processing slots, so `block` picks
   * which one to drive) — also used, independently, by the `wing_auto_compress` MCP tool. Same
   * error-code mapping convention as `respondAutoGain()` above: a signal/value condition (no real
   * program material to measure, console rejected the new threshold) is a 422, anything else
   * (console unreachable, read/write failure) is a 502.
   */
  function parseAutoCompressBody(
    req: Request,
  ): Pick<
    AutoCompressOptions,
    "thresholdDb" | "targetReductionDb" | "targetMode" | "maxIterations" | "inputGainDb" | "ratio" | "sampleMs"
  > {
    const body = req.body as
      | {
          thresholdDb?: number;
          targetReductionDb?: number;
          targetMode?: unknown;
          maxIterations?: number;
          inputGainDb?: number;
          ratio?: number | string;
          sampleMs?: number;
        }
      | undefined;
    return {
      thresholdDb: typeof body?.thresholdDb === "number" && Number.isFinite(body.thresholdDb) ? body.thresholdDb : undefined,
      targetReductionDb:
        typeof body?.targetReductionDb === "number" && Number.isFinite(body.targetReductionDb) ? body.targetReductionDb : undefined,
      targetMode: body?.targetMode === "average" || body?.targetMode === "peak" ? body.targetMode : undefined,
      maxIterations: typeof body?.maxIterations === "number" && Number.isFinite(body.maxIterations) ? body.maxIterations : undefined,
      inputGainDb: typeof body?.inputGainDb === "number" && Number.isFinite(body.inputGainDb) ? body.inputGainDb : undefined,
      ratio: typeof body?.ratio === "number" || typeof body?.ratio === "string" ? body.ratio : undefined,
      sampleMs: typeof body?.sampleMs === "number" && Number.isFinite(body.sampleMs) ? body.sampleMs : undefined,
    };
  }

  async function respondAutoCompress(res: Response, opts: AutoCompressOptions): Promise<void> {
    try {
      const result = await runAutoCompress(ctx, opts);
      res.json(result);
    } catch (err) {
      if (err instanceof WingValueError) {
        res.status(422).json({ error: err.message });
        return;
      }
      res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    }
  }

  function autoCompressRoute(routePath: string, resolve: (req: Request) => { type: AutoCompressOptions["type"]; index: number; block: AutoCompressBlock } | null): void {
    router.post(routePath, express.json(), async (req: Request, res: Response) => {
      const resolved = resolve(req);
      if (resolved === null) {
        res.status(400).json({ error: `invalid path parameters for ${routePath}` });
        return;
      }
      await respondAutoCompress(res, { ...resolved, ...parseAutoCompressBody(req) });
    });
  }

  autoCompressRoute("/channels/:index/gate/auto-compress", (req) => {
    const channel = channelIndexOrNull(req);
    return channel === null ? null : { type: "channel", index: channel, block: "gate" };
  });

  autoCompressRoute("/channels/:index/dyn/auto-compress", (req) => {
    const channel = channelIndexOrNull(req);
    return channel === null ? null : { type: "channel", index: channel, block: "dyn" };
  });

  autoCompressRoute("/aux/:index/dyn/auto-compress", (req) => {
    const aux = auxIndexOrNull(req);
    return aux === null ? null : { type: "aux", index: aux, block: "dyn" };
  });

  // "mtx" (this dashboard's own bus/main/matrix route-param spelling — see stripPathOrNull above)
  // maps to the MCP-tool-facing/meter-protocol spelling "matrix" used by AutoCompressOptions.
  autoCompressRoute("/strips/:type/:index/dyn/auto-compress", (req) => {
    const type = req.params.type;
    if (type !== "bus" && type !== "main" && type !== "mtx") return null;
    const n = Number(req.params.index);
    if (!Number.isInteger(n)) return null;
    return { type: type === "mtx" ? "matrix" : type, index: n, block: "dyn" };
  });

  /**
   * HTTP adapter around the shared `runAutoGate()` algorithm (see wing-auto-gate.ts) — mirrors the
   * auto-compress routes just above, same error-code convention.
   */
  function parseAutoGateBody(req: Request): Pick<AutoGateOptions, "marginDb" | "sampleMs"> {
    const body = req.body as { marginDb?: number; sampleMs?: number } | undefined;
    return {
      marginDb: typeof body?.marginDb === "number" && Number.isFinite(body.marginDb) ? body.marginDb : undefined,
      sampleMs: typeof body?.sampleMs === "number" && Number.isFinite(body.sampleMs) ? body.sampleMs : undefined,
    };
  }

  async function respondAutoGate(res: Response, opts: AutoGateOptions): Promise<void> {
    try {
      const result = await runAutoGate(ctx, opts);
      res.json(result);
    } catch (err) {
      if (err instanceof WingValueError) {
        res.status(422).json({ error: err.message });
        return;
      }
      res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    }
  }

  function autoGateRoute(routePath: string, resolve: (req: Request) => { type: AutoGateOptions["type"]; index: number; block: AutoGateBlock } | null): void {
    router.post(routePath, express.json(), async (req: Request, res: Response) => {
      const resolved = resolve(req);
      if (resolved === null) {
        res.status(400).json({ error: `invalid path parameters for ${routePath}` });
        return;
      }
      await respondAutoGate(res, { ...resolved, ...parseAutoGateBody(req) });
    });
  }

  autoGateRoute("/channels/:index/gate/auto-gate", (req) => {
    const channel = channelIndexOrNull(req);
    return channel === null ? null : { type: "channel", index: channel, block: "gate" };
  });

  autoGateRoute("/channels/:index/dyn/auto-gate", (req) => {
    const channel = channelIndexOrNull(req);
    return channel === null ? null : { type: "channel", index: channel, block: "dyn" };
  });

  autoGateRoute("/aux/:index/dyn/auto-gate", (req) => {
    const aux = auxIndexOrNull(req);
    return aux === null ? null : { type: "aux", index: aux, block: "dyn" };
  });

  autoGateRoute("/strips/:type/:index/dyn/auto-gate", (req) => {
    const type = req.params.type;
    if (type !== "bus" && type !== "main" && type !== "mtx") return null;
    const n = Number(req.params.index);
    if (!Number.isInteger(n)) return null;
    return { type: type === "mtx" ? "matrix" : type, index: n, block: "dyn" };
  });

  router.post("/io/in/:group/:index/autogain", express.json(), async (req: Request, res: Response) => {
    const group = ioGroupOrNull(req);
    const n = ioIndexOrNull(req);
    if (group === null || n === null) {
      res.status(400).json({ error: "invalid group/index" });
      return;
    }
    const body = req.body as { meterType?: string; meterIndex?: number; targetDb?: number } | undefined;
    const meterType = body?.meterType === "aux" ? "aux" : "channel";
    const meterIndex = Number(body?.meterIndex);
    const maxMeterIndex = meterType === "aux" ? AUX_COUNT : CHANNEL_COUNT;
    if (!Number.isInteger(meterIndex) || meterIndex < 1 || meterIndex > maxMeterIndex) {
      res.status(400).json({
        error:
          "A valid meterType + meterIndex is required — this physical input must currently be routed to a channel or aux to sample its live level.",
      });
      return;
    }
    await respondAutoGain(res, {
      targetNodePath: ioInPath(group, n),
      fieldKey: "g",
      fieldFallbackRange: GAIN_FALLBACK_RANGE,
      meterType,
      meterIndex,
      targetDb: parseAutogainTargetDb(req),
    });
  });
}
