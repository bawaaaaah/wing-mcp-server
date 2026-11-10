/**
 * What the patch sheet knows about the hardware plugged into the console. Data, not code: adding a
 * device is adding an entry. A box whose model matches nothing gets `genericSpec`, sized from its
 * box-map range.
 */
export interface DeviceSpec {
  id: string;
  /** "Midas DL8". */
  label: string;
  kind: "stagebox" | "converter" | "personal-mixer" | "generic";
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
    id: "klark-teknik-dn4816u",
    label: "Klark Teknik DN4816U",
    kind: "converter",
    ins: 16,
    outs: 16,
    connectors: "StageCONNECT · Ultranet 16 voies · USB",
    match: /\bDN-?4816/i,
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
