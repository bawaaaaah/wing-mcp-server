import { expect } from "chai";
import {
  encodeChannelSelect,
  encodeMeterCollection,
  encodeReportId,
  encodeUdpPortAnnouncement,
  escapeBytes,
  ESCAPE,
  mergeMeterSnapshots,
  parseMeterUdpPacket,
  TOKEN_COLLECTION_END,
  TOKEN_COLLECTION_START,
  TOKEN_REPORT_ID,
  TOKEN_UDP_PORT,
  WingChannelDemuxer,
} from "../../../src/plugins/wing/wing-meter-protocol.js";
import type { MeterFrame, MeterGroupType, MeterSnapshot } from "../../../src/plugins/wing/wing-meter-types.js";

describe("wing-meter-protocol", () => {
  describe("tokens", () => {
    it("exposes the expected constant values", () => {
      expect(ESCAPE).to.equal(0xdf);
      expect(TOKEN_UDP_PORT).to.equal(0xd3);
      expect(TOKEN_REPORT_ID).to.equal(0xd4);
      expect(TOKEN_COLLECTION_START).to.equal(0xdc);
      expect(TOKEN_COLLECTION_END).to.equal(0xde);
    });
  });

  describe("encodeChannelSelect", () => {
    it("encodes the meter channel (3) select sequence", () => {
      expect(encodeChannelSelect(3)).to.deep.equal(Buffer.from([0xdf, 0xd3]));
    });

    it("encodes an arbitrary channel id", () => {
      expect(encodeChannelSelect(0)).to.deep.equal(Buffer.from([0xdf, 0xd0]));
    });
  });

  describe("escapeBytes", () => {
    it("passes non-0xdf bytes through unchanged", () => {
      expect(escapeBytes([1, 2, 3])).to.deep.equal(Buffer.from([1, 2, 3]));
    });

    it("escapes a literal 0xdf byte as 0xdf 0xde", () => {
      expect(escapeBytes([1, 0xdf, 2])).to.deep.equal(Buffer.from([1, 0xdf, 0xde, 2]));
    });

    it("accepts a Buffer as input", () => {
      expect(escapeBytes(Buffer.from([0xdf]))).to.deep.equal(Buffer.from([0xdf, 0xde]));
    });
  });

  describe("encodeMeterCollection", () => {
    it("matches the worked example from the protocol spec", () => {
      const encoded = encodeMeterCollection([
        { type: "channel", indices: [1, 2, 9] },
        { type: "fx", indices: [5] },
      ]);
      expect(encoded).to.deep.equal(Buffer.from([0xdc, 0xa0, 0x00, 0x01, 0x08, 0xa6, 0x04, 0xde]));
    });

    it("encodes index-less groups (monitor/rta) with just their token", () => {
      const encoded = encodeMeterCollection([{ type: "monitor" }, { type: "rta" }]);
      expect(encoded).to.deep.equal(Buffer.from([0xdc, 0xa9, 0xaa, 0xde]));
    });

    it("throws a RangeError when an index is out of range", () => {
      expect(() => encodeMeterCollection([{ type: "channel", indices: [0] }])).to.throw(RangeError);
      expect(() => encodeMeterCollection([{ type: "channel", indices: [129] }])).to.throw(RangeError);
    });

    it("throws a RangeError when a required index list is missing or empty", () => {
      expect(() => encodeMeterCollection([{ type: "bus" }])).to.throw(RangeError);
      expect(() => encodeMeterCollection([{ type: "bus", indices: [] }])).to.throw(RangeError);
    });
  });

  describe("encodeReportId", () => {
    it("encodes the token followed by 4 big-endian bytes", () => {
      expect(encodeReportId(0x01020304)).to.deep.equal(Buffer.from([0xd4, 0x01, 0x02, 0x03, 0x04]));
    });

    it("wraps values via >>> 0 for negative / oversized inputs", () => {
      expect(encodeReportId(0)).to.deep.equal(Buffer.from([0xd4, 0x00, 0x00, 0x00, 0x00]));
    });
  });

  describe("encodeUdpPortAnnouncement", () => {
    it("encodes the token followed by a big-endian 16-bit port", () => {
      expect(encodeUdpPortAnnouncement(14135)).to.deep.equal(Buffer.from([0xd3, 0x37, 0x37]));
    });
  });

  describe("WingChannelDemuxer", () => {
    it("round-trips a channel-select sequence followed by plain data", () => {
      const demuxer = new WingChannelDemuxer();
      const received: Array<{ chId: number; byte: number }> = [];
      demuxer.feed(Buffer.from([0xdf, 0xd3, 0x01, 0x02]), (chId, byte) => received.push({ chId, byte }));
      expect(received).to.deep.equal([
        { chId: 3, byte: 0x01 },
        { chId: 3, byte: 0x02 },
      ]);
    });

    it("round-trips a sequence containing an escaped 0xdf byte via escapeBytes", () => {
      const payload = [0x01, 0xdf, 0x02, 0x03];
      const wire = Buffer.concat([Buffer.from([0xdf, 0xd3]), escapeBytes(payload)]);

      const demuxer = new WingChannelDemuxer();
      const received: number[] = [];
      demuxer.feed(wire, (chId, byte) => {
        expect(chId).to.equal(3);
        received.push(byte);
      });

      expect(received).to.deep.equal(payload);
    });

    it("handles the escape sequence split across separate feed() calls", () => {
      const demuxer = new WingChannelDemuxer();
      const received: number[] = [];
      const onByte = (_chId: number, byte: number) => received.push(byte);

      demuxer.feed(Buffer.from([0xdf, 0xd3, 0x01, 0xdf]), onByte);
      demuxer.feed(Buffer.from([0xde, 0x02]), onByte);

      expect(received).to.deep.equal([0x01, 0xdf, 0x02]);
    });

    it("interprets an escape followed by a non-0xde byte as a channel reselect (no data emitted)", () => {
      const demuxer = new WingChannelDemuxer();
      const received: Array<{ chId: number; byte: number }> = [];
      demuxer.feed(Buffer.from([0xdf, 0xd0, 0x11, 0xdf, 0xd5, 0x22]), (chId, byte) => received.push({ chId, byte }));
      expect(received).to.deep.equal([
        { chId: 0, byte: 0x11 },
        { chId: 5, byte: 0x22 },
      ]);
    });
  });

  describe("parseMeterUdpPacket", () => {
    it("parses a plain 8-word group (e.g. channel) with correct dB scaling", () => {
      const reportId = 0xdeadbeef;
      // Level/key words: dB = word/256 (1, 2, -1, 0, 0.5, -0.5). Gain-reduction words (gateGain,
      // dynGain) use a different, documented scaling instead — see toGainReductionDb in
      // wing-meter-protocol.ts: dB = -(word/256)*20 (the protocol doc's DEFAULT full-scale range),
      // with the sign flipped from level words since a *positive* raw word means *more* reduction.
      const words = [256, 512, -256, 0, 128, 64, -128, -64];
      const buf = buildPacket(reportId, words);

      const snapshot = parseMeterUdpPacket(buf, [{ type: "channel", index: 1 }]);
      expect(snapshot).to.not.equal(null);
      expect(snapshot!.reportId).to.equal(reportId);
      expect(snapshot!.frames).to.have.length(1);
      const frame = snapshot!.frames[0];
      expect(frame.type).to.equal("channel");
      if (frame.type === "channel") {
        expect(frame.index).to.equal(1);
        expect(frame.inputL_dB).to.equal(1);
        expect(frame.inputR_dB).to.equal(2);
        expect(frame.outputL_dB).to.equal(-1);
        expect(frame.outputR_dB).to.equal(0);
        expect(frame.gateKey_dB).to.equal(0.5);
        expect(frame.gateGain_dB).to.equal(-5);
        expect(frame.dynKey_dB).to.equal(-0.5);
        expect(frame.dynGain_dB).to.equal(5);
      }
    });

    it("parses an fx group with the distinct state-word dB scaling", () => {
      const reportId = 42;
      // 4 level words (÷256) then 6 state words (×6/2048)
      const words = [256, 256, 256, 256, 2048, 1024, 0, -1024, -2048, 512];
      const buf = buildPacket(reportId, words);

      const snapshot = parseMeterUdpPacket(buf, [{ type: "fx", index: 5 }]);
      expect(snapshot).to.not.equal(null);
      const frame = snapshot!.frames[0];
      expect(frame.type).to.equal("fx");
      if (frame.type === "fx") {
        expect(frame.index).to.equal(5);
        expect(frame.inputL_dB).to.equal(1);
        expect(frame.inputR_dB).to.equal(1);
        expect(frame.outputL_dB).to.equal(1);
        expect(frame.outputR_dB).to.equal(1);
        expect(frame.state).to.have.length(6);
        expect(frame.state[0]).to.be.closeTo(6.0, 1e-9);
        expect(frame.state[1]).to.be.closeTo(3.0, 1e-9);
        expect(frame.state[2]).to.equal(0);
        expect(frame.state[3]).to.be.closeTo(-3.0, 1e-9);
        expect(frame.state[4]).to.be.closeTo(-6.0, 1e-9);
        expect(frame.state[5]).to.be.closeTo(1.5, 1e-9);
      }
    });

    it("parses multiple groups in order, including index-less ones", () => {
      const reportId = 7;
      const dcaWords = [256, 512, 768, 1024];
      const monitorWords = [256, -256, 512, -512, 768, -768];
      const buf = buildPacket(reportId, [...dcaWords, ...monitorWords]);

      const snapshot = parseMeterUdpPacket(buf, [{ type: "dca", index: 2 }, { type: "monitor" }]);
      expect(snapshot).to.not.equal(null);
      expect(snapshot!.frames).to.have.length(2);
      expect(snapshot!.frames[0].type).to.equal("dca");
      expect(snapshot!.frames[1].type).to.equal("monitor");
    });

    it("returns null (does not throw) on a truncated buffer", () => {
      const reportId = 1;
      const buf = buildPacket(reportId, [1, 2, 3]); // fewer than the 8 words "channel" expects
      const result = parseMeterUdpPacket(buf, [{ type: "channel", index: 1 }]);
      expect(result).to.equal(null);
    });

    it("returns null on an empty buffer", () => {
      expect(parseMeterUdpPacket(Buffer.alloc(0), [{ type: "channel", index: 1 }])).to.equal(null);
    });
  });

  describe("mergeMeterSnapshots", () => {
    type ChannelFrameOverrides = Partial<{
      inputL_dB: number;
      inputR_dB: number;
      outputL_dB: number;
      outputR_dB: number;
      gateKey_dB: number;
      gateGain_dB: number;
      dynKey_dB: number;
      dynGain_dB: number;
    }>;
    function channelFrame(overrides: ChannelFrameOverrides): MeterFrame {
      return {
        type: "channel",
        index: 1,
        inputL_dB: -20,
        inputR_dB: -20,
        outputL_dB: -20,
        outputR_dB: -20,
        gateKey_dB: -30,
        gateGain_dB: 0,
        dynKey_dB: -30,
        dynGain_dB: 0,
        ...overrides,
      };
    }
    function snapshotOf(...frames: MeterFrame[]): MeterSnapshot {
      return { reportId: 1, receivedAt: 0, frames };
    }

    it("keeps a deep transient gain-reduction dip even though the last sample in the window released back to 0", () => {
      // This is the exact scenario a naive "just keep the latest sample" throttle gets wrong: a
      // compressor grabs 5dB for one sample, then fully releases before the window's last sample —
      // "latest" would report 0dB of reduction even though real, sizeable compression just happened.
      const snapshots = [
        snapshotOf(channelFrame({ dynGain_dB: 0 })),
        snapshotOf(channelFrame({ dynGain_dB: -5 })),
        snapshotOf(channelFrame({ dynGain_dB: 0 })),
      ];
      const merged = mergeMeterSnapshots(snapshots);
      const frame = merged.frames[0];
      expect(frame.type).to.equal("channel");
      if (frame.type === "channel") {
        expect(frame.dynGain_dB).to.equal(-5);
      }
    });

    it("keeps the loudest peak level across the window rather than whatever the last sample happened to read", () => {
      const snapshots = [snapshotOf(channelFrame({ inputL_dB: -20 })), snapshotOf(channelFrame({ inputL_dB: -3 })), snapshotOf(channelFrame({ inputL_dB: -18 }))];
      const merged = mergeMeterSnapshots(snapshots);
      const frame = merged.frames[0];
      expect(frame.type).to.equal("channel");
      if (frame.type === "channel") {
        expect(frame.inputL_dB).to.equal(-3);
      }
    });

    it("keeps the biggest-magnitude value (boost or cut) for a channelV2 automixGain_dB swing", () => {
      const v2Frame = (automixGain_dB: number): MeterFrame => ({
        type: "channelV2",
        index: 1,
        inputL_dB: -20,
        inputR_dB: -20,
        outputL_dB: -20,
        outputR_dB: -20,
        gateKey_dB: -30,
        gateGain_dB: 0,
        gateLed: false,
        dynKey_dB: -30,
        dynGain_dB: 0,
        dynActive: false,
        automixGain_dB,
      });
      const merged = mergeMeterSnapshots([snapshotOf(v2Frame(1)), snapshotOf(v2Frame(-4)), snapshotOf(v2Frame(2))]);
      const frame = merged.frames[0];
      expect(frame.type).to.equal("channelV2");
      if (frame.type === "channelV2") {
        expect(frame.automixGain_dB).to.equal(-4);
      }
    });

    it("takes the peak across every band for an rta snapshot", () => {
      const merged = mergeMeterSnapshots([
        snapshotOf({ type: "rta", bands_dB: [-40, -10, -60] }),
        snapshotOf({ type: "rta", bands_dB: [-30, -20, -5] }),
      ]);
      const frame = merged.frames[0];
      expect(frame.type).to.equal("rta");
      if (frame.type === "rta") {
        expect(frame.bands_dB).to.deep.equal([-30, -10, -5]);
      }
    });

    it("passes a single snapshot through unchanged", () => {
      const only = snapshotOf(channelFrame({ dynGain_dB: -2 }));
      expect(mergeMeterSnapshots([only])).to.deep.equal(only);
    });

    it("takes the last snapshot's reportId/receivedAt", () => {
      const merged = mergeMeterSnapshots([
        { reportId: 1, receivedAt: 100, frames: [channelFrame({})] },
        { reportId: 2, receivedAt: 200, frames: [channelFrame({})] },
      ]);
      expect(merged.reportId).to.equal(2);
      expect(merged.receivedAt).to.equal(200);
    });
  });
});

function buildPacket(reportId: number, words: number[]): Buffer {
  const buf = Buffer.alloc(4 + words.length * 2);
  buf.writeUInt32BE(reportId >>> 0, 0);
  let offset = 4;
  for (const word of words) {
    buf.writeInt16BE(word, offset);
    offset += 2;
  }
  return buf;
}

// keep TS from complaining about an unused type-only import if the file is later trimmed
void (null as unknown as MeterGroupType);
