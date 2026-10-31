// Meters for bridged tablets without a console connection of their own: each tablet's channel-3
// request (UDP port, report id, meter collection) is read here, the union of what tablets want is
// added to the server's own meter subscription (WingMeterClient.setExtraRequests), and every frame
// the console sends is re-sliced into each tablet's packet — its report id, its groups, in its order.

import dgram from "node:dgram";
import type { MeterFrameEvent, WingMeterClient } from "./wing-meter-client.js";
import { encodeMeterPacket, METER_GROUP_TABLE, MeterRequestParser, type FlattenedGroup } from "./wing-meter-protocol.js";
import type { MeterRequest } from "./wing-meter-types.js";
import type { NativeMeterSession } from "./wing-bridge-native.js";
import { meterGroupKey } from "./wing-meter-client.js";

/** The console stops streaming 5 s after the last report-id keepalive; so does the bridge. */
const KEEPALIVE_TIMEOUT_MS = 5000;
const ADD_DEBOUNCE_MS = 250;
const REMOVE_DEBOUNCE_MS = 2000;
/** What a group not yet in the subscription reads as: the int16 floor, i.e. silence. */
const NO_SIGNAL = -32768;

interface TabletMeters {
  peer: { address: string; port: number };
  udpPort: number | null;
  reportId: number | null;
  groups: FlattenedGroup[];
  lastKeepaliveAt: number;
  closed: boolean;
}

export interface BridgeMeterStatus {
  tablets: number;
  streaming: number;
  extraGroups: number;
  packetsSent: number;
  lastError: string | null;
}

export class WingBridgeMeters {
  private readonly tablets = new Set<TabletMeters>();
  private meterClient: WingMeterClient | null = null;
  private socket: dgram.Socket | null = null;
  private unionTimer: NodeJS.Timeout | null = null;
  private appliedUnion = "";
  private packetsSent = 0;
  private lastError: string | null = null;
  private readonly timing: { keepaliveTimeoutMs: number; addDebounceMs: number; removeDebounceMs: number };

  private readonly onFrame = (frame: MeterFrameEvent): void => this.fanOut(frame);

  constructor(timing: Partial<WingBridgeMeters["timing"]> = {}) {
    this.timing = { keepaliveTimeoutMs: KEEPALIVE_TIMEOUT_MS, addDebounceMs: ADD_DEBOUNCE_MS, removeDebounceMs: REMOVE_DEBOUNCE_MS, ...timing };
  }

  /** The plugin's current meter client (null while disconnected). */
  attachMeterClient(client: WingMeterClient | null): void {
    if (this.meterClient === client) return;
    this.meterClient?.off("frame", this.onFrame);
    this.meterClient?.setExtraRequests([]);
    this.meterClient = client;
    this.appliedUnion = "";
    client?.on("frame", this.onFrame);
    this.scheduleUnion(0);
  }

  /** One per tablet that uses channel 3 (the native proxy calls this on its first meter byte). */
  createSession(peer: { address: string; port: number }): NativeMeterSession {
    const tablet: TabletMeters = { peer, udpPort: null, reportId: null, groups: [], lastKeepaliveAt: 0, closed: false };
    this.tablets.add(tablet);
    const parser = new MeterRequestParser((event) => {
      switch (event.kind) {
        case "udpPort":
          tablet.udpPort = event.port;
          break;
        case "reportId":
          tablet.reportId = event.id;
          tablet.lastKeepaliveAt = Date.now();
          break;
        case "collection":
          tablet.groups = event.groups;
          this.scheduleUnion(this.timing.addDebounceMs);
          break;
        default:
          break;
      }
    });
    return {
      feedByte: (byte) => parser.feedByte(byte),
      close: () => {
        tablet.closed = true;
        this.tablets.delete(tablet);
        this.scheduleUnion(this.timing.removeDebounceMs);
      },
    };
  }

  getStatus(): BridgeMeterStatus {
    const now = Date.now();
    return {
      tablets: this.tablets.size,
      streaming: [...this.tablets].filter((t) => this.isLive(t, now)).length,
      extraGroups: this.appliedUnion ? this.appliedUnion.split(" ").length : 0,
      packetsSent: this.packetsSent,
      lastError: this.lastError,
    };
  }

  close(): void {
    for (const tablet of this.tablets) tablet.closed = true;
    this.tablets.clear();
    if (this.unionTimer) clearTimeout(this.unionTimer);
    this.unionTimer = null;
    this.attachMeterClient(null);
    this.socket?.close();
    this.socket = null;
  }

  private isLive(tablet: TabletMeters, now: number): boolean {
    return tablet.udpPort !== null && tablet.reportId !== null && tablet.groups.length > 0 && now - tablet.lastKeepaliveAt <= this.timing.keepaliveTimeoutMs;
  }

  private scheduleUnion(delayMs: number): void {
    if (this.unionTimer && delayMs > 0) return;
    if (this.unionTimer) clearTimeout(this.unionTimer);
    this.unionTimer = setTimeout(() => {
      this.unionTimer = null;
      this.applyUnion();
    }, delayMs);
    this.unionTimer.unref?.();
  }

  /** Every group any tablet asked for, as requests; the meter client skips what it already has. */
  private applyUnion(): void {
    const keys = new Map<string, FlattenedGroup>();
    for (const tablet of this.tablets) for (const group of tablet.groups) keys.set(meterGroupKey(group), group);
    const signature = [...keys.keys()].sort().join(" ");
    if (signature === this.appliedUnion || !this.meterClient) return;
    this.appliedUnion = signature;
    const requests: MeterRequest[] = [...keys.values()].map((g) => (g.index === undefined ? { type: g.type } : { type: g.type, indices: [g.index] }));
    this.meterClient.setExtraRequests(requests);
  }

  private fanOut(frame: MeterFrameEvent): void {
    const now = Date.now();
    for (const tablet of this.tablets) {
      if (!this.isLive(tablet, now)) continue;
      const words: number[] = [];
      for (const group of tablet.groups) {
        const slot = frame.layout.get(meterGroupKey(group));
        const count = METER_GROUP_TABLE[group.type].wordCount;
        for (let i = 0; i < count; i++) {
          const at = 4 + ((slot?.offset ?? 0) + i) * 2;
          words.push(slot && at + 2 <= frame.packet.length ? frame.packet.readInt16BE(at) : NO_SIGNAL);
        }
      }
      this.send(encodeMeterPacket(tablet.reportId as number, words), tablet.peer.address, tablet.udpPort as number);
    }
  }

  private send(packet: Buffer, address: string, port: number): void {
    if (!this.socket) {
      const socket = dgram.createSocket("udp4");
      socket.on("error", (err) => (this.lastError = err.message));
      socket.unref();
      this.socket = socket;
    }
    try {
      this.socket.send(packet, port, address, (err) => {
        if (err) this.lastError = err.message;
        else this.packetsSent += 1;
      });
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
    }
  }
}
