// Decoding of the WebSocket protocol's WING frames (docs/websocket-protocol.md). Deliberately free
// of DOM and React: the server's tests import this very file to decode what the server encodes, so
// the two sides cannot drift apart unnoticed.

/** `evt` data on `wing:rta`. */
export interface RtaWireFrame {
  receivedAt: number;
  /** 1/scale dB per unit. */
  scale: number;
  /** Int16LE, one word per band, ascending frequency. */
  bands: Uint8Array;
}

/** Bands in dB. DataView rather than Int16Array: a msgpack `bin` can sit at an odd byte offset. */
export function decodeRtaBands(frame: RtaWireFrame): Float32Array {
  const { bands, scale } = frame;
  const view = new DataView(bands.buffer, bands.byteOffset, bands.byteLength);
  const out = new Float32Array(Math.floor(bands.byteLength / 2));
  for (let i = 0; i < out.length; i++) out[i] = view.getInt16(i * 2, true) / scale;
  return out;
}

/** `ack` data on `wing:meters`: each frame type's tuple layout. */
export interface MetersAck {
  columns: Record<string, readonly string[]>;
  scale: number;
}

/** `evt` data on `wing:meters`. Each frame is `[type, index, ...values]` in the ack's column order. */
export interface MetersWireFrame {
  receivedAt: number;
  frames: (string | number | null)[][];
}

export interface MeterReading {
  type: string;
  index: number;
  /** Columns ending in `_dB` are in dB; the others (gateLed, dynActive) are 0/1. null: no reading. */
  values: Record<string, number | null>;
}

export function decodeMeterFrames(frame: MetersWireFrame, ack: MetersAck): MeterReading[] {
  const readings: MeterReading[] = [];
  for (const tuple of frame.frames) {
    const [type, index] = tuple as [string, number];
    const columns = ack.columns[type];
    if (!columns) continue;
    const values: Record<string, number | null> = {};
    for (let i = 0; i < columns.length; i++) {
      const raw = tuple[i + 2];
      const column = columns[i];
      values[column] = typeof raw !== "number" ? null : column.endsWith("_dB") ? raw / ack.scale : raw;
    }
    readings.push({ type, index, values });
  }
  return readings;
}
