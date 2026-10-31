import { expect } from "chai";
import { WingChannelDemuxer, escapeBytes } from "../../../src/plugins/wing/wing-meter-protocol.js";
import {
  NativeTokenizer,
  decodeNativeTokens,
  describeNativeToken,
  encodeFloat,
  encodeInt,
  encodeNodeId,
  encodeNodeIndex,
  encodeNodeDef,
  encodeNodeName,
  encodeString,
  frameControl,
  isNavToken,
  isWriteToken,
  type NativeToken,
} from "../../../src/plugins/wing/wing-native-codec.js";

function str(text: string): number[] {
  const bytes = Buffer.from(text, "utf8");
  return [bytes.length, ...bytes];
}

/** A definition record (0xdf, length word, body) the way the spec lays it out. */
function defRecord(fields: { parent: number; id: number; index: number; name: string; longName: string; flags: number; extra?: number[] }): number[] {
  const body = Buffer.alloc(10);
  body.writeUInt32BE(fields.parent, 0);
  body.writeUInt32BE(fields.id, 4);
  body.writeUInt16BE(fields.index, 8);
  const flags = Buffer.alloc(2);
  flags.writeUInt16BE(fields.flags, 0);
  const all = [...body, ...str(fields.name), ...str(fields.longName), ...flags, ...(fields.extra ?? [])];
  const length = Buffer.alloc(2);
  length.writeUInt16BE(all.length, 0);
  return [0xdf, ...length, ...all];
}

function f32(value: number): number[] {
  const buf = Buffer.alloc(4);
  buf.writeFloatBE(value, 0);
  return [...buf];
}

function i32(value: number): number[] {
  const buf = Buffer.alloc(4);
  buf.writeInt32BE(value, 0);
  return [...buf];
}

describe("wing-native-codec", () => {
  describe("tokenizer", () => {
    it("decodes every value form", () => {
      const tokens = decodeNativeTokens([
        0x00,
        0x01,
        0x3f,
        ...encodeInt(-3),
        ...encodeInt(100000),
        ...encodeFloat(-6.5),
        ...encodeFloat(0.25, true),
        0xd0,
        ...encodeString("Vox"),
        ...encodeString("x".repeat(200)),
      ]);
      expect(tokens.map((t) => [t.kind, "value" in t ? t.value : null])).to.deep.equal([
        ["int", 0],
        ["int", 1],
        ["int", 63],
        ["int", -3],
        ["int", 100000],
        ["float", -6.5],
        ["rawFloat", 0.25],
        ["string", ""],
        ["string", "Vox"],
        ["string", "x".repeat(200)],
      ]);
    });

    it("decodes navigation, actions and requests", () => {
      const tokens = decodeNativeTokens([
        0xda,
        ...encodeNodeName("ch"),
        ...encodeNodeIndex(5),
        ...encodeNodeIndex(300),
        0xdb,
        ...encodeNodeId(0xdeadbeef),
        0xd8,
        0xd9,
        0xff,
        0xdc,
        0xdd,
        0xde,
      ]);
      expect(tokens.map(describeNativeToken)).to.deep.equal([
        "root",
        "name(ch)",
        "index(5)",
        "index(300)",
        "up",
        "id(0xdeadbeef)",
        "click",
        "step(-1)",
        "reqData",
        "reqDef",
        "end",
      ]);
      expect(tokens.filter(isNavToken)).to.have.lengthOf(6);
      expect(tokens.filter(isWriteToken).map((t) => t.kind)).to.deep.equal(["click", "step"]);
    });

    it("keeps each token's exact bytes, so a stream re-encodes byte for byte", () => {
      const stream = [...encodeNodeId(0x01020304), ...encodeFloat(-12), 0xdc, ...encodeString("Kick"), 0xde];
      const tokens = decodeNativeTokens(stream);
      expect([...Buffer.concat(tokens.map((t) => t.bytes))]).to.deep.equal(stream);
    });

    it("produces the same tokens whatever the chunking", () => {
      const stream = [...encodeNodeId(0xcafe0001), ...encodeString("Lead Vocal"), ...defRecord({ parent: 1, id: 2, index: 3, name: "fdr", longName: "Fader", flags: 0x30 })];
      const whole = decodeNativeTokens(stream).map(describeNativeToken);
      const tokenizer = new NativeTokenizer();
      const oneByOne: NativeToken[] = [];
      for (const byte of stream) tokenizer.feedByte(byte, (t) => oneByOne.push(t));
      expect(oneByOne.map(describeNativeToken)).to.deep.equal(whole);
      expect(tokenizer.pendingLength).to.equal(0);
    });

    it("flags the spec's unused bytes 0xe0..0xff as unknown", () => {
      expect(decodeNativeTokens([0xe0, 0xff]).map(describeNativeToken)).to.deep.equal(["unknown(0xe0)", "unknown(0xff)"]);
    });

    it("reports a stream that ends mid-token", () => {
      expect(() => decodeNativeTokens([0xd7, 0x01, 0x02])).to.throw(/mid-token/);
    });
  });

  describe("node definition records", () => {
    it("parses the header, flags and a linear-float range", () => {
      const [token] = decodeNativeTokens(
        defRecord({ parent: 0x11111111, id: 0x22222222, index: 4, name: "trim", longName: "Trim", flags: 0x0211, extra: [...f32(-18), ...f32(18), ...i32(73)] }),
      );
      expect(token.kind).to.equal("def");
      if (token.kind !== "def") return;
      expect(token.def).to.deep.include({
        parent: 0x11111111,
        id: 0x22222222,
        index: 4,
        name: "trim",
        longName: "Trim",
        type: "linf",
        unit: "dB",
        readOnly: true,
        min: -18,
        max: 18,
        steps: 73,
      });
    });

    it("parses enum items", () => {
      const [token] = decodeNativeTokens(
        defRecord({ parent: 1, id: 2, index: 1, name: "mode", longName: "Mode", flags: 0x50, extra: [0, 2, ...str("M"), ...str("Mono"), ...str("ST"), ...str("Stereo")] }),
      );
      expect(token.kind === "def" && token.def?.items).to.deep.equal([
        { value: "M", label: "Mono" },
        { value: "ST", label: "Stereo" },
      ]);
    });

    it("reads a long length when the word length is 0", () => {
      const short = defRecord({ parent: 1, id: 2, index: 1, name: "ch", longName: "Channels", flags: 0x00 });
      const body = short.slice(3);
      const long = [0xdf, 0, 0, ...i32(body.length), ...body];
      const [token] = decodeNativeTokens(long);
      expect(token.kind === "def" && token.def?.name).to.equal("ch");
    });

    it("reports a record whose body is shorter than its fields, instead of misreading it", () => {
      const [token] = decodeNativeTokens([0xdf, 0, 4, 0, 0, 0, 1]);
      expect(token.kind).to.equal("def");
      expect(token.kind === "def" && token.def).to.equal(null);
      expect(token.kind === "def" && token.error).to.match(/record ends/);
    });
  });

  describe("encodeNodeDef", () => {
    it("round-trips every type through the tokenizer", () => {
      const defs = [
        { parent: 1, id: 2, index: 1, name: "ch", longName: "Channels", type: "node" as const, unit: "" },
        { parent: 2, id: 3, index: 2, name: "fdr", longName: "Fader", type: "fader" as const, unit: "dB" },
        { parent: 2, id: 4, index: 3, name: "pan", longName: "Pan", type: "linf" as const, unit: "", min: -100, max: 100, steps: 201 },
        { parent: 2, id: 5, index: 4, name: "mute", longName: "Mute", type: "int" as const, unit: "", min: 0, max: 1 },
        { parent: 2, id: 6, index: 5, name: "mdl", longName: "Model", type: "enum" as const, unit: "", items: [{ value: "GATE", label: "Gate" }] },
        { parent: 2, id: 7, index: 6, name: "name", longName: "Name", type: "string" as const, unit: "", maxLength: 16, readOnly: true },
      ];
      const decoded = decodeNativeTokens(Buffer.concat(defs.map(encodeNodeDef))).map((t) => {
        if (t.kind !== "def" || !t.def) throw new Error(`not a parsed definition: ${describeNativeToken(t)}`);
        const { flags: _flags, ...rest } = t.def;
        return rest;
      });
      expect(decoded).to.deep.equal(defs.map((d) => ({ ...d, readOnly: d.readOnly ?? false })));
    });
  });

  describe("on the wire", () => {
    it("survives ids and floats containing 0xdf through framing and the demuxer", () => {
      const logical = Buffer.concat([encodeNodeId(0x00df00df), encodeFloat(Buffer.from([0xdf, 0xd3, 0x00, 0x00]).readFloatBE(0))]);
      const wire = frameControl(logical);
      const demuxer = new WingChannelDemuxer();
      const out: number[] = [];
      demuxer.feed(wire, (ch, byte) => {
        expect(ch).to.equal(1);
        out.push(byte);
      });
      expect(Buffer.from(out)).to.deep.equal(logical);
      expect(decodeNativeTokens(out).map((t) => t.kind)).to.deep.equal(["navId", "float"]);
    });

    it("decodes the console's sparse escaping, where 0xdf is escaped only before a selector byte", () => {
      // The spec's example: an id with a 0xdf byte followed by 0xaf needs no escape.
      const wire = Buffer.from([0xdf, 0xd1, 0xd7, 0x02, 0xdf, 0xaf, 0x0e, 0xdc]);
      const demuxer = new WingChannelDemuxer();
      const out: number[] = [];
      demuxer.feed(wire, (_ch, byte) => out.push(byte));
      const tokens = decodeNativeTokens(out);
      expect(tokens.map(describeNativeToken)).to.deep.equal(["id(0x02dfaf0e)", "reqData"]);
      expect(escapeBytes(out).length).to.be.greaterThan(out.length);
    });
  });
});
