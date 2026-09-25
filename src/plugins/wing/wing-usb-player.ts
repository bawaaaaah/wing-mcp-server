import { WingUnavailableError, WingValueError } from "./wing-errors.js";
import { parseWingDescribeParams, requireSafeBulkSetValue } from "./wing-value-codec.js";
import type { WingBranchResult, WingBulkSetResult, WingGetResult } from "./wing-osc-client.js";
import type { WingPluginContext } from "./wing-plugin.js";

/**
 * The USB media player/recorder module: verified against real hardware that WING (at least this
 * Rack unit's firmware) exposes exactly one combined `/play` + `/rec` module operating on
 * whatever's plugged into its single USB port — there is no separate SD-card module. Its live
 * status fields (song/artist/position/recording state, etc.) are all "$"-prefixed and are *not*
 * included in a `dump()` (unlike every other node in this file) — dump() only returns the
 * writable config (repeat/resolution/channels), so each status field needs its own GET.
 *
 * Shared by the `wing_usb_*` MCP tools and the `/media*` REST routes — both call these same
 * functions rather than each re-implementing the OSC calls.
 */

export const USB_PLAY_ACTIONS = ["IDLE", "STOP", "PLAY", "PAUSE", "NEXT", "PREV", "PLAYFILE"] as const;
export type UsbPlayAction = (typeof USB_PLAY_ACTIONS)[number];

// The protocol PDF (WING_Remote-Protocols-3.1-03.pdf) does not document "IDLE" as a valid value
// for /rec/$action, unlike /play/$action where it is documented — kept here pending live
// verification of whether the console actually accepts or rejects it.
export const USB_REC_ACTIONS = ["IDLE", "STOP", "REC", "PAUSE", "NEWFILE"] as const;
export type UsbRecAction = (typeof USB_REC_ACTIONS)[number];

const MEDIA_STATE_BUDGET_MS = 5000;

export interface UsbMediaState {
  usb: { state: string; volumeName: string };
  play: {
    state: string;
    currentIndex: number | null;
    songs: { index: number; name: string }[];
    file: string;
    song: string;
    album: string;
    artist: string;
    pos: { display: string; seconds: number };
    total: { display: string; seconds: number };
    resolution: string;
    channels: string;
    rate: string;
    format: string;
    repeat: boolean;
  };
  rec: {
    state: string;
    file: string;
    path: string;
    time: { display: string; seconds: number };
    resolution: string;
    channels: string;
  };
}

function asNumber(value: string | number | undefined, fallback: number): number {
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

function displayAndSeconds(leaf: WingGetResult | WingBranchResult | null): { display: string; seconds: number } {
  if (!leaf || leaf.kind !== "leaf") return { display: "0:00", seconds: 0 };
  return { display: leaf.display ?? String(leaf.value), seconds: Number(leaf.value) || 0 };
}

/** Reads the full USB player/recorder state in one batch, bounded by a timeout budget so a slow
 * console degrades to a clear error instead of hanging the caller indefinitely. */
export async function getUsbPlayerState(ctx: WingPluginContext): Promise<UsbMediaState> {
  const loadAll = Promise.all([
    getLeafOrNull(ctx, "/$stat/usbstate"),
    getLeafOrNull(ctx, "/$stat/usbvolname"),
    // Verified against real hardware: describing the $songs *leaf* directly never replies (same
    // dead end as $scenes), but describing the *parent branch* "/play" does, and its reply's
    // inline enum for $songs is the actual browsable file list, in the same order as $actidx.
    ctx.client.describe("/play").catch(() => null),
    getLeafOrNull(ctx, "/play/$actstate"),
    getLeafOrNull(ctx, "/play/$actidx"),
    getLeafOrNull(ctx, "/play/$actfile"),
    getLeafOrNull(ctx, "/play/$song"),
    getLeafOrNull(ctx, "/play/$album"),
    getLeafOrNull(ctx, "/play/$artist"),
    ctx.client.get("/play/$pos").catch(() => null),
    ctx.client.get("/play/$total").catch(() => null),
    getLeafOrNull(ctx, "/play/$resolution"),
    getLeafOrNull(ctx, "/play/$channels"),
    getLeafOrNull(ctx, "/play/$rate"),
    getLeafOrNull(ctx, "/play/$format"),
    ctx.client.dump("/play").catch(() => ({}) as Record<string, string | number>),
    getLeafOrNull(ctx, "/rec/$actstate"),
    getLeafOrNull(ctx, "/rec/$actfile"),
    getLeafOrNull(ctx, "/rec/$path"),
    ctx.client.get("/rec/$time").catch(() => null),
    ctx.client.dump("/rec").catch(() => ({}) as Record<string, string | number>),
  ]);
  const budget = new Promise<"timeout">((resolve) => {
    const timer = setTimeout(() => resolve("timeout"), MEDIA_STATE_BUDGET_MS);
    timer.unref?.();
  });

  const result = await Promise.race([loadAll, budget]);
  if (result === "timeout") {
    throw new WingUnavailableError("Timed out loading the USB media module state from the console.");
  }

  const [
    usbState, usbVolumeName, playDescription, playState, playActIdx, playFile, playSong, playAlbum, playArtist, playPos, playTotal,
    playResolution, playChannels, playRate, playFormat, playDump,
    recState, recFile, recPath, recTime, recDump,
  ] = result;

  // Verified against real hardware: unlike $ctl/lib's $actidx (0-based, matching $scenes' array
  // position exactly), /play's $actidx is 1-based — setting $actionidx=3 selects $songs[2]. Index
  // these entries starting at 1 to match that convention directly.
  const songsParam = playDescription ? parseWingDescribeParams(playDescription.lines).find((p) => p.key === "$songs") : undefined;
  const songs = (songsParam?.options ?? []).map((name, i) => ({ index: i + 1, name }));

  return {
    usb: { state: String(usbState ?? "UNKNOWN"), volumeName: String(usbVolumeName ?? "") },
    play: {
      state: String(playState ?? "UNKNOWN"),
      currentIndex: playActIdx !== null ? Number(playActIdx) : null,
      songs,
      file: String(playFile ?? ""),
      song: String(playSong ?? ""),
      album: String(playAlbum ?? ""),
      artist: String(playArtist ?? ""),
      pos: displayAndSeconds(playPos),
      total: displayAndSeconds(playTotal),
      resolution: String(playResolution ?? ""),
      channels: String(playChannels ?? ""),
      rate: String(playRate ?? ""),
      format: String(playFormat ?? ""),
      repeat: asNumber(playDump.repeat, 0) === 1,
    },
    rec: {
      state: String(recState ?? "UNKNOWN"),
      file: String(recFile ?? ""),
      path: String(recPath ?? ""),
      time: displayAndSeconds(recTime),
      resolution: String(recDump.resolution ?? ""),
      channels: String(recDump.channels ?? ""),
    },
  };
}

export interface UsbPlayOptions {
  action: UsbPlayAction;
  /** Required for PLAYFILE — an arbitrary path, distinct from selecting a track by index. */
  file?: string;
  /** For PLAY only — 1-based index into the `$songs` list returned by `getUsbPlayerState`. */
  index?: number;
}

/** Selecting a track from the browsable `$songs` list and playing it is a single combined write,
 * verified against real hardware: `{$actionidx: N, $action: "PLAY"}`. PLAYFILE instead plays an
 * arbitrary path via `$playfile` rather than an index into `$songs`. */
export async function runUsbPlayAction(ctx: WingPluginContext, opts: UsbPlayOptions): Promise<WingBulkSetResult> {
  if (!USB_PLAY_ACTIONS.includes(opts.action)) {
    throw new WingValueError(`action must be one of ${USB_PLAY_ACTIONS.join(", ")}`);
  }
  if (opts.action === "PLAYFILE" && !opts.file) {
    throw new WingValueError("PLAYFILE requires a `file` path");
  }
  const assignments: Record<string, string | number> = { $action: opts.action };
  if (opts.action === "PLAYFILE" && opts.file) assignments.$playfile = requireSafeBulkSetValue(opts.file, "file");
  if (opts.action === "PLAY" && opts.index !== undefined) {
    if (!Number.isInteger(opts.index) || opts.index < 1) {
      throw new WingValueError(`index must be a positive integer (got ${opts.index}).`);
    }
    assignments.$actionidx = opts.index;
  }
  return ctx.client.bulkSet("/play", assignments);
}

export interface UsbRecordOptions {
  action: UsbRecAction;
}

export async function runUsbRecordAction(ctx: WingPluginContext, opts: UsbRecordOptions): Promise<WingBulkSetResult> {
  if (!USB_REC_ACTIONS.includes(opts.action)) {
    throw new WingValueError(`action must be one of ${USB_REC_ACTIONS.join(", ")}`);
  }
  return ctx.client.bulkSet("/rec", { $action: opts.action });
}

/** `/play/repeat` was previously only ever read (via `getUsbPlayerState`'s `dump("/play")`), never
 * written — this is the first write path for it. */
export async function setUsbRepeat(ctx: WingPluginContext, on: boolean): Promise<WingBulkSetResult> {
  return ctx.client.bulkSet("/play", { repeat: on ? 1 : 0 });
}
