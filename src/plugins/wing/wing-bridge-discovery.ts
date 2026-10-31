// Answering WING discovery as if we were a console, so apps that find consoles by broadcasting
// "WING?" on UDP 2222 (WING-Q, Co-Pilot, WING Edit) list this server too. Pure helpers here; the
// socket lives with whoever answers (the bridge, or scripts/wing-native-capture.ts).

/* eslint-disable no-bitwise -- IPv4 netmask arithmetic. */
import dgram from "node:dgram";
import os, { type NetworkInterfaceInfo } from "node:os";
import { discoverWingConsoles, type WingDiscoveryResult } from "./wing-discovery.js";

export const DISCOVERY_QUERY = "WING?";

/** The reply field the console caps at 16 bytes for its own name; apps may assume the same. */
const MAX_NAME_BYTES = 16;

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = (value << 8) | n;
  }
  return value >>> 0;
}

/** Strips an IPv4-mapped IPv6 prefix ("::ffff:192.168.1.5"), as sockets report peers on a dual stack. */
export function plainIpv4(address: string): string {
  return address.replace(/^::ffff:/i, "");
}

/**
 * The local address to put in a reply to `requesterIp`: the IPv4 address of the interface whose
 * subnet contains the requester (the one it can reach us on), else the first external IPv4 address.
 * The console replies with its own address; a tablet connects to whatever address the reply names.
 */
export function pickAdvertiseAddress(
  requesterIp: string,
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>,
): string | null {
  const requester = ipv4ToInt(plainIpv4(requesterIp));
  let fallback: string | null = null;
  for (const infos of Object.values(interfaces)) {
    for (const info of infos ?? []) {
      if (info.family !== "IPv4" || info.internal) continue;
      fallback ??= info.address;
      const address = ipv4ToInt(info.address);
      const mask = ipv4ToInt(info.netmask);
      if (requester !== null && address !== null && mask !== null && (address & mask) === (requester & mask)) {
        return info.address;
      }
    }
  }
  return fallback;
}

/** Truncates to at most `maxBytes` UTF-8 bytes without splitting a character. */
function truncateUtf8(text: string, maxBytes: number): string {
  let out = "";
  for (const char of text) {
    if (Buffer.byteLength(out + char, "utf8") > maxBytes) break;
    out += char;
  }
  return out;
}

/**
 * The discovery reply `WING,<ip>,<name>,<model>,<serial>,<firmware>`. Fields are comma-separated with
 * no quoting, so commas are removed from every field — a parser that splits on "," (ours does, see
 * wing-discovery.ts) would otherwise drop the reply.
 */
export function formatDiscoveryReply(identity: WingDiscoveryResult): string {
  const clean = (field: string) => field.replace(/,/g, "").trim();
  return [
    "WING",
    clean(identity.ip),
    truncateUtf8(clean(identity.name), MAX_NAME_BYTES),
    clean(identity.model),
    clean(identity.serial),
    clean(identity.firmware),
  ].join(",");
}

/**
 * A serial that is not the console's own: apps may merge two discovery entries with the same serial
 * (libwing dedupes on ip + serial) and then connect to the wrong one.
 */
export function deriveSerial(serial: string, suffix: string): string {
  return serial ? `${serial}-${suffix}` : suffix;
}

export function isDiscoveryQuery(datagram: Buffer): boolean {
  return datagram.toString("ascii").trim() === DISCOVERY_QUERY;
}

const IDENTITY_REFRESH_MS = 5 * 60 * 1000;

export interface DiscoveryResponderOptions {
  /** UDP port to answer on: the console's own (2222), since apps broadcast there. */
  port: number;
  consoleHost: string;
  consoleDiscoveryPort: number;
  /** Advertised name; empty means "<console name>-BR". */
  name: string;
  /** Address put in the reply; empty means the interface facing each requester. */
  advertiseHost: string;
  serialMode: "derived" | "real";
}

export interface DiscoveryResponderStatus {
  listening: boolean;
  port: number;
  queries: number;
  lastQueryFrom: string | null;
  identity: WingDiscoveryResult | null;
  advertised: { name: string; serial: string } | null;
  lastError: string | null;
}

/**
 * Answers `WING?` on UDP as the console would, with this server's address, so tablet apps list the
 * bridge. Model and firmware are the real console's (read with a unicast WING? to it, refreshed
 * every few minutes); name and serial are the bridge's own, so an app keeps the two entries apart.
 * Binds every interface: a socket bound to one address does not receive broadcasts on Linux.
 */
export class WingDiscoveryResponder {
  private socket: dgram.Socket | null = null;
  private identity: WingDiscoveryResult | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private queries = 0;
  private lastQueryFrom: string | null = null;
  private lastError: string | null = null;

  constructor(private readonly opts: DiscoveryResponderOptions) {}

  async start(): Promise<void> {
    const socket = dgram.createSocket({ type: "udp4", reuseAddr: false });
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.bind(this.opts.port, "0.0.0.0", () => {
        socket.off("error", reject);
        resolve();
      });
    });
    socket.on("error", (err) => (this.lastError = err.message));
    socket.on("message", (msg, rinfo) => this.onMessage(socket, msg, rinfo));
    this.socket = socket;
    void this.refreshIdentity();
    this.refreshTimer = setInterval(() => void this.refreshIdentity(), IDENTITY_REFRESH_MS);
    this.refreshTimer.unref?.();
  }

  get port(): number {
    return (this.socket?.address() as { port: number } | undefined)?.port ?? this.opts.port;
  }

  async close(): Promise<void> {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
    const socket = this.socket;
    this.socket = null;
    if (socket) await new Promise<void>((resolve) => socket.close(() => resolve()));
  }

  /** What this responder answers with, or null until the console's identity is known. */
  advertised(): { name: string; serial: string } | null {
    if (!this.identity) return null;
    const name = this.opts.name.trim() || `${this.identity.name}-BR`;
    const serial = this.opts.serialMode === "real" ? this.identity.serial : deriveSerial(this.identity.serial, "BR");
    return { name, serial };
  }

  /**
   * True for a discovery result that is this bridge answering, not a console. The name is compared
   * too: with serialMode "real" the serial alone would also match the console itself.
   */
  isOwnReply(result: WingDiscoveryResult): boolean {
    const own = this.advertised();
    return own !== null && result.serial === own.serial && result.name === truncateUtf8(own.name.replace(/,/g, "").trim(), MAX_NAME_BYTES);
  }

  getStatus(): DiscoveryResponderStatus {
    return {
      listening: this.socket !== null,
      port: this.port,
      queries: this.queries,
      lastQueryFrom: this.lastQueryFrom,
      identity: this.identity,
      advertised: this.advertised(),
      lastError: this.lastError,
    };
  }

  private async refreshIdentity(): Promise<void> {
    const found = await discoverWingConsoles({ broadcastAddress: this.opts.consoleHost, port: this.opts.consoleDiscoveryPort, timeoutMs: 1500 });
    const desk = found.find((c) => c.ip === this.opts.consoleHost) ?? found[0];
    if (desk) {
      this.identity = desk;
      this.lastError = null;
    } else if (!this.identity) {
      this.lastError = `the console at ${this.opts.consoleHost} did not answer WING?: not advertising until it does`;
    }
  }

  private onMessage(socket: dgram.Socket, msg: Buffer, rinfo: dgram.RemoteInfo): void {
    if (!isDiscoveryQuery(msg)) return;
    const own = this.advertised();
    if (!this.identity || !own) return;
    this.queries += 1;
    this.lastQueryFrom = `${rinfo.address}:${rinfo.port}`;
    const ip = this.opts.advertiseHost.trim() || pickAdvertiseAddress(rinfo.address, os.networkInterfaces());
    if (!ip) return;
    socket.send(formatDiscoveryReply({ ...this.identity, ip, name: own.name, serial: own.serial }), rinfo.port, rinfo.address);
  }
}
