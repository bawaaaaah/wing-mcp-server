// Test-only fake WING console for the metering protocol: a real net.Server (TCP:2222-equivalent
// control channel) + a real dgram.Socket (UDP level-meter stream). Implements just enough of the
// server-side state machine to drive wing-meter-client.test.ts against real loopback sockets — no
// mocking of net/dgram.
//
// Handshake understood (mirrors wing-meter-protocol.ts exactly, server side):
//   0xdf 0xd3            -> select the meter channel (ChID 3); everything below arrives as
//                            already-demultiplexed/de-escaped bytes on that channel.
//   0xd3 <hi> <lo>        -> remember the client's UDP listen port.
//   0xd4 <4 bytes BE>      -> remember the report id. Every occurrence (first or repeat) counts as
//                            a keepalive and resets the keepalive-timeout watchdog.
//   0xdc ...groups... 0xde -> remember the requested (flattened) meter groups.
//
// Once port + reportId + groups are all known, synthetic frames are sent to the client's UDP port
// on a short interval. If no keepalive (0xd4) arrives within `keepaliveTimeoutMs`, sending stops —
// this is what lets tests assert that WingMeterClient's renewal loop keeps the stream alive.

/* eslint-disable no-bitwise -- it encodes the bit-packed WING metering protocol. */
import net from "node:net";
import dgram from "node:dgram";
import {
  METER_GROUP_TABLE,
  TOKEN_COLLECTION_END,
  TOKEN_COLLECTION_START,
  TOKEN_REPORT_ID,
  TOKEN_UDP_PORT,
  WingChannelDemuxer,
} from "../../../src/plugins/wing/wing-meter-protocol.js";
import type { MeterGroupType } from "../../../src/plugins/wing/wing-meter-types.js";

const METER_CHANNEL_ID = 3;
const DEFAULT_METER_INTERVAL_MS = 50;
const DEFAULT_KEEPALIVE_TIMEOUT_MS = 5000;

const TOKEN_TO_GROUP_TYPE: Map<number, MeterGroupType> = new Map(
  (Object.entries(METER_GROUP_TABLE) as [MeterGroupType, { token: number }][]).map(([type, meta]) => [
    meta.token,
    type,
  ]),
);

interface FlatGroup {
  type: MeterGroupType;
  index?: number;
}

interface PendingField {
  kind: "port" | "reportId";
  bytes: number[];
  total: number;
}

export interface WingMeterSimulatorOptions {
  /** How long to wait for a keepalive (repeat 0xd4) before stopping the synthetic UDP stream. Default 5000 (matches the real console's ~5s window), overridable for fast tests. */
  keepaliveTimeoutMs?: number;
  /** Interval between synthetic UDP frames while streaming. Default 50 (~20Hz, matches the real console). */
  meterIntervalMs?: number;
}

/**
 * Fake WING console metering endpoint for tests: real TCP control server + real UDP meter sender.
 */
export class WingMeterSimulator {
  private readonly keepaliveTimeoutMs: number;
  private readonly meterIntervalMs: number;

  private tcpServer: net.Server | null = null;
  private udpSocket: dgram.Socket | null = null;
  private currentSocket: net.Socket | null = null;

  private readonly demuxer = new WingChannelDemuxer();

  private clientAddress: string | null = null;
  private clientUdpPort: number | null = null;
  private reportId: number | null = null;
  private groups: FlatGroup[] = [];

  private receivedKeepalivesCount = 0;
  private lastCollectionBytesValue: Buffer | null = null;

  private inCollection = false;
  private collectionRawBytes: number[] = [];
  private collectionGroupsBuilder: FlatGroup[] = [];
  private currentCollectionType: MeterGroupType | null = null;
  private pendingField: PendingField | null = null;

  private meterInterval: NodeJS.Timeout | null = null;
  private keepaliveWatchdog: NodeJS.Timeout | null = null;
  private wavePhase = 0;

  constructor(opts?: WingMeterSimulatorOptions) {
    this.keepaliveTimeoutMs = opts?.keepaliveTimeoutMs ?? DEFAULT_KEEPALIVE_TIMEOUT_MS;
    this.meterIntervalMs = opts?.meterIntervalMs ?? DEFAULT_METER_INTERVAL_MS;
  }

  get receivedKeepalives(): number {
    return this.receivedKeepalivesCount;
  }

  get lastCollectionBytes(): Buffer | null {
    return this.lastCollectionBytesValue;
  }

  /** The report id most recently announced by the client, as read off the control channel. */
  get currentReportId(): number | null {
    return this.reportId;
  }

  /** Simulates the console dropping the metering TCP connection (reboot, network blip, ...) —
   * destroys the current client connection without touching the listening server, so a subsequent
   * reconnect attempt from the client is accepted as a brand new connection. */
  forceDisconnect(): void {
    this.currentSocket?.destroy();
  }

  async start(): Promise<{ tcpPort: number }> {
    const udpSocket = dgram.createSocket("udp4");
    await new Promise<void>((resolve, reject) => {
      udpSocket.once("error", reject);
      udpSocket.bind(0, "127.0.0.1", () => resolve());
    });
    this.udpSocket = udpSocket;

    const tcpServer = net.createServer((socket) => {
      this.clientAddress = socket.remoteAddress ?? "127.0.0.1";
      this.currentSocket = socket;
      socket.on("data", (chunk: Buffer) => {
        this.demuxer.feed(chunk, (chId, byte) => {
          if (chId === METER_CHANNEL_ID) {
            this.handleChannel3Byte(byte);
          }
        });
      });
      socket.on("error", (err) => {
        console.error("wing-meter-simulator: connection error:", err);
      });
      socket.on("close", () => {
        if (this.currentSocket === socket) {
          this.currentSocket = null;
        }
        // A fresh reconnect starts renegotiating port/reportId/groups from scratch — stale state
        // from the dropped connection must not let a stray retained keepalive/frame slip through.
        this.clientUdpPort = null;
        this.reportId = null;
        this.groups = [];
        this.stopMeterInterval();
        this.clearKeepaliveWatchdog();
      });
    });
    this.tcpServer = tcpServer;

    const tcpPort = await new Promise<number>((resolve, reject) => {
      tcpServer.once("error", reject);
      tcpServer.listen(0, "127.0.0.1", () => {
        const address = tcpServer.address();
        resolve(typeof address === "object" && address !== null ? address.port : 0);
      });
    });

    return { tcpPort };
  }

  async stop(): Promise<void> {
    this.stopMeterInterval();
    this.clearKeepaliveWatchdog();

    const tcpServer = this.tcpServer;
    this.tcpServer = null;
    if (tcpServer) {
      await new Promise<void>((resolve) => tcpServer.close(() => resolve()));
    }

    const udpSocket = this.udpSocket;
    this.udpSocket = null;
    if (udpSocket) {
      await new Promise<void>((resolve) => udpSocket.close(() => resolve()));
    }
  }

  private handleChannel3Byte(byte: number): void {
    if (this.inCollection) {
      this.collectionRawBytes.push(byte);
      if (byte === TOKEN_COLLECTION_END) {
        this.inCollection = false;
        this.currentCollectionType = null;
        this.lastCollectionBytesValue = Buffer.from(this.collectionRawBytes);
        this.groups = this.collectionGroupsBuilder.slice();
        this.tryStartStreaming();
        return;
      }
      const type = TOKEN_TO_GROUP_TYPE.get(byte);
      if (type) {
        // A group-type token starts a new run: for index-less groups (monitor/rta) it stands
        // alone; for indexed groups it's followed by a *run* of 0-based index bytes (as many as
        // that request had indices — encodeMeterCollection has no explicit count, the boundary is
        // implicit: index bytes are always < 0xa0, the next token always >= 0xa0).
        this.currentCollectionType = type;
        if (!METER_GROUP_TABLE[type].hasIndex) {
          this.collectionGroupsBuilder.push({ type });
        }
        return;
      }
      // Not a recognized token: it's a 0-based index byte for the current run's type.
      if (this.currentCollectionType) {
        this.collectionGroupsBuilder.push({ type: this.currentCollectionType, index: byte + 1 });
      }
      return;
    }

    if (this.pendingField) {
      this.pendingField.bytes.push(byte);
      if (this.pendingField.bytes.length === this.pendingField.total) {
        const bytes = this.pendingField.bytes;
        if (this.pendingField.kind === "port") {
          this.clientUdpPort = (bytes[0] << 8) | bytes[1];
        } else {
          this.reportId =
            ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
          this.receivedKeepalivesCount += 1;
          this.tryStartStreaming();
        }
        this.pendingField = null;
      }
      return;
    }

    switch (byte) {
      case TOKEN_UDP_PORT:
        this.pendingField = { kind: "port", bytes: [], total: 2 };
        break;
      case TOKEN_REPORT_ID:
        this.pendingField = { kind: "reportId", bytes: [], total: 4 };
        break;
      case TOKEN_COLLECTION_START:
        this.inCollection = true;
        this.collectionRawBytes = [TOKEN_COLLECTION_START];
        this.collectionGroupsBuilder = [];
        break;
      default:
        // Unrecognized top-level byte on the meter channel: ignore rather than throw.
        break;
    }
  }

  private tryStartStreaming(): void {
    if (
      this.clientUdpPort === null ||
      this.reportId === null ||
      this.clientAddress === null ||
      this.groups.length === 0
    ) {
      return;
    }
    this.resetKeepaliveWatchdog();
    if (!this.meterInterval) {
      this.meterInterval = setInterval(() => this.sendSyntheticFrame(), this.meterIntervalMs);
    }
  }

  private resetKeepaliveWatchdog(): void {
    this.clearKeepaliveWatchdog();
    this.keepaliveWatchdog = setTimeout(() => {
      this.stopMeterInterval();
    }, this.keepaliveTimeoutMs);
  }

  private clearKeepaliveWatchdog(): void {
    if (this.keepaliveWatchdog) {
      clearTimeout(this.keepaliveWatchdog);
      this.keepaliveWatchdog = null;
    }
  }

  private stopMeterInterval(): void {
    if (this.meterInterval) {
      clearInterval(this.meterInterval);
      this.meterInterval = null;
    }
  }

  private sendSyntheticFrame(): void {
    if (!this.udpSocket || this.clientUdpPort === null || this.reportId === null || !this.clientAddress) {
      return;
    }
    this.wavePhase += 1;

    const words: number[] = [];
    let wordIndex = 0;
    for (const group of this.groups) {
      const wordCount = METER_GROUP_TABLE[group.type].wordCount;
      for (let w = 0; w < wordCount; w++) {
        // Plausible slowly-varying synthetic value, distinct per word so tests can sanity-check shape.
        const raw = 6000 * Math.sin((this.wavePhase + wordIndex * 3) * 0.05);
        words.push(Math.max(-32768, Math.min(32767, Math.round(raw))));
        wordIndex += 1;
      }
    }

    const packet = Buffer.alloc(4 + words.length * 2);
    packet.writeUInt32BE(this.reportId >>> 0, 0);
    let offset = 4;
    for (const word of words) {
      packet.writeInt16BE(word, offset);
      offset += 2;
    }

    this.udpSocket.send(packet, this.clientUdpPort, this.clientAddress, (err) => {
      if (err) {
        console.error("wing-meter-simulator: failed to send synthetic frame:", err);
      }
    });
  }
}
