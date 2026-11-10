import type { WingBox, WingBoxMap } from "../wing-config.js";
import { getAesLinkStatus, type AesLinkStatus } from "../wing-link-status.js";
import type { WingPluginContext } from "../wing-plugin.js";
import { findDeviceSpec } from "./device-catalog.js";

export interface DetectedBoxMap {
  /** The console model as it reports it ("wing-rack", "wing-compact", "ngc-full"...). */
  consoleModel: string;
  boxMap: WingBoxMap;
  /** What was guessed and what could not be known: shown next to the suggestion. */
  notes: string[];
  links: AesLinkStatus;
}

/** The console's own back panel, by model; undefined when the model is not one we draw. */
function localBox(consoleModel: string): WingBox | undefined {
  const m = consoleModel.toLowerCase();
  if (m.includes("rack")) return { range: [1, 24], device: "Local", model: "Behringer WING Rack" };
  if (m.includes("compact")) return { range: [1, 24], device: "Local", model: "Behringer WING Compact" };
  if (m.includes("full") || m.includes("ngc")) return { range: [1, 8], device: "Local", model: "Behringer WING Full" };
  return undefined;
}

function tokens(devices: string): string[] {
  return devices
    .split(/[,;]/)
    .map((t) => t.trim())
    .filter((t) => t !== "" && t !== "-");
}

/**
 * Lays out the devices a link reports on one port (a comma-separated model list such as "HUB4,DL8"):
 * boxes follow each other from channel 1 by their number of inputs, a hub serves 33-48 and the
 * boxes after it sit on its ports. Pure: tested without a console.
 */
export function layoutLinkDevices(group: string, devices: string, notes: string[]): WingBox[] {
  const list = tokens(devices);
  const out: WingBox[] = [];
  const seen = new Map<string, number>();
  const name = (token: string, total: number): string => {
    const n = (seen.get(token) ?? 0) + 1;
    seen.set(token, n);
    return total > 1 ? `${token}-${n}` : token;
  };
  const count = (token: string): number => list.filter((t) => t === token).length;
  let cursor = 1;
  let hub: string | undefined;
  for (const token of list) {
    const spec = findDeviceSpec(token, token, 8);
    if (spec.kind === "hub") {
      hub = name(token, count(token));
      out.push({ range: [33, 48], device: hub, model: spec.label });
      continue;
    }
    if (spec.kind === "personal-mixer") continue;
    const ins = spec.id === "generic" ? 8 : spec.ins;
    if (spec.id === "generic") notes.push(`${group}: unknown device "${token}": given 8 ports, set its model and range yourself.`);
    const hi = cursor + ins - 1;
    if (hi > 48) {
      notes.push(`${group}: "${token}" does not fit in the 48 channels of an AES50 link: left out.`);
      continue;
    }
    out.push({ range: [cursor, hi], device: name(token, count(token)), model: spec.id === "generic" ? token : spec.label, ...(hub && ins <= 8 ? { hub } : {}) });
    cursor = hi + 1;
  }
  if (hub) notes.push(`${group}: a ${hub} serves channels 33-48; the boxes on its ports are placed from channel 1 in the order the console lists them: check which port each sits on.`);
  return out;
}

/** Builds a box map from what the console reports about itself and its AES50 / StageConnect links. */
export function buildBoxMapFromLinks(consoleModel: string, links: AesLinkStatus): { boxMap: WingBoxMap; notes: string[] } {
  const boxMap: WingBoxMap = {};
  const notes: string[] = [];
  const local = localBox(consoleModel);
  if (local) boxMap.LCL = [local];
  else notes.push(`Console model "${consoleModel}" is not one the sheet draws: its local ports are not described.`);
  for (const port of links.ports) {
    const up = port.state.trim() !== "" && port.state.trim() !== "-";
    if (!up) continue;
    if (port.device.trim() === "") {
      notes.push(`${port.port}: link up${port.remoteName ? ` to "${port.remoteName}"` : ""} but the console names no device.`);
      continue;
    }
    boxMap[port.port] = layoutLinkDevices(port.port, port.device, notes);
    if (port.remoteName) notes.push(`${port.port}: the console shows it as "${port.remoteName}".`);
  }
  const sc = tokens(links.stageConnect.devices);
  if (sc.length > 0) boxMap.SC = layoutLinkDevices("SC", links.stageConnect.devices, notes);
  const hasUltranet = Object.values(boxMap).flat().some((b) => /DN4816|DL16|DL32|HUB/i.test(`${b.model ?? ""} ${b.device}`));
  if (hasUltranet) notes.push("Personal mixers (P16-M) are not reported: add one as a box plugged into the converter, hub or stage box that feeds it (default tracks: its first 16 ports, or 33-48 on a DL16, DL32 or HUB4).");
  notes.push("Expansion cards (WING-LIVE, Dante...) are not reported by the console: add them as boxes on group CRD (WING-LIVE) or MOD (Dante and others).");
  return { boxMap, notes };
}

export async function detectBoxMap(ctx: WingPluginContext): Promise<DetectedBoxMap> {
  const model = await ctx.client.get("/$syscfg/$cnsmdl").then((r) => (r.kind === "leaf" ? String(r.value) : ""));
  const links = await getAesLinkStatus(ctx);
  return { consoleModel: model, links, ...buildBoxMapFromLinks(model, links) };
}
