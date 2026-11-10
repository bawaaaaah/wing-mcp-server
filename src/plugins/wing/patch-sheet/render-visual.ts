import PDFDocument from "pdfkit";
import type { Connector } from "./device-catalog.js";
import { COLOR_BUS, COLOR_COMPUTER, COLOR_FREE, COLOR_MAIN, COLOR_USER } from "./colors.js";
import { pdfSafe } from "./pdf-writer.js";
import { cellLines, type BoxPage, type NamingMode, type PatchSheetModel, type PortCell } from "./patch-model.js";

type Doc = InstanceType<typeof PDFDocument>;

const W = 842;
const H = 595;
const M = 40;
const INK = "#1f2430";
const MUTED = "#6b7280";
const RULE = "#d8dbe0";
const CARD = "#f4f5f7";
const GRID = W - 2 * M;

const KIND_COLOR: Record<string, string> = {
  stagebox: "#8e44ad",
  converter: "#2d9cdb",
  "personal-mixer": "#2d9cdb",
  hub: "#2d9cdb",
  generic: "#8e44ad",
};

/**
 * A connector as seen from the front, drawn large enough to tell apart: a coloured ring (the
 * channel's colour), then an XLR female (three holes and its latch), an XLR male (three gold pins),
 * a jack socket (hex nut round a hole) or a combo (XLR holes around a jack hole).
 */
/** The release button of a console-style female connector: a small grey tab just above its ring. */
function pushButton(doc: Doc, cx: number, cy: number, r: number): void {
  const w = r * 1.05;
  doc.roundedRect(cx - w / 2, cy - r - 3 - r * 0.2, w, r * 0.5, r * 0.12).fill("#cfc9bb");
}

function plug(doc: Doc, kind: Connector, cx: number, cy: number, r: number, color: string): void {
  doc.circle(cx, cy, r + 3).lineWidth(3).strokeColor(color).stroke();
  doc.circle(cx, cy, r).fill("#9ea4ad");
  doc.circle(cx, cy, r - 1.6).fill("#0d0f14");
  if (kind === "jack") {
    const hex = Array.from({ length: 6 }, (_, i) => [cx + Math.cos((Math.PI / 3) * i) * r * 0.72, cy + Math.sin((Math.PI / 3) * i) * r * 0.72] as [number, number]);
    doc.polygon(...hex).fill("#d4d7dc");
    doc.circle(cx, cy, r * 0.34).fill("#000000");
    return;
  }
  if (kind === "ethercon") {
    // RJ45 socket in a round shell: latch on top, the contact comb along the bottom.
    pushButton(doc, cx, cy, r);
    doc.roundedRect(cx - r * 0.62, cy - r * 0.5, r * 1.24, r * 1.0, 2).fill("#c9ccd1");
    doc.roundedRect(cx - r * 0.5, cy - r * 0.38, r * 1.0, r * 0.72, 1.5).fill("#0d0f14");
    for (let i = 0; i < 8; i++) doc.rect(cx - r * 0.44 + i * r * 0.125, cy + r * 0.1, r * 0.055, r * 0.2).fill("#d4a72c");
    return;
  }
  // The three contacts sit on one circle at 3, 6 and 9 o'clock (90, 180 and 270 degrees, the key
  // notch being 0), male and female alike.
  const rho = 0.52;
  const holes: [number, number][] = [[-rho, 0], [rho, 0], [0, rho]];
  if (kind === "xlr-m") {
    doc.rect(cx - r * 0.2, cy - r * 0.84, r * 0.4, r * 0.22).fill("#d4a72c");
    for (const [dx, dy] of holes) doc.circle(cx + dx * r, cy + dy * r, r * 0.13).fill("#d4a72c");
    return;
  }
  // XLR female and combo: release button above the ring, key notch, three holes with a visible rim.
  pushButton(doc, cx, cy, r);
  if (kind === "combo") {
    // The jack hole fills the middle; the XLR holes ring it.
    const combo: [number, number][] = [[-0.68, 0], [0.68, 0], [0, 0.68]];
    for (const [dx, dy] of combo) doc.circle(cx + dx * r, cy + dy * r, r * 0.13).fillAndStroke("#000000", "#8b919b");
    doc.circle(cx, cy + r * 0.02, r * 0.27).lineWidth(1).fillAndStroke("#000000", "#8b919b");
    return;
  }
  doc.rect(cx - r * 0.22, cy - r * 0.62, r * 0.44, r * 0.2).fill("#1b1f27");
  for (const [dx, dy] of holes) doc.circle(cx + dx * r, cy + dy * r, r * 0.19).fillAndStroke("#000000", "#8b919b");
}

function text(doc: Doc, s: string, x: number, y: number, opts: { size: number; bold?: boolean; color?: string; width?: number; align?: "left" | "center" | "right"; height?: number }): void {
  doc
    .font(opts.bold ? "Helvetica-Bold" : "Helvetica")
    .fontSize(opts.size)
    .fillColor(opts.color ?? INK)
    .text(pdfSafe(s), x, y, { width: opts.width, align: opts.align ?? "left", height: opts.height, ellipsis: true, lineBreak: opts.width !== undefined });
}

function header(doc: Doc, title: string, subtitle: string): void {
  text(doc, title, M, 34, { size: 24, bold: true });
  text(doc, subtitle, M, 66, { size: 10, color: MUTED, width: GRID - 200 });
  doc.moveTo(M, 90).lineTo(W - M, 90).lineWidth(0.7).strokeColor(RULE).stroke();
}

function card(doc: Doc, x: number, y: number, w: number, h: number, bar: string, title: string, lines: string[], dim = false): void {
  doc.roundedRect(x, y, w, h, 6).fill(dim ? "#f7f8f9" : CARD);
  doc.roundedRect(x, y, w, h, 6).lineWidth(1.6).strokeColor(dim ? COLOR_FREE : bar).stroke();
  doc.save().roundedRect(x, y, w, 7, 4).clip().rect(x, y, w, 7).fill(dim ? COLOR_FREE : bar).restore();
  text(doc, title, x + 6, y + 16, { size: 11, bold: true, color: dim ? MUTED : INK, width: w - 12, align: "center", height: 14 });
  lines.slice(0, 4).forEach((l, i) => text(doc, l, x + 6, y + 32 + i * 10, { size: 7.5, color: MUTED, width: w - 12, align: "center", height: 10 }));
}

function link(doc: Doc, x1: number, y1: number, x2: number, y2: number): void {
  doc.moveTo(x1, y1).lineTo(x2, y2).lineWidth(1).strokeColor("#6b7280").stroke();
}

function usedCount(b: BoxPage): number {
  return b.inputs.filter((c) => c.used).length + b.outputs.filter((c) => c.used).length;
}

function consoleGroups(model: PatchSheetModel): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const s of model.consoleSources) {
    const g = s.label.replace(/ [\d-]+$/, "");
    const list = out.get(g) ?? [];
    list.push(s.name || s.channelNames.join(" + "));
    out.set(g, list);
  }
  return out;
}

function overview(doc: Doc, model: PatchSheetModel, title: string): void {
  header(doc, title, "Vue d'ensemble du câblage");
  const cw = 190;
  const cx = (W - cw) / 2;
  card(doc, cx, 118, cw, 62, INK, "Behringer WING", ["Régie"]);

  const groups = consoleGroups(model);
  const computers = ["USB AUDIO", "USB PLAYER", "DANTE", "WLIVE PLAY"].filter((g) => groups.has(g));
  const left = computers.map((g) => `${g} : ${(groups.get(g) as string[]).slice(0, 3).join(", ")}`);
  if (left.length > 0) {
    card(doc, M, 118, 170, 62, COLOR_COMPUTER, "Ordinateurs / sources", left);
    link(doc, M + 170, 149, cx, 149);
  }
  const rest = [...groups.keys()].filter((g) => !computers.includes(g));
  const right = rest.map((g) => `${g} : ${(groups.get(g) as string[]).length} sources`);
  // The console's own ports (box-map group LCL) are drawn beside it, not on the AES50 line.
  const local = model.boxes.find((b) => b.group === "LCL" && !b.via);
  if (local) {
    card(doc, W - M - 170, 118, 170, 62, KIND_COLOR[local.spec.kind] ?? "#8e44ad", /^local$/i.test(local.device) ? "Ports locaux" : local.device, [local.spec.label, `${local.inputs.filter((c) => c.used).length} entrées · ${local.outputs.filter((c) => c.used).length} sorties`, ...right.slice(0, 1)]);
    link(doc, cx + cw, 149, W - M - 170, 149);
  } else if (right.length > 0) {
    card(doc, W - M - 170, 118, 170, 62, "#8e44ad", "Entrées console", right);
    link(doc, cx + cw, 149, W - M - 170, 149);
  }

  const hosts = model.boxes.filter((b) => !b.via && !b.hub && b.group !== "LCL" && b.spec.kind !== "card");
  const n = Math.max(1, hosts.length);
  const bw = Math.min(150, (GRID - (n - 1) * 14) / n);
  const gap = n > 1 ? (GRID - n * bw) / (n - 1) : 0;
  const total = n * bw + (n - 1) * gap;
  const x0 = (W - total) / 2;
  const busY = 240;
  const groupsUsed = [...new Set(hosts.map((b) => b.group))];
  link(doc, W / 2, 180, W / 2, busY);
  if (hosts.length > 0) link(doc, x0 + bw / 2, busY, x0 + total - bw / 2, busY);
  text(doc, `AES50-${groupsUsed.join("/")}`, W / 2 + 6, busY - 12, { size: 8, bold: true, color: MUTED, width: 120 });
  hosts.forEach((b, i) => {
    const x = x0 + i * (bw + gap);
    link(doc, x + bw / 2, busY, x + bw / 2, 262);
    const lines = [`${b.group} ${b.range[0]}-${b.range[1]}`, usedCount(b) === 0 ? "non utilisé" : `${b.inputs.filter((c) => c.used).length} entrées · ${b.outputs.filter((c) => c.used).length} sorties`];
    card(doc, x, 262, bw, 66, KIND_COLOR[b.spec.kind] ?? "#8e44ad", b.device, [b.spec.label !== b.device ? b.spec.label : "", ...lines], usedCount(b) === 0);
    // Boxes hung under this one: a hub's DL8s (AES50 ports), personal mixers (Ultranet).
    const kids = model.boxes.filter((k) => k.via === b.device || k.hub === b.device);
    if (kids.length > 0) {
      const kw = Math.min(150, (GRID - (kids.length - 1) * 12) / kids.length);
      const kidsW = kids.length * kw + (kids.length - 1) * 12;
      const start = Math.min(Math.max(x + bw / 2 - kidsW / 2, M), W - M - kidsW);
      link(doc, x + bw / 2, 328, x + bw / 2, 352);
      link(doc, start + kw / 2, 352, start + kidsW - kw / 2, 352);
      kids.forEach((k, j) => {
        const kx = start + j * (kw + 12);
        link(doc, kx + kw / 2, 352, kx + kw / 2, 380);
        const port = k.hub ? Math.floor((k.range[0] - 1) / 8) + 1 : 0;
        card(doc, kx, 380, kw, 66, KIND_COLOR[k.spec.kind] ?? "#2d9cdb", k.device, [
          k.spec.label !== k.device ? k.spec.label : "",
          k.via ? `${k.group} ${k.range[0]}-${k.range[1]} → pistes 1-16` : `${k.group} ${k.range[0]}-${k.range[1]}`,
          k.hub && k.range[0] >= 33 ? `StageConnect du ${k.hub}` : k.hub && port >= 1 && port <= 4 ? `port ${port} du ${k.hub}` : k.via ? "Ultranet" : "",
        ]);
      });
    }
  });
  // Expansion cards sit in their own row: they are not on an AES50 link.
  const cards = model.boxes.filter((b) => b.spec.kind === "card");
  if (cards.length > 0) {
    text(doc, "CARTES D'EXTENSION", M, 442, { size: 8, bold: true, color: MUTED });
    cards.forEach((c, i) => {
      const used = c.inputs.filter((p) => p.used).length + c.outputs.filter((p) => p.used).length;
      card(doc, M + i * 166, 456, 154, 58, "#2d9cdb", c.device, [c.spec.label !== c.device ? c.spec.label : "", used === 0 ? "non utilisée" : `${used} voies utilisées`], used === 0);
    });
  }
  legend(doc, model);
}

function legend(doc: Doc, model: PatchSheetModel): void {
  const items: [string, string][] = [
    [COLOR_COMPUTER, "Ordinateurs / sources"],
    [COLOR_BUS, "Retours in-ear (bus)"],
    [COLOR_MAIN, "Façade (main / matrix)"],
    [COLOR_USER, "User signals"],
    [COLOR_FREE, "Libre / non utilisé"],
  ];
  const seen = new Map<string, string>();
  for (const b of model.boxes) for (const c of [...b.inputs]) if (c.color && c.colorName) seen.set(c.color, c.colorName);
  for (const [hex, name] of seen) items.push([hex, `Couleur WING ${name}`]);
  let x = M;
  let y = 520;
  for (const [color, label] of items) {
    const w = 24 + label.length * 4.4 + 12;
    if (x + w > W - M) { x = M; y += 16; }
    doc.roundedRect(x, y, 16, 6, 3).fill(color);
    text(doc, label, x + 22, y - 1, { size: 8, color: MUTED });
    x += w;
  }
}

/** Column geometry: ports are laid out on `n` equal columns across the page. */
function columns(box: BoxPage): number {
  return Math.max(box.spec.ins, box.spec.outs, ...box.inputs.map((c) => c.port + c.span - 1), ...box.outputs.map((c) => c.port + c.span - 1), 1);
}

function strip(doc: Doc, label: string, cells: PortCell[], n: number, y: number, naming: NamingMode): void {
  text(doc, label, M, y, { size: 8, bold: true, color: MUTED });
  const colW = GRID / n;
  for (const c of cells) {
    const x = M + (c.port - 1) * colW + 3;
    const w = c.span * colW - 6;
    doc.roundedRect(x, y + 14, w, 4, 2).fill(c.used ? (c.color ?? COLOR_USER) : COLOR_FREE);
    const lines = cellLines(c, naming);
    const size = n > 8 ? 7.5 : 9;
    lines.slice(0, 3).forEach((l, i) => text(doc, l, x, y + 24 + i * (size + 3), { size: i === 0 ? size : size - 1, bold: i === 0 && c.used, color: c.used ? (i === 0 ? INK : MUTED) : "#9ca3af", width: w, align: "center", height: size + 2 }));
    const sub = [c.patch, c.mode && c.mode !== "M" ? c.mode : "", c.phantom48v ? "48V" : ""].filter(Boolean).join(" · ");
    if (c.used && sub) text(doc, sub, x, y + 24 + Math.min(lines.length, 3) * (size + 3), { size: 6.5, color: "#9ca3af", width: w, align: "center", height: 9 });
  }
}

/** The box's front, drawn from its catalogue entry. Ring colours follow the cells. */
/** Vertical pitch of a ring row on a multi-row face (room for the number above each ring). */
const MULTI_ROW = 40;
function multiRowFaceHeight(inRows: number): number {
  return 46 + (inRows + 1) * MULTI_ROW - 6;
}

const WING_FACE_H = 200;
const WING_STRIP_PITCH = 58;

/** The WING Rack and Compact share a back panel, drawn as it is on the unit. */
function hasWingBackPanel(box: BoxPage): boolean {
  return box.spec.id === "behringer-wing-rack" || box.spec.id === "behringer-wing-compact";
}

/**
 * WING Rack / Compact back: eight XLR outputs over four stereo jacks on the left, the 24 combo inputs
 * in three rows on the right, and along the bottom the two network ports, AES50 A/B/C, StageCONNECT,
 * AES/EBU out and in and the WING-LIVE slot. The jacks and the bottom row carry no patch data of their
 * own; AES50 and StageCONNECT list the boxes the box map puts on them.
 */
function wingBackPanel(doc: Doc, box: BoxPage, model: PatchSheetModel): void {
  const y0 = 104;
  doc.roundedRect(M, y0, GRID, WING_FACE_H, 10).fill("#1b1f27");
  text(doc, box.spec.label.toUpperCase(), M + 14, y0 + 122, { size: 9, bold: true, color: "#6b7280" });
  const colorOf = (c: PortCell | undefined): string => (c?.used ? (c.color ?? COLOR_USER) : "#3a4050");
  const rowY = (r: number): number => y0 + 34 + r * 40;
  const label = (s: string, cx: number, y: number, size = 6.5): void => text(doc, s, cx - 30, y, { size, bold: true, color: "#c9ccd1", width: 60, align: "center" });

  // Left: OUT 1-8 (XLR male) in one framed block, the four stereo jacks in a block below it, each
  // jack centred between the two outputs of its pair.
  const frame = (y: number, h: number): void => {
    doc.roundedRect(M + 4, y, 8 * 32 + 20, h, 6).lineWidth(0.8).strokeColor("#3a4050").stroke();
  };
  frame(y0 + 6, 48);
  frame(y0 + 58, 46);
  for (let i = 0; i < 8; i++) {
    const cx = M + 22 + i * 32;
    plug(doc, "xlr-m", cx, rowY(0), 11, colorOf(box.outputs.find((c) => c.port <= i + 1 && i + 1 < c.port + c.span)));
    label(`${i + 1}`, cx, rowY(0) - 23, 6.5);
  }
  ["2/1", "4/3", "6/5", "8/7"].forEach((l, j) => {
    const cx = M + 22 + (2 * j + 0.5) * 32;
    plug(doc, "jack", cx, y0 + 86, 11, "#3a4050");
    label(l, cx, y0 + 61, 6.5);
  });

  // Right: IN 1-24 (combo), three rows of eight.
  const x0 = M + 300;
  const colW = (GRID - 300) / 8;
  for (const c of box.inputs) {
    for (let k = 0; k < c.span; k++) {
      const idx = c.port - 1 + k;
      const cx = x0 + ((idx % 8) + 0.5) * colW;
      const cy = rowY(Math.floor(idx / 8));
      plug(doc, "combo", cx, cy, 11, colorOf(c));
      label(String(idx + 1), cx, cy - 22, 6.5);
    }
  }

  // Bottom: network, AES50 A/B/C, StageCONNECT, AES/EBU, expansion slot.
  const by = y0 + 162;
  const boxesOn = (g: string): string => {
    const names = model.boxes.filter((b) => b.group === g && !b.via && b.spec.kind !== "personal-mixer").map((b) => b.device);
    return names.length === 0 ? "" : names.length > 2 ? `${names.length} boîtiers` : names.join(", ");
  };
  [0, 1].forEach((i) => {
    doc.roundedRect(M + 20 + i * 40, by - 9, 26, 18, 3).fill("#c9ccd1");
    doc.roundedRect(M + 24 + i * 40, by - 5, 18, 10, 2).fill("#0d0f14");
  });
  label("NETWORK", M + 53, by + 14);
  (["A", "B", "C"] as const).forEach((g, i) => {
    const cx = M + 150 + i * 56;
    plug(doc, "ethercon", cx, by, 14, boxesOn(g) ? "#8e44ad" : "#3a4050");
    label(`AES50 ${g}`, cx, by + 19);
    if (boxesOn(g)) label(boxesOn(g), cx, by + 28, 6);
  });
  const sc = boxesOn("SC");
  plug(doc, "xlr-m", M + 330, by, 14, sc ? "#8e44ad" : "#3a4050");
  label("ST CONNECT", M + 330, by + 19);
  if (sc) label(sc, M + 330, by + 28, 6);
  plug(doc, "xlr-m", M + 392, by, 14, "#3a4050");
  label("AES/EBU OUT", M + 392, by + 19);
  plug(doc, "xlr-f", M + 446, by, 14, "#3a4050");
  label("AES/EBU IN", M + 446, by + 19);
  doc.roundedRect(M + 490, by - 22, GRID - 506, 48, 6).lineWidth(1).fillAndStroke("#242933", "#3a4050");
  text(doc, "WING-LIVE · WLIVE PLAY", M + 490, by - 12, { size: 8, bold: true, color: "#c9ccd1", width: GRID - 506, align: "center" });
  text(doc, "enregistrement / lecture SD (2 x 32 pistes)", M + 490, by + 2, { size: 6.5, color: "#9ca3af", width: GRID - 506, align: "center" });
}

/** Ports per drawn row: the whole box up to 16, then 8 (to 24) or 16 (beyond). */
function rowSize(n: number): number {
  return n > 24 ? 16 : n > 16 ? 8 : n;
}

function face(doc: Doc, box: BoxPage, n: number, model: PatchSheetModel): void {
  if (hasWingBackPanel(box)) {
    wingBackPanel(doc, box, model);
    return;
  }
  // Wider than 16 ports: rows of 8 (a WING Rack's 24 inputs) or of 16 (a 32-input S32 / DL32).
  const perRow = rowSize(n);
  const colW = GRID / perRow;
  const y0 = 104;
  if (n > 16) {
    const inRows = Math.ceil(Math.max(...box.inputs.map((c) => c.port + c.span - 1), 1) / perRow);
    doc.roundedRect(M, y0, GRID, multiRowFaceHeight(inRows), 10).fill("#1b1f27");
    text(doc, box.spec.label.toUpperCase(), M + 14, y0 + 8, { size: 11, bold: true, color: "#e5e7eb" });
    // Ring centre of slot `idx` on a row; its number sits above it, like on the unit.
    const ring = (c: PortCell, row0: number, kind: Connector, label: (idx: number) => string): void => {
      for (let k = 0; k < c.span; k++) {
        const idx = c.port - 1 + k;
        const cx = M + ((idx % perRow) + 0.5) * colW;
        const cy = y0 + 46 + (row0 + Math.floor(idx / perRow)) * MULTI_ROW;
        plug(doc, kind, cx, cy, 11, c.used ? (c.color ?? COLOR_USER) : "#3a4050");
        text(doc, label(idx), cx - 14, cy - 23, { size: 7, bold: true, color: "#e5e7eb", width: 28, align: "center" });
      }
    };
    for (const c of box.inputs) ring(c, 0, box.spec.inConn ?? "xlr-f", (i) => String(i + 1));
    for (const c of box.outputs) ring(c, inRows, box.spec.outConn ?? "xlr-m", (i) => (perRow > 8 ? `o${i + 1}` : `OUT ${i + 1}`));
    return;
  }
  const rings = (cells: PortCell[], y: number, r: number, kind: Connector): void => {
    for (const c of cells) {
      for (let k = 0; k < c.span; k++) {
        const cx = M + (c.port - 1 + k + 0.5) * colW;
        plug(doc, kind, cx, y, r, c.used ? (c.color ?? COLOR_USER) : "#3a4050");
        text(doc, String(c.port + k), cx - 6, y - r - 15, { size: 7, bold: true, color: "#e5e7eb", width: 12, align: "center" });
      }
    }
  };
  if (box.spec.kind === "personal-mixer") {
    doc.roundedRect(M, y0, GRID, 70, 10).fill("#2b2f38");
    doc.rect(M, y0 + 46, GRID, 24).fill("#c9ccd1");
    text(doc, "POWERPLAY  P16-M", M + 14, y0 + 8, { size: 10, bold: true, color: "#e5e7eb" });
    for (const c of box.outputs) {
      const cx = M + (c.port - 0.5) * colW;
      doc.roundedRect(cx - 9, y0 + 28, 18, 12, 3).fill(c.used ? (c.color ?? COLOR_USER) : "#4b5160");
      text(doc, String(c.port), cx - 8, y0 + 52, { size: 7, bold: true, color: "#1f2430", width: 16, align: "center" });
    }
    return;
  }
  if (box.spec.id === "klark-teknik-dn4816u") {
    doc.roundedRect(M, y0, GRID, 78, 10).fill("#c9ccd1");
    text(doc, "KLARK TEKNIK  StageCONNECT CONVERTER  DN4816U", M + 14, y0 + 10, { size: 10, bold: true, color: INK });
    ["ULTRANET IN", "ULTRANET OUT", "USB"].forEach((l, i) => {
      doc.roundedRect(M + 16 + i * 80, y0 + 30, 60, 30, 4).fill("#1f2430");
      text(doc, l, M + 16 + i * 80, y0 + 63, { size: 6.5, bold: true, color: INK, width: 60, align: "center" });
    });
    return;
  }
  const stagebox = box.spec.kind === "stagebox";
  doc.roundedRect(M, y0, GRID, stagebox ? 144 : 70, 10).fill("#1b1f27");
  text(doc, box.spec.label.toUpperCase(), M, y0 + 130, { size: 8, bold: true, color: "#6b7280", width: GRID - 14, align: "right" });
  if (stagebox) {
    rings(box.inputs, y0 + 42, 15, box.spec.inConn ?? "xlr-f");
    rings(box.outputs, y0 + 100, 15, box.spec.outConn ?? "xlr-m");
    if (n <= 8) {
      text(doc, "IN", M + 4, y0 + 30, { size: 6.5, color: "#9ca3af" });
      text(doc, "OUT", M + 4, y0 + 90, { size: 6.5, color: "#9ca3af" });
    }
  } else {
    text(doc, box.spec.connectors || `${box.group} ${box.range[0]}-${box.range[1]}`, M + 14, y0 + 30, { size: 8, color: "#9ca3af" });
  }
}

function boxPage(doc: Doc, box: BoxPage, model: PatchSheetModel, naming: NamingMode): void {
  header(doc, box.device, [box.spec.label, box.via ? `branché sur ${box.via}` : `${box.group} ${box.range[0]}-${box.range[1]}`, box.spec.connectors].filter(Boolean).join(" · "));
  if (box.spec.kind === "personal-mixer") {
    face(doc, box, 16, model);
    p16Cards(doc, box, naming);
    return;
  }
  if (box.spec.kind === "hub") {
    hubPage(doc, box, model, naming);
    return;
  }
  if (box.spec.kind === "card") {
    cardPage(doc, box, naming);
    return;
  }
  const n = columns(box);
  face(doc, box, n, model);
  const stagebox = box.spec.kind === "stagebox";
  if (n > 16) {
    // Rows of 8 or 16 inputs, then the outputs, each as its own strip.
    const perRow = rowSize(n);
    const inRows = Math.ceil(Math.max(...box.inputs.map((c) => c.port + c.span - 1), 1) / perRow);
    const wing = hasWingBackPanel(box);
    let ry = 104 + (wing ? WING_FACE_H : multiRowFaceHeight(inRows)) + 12;
    for (let r = 0; r < inRows; r++) {
      const chunk = box.inputs.filter((c) => c.port > r * perRow && c.port <= r * perRow + perRow).map((c) => ({ ...c, port: c.port - r * perRow }));
      strip(doc, r === 0 ? "ENTREES" : `ENTREES ${r * perRow + 1}-${r * perRow + perRow}`, chunk, perRow, ry, naming);
      ry += wing ? WING_STRIP_PITCH : 66;
    }
    if (box.outputs.length > 0) strip(doc, "SORTIES", box.outputs, Math.max(perRow, ...box.outputs.map((c) => c.port + c.span - 1)), ry, naming);
    return;
  }
  let y = stagebox ? 264 : 200;
  if (box.inputs.length > 0) {
    strip(doc, "ENTREES", box.inputs, n, y, naming);
    y += 92;
  }
  if (box.outputs.length > 0) strip(doc, "SORTIES", box.outputs, n, y, naming);
}

/** A HUB4: its four AES50 ports with what is plugged in, then A 33-48 served on StageCONNECT / outputs. */
function hubPage(doc: Doc, box: BoxPage, model: PatchSheetModel, naming: NamingMode): void {
  const y0 = 104;
  doc.roundedRect(M, y0, GRID, 84, 10).fill("#1b1f27");
  text(doc, "MIDAS  HUB4", M + 14, y0 + 8, { size: 11, bold: true, color: "#e5e7eb" });
  const cw = (GRID - 3 * 12) / 4;
  for (let p = 1; p <= 4; p++) {
    const lo = (p - 1) * 8 + 1;
    const plugged = model.boxes.filter((b) => b.hub === box.device && b.range[0] <= lo + 7 && b.range[1] >= lo && b.range[0] < 33);
    const x = M + (p - 1) * (cw + 12);
    doc.roundedRect(x + 8, y0 + 28, cw - 16, 46, 6).fill("#2b2f38");
    plug(doc, "ethercon", x + 26, y0 + 51, 11, plugged.length > 0 ? "#8e44ad" : "#3a4050");
    text(doc, `PORT ${p} · A ${lo}-${lo + 7}`, x + 44, y0 + 38, { size: 8, bold: true, color: "#e5e7eb", width: cw - 56 });
    text(doc, plugged.length > 0 ? plugged.map((b) => b.device).join(", ") : "libre", x + 44, y0 + 52, { size: 8, color: plugged.length > 0 ? "#c9ccd1" : "#6b7280", width: cw - 56 });
  }
  const onSc = model.boxes.filter((b) => b.hub === box.device && b.range[0] >= 33);
  if (onSc.length > 0) text(doc, `STAGECONNECT : ${onSc.map((b) => b.device).join(", ")}`, M + 14, y0 + 92, { size: 8, bold: true, color: "#c9ccd1" });
  strip(doc, "A 33-48 SERVIS EN STAGECONNECT ET EN SORTIES LOCALES (4 PORTS x 4 SIGNAUX)", box.outputs, 16, y0 + 112, naming);
}

/**
 * An expansion card (WING-LIVE, Dante...): 64 channels each way, drawn as rows of 16 and only the
 * rows with something in use. A slot is drawn for the WING-LIVE's two SD cards.
 */
function cardPage(doc: Doc, box: BoxPage, naming: NamingMode): void {
  const y0 = 104;
  doc.roundedRect(M, y0, GRID, 56, 10).fill("#1b1f27");
  text(doc, box.spec.label.toUpperCase(), M + 14, y0 + 10, { size: 12, bold: true, color: "#e5e7eb" });
  text(doc, box.spec.connectors, M + 14, y0 + 30, { size: 8, color: "#9ca3af", width: GRID - 200 });
  if (box.spec.id === "wing-live") {
    [1, 2].forEach((n, i) => {
      doc.roundedRect(W - M - 150 + i * 70, y0 + 12, 60, 32, 4).lineWidth(1).fillAndStroke("#242933", "#3a4050");
      text(doc, `SD ${n}`, W - M - 150 + i * 70, y0 + 24, { size: 8, bold: true, color: "#c9ccd1", width: 60, align: "center" });
    });
  }
  const chunks = (cells: PortCell[], label: string): { label: string; cells: PortCell[] }[] => {
    const out: { label: string; cells: PortCell[] }[] = [];
    for (let r = 0; r < 4; r++) {
      const part = cells.filter((c) => c.port > r * 16 && c.port <= r * 16 + 16);
      if (part.some((c) => c.used)) out.push({ label: `${label} ${r * 16 + 1}-${r * 16 + 16}`, cells: part.map((c) => ({ ...c, port: c.port - r * 16 })) });
    }
    return out;
  };
  const rows = [...chunks(box.inputs, "ENTREES"), ...chunks(box.outputs, "SORTIES")];
  if (rows.length === 0) {
    text(doc, "Aucune voie utilisée sur cette carte.", M, y0 + 80, { size: 10, color: MUTED });
    return;
  }
  const pitch = Math.min(66, (H - 40 - (y0 + 72)) / rows.length);
  rows.forEach((r, i) => strip(doc, r.label, r.cells, 16, y0 + 72 + i * pitch, naming));
}

/** Personal mixer: sixteen channel cards, 8 per row, as on the reference sheet. */
function p16Cards(doc: Doc, box: BoxPage, naming: NamingMode): void {
  const cw = (GRID - 7 * 8) / 8;
  const ch = 52;
  for (let slot = 1; slot <= 16; slot++) {
    const c = box.outputs.find((o) => o.port === slot) ?? { port: slot, span: 1, channelNames: [], used: false };
    const col = (slot - 1) % 8;
    const row = Math.floor((slot - 1) / 8);
    const x = M + col * (cw + 8);
    const y = 210 + row * (ch + 10);
    doc.roundedRect(x, y, cw, ch, 6).fill(CARD);
    doc.save().roundedRect(x, y, cw, ch, 6).clip().rect(x, y, 4, ch).fill(c.used ? (c.color ?? COLOR_USER) : COLOR_FREE).restore();
    text(doc, String(slot), x + 12, y + 8, { size: 8, bold: true, color: MUTED });
    text(doc, c.mode && c.mode !== "M" ? "ST" : "MONO", x + cw - 40, y + 8, { size: 7, color: MUTED, width: 32, align: "right" });
    text(doc, cellLines(c, naming)[0] as string, x + 12, y + 26, { size: 10, bold: true, color: c.used ? INK : "#9ca3af", width: cw - 18, height: 12 });
  }
}

/** Renders the sheet in the reference layout: overview, then one page per box with its drawn front. */
export function writeVisualPdf(model: PatchSheetModel, naming: NamingMode, opts: { date: Date; title: string; footer: string }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: [W, H], margin: 0, bufferPages: true, info: { Title: pdfSafe(opts.title), CreationDate: opts.date } });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    overview(doc, model, opts.title);
    for (const box of model.boxes) {
      doc.addPage({ size: [W, H], margin: 0 });
      boxPage(doc, box, model, naming);
    }
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      text(doc, `${opts.footer}`, W - M - 360, 38, { size: 8, color: MUTED, width: 360, align: "right" });
      text(doc, `Page ${i + 1}/${range.count}`, W - M - 360, 52, { size: 8, color: MUTED, width: 360, align: "right" });
    }
    doc.end();
  });
}
