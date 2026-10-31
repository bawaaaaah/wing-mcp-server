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

/** Looks MAC addresses up in the ARP table, with a short cache. Never throws: unknown is null. */
export class MacResolver {
  private readonly cache = new Map<string, { mac: string | null; at: number }>();

  constructor(private readonly arp: ArpLookup = runArp) {}

  async lookup(ip: string): Promise<string | null> {
    const cached = this.cache.get(ip);
    if (cached && Date.now() - cached.at < MAC_CACHE_MS) return cached.mac;
    let mac: string | null = null;
    try {
      mac = parseArpOutput(await this.arp(ip));
    } catch {
      mac = null;
    }
    this.cache.set(ip, { mac, at: Date.now() });
    return mac;
  }
}

/**
 * The first profile whose every given criterion matches: IP exactly, MAC after normalising, model
 * case-insensitively. A criterion the client cannot provide (no MAC known, no model sent) does not
 * match, so a profile keyed on it never applies to the wrong device by default.
 */
export function matchProfile(profiles: readonly BridgeProfile[], identity: ClientIdentity): BridgeProfile | null {
  for (const profile of profiles) {
    const { ip, mac, model } = profile.match;
    if (ip && ip !== identity.ip) continue;
    if (mac && normalizeMac(mac) !== identity.mac) continue;
    if (model && model.toLowerCase() !== identity.model?.toLowerCase()) continue;
    if (!ip && !mac && !model) continue;
    return profile;
  }
  return null;
}
