// I/O: input properties and listing, input patch and alt sources, AES50 link status, matrix direct inputs.
// Part of the dashboard's REST API — see ./index.ts for how the modules are mounted.

import express, { type Request, type Response, type Router } from "express";
import { AUX_COUNT, CHANNEL_COUNT, MATRIX_COUNT, auxPath, channelPath } from "../wing-node-paths.js";
import { WingValueError } from "../wing-errors.js";
import {
  getGlobalAltSwitch,
  getInputPatch,
  setAltSourceActive,
  setGlobalAltSwitch,
  setInputConnection,
  setSrcAuto,
  type InputPatchStripType,
  type InputSlot,
} from "../wing-input-patch.js";
import { clearAesErrors, getAesLinkStatus } from "../wing-link-status.js";
import {
  getMatrixDirectInput,
  setMatrixDirectInput,
  type SetMatrixDirectInputOptions,
} from "../wing-matrix-direct.js";
import { getSourceProps, setSourceProps, type SetSourcePropsOptions } from "../wing-source.js";
import type { WingPluginContext } from "../wing-plugin.js";
import { boundedReads } from "../wing-read-budget.js";
import { channelIndexOrNull, auxIndexOrNull, ioGroupOrNull, ioIndexOrNull } from "./shared.js";

export function registerIoRoutes(router: Router, ctx: WingPluginContext): void {
  /**
   * A physical input source's own identity + preamp settings (name/color/icon/gain/48V/polarity/mute)
   * as a fixed, decoded shape — the shared getSourceProps/setSourceProps core behind the
   * `wing_get_source` / `wing_set_source` MCP tools (tools/source.ts). Distinct from the describe+dump
   * `/io/in/:group/:index` param-panel route above: that streams whatever leaves the console
   * describes; this resolves the `col` display/value off-by-one and returns booleans as booleans, for
   * programmatic callers and the Identity tab's Source editor.
   */
  router.get("/io/in/:group/:index/props", async (req: Request, res: Response) => {
    const group = ioGroupOrNull(req);
    const n = ioIndexOrNull(req);
    if (group === null || n === null) {
      res.status(400).json({ error: "invalid group/index for /io/in/:group/:index/props" });
      return;
    }
    try {
      res.json(await getSourceProps(ctx, group, n));
    } catch (err) {
      res.status(502).json({ error: String(err) });
    }
  });

  router.post("/io/in/:group/:index/props", express.json(), async (req: Request, res: Response) => {
    const group = ioGroupOrNull(req);
    const n = ioIndexOrNull(req);
    if (group === null || n === null) {
      res.status(400).json({ error: "invalid group/index for /io/in/:group/:index/props" });
      return;
    }
    const { name, col, icon, gain, phantom48v, polarityInverted, mute } = req.body as Partial<SetSourcePropsOptions>;
    try {
      res.json(await setSourceProps(ctx, { group, index: n, name, col, icon, gain, phantom48v, polarityInverted, mute }));
    } catch (err) {
      if (err instanceof WingValueError) {
        res.status(422).json({ error: err.message });
        return;
      }
      res.status(502).json({ error: String(err) });
    }
  });

  /**
   * Lists every physical I/O group and its real per-group channel count (LCL has 24 inputs on a
   * WING Rack, AES has 2, AES50 ports A/B/C have 48 each, etc. — verified to vary a lot, so this is
   * discovered live rather than hardcoded). "$"-prefixed groups under /io/in (the internal
   * BUS/MAIN/MTX/SEND/MON taps) are excluded from the input listing: they aren't physical inputs
   * with gain/phantom/name properties, just index ranges selectable via a channel's in/conn.grp.
   */
  router.get("/io", async (_req: Request, res: Response) => {
    async function listGroups(base: "/io/in" | "/io/out"): Promise<{ group: string; count: number }[]> {
      const root = await ctx.client.get(base);
      if (root.kind !== "branch") return [];
      const groups = root.children.filter((g) => !g.startsWith("$"));
      return Promise.all(
        groups.map(async (group) => {
          const branch = await ctx.client.get(`${base}/${group}`);
          return { group, count: branch.kind === "branch" ? branch.children.length : 0 };
        }),
      );
    }
    try {
      const [inputGroups, outputGroups] = await Promise.all([listGroups("/io/in"), listGroups("/io/out")]);
      res.json({ inputGroups, outputGroups });
    } catch (err) {
      res.status(502).json({ error: String(err) });
    }
  });

  /**
   * Physical input patch (Main/Alt) — business logic lives in wing-input-patch.ts, shared with the
   * `wing_get_input_patch`/`wing_set_input_connection`/`wing_set_alt_source_active`/`wing_set_srcauto`
   * MCP tools (see tools/input-patch.ts). Channel/aux only — `type` is fixed by which route matched
   * rather than accepted as a body field, so there's no need to validate an arbitrary `type` string here.
   */
  function inputPatchRoute(
    routePath: string,
    resolve: (req: Request) => { type: InputPatchStripType; index: number } | null,
  ): void {
    router.get(`${routePath}/in/patch`, async (req: Request, res: Response) => {
      const resolved = resolve(req);
      if (resolved === null) {
        res.status(400).json({ error: `invalid path parameters for ${routePath}/in/patch` });
        return;
      }
      try {
        res.json(await getInputPatch(ctx, resolved));
      } catch (err) {
        if (err instanceof WingValueError) {
          res.status(422).json({ error: err.message });
          return;
        }
        res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    router.post(`${routePath}/in/patch`, express.json(), async (req: Request, res: Response) => {
      const resolved = resolve(req);
      if (resolved === null) {
        res.status(400).json({ error: `invalid path parameters for ${routePath}/in/patch` });
        return;
      }
      const { slot, grp, in: inputIndex } = req.body as { slot?: unknown; grp?: unknown; in?: unknown };
      if ((slot !== "main" && slot !== "alt") || typeof grp !== "string" || typeof inputIndex !== "number") {
        res.status(400).json({ error: 'body must include slot ("main"|"alt"), string `grp`, numeric `in`' });
        return;
      }
      try {
        res.json(await setInputConnection(ctx, { ...resolved, slot: slot as InputSlot, grp, in: inputIndex }));
      } catch (err) {
        if (err instanceof WingValueError) {
          res.status(422).json({ error: err.message });
          return;
        }
        res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    router.post(`${routePath}/in/set/altsrc`, express.json(), async (req: Request, res: Response) => {
      const resolved = resolve(req);
      if (resolved === null) {
        res.status(400).json({ error: `invalid path parameters for ${routePath}/in/set/altsrc` });
        return;
      }
      const { active } = req.body as { active?: unknown };
      if (typeof active !== "boolean") {
        res.status(400).json({ error: "body must include boolean `active`" });
        return;
      }
      try {
        res.json(await setAltSourceActive(ctx, { ...resolved, active }));
      } catch (err) {
        if (err instanceof WingValueError) {
          res.status(422).json({ error: err.message });
          return;
        }
        res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    router.post(`${routePath}/in/set/srcauto`, express.json(), async (req: Request, res: Response) => {
      const resolved = resolve(req);
      if (resolved === null) {
        res.status(400).json({ error: `invalid path parameters for ${routePath}/in/set/srcauto` });
        return;
      }
      const { linked } = req.body as { linked?: unknown };
      if (typeof linked !== "boolean") {
        res.status(400).json({ error: "body must include boolean `linked`" });
        return;
      }
      try {
        res.json(await setSrcAuto(ctx, { ...resolved, linked }));
      } catch (err) {
        if (err instanceof WingValueError) {
          res.status(422).json({ error: err.message });
          return;
        }
        res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
      }
    });
  }

  inputPatchRoute("/channels/:index", (req) => {
    const n = channelIndexOrNull(req);
    return n === null ? null : { type: "channel", index: n };
  });

  inputPatchRoute("/aux/:index", (req) => {
    const n = auxIndexOrNull(req);
    return n === null ? null : { type: "aux", index: n };
  });

  /** Console-wide Alt switch — independent of any single channel/aux's own Main/Alt selector. */
  router.get("/io/altsw", async (_req: Request, res: Response) => {
    try {
      res.json(await getGlobalAltSwitch(ctx));
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/io/altsw", express.json(), async (req: Request, res: Response) => {
    const { on, autoOverride } = req.body as { on?: unknown; autoOverride?: unknown };
    if (on !== undefined && typeof on !== "boolean") {
      res.status(400).json({ error: "`on` must be boolean if provided" });
      return;
    }
    if (autoOverride !== undefined && typeof autoOverride !== "boolean") {
      res.status(400).json({ error: "`autoOverride` must be boolean if provided" });
      return;
    }
    try {
      res.json(await setGlobalAltSwitch(ctx, { on, autoOverride }));
    } catch (err) {
      if (err instanceof WingValueError) {
        res.status(422).json({ error: err.message });
        return;
      }
      res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get("/link-status", async (_req: Request, res: Response) => {
    try {
      res.json(await getAesLinkStatus(ctx));
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/link-status/clear-errors", express.json(), async (req: Request, res: Response) => {
    const { port } = (req.body ?? {}) as { port?: unknown };
    if (typeof port !== "string") {
      res.status(400).json({ error: "`port` must be a string (A, B, or C)" });
      return;
    }
    try {
      res.json(await clearAesErrors(ctx, port));
    } catch (err) {
      if (err instanceof WingValueError) {
        res.status(422).json({ error: err.message });
        return;
      }
      res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * Matrix-exclusive "Direct Input" sub-mixer — business logic lives in wing-matrix-direct.ts,
   * shared with the `wing_get_matrix_direct_input`/`wing_set_matrix_direct_input` MCP tools (see
   * tools/matrix-direct.ts).
   */
  router.get("/mtx/:index/direct-input", async (req: Request, res: Response) => {
    const n = Number(req.params.index);
    if (!Number.isInteger(n) || n < 1 || n > MATRIX_COUNT) {
      res.status(400).json({ error: "invalid path parameters for /mtx/:index/direct-input" });
      return;
    }
    try {
      res.json(await getMatrixDirectInput(ctx, n));
    } catch (err) {
      if (err instanceof WingValueError) {
        res.status(422).json({ error: err.message });
        return;
      }
      res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/mtx/:index/direct-input", express.json(), async (req: Request, res: Response) => {
    const n = Number(req.params.index);
    if (!Number.isInteger(n) || n < 1 || n > MATRIX_COUNT) {
      res.status(400).json({ error: "invalid path parameters for /mtx/:index/direct-input" });
      return;
    }
    const { on, levelDb, invert, input } = (req.body ?? {}) as Partial<Omit<SetMatrixDirectInputOptions, "index">>;
    try {
      res.json(await setMatrixDirectInput(ctx, { index: n, on, levelDb, invert, input }));
    } catch (err) {
      if (err instanceof WingValueError) {
        res.status(422).json({ error: err.message });
        return;
      }
      res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * Which channels/aux currently have this physical input as their primary source (in/conn.grp +
   * .in — not altgrp/altin, whose failover semantics aren't verified against hardware) — lets the
   * Physical Inputs panel show a live meter and offer Auto Gain for whatever's actually plugged in,
   * without needing to reverse-engineer the metering protocol's undocumented "source"/"output"
   * token's own index space (investigated live and found NOT to align with /io/in's group+index
   * addressing in any simple way — see session notes).
   */
  router.get("/io/in/:group/:index/routed-channels", async (req: Request, res: Response) => {
    const group = ioGroupOrNull(req);
    const n = ioIndexOrNull(req);
    if (group === null || n === null) {
      res.status(400).json({ error: "invalid group/index" });
      return;
    }
    const ROUTED_LOOKUP_BUDGET_MS = 8000;
    const reads = boundedReads(ROUTED_LOOKUP_BUDGET_MS);
    async function matches(path: string): Promise<boolean> {
      try {
        const dump = await reads.run(() => ctx.client.dump(path));
        return dump.grp === group && Number(dump.in) === n;
      } catch {
        return false;
      }
    }
    const loadAll = Promise.all([
      Promise.all(Array.from({ length: CHANNEL_COUNT }, (_, i) => i + 1).map(async (i) => ((await matches(channelPath(i, "in/conn"))) ? i : null))),
      Promise.all(Array.from({ length: AUX_COUNT }, (_, i) => i + 1).map(async (i) => ((await matches(auxPath(i, "in/conn"))) ? i : null))),
    ]);
    const result = await reads.within(loadAll);
    if (result === "timeout") {
      res.status(504).json({ error: "Timed out looking up which channels/aux use this input." });
      return;
    }
    const [channels, auxes] = result;
    res.json({
      channels: channels.filter((v): v is number => v !== null),
      auxes: auxes.filter((v): v is number => v !== null),
    });
  });
}
