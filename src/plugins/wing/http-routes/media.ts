// USB player/recorder and WING LIVE card transport.
// Part of the dashboard's REST API — see ./index.ts for how the modules are mounted.

import express, { type Request, type Response, type Router } from "express";
import { WingUnavailableError, WingValueError } from "../wing-errors.js";
import {
  getUsbPlayerState,
  runUsbPlayAction,
  runUsbRecordAction,
  setUsbRepeat,
  type UsbPlayAction,
  type UsbRecAction,
} from "../wing-usb-player.js";
import {
  formatWLiveCard,
  getWLiveStatus,
  manageWLiveMarker,
  manageWLiveSession,
  runWLiveTransport,
  type WLiveMarkerAction,
  type WLiveMarkerOptions,
  type WLiveSessionAction,
  type WLiveSessionOptions,
  type WLiveTransportAction,
} from "../wing-live.js";
import type { WingPluginContext } from "../wing-plugin.js";

export function registerMediaRoutes(router: Router, ctx: WingPluginContext): void {
  /**
   * The USB media player/recorder module — business logic lives in wing-usb-player.ts, shared with
   * the `wing_usb_*` MCP tools (see tools/usb-player.ts) so both surfaces call the exact same OSC
   * calls rather than each re-implementing them.
   */
  router.get("/media", async (_req: Request, res: Response) => {
    try {
      res.json(await getUsbPlayerState(ctx));
    } catch (err) {
      if (err instanceof WingUnavailableError) {
        res.status(504).json({ error: err.message });
        return;
      }
      res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/media/play", express.json(), async (req: Request, res: Response) => {
    const { action, file, index } = req.body as { action?: string; file?: string; index?: number };
    try {
      const ack = await runUsbPlayAction(ctx, { action: action as UsbPlayAction, file, index });
      res.json(ack);
    } catch (err) {
      if (err instanceof WingValueError) {
        res.status(422).json({ error: err.message });
        return;
      }
      res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/media/rec", express.json(), async (req: Request, res: Response) => {
    const { action } = req.body as { action?: string };
    try {
      const ack = await runUsbRecordAction(ctx, { action: action as UsbRecAction });
      res.json(ack);
    } catch (err) {
      if (err instanceof WingValueError) {
        res.status(422).json({ error: err.message });
        return;
      }
      res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/media/repeat", express.json(), async (req: Request, res: Response) => {
    const { on } = req.body as { on?: boolean };
    if (typeof on !== "boolean") {
      res.status(422).json({ error: "expected { on: boolean }" });
      return;
    }
    try {
      res.json(await setUsbRepeat(ctx, on));
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * WING Live expansion card — business logic lives in wing-live.ts, shared with the `wing_*wlive*`
   * MCP tools (see tools/wing-live.ts). Not verified against real WING Live hardware — see the doc
   * comment on getWLiveStatus() for how a missing/unreachable card degrades instead of crashing.
   */
  router.get("/wlive/status", async (_req: Request, res: Response) => {
    try {
      res.json(await getWLiveStatus(ctx));
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/wlive/:card/transport", express.json(), async (req: Request, res: Response) => {
    const card = Number(req.params.card);
    const { action } = (req.body ?? {}) as { action?: WLiveTransportAction };
    if (!action) {
      res.status(400).json({ error: "body must include `action`" });
      return;
    }
    try {
      const ack = await runWLiveTransport(ctx, { card, action });
      res.json({ card, action, ...ack });
    } catch (err) {
      if (err instanceof WingValueError) {
        res.status(422).json({ error: err.message });
        return;
      }
      res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/wlive/:card/session", express.json(), async (req: Request, res: Response) => {
    const card = Number(req.params.card);
    const { action, sessionIndex, name } = (req.body ?? {}) as Partial<Omit<WLiveSessionOptions, "card">> & {
      action?: WLiveSessionAction;
    };
    if (!action) {
      res.status(400).json({ error: "body must include `action`" });
      return;
    }
    try {
      const ack = await manageWLiveSession(ctx, { card, action, sessionIndex, name });
      res.json({ card, action, ...ack });
    } catch (err) {
      if (err instanceof WingValueError) {
        res.status(422).json({ error: err.message });
        return;
      }
      res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/wlive/:card/marker", express.json(), async (req: Request, res: Response) => {
    const card = Number(req.params.card);
    const { action, markerIndex, timeMs } = (req.body ?? {}) as Partial<Omit<WLiveMarkerOptions, "card">> & {
      action?: WLiveMarkerAction;
    };
    if (!action) {
      res.status(400).json({ error: "body must include `action`" });
      return;
    }
    try {
      const ack = await manageWLiveMarker(ctx, { card, action, markerIndex, timeMs });
      res.json({ card, action, ...ack });
    } catch (err) {
      if (err instanceof WingValueError) {
        res.status(422).json({ error: err.message });
        return;
      }
      res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/wlive/:card/format", async (req: Request, res: Response) => {
    const card = Number(req.params.card);
    try {
      const ack = await formatWLiveCard(ctx, card);
      res.json({ card, ...ack });
    } catch (err) {
      if (err instanceof WingValueError) {
        res.status(422).json({ error: err.message });
        return;
      }
      res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
