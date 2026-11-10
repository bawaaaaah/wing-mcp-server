/**
 * What the patch sheet knows about the hardware plugged into the console. Data, not code: adding a
 * device is adding an entry. A box whose model matches nothing gets `genericSpec`, sized from its
 * box-map range.
 */
/** What the connector looks like from the front: XLR female (holes), XLR male (pins), jack socket, a combo of both, or an etherCON (RJ45 in a round XLR-style shell: AES50, StageConnect-less). */
export type Connector = "xlr-f" | "xlr-m" | "jack" | "combo" | "ethercon";

export interface DeviceSpec {
  id: string;
  /** "Midas DL8". */
  label: string;
  kind: "stagebox" | "converter" | "personal-mixer" | "hub" | "card" | "generic";
  /** Physical inputs / outputs the box offers to the console (the box-map range is clipped to these). */
  ins: number;
  outs: number;
  /** Input / output connectors as drawn on the front. Default: XLR female in, XLR male out. */
  inConn?: Connector;
  outConn?: Connector;
  /** Has an Ultranet port (RJ45, on the back panel) a P16-M plugs into. */
  ultranet?: boolean;
  /** Has output modes (DL16, S16): XLR outputs on AES50 ch 1-8 / 9-16 / 17-24, and a splitter mode. */
  outModes?: boolean;
  /** Connector wording of the sheet's subtitle. */
  connectors: string;
  /** Matched against `"<model> <device>"` of the box-map entry. */
  match: RegExp;
}

export const DEVICE_CATALOG: readonly DeviceSpec[] = [
  {
    id: "midas-dl8",
    inConn: "combo",
    label: "Midas DL8",
    kind: "stagebox",
    ins: 8,
    outs: 8,
    connectors: "entrées combo XLR/Jack femelle · sorties XLR mâle",
    match: /\bDL-?8\b/i,
  },
  {
    id: "midas-dl16",
    ultranet: true,
    outModes: true,
    label: "Midas DL16",
    kind: "stagebox",
    ins: 16,
    outs: 8,
    connectors: "16 entrées XLR · 8 sorties XLR mâle · Ultranet",
    match: /\bDL-?16\b/i,
  },
  {
    id: "midas-dl32",
    ultranet: true,
    label: "Midas DL32",
    kind: "stagebox",
    ins: 32,
    outs: 16,
    connectors: "32 entrées XLR · 16 sorties XLR mâle · Ultranet",
    match: /\bDL-?32\b/i,
  },
  {
    // The WING Rack's own back panel (LCL ports of the console) or a rack used as a remote box:
    // 24 XLR/jack combo inputs and 8 XLR outputs. Its four headphone-style jack pairs are not mapped.
    id: "behringer-wing-rack",
    inConn: "combo",
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
    inConn: "combo",
    label: "Behringer WING Compact",
    kind: "stagebox",
    ins: 24,
    outs: 8,
    connectors: "24 entrées combo XLR/Jack · 8 sorties XLR",
    match: /\bWING[\s-]*Compact\b/i,
  },
  {
    id: "behringer-s16",
    ultranet: true,
    outModes: true,
    label: "Behringer S16",
    kind: "stagebox",
    ins: 16,
    outs: 8,
    connectors: "16 entrées XLR · 8 sorties XLR · AES50",
    match: /\bS-?16\b/i,
  },
  {
    id: "behringer-s32",
    ultranet: true,
    label: "Behringer S32",
    kind: "stagebox",
    ins: 32,
    outs: 16,
    connectors: "32 entrées XLR · 16 sorties XLR · AES50",
    match: /\bS-?32\b/i,
  },
  {
    // The full-size WING's own back panel (LCL ports): 8 XLR/jack combo inputs and 8 XLR outputs.
    // Its AUX in/out jacks, lamp and talkback connectors are not mapped.
    id: "behringer-wing-full",
    inConn: "combo",
    label: "Behringer WING",
    kind: "stagebox",
    ins: 8,
    outs: 8,
    connectors: "8 entrées combo XLR/Jack · 8 sorties XLR",
    match: /\bWING[\s-]*Full/i,
  },
  {
    // A rack X32 used as a remote stage box over AES50: 16 XLR mic inputs and 8 XLR outputs.
    // Its aux jacks and monitor outs are not mapped (they are not part of its AES50 stage-box role).
    id: "behringer-x32-rack",
    ultranet: true,
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
    // Hub of AES50-A: four RJ45 ports take DL8s directly (A 1-8, 9-16, 17-24, 25-32) and A 33-48 are
    // served on its StageCONNECT output and as local outputs (4 ports x 4 signals).
    id: "midas-hub4",
    label: "Midas HUB4",
    kind: "hub",
    ins: 0,
    outs: 16,
    connectors: "AES50 · 4 ports DL8 · StageCONNECT · sorties A 33-48",
    match: /\bHUB-?4\b/i,
  },
  {
    // Expansion cards: 64 channels each way on the console's CRD (WING-LIVE) or MOD (Dante...) group.
    id: "wing-live",
    label: "WING-LIVE",
    kind: "card",
    ins: 64,
    outs: 64,
    connectors: "2 x carte SD · SD 1 = voies 1-32 · SD 2 = voies 33-64 (WLIVE PLAY)",
    match: /\bW(ING)?[\s-]*LIVE\b/i,
  },
  {
    id: "wing-dante",
    label: "WING-DANTE",
    kind: "card",
    ins: 64,
    outs: 64,
    connectors: "carte Dante · 64 canaux",
    match: /\bDANTE\b/i,
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

export function genericSpec(device: string, model: string | undefined, rangeLength: number, kind: DeviceSpec["kind"] = "generic"): DeviceSpec {
  return {
    id: "generic",
    label: model && model !== device ? `${model}` : device,
    kind,
    ins: rangeLength,
    outs: rangeLength,
    connectors: "",
    match: /^$/,
  };
}

/** An unknown device on a card group (CRD, MOD) is still a card: only its used channels are listed. */
const CARD_GROUPS = new Set(["CRD", "MOD"]);

export function findDeviceSpec(device: string, model: string | undefined, rangeLength: number, group?: string): DeviceSpec {
  // The model decides; the name only when the model matches nothing (a "DL8-1" set to a DL16 is a DL16).
  const known = (model ? DEVICE_CATALOG.find((d) => d.match.test(model)) : undefined) ?? DEVICE_CATALOG.find((d) => d.match.test(device));
  if (known) return known;
  return genericSpec(device, model, rangeLength, group && CARD_GROUPS.has(group) ? "card" : "generic");
}

/** Hosts whose personal mixers play tracks 33-48 of their group (the 16 Ultranet channels). */
const P16_HOSTS_33_48: ReadonlySet<string> = new Set(["midas-dl16", "midas-dl32", "midas-hub4", "behringer-s16", "behringer-s32", "behringer-x32-rack"]);

/**
 * The console output ports a box hung off another one plays. The box's own `feed` wins; otherwise a
 * DL16/DL32 host plays tracks 33-48 of its group and any other host its first 16 ports.
 */
export function resolveFeed(
  box: { range: [number, number]; feed?: { group?: string; range: [number, number] } },
  group: string,
  host: { range: [number, number]; spec: DeviceSpec; group?: string } | undefined,
): { group: string; range: [number, number] } {
  // Without an explicit group the tracks are the host's own: a DN4816U on StageConnect plays SC 1-16.
  const hostGroup = host?.group ?? group;
  if (box.feed) return { group: box.feed.group ?? hostGroup, range: box.feed.range };
  if (host && P16_HOSTS_33_48.has(host.spec.id)) return { group: hostGroup, range: [33, 48] };
  if (host) return { group: hostGroup, range: [host.range[0], Math.min(host.range[1], host.range[0] + 15)] };
  return { group, range: box.range };
}

/** The connectors line of a box's subtitle, in the sheet's language. */
const CONNECTORS_EN: Record<string, string> = {
  "midas-dl8": "combo XLR/jack inputs · XLR male outputs",
  "midas-dl16": "16 XLR inputs · 8 XLR male outputs · Ultranet",
  "midas-dl32": "32 XLR inputs · 16 XLR male outputs · Ultranet",
  "behringer-wing-rack": "24 combo XLR/jack inputs · 8 XLR outputs",
  "behringer-wing-compact": "24 combo XLR/jack inputs · 8 XLR outputs",
  "behringer-wing-full": "8 combo XLR/jack inputs · 8 XLR outputs",
  "behringer-s16": "16 XLR inputs · 8 XLR outputs · AES50",
  "behringer-s32": "32 XLR inputs · 16 XLR outputs · AES50",
  "behringer-x32-rack": "16 XLR inputs · 8 XLR outputs · AES50",
  "klark-teknik-dn4816u": "StageCONNECT · 16-channel Ultranet · USB",
  "midas-hub4": "AES50 · 4 DL8 ports · StageCONNECT · outputs A 33-48",
  "behringer-p16m": "Ultranet · 16 channels",
  "wing-live": "2 x SD card · SD 1 = channels 1-32 · SD 2 = channels 33-64 (WLIVE PLAY)",
  "wing-dante": "Dante card · 64 channels",
};

export function connectorsText(spec: DeviceSpec, lang: "fr" | "en" | undefined): string {
  return lang === "en" ? (CONNECTORS_EN[spec.id] ?? spec.connectors) : spec.connectors;
}
