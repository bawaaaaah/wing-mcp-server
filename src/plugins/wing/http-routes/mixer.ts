// The Mixer tab's bulk loads: the whole mixer state, and a strip's sends.
// Part of the dashboard's REST API — see ./index.ts for how the modules are mounted.

import type { Request, Response, Router } from "express";
import {
  AUX_COUNT,
  BUS_COUNT,
  CHANNEL_COUNT,
  DCA_COUNT,
  MAIN_COUNT,
  MATRIX_COUNT,
  MUTEGROUP_COUNT,
  auxPath,
  busPath,
  channelPath,
  dcaPath,
  mainPath,
  matrixPath,
  mutegroupPath,
  sendBusToBusPath,
  sendBusToMainPath,
  sendBusToMatrixPath,
  sendMainToMatrixPath,
  sendToAuxBusPath,
  sendToAuxMainPath,
  sendToAuxMatrixPath,
  sendToBusPath,
  sendToMainPath,
  sendToMatrixPath,
} from "../wing-node-paths.js";
import type { WingPluginContext } from "../wing-plugin.js";
import { boundedReads, type BoundedReads } from "../wing-read-budget.js";
import { asNumber } from "./shared.js";

interface ChannelStrip {
  index: number;
  name: string;
  fader: number;
  muted: boolean;
  pan: number;
  col: number;
  icon: number;
  /** `clink` — whether this strip's name/customization is linked to its physical source. */
  srcAuto: boolean;
}

interface StageStrip {
  index: number;
  name: string;
  fader: number;
  muted: boolean;
  col: number;
  icon: number;
}

/** A channel's send to a bus or matrix — these two destinations share the same node shape. */
interface BusMtxSendState {
  index: number;
  on: boolean;
  levelDb: number;
  /** PRE/POST/GRP — verified against real hardware; the protocol reference's channel-to-main "pre" boolean does not apply here. */
  mode: string;
  pan: number;
}

/** A channel's send to a main — verified against real hardware to have neither `pan` nor `mode`, just a pre/post boolean. */
interface MainSendState {
  index: number;
  on: boolean;
  levelDb: number;
  pre: boolean;
}

export function registerMixerRoutes(router: Router, ctx: WingPluginContext): void {
  /**
   * Full live-mixing snapshot: one `dump()` per channel/bus/main/matrix/dca/
   * mutegroup index (each dump returns that strip's entire flat state in a
   * single request, so this is ~92 requests total rather than one per
   * field). Bounded by an overall budget so a slow/unreachable console
   * degrades to a partial (or empty) snapshot instead of hanging the
   * request for minutes — the dashboard's live "param-change" SSE stream
   * fills in anything missed after this initial load.
   */
  router.get("/mixer-state", async (_req: Request, res: Response) => {
    const MIXER_STATE_BUDGET_MS = 8000;
    const reads = boundedReads(MIXER_STATE_BUDGET_MS);

    async function dumpStrip<T>(path: string, build: (entries: Record<string, string | number>) => T): Promise<T | null> {
      try {
        const entries = await reads.run(() => ctx.client.dump(path));
        return build(entries);
      } catch {
        return null;
      }
    }

    function channelStrip(n: number, e: Record<string, string | number>): ChannelStrip {
      return {
        index: n,
        name: String(e.name ?? ""),
        fader: asNumber(e.fdr, -144),
        muted: asNumber(e.mute, 0) === 1,
        pan: asNumber(e.pan, 0),
        col: asNumber(e.col, 1),
        icon: asNumber(e.icon, 0),
        srcAuto: asNumber(e.clink, 0) === 1,
      };
    }

    function stageStrip(n: number, e: Record<string, string | number>): StageStrip {
      return {
        index: n,
        name: String(e.name ?? ""),
        fader: asNumber(e.fdr, -144),
        muted: asNumber(e.mute, 0) === 1,
        col: asNumber(e.col, 1),
        icon: asNumber(e.icon, 0),
      };
    }

    const loadAll = Promise.all([
      Promise.all(Array.from({ length: CHANNEL_COUNT }, (_, i) => i + 1).map((n) => dumpStrip(channelPath(n), (e) => channelStrip(n, e)))),
      Promise.all(Array.from({ length: AUX_COUNT }, (_, i) => i + 1).map((n) => dumpStrip(auxPath(n), (e) => channelStrip(n, e)))),
      Promise.all(Array.from({ length: BUS_COUNT }, (_, i) => i + 1).map((n) => dumpStrip(busPath(n), (e) => stageStrip(n, e)))),
      Promise.all(Array.from({ length: MAIN_COUNT }, (_, i) => i + 1).map((n) => dumpStrip(mainPath(n), (e) => stageStrip(n, e)))),
      Promise.all(Array.from({ length: MATRIX_COUNT }, (_, i) => i + 1).map((n) => dumpStrip(matrixPath(n), (e) => stageStrip(n, e)))),
      Promise.all(Array.from({ length: DCA_COUNT }, (_, i) => i + 1).map((n) => dumpStrip(dcaPath(n), (e) => stageStrip(n, e)))),
      Promise.all(
        Array.from({ length: MUTEGROUP_COUNT }, (_, i) => i + 1).map((n) =>
          dumpStrip(mutegroupPath(n), (e) => ({ index: n, name: String(e.name ?? ""), muted: asNumber(e.mute, 0) === 1 })),
        ),
      ),
    ]);

    const result = await reads.within(loadAll);
    if (result === "timeout") {
      res.status(504).json({ error: "Timed out loading the full mixer state from the console." });
      return;
    }

    const [channels, auxes, buses, mains, matrices, dcas, mutegroups] = result;
    res.json({
      channels: channels.filter((s): s is ChannelStrip => s !== null),
      auxes: auxes.filter((s): s is ChannelStrip => s !== null),
      buses: buses.filter((s): s is StageStrip => s !== null),
      mains: mains.filter((s): s is StageStrip => s !== null),
      matrices: matrices.filter((s): s is StageStrip => s !== null),
      dcas: dcas.filter((s): s is StageStrip => s !== null),
      mutegroups: mutegroups.filter((s): s is { index: number; name: string; muted: boolean } => s !== null),
    });
  });

  // Verified against real hardware: a channel/aux's send to a bus/matrix carries
  // {on,lvl,pon,mode,plink,pan} (mode = PRE/POST/GRP), while its send to a main carries only
  // {on,lvl,pre} — no pan, and a plain boolean instead of the mode enum. These are genuinely
  // different node shapes, not a formatting quirk. Aux verified to share the exact same shapes.
  async function readBusMtxSend(path: string, index: number, reads: BoundedReads): Promise<BusMtxSendState | null> {
    try {
      const entries = await reads.run(() => ctx.client.dump(path));
      return {
        index,
        on: asNumber(entries.on, 0) === 1,
        levelDb: asNumber(entries.lvl, -144),
        mode: typeof entries.mode === "string" ? entries.mode : "PRE",
        pan: asNumber(entries.pan, 0),
      };
    } catch {
      return null;
    }
  }

  async function readMainSend(path: string, index: number, reads: BoundedReads): Promise<MainSendState | null> {
    try {
      const entries = await reads.run(() => ctx.client.dump(path));
      return { index, on: asNumber(entries.on, 0) === 1, levelDb: asNumber(entries.lvl, -144), pre: asNumber(entries.pre, 0) === 1 };
    } catch {
      return null;
    }
  }

  async function loadSends(
    busPathFn: (n: number) => string,
    mtxPathFn: (n: number) => string,
    mainPathFn: (n: number) => string,
  ): Promise<{ bus: BusMtxSendState[]; mtx: BusMtxSendState[]; main: MainSendState[] } | "timeout"> {
    // Same rationale as /mixer-state: bound the overall wait so a fully unreachable console
    // fails fast (28 sequential dumps at up to 1s each could otherwise take ~28s) rather than
    // hanging the request.
    const SENDS_BUDGET_MS = 5000;
    const reads = boundedReads(SENDS_BUDGET_MS);
    const loadAll = Promise.all([
      Promise.all(Array.from({ length: BUS_COUNT }, (_, i) => i + 1).map((n) => readBusMtxSend(busPathFn(n), n, reads))),
      Promise.all(Array.from({ length: MATRIX_COUNT }, (_, i) => i + 1).map((n) => readBusMtxSend(mtxPathFn(n), n, reads))),
      Promise.all(Array.from({ length: MAIN_COUNT }, (_, i) => i + 1).map((n) => readMainSend(mainPathFn(n), n, reads))),
    ]);

    const result = await reads.within(loadAll);
    if (result === "timeout") return "timeout";
    const [bus, mtx, main] = result;
    return {
      bus: bus.filter((s): s is BusMtxSendState => s !== null),
      mtx: mtx.filter((s): s is BusMtxSendState => s !== null),
      main: main.filter((s): s is MainSendState => s !== null),
    };
  }

  /** A single channel's sends to every bus/matrix/main, for the Routing sub-tab. */
  router.get("/channels/:index/sends", async (req: Request, res: Response) => {
    const channel = Number(req.params.index);
    if (!Number.isInteger(channel) || channel < 1 || channel > CHANNEL_COUNT) {
      res.status(400).json({ error: `channel index out of range: ${String(req.params.index)}` });
      return;
    }
    const result = await loadSends(
      (n) => sendToBusPath(channel, n),
      (n) => sendToMatrixPath(channel, n),
      (n) => sendToMainPath(channel, n),
    );
    if (result === "timeout") {
      res.status(504).json({ error: "Timed out loading this channel's sends from the console." });
      return;
    }
    res.json(result);
  });

  /** Same as above, for an aux — verified against real hardware to share the exact same send shapes. */
  router.get("/aux/:index/sends", async (req: Request, res: Response) => {
    const aux = Number(req.params.index);
    if (!Number.isInteger(aux) || aux < 1 || aux > AUX_COUNT) {
      res.status(400).json({ error: `aux index out of range: ${String(req.params.index)}` });
      return;
    }
    const result = await loadSends(
      (n) => sendToAuxBusPath(aux, n),
      (n) => sendToAuxMatrixPath(aux, n),
      (n) => sendToAuxMainPath(aux, n),
    );
    if (result === "timeout") {
      res.status(504).json({ error: "Timed out loading this aux's sends from the console." });
      return;
    }
    res.json(result);
  });

  /**
   * A bus's sends to every OTHER bus, every matrix, and every main, for the Routing sub-tab —
   * verified against real hardware: bus.md documents send/1..16 (to other buses), send/MX1..8, and
   * main/1..4, so a bus is itself a valid routing *source*, not just a destination. The bus's send
   * to itself is a real node but is ignored by the console's own signal path, so it's excluded here
   * rather than shown as a confusing dead control. Also verified against real hardware: UNLIKE a
   * channel/aux's sends to a bus/matrix, a bus's sends to another bus AND to a matrix both come back
   * with the reduced {on,lvl,pre} shape (no mode/pon/plink/pan) — the same shape as its send to a
   * main — so all three are read with readMainSend here, not readBusMtxSend.
   */
  router.get("/bus/:index/sends", async (req: Request, res: Response) => {
    const bus = Number(req.params.index);
    if (!Number.isInteger(bus) || bus < 1 || bus > BUS_COUNT) {
      res.status(400).json({ error: `bus index out of range: ${String(req.params.index)}` });
      return;
    }
    const BUS_SENDS_BUDGET_MS = 5000;
    const reads = boundedReads(BUS_SENDS_BUDGET_MS);
    const loadAll = Promise.all([
      Promise.all(
        Array.from({ length: BUS_COUNT }, (_, i) => i + 1)
          .filter((n) => n !== bus)
          .map((n) => readMainSend(sendBusToBusPath(bus, n), n, reads)),
      ),
      Promise.all(Array.from({ length: MATRIX_COUNT }, (_, i) => i + 1).map((n) => readMainSend(sendBusToMatrixPath(bus, n), n, reads))),
      Promise.all(Array.from({ length: MAIN_COUNT }, (_, i) => i + 1).map((n) => readMainSend(sendBusToMainPath(bus, n), n, reads))),
    ]);
    const result = await reads.within(loadAll);
    if (result === "timeout") {
      res.status(504).json({ error: "Timed out loading this bus's sends from the console." });
      return;
    }
    const [busSends, mtxSends, mainSends] = result;
    res.json({
      bus: busSends.filter((s): s is MainSendState => s !== null),
      mtx: mtxSends.filter((s): s is MainSendState => s !== null),
      main: mainSends.filter((s): s is MainSendState => s !== null),
    });
  });

  /**
   * A main's sends to every matrix, for the Routing sub-tab — verified against real hardware: a
   * main only has send/MX1..8 (no send-to-main, no send-to-bus at all). Also verified against real
   * hardware that this node's actual shape is {on,lvl,pre} (a plain pre/post boolean, no pan) —
   * *not* the {on,lvl,mode,pon,plink,pan} shape main.md's catalog entry describes; that catalog
   * entry is marked "Approximate — exact values not confirmed against hardware/firmware" and this
   * is exactly such a case, so this reads it with readMainSend rather than readBusMtxSend.
   */
  router.get("/main/:index/sends", async (req: Request, res: Response) => {
    const main = Number(req.params.index);
    if (!Number.isInteger(main) || main < 1 || main > MAIN_COUNT) {
      res.status(400).json({ error: `main index out of range: ${String(req.params.index)}` });
      return;
    }
    const MAIN_SENDS_BUDGET_MS = 3000;
    const reads = boundedReads(MAIN_SENDS_BUDGET_MS);
    const loadAll = Promise.all(
      Array.from({ length: MATRIX_COUNT }, (_, i) => i + 1).map((n) => readMainSend(sendMainToMatrixPath(main, n), n, reads)),
    );
    const result = await reads.within(loadAll);
    if (result === "timeout") {
      res.status(504).json({ error: "Timed out loading this main's sends from the console." });
      return;
    }
    res.json({ mtx: result.filter((s): s is MainSendState => s !== null) });
  });
}
