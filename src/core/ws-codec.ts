import { decode as msgpackDecode, encode as msgpackEncode } from "@msgpack/msgpack";

/**
 * The two wire encodings of the WebSocket protocol (docs/websocket-protocol.md). The messages are the
 * same in both; only their serialization differs. MessagePack is what the dashboard speaks; JSON
 * exists so a test or a human with `wscat` can read the traffic.
 *
 * MessagePack carries `Uint8Array` values as native `bin`. JSON cannot, so it writes them as
 * `{"$b64": "<base64>"}` and turns that shape back into bytes on the way in.
 */
export type WsCodecName = "msgpack" | "json";

export interface WsCodec {
  readonly name: WsCodecName;
  /** Whether frames go out as binary (msgpack) or text (json) WebSocket messages. */
  readonly binary: boolean;
  encode(message: unknown): Uint8Array | string;
  /** Throws on anything that does not decode; the hub turns that into a 4400 close. */
  decode(data: Buffer, isBinary: boolean): unknown;
}

const B64_KEY = "$b64";

function jsonReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return { [B64_KEY]: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("base64") };
  }
  return value;
}

function jsonReviver(_key: string, value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.length === 1 && keys[0] === B64_KEY && typeof record[B64_KEY] === "string") {
      return new Uint8Array(Buffer.from(record[B64_KEY], "base64"));
    }
  }
  return value;
}

export const msgpackCodec: WsCodec = {
  name: "msgpack",
  binary: true,
  encode: (message) => msgpackEncode(message),
  decode: (data, isBinary) => {
    if (!isBinary) throw new Error("expected a binary frame on a msgpack connection");
    return msgpackDecode(data);
  },
};

export const jsonCodec: WsCodec = {
  name: "json",
  binary: false,
  encode: (message) => JSON.stringify(message, jsonReplacer),
  decode: (data, isBinary) => {
    if (isBinary) throw new Error("expected a text frame on a json connection");
    return JSON.parse(data.toString("utf8"), jsonReviver) as unknown;
  },
};

export const WS_CODECS: Record<WsCodecName, WsCodec> = { msgpack: msgpackCodec, json: jsonCodec };
