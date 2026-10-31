// The bridge: tablets and OSC apps connected through this server, and the strips they may not
// change. Same logic as the wing_bridge_* tools (wing-bridge.ts), persisted the same way.
// Part of the dashboard's REST API — see ./index.ts for how the modules are mounted.

import express, { type Request, type Response, type Router } from "express";
import {
  BRIDGE_CONFIGURE_SHAPE,
  BRIDGE_PROFILES_SHAPE,
  BRIDGE_SAFES_SHAPE,
  configureBridge,
  setBridgeProfiles,
  setBridgeSafes,
  type BridgeProfilesMode,
  type BridgeSafesMode,
  type BridgeStatus,
} from "../wing-bridge.js";
import { BridgeProfileSchema } from "../wing-config.js";
import { WingValueError } from "../wing-errors.js";
import type { WingPluginContext } from "../wing-plugin.js";
import { parseBodyOr400 } from "./shared.js";

async function respond(res: Response, run: () => Promise<BridgeStatus>): Promise<void> {
  try {
    res.json(await run());
  } catch (err) {
    res.status(err instanceof WingValueError ? 422 : 502).json({ error: err instanceof Error ? err.message : String(err) });
  }
}

export function registerBridgeRoutes(router: Router, ctx: WingPluginContext): void {
  router.get("/bridge", (_req: Request, res: Response) => {
    res.json(ctx.bridge.getStatus());
  });

  router.post("/bridge", express.json(), async (req: Request, res: Response) => {
    const body = parseBodyOr400(BRIDGE_CONFIGURE_SHAPE, req, res);
    if (!body) return;
    await respond(res, () => configureBridge(ctx, body));
  });

  /** PUT replaces the whole set (kinds left out are cleared); POST adds or removes, per `mode`. */
  const safesRoute = (defaultMode: BridgeSafesMode) => async (req: Request, res: Response) => {
    const body = parseBodyOr400(BRIDGE_SAFES_SHAPE, req, res);
    if (!body) return;
    const { mode, ...change } = body;
    await respond(res, () => setBridgeSafes(ctx, mode ?? defaultMode, change));
  };
  router.put("/bridge/safes", express.json(), safesRoute("replace"));
  router.post("/bridge/safes", express.json(), safesRoute("add"));

  /** Device profiles: PUT replaces the list (or applies `mode`), POST adds or updates one, DELETE removes one. */
  router.put("/bridge/profiles", express.json(), async (req: Request, res: Response) => {
    const body = parseBodyOr400(BRIDGE_PROFILES_SHAPE, req, res);
    if (!body) return;
    await respond(res, () => setBridgeProfiles(ctx, (body.mode ?? "replace") as BridgeProfilesMode, body.profiles, body.ids));
  });
  router.post("/bridge/profiles", express.json(), async (req: Request, res: Response) => {
    const parsed = BridgeProfileSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues.map((i) => `${i.path.join(".") || "profile"}: ${i.message}`).join("; ") });
      return;
    }
    await respond(res, () => setBridgeProfiles(ctx, "upsert", [parsed.data]));
  });
  router.delete("/bridge/profiles/:id", async (req: Request, res: Response) => {
    await respond(res, () => setBridgeProfiles(ctx, "remove", undefined, [String(req.params.id)]));
  });
}
