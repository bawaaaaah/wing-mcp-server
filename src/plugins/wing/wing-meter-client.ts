// TCP:2222 control + UDP level-meter stream client for a WING console's binary metering protocol.
// Completely separate from the OSC control plane (see wing-osc-client.ts, owned by another module).

import { EventEmitter } from "node:events";
import net from "node:net";
import dgram from "node:dgram";
import crypto from "node:crypto";
import {
  encodeChannelSelect,
  encodeMeterCollection,
  encodeReportId,
  encodeUdpPortAnnouncement,
  escapeBytes,
  METER_GROUP_TABLE,
  parseMeterUdpPacket,
  WingChannelDemuxer,
} from "./wing-meter-protocol.js";
import type { MeterGroupType, MeterRequest, MeterSnapshot } from "./wing-meter-types.js";

const METER_CHANNEL_ID = 3;
const DEFAULT_TCP_PORT = 2222;
const DEFAULT_UDP_LISTEN_PORT = 14135;
const DEFAULT_KEEPALIVE_INTERVAL_MS = 3000;
const RECONNECT_CAP_MS = 10000;
const RECONNECT_JITTER_MS = 250;
// A connection that gets torn down again within this window doesn't count as "recovered" — the
// backoff keeps escalating instead of resetting to zero on every fresh TCP connect. Without this,
// a console that accepts the TCP connection but immediately resets it (observed in practice after
// the console was left holding several stale metering sessions from prior ungraceful disconnects)
// causes an unthrottled ~1s reconnect storm instead of backing off.
const RECONNECT_STABLE_AFTER_MS = 3000;

export type WingMeterClientStatus = "connected" | "disconnected" | "reconnecting";

export interface WingMeterClientOptions {
  host: string;
  /** default 2222 */
  tcpPort?: number;
  /** default 14135 — fixed (not ephemeral) so it can be published in docker-compose */
  udpListenPort?: number;
  /** default 3000 — must stay comfortably under the console's ~5s subscription window */
  keepaliveIntervalMs?: number;
}

interface FlattenedGroup {
  type: MeterGroupType;
  index?: number;
}

/**
 * Client for the WING binary metering protocol: opens a TCP control connection on port 2222,
 * selects the meter channel (ChID 3), announces a local UDP port for the level-meter stream, and
 * keeps a report-id "subscription" alive via periodic keepalive writes.
 *
 * Events: "snapshot" (MeterSnapshot), "status" ("connected"|"disconnected"|"reconnecting"), "error" (Error),
 * "raw" (Buffer — every UDP packet received, verbatim, before parsing/report-id filtering; tapped by
 * wing-osc-mirror.ts).
 */
export class WingMeterClient extends EventEmitter {
  private readonly host: string;
  private readonly tcpPort: number;
  private readonly udpListenPort: number;
  private readonly keepaliveIntervalMs: number;

  private tcpSocket: net.Socket | null = null;
  private udpSocket: dgram.Socket | null = null;
  private readonly demuxer = new WingChannelDemuxer();

  private reportId: number | null = null;
  private flattenedGroups: FlattenedGroup[] = [];
  private lastRequests: MeterRequest[] | null = null;

  private keepaliveTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectStableTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;

  private explicitlyDisconnected = false;
  private connecting: Promise<void> | null = null;

  constructor(opts: WingMeterClientOptions) {
    super();
    this.host = opts.host;
    this.tcpPort = opts.tcpPort ?? DEFAULT_TCP_PORT;
    this.udpListenPort = opts.udpListenPort ?? DEFAULT_UDP_LISTEN_PORT;
    this.keepaliveIntervalMs = opts.keepaliveIntervalMs ?? DEFAULT_KEEPALIVE_INTERVAL_MS;
  }

  async connect(): Promise<void> {
    if (this.connecting) {
      return this.connecting;
    }
    this.explicitlyDisconnected = false;
    const promise = this.doConnect();
    this.connecting = promise.finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async doConnect(): Promise<void> {
    // Carries no state across connections: a stream that dropped mid-escape-sequence would
    // otherwise make the first byte of this one look like a channel selector.
    this.demuxer.reset();
    await this.connectTcp();
    const socket = this.tcpSocket;
    if (!socket) {
      // connectTcp() resolves on "connect", but handleTcpClosed() nulls tcpSocket on "close" — and
      // a console that accepts the connection then immediately resets it is the documented case
      // (see RECONNECT_STABLE_AFTER_MS above). Asserting non-null here surfaced that as an opaque
      // TypeError; reconnectNow() catches this and backs off like any other connection failure.
      throw new Error("WING meter TCP connection closed before the metering channel could be selected");
    }
    socket.write(encodeChannelSelect(METER_CHANNEL_ID));
    await this.bindUdpSocket();
    this.writeChannelPayload(encodeUdpPortAnnouncement(this.udpListenPort));
    this.clearReconnectStableTimer();
    this.reconnectStableTimer = setTimeout(() => {
      this.reconnectStableTimer = null;
      this.reconnectAttempts = 0;
    }, RECONNECT_STABLE_AFTER_MS);
    this.emit("status", "connected" satisfies WingMeterClientStatus);
  }

  private clearReconnectStableTimer(): void {
    if (this.reconnectStableTimer) {
      clearTimeout(this.reconnectStableTimer);
      this.reconnectStableTimer = null;
    }
  }

  private connectTcp(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new net.Socket();
      let settled = false;

      socket.once("connect", () => {
        settled = true;
        this.tcpSocket = socket;
        resolve();
      });

      socket.on("error", (err) => {
        this.emit("error", err instanceof Error ? err : new Error(String(err)));
        if (!settled) {
          settled = true;
          reject(err);
        }
      });

      socket.on("close", () => {
        this.handleTcpClosed();
      });

      socket.on("data", (chunk: Buffer) => {
        // Nothing meaningful is expected back on the meter control channel today, but the stream
        // must still be consumed (and correctly de-escaped/demuxed) to avoid backpressure stalls.
        this.demuxer.feed(chunk, () => {
          /* no-op */
        });
      });

      socket.connect(this.tcpPort, this.host);
    });
  }

  private bindUdpSocket(): Promise<void> {
    if (this.udpSocket) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const socket = dgram.createSocket("udp4");
      let settled = false;

      socket.on("error", (err) => {
        this.emit("error", err instanceof Error ? err : new Error(String(err)));
        if (!settled) {
          settled = true;
          reject(err);
          return;
        }
        this.handleUdpFailure(socket);
      });

      // Deliberately not filtered by source address, unlike the OSC socket: frames arrive on a port
      // the console pushes to, which under Docker Desktop's port forwarding shows up as coming from
      // the VM's gateway rather than the console. A frame is only accepted when it carries the random
      // 32-bit report id of the current subscription (handleUdpMessage), which already rules out
      // blind injection from elsewhere on the network.
      socket.on("message", (msg) => {
        this.handleUdpMessage(msg);
      });

      socket.bind(this.udpListenPort, () => {
        settled = true;
        this.udpSocket = socket;
        resolve();
      });
    });
  }

  /**
   * An error on the UDP socket *after* a successful bind used to be emitted and then ignored. That
   * left a dead socket in place — and `bindUdpSocket()` short-circuits whenever `udpSocket` is
   * non-null (deliberately, so a reconnect doesn't hit EADDRINUSE on the fixed listen port), so it
   * was treated as valid forever: the TCP side stayed up, the status stayed "connected",
   * getHealth() kept reporting HEALTHY, and not one further meter frame ever arrived. Dropping the
   * socket and tearing down TCP routes recovery through the reconnect path, which re-binds.
   */
  private handleUdpFailure(socket: dgram.Socket): void {
    if (this.udpSocket !== socket) {
      return;
    }
    this.udpSocket = null;
    try {
      socket.close();
    } catch {
      // Already closing or never bound — nothing left to release.
    }
    if (this.explicitlyDisconnected) {
      return;
    }
    const tcp = this.tcpSocket;
    if (tcp) {
      // "close" -> handleTcpClosed(), which emits the status change and schedules the reconnect.
      tcp.destroy();
    } else {
      this.scheduleReconnect();
    }
  }

  private handleUdpMessage(msg: Buffer): void {
    this.emit("raw", msg);
    try {
      const snapshot = parseMeterUdpPacket(msg, this.flattenedGroups);
      if (snapshot !== null && this.reportId !== null && snapshot.reportId === this.reportId) {
        this.emit("snapshot", snapshot satisfies MeterSnapshot);
      }
      // Non-null snapshots with a stale reportId (leftover from a previous subscription) are
      // silently dropped — expected during resubscribe races, not worth logging.
    } catch (err) {
      console.error("wing-meter-client: error handling UDP meter message:", err);
    }
  }

  async subscribe(requests: MeterRequest[]): Promise<void> {
    this.lastRequests = requests;
    this.flattenedGroups = flattenRequests(requests);
    // A new id every time, deliberately. handleUdpMessage() drops packets whose report id is not
    // the current one, which is the only guard against decoding an in-flight packet from the
    // previous subscription against the new `flattenedGroups` — positional decoding would turn it
    // into plausible-looking levels attributed to the wrong strips. Reusing the id made that guard
    // dead code: the id never changed, so a stale packet always matched.
    this.reportId = crypto.randomInt(0, 2 ** 32);
    this.writeSubscription(requests);
    this.startKeepalive();
  }

  private writeSubscription(requests: MeterRequest[]): void {
    if (!this.tcpSocket || this.reportId === null) {
      return;
    }
    this.writeChannelPayload(encodeReportId(this.reportId));
    this.writeChannelPayload(encodeMeterCollection(requests));
  }

  private writeChannelPayload(payload: Buffer): void {
    if (!this.tcpSocket) {
      return;
    }
    this.tcpSocket.write(escapeBytes(payload));
  }

  private startKeepalive(): void {
    this.stopKeepalive();
    this.keepaliveTimer = setInterval(() => {
      if (this.reportId !== null) {
        this.writeChannelPayload(encodeReportId(this.reportId));
      }
    }, this.keepaliveIntervalMs);
  }

  private stopKeepalive(): void {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
  }

  async unsubscribe(): Promise<void> {
    this.stopKeepalive();
    this.lastRequests = null;
    this.flattenedGroups = [];
    this.reportId = null;
  }

  async disconnect(): Promise<void> {
    this.explicitlyDisconnected = true;
    this.clearReconnectTimer();
    this.clearReconnectStableTimer();
    this.stopKeepalive();
    this.lastRequests = null;
    this.flattenedGroups = [];
    this.reportId = null;
    await this.closeSockets();
  }

  private async closeSockets(): Promise<void> {
    const tcp = this.tcpSocket;
    this.tcpSocket = null;
    if (tcp) {
      await new Promise<void>((resolve) => {
        tcp.once("close", () => resolve());
        tcp.destroy();
      });
    }

    const udp = this.udpSocket;
    this.udpSocket = null;
    if (udp) {
      await new Promise<void>((resolve) => {
        udp.close(() => resolve());
      });
    }
  }

  private handleTcpClosed(): void {
    // Node never re-emits "close" for a socket that's already closed/destroyed — closeSockets()
    // awaits exactly that event, so leaving `tcpSocket` pointing at this now-dead socket would make
    // a disconnect() called during the "disconnected"/reconnecting window hang forever.
    this.tcpSocket = null;
    if (this.explicitlyDisconnected) {
      return;
    }
    this.clearReconnectStableTimer();
    this.stopKeepalive();
    this.emit("status", "disconnected" satisfies WingMeterClientStatus);
    this.scheduleReconnect();
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.explicitlyDisconnected || this.reconnectTimer) {
      return;
    }
    const attempt = this.reconnectAttempts++;
    const delay = Math.min(RECONNECT_CAP_MS, 1000 * 2 ** attempt) + Math.random() * RECONNECT_JITTER_MS;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.reconnectNow();
    }, delay);
  }

  private async reconnectNow(): Promise<void> {
    if (this.explicitlyDisconnected) {
      return;
    }
    this.emit("status", "reconnecting" satisfies WingMeterClientStatus);
    try {
      await this.connect();
      if (this.lastRequests) {
        await this.subscribe(this.lastRequests);
      }
    } catch (err) {
      this.emit("error", err instanceof Error ? err : new Error(String(err)));
      this.scheduleReconnect();
    }
  }
}

function flattenRequests(requests: MeterRequest[]): FlattenedGroup[] {
  const flattened: FlattenedGroup[] = [];
  for (const request of requests) {
    const meta = METER_GROUP_TABLE[request.type];
    if (meta.hasIndex) {
      for (const index of request.indices ?? []) {
        flattened.push({ type: request.type, index });
      }
    } else {
      flattened.push({ type: request.type });
    }
  }
  return flattened;
}
