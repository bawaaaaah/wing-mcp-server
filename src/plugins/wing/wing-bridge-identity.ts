// Who a bridged client is, so a device profile can give it its own rights: its IP, its MAC address
// (from this server's ARP table — only for devices on the same network segment) and, for WING-Q,
// its model, which the app's WebView sends in its User-Agent ("... Android 16; SM-X700 Build/...").

import { execFile } from "node:child_process";
import type { BridgeProfile } from "./wing-config.js";

export interface ClientIdentity {
  ip: string;
  mac: string | null;
  model: string | null;
}

/** "SM-X700" from an Android WebView user agent; "iPad"/"iPhone" from an Apple one; else null. */
export function parseDeviceModel(userAgent: string | undefined): string | null {
  if (!userAgent) return null;
  const android = /;\s*([^;()]+?)\s+Build\//.exec(userAgent);
  if (android) return android[1].trim();
  const apple = /\((iPad|iPhone|iPod)\b/.exec(userAgent);
  return apple ? apple[1] : null;
}

/** "A:b:C:1:2:3" or "0a-0b-0c-01-02-03" -> "0a:0b:0c:01:02:03"; null when it is not a MAC address. */
export function normalizeMac(text: string | null | undefined): string | null {
  if (!text) return null;
  const parts = text.trim().toLowerCase().split(/[:-]/);
  if (parts.length !== 6 || !parts.every((p) => /^[0-9a-f]{1,2}$/.test(p))) return null;
  return parts.map((p) => p.padStart(2, "0")).join(":");
}

/** The MAC address in one line of `arp -n <ip>` output (macOS and Linux formats), or null. */
export function parseArpOutput(output: string): string | null {
  for (const match of output.matchAll(/\b([0-9a-f]{1,2}(?:[:-][0-9a-f]{1,2}){5})\b/gi)) {
    const mac = normalizeMac(match[1]);
    // "(incomplete)" entries and broadcast addresses are not a device.
    if (mac && mac !== "ff:ff:ff:ff:ff:ff" && mac !== "00:00:00:00:00:00") return mac;
  }
  return null;
}

export type ArpLookup = (ip: string) => Promise<string>;

const runArp: ArpLookup = (ip) =>
  new Promise((resolve) => {
    execFile("arp", ["-n", ip], { timeout: 2000 }, (_err, stdout) => resolve(String(stdout ?? "")));
  });

const MAC_CACHE_MS = 60_000;
/** Entries kept per identity cache: far more than a stage's devices, small enough that a flood of clients can't grow it. */
export const IDENTITY_CACHE_LIMIT = 256;

/**
 * A Map holding at most `limit` entries: setting one more drops the least recently used (read or
 * set). For caches keyed by what clients send (IP, user agent), which must not grow without end.
 */
export class LruMap<K, V> {
  private readonly map = new Map<K, V>();

  constructor(readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError(`LruMap limit must be a positive integer, got ${limit}`);
  }

  get size(): number {
    return this.map.size;
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  get(key: K): V | undefined {
    if (!this.map.has(key)) return undefined;
    const value = this.map.get(key) as V;
    // Map keeps insertion order: re-inserting makes it the most recent.
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key: K, value: V): this {
    this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.limit) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      this.map.delete(oldest.value);
    }
    return this;
  }

  delete(key: K): boolean {
    return this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }
}

/** Looks MAC addresses up in the ARP table, with a short cache. Never throws: unknown is null. */
export class MacResolver {
  private readonly cache: LruMap<string, { mac: string | null; at: number }>;
  /** Lookups running, by IP; each is removed when it settles (arp runs with a 2 s timeout). */
  private readonly inFlight = new Map<string, Promise<string | null>>();

  constructor(
    private readonly arp: ArpLookup = runArp,
    cacheLimit = IDENTITY_CACHE_LIMIT,
  ) {
    this.cache = new LruMap(cacheLimit);
  }

  /** IPs cached (tests). */
  get cacheSize(): number {
    return this.cache.size;
  }

  async lookup(ip: string): Promise<string | null> {
    const cached = this.cache.get(ip);
    if (cached && Date.now() - cached.at < MAC_CACHE_MS) return cached.mac;
    // One `arp` per IP at a time, however many clients (user agents) from it ask meanwhile.
    const running = this.inFlight.get(ip);
    if (running) return running;
    const lookup = (async () => {
      let mac: string | null = null;
      try {
        mac = parseArpOutput(await this.arp(ip));
      } catch {
        mac = null;
      }
      this.cache.set(ip, { mac, at: Date.now() });
      return mac;
    })().finally(() => this.inFlight.delete(ip));
    this.inFlight.set(ip, lookup);
    return lookup;
  }
}

/**
 * The profile for a client: among those whose every given criterion matches (IP exactly, MAC after
 * normalising, model case-insensitively), the most specific — the one giving the most criteria; the
 * first listed on a tie. A profile giving none matches every device, so it only applies when no
 * other does: a default for every device. A criterion the client cannot provide (no MAC known, no
 * model sent) does not match.
 */
export function matchProfile(profiles: readonly BridgeProfile[], identity: ClientIdentity): BridgeProfile | null {
  let best: BridgeProfile | null = null;
  let bestScore = -1;
  for (const profile of profiles) {
    const { ip, mac, model } = profile.match;
    if (ip && ip !== identity.ip) continue;
    if (mac && normalizeMac(mac) !== identity.mac) continue;
    if (model && model.toLowerCase() !== identity.model?.toLowerCase()) continue;
    const score = Number(Boolean(ip)) + Number(Boolean(mac)) + Number(Boolean(model));
    if (score > bestScore) {
      best = profile;
      bestScore = score;
    }
  }
  return best;
}
