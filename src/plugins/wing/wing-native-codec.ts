// Token codec for the WING native protocol's control channel (TCP:2222, ChID 1 — "Audio Engine &
// Control"). Pure encode/decode only, no sockets. The outer escape/channel layer is
// wing-meter-protocol.ts's WingChannelDemuxer/escapeBytes: this file sees *logical* bytes.
//
// Token table (WING Remote Protocols, "Binary Stream Format"; length conventions cross-checked with
// libwing's encoder): words are 2 bytes, longs 4, both big endian.
//
//   0x00..0x3f  int 0..63 (0 = false/off, 1 = true/on)   0xd3 int16      0xd4 int32
//   0x40..0x7f  node index 1..64                          0xd5 float32    0xd6 raw float32 (0..1)
//   0x80..0xbf  string of 1..64 bytes                     0xd7 node id (long)
//   0xc0..0xcf  node name of 1..16 bytes                  0xd8 click (toggle)  0xd9 step (signed byte)
//   0xd0        empty string                              0xda root   0xdb up one level
//   0xd1 byte   string of 1..256 bytes                    0xdc data request   0xdd definition request
//   0xd2 word   node index 1..65536                       0xde end of data/definition request
//   0xdf word   node definition record (word = length; 0 means a long length follows)
//
// The node-index and string length offsets (+1) are what the spec's ranges imply and libwing
// encodes; the capture spike (scripts/wing-native-capture.ts) is what confirms them on hardware.

/* eslint-disable no-bitwise -- the WING native protocol is a bit-packed binary format. */
import { encodeChannelSelect, escapeBytes } from "./wing-meter-protocol.js";

export const CONTROL_CHANNEL_ID = 1;

export const TOKEN_EMPTY_STRING = 0xd0;
export const TOKEN_LONG_STRING = 0xd1;
export const TOKEN_WORD_INDEX = 0xd2;
export const TOKEN_INT16 = 0xd3;
export const TOKEN_INT32 = 0xd4;
export const TOKEN_FLOAT = 0xd5;
export const TOKEN_RAW_FLOAT = 0xd6;
export const TOKEN_NODE_ID = 0xd7;
export const TOKEN_CLICK = 0xd8;
export const TOKEN_STEP = 0xd9;
export const TOKEN_ROOT = 0xda;
export const TOKEN_UP = 0xdb;
export const TOKEN_DATA_REQUEST = 0xdc;
export const TOKEN_DEF_REQUEST = 0xdd;
export const TOKEN_REQUEST_END = 0xde;
export const TOKEN_NODE_DEF = 0xdf;

export type NativeNodeType = "node" | "linf" | "logf" | "fader" | "int" | "enum" | "fenum" | "string" | "unknown";

const NODE_TYPES: NativeNodeType[] = ["node", "linf", "logf", "fader", "int", "enum", "fenum", "string"];
const UNITS = ["", "dB", "%", "ms", "Hz", "m", "s", "oct"];

export interface NativeNodeDef {
  parent: number;
  id: number;
  index: number;
  name: string;
  longName: string;
  flags: number;
  type: NativeNodeType;
  unit: string;
  readOnly: boolean;
  /** Type-specific fields when they parsed cleanly: ranges, enum items, max string length. */
  min?: number;
  max?: number;
  steps?: number;
  items?: { value: string | number; label: string }[];
  maxLength?: number;
}

/** One decoded token. `bytes` is its exact logical encoding, so a proxy can re-send it unchanged. */
export type NativeToken =
  | { kind: "int"; value: number; bytes: Buffer }
  | { kind: "float"; value: number; bytes: Buffer }
  | { kind: "rawFloat"; value: number; bytes: Buffer }
  | { kind: "string"; value: string; bytes: Buffer }
  | { kind: "navIndex"; index: number; bytes: Buffer }
  | { kind: "navName"; name: string; bytes: Buffer }
  | { kind: "navId"; id: number; bytes: Buffer }
  | { kind: "root"; bytes: Buffer }
  | { kind: "up"; bytes: Buffer }
  | { kind: "click"; bytes: Buffer }
  | { kind: "step"; delta: number; bytes: Buffer }
  | { kind: "reqData"; bytes: Buffer }
  | { kind: "reqDef"; bytes: Buffer }
  | { kind: "end"; bytes: Buffer }
  | { kind: "def"; def: NativeNodeDef | null; error?: string; bytes: Buffer }
  /** 0xe0..0xff — "not used" in the spec. Seeing one means the stream is not what we think it is. */
  | { kind: "unknown"; byte: number; bytes: Buffer };

export type NativeTokenKind = NativeToken["kind"];

/** A value that sets the current node: any value token, a click (toggle) or a step. */
export function isWriteToken(token: NativeToken): boolean {
  return (
    token.kind === "int" ||
    token.kind === "float" ||
    token.kind === "rawFloat" ||
    token.kind === "string" ||
    token.kind === "click" ||
    token.kind === "step"
  );
}

/** Moves the current node: root, up, by index, by name, or straight to an id. */
export function isNavToken(token: NativeToken): boolean {
  return token.kind === "navIndex" || token.kind === "navName" || token.kind === "navId" || token.kind === "root" || token.kind === "up";
}

export function isValueToken(token: NativeToken): boolean {
  return token.kind === "int" || token.kind === "float" || token.kind === "rawFloat" || token.kind === "string";
}

/**
 * How many bytes a token starting with `first` needs in total, given what has arrived so far.
 * `null` means "not known yet" (a length field is still incomplete).
 */
function tokenLength(bytes: readonly number[]): number | null {
  const first = bytes[0];
  if (first <= 0x7f) return 1;
  if (first <= 0xbf) return 1 + (first - 0x80 + 1);
  if (first <= 0xcf) return 1 + (first - 0xc0 + 1);
  switch (first) {
    case TOKEN_EMPTY_STRING:
      return 1;
    case TOKEN_LONG_STRING:
      return bytes.length < 2 ? null : 2 + bytes[1] + 1;
    case TOKEN_WORD_INDEX:
    case TOKEN_INT16:
      return 3;
    case TOKEN_INT32:
    case TOKEN_FLOAT:
    case TOKEN_RAW_FLOAT:
    case TOKEN_NODE_ID:
      return 5;
    case TOKEN_STEP:
      return 2;
    case TOKEN_NODE_DEF: {
      if (bytes.length < 3) return null;
      const short = (bytes[1] << 8) | bytes[2];
      if (short !== 0) return 3 + short;
      if (bytes.length < 7) return null;
      return 7 + (((bytes[3] << 24) | (bytes[4] << 16) | (bytes[5] << 8) | bytes[6]) >>> 0);
    }
    default:
      // 0xd8, 0xda..0xde, and the unused 0xe0..0xff: single bytes.
      return 1;
  }
}

const utf8 = (buf: Buffer): string => buf.toString("utf8");

function decodeToken(bytes: Buffer): NativeToken {
  const first = bytes[0];
  if (first <= 0x3f) return { kind: "int", value: first, bytes };
  if (first <= 0x7f) return { kind: "navIndex", index: first - 0x40 + 1, bytes };
  if (first <= 0xbf) return { kind: "string", value: utf8(bytes.subarray(1)), bytes };
  if (first <= 0xcf) return { kind: "navName", name: utf8(bytes.subarray(1)), bytes };
  switch (first) {
    case TOKEN_EMPTY_STRING:
      return { kind: "string", value: "", bytes };
    case TOKEN_LONG_STRING:
      return { kind: "string", value: utf8(bytes.subarray(2)), bytes };
    case TOKEN_WORD_INDEX:
      return { kind: "navIndex", index: bytes.readUInt16BE(1) + 1, bytes };
    case TOKEN_INT16:
      return { kind: "int", value: bytes.readInt16BE(1), bytes };
    case TOKEN_INT32:
      return { kind: "int", value: bytes.readInt32BE(1), bytes };
    case TOKEN_FLOAT:
      return { kind: "float", value: bytes.readFloatBE(1), bytes };
    case TOKEN_RAW_FLOAT:
      return { kind: "rawFloat", value: bytes.readFloatBE(1), bytes };
    case TOKEN_NODE_ID:
      return { kind: "navId", id: bytes.readUInt32BE(1), bytes };
    case TOKEN_CLICK:
      return { kind: "click", bytes };
    case TOKEN_STEP:
      return { kind: "step", delta: bytes.readInt8(1), bytes };
    case TOKEN_ROOT:
      return { kind: "root", bytes };
    case TOKEN_UP:
      return { kind: "up", bytes };
    case TOKEN_DATA_REQUEST:
      return { kind: "reqData", bytes };
    case TOKEN_DEF_REQUEST:
      return { kind: "reqDef", bytes };
    case TOKEN_REQUEST_END:
      return { kind: "end", bytes };
    case TOKEN_NODE_DEF: {
      const headerLength = bytes[1] === 0 && bytes[2] === 0 ? 7 : 3;
      try {
        return { kind: "def", def: parseNodeDefBody(bytes.subarray(headerLength)), bytes };
      } catch (err) {
        return { kind: "def", def: null, error: err instanceof Error ? err.message : String(err), bytes };
      }
    }
    default:
      return { kind: "unknown", byte: first, bytes };
  }
}

/** Sequential big-endian reader that throws on overrun, so a malformed record is reported, not misread. */
class Reader {
  private offset = 0;
  constructor(private readonly buf: Buffer) {}
  get remaining(): number {
    return this.buf.length - this.offset;
  }
  private take(n: number): Buffer {
    if (this.offset + n > this.buf.length) throw new RangeError(`record ends after ${this.buf.length} bytes, needed ${this.offset + n}`);
    const out = this.buf.subarray(this.offset, this.offset + n);
    this.offset += n;
    return out;
  }
  u8(): number {
    return this.take(1)[0];
  }
  u16(): number {
    return this.take(2).readUInt16BE(0);
  }
  u32(): number {
    return this.take(4).readUInt32BE(0);
  }
  i32(): number {
    return this.take(4).readInt32BE(0);
  }
  f32(): number {
    return this.take(4).readFloatBE(0);
  }
  str(): string {
    return utf8(this.take(this.u8()));
  }
}

/**
 * Parses a node definition record body: parent.l, id.l, index.w, name, long name, flags.w, then the
 * type-specific fields (spec, "Node Definition Response"). Flags: b0-3 unit, b4-7 type, b9 read-only.
 */
export function parseNodeDefBody(body: Buffer): NativeNodeDef {
  const r = new Reader(body);
  const parent = r.u32();
  const id = r.u32();
  const index = r.u16();
  const name = r.str();
  const longName = r.str();
  const flags = r.u16();
  const type = NODE_TYPES[(flags >> 4) & 0x0f] ?? "unknown";
  const def: NativeNodeDef = {
    parent,
    id,
    index,
    name,
    longName,
    flags,
    type,
    unit: UNITS[flags & 0x0f] ?? `unit${flags & 0x0f}`,
    readOnly: (flags & 0x200) !== 0,
  };
  switch (type) {
    case "linf":
    case "logf":
      def.min = r.f32();
      def.max = r.f32();
      def.steps = r.i32();
      break;
    case "int":
      def.min = r.i32();
      def.max = r.i32();
      break;
    case "enum": {
      const count = r.u16();
      def.items = Array.from({ length: count }, () => ({ value: r.str(), label: r.str() }));
      break;
    }
    case "fenum": {
      const count = r.u16();
      def.items = Array.from({ length: count }, () => ({ value: r.f32(), label: r.str() }));
      break;
    }
    case "string":
      def.maxLength = r.u16();
      break;
    default:
      break;
  }
  return def;
}

/**
 * Streaming tokenizer for one direction of the control channel. Feed it logical bytes (the output of
 * WingChannelDemuxer for ChID 1) in any chunking; `onToken` fires once per complete token.
 */
export class NativeTokenizer {
  private pending: number[] = [];
  private needed: number | null = null;

  reset(): void {
    this.pending = [];
    this.needed = null;
  }

  /** Bytes of a token that has started but not finished — non-zero means a token is mid-flight. */
  get pendingLength(): number {
    return this.pending.length;
  }

  feedByte(byte: number, onToken: (token: NativeToken) => void): void {
    this.pending.push(byte);
    if (this.needed === null) {
      this.needed = tokenLength(this.pending);
    }
    if (this.needed !== null && this.pending.length >= this.needed) {
      const bytes = Buffer.from(this.pending);
      this.pending = [];
      this.needed = null;
      onToken(decodeToken(bytes));
    }
  }

  feed(bytes: Iterable<number>, onToken: (token: NativeToken) => void): void {
    for (const byte of bytes) this.feedByte(byte, onToken);
  }
}

/** Decodes a complete logical byte sequence; throws if it ends mid-token. For tests and tooling. */
export function decodeNativeTokens(bytes: Iterable<number>): NativeToken[] {
  const tokenizer = new NativeTokenizer();
  const tokens: NativeToken[] = [];
  tokenizer.feed(bytes, (token) => tokens.push(token));
  if (tokenizer.pendingLength > 0) throw new RangeError(`stream ends mid-token (${tokenizer.pendingLength} bytes pending)`);
  return tokens;
}

// --- encoders (logical bytes; wrap with frameControl() to put them on the wire) ---

export function encodeNodeId(id: number): Buffer {
  const buf = Buffer.alloc(5);
  buf[0] = TOKEN_NODE_ID;
  buf.writeUInt32BE(id >>> 0, 1);
  return buf;
}

export function encodeInt(value: number): Buffer {
  if (!Number.isInteger(value)) throw new RangeError(`not an integer: ${value}`);
  if (value >= 0 && value <= 0x3f) return Buffer.from([value]);
  if (value >= -0x8000 && value <= 0x7fff) {
    const int16 = Buffer.alloc(3);
    int16[0] = TOKEN_INT16;
    int16.writeInt16BE(value, 1);
    return int16;
  }
  const int32 = Buffer.alloc(5);
  int32[0] = TOKEN_INT32;
  int32.writeInt32BE(value, 1);
  return int32;
}

export function encodeFloat(value: number, raw = false): Buffer {
  const buf = Buffer.alloc(5);
  buf[0] = raw ? TOKEN_RAW_FLOAT : TOKEN_FLOAT;
  buf.writeFloatBE(value, 1);
  return buf;
}

export function encodeString(value: string): Buffer {
  const text = Buffer.from(value, "utf8");
  if (text.length === 0) return Buffer.from([TOKEN_EMPTY_STRING]);
  if (text.length <= 64) return Buffer.concat([Buffer.from([0x80 + text.length - 1]), text]);
  if (text.length <= 256) return Buffer.concat([Buffer.from([TOKEN_LONG_STRING, text.length - 1]), text]);
  throw new RangeError(`string too long for the native protocol (${text.length} bytes, max 256)`);
}

export function encodeNodeName(name: string): Buffer {
  const text = Buffer.from(name, "utf8");
  if (text.length < 1 || text.length > 16) throw new RangeError(`node name must be 1..16 bytes: "${name}"`);
  return Buffer.concat([Buffer.from([0xc0 + text.length - 1]), text]);
}

export function encodeNodeIndex(index: number): Buffer {
  if (index >= 1 && index <= 64) return Buffer.from([0x40 + index - 1]);
  if (index >= 1 && index <= 65536) {
    const buf = Buffer.alloc(3);
    buf[0] = TOKEN_WORD_INDEX;
    buf.writeUInt16BE(index - 1, 1);
    return buf;
  }
  throw new RangeError(`node index out of range: ${index}`);
}

function lengthPrefixed(text: string): Buffer {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length > 255) throw new RangeError(`name too long for a definition record: "${text}"`);
  return Buffer.concat([Buffer.from([bytes.length]), bytes]);
}

/**
 * Encodes a node definition record (0xdf, length, body) — the inverse of parseNodeDefBody. Used by
 * the test console and by anything that answers definition requests from a cache.
 */
export function encodeNodeDef(def: Omit<NativeNodeDef, "flags" | "readOnly"> & { readOnly?: boolean }): Buffer {
  const typeCode = NODE_TYPES.indexOf(def.type);
  if (typeCode < 0) throw new RangeError(`cannot encode node type "${def.type}"`);
  const unitCode = Math.max(0, UNITS.indexOf(def.unit));
  const head = Buffer.alloc(10);
  head.writeUInt32BE(def.parent >>> 0, 0);
  head.writeUInt32BE(def.id >>> 0, 4);
  head.writeUInt16BE(def.index, 8);
  const flags = Buffer.alloc(2);
  flags.writeUInt16BE(unitCode | (typeCode << 4) | (def.readOnly ? 0x200 : 0), 0);
  const parts = [head, lengthPrefixed(def.name), lengthPrefixed(def.longName), flags];
  const f32 = (v: number) => {
    const b = Buffer.alloc(4);
    b.writeFloatBE(v, 0);
    return b;
  };
  const i32 = (v: number) => {
    const b = Buffer.alloc(4);
    b.writeInt32BE(v, 0);
    return b;
  };
  const u16 = (v: number) => {
    const b = Buffer.alloc(2);
    b.writeUInt16BE(v, 0);
    return b;
  };
  switch (def.type) {
    case "linf":
    case "logf":
      parts.push(f32(def.min ?? 0), f32(def.max ?? 1), i32(def.steps ?? 0));
      break;
    case "int":
      parts.push(i32(def.min ?? 0), i32(def.max ?? 1));
      break;
    case "enum":
      parts.push(u16(def.items?.length ?? 0));
      for (const item of def.items ?? []) parts.push(lengthPrefixed(String(item.value)), lengthPrefixed(item.label));
      break;
    case "fenum":
      parts.push(u16(def.items?.length ?? 0));
      for (const item of def.items ?? []) parts.push(f32(Number(item.value)), lengthPrefixed(item.label));
      break;
    case "string":
      parts.push(u16(def.maxLength ?? 16));
      break;
    default:
      break;
  }
  const body = Buffer.concat(parts);
  if (body.length <= 0xffff) return Buffer.concat([Buffer.from([TOKEN_NODE_DEF]), u16(body.length), body]);
  const long = Buffer.alloc(4);
  long.writeUInt32BE(body.length, 0);
  return Buffer.concat([Buffer.from([TOKEN_NODE_DEF, 0, 0]), long, body]);
}

/** Puts logical control-channel bytes on the wire: select ChID 1, then the escaped payload. */
export function frameControl(logical: Buffer | number[]): Buffer {
  return Buffer.concat([encodeChannelSelect(CONTROL_CHANNEL_ID), escapeBytes(logical)]);
}

/** One-line human form of a token, for logs and the capture tool. */
export function describeNativeToken(token: NativeToken): string {
  switch (token.kind) {
    case "int":
    case "float":
    case "rawFloat":
      return `${token.kind}(${token.value})`;
    case "string":
      return `string(${JSON.stringify(token.value)})`;
    case "navIndex":
      return `index(${token.index})`;
    case "navName":
      return `name(${token.name})`;
    case "navId":
      return `id(0x${token.id.toString(16).padStart(8, "0")})`;
    case "step":
      return `step(${token.delta})`;
    case "unknown":
      return `unknown(0x${token.byte.toString(16)})`;
    case "def":
      return token.def
        ? `def(${token.def.name} id=0x${token.def.id.toString(16)} parent=0x${token.def.parent.toString(16)} ${token.def.type})`
        : `def(unparsed: ${token.error ?? "?"})`;
    default:
      return token.kind;
  }
}
