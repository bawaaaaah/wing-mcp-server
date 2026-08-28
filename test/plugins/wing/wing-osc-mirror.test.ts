import { expect } from "chai";
import dgram from "node:dgram";
import type { AddressInfo } from "node:net";
import osc from "osc";
import { WingValueError } from "../../../src/plugins/wing/wing-errors.js";
import { WingOscMirror } from "../../../src/plugins/wing/wing-osc-mirror.js";

/** Polls `condition` instead of sleeping a fixed amount, for asserting async UDP delivery. */
async function waitFor(condition: () => boolean, timeoutMs = 2000, intervalMs = 20): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** Binds a UDP listener on loopback and records every datagram it receives. */
async function createUdpListener(): Promise<{ port: number; received: Buffer[]; close: () => Promise<void> }> {
  const socket = dgram.createSocket("udp4");
  const received: Buffer[] = [];
  socket.on("message", (msg) => received.push(msg));
  await new Promise<void>((resolve) => socket.bind(0, "127.0.0.1", resolve));
  const port = (socket.address() as AddressInfo).port;
  return {
    port,
    received,
    close: () => new Promise<void>((resolve) => socket.close(() => resolve())),
  };
}

describe("WingOscMirror", () => {
  let mirror: WingOscMirror;

  beforeEach(() => {
    mirror = new WingOscMirror();
  });

  afterEach(() => {
    mirror.close();
  });

  describe("getStatus()", () => {
    it("starts disabled with empty target and zeroed counters", () => {
      expect(mirror.getStatus()).to.deep.equal({
        enabled: false,
        host: "",
        port: 0,
        messagesSent: 0,
        bytesSent: 0,
        lastError: null,
      });
    });
  });

  describe("configure()", () => {
    it("rejects a call with no fields at all", () => {
      expect(() => mirror.configure({})).to.throw(WingValueError, /at least one/);
    });

    it("rejects enabling without a host", () => {
      expect(() => mirror.configure({ enabled: true, port: 9000 })).to.throw(WingValueError, /host/);
    });

    it("rejects enabling with an out-of-range port", () => {
      expect(() => mirror.configure({ enabled: true, host: "127.0.0.1", port: 0 })).to.throw(WingValueError, /port/);
      expect(() => mirror.configure({ enabled: true, host: "127.0.0.1", port: 70000 })).to.throw(WingValueError, /port/);
    });

    it("merges a partial update onto the existing config rather than replacing it", () => {
      mirror.configure({ enabled: true, host: "127.0.0.1", port: 9000 });
      const status = mirror.configure({ port: 9001 });
      expect(status).to.deep.include({ enabled: true, host: "127.0.0.1", port: 9001 });
    });

    it("allows disabling without host/port (nothing to validate once turned off)", () => {
      mirror.configure({ enabled: true, host: "127.0.0.1", port: 9000 });
      const status = mirror.configure({ enabled: false });
      expect(status.enabled).to.equal(false);
    });
  });

  describe("mirrorOscMessage()", () => {
    it("does nothing while disabled", async () => {
      const listener = await createUdpListener();
      try {
        mirror.mirrorOscMessage("/ch/1/fdr", [{ type: "f", value: -6 }]);
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(listener.received).to.have.length(0);
      } finally {
        await listener.close();
      }
    });

    it("re-encodes and forwards the message as a real OSC packet, byte-for-byte decodable", async () => {
      const listener = await createUdpListener();
      try {
        mirror.configure({ enabled: true, host: "127.0.0.1", port: listener.port });
        mirror.mirrorOscMessage("/ch/1/fdr", [{ type: "f", value: -6 }]);
        await waitFor(() => listener.received.length === 1);
        const decoded = osc.readMessage(listener.received[0]);
        expect(decoded.address).to.equal("/ch/1/fdr");
        expect(decoded.args).to.be.closeTo(-6, 0.001);
        await waitFor(() => mirror.getStatus().messagesSent === 1);
        expect(mirror.getStatus().bytesSent).to.equal(listener.received[0].length);
      } finally {
        await listener.close();
      }
    });
  });

  describe("mirrorRawBuffer()", () => {
    it("does nothing while disabled", async () => {
      const listener = await createUdpListener();
      try {
        mirror.mirrorRawBuffer(Buffer.from([1, 2, 3]));
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(listener.received).to.have.length(0);
      } finally {
        await listener.close();
      }
    });

    it("forwards the exact bytes received, unmodified", async () => {
      const listener = await createUdpListener();
      try {
        mirror.configure({ enabled: true, host: "127.0.0.1", port: listener.port });
        const payload = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
        mirror.mirrorRawBuffer(payload);
        await waitFor(() => listener.received.length === 1);
        expect(listener.received[0]).to.deep.equal(payload);
      } finally {
        await listener.close();
      }
    });

    it("stops sending once disabled again", async () => {
      const listener = await createUdpListener();
      try {
        mirror.configure({ enabled: true, host: "127.0.0.1", port: listener.port });
        mirror.mirrorRawBuffer(Buffer.from([1]));
        await waitFor(() => listener.received.length === 1);

        mirror.configure({ enabled: false });
        mirror.mirrorRawBuffer(Buffer.from([2]));
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(listener.received).to.have.length(1);
      } finally {
        await listener.close();
      }
    });
  });
});
