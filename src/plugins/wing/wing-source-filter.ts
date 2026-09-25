import dns from "node:dns";
import net from "node:net";

/**
 * Which source addresses may speak for the console on the UDP sockets this server listens on.
 *
 * Both of them (OSC replies/pushes, meter frames) are bound on every interface and used to accept a
 * datagram from anyone: a host on the same LAN could inject a fake "OK" ack for a write, poison the
 * state cache with invented values, or draw fake meters. The console's protocol has no
 * authentication to lean on, so the source address is the one thing to check.
 */
export type ConsoleSources = ReadonlySet<string> | null;

/** "::ffff:192.168.1.50" and "192.168.1.50" are the same IPv4 sender. */
export function normalizeAddress(address: string): string {
  return address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;
}

/**
 * The console's IPv4 addresses (the sockets are udp4). `null` — no filtering — when a hostname does
 * not resolve right now: being unable to resolve must not make the server deaf to a console that
 * is answering. The warning says so.
 */
export async function resolveConsoleSources(host: string): Promise<ConsoleSources> {
  if (!host) return null;
  if (net.isIP(host)) return new Set([normalizeAddress(host)]);
  try {
    const addresses = await dns.promises.lookup(host, { all: true, family: 4 });
    return new Set(addresses.map((entry) => normalizeAddress(entry.address)));
  } catch (err) {
    console.warn(`[wing] could not resolve ${host}; accepting UDP from any source until it does:`, err);
    return null;
  }
}

export function isFromConsole(sources: ConsoleSources, address: string | undefined): boolean {
  if (sources === null) return true;
  return address !== undefined && sources.has(normalizeAddress(address));
}

/** Logs the first datagram dropped from each foreign source, so a NAT/multi-homing setup is diagnosable. */
export function createDropReporter(label: string, host: string): (address: string | undefined) => void {
  const reported = new Set<string>();
  return (address) => {
    const key = address ?? "unknown";
    if (reported.has(key) || reported.size >= 20) return;
    reported.add(key);
    console.warn(`[${label}] ignoring UDP from ${key}: not the console (${host})`);
  };
}
