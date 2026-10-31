// Meters for bridged tablets without a console connection of their own: each tablet's channel-3
// request (UDP port, report id, meter collection) is read here, the union of what tablets want is
// added to the server's own meter subscription (WingMeterClient.setExtraRequests), and every frame
// the console sends is re-sliced into each tablet's packet — its report id, its groups, in its order.
//
// A tablet may hold several subscriptions at once, one per report id (WING Edit had five in a capture:
// strips, RTA, ...): an 0xd4 id selects which one the next collection defines, and renews that one
// only. Each is kept, renewed and expired on its own.

import dgram from "node:dgram";
import type { MeterFrameEvent, WingMeterClient } from "./wing-meter-client.js";
import { encodeMeterPacket, meterGroupWordCount, MeterRequestParser, type FlattenedGroup } from "./wing-meter-protocol.js";
import type { MeterRequest } from "./wing-meter-types.js";
import type { NativeMeterSession } from "./wing-bridge-native.js";
import { meterGroupKey } from "./wing-meter-client.js";

/** The console stops streaming 5 s after the last report-id keepalive; so does the bridge. */
const KEEPALIVE_TIMEOUT_MS = 5000;
const ADD_DEBOUNCE_MS = 250;
const REMOVE_DEBOUNCE_MS = 2000;
/** What a group not yet in the subscription reads as: the int16 floor, i.e. silence. */
const NO_SIGNAL = -32768;

interface MeterSubscription {
  groups: FlattenedGroup[];
  lastKeepaliveAt: number;
}

interface TabletMeters {
  peer: { address: string; port: number };
  udpPort: number | null;
  /** The report id the last 0xd4 named: the next collection belongs to it. */
  current: number | null;
  subscriptions: Map<number, MeterSubscription>;
  /** Bytes inside a collection the bridge does not know: a group it would then size wrong. */
  unknownTokens: number[];
  closed: boolean;
}

function summarizeGroups(groups: FlattenedGroup[]): string {
  const byType = new Map<string, number[]>();
  for (const group of groups) {
    const list = byType.get(group.type) ?? [];
    if (group.index !== undefined) list.push(group.index);
    byType.set(group.type, list);
  }
  return [...byType]
    .map(([type, idx]) => (idx.length === 0 ? type : `${type} ${idx.length > 2 && idx[idx.length - 1] - idx[0] === idx.length - 1 ? `${idx[0]}-${idx[idx.length - 1]}` : idx.join(",")}`))
    .join(", ");
}

export interface BridgeMeterSubscriptionStatus {
  reportId: number;
  /** "channelV2 1-40, busV2 6, rta" */
  groups: string;
  words: number;
  live: boolean;
  ageMs: number;
}

export interface BridgeMeterStatus {
  /** What each tablet asked for, by report id: the first thing to look at when an app's meters look wrong. */
  perTablet: { address: string; udpPort: number | null; subscriptions: BridgeMeterSubscriptionStatus[]; unknownTokens: number[] }[];
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
  /**
   * Sends from another socket when set: the discovery responder's, bound to UDP 2222 — the port the
   * console itself sends meters from, in case an app checks. Returns false when it cannot.
   */
  private sender: ((packet: Buffer, port: number, address: string) => boolean) | null = null;

  /** Called when a tablet asks for `source`/`output` meters and the I/O group sizes are not known. */
  onNeedIoSizes: ((client: WingMeterClient) => void) | null = null;

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

  setSender(sender: ((packet: Buffer, port: number, address: string) => boolean) | null): void {
    this.sender = sender;
  }

  /** One per tablet that uses channel 3 (the native proxy calls this on its first meter byte). */
  createSession(peer: { address: string; port: number }): NativeMeterSession {
    const tablet: TabletMeters = { peer, udpPort: null, current: null, subscriptions: new Map(), unknownTokens: [], closed: false };
    this.tablets.add(tablet);
    const parser = new MeterRequestParser((event) => {
      switch (event.kind) {
        case "udpPort":
          tablet.udpPort = event.port;
          break;
        case "reportId": {
          tablet.current = event.id;
          const subscription = tablet.subscriptions.get(event.id) ?? { groups: [], lastKeepaliveAt: 0 };
          subscription.lastKeepaliveAt = Date.now();
          tablet.subscriptions.set(event.id, subscription);
          break;
        }
        case "collection": {
          if (tablet.current === null) break;
          const subscription = tablet.subscriptions.get(tablet.current) ?? { groups: [], lastKeepaliveAt: Date.now() };
          subscription.groups = event.groups;
          tablet.subscriptions.set(tablet.current, subscription);
          const needsIo = event.groups.some((g) => g.type === "source" || g.type === "output");
          if (needsIo && this.meterClient && !this.meterClient.getIoSizes()) this.onNeedIoSizes?.(this.meterClient);
          if (event.unknownTokens.length > 0) tablet.unknownTokens = [...new Set([...tablet.unknownTokens, ...event.unknownTokens])].slice(0, 16);
          this.scheduleUnion(this.timing.addDebounceMs);
          break;
        }
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
      perTablet: [...this.tablets].map((t) => ({
        address: t.peer.address,
        udpPort: t.udpPort,
        unknownTokens: t.unknownTokens,
        subscriptions: [...t.subscriptions].map(([reportId, sub]) => ({
          reportId,
          groups: summarizeGroups(sub.groups),
          words: sub.groups.reduce((n, g) => n + (meterGroupWordCount(g, this.meterClient?.getIoSizes() ?? null) ?? 0), 0),
          live: this.isLive(t, sub, now),
          ageMs: now - sub.lastKeepaliveAt,
        })),
      })),
      tablets: this.tablets.size,
      streaming: [...this.tablets].filter((t) => [...t.subscriptions.values()].some((sub) => this.isLive(t, sub, now))).length,
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

  private isLive(tablet: TabletMeters, subscription: MeterSubscription, now: number): boolean {
    return tablet.udpPort !== null && subscription.groups.length > 0 && now - subscription.lastKeepaliveAt <= this.timing.keepaliveTimeoutMs;
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
    for (const tablet of this.tablets) {
      for (const subscription of tablet.subscriptions.values()) {
        for (const group of subscription.groups) keys.set(meterGroupKey(group), group);
      }
    }
    const signature = [...keys.keys()].sort().join(" ");
    if (signature === this.appliedUnion || !this.meterClient) return;
    this.appliedUnion = signature;
    const requests: MeterRequest[] = [...keys.values()].map((g) => (g.index === undefined ? { type: g.type } : { type: g.type, indices: [g.index] }));
    this.meterClient.setExtraRequests(requests);
  }

  private fanOut(frame: MeterFrameEvent): void {
    const now = Date.now();
    let dropped = false;
    for (const tablet of this.tablets) {
      for (const [reportId, subscription] of tablet.subscriptions) {
        if (now - subscription.lastKeepaliveAt > this.timing.keepaliveTimeoutMs * 2) {
          // Long expired: forget it, so its groups leave the server's subscription too.
          tablet.subscriptions.delete(reportId);
          dropped = true;
          continue;
        }
        if (!this.isLive(tablet, subscription, now)) continue;
        const sizes = subscription.groups.map((group) => meterGroupWordCount(group, this.meterClient?.getIoSizes() ?? null));
        // A group of unknown size (I/O sizes not read yet): a packet of the wrong length would shift
        // everything after it in the app — the RTA showed garbage that way. Send nothing until known.
        if (sizes.some((count) => count === null)) continue;
        const words: number[] = [];
        for (const [g, group] of subscription.groups.entries()) {
          const slot = frame.layout.get(meterGroupKey(group));
          const count = sizes[g] as number;
          for (let i = 0; i < count; i++) {
            const at = 4 + ((slot?.offset ?? 0) + i) * 2;
            words.push(slot && at + 2 <= frame.packet.length ? frame.packet.readInt16BE(at) : NO_SIGNAL);
          }
        }
        this.send(encodeMeterPacket(reportId, words), tablet.peer.address, tablet.udpPort as number);
      }
    }
    if (dropped) this.scheduleUnion(this.timing.removeDebounceMs);
  }

  private send(packet: Buffer, address: string, port: number): void {
    if (this.sender?.(packet, port, address)) {
      this.packetsSent += 1;
      return;
    }
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
