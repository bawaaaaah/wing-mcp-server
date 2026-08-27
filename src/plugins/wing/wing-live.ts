import { WingValueError } from "./wing-errors.js";
import type { WingBulkSetResult } from "./wing-osc-client.js";
import type { WingPluginContext } from "./wing-plugin.js";

/**
 * The WING Live expansion card: one physical card with two independent SD card slots (numbered 1
 * and 2 in the protocol reference — "2x 32 inputs from one or two SD cards"), each recording/
 * playing its own session. `/cards/$type` reports which expansion card (if any) is installed —
 * checked first so a console with no WING Live card (or a different card, e.g. WDANTE/WMADI)
 * never touches `/cards/wlive/*` at all, rather than risking a timeout on a subtree that may not
 * exist. Not verified against real WING Live hardware (none was available at implementation time)
 * — every field/path below is transcribed directly from the protocol reference's "Cards Settings"
 * section, and getWLiveStatus() degrades a per-slot read failure to `reachable: false` rather than
 * throwing, so a slot without an SD card inserted (or without the card physically installed) is
 * reported, not crashed on.
 */
export const WLIVE_CARD_SLOTS = [1, 2] as const;
export type WLiveCardSlot = (typeof WLIVE_CARD_SLOTS)[number];

function requireWLiveCard(card: number): asserts card is WLiveCardSlot {
  if (!(WLIVE_CARD_SLOTS as readonly number[]).includes(card)) {
    throw new WingValueError(`WING Live card slot must be 1 or 2, got ${card}.`);
  }
}

export const WLIVE_TRANSPORT_ACTIONS = ["STOP", "PPAUSE", "PLAY", "REC"] as const;
export type WLiveTransportAction = (typeof WLIVE_TRANSPORT_ACTIONS)[number];

export const WLIVE_SESSION_ACTIONS = ["open", "delete", "rename"] as const;
export type WLiveSessionAction = (typeof WLIVE_SESSION_ACTIONS)[number];

export const WLIVE_MARKER_ACTIONS = ["set", "edit", "goto", "delete", "seek"] as const;
export type WLiveMarkerAction = (typeof WLIVE_MARKER_ACTIONS)[number];

function asString(value: string | number | undefined, fallback = ""): string {
  return value === undefined ? fallback : String(value);
}

function asNumber(value: string | number | undefined, fallback = 0): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

async function getLeafOrNull(ctx: WingPluginContext, path: string): Promise<string | number | null> {
  try {
    const result = await ctx.client.get(path);
    return result.kind === "leaf" ? result.value : null;
  } catch {
    return null;
  }
}

export interface WLiveGlobalSettings {
  sdlink: string;
  actLink: string;
  battState: string;
  autoIn: string;
  meters: boolean;
  autoStop: string;
  autoPlay: string;
  autoRec: string;
}

export interface WLiveCardStatus {
  card: WLiveCardSlot;
  /** false if this slot's status couldn't be read (no card installed, no SD inserted, timeout). */
  reachable: boolean;
  state: string;
  etimeMs: number;
  sdFreeMs: number;
  sdSizeGb: number;
  sdState: string;
  sessions: number;
  markers: number;
  sessionLenMs: number;
  sessionPos: number;
  markerPos: number;
  tracks: string;
  rate: string;
  linkedPos: number;
  startMs: number;
  stopMs: number;
  errorMessage: string;
  errorCode: number;
  recTracks: string;
  playMode: string;
}

export interface WLiveOverview {
  installed: boolean;
  cardType: string;
  global: WLiveGlobalSettings | null;
  cards: WLiveCardStatus[];
}

async function getWLiveCardStatus(ctx: WingPluginContext, card: WLiveCardSlot): Promise<WLiveCardStatus> {
  const [stat, cfg] = await Promise.all([
    ctx.client.dump(`/cards/wlive/${card}/$stat`).catch(() => null),
    ctx.client.dump(`/cards/wlive/${card}/cfg`).catch(() => null),
  ]);
  if (stat === null && cfg === null) {
    return {
      card,
      reachable: false,
      state: "UNKNOWN",
      etimeMs: 0,
      sdFreeMs: 0,
      sdSizeGb: 0,
      sdState: "NONE",
      sessions: 0,
      markers: 0,
      sessionLenMs: 0,
      sessionPos: 0,
      markerPos: 0,
      tracks: "",
      rate: "",
      linkedPos: 0,
      startMs: 0,
      stopMs: 0,
      errorMessage: "",
      errorCode: 0,
      recTracks: "",
      playMode: "",
    };
  }
  const s = stat ?? {};
  const c = cfg ?? {};
  return {
    card,
    reachable: true,
    state: asString(s.state, "UNKNOWN"),
    etimeMs: asNumber(s.etime),
    sdFreeMs: asNumber(s.sdfree),
    sdSizeGb: asNumber(s.sdsize),
    sdState: asString(s.sdstate, "NONE"),
    sessions: asNumber(s.sessions),
    markers: asNumber(s.markers),
    sessionLenMs: asNumber(s.sessionlen),
    sessionPos: asNumber(s.sessionpos),
    markerPos: asNumber(s.markerpos),
    tracks: asString(s.tracks),
    rate: asString(s.rate),
    linkedPos: asNumber(s.linkedpos),
    startMs: asNumber(s.start),
    stopMs: asNumber(s.stop),
    errorMessage: asString(s.errormessage),
    errorCode: asNumber(s.errorcode),
    recTracks: asString(c.rectracks),
    playMode: asString(c.playmode),
  };
}

/**
 * Full WING Live status: which expansion card (if any) is installed, its global settings, and
 * per-slot (1/2) session/recording status. Returns `installed: false` with no per-slot reads at
 * all when `/cards/$type` isn't "WLIVE" — safe to call on a console with no WING Live card.
 */
export async function getWLiveStatus(ctx: WingPluginContext): Promise<WLiveOverview> {
  const typeResult = await ctx.client.get("/cards/$type");
  const cardType = typeResult.kind === "leaf" ? String(typeResult.value) : "NONE";
  if (cardType !== "WLIVE") {
    return { installed: false, cardType, global: null, cards: [] };
  }

  const [globalFlat, actLink, battState] = await Promise.all([
    ctx.client.dump("/cards/wlive").catch(() => ({}) as Record<string, string | number>),
    getLeafOrNull(ctx, "/cards/wlive/$actlink"),
    getLeafOrNull(ctx, "/cards/wlive/$battstate"),
  ]);
  const global: WLiveGlobalSettings = {
    sdlink: asString(globalFlat.sdlink),
    actLink: asString(actLink ?? undefined),
    battState: asString(battState ?? undefined),
    autoIn: asString(globalFlat.autoin),
    meters: asNumber(globalFlat.meters) === 1,
    autoStop: asString(globalFlat.auto_stop),
    autoPlay: asString(globalFlat.auto_play),
    autoRec: asString(globalFlat.auto_rec),
  };

  const cards = await Promise.all(WLIVE_CARD_SLOTS.map((card) => getWLiveCardStatus(ctx, card)));
  return { installed: true, cardType, global, cards };
}

export interface WLiveTransportOptions {
  card: number;
  action: WLiveTransportAction;
}

/** Transport control (stop/pause/play/record) for one WING Live SD slot. */
export async function runWLiveTransport(ctx: WingPluginContext, opts: WLiveTransportOptions): Promise<WingBulkSetResult> {
  requireWLiveCard(opts.card);
  if (!WLIVE_TRANSPORT_ACTIONS.includes(opts.action)) {
    throw new WingValueError(`action must be one of ${WLIVE_TRANSPORT_ACTIONS.join(", ")}`);
  }
  return ctx.client.bulkSet(`/cards/wlive/${opts.card}/$ctl`, { control: opts.action });
}

export interface WLiveSessionOptions {
  card: number;
  action: WLiveSessionAction;
  /** Required for "open"/"delete" — session # (0..100). */
  sessionIndex?: number;
  /** Required for "rename". The console only applies this while the slot is stopped. */
  name?: string;
}

function requireSessionIndex(sessionIndex: number | undefined, actionLabel: string): number {
  if (sessionIndex === undefined || !Number.isInteger(sessionIndex) || sessionIndex < 0 || sessionIndex > 100) {
    throw new WingValueError(`session action "${actionLabel}" requires an integer sessionIndex between 0 and 100.`);
  }
  return sessionIndex;
}

/**
 * Opens, deletes, or renames a session on one WING Live SD slot. Validated here (not just in the
 * MCP tool's Zod schema) so a REST caller gets the same rejection as an MCP caller, instead of an
 * out-of-range sessionIndex or an overlong name reaching the console unchecked.
 */
export async function manageWLiveSession(ctx: WingPluginContext, opts: WLiveSessionOptions): Promise<WingBulkSetResult> {
  requireWLiveCard(opts.card);
  const basePath = `/cards/wlive/${opts.card}/$ctl`;
  if (opts.action === "open") {
    return ctx.client.bulkSet(basePath, { opensession: requireSessionIndex(opts.sessionIndex, "open") });
  }
  if (opts.action === "delete") {
    return ctx.client.bulkSet(basePath, { deletesession: requireSessionIndex(opts.sessionIndex, "delete") });
  }
  if (opts.action === "rename") {
    if (!opts.name || opts.name.length > 19) {
      throw new WingValueError('session action "rename" requires a non-empty name of at most 19 characters.');
    }
    return ctx.client.bulkSet(basePath, { namesession: opts.name });
  }
  throw new WingValueError(`Unknown session action: ${String(opts.action)}`);
}

export interface WLiveMarkerOptions {
  card: number;
  action: WLiveMarkerAction;
  /** Required for "edit"/"goto"/"delete" — marker # (0..100). */
  markerIndex?: number;
  /** Required for "seek" — target time in milliseconds; the console requires this to be followed
   * by gotomarker=101 to take effect, which this sends in the same bulk-set. 101 is an internal
   * commit signal for THIS action only, never a real marker index — see "goto" below. */
  timeMs?: number;
}

function requireMarkerIndex(markerIndex: number | undefined, actionLabel: string): number {
  if (markerIndex === undefined || !Number.isInteger(markerIndex) || markerIndex < 0 || markerIndex > 100) {
    throw new WingValueError(`marker action "${actionLabel}" requires an integer markerIndex between 0 and 100.`);
  }
  return markerIndex;
}

/**
 * Sets, edits, deletes, or jumps to a marker on one WING Live SD slot.
 *
 * "goto" intentionally rejects markerIndex 101: per the protocol reference, `gotomarker=101` isn't a
 * 101st marker — it's a "commit the currently-set stime" signal, meaningful only when paired with a
 * `stime` write in the SAME bulk-set (exactly what "seek" below does). Accepting 101 here would jump
 * to whatever stale `stime` happens to be on the console rather than anywhere the caller intended.
 */
export async function manageWLiveMarker(ctx: WingPluginContext, opts: WLiveMarkerOptions): Promise<WingBulkSetResult> {
  requireWLiveCard(opts.card);
  const basePath = `/cards/wlive/${opts.card}/$ctl`;
  if (opts.action === "set") {
    return ctx.client.bulkSet(basePath, { setmarker: 1 });
  }
  if (opts.action === "edit") {
    return ctx.client.bulkSet(basePath, { editmarker: requireMarkerIndex(opts.markerIndex, "edit") });
  }
  if (opts.action === "goto") {
    return ctx.client.bulkSet(basePath, { gotomarker: requireMarkerIndex(opts.markerIndex, "goto") });
  }
  if (opts.action === "delete") {
    return ctx.client.bulkSet(basePath, { deletemarker: requireMarkerIndex(opts.markerIndex, "delete") });
  }
  if (opts.action === "seek") {
    if (opts.timeMs === undefined || opts.timeMs < 0) {
      throw new WingValueError('marker action "seek" requires a non-negative timeMs.');
    }
    return ctx.client.bulkSet(basePath, { stime: opts.timeMs, gotomarker: 101 });
  }
  throw new WingValueError(`Unknown marker action: ${String(opts.action)}`);
}

/**
 * Formats the SD card in one WING Live slot — DESTRUCTIVE, erases all sessions on that card.
 * Mirrors wing_save_to_flash's caution: never call this from a loop or without explicit user
 * confirmation of which card and that its contents are expendable.
 */
export async function formatWLiveCard(ctx: WingPluginContext, card: number): Promise<WingBulkSetResult> {
  requireWLiveCard(card);
  return ctx.client.bulkSet(`/cards/wlive/${card}/$ctl`, { formatsdcard: 1 });
}
