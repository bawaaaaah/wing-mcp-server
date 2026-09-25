// Generic and memory-backed writes: group membership, value memory, fades, set and bulk-set.
// Part of the dashboard's REST API — see ./index.ts for how the modules are mounted.

import express, { type Request, type Response, type Router } from "express";
import {
  BUS_COUNT,
  MAIN_COUNT,
  MATRIX_COUNT,
  auxPath,
  busPath,
  channelPath,
  mainPath,
  matrixPath,
} from "../wing-node-paths.js";
import { splitLeafPath } from "../tools/generic.js";
import { WingValueError } from "../wing-errors.js";
import { requireEasingName } from "../wing-easing.js";
import { adjustValueByDelta, restoreValue, storeValue, undoLastAdjust } from "../wing-value-memory.js";
import { cancelFade, startFade } from "../wing-fade.js";
import { getGroupMembership, setGroupMembership } from "../wing-group-tags.js";
import { validateNodeValue } from "../wing-value-codec.js";
import type { WingPluginContext } from "../wing-plugin.js";
import { channelIndexOrNull, auxIndexOrNull } from "./shared.js";

export function registerWritesRoutes(router: Router, ctx: WingPluginContext): void {
  /**
   * DCA/mute group membership — verified against real hardware to NOT be a separate node
   * (`/ch/N`, `/dca/N`, and `/mgrp/N` were all fully describe()'d and none expose a membership
   * field). It's encoded instead as reserved `#D<n>`/`#M<n>` tokens inside the node's own `tags`
   * string, confirmed both from the official protocol reference (`#D1..#D16` for DCA) and live
   * against this console (a channel already tagged `#D7,#D9` in production; tagging a test channel
   * `#M1` and muting `/mgrp/1` flipped its `$mute` to 2, the same value a `#D`-tagged channel gets
   * when its DCA is muted) — see wing-group-tags.ts. Registered for every node type verified to
   * have a `tags` field: channel, aux, bus, main, matrix.
   *
   * Two hardware/protocol quirks shaped how this reads and writes, both found live while testing:
   *  - Reads use `get()` on the `tags` leaf directly, never `dump()` on the whole parent node:
   *    `dump()`'s flat-assignment parser mis-keys some entries (a stray leading "." — e.g. "tags"
   *    comes back as ".tags") on nodes with enough nested sub-sections, which a full `/ch/N`
   *    (in/set, in/conn, flt, peq, gate, eq, dyn, send/1..16, send/MX1..8, main/1..4, ...) very
   *    much is. A single leaf `get()` has no such ambiguity.
   *  - Writes use `set()` on the `tags` leaf directly, never `bulkSet()`: bulkSet's compact
   *    "key=val,key2=val2" format uses comma as the assignment separator, which is ambiguous with
   *    a multi-tag value like "#D3,#D9" — confirmed live, the console reported "NODE NOT FOUND"
   *    (parsing "#D9" as a second, invalid assignment) when a two-tag value was bulk-set this way.
   *    `set()` sends the whole string as a single OSC argument with no such delimiter collision,
   *    at the cost of no ack — so the write is verified here by reading the value back.
   */
  function registerGroupsRoutes(routePath: string, resolvePath: (req: Request) => string | null): void {
    router.get(routePath, async (req: Request, res: Response) => {
      const path = resolvePath(req);
      if (path === null) {
        res.status(400).json({ error: `invalid path parameters for ${routePath}` });
        return;
      }
      try {
        const parsed = await getGroupMembership(ctx, path);
        res.json({ dca: parsed.dca, mutegroups: parsed.mutegroups });
      } catch (err) {
        res.status(502).json({ error: String(err) });
      }
    });

    router.post(`${routePath}/toggle`, express.json(), async (req: Request, res: Response) => {
      const path = resolvePath(req);
      if (path === null) {
        res.status(400).json({ error: `invalid path parameters for ${routePath}` });
        return;
      }
      const { kind, index, on } = (req.body ?? {}) as { kind?: unknown; index?: unknown; on?: unknown };
      if (kind !== "dca" && kind !== "mutegroup") {
        res.status(400).json({ error: "kind must be 'dca' or 'mutegroup'" });
        return;
      }
      try {
        const parsed = await setGroupMembership(ctx, path, kind, Number(index), Boolean(on));
        res.json({ dca: parsed.dca, mutegroups: parsed.mutegroups, ack: { status: "OK", ok: true, raw: "OK" } });
      } catch (err) {
        if (err instanceof WingValueError) {
          res.status(422).json({ error: err.message });
          return;
        }
        res.status(502).json({ error: String(err) });
      }
    });
  }

  registerGroupsRoutes("/channels/:index/groups", (req) => {
    const n = channelIndexOrNull(req);
    return n === null ? null : channelPath(n);
  });

  registerGroupsRoutes("/aux/:index/groups", (req) => {
    const n = auxIndexOrNull(req);
    return n === null ? null : auxPath(n);
  });

  registerGroupsRoutes("/bus/:index/groups", (req) => {
    const n = Number(req.params.index);
    return Number.isInteger(n) && n >= 1 && n <= BUS_COUNT ? busPath(n) : null;
  });

  registerGroupsRoutes("/main/:index/groups", (req) => {
    const n = Number(req.params.index);
    return Number.isInteger(n) && n >= 1 && n <= MAIN_COUNT ? mainPath(n) : null;
  });

  registerGroupsRoutes("/mtx/:index/groups", (req) => {
    const n = Number(req.params.index);
    return Number.isInteger(n) && n >= 1 && n <= MATRIX_COUNT ? matrixPath(n) : null;
  });

  /**
   * Generic path-based value memory — business logic lives in wing-value-memory.ts, shared with the
   * `wing_store_value`/`wing_restore_value`/`wing_adjust_value_by_delta`/`wing_undo_last_adjust` MCP
   * tools (see tools/value-memory.ts). No new OSC capability — a pure client-side layer over
   * already-readable/writable leaves, same "arbitrary path" shape as `wing_get`/`wing_set`.
   */
  router.post("/value-memory/store", express.json(), async (req: Request, res: Response) => {
    const { path } = (req.body ?? {}) as { path?: unknown };
    if (typeof path !== "string") {
      res.status(400).json({ error: "`path` must be a string" });
      return;
    }
    try {
      res.json(await storeValue(ctx, path));
    } catch (err) {
      if (err instanceof WingValueError) {
        res.status(422).json({ error: err.message });
        return;
      }
      res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/value-memory/restore", express.json(), async (req: Request, res: Response) => {
    const { path } = (req.body ?? {}) as { path?: unknown };
    if (typeof path !== "string") {
      res.status(400).json({ error: "`path` must be a string" });
      return;
    }
    try {
      res.json(await restoreValue(ctx, path));
    } catch (err) {
      if (err instanceof WingValueError) {
        res.status(422).json({ error: err.message });
        return;
      }
      res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/value-memory/adjust", express.json(), async (req: Request, res: Response) => {
    const { path, delta } = (req.body ?? {}) as { path?: unknown; delta?: unknown };
    if (typeof path !== "string" || typeof delta !== "number") {
      res.status(400).json({ error: "body must include `path` (string) and `delta` (number)" });
      return;
    }
    try {
      res.json(await adjustValueByDelta(ctx, path, delta));
    } catch (err) {
      if (err instanceof WingValueError) {
        res.status(422).json({ error: err.message });
        return;
      }
      res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/value-memory/undo", express.json(), async (req: Request, res: Response) => {
    const { path } = (req.body ?? {}) as { path?: unknown };
    if (typeof path !== "string") {
      res.status(400).json({ error: "`path` must be a string" });
      return;
    }
    try {
      res.json(await undoLastAdjust(ctx, path));
    } catch (err) {
      if (err instanceof WingValueError) {
        res.status(422).json({ error: err.message });
        return;
      }
      res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  interface FadeRequestBody {
    path: string;
    durationMs: number;
    direction: "in" | "out";
    /** Absolute target in dB — takes precedence over `deltaDb` if both are somehow sent. */
    to?: number;
    /** Relative target: resolves to (value read at fade start) + deltaDb. */
    deltaDb?: number;
    /** Progress-shaping curve, default "linear" — see wing-easing.ts. */
    easing?: string;
  }

  /** Thin HTTP wrapper around the shared fade engine (also used by the `wing_fade` MCP tool) —
   * see wing-fade.ts for the actual ramp logic. */
  router.post("/fade", express.json(), async (req: Request, res: Response) => {
    const body = req.body as Partial<FadeRequestBody>;
    if (typeof body.path !== "string" || typeof body.durationMs !== "number" || (body.direction !== "in" && body.direction !== "out")) {
      res.status(400).json({ error: "expected { path: string, durationMs: number, direction: 'in' | 'out' }" });
      return;
    }
    try {
      if (body.easing !== undefined) requireEasingName(body.easing);
      const result = await startFade(ctx, {
        path: body.path,
        durationMs: body.durationMs,
        direction: body.direction,
        to: body.to,
        deltaDb: body.deltaDb,
        easing: body.easing,
      });
      res.json({ status: "started", ...result });
    } catch (err) {
      if (err instanceof WingValueError) {
        res.status(422).json({ error: err.message });
        return;
      }
      res.status(502).json({ error: `Failed to start fade on ${body.path}: ${String(err)}` });
    }
  });

  /** Stops an in-progress fade on `path`, leaving the fader wherever it currently is rather than
   * snapping to either end. No-op (still 200) if nothing is fading on that path. */
  router.post("/fade/cancel", express.json(), (req: Request, res: Response) => {
    const { path } = req.body as { path?: string };
    if (typeof path !== "string") {
      res.status(400).json({ error: "expected { path: string }" });
      return;
    }
    cancelFade(path);
    res.json({ status: "cancelled", path });
  });

  /**
   * Generic single-leaf set (mirrors the `wing_set` MCP tool) — the write
   * primitive behind every fader/mute/pan control in the Mixer tab. `splitLeafPath`
   * is imported (not duplicated) from the tools layer since it's a tiny pure
   * string helper, not business logic — unlike the scene-list parser above,
   * keeping two copies of this in sync would be pure downside with no
   * decoupling benefit.
   */
  router.post("/set", express.json(), async (req: Request, res: Response) => {
    const { path, value } = req.body as { path?: unknown; value?: unknown };
    if (typeof path !== "string" || !path.startsWith("/")) {
      res.status(400).json({ error: "path must be a string starting with /" });
      return;
    }
    if (typeof value !== "number" && typeof value !== "string") {
      res.status(400).json({ error: "value must be a number or a string" });
      return;
    }
    try {
      const validatedValue = validateNodeValue(path, value);
      const { baseNode, key } = splitLeafPath(path);
      const ack = await ctx.client.bulkSet(baseNode, { [key]: validatedValue });
      res.json(ack);
    } catch (err) {
      if (err instanceof WingValueError) {
        res.status(422).json({ error: err.message });
        return;
      }
      res.status(502).json({ error: String(err) });
    }
  });

  /** Generic multi-key set on one node (mirrors `wing_bulk_set`) — used by the Routing sub-tab (on/lvl/pan in one ACK'd call). */
  router.post("/bulk-set", express.json(), async (req: Request, res: Response) => {
    const { baseNode, assignments } = req.body as { baseNode?: unknown; assignments?: unknown };
    if (typeof baseNode !== "string" || !baseNode.startsWith("/")) {
      res.status(400).json({ error: "baseNode must be a string starting with /" });
      return;
    }
    if (typeof assignments !== "object" || assignments === null || Array.isArray(assignments)) {
      res.status(400).json({ error: "assignments must be an object of key -> number|string" });
      return;
    }
    const badKey = Object.entries(assignments as Record<string, unknown>).find(([, v]) => typeof v !== "number" && typeof v !== "string");
    if (badKey) {
      res.status(400).json({ error: `assignments.${badKey[0]} must be a number or a string` });
      return;
    }
    try {
      const validatedAssignments = Object.fromEntries(
        Object.entries(assignments as Record<string, number | string>).map(([key, value]) => [
          key,
          validateNodeValue(`${baseNode}/${key.replace(/\./g, "/")}`, value),
        ]),
      );
      const ack = await ctx.client.bulkSet(baseNode, validatedAssignments);
      res.json(ack);
    } catch (err) {
      if (err instanceof WingValueError) {
        res.status(422).json({ error: err.message });
        return;
      }
      res.status(502).json({ error: String(err) });
    }
  });
}
