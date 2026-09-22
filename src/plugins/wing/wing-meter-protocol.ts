// Low-level binary framing for the WING metering protocol (TCP:2222).
// Pure encode/decode functions only — no sockets here (see wing-meter-client.ts for the transport).
//
// Two layers, per the protocol spec:
//  (A) A byte-escaping / channel-multiplex layer active on the *whole* TCP stream at all times.
//      Escape byte 0xdf. Channel select = 0xdf, (0xd0 + ChID). A literal 0xdf in payload data is
//      escaped on the wire as 0xdf 0xde.
//  (B) The meter subsystem's own command tokens, carried as payload bytes on channel 3 (once selected).

import type { MeterFrame, MeterGroupType, MeterRequest, MeterSnapshot } from "./wing-meter-types.js";

export const ESCAPE = 0xdf;

export const TOKEN_UDP_PORT = 0xd3;
export const TOKEN_REPORT_ID = 0xd4;
export const TOKEN_COLLECTION_START = 0xdc;
export const TOKEN_COLLECTION_END = 0xde;

const METER_CHANNEL_SELECTOR_BASE = 0xd0;

/** Builds the `0xdf, (0xd0 + chId)` channel-select sequence for the outer multiplex layer. */
export function encodeChannelSelect(chId: number): Buffer {
  return Buffer.from([ESCAPE, METER_CHANNEL_SELECTOR_BASE + chId]);
}

/**
 * Escapes any literal 0xdf byte in `payload` as the two-byte sequence `0xdf 0xde`, per the
 * multiplex layer's escaping rule. Apply this to any payload written to the TCP stream on an
 * already-selected channel (never to the channel-select sequence itself).
 */
export function escapeBytes(payload: number[] | Buffer): Buffer {
  const source = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const out: number[] = [];
  for (const byte of source) {
    if (byte === ESCAPE) {
      out.push(ESCAPE, TOKEN_COLLECTION_END);
    } else {
      out.push(byte);
    }
  }
  return Buffer.from(out);
}

/**
 * Streaming de-escaper / channel demultiplexer for the outer multiplex layer described above.
 * Feed it raw TCP bytes as they arrive (in any chunk boundary) and it will call `onByte` once per
 * logical (post-escape) data byte, tagged with the channel it belongs to.
 */
export class WingChannelDemuxer {
  private currentChannel = 0;
  private pendingEscape = false;

  /**
   * Drops the state carried between `feed()` calls. Must be called whenever the underlying stream
   * is replaced: a connection that drops mid-escape-sequence leaves `pendingEscape` set, and the
   * first byte of the *next* connection would then be read as a channel selector rather than data.
   */
  reset(): void {
    this.currentChannel = 0;
    this.pendingEscape = false;
  }

  feed(chunk: Buffer, onByte: (chId: number, byte: number) => void): void {
    for (let i = 0; i < chunk.length; i++) {
      const byte = chunk[i];
      if (this.pendingEscape) {
        this.pendingEscape = false;
        if (byte === TOKEN_COLLECTION_END) {
          // 0xdf 0xde => literal escaped 0xdf data byte on the current channel.
          onByte(this.currentChannel, ESCAPE);
        } else {
          // 0xdf <byte> (byte !== 0xde) => channel select, no data emitted.
          this.currentChannel = byte - METER_CHANNEL_SELECTOR_BASE;
        }
        continue;
      }
      if (byte === ESCAPE) {
        this.pendingEscape = true;
        continue;
      }
      onByte(this.currentChannel, byte);
    }
  }
}

interface MeterGroupMeta {
  token: number;
  hasIndex: boolean;
  wordCount: number;
}

export const METER_GROUP_TABLE: Record<MeterGroupType, MeterGroupMeta> = {
  channel: { token: 0xa0, hasIndex: true, wordCount: 8 },
  aux: { token: 0xa1, hasIndex: true, wordCount: 8 },
  bus: { token: 0xa2, hasIndex: true, wordCount: 8 },
  main: { token: 0xa3, hasIndex: true, wordCount: 8 },
  matrix: { token: 0xa4, hasIndex: true, wordCount: 8 },
  dca: { token: 0xa5, hasIndex: true, wordCount: 4 },
  fx: { token: 0xa6, hasIndex: true, wordCount: 10 },
  source: { token: 0xa7, hasIndex: true, wordCount: 1 },
  output: { token: 0xa8, hasIndex: true, wordCount: 1 },
  monitor: { token: 0xa9, hasIndex: false, wordCount: 6 },
  rta: { token: 0xaa, hasIndex: false, wordCount: 120 },
  channelV2: { token: 0xab, hasIndex: true, wordCount: 11 },
  auxV2: { token: 0xac, hasIndex: true, wordCount: 11 },
  busV2: { token: 0xad, hasIndex: true, wordCount: 11 },
  mainV2: { token: 0xae, hasIndex: true, wordCount: 11 },
  matrixV2: { token: 0xaf, hasIndex: true, wordCount: 11 },
};

/**
 * Encodes a meter subscription collection:
 * `[TOKEN_COLLECTION_START, ...for each request: token, ...(0-based index bytes if hasIndex)..., TOKEN_COLLECTION_END]`.
 */
export function encodeMeterCollection(requests: MeterRequest[]): Buffer {
  const bytes: number[] = [TOKEN_COLLECTION_START];
  for (const request of requests) {
    const meta = METER_GROUP_TABLE[request.type];
    bytes.push(meta.token);
    if (meta.hasIndex) {
      if (!request.indices || request.indices.length === 0) {
        throw new RangeError(`meter request of type "${request.type}" requires at least one index`);
      }
      for (const index of request.indices) {
        if (!Number.isInteger(index) || index < 1 || index > 128) {
          throw new RangeError(`meter index out of range (1..128) for type "${request.type}": ${index}`);
        }
        bytes.push(index - 1);
      }
    }
  }
  bytes.push(TOKEN_COLLECTION_END);
  return Buffer.from(bytes);
}

/** Encodes the report-id / keepalive token: `[TOKEN_REPORT_ID, ...4 bytes big-endian of id>>>0]`. */
export function encodeReportId(id: number): Buffer {
  const buf = Buffer.alloc(5);
  buf[0] = TOKEN_REPORT_ID;
  buf.writeUInt32BE(id >>> 0, 1);
  return buf;
}

/** Encodes the UDP port announcement: `[TOKEN_UDP_PORT, hi byte, lo byte]`. */
export function encodeUdpPortAnnouncement(port: number): Buffer {
  const buf = Buffer.alloc(3);
  buf[0] = TOKEN_UDP_PORT;
  buf.writeUInt16BE(port & 0xffff, 1);
  return buf;
}

function toDb(word: number): number {
  return word / 256;
}

/**
 * RTA band words are 1/128 dB, not 1/256 like level words — verified on hardware: a 10 dB change of the
 * internal oscillator moved every band by ~5 dB under /256, and a +6 dB matrix EQ bell read +3 dB.
 */
function rtaWordToDb(word: number): number {
  return word / 128;
}

/**
 * Gate/dyn gain-reduction words are NOT plain 1/256 dB like level words, despite the protocol doc's
 * general statement that "level values are in 1/256 dB" — its dedicated "Channel 3: Metering" section
 * calls out gate/dyn gain specifically: "Most data are returned in 1/256 steps. This is typically the
 * case for Gate gain and Dyn gain values. The returned value is multiplied/adjusted with a fixed
 * value to cover for the plugin model data range in use. For most of them 1.0 (256) maps to 20 dB
 * gain reduction. Standard Wing gate is 60 dB." (WING_Remote-Protocols-3.1-03.pdf, p.98) — i.e.
 * `word / 256` is a normalized ratio (1.0 = full scale for whatever range this slot's model uses), not
 * dB directly; this applies the documented DEFAULT 20dB range. The one documented exception (the
 * "GATE" model's 60dB range) can't be corrected here — this parsing layer has no way to know which
 * model occupies a given slot (that's OSC-side info, from an entirely separate connection) — see
 * `gainReductionScaleCorrection()` in wing-dynamics-models.ts for callers that do know the model.
 *
 * Sign: unlike level words (negative = quieter), a positive raw word here means *more* reduction —
 * confirmed live by forcing an unambiguous, extreme gate+compressor setup (threshold/ratio chosen so
 * substantial real reduction was mathematically guaranteed) and observing a large *positive* raw word
 * in exactly that case, never negative. Negated here so the rest of this codebase's existing "negative
 * dB = actively reducing" convention (matching a hardware GR meter) is correct at the source, instead
 * of every caller having to remember to flip it.
 */
export const DEFAULT_GAIN_REDUCTION_FULL_SCALE_DB = 20;

function toGainReductionDb(word: number): number {
  return -(word / 256) * DEFAULT_GAIN_REDUCTION_FULL_SCALE_DB;
}

function toFxState(word: number): number {
  return (word * 6.0) / 2048;
}

function buildFrame(type: MeterGroupType, index: number | undefined, words: number[]): MeterFrame {
  switch (type) {
    case "channel":
    case "aux":
    case "bus":
    case "main":
    case "matrix":
      return {
        type,
        index: index ?? 0,
        inputL_dB: toDb(words[0]),
        inputR_dB: toDb(words[1]),
        outputL_dB: toDb(words[2]),
        outputR_dB: toDb(words[3]),
        gateKey_dB: toDb(words[4]),
        gateGain_dB: toGainReductionDb(words[5]),
        dynKey_dB: toDb(words[6]),
        dynGain_dB: toGainReductionDb(words[7]),
      };
    case "channelV2":
    case "auxV2":
    case "busV2":
    case "mainV2":
    case "matrixV2":
      return {
        type,
        index: index ?? 0,
        inputL_dB: toDb(words[0]),
        inputR_dB: toDb(words[1]),
        outputL_dB: toDb(words[2]),
        outputR_dB: toDb(words[3]),
        gateKey_dB: toDb(words[4]),
        gateGain_dB: toGainReductionDb(words[5]),
        gateLed: words[6] !== 0,
        dynKey_dB: toDb(words[7]),
        dynGain_dB: toGainReductionDb(words[8]),
        dynActive: words[9] !== 0,
        automixGain_dB: toDb(words[10]),
      };
    case "dca":
      return {
        type,
        index: index ?? 0,
        preFaderL_dB: toDb(words[0]),
        preFaderR_dB: toDb(words[1]),
        postFaderL_dB: toDb(words[2]),
        postFaderR_dB: toDb(words[3]),
      };
    case "fx":
      return {
        type,
        index: index ?? 0,
        inputL_dB: toDb(words[0]),
        inputR_dB: toDb(words[1]),
        outputL_dB: toDb(words[2]),
        outputR_dB: toDb(words[3]),
        state: words.slice(4).map(toFxState),
      };
    case "source":
    case "output":
      return { type, index: index ?? 0, level_dB: toDb(words[0]) };
    case "monitor":
      return {
        type,
        soloL_dB: toDb(words[0]),
        soloR_dB: toDb(words[1]),
        mon1L_dB: toDb(words[2]),
        mon1R_dB: toDb(words[3]),
        mon2L_dB: toDb(words[4]),
        mon2R_dB: toDb(words[5]),
      };
    case "rta":
      return { type, bands_dB: words.map(rtaWordToDb) };
    default: {
      const exhaustive: never = type;
      throw new Error(`unknown meter group type: ${exhaustive as string}`);
    }
  }
}

/**
 * Parses a UDP meter datagram: `<report id 4 bytes BE><int16 BE words...>`, given the ordered,
 * flattened list of groups that were requested (one entry per (type, index) pair, in request order —
 * "monitor"/"rta" have no index).
 *
 * Never throws: returns `null` for a buffer shorter than the expected total length, since malformed
 * or truncated packets must never crash a socket handler.
 */
export function parseMeterUdpPacket(
  buf: Buffer,
  groups: Array<{ type: MeterGroupType; index?: number }>,
): MeterSnapshot | null {
  try {
    let totalWords = 0;
    for (const group of groups) {
      totalWords += METER_GROUP_TABLE[group.type].wordCount;
    }
    const expectedLength = 4 + 2 * totalWords;
    if (buf.length < expectedLength) {
      return null;
    }

    const reportId = buf.readUInt32BE(0);
    let offset = 4;
    const frames: MeterFrame[] = [];
    for (const group of groups) {
      const meta = METER_GROUP_TABLE[group.type];
      const words: number[] = new Array(meta.wordCount);
      for (let w = 0; w < meta.wordCount; w++) {
        words[w] = buf.readInt16BE(offset);
        offset += 2;
      }
      frames.push(buildFrame(group.type, group.index, words));
    }

    return { reportId, receivedAt: Date.now(), frames };
  } catch (err) {
    console.error("wing-meter-protocol: failed to parse UDP meter packet:", err);
    return null;
  }
}

/**
 * Combines two frames of the same (type, index) into one, keeping whichever value best represents
 * "the most extreme thing this field did" across both: peak (max) for a plain level/detector-key
 * reading, and peak-in-the-cutting-direction (min) for a gain-reduction field, since a *deeper*
 * reduction is the more extreme/significant one there, not a larger raw number. `automixGain_dB`
 * can legitimately swing either way (an automixer raises some channels and lowers others), so it
 * keeps whichever of the two has the larger magnitude instead of always min or always max.
 */
function mergeFrame(a: MeterFrame, b: MeterFrame): MeterFrame {
  const maxOf = (x: number, y: number) => Math.max(x, y);
  const minOf = (x: number, y: number) => Math.min(x, y);
  const biggerMagnitudeOf = (x: number, y: number) => (Math.abs(y) > Math.abs(x) ? y : x);
  switch (a.type) {
    case "channel":
    case "aux":
    case "bus":
    case "main":
    case "matrix": {
      const other = b as typeof a;
      return {
        ...a,
        inputL_dB: maxOf(a.inputL_dB, other.inputL_dB),
        inputR_dB: maxOf(a.inputR_dB, other.inputR_dB),
        outputL_dB: maxOf(a.outputL_dB, other.outputL_dB),
        outputR_dB: maxOf(a.outputR_dB, other.outputR_dB),
        gateKey_dB: maxOf(a.gateKey_dB, other.gateKey_dB),
        gateGain_dB: minOf(a.gateGain_dB, other.gateGain_dB),
        dynKey_dB: maxOf(a.dynKey_dB, other.dynKey_dB),
        dynGain_dB: minOf(a.dynGain_dB, other.dynGain_dB),
      };
    }
    case "channelV2":
    case "auxV2":
    case "busV2":
    case "mainV2":
    case "matrixV2": {
      const other = b as typeof a;
      return {
        ...a,
        inputL_dB: maxOf(a.inputL_dB, other.inputL_dB),
        inputR_dB: maxOf(a.inputR_dB, other.inputR_dB),
        outputL_dB: maxOf(a.outputL_dB, other.outputL_dB),
        outputR_dB: maxOf(a.outputR_dB, other.outputR_dB),
        gateKey_dB: maxOf(a.gateKey_dB, other.gateKey_dB),
        gateGain_dB: minOf(a.gateGain_dB, other.gateGain_dB),
        gateLed: a.gateLed || other.gateLed,
        dynKey_dB: maxOf(a.dynKey_dB, other.dynKey_dB),
        dynGain_dB: minOf(a.dynGain_dB, other.dynGain_dB),
        dynActive: a.dynActive || other.dynActive,
        automixGain_dB: biggerMagnitudeOf(a.automixGain_dB, other.automixGain_dB),
      };
    }
    case "dca": {
      const other = b as typeof a;
      return {
        ...a,
        preFaderL_dB: maxOf(a.preFaderL_dB, other.preFaderL_dB),
        preFaderR_dB: maxOf(a.preFaderR_dB, other.preFaderR_dB),
        postFaderL_dB: maxOf(a.postFaderL_dB, other.postFaderL_dB),
        postFaderR_dB: maxOf(a.postFaderR_dB, other.postFaderR_dB),
      };
    }
    case "fx": {
      const other = b as typeof a;
      return {
        ...a,
        inputL_dB: maxOf(a.inputL_dB, other.inputL_dB),
        inputR_dB: maxOf(a.inputR_dB, other.inputR_dB),
        outputL_dB: maxOf(a.outputL_dB, other.outputL_dB),
        outputR_dB: maxOf(a.outputR_dB, other.outputR_dB),
        state: a.state.map((v, i) => maxOf(v, other.state[i])),
      };
    }
    case "source":
    case "output": {
      const other = b as typeof a;
      return { ...a, level_dB: maxOf(a.level_dB, other.level_dB) };
    }
    case "monitor": {
      const other = b as typeof a;
      return {
        ...a,
        soloL_dB: maxOf(a.soloL_dB, other.soloL_dB),
        soloR_dB: maxOf(a.soloR_dB, other.soloR_dB),
        mon1L_dB: maxOf(a.mon1L_dB, other.mon1L_dB),
        mon1R_dB: maxOf(a.mon1R_dB, other.mon1R_dB),
        mon2L_dB: maxOf(a.mon2L_dB, other.mon2L_dB),
        mon2R_dB: maxOf(a.mon2R_dB, other.mon2R_dB),
      };
    }
    case "rta": {
      const other = b as typeof a;
      return { ...a, bands_dB: a.bands_dB.map((v, i) => maxOf(v, other.bands_dB[i])) };
    }
    default: {
      const exhaustive: never = a;
      throw new Error(`unknown meter frame type: ${(exhaustive as MeterFrame).type}`);
    }
  }
}

/**
 * Folds several snapshots (all parsed from the same fixed, ordered subscription — see
 * `flattenedGroups` in wing-meter-client.ts — so their `frames` arrays are always the same length,
 * in the same (type, index) order) into one, field-by-field peak-preserving (see `mergeFrame`).
 *
 * Exists because the console streams meter UDP packets far more often than the ~100ms rate the
 * dashboard's SSE bridge publishes at (`METER_PUBLISH_THROTTLE_MS` in wing-plugin.ts) — naively
 * forwarding only the single latest snapshot per publish window silently drops every fast transient
 * that happened in between, e.g. a compressor's gain-reduction meter dipping several dB for a few
 * ms then releasing well within one throttle window. Folding the whole window's worth of raw
 * snapshots together instead means the deepest reduction (or loudest peak) that actually occurred is
 * never lost, even though only one merged snapshot per window is ever published downstream.
 */
export function mergeMeterSnapshots(snapshots: MeterSnapshot[]): MeterSnapshot {
  const last = snapshots[snapshots.length - 1];
  let frames = snapshots[0].frames;
  for (let s = 1; s < snapshots.length; s++) {
    const next = snapshots[s].frames;
    frames = frames.map((frame, i) => mergeFrame(frame, next[i]));
  }
  return { reportId: last.reportId, receivedAt: last.receivedAt, frames };
}
