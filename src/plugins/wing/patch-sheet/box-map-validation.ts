import type { WingBox, WingBoxMap } from "../wing-config.js";
import { findDeviceSpec, type DeviceSpec } from "./device-catalog.js";

/** How many ports each console group has: what a box range may not go beyond. */
export const GROUP_PORT_LIMIT: Record<string, number> = { A: 48, B: 48, C: 48, SC: 32, LCL: 24, CRD: 64, MOD: 64 };

/** Channels a box of this kind takes on the console (0: it takes none, a personal mixer plays a feed). */
export function specSize(spec: DeviceSpec): number {
  if (spec.id === "generic") return 0;
  if (spec.kind === "hub") return spec.outs;
  if (spec.kind === "card") return spec.ins;
  if (spec.kind === "personal-mixer") return 0;
  return spec.ins;
}

/** What the box-map editor needs to size a box: the catalogue without its code. */
export function catalogForEditor(catalog: readonly DeviceSpec[]): {
  id: string;
  label: string;
  kind: DeviceSpec["kind"];
  size: number;
  ins: number;
  outs: number;
  fixedStart?: number;
  match: { source: string; flags: string };
}[] {
  return catalog.map((d) => ({
    id: d.id,
    label: d.label,
    kind: d.kind,
    size: specSize(d),
    ins: d.ins,
    outs: d.outs,
    ...(d.kind === "hub" ? { fixedStart: 33 } : d.kind === "card" ? { fixedStart: 1 } : {}),
    match: { source: d.match.source, flags: d.match.flags },
  }));
}

/**
 * The reasons a box map cannot be right: a range beyond the ports of its group (A/B/C have 48, StageConnect
 * 32, an expansion card 64, the local ports 24), a box with more channels than its model has (a DL8 on
 * eight ports at most), a personal mixer playing more than 16 tracks. Shorter ranges are allowed: the
 * sheet draws a known box whole. Empty when the map is sound.
 */
export function validateBoxMap(map: WingBoxMap): string[] {
  const problems: string[] = [];
  // Boxes are linked by name (a P16-M "via" its host, a DL8 on a "hub"): a name used twice is ambiguous,
  // and a link to a name that is not there leads nowhere.
  const names = new Map<string, number>();
  for (const boxes of Object.values(map)) for (const b of boxes as WingBox[]) names.set(b.device, (names.get(b.device) ?? 0) + 1);
  for (const [name, n] of names) if (n > 1) problems.push(`The name "${name}" is used by ${n} boxes: give each box its own name.`);
  for (const boxes of Object.values(map)) {
    for (const b of boxes as WingBox[]) {
      for (const host of [b.via, b.hub]) if (host && !names.has(host)) problems.push(`${b.device} is plugged into "${host}", which is not in the list.`);
    }
  }
  for (const [group, boxes] of Object.entries(map)) {
    const limit = GROUP_PORT_LIMIT[group];
    for (const box of boxes as WingBox[]) {
      const where = `${box.device} (${group} ${box.range[0]}-${box.range[1]})`;
      if (box.range[0] > box.range[1]) problems.push(`${where}: the range starts after its end.`);
      if (!box.via) {
        if (limit !== undefined && box.range[1] > limit) problems.push(`${where}: group ${group} has ${limit} ports.`);
        const spec = findDeviceSpec(box.device, box.model, box.range[1] - box.range[0] + 1, group);
        const size = specSize(spec);
        const length = box.range[1] - box.range[0] + 1;
        if (size > 0 && length > size) problems.push(`${where}: a ${spec.label} has ${size} channels, not ${length}.`);
      }
      if (box.feed) {
        const feedGroup = box.feed.group ?? group;
        const feedLimit = GROUP_PORT_LIMIT[feedGroup];
        if (box.feed.range[0] > box.feed.range[1] || box.feed.range[1] - box.feed.range[0] > 15) problems.push(`${box.device}: the played ports must be an ascending range of at most 16.`);
        if (feedLimit !== undefined && box.feed.range[1] > feedLimit) problems.push(`${box.device}: group ${feedGroup} has ${feedLimit} ports.`);
      }
    }
  }
  return problems;
}
