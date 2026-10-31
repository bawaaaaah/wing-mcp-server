// Answering WING discovery as if we were a console, so apps that find consoles by broadcasting
// "WING?" on UDP 2222 (WING-Q, Co-Pilot, WING Edit) list this server too. Pure helpers here; the
// socket lives with whoever answers (the bridge, or scripts/wing-native-capture.ts).

/* eslint-disable no-bitwise -- IPv4 netmask arithmetic. */
import type { NetworkInterfaceInfo } from "node:os";
import type { WingDiscoveryResult } from "./wing-discovery.js";

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
