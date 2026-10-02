import { decodeRtaSourceIndex, encodeRtaSource, type RtaSource } from "./wing-rta-source.js";
import type { WingPluginContext } from "./wing-plugin.js";

export const SELECTED_STRIP_PATH = "/$ctl/$stat/selidx";

export interface SelectedStrip {
  rawIndex: number;
  strip: RtaSource | null;
}

/**
 * Reads the channel strip currently selected on the console's home screen. `/$ctl/$stat/selidx`
 * is 0-based (0..75) in both directions, while `decodeRtaSourceIndex` (wing-rta-source.ts)
 * operates on the 1..76 canonical numbering shared across the protocol (RTA source, USER button
 * targets, FSND, ...), so the raw value is shifted by one before decoding.
 *
 * The protocol reference's footnote says SET expects 1..76, one more than GET. Measured on a WING
 * Rack (2026-10-03) it does not: writing 1 reads back 1 (channel 2), 2 reads back 2 (channel 3),
 * 27 reads back 27 (channel 28) — following the footnote selected the strip after the one asked for.
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
 * Selects a channel strip on the console's home screen. `writtenIndex` is the raw 0..75 value sent
 * on the wire — the same one a subsequent GET reports (see getSelectedStrip for the footnote this
 * contradicts).
 */
export async function setSelectedStrip(ctx: WingPluginContext, strip: RtaSource): Promise<SetSelectedStripResult> {
  const writtenIndex = encodeRtaSource(strip) - 1;
  const ack = await ctx.client.bulkSet("/$ctl/$stat", { selidx: writtenIndex });
  return { strip, writtenIndex, ack };
}
