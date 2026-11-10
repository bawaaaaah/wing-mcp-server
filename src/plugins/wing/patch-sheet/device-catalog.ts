/**
 * What the patch sheet knows about the hardware plugged into the console. Data, not code: adding a
 * device is adding an entry. A box whose model matches nothing gets `genericSpec`, sized from its
 * box-map range.
 */
export interface DeviceSpec {
  id: string;
  /** "Midas DL8". */
  label: string;
  kind: "stagebox" | "converter" | "personal-mixer" | "hub" | "generic";
  /** Physical inputs / outputs the box offers to the console (the box-map range is clipped to these). */
  ins: number;
  outs: number;
  /** Connector wording of the sheet's subtitle. */
  connectors: string;
  /** Matched against `"<model> <device>"` of the box-map entry. */
  match: RegExp;
}

export const DEVICE_CATALOG: readonly DeviceSpec[] = [
  {
    id: "midas-dl8",
    label: "Midas DL8",
    kind: "stagebox",
    ins: 8,
    outs: 8,
    connectors: "entrées combo XLR/Jack femelle · sorties XLR mâle",
    match: /\bDL-?8\b/i,
  },
  {
    id: "midas-dl16",
    label: "Midas DL16",
    kind: "stagebox",
    ins: 16,
    outs: 8,
    connectors: "entrées combo XLR/Jack femelle · sorties XLR mâle · Ultranet",
    match: /\bDL-?16\b/i,
  },
  {
    id: "midas-dl32",
    label: "Midas DL32",
    kind: "stagebox",
    ins: 32,
    outs: 16,
    connectors: "entrées combo XLR/Jack femelle · sorties XLR mâle · Ultranet",
    match: /\bDL-?32\b/i,
  },
  {
    // The WING Rack's own back panel (LCL ports of the console) or a rack used as a remote box:
    // 24 XLR/jack combo inputs and 8 XLR outputs. Its four headphone-style jack pairs are not mapped.
    id: "behringer-wing-rack",
    label: "Behringer WING Rack",
    kind: "stagebox",
    ins: 24,
    outs: 8,
    connectors: "24 entrées combo XLR/Jack · 8 sorties XLR",
    match: /\bWING[\s-]*Rack\b/i,
  },
  {
    // Same back panel as the Rack: 24 XLR/jack combo inputs and 8 XLR outputs (+ AES50 A/B/C, StageConnect).
    id: "behringer-wing-compact",
    label: "Behringer WING Compact",
    kind: "stagebox",
    ins: 24,
    outs: 8,
    connectors: "24 entrées combo XLR/Jack · 8 sorties XLR",
    match: /\bWING[\s-]*Compact\b/i,
  },
  {
    // A rack X32 used as a remote stage box over AES50: 16 XLR mic inputs and 8 XLR outputs.
    // Its aux jacks and monitor outs are not mapped (they are not part of its AES50 stage-box role).
    id: "behringer-x32-rack",
    label: "Behringer X32 Rack",
    kind: "stagebox",
    ins: 16,
    outs: 8,
    connectors: "16 entrées XLR · 8 sorties XLR · AES50",
    match: /\bX32[\s-]*Rack\b/i,
  },
  {
    id: "klark-teknik-dn4816u",
    label: "Klark Teknik DN4816U",
    kind: "converter",
    ins: 16,
    outs: 16,
    connectors: "StageCONNECT · Ultranet 16 voies · USB",
    match: /\bDN-?4816/i,
  },
  {
    // Distributes Ultranet to personal mixers: no audio connector of its own, so no page.
    id: "behringer-hub4",
    label: "Behringer HUB4",
    kind: "hub",
    ins: 0,
    outs: 0,
    connectors: "",
    match: /\bHUB-?4\b/i,
  },
  {
    id: "behringer-p16m",
    label: "Behringer P16-M",
    kind: "personal-mixer",
    ins: 0,
    outs: 16,
    connectors: "Ultranet · 16 canaux",
    match: /\bP-?16-?M\b/i,
  },
];

export function genericSpec(device: string, model: string | undefined, rangeLength: number): DeviceSpec {
  return {
    id: "generic",
    label: model && model !== device ? `${model}` : device,
    kind: "generic",
    ins: rangeLength,
    outs: rangeLength,
    connectors: "",
    match: /^$/,
  };
}

export function findDeviceSpec(device: string, model: string | undefined, rangeLength: number): DeviceSpec {
  const hay = `${model ?? ""} ${device}`;
  return DEVICE_CATALOG.find((d) => d.match.test(hay)) ?? genericSpec(device, model, rangeLength);
}

/**
 * The console output ports a box hung off another one plays. The box's own `feed` wins; otherwise a
 * DL16/DL32 host plays tracks 33-48 of its group and any other host its first 16 ports.
 */
export function resolveFeed(
  box: { range: [number, number]; feed?: { group?: string; range: [number, number] } },
  group: string,
  host: { range: [number, number]; spec: DeviceSpec } | undefined,
): { group: string; range: [number, number] } {
  if (box.feed) return { group: box.feed.group ?? group, range: box.feed.range };
  if (host?.spec.id === "midas-dl16" || host?.spec.id === "midas-dl32" || host?.spec.id === "behringer-hub4") return { group, range: [33, 48] };
  if (host) return { group, range: [host.range[0], Math.min(host.range[1], host.range[0] + 15)] };
  return { group, range: box.range };
}
