import { z } from "zod";
import type { LiveTopic } from "../../core/plugin.js";
import type { MeterFrame, MeterSnapshot } from "./wing-meter-types.js";
import type { RtaSnapshot } from "./wing-plugin.js";

/**
 * The WING plugin's topics on the WebSocket hub (core/ws-hub.ts). Their wire format is part of the
 * documented protocol — docs/websocket-protocol.md — so a change here is a change there.
 */

/** RTA bands travel as Int16LE in 1/128 dB — the console's own word resolution, so lossless. */
export const RTA_WIRE_SCALE = 128;

/** Meter values travel as integers in tenths of a dB (booleans as 0/1), per these columns. */
export const METER_WIRE_SCALE = 10;

const STRIP_COLUMNS = ["inputL_dB", "inputR_dB", "outputL_dB", "outputR_dB", "gateKey_dB", "gateGain_dB", "dynKey_dB", "dynGain_dB"] as const;
const STRIP_V2_COLUMNS = [...STRIP_COLUMNS, "gateLed", "dynActive", "automixGain_dB"] as const;

type MeterFrameType = Exclude<MeterFrame["type"], "rta">;

/**
 * Column order of each frame type's tuple. Sent to every `meters` subscriber in its ack, so the
 * dashboard never hardcodes a layout. fx's `state` array is not a level and is left out.
 */
export const METER_COLUMNS: Record<MeterFrameType, readonly string[]> = {
  channel: STRIP_COLUMNS,
  aux: STRIP_COLUMNS,
  bus: STRIP_COLUMNS,
  main: STRIP_COLUMNS,
  matrix: STRIP_COLUMNS,
  channelV2: STRIP_V2_COLUMNS,
  auxV2: STRIP_V2_COLUMNS,
  busV2: STRIP_V2_COLUMNS,
  mainV2: STRIP_V2_COLUMNS,
  matrixV2: STRIP_V2_COLUMNS,
  dca: ["preFaderL_dB", "preFaderR_dB", "postFaderL_dB", "postFaderR_dB"],
  fx: ["inputL_dB", "inputR_dB", "outputL_dB", "outputR_dB"],
  source: ["level_dB"],
  output: ["level_dB"],
  monitor: ["soloL_dB", "soloR_dB", "mon1L_dB", "mon1R_dB", "mon2L_dB", "mon2R_dB"],
};

const METER_FRAME_TYPES = Object.keys(METER_COLUMNS) as [MeterFrameType, ...MeterFrameType[]];

const MetersParamsSchema = z
  .object({
    strips: z.union([
      z.literal("all"),
      z
        .array(z.object({ type: z.enum(METER_FRAME_TYPES), index: z.number().int().min(0).max(128) }).strict())
        .max(512),
    ]),
  })
  .strict();

/** `null` means every strip. */
type MetersFilter = Set<string> | null;

const stripKey = (type: string, index: number): string => `${type}:${index}`;

/** monitor has no index; it travels as 0. */
const frameIndex = (frame: MeterFrame): number => ("index" in frame ? frame.index : 0);

function toWire(value: unknown): number | null {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number" && Number.isFinite(value)) return Math.round(value * METER_WIRE_SCALE);
  return null;
}

function subscribeMeters(params: unknown): { key: string; params: MetersFilter; ack: unknown } {
  const parsed = MetersParamsSchema.safeParse(params);
  if (!parsed.success) {
    throw new Error('expected { strips: "all" | [{ type, index }] } — ' + (parsed.error.issues[0]?.message ?? "invalid"));
  }
  const ack = { columns: METER_COLUMNS, scale: METER_WIRE_SCALE };
  if (parsed.data.strips === "all") return { key: "all", params: null, ack };
  const wanted = new Set(parsed.data.strips.map((s) => stripKey(s.type, s.index)));
  // Subscribers asking for the same set share one group, whatever order they listed it in.
  return { key: [...wanted].sort().join(","), params: wanted, ack };
}

function encodeMeters(payload: unknown, filter: unknown): unknown {
  const snapshot = payload as MeterSnapshot;
  const wanted = filter as MetersFilter;
  const frames: (string | number | null)[][] = [];
  for (const frame of snapshot.frames) {
    if (frame.type === "rta") continue;
    const index = frameIndex(frame);
    if (wanted && !wanted.has(stripKey(frame.type, index))) continue;
    const record = frame as unknown as Record<string, unknown>;
    const tuple: (string | number | null)[] = [frame.type, index];
    for (const column of METER_COLUMNS[frame.type]) tuple.push(toWire(record[column]));
    frames.push(tuple);
  }
  if (frames.length === 0) return null;
  return { receivedAt: snapshot.receivedAt, frames };
}

/** Int16LE bands in 1/RTA_WIRE_SCALE dB, clamped to the int16 range. */
export function encodeRtaBands(bandsDb: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(bandsDb.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < bandsDb.length; i++) {
    const db = bandsDb[i];
    const word = Number.isFinite(db) ? Math.round(db * RTA_WIRE_SCALE) : -32768;
    view.setInt16(i * 2, Math.max(-32768, Math.min(32767, word)), true);
  }
  return bytes;
}

function encodeRta(payload: unknown): unknown {
  const rta = payload as RtaSnapshot;
  return { receivedAt: rta.receivedAt, scale: RTA_WIRE_SCALE, bands: encodeRtaBands(rta.bandsDb) };
}

export function wingLiveTopics(): Record<string, LiveTopic> {
  return {
    "param-change": { channel: "control" },
    connection: { channel: "control" },
    "cache-invalidated": { channel: "control" },
    meters: { channel: "stream", subscribe: subscribeMeters, encode: encodeMeters },
    // A quantized spectrum barely compresses, and at ~250 bytes it is under the threshold anyway.
    rta: { channel: "stream", compress: false, encode: encodeRta },
  };
}
