import express, { type Request, type Response, type Router } from "express";
import { discoverWingConsoles } from "./wing-discovery.js";
import {
  AUX_COUNT,
  BUS_COUNT,
  CHANNEL_COUNT,
  DCA_COUNT,
  FX_COUNT,
  MAIN_COUNT,
  MATRIX_COUNT,
  MUTEGROUP_COUNT,
  auxPath,
  busPath,
  channelPath,
  dcaPath,
  fxPath,
  ioInPath,
  ioOutPath,
  mainPath,
  matrixPath,
  mutegroupPath,
  resolveBusMainMatrixPath,
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
} from "./wing-node-paths.js";
import { splitLeafPath } from "./tools/generic.js";
import {
  type AutoGainMode,
  type AutoGainOptions,
  GAIN_FALLBACK_RANGE,
  runAutoGain,
  runCombinedAutoGain,
} from "./wing-autogain.js";
import { type AutoCompressBlock, type AutoCompressOptions, runAutoCompress } from "./wing-auto-compress.js";
import { type AutoGateBlock, type AutoGateOptions, runAutoGate } from "./wing-auto-gate.js";
import { WingUnavailableError, WingValueError } from "./wing-errors.js";
import {
  getInsertStatus,
  setInsert,
  type InsertSlot,
  type InsertStripType,
  type SetInsertOptions,
} from "./wing-insert.js";
import {
  getProcessingBlockOn,
  setProcessingBlockOn,
  type ProcessingBlock,
  type ProcessingToggleType,
} from "./wing-processing-toggle.js";
import { getProcOrder, setProcOrder } from "./wing-proc-order.js";
import {
  getGlobalAltSwitch,
  getInputPatch,
  setAltSourceActive,
  setGlobalAltSwitch,
  setInputConnection,
  type InputPatchStripType,
  type InputSlot,
} from "./wing-input-patch.js";
import {
  getUsbPlayerState,
  runUsbPlayAction,
  runUsbRecordAction,
  setUsbRepeat,
  type UsbPlayAction,
  type UsbRecAction,
} from "./wing-usb-player.js";
import { cancelFade, startFade } from "./wing-fade.js";
import { parseGroupTags, toggleGroupTag } from "./wing-group-tags.js";
import {
  decodeRtaSourceIndex,
  encodeRtaSource,
  RTA_SOURCE_PATH,
  RTA_SOURCE_TYPES,
  RTA_TAP_PATH,
  type RtaSourceType,
} from "./wing-rta-source.js";
import { parseWingDescribeNumber, parseWingDescribeParams, type WingDescribeParam } from "./wing-value-codec.js";
import type { WingPluginContext } from "./wing-plugin.js";
import {
  performPresetDelete,
  performPresetLoad,
  performPresetSave,
  summarizeSlot,
  type PresetSectionKey,
} from "./wing-preset-engine.js";
import { STRIP_TYPES, type StripType } from "./wing-node-paths.js";

/** Number formatting helper for values pulled out of a `dump()` flat map. */
function asNumber(value: string | number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

interface ChannelStrip {
  index: number;
  name: string;
  fader: number;
  muted: boolean;
  pan: number;
}

interface StageStrip {
  index: number;
  name: string;
  fader: number;
  muted: boolean;
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

export function registerWingHttpRoutes(router: Router, ctx: WingPluginContext): void {
  router.get("/discover", async (_req: Request, res: Response) => {
    try {
      const config = ctx.getConfig();
      const results = await discoverWingConsoles({ port: config.discoveryPort });
      res.json(results);
    } catch (err) {
      res.status(502).json({ error: String(err) });
    }
  });

  router.get("/state", (_req: Request, res: Response) => {
    try {
      res.json(ctx.cache.snapshotChannels());
    } catch (err) {
      res.status(502).json({ error: String(err) });
    }
  });

  /** One-shot snapshot mirroring the `wing_get_rta` MCP tool — the live view (Meters tab) instead
   * reads RTA frames off the "meters" SSE stream, since RTA is a push-only 20Hz feed with no
   * request/response primitive to poll on demand. */
  router.get("/rta", (_req: Request, res: Response) => {
    const snapshot = ctx.getLastRta();
    if (!snapshot) {
      res.json({ available: false });
      return;
    }
    res.json({ available: true, bandsDb: snapshot.bandsDb, receivedAt: snapshot.receivedAt, ageMs: Date.now() - snapshot.receivedAt });
  });

  /** Mirrors the `wing_get_rta_source`/`wing_set_rta_source` MCP tools — see wing-rta-source.ts for
   * the (inferred, not officially documented) rtasrc index mapping. */
  router.get("/rta/source", async (_req: Request, res: Response) => {
    try {
      const [srcResult, tapResult] = await Promise.all([ctx.client.get(RTA_SOURCE_PATH), ctx.client.get(RTA_TAP_PATH)]);
      const rawIndex = srcResult.kind === "leaf" ? Number(srcResult.value) : NaN;
      const tap = tapResult.kind === "leaf" ? String(tapResult.value) : null;
      res.json({ rawIndex, source: Number.isFinite(rawIndex) ? decodeRtaSourceIndex(rawIndex) : null, tap });
    } catch (err) {
      res.status(502).json({ error: String(err) });
    }
  });

  router.post("/rta/source", express.json(), async (req: Request, res: Response) => {
    const { type, index, tap } = req.body as { type?: string; index?: number; tap?: string };
    if (!RTA_SOURCE_TYPES.includes(type as RtaSourceType) || typeof index !== "number") {
      res.status(400).json({ error: `expected { type: one of ${RTA_SOURCE_TYPES.join(", ")}, index: number, tap?: string }` });
      return;
    }
    try {
      const rawIndex = encodeRtaSource({ type: type as RtaSourceType, index });
      const assignments: Record<string, number | string> = { rtasrc: rawIndex };
      if (tap) assignments.rtatap = tap;
      const ack = await ctx.client.bulkSet("/cfg/rta", assignments);
      res.json({ type, index, rawIndex, tap: tap ?? null, ...ack });
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

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

    async function dumpStrip<T>(path: string, build: (entries: Record<string, string | number>) => T): Promise<T | null> {
      try {
        const entries = await ctx.client.dump(path);
        return build(entries);
      } catch {
        return null;
      }
    }

    function channelStrip(n: number, e: Record<string, string | number>): ChannelStrip {
      return { index: n, name: String(e.name ?? ""), fader: asNumber(e.fdr, -144), muted: asNumber(e.mute, 0) === 1, pan: asNumber(e.pan, 0) };
    }

    function stageStrip(n: number, e: Record<string, string | number>): StageStrip {
      return { index: n, name: String(e.name ?? ""), fader: asNumber(e.fdr, -144), muted: asNumber(e.mute, 0) === 1 };
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

    const budget = new Promise<"timeout">((resolve) => {
      const timer = setTimeout(() => resolve("timeout"), MIXER_STATE_BUDGET_MS);
      timer.unref?.();
    });

    const result = await Promise.race([loadAll, budget]);
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
  async function readBusMtxSend(path: string, index: number): Promise<BusMtxSendState | null> {
    try {
      const entries = await ctx.client.dump(path);
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

  async function readMainSend(path: string, index: number): Promise<MainSendState | null> {
    try {
      const entries = await ctx.client.dump(path);
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
    const loadAll = Promise.all([
      Promise.all(Array.from({ length: BUS_COUNT }, (_, i) => i + 1).map((n) => readBusMtxSend(busPathFn(n), n))),
      Promise.all(Array.from({ length: MATRIX_COUNT }, (_, i) => i + 1).map((n) => readBusMtxSend(mtxPathFn(n), n))),
      Promise.all(Array.from({ length: MAIN_COUNT }, (_, i) => i + 1).map((n) => readMainSend(mainPathFn(n), n))),
    ]);
    const budget = new Promise<"timeout">((resolve) => {
      const timer = setTimeout(() => resolve("timeout"), SENDS_BUDGET_MS);
      timer.unref?.();
    });

    const result = await Promise.race([loadAll, budget]);
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
      res.status(400).json({ error: `channel index out of range: ${req.params.index}` });
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
      res.status(400).json({ error: `aux index out of range: ${req.params.index}` });
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
      res.status(400).json({ error: `bus index out of range: ${req.params.index}` });
      return;
    }
    const BUS_SENDS_BUDGET_MS = 5000;
    const loadAll = Promise.all([
      Promise.all(
        Array.from({ length: BUS_COUNT }, (_, i) => i + 1)
          .filter((n) => n !== bus)
          .map((n) => readMainSend(sendBusToBusPath(bus, n), n)),
      ),
      Promise.all(Array.from({ length: MATRIX_COUNT }, (_, i) => i + 1).map((n) => readMainSend(sendBusToMatrixPath(bus, n), n))),
      Promise.all(Array.from({ length: MAIN_COUNT }, (_, i) => i + 1).map((n) => readMainSend(sendBusToMainPath(bus, n), n))),
    ]);
    const budget = new Promise<"timeout">((resolve) => {
      const timer = setTimeout(() => resolve("timeout"), BUS_SENDS_BUDGET_MS);
      timer.unref?.();
    });
    const result = await Promise.race([loadAll, budget]);
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
      res.status(400).json({ error: `main index out of range: ${req.params.index}` });
      return;
    }
    const MAIN_SENDS_BUDGET_MS = 3000;
    const loadAll = Promise.all(Array.from({ length: MATRIX_COUNT }, (_, i) => i + 1).map((n) => readMainSend(sendMainToMatrixPath(main, n), n)));
    const budget = new Promise<"timeout">((resolve) => {
      const timer = setTimeout(() => resolve("timeout"), MAIN_SENDS_BUDGET_MS);
      timer.unref?.();
    });
    const result = await Promise.race([loadAll, budget]);
    if (result === "timeout") {
      res.status(504).json({ error: "Timed out loading this main's sends from the console." });
      return;
    }
    res.json({ mtx: result.filter((s): s is MainSendState => s !== null) });
  });

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
      res.status(400).json({ error: `channel index out of range: ${req.params.index}` });
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
      res.status(400).json({ error: `channel index out of range: ${req.params.index}` });
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

  function auxIndexOrNull(req: Request): number | null {
    const n = Number(req.params.index);
    return Number.isInteger(n) && n >= 1 && n <= AUX_COUNT ? n : null;
  }

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
   * Physical I/O group name, as returned live by `GET /io/in` / `GET /io/out` (LCL, AUX, A, B, C,
   * SC, USB, CRD, MOD, PLAY, AES, USR, OSC, or a "$"-prefixed internal tap group). Validated against
   * a permissive charset rather than a hardcoded list, since group availability varies by console
   * model — an unknown group simply gets a timeout/VALUE ERROR from the console itself.
   */
  function ioGroupOrNull(req: Request): string | null {
    const group = req.params.group;
    return typeof group === "string" && /^\$?[A-Za-z0-9]+$/.test(group) ? group : null;
  }

  function ioIndexOrNull(req: Request): number | null {
    const n = Number(req.params.index);
    return Number.isInteger(n) && n >= 1 ? n : null;
  }

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

  /**
   * Lists every physical I/O group and its real per-group channel count (LCL has 24 inputs on a
   * WING Rack, AES has 2, AES50 ports A/B/C have 48 each, etc. — verified to vary a lot, so this is
   * discovered live rather than hardcoded). "$"-prefixed groups under /io/in (the internal
   * BUS/MAIN/MTX/SEND/MON taps) are excluded from the input listing: they aren't physical inputs
   * with gain/phantom/name properties, just index ranges selectable via a channel's in/conn.grp.
   */
  router.get("/io", async (_req: Request, res: Response) => {
    async function listGroups(base: "/io/in" | "/io/out"): Promise<Array<{ group: string; count: number }>> {
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

  function channelIndexOrNull(req: Request): number | null {
    const n = Number(req.params.index);
    return Number.isInteger(n) && n >= 1 && n <= CHANNEL_COUNT ? n : null;
  }

  function stripPathOrNull(req: Request, suffix: string): string | null {
    const type = req.params.type;
    if (type !== "bus" && type !== "main" && type !== "mtx") {
      return null;
    }
    const n = Number(req.params.index);
    if (!Number.isInteger(n)) {
      return null;
    }
    try {
      return resolveBusMainMatrixPath(type, n, suffix);
    } catch {
      return null;
    }
  }

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
      res.status(400).json({ error: `channel index out of range: ${req.params.index}` });
      return;
    }
    await respondCombinedAutoGain(res, "channel", channel, req);
  });

  router.post("/aux/:index/autogain", express.json(), async (req: Request, res: Response) => {
    const aux = auxIndexOrNull(req);
    if (aux === null) {
      res.status(400).json({ error: `aux index out of range: ${req.params.index}` });
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
  ): Pick<AutoCompressOptions, "thresholdDb" | "targetReductionDb" | "targetMode" | "maxIterations" | "ratio" | "sampleMs"> {
    const body = req.body as
      | {
          thresholdDb?: number;
          targetReductionDb?: number;
          targetMode?: unknown;
          maxIterations?: number;
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
   * Physical input patch (Main/Alt) — business logic lives in wing-input-patch.ts, shared with the
   * `wing_get_input_patch`/`wing_set_input_connection`/`wing_set_alt_source_active` MCP tools (see
   * tools/input-patch.ts). Channel/aux only — `type` is fixed by which route matched rather than
   * accepted as a body field, so there's no need to validate an arbitrary `type` string here.
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
  async function getTags(basePath: string): Promise<string> {
    const result = await ctx.client.get(`${basePath}/tags`);
    return result.kind === "leaf" ? String(result.value) : "";
  }

  function registerGroupsRoutes(routePath: string, resolvePath: (req: Request) => string | null): void {
    router.get(routePath, async (req: Request, res: Response) => {
      const path = resolvePath(req);
      if (path === null) {
        res.status(400).json({ error: `invalid path parameters for ${routePath}` });
        return;
      }
      try {
        const parsed = parseGroupTags(await getTags(path));
        res.json({ dca: parsed.dca, mutegroups: parsed.mutegroups });
      } catch (err) {
        res.status(504).json({ error: String(err) });
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
      const groupIndex = Number(index);
      const maxIndex = kind === "dca" ? DCA_COUNT : MUTEGROUP_COUNT;
      if (!Number.isInteger(groupIndex) || groupIndex < 1 || groupIndex > maxIndex) {
        res.status(400).json({ error: `${kind} index out of range: ${String(index)}` });
        return;
      }
      try {
        const currentTags = await getTags(path);
        const nextTags = toggleGroupTag(currentTags, kind, groupIndex, Boolean(on));
        if (nextTags === null) {
          res.status(400).json({ error: "This would exceed the console's 80-character tags field — remove another tag first." });
          return;
        }
        await ctx.client.set(`${path}/tags`, nextTags);
        const confirmedTags = await getTags(path);
        if (confirmedTags !== nextTags) {
          res
            .status(502)
            .json({ error: `The console didn't accept the new tags value (expected ${JSON.stringify(nextTags)}, read back ${JSON.stringify(confirmedTags)}).` });
          return;
        }
        const parsed = parseGroupTags(confirmedTags);
        res.json({ dca: parsed.dca, mutegroups: parsed.mutegroups, ack: { status: "OK", ok: true, raw: "OK" } });
      } catch (err) {
        res.status(504).json({ error: String(err) });
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
    async function matches(path: string): Promise<boolean> {
      try {
        const dump = await ctx.client.dump(path);
        return dump.grp === group && Number(dump.in) === n;
      } catch {
        return false;
      }
    }
    const ROUTED_LOOKUP_BUDGET_MS = 8000;
    const loadAll = Promise.all([
      Promise.all(Array.from({ length: CHANNEL_COUNT }, (_, i) => i + 1).map(async (i) => ((await matches(channelPath(i, "in/conn"))) ? i : null))),
      Promise.all(Array.from({ length: AUX_COUNT }, (_, i) => i + 1).map(async (i) => ((await matches(auxPath(i, "in/conn"))) ? i : null))),
    ]);
    const budget = new Promise<"timeout">((resolve) => {
      const timer = setTimeout(() => resolve("timeout"), ROUTED_LOOKUP_BUDGET_MS);
      timer.unref?.();
    });
    const result = await Promise.race([loadAll, budget]);
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

  interface FadeRequestBody {
    path: string;
    durationMs: number;
    direction: "in" | "out";
    /** Absolute target in dB — takes precedence over `deltaDb` if both are somehow sent. */
    to?: number;
    /** Relative target: resolves to (value read at fade start) + deltaDb. */
    deltaDb?: number;
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
      const result = await startFade(ctx, {
        path: body.path,
        durationMs: body.durationMs,
        direction: body.direction,
        to: body.to,
        deltaDb: body.deltaDb,
      });
      res.json({ status: "started", ...result });
    } catch (err) {
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
    try {
      const { path, value } = req.body as { path: string; value: number | string };
      const { baseNode, key } = splitLeafPath(path);
      const ack = await ctx.client.bulkSet(baseNode, { [key]: value });
      res.json(ack);
    } catch (err) {
      res.status(502).json({ error: String(err) });
    }
  });

  /** Generic multi-key set on one node (mirrors `wing_bulk_set`) — used by the Routing sub-tab (on/lvl/pan in one ACK'd call). */
  router.post("/bulk-set", express.json(), async (req: Request, res: Response) => {
    try {
      const { baseNode, assignments } = req.body as { baseNode: string; assignments: Record<string, number | string> };
      const ack = await ctx.client.bulkSet(baseNode, assignments);
      res.json(ack);
    } catch (err) {
      res.status(502).json({ error: String(err) });
    }
  });

  /**
   * Verified against real hardware: describing the *leaf* "/$ctl/lib/$scenes" directly never
   * replies (neither "?" nor "#") — that dead end is what led to the earlier, wrong conclusion that
   * WING has no way to enumerate scenes over OSC. Describing the *parent branch* "/$ctl/lib"
   * instead works, and its reply's inline enum for the $scenes field IS the full scene list in
   * order (e.g. "$scenes list [entree-epoux, AMI REPET, AMI INSTALL, AMI]"), with array position
   * matching $actidx. parseWingDescribeParams (already used for EQ/Gate/Dynamics/FX panels) parses
   * this the same way, since it's the same describe-line format.
   */
  router.get("/scenes", async (_req: Request, res: Response) => {
    const [libDescription, actIdx, active, actShow, activeId] = await Promise.all([
      ctx.client.describe("/$ctl/lib").catch(() => null),
      ctx.client.get("/$ctl/lib/$actidx").catch(() => null),
      ctx.client.get("/$ctl/lib/$active").catch(() => null),
      ctx.client.get("/$ctl/lib/$actshow").catch(() => null),
      ctx.client.get("/$ctl/lib/$activeid").catch(() => null),
    ]);

    if (actIdx === null && active === null && actShow === null && activeId === null) {
      res.status(502).json({ error: "Failed to reach the console for scene/library state." });
      return;
    }

    const scenesParam = libDescription ? parseWingDescribeParams(libDescription.lines).find((p) => p.key === "$scenes") : undefined;
    const scenes = (scenesParam?.options ?? []).map((name, index) => ({ index, name }));

    res.json({
      scenes,
      current: {
        index: actIdx?.kind === "leaf" ? Number(actIdx.value) : null,
        name: active?.kind === "leaf" ? String(active.value) : "",
        show: actShow?.kind === "leaf" ? String(actShow.value) : "",
        tagId: activeId?.kind === "leaf" ? Number(activeId.value) : null,
      },
    });
  });

  router.post("/scenes/step", express.json(), async (req: Request, res: Response) => {
    const { direction } = req.body as { direction?: "next" | "prev" };
    if (direction !== "next" && direction !== "prev") {
      res.status(400).json({ error: "expected { direction: 'next' | 'prev' }" });
      return;
    }
    try {
      const ack = await ctx.client.bulkSet("/$ctl/lib", { $action: direction === "next" ? "NEXT" : "PREV" });
      res.json(ack);
    } catch (err) {
      res.status(502).json({ error: String(err) });
    }
  });

  router.post("/scenes/recall", express.json(), async (req: Request, res: Response) => {
    try {
      const { target, byTag } = req.body as { target: number | string; byTag?: boolean };
      const ack = await ctx.client.bulkSet("/$ctl/lib", {
        $actionidx: target,
        $action: byTag ? "GOTAG" : "GO",
      });
      res.json(ack);
    } catch (err) {
      res.status(502).json({ error: String(err) });
    }
  });

  // Presets: thin REST wrappers around the same performPresetSave/Load/Delete orchestration used by
  // the wing_preset_* MCP tools (tools/presets.ts), so the dashboard and an LLM client behave
  // identically — same split already used by wing-autogain.ts's runCombinedAutoGain.
  const sendPresetError = (res: Response, err: unknown): void => {
    res.status(err instanceof WingValueError ? 400 : 502).json({ error: err instanceof Error ? err.message : String(err) });
  };

  router.get("/presets", async (_req: Request, res: Response) => {
    try {
      res.json({ presets: await ctx.presetStore.list() });
    } catch (err) {
      sendPresetError(res, err);
    }
  });

  router.get("/presets/:name", async (req: Request, res: Response) => {
    try {
      const file = await ctx.presetStore.get(String(req.params.name));
      if (!file) {
        res.status(404).json({ error: `No preset named "${req.params.name}" exists.` });
        return;
      }
      res.json({
        name: file.name,
        type: file.type,
        createdAt: file.createdAt,
        updatedAt: file.updatedAt,
        slots: file.slots.map(summarizeSlot),
      });
    } catch (err) {
      sendPresetError(res, err);
    }
  });

  router.post("/presets", express.json(), async (req: Request, res: Response) => {
    try {
      const { name, type, indices, overwrite } = req.body as {
        name?: string;
        type?: StripType;
        indices?: number[];
        overwrite?: boolean;
      };
      if (!name || !Array.isArray(indices) || indices.length === 0) {
        res.status(400).json({ error: "expected { name: string, indices: number[], type?, overwrite? }" });
        return;
      }
      if (type !== undefined && !STRIP_TYPES.includes(type)) {
        res.status(400).json({ error: `type must be one of ${STRIP_TYPES.join(", ")}` });
        return;
      }
      const result = await performPresetSave(ctx, { name, type: type ?? "channel", indices, overwrite });
      res.json(result);
    } catch (err) {
      sendPresetError(res, err);
    }
  });

  router.post("/presets/:name/load", express.json(), async (req: Request, res: Response) => {
    try {
      const { targetIndex, targetIndices, sections } = req.body as {
        targetIndex?: number;
        targetIndices?: number[];
        sections?: PresetSectionKey[];
      };
      const result = await performPresetLoad(ctx, { name: String(req.params.name), targetIndex, targetIndices, sections });
      res.json(result);
    } catch (err) {
      sendPresetError(res, err);
    }
  });

  router.delete("/presets/:name", async (req: Request, res: Response) => {
    try {
      const result = await performPresetDelete(ctx, String(req.params.name));
      res.json(result);
    } catch (err) {
      sendPresetError(res, err);
    }
  });
}
