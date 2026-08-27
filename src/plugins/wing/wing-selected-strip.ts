import { decodeRtaSourceIndex, encodeRtaSource, type RtaSource } from "./wing-rta-source.js";
import type { WingPluginContext } from "./wing-plugin.js";

export const SELECTED_STRIP_PATH = "/$ctl/$stat/selidx";

export interface SelectedStrip {
  rawIndex: number;
  strip: RtaSource | null;
}

/**
 * Reads the channel strip currently selected on the console's home screen. The protocol
 * reference's own footnote on `/$ctl/$stat/selidx` says GET reports 0..75 while SET expects
 * 1..76 — a deliberate off-by-one between the two directions, not a bug. `decodeRtaSourceIndex`
 * (wing-rta-source.ts) already operates on the 1..76 canonical numbering shared across the
 * protocol (RTA source, USER button targets, FSND, ...), so the raw GET value is shifted by one
 * before decoding.
 */
export async function getSelectedStrip(ctx: WingPluginContext): Promise<SelectedStrip> {
  const result = await ctx.client.get(SELECTED_STRIP_PATH);
  const rawIndex = result.kind === "leaf" ? Number(result.value) : NaN;
  const strip = Number.isFinite(rawIndex) ? decodeRtaSourceIndex(rawIndex + 1) : null;
  return { rawIndex, strip };
}

export interface SetSelectedStripResult {
  strip: RtaSource;
  writtenIndex: number;
  ack: { status: string; ok: boolean; raw: string };
}

/**
 * Selects a channel strip on the console's home screen. `writtenIndex` is the raw 1..76 value
 * sent on the wire (SET's own convention — a subsequent GET will report `writtenIndex - 1`).
 */
export async function setSelectedStrip(ctx: WingPluginContext, strip: RtaSource): Promise<SetSelectedStripResult> {
  const writtenIndex = encodeRtaSource(strip);
  const ack = await ctx.client.bulkSet("/$ctl/$stat", { selidx: writtenIndex });
  return { strip, writtenIndex, ack };
}
