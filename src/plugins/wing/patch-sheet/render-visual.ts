import PDFDocument from "pdfkit";
import type { Connector } from "./device-catalog.js";
import { COLOR_BUS, COLOR_COMPUTER, COLOR_FREE, COLOR_MAIN, COLOR_USER } from "./colors.js";
import { pdfSafe } from "./pdf-writer.js";
import { modeNotes } from "./render-table.js";
import { connectorsText } from "./device-catalog.js";
import { strings, type Lang, type Strings } from "./strings.js";
import { cellLines, coveringCell, type BoxPage, type NamingMode, type PatchSheetModel, type PortCell } from "./patch-model.js";

type Doc = InstanceType<typeof PDFDocument>;

/** Language of the sheet being drawn (set by writeVisualPdf: drawing is synchronous). */
let L: Strings = strings("fr");
let LANG: Lang = "fr";

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
    doc.circle(cx, cy + r * 0.02, r * 0.31).lineWidth(1.2).fillAndStroke("#000000", "#d4d7dc");
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
  // Kept clear of the page number at the top right.
  text(doc, title, M, 34, { size: 24, bold: true, width: GRID - 380, height: 28 });
  text(doc, subtitle, M, 66, { size: 10, color: MUTED, width: GRID - 200 });
  doc.moveTo(M, 90).lineTo(W - M, 90).lineWidth(0.7).strokeColor(RULE).stroke();
}

function card(doc: Doc, x: number, y: number, w: number, h: number, bar: string, title: string, lines: string[], dim = false): void {
  doc.roundedRect(x, y, w, h, 6).fill(dim ? "#f7f8f9" : CARD);
  doc.roundedRect(x, y, w, h, 6).lineWidth(1.6).strokeColor(dim ? COLOR_FREE : bar).stroke();
  doc.save().roundedRect(x, y, w, 7, 4).clip().rect(x, y, w, 7).fill(dim ? COLOR_FREE : bar).restore();
  text(doc, title, x + 6, y + 16, { size: 11, bold: true, color: dim ? MUTED : INK, width: w - 12, align: "center", height: 14 });
  lines.filter(Boolean).slice(0, 4).forEach((l, i) => text(doc, l, x + 6, y + 32 + i * 10, { size: 7.5, color: MUTED, width: w - 12, align: "center", height: 10 }));
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
  header(doc, title, L.overviewSubtitle);
  const cw = 190;
  const cx = (W - cw) / 2;
  card(doc, cx, 118, cw, 62, INK, "Behringer WING", [L.console]);

  const groups = consoleGroups(model);
  const computers = ["USB AUDIO", "USB PLAYER", "DANTE", "WLIVE PLAY"].filter((g) => groups.has(g));
  const left = computers.map((g) => `${g} : ${(groups.get(g) as string[]).slice(0, 3).join(", ")}`);
  if (left.length > 0) {
    card(doc, M, 118, 170, 62, COLOR_COMPUTER, L.computers, left);
    link(doc, M + 170, 149, cx, 149);
  }
  const rest = [...groups.keys()].filter((g) => !computers.includes(g));
  const right = rest.map((g) => `${g} : ${(groups.get(g) as string[]).length} source${(groups.get(g) as string[]).length > 1 ? "s" : ""}`);
  // The console's own ports (box-map group LCL) are drawn beside it, not on the AES50 line.
  const local = model.boxes.find((b) => b.group === "LCL" && !b.via);
  if (local) {
    card(doc, W - M - 170, 118, 170, 62, KIND_COLOR[local.spec.kind] ?? "#8e44ad", /^local$/i.test(local.device) ? L.localPorts : local.device, [local.spec.label, L.counts(local.inputs.filter((c) => c.used).length, local.outputs.filter((c) => c.used).length), ...right.slice(0, 1)]);
    link(doc, cx + cw, 149, W - M - 170, 149);
  } else if (right.length > 0) {
    card(doc, W - M - 170, 118, 170, 62, "#8e44ad", L.consoleInputs, right);
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
  const linkLabel = groupsUsed.map((g) => (g === "SC" ? "StageConnect" : `AES50-${g}`)).join(" / ");
  if (linkLabel) text(doc, linkLabel, W / 2 + 6, busY - 12, { size: 8, bold: true, color: MUTED, width: 160, height: 10 });
  // What hangs under each host (a hub's DL8s, personal mixers); what hangs off one of those follows it in the same row.
  const itemsOf = (b: BoxPage): { box: BoxPage; joined: boolean }[] => {
    const out: { box: BoxPage; joined: boolean }[] = [];
    for (const k of model.boxes.filter((m) => m.via === b.device || m.hub === b.device)) {
      out.push({ box: k, joined: false });
      for (const g of model.boxes.filter((m) => m.via === k.device)) out.push({ box: g, joined: true });
    }
    return out;
  };
  // Each host gets its own band for its children, so two hosts with children never overlap: the cards are
  // narrowed to fit the whole row, then each band is centred under its host and pushed aside by its neighbours.
  const KID_GAP = 12;
  const BAND_GAP = 20;
  const bands = hosts.map((b, i) => ({ i, items: itemsOf(b) })).filter((e) => e.items.length > 0);
  const totalItems = bands.reduce((sum, e) => sum + e.items.length, 0);
  const fixedGaps = bands.reduce((sum, e) => sum + (e.items.length - 1) * KID_GAP, 0) + Math.max(0, bands.length - 1) * BAND_GAP;
  // Never narrower than a readable card: with very many boxes the row runs past the margin rather than drawing negative widths.
  const kw = totalItems > 0 ? Math.max(40, Math.min(150, (GRID - fixedGaps) / totalItems)) : 150;
  const bandW = (count: number): number => count * kw + (count - 1) * KID_GAP;
  const startOf = new Map<number, number>();
  let prevEnd = M - BAND_GAP;
  for (const e of bands) {
    const centre = x0 + e.i * (bw + gap) + bw / 2;
    const st = Math.max(centre - bandW(e.items.length) / 2, prevEnd + BAND_GAP, M);
    startOf.set(e.i, st);
    prevEnd = st + bandW(e.items.length);
  }
  // Pushed past the right margin: shift back from the right edge.
  let nextStart = W - M + BAND_GAP;
  for (const e of [...bands].reverse()) {
    const st = Math.min(startOf.get(e.i) as number, nextStart - BAND_GAP - bandW(e.items.length));
    startOf.set(e.i, st);
    nextStart = st;
  }
  hosts.forEach((b, i) => {
    const x = x0 + i * (bw + gap);
    link(doc, x + bw / 2, busY, x + bw / 2, 262);
    // A hub or converter with boxes plugged into it is in use even when its own ports carry nothing.
    const kids = model.boxes.filter((k) => k.via === b.device || k.hub === b.device);
    const idle = usedCount(b) === 0 && kids.length === 0;
    const lines = [`${b.group} ${b.range[0]}-${b.range[1]}`, usedCount(b) === 0 ? (kids.length > 0 ? L.boxCount(kids.length) : L.unused) : L.counts(b.inputs.filter((c) => c.used).length, b.outputs.filter((c) => c.used).length)];
    card(doc, x, 262, bw, 66, KIND_COLOR[b.spec.kind] ?? "#8e44ad", b.device, [b.spec.label !== b.device ? b.spec.label : "", ...lines], idle);
    // Boxes hung under this one: a hub's DL8s (AES50 ports), personal mixers (Ultranet). What hangs off one
    // of those (a personal mixer on a converter) follows it in the same row, joined to it.
    if (kids.length > 0) {
      const items = itemsOf(b);
      const start = startOf.get(i) as number;
      link(doc, x + bw / 2, 328, x + bw / 2, 352);
      const tops = items.filter((it) => !it.joined);
      const firstTop = items.indexOf(tops[0] as (typeof items)[number]);
      const lastTop = items.indexOf(tops[tops.length - 1] as (typeof items)[number]);
      const busFrom = start + firstTop * (kw + 12) + kw / 2;
      const busTo = start + lastTop * (kw + 12) + kw / 2;
      link(doc, Math.min(busFrom, x + bw / 2), 352, Math.max(busTo, x + bw / 2), 352);
      items.forEach((it, j) => {
        const k = it.box;
        const kx = start + j * (kw + 12);
        if (it.joined) link(doc, kx - 12, 413, kx, 413);
        else link(doc, kx + kw / 2, 352, kx + kw / 2, 380);
        const port = k.hub ? Math.floor((k.range[0] - 1) / 8) + 1 : 0;
        card(doc, kx, 380, kw, 66, KIND_COLOR[k.spec.kind] ?? "#2d9cdb", k.device, [
          k.spec.label !== k.device ? k.spec.label : "",
          k.via ? `${k.group} ${k.range[0]}-${k.range[1]} -> ${L.tracks}` : `${k.group} ${k.range[0]}-${k.range[1]}`,
          k.hub && k.range[0] >= 33 ? L.scOfHub(k.hub) : k.hub && port >= 1 && port <= 4 ? L.portOfHub(port, k.hub) : k.via ? "Ultranet" : "",
        ]);
      });
    }
  });
  // Expansion cards sit in their own row: they are not on an AES50 link.
  const cards = model.boxes.filter((b) => b.spec.kind === "card");
  if (cards.length > 0) {
    // Cards share the row: narrowed together when there are too many to keep 166 pt each.
    const step = Math.min(166, (GRID + 12) / cards.length);
    const cardW = step - 12;
    const cx0 = W - M - cards.length * step + 12;
    text(doc, L.cardsHeading, cx0, 458, { size: 8, bold: true, color: MUTED });
    cards.forEach((c, i) => {
      const used = c.inputs.filter((p) => p.used).length + c.outputs.filter((p) => p.used).length;
      card(doc, cx0 + i * step, 472, cardW, 58, "#2d9cdb", c.device, [c.spec.label !== c.device ? c.spec.label : "", used === 0 ? L.cardUnused : L.cardUsed(used)], used === 0);
    });
  }
  legend(doc, model);
}

/** What the colours of the page mean: only the ones that are drawn on it. */
function legend(doc: Doc, model: PatchSheetModel): void {
  const cells = model.boxes.flatMap((b) => [...b.inputs, ...b.outputs]).filter((c) => c.used);
  const colours = new Set(cells.map((c) => c.color));
  const kinds = new Set(model.boxes.map((b) => b.spec.kind));
  const items: [string, string][] = [];
  if (model.consolePorts.length > 0 && model.consoleSources.some((s) => s.channelNames.length > 0 || s.name)) items.push([COLOR_COMPUTER, L.computers]);
  if (kinds.has("stagebox") || kinds.has("generic")) items.push([KIND_COLOR.stagebox as string, L.legendStagebox]);
  if (kinds.has("converter") || kinds.has("personal-mixer") || kinds.has("hub") || kinds.has("card")) items.push([KIND_COLOR.converter as string, L.legendConverter]);
  if (colours.has(COLOR_BUS)) items.push([COLOR_BUS, L.legendBus]);
  if (colours.has(COLOR_MAIN)) items.push([COLOR_MAIN, L.legendMain]);
  if (colours.has(COLOR_USER)) items.push([COLOR_USER, L.legendUser]);
  items.push([COLOR_FREE, L.legendFree]);
  let x = M;
  let y = 556;
  for (const [color, label] of items) {
    const w = 24 + label.length * 4.4 + 14;
    if (x + w > W - M) { x = M; y += 14; }
    doc.roundedRect(x, y, 16, 6, 3).fill(color);
    text(doc, label, x + 22, y - 1, { size: 8, color: MUTED });
    x += w;
  }
}

/** Column geometry: ports are laid out on `n` equal columns across the page. */
function columns(box: BoxPage): number {
  return Math.max(box.spec.ins, box.spec.outs, ...box.inputs.map((c) => c.port + c.span - 1), ...box.outputs.map((c) => c.port + c.span - 1), 1);
}

/** Dark text on a light bar, white on a dark one. */
function onColor(hex: string): string {
  const v = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16));
  // WCAG relative luminance: keep whichever text colour contrasts more.
  const lin = (c: number): number => ((c / 255) <= 0.03928 ? c / 255 / 12.92 : (((c / 255) + 0.055) / 1.055) ** 2.4);
  const lum = 0.2126 * lin(r as number) + 0.7152 * lin(g as number) + 0.0722 * lin(b as number);
  const dark = 0.0173; // luminance of #1f2430
  return (lum + 0.05) / (dark + 0.05) >= (1.05) / (lum + 0.05) ? "#1f2430" : "#ffffff";
}

/**
 * A row of cells under a face. Each cell has a coloured tab carrying its port number (the connector's
 * own number: `offset` is added when the row is a slice of a longer one), then its name lines.
 */
function strip(doc: Doc, label: string, cells: PortCell[], n: number, y: number, naming: NamingMode, offset = 0, layout?: (c: PortCell) => { x: number; w: number }): void {
  text(doc, label, M, y, { size: 8, bold: true, color: MUTED });
  const colW = GRID / n;
  for (const c of cells) {
    const { x, w } = layout ? layout(c) : { x: M + (c.port - 1) * colW + 3, w: c.span * colW - 6 };
    const color = c.used ? (c.color ?? COLOR_USER) : COLOR_FREE;
    doc.roundedRect(x, y + 13, w, 10, 5).fill(color);
    const num = c.span === 2 ? `${offset + c.port}-${offset + c.port + 1}` : String(offset + c.port);
    text(doc, num, x, y + 15.2, { size: 6.5, bold: true, color: onColor(color), width: w, align: "center", height: 8 });
    const lines = cellLines(c, naming, L.free).slice(0, 3);
    const size = n > 8 ? 7.5 : 9;
    let ty = y + 28;
    lines.forEach((l, i) => {
      const fs = i === 0 ? size : size - 1;
      const bold = i === 0 && c.used;
      // A name may take two lines in a narrow cell instead of being cut; the lines below move down with it.
      doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(fs);
      const maxLines = n > 8 && i === 0 ? 2 : 1;
      const h = Math.min(doc.heightOfString(pdfSafe(l), { width: w }), (fs + 1.5) * maxLines);
      text(doc, l, x, ty, { size: fs, bold, color: c.used ? (i === 0 ? INK : MUTED) : "#9ca3af", width: w, align: "center", height: Math.max(h, fs + 2) });
      ty += Math.max(h, fs + 1.5) + 1.5;
    });
    const sub = [c.patch, c.mode && c.mode !== "M" ? c.mode : "", c.phantom48v ? "48V" : ""].filter(Boolean).join(" · ");
    if (c.used && sub) text(doc, sub, x, ty, { size: 6.5, color: "#9ca3af", width: w, align: "center", height: 9 });
  }
}

/**
 * Cells laid out right to left over `n` columns: on a WING or an X32 the connectors are numbered from the
 * right, and the names under them keep the same order so each one sits under its own connector.
 */
function mirrored(n: number): (c: PortCell) => { x: number; w: number } {
  const colW = GRID / n;
  return (c) => ({ x: M + (n - (c.port + c.span - 1)) * colW + 3, w: c.span * colW - 6 });
}

/** The box's front, drawn from its catalogue entry. Ring colours follow the cells. */
/** Vertical pitch of a ring row on a multi-row face (room for the number above each ring). */
const MULTI_ROW = 40;
function multiRowFaceHeight(inRows: number, outRows = 1): number {
  return 46 + (inRows + outRows) * MULTI_ROW - 6;
}
/** Rows the outputs take on a multi-row face (a generic box can have more than one row of them). */
function outRowsOf(box: BoxPage, perRow: number): number {
  return Math.max(1, Math.ceil(Math.max(...box.outputs.map((c) => c.port + c.span - 1), 1) / perRow));
}

const WING_FACE_H = 200;
const WING_STRIP_PITCH = 66;

/** The WING Rack and Compact have their own back panel, drawn as it is on the unit (the Compact differs from the Rack). */
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
  const label = (s: string, cx: number, y: number, size = 6.5): void => text(doc, s, cx - 30, y, { size, bold: true, color: "#c9ccd1", width: 60, height: size + 3, align: "center" });

  // Left: OUT 1-8 (XLR male) in one framed block, the four stereo jacks in a block below it, each
  // jack centred between the two outputs of its pair.
  const frame = (y: number, h: number): void => {
    doc.roundedRect(M + 4, y, 8 * 32 + 20, h, 6).lineWidth(0.8).strokeColor("#3a4050").stroke();
  };
  frame(y0 + 6, 48);
  frame(y0 + 58, 46);
  for (let i = 0; i < 8; i++) {
    // Numbered from the right, like the inputs.
    const cx = M + 22 + (7 - i) * 32;
    plug(doc, "xlr-m", cx, rowY(0), 11, colorOf(box.outputs.find((c) => c.port <= i + 1 && i + 1 < c.port + c.span)));
    label(`${i + 1}`, cx, rowY(0) - 23, 6.5);
  }
  ["1/2", "3/4", "5/6", "7/8"].forEach((l, j) => {
    const cx = M + 22 + (7 - (2 * j + 0.5)) * 32;
    plug(doc, "jack", cx, y0 + 86, 11, "#3a4050");
    label(l, cx, y0 + 61, 6.5);
  });

  // Right: IN 1-24 (combo), three rows of eight. A WING numbers them from the right to the left, top to bottom
  // (1 is the rightmost of the top row), the same on the Rack, Compact and Full.
  const x0 = M + 300;
  const colW = (GRID - 300) / 8;
  for (const c of box.inputs) {
    for (let k = 0; k < c.span; k++) {
      const idx = c.port - 1 + k;
      const cx = x0 + (7 - (idx % 8) + 0.5) * colW;
      const cy = rowY(Math.floor(idx / 8));
      plug(doc, "combo", cx, cy, 11, colorOf(c));
      label(String(idx + 1), cx, cy - 22, 6.5);
    }
  }
  wingBottomRow(doc, model, y0 + 162, false);
}

/** The bottom row of a WING back panel: network, (USB B), AES50 A/B/C, StageCONNECT, AES/EBU out and in, expansion slot. */
function wingBottomRow(doc: Doc, model: PatchSheetModel, by: number, withUsb: boolean): void {
  const label = (s: string, cx: number, y: number, size = 6.5): void => text(doc, s, cx - 30, y, { size, bold: true, color: "#c9ccd1", width: 60, height: size + 3, align: "center" });
  const boxesOn = (g: string): string => {
    const names = model.boxes.filter((b) => b.group === g && !b.via && b.spec.kind !== "personal-mixer").map((b) => b.device);
    return names.length === 0 ? "" : names.length > 2 ? L.boxCount(names.length) : names.join(", ");
  };
  [0, 1].forEach((i) => {
    doc.roundedRect(M + 20 + i * 40, by - 9, 26, 18, 3).fill("#c9ccd1");
    doc.roundedRect(M + 24 + i * 40, by - 5, 18, 10, 2).fill("#0d0f14");
  });
  if (withUsb) {
    // USB B: the square connector between the network ports and AES50.
    doc.roundedRect(M + 96, by - 7, 14, 14, 2).fill("#c9ccd1");
    doc.rect(M + 99, by - 4, 8, 8).fill("#0d0f14");
    label("USB B", M + 103, by + 14);
  }
  label("NETWORK", M + 53, by + 14);
  (["A", "B", "C"] as const).forEach((g, i) => {
    // AES50 A is the rightmost of the three, C the leftmost.
    const cx = M + 150 + (2 - i) * 56;
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
  text(doc, L.cardRecord, M + 490, by + 2, { size: 6.5, color: "#9ca3af", width: GRID - 506, align: "center" });
}

/**
 * WING Compact back, as on the unit: the top row has the combo inputs 16-9 then 8-1, the second row the XLR
 * outputs 8-1 then the combo inputs 24-17 (each block numbered from its right), and along the bottom the
 * two network ports, USB B, AES50 C/B/A, StageCONNECT, AES/EBU out and in, and the expansion slot.
 */
function compactBackPanel(doc: Doc, box: BoxPage, model: PatchSheetModel): void {
  const y0 = 104;
  doc.roundedRect(M, y0, GRID, WING_FACE_H, 10).fill("#1b1f27");
  text(doc, box.spec.label.toUpperCase(), M + 14, y0 + 5, { size: 8, bold: true, color: "#6b7280" });
  const colorOf = (c: PortCell | undefined): string => (c?.used ? (c.color ?? COLOR_USER) : "#3a4050");
  const label = (s: string, cx: number, y: number): void => text(doc, s, cx - 14, y, { size: 6.5, bold: true, color: "#c9ccd1", width: 28, height: 9, align: "center" });
  const rowY = (r: number): number => y0 + 44 + r * 46;
  const blockW = (GRID - 12) / 2;
  const blockX = [M, M + blockW + 12] as const;
  const colW = blockW / 8;
  for (const bx of blockX) for (const r of [0, 1]) doc.roundedRect(bx, rowY(r) - 25, blockW, 43, 6).lineWidth(0.8).strokeColor("#3a4050").stroke();
  // Slot `i` (0-7) of a block, numbered from the block's right.
  const slotX = (block: 0 | 1, i: number): number => (blockX[block] as number) + (7 - i + 0.5) * colW;
  // Inputs: 1-8 right block top row, 9-16 left block top row, 17-24 right block bottom row.
  const inputSlot = (idx: number): { cx: number; cy: number } =>
    idx < 8 ? { cx: slotX(1, idx), cy: rowY(0) } : idx < 16 ? { cx: slotX(0, idx - 8), cy: rowY(0) } : { cx: slotX(1, idx - 16), cy: rowY(1) };
  for (const c of box.inputs) {
    for (let k = 0; k < c.span; k++) {
      const idx = c.port - 1 + k;
      if (idx >= 24) continue;
      const { cx, cy } = inputSlot(idx);
      plug(doc, "combo", cx, cy, 11, colorOf(c));
      label(String(idx + 1), cx, cy - 22);
    }
  }
  // Outputs 1-8: XLR male, left block bottom row.
  for (let i = 0; i < 8; i++) {
    const cx = slotX(0, i);
    plug(doc, "xlr-m", cx, rowY(1), 11, colorOf(box.outputs.find((c) => c.port <= i + 1 && i + 1 < c.port + c.span)));
    label(`${i + 1}`, cx, rowY(1) - 22);
  }
  wingBottomRow(doc, model, y0 + 162, true);
}

/** Ports per drawn row: the whole box up to 16, then 8 (to 24) or 16 (beyond). */
function rowSize(n: number): number {
  return n > 24 ? 16 : n > 16 ? 8 : n;
}

function face(doc: Doc, box: BoxPage, n: number, model: PatchSheetModel): void {
  if (hasWingBackPanel(box)) {
    if (box.spec.id === "behringer-wing-compact") compactBackPanel(doc, box, model);
    else wingBackPanel(doc, box, model);
    return;
  }
  // Wider than 16 ports: rows of 8 (a WING Rack's 24 inputs) or of 16 (a 32-input S32 / DL32).
  const perRow = rowSize(n);
  const colW = GRID / perRow;
  const y0 = 104;
  if (n > 16) {
    const inRows = Math.ceil(Math.max(...box.inputs.map((c) => c.port + c.span - 1), 1) / perRow);
    doc.roundedRect(M, y0, GRID, multiRowFaceHeight(inRows, outRowsOf(box, perRow)), 10).fill("#1b1f27");
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
    for (const c of box.outputs) ring(c, inRows, box.spec.outConn ?? "xlr-m", (i) => `OUT ${i + 1}`);
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
    for (let slot = 1; slot <= 16; slot++) {
      const c = coveringCell(box.outputs, slot);
      const cx = M + (slot - 0.5) * colW;
      doc.roundedRect(cx - 9, y0 + 28, 18, 12, 3).fill(c?.used ? (c.color ?? COLOR_USER) : "#4b5160");
      text(doc, String(slot), cx - 8, y0 + 52, { size: 7, bold: true, color: "#1f2430", width: 16, align: "center" });
    }
    return;
  }
  if (box.spec.id === "klark-teknik-dn4816u") {
    doc.roundedRect(M, y0, GRID, 78, 10).fill("#c9ccd1");
    text(doc, "KLARK TEKNIK  StageCONNECT CONVERTER  DN4816U", M + 14, y0 + 10, { size: 10, bold: true, color: INK });
    // The Ultranet ports are RJ45 (ethernet); the USB one is a type B socket.
    ["ULTRANET IN", "ULTRANET OUT", "USB"].forEach((l, i) => {
      const x = M + 16 + i * 80;
      const cy = y0 + 45;
      if (i < 2) {
        doc.roundedRect(x + 8, cy - 15, 44, 30, 3).fill("#9ea4ad");
        doc.rect(x + 25, cy - 18, 10, 5).fill("#9ea4ad");
        doc.roundedRect(x + 12, cy - 11, 36, 20, 2).fill("#0d0f14");
        for (let c = 0; c < 8; c++) doc.rect(x + 15 + c * 4, cy + 2, 2, 6).fill("#d4a72c");
      } else {
        doc.roundedRect(x + 12, cy - 15, 36, 30, 2).fill("#9ea4ad");
        doc.polygon([x + 17, cy - 5], [x + 22, cy - 10], [x + 38, cy - 10], [x + 43, cy - 5], [x + 43, cy + 10], [x + 17, cy + 10]).fill("#0d0f14");
      }
      text(doc, l, x, y0 + 63, { size: 6.5, bold: true, color: INK, width: 60, align: "center" });
    });
    // A personal mixer plugs into the Ultranet OUT port.
    const mixers = model.boxes.filter((b) => b.via === box.device);
    text(doc, mixers.length > 0 ? `ULTRANET OUT -> ${mixers.map((m) => `${m.device} (${m.group} ${m.range[0]}-${m.range[1]})`).join(", ")}` : "", M + 270, y0 + 40, { size: 8, bold: true, color: INK, width: GRID - 290, height: 12 });
    return;
  }
  const stagebox = box.spec.kind === "stagebox";
  doc.roundedRect(M, y0, GRID, stagebox ? 144 : 70, 10).fill("#1b1f27");
  text(doc, box.spec.label.toUpperCase(), M, y0 + 130, { size: 8, bold: true, color: "#6b7280", width: GRID - 14, align: "right" });
  if (stagebox && box.spec.id === "behringer-x32-rack") {
    // An X32 numbers its connectors from the right to the left, top to bottom: 1 is the rightmost of the
    // first row of eight.
    const cw = GRID / 8;
    const at = (c: PortCell, rowAt: (r: number) => number, kind: Connector, offset = 0): void => {
      for (let k = 0; k < c.span; k++) {
        const idx = c.port - 1 + k;
        const cx = M + (7 - (idx % 8) + 0.5) * cw;
        const cy = rowAt(Math.floor(idx / 8) + offset);
        plug(doc, kind, cx, cy, 11, c.used ? (c.color ?? COLOR_USER) : "#3a4050");
        text(doc, String(idx + 1), cx - 6, cy - 26, { size: 7, bold: true, color: "#e5e7eb", width: 12, align: "center" });
      }
    };
    const rowY = (r: number): number => y0 + 38 + r * 38;
    for (const c of box.inputs) at(c, rowY, box.spec.inConn ?? "xlr-f");
    for (const c of box.outputs) at(c, rowY, box.spec.outConn ?? "xlr-m", Math.ceil(Math.max(box.spec.ins, 1) / 8));
  } else if (stagebox) {
    rings(box.inputs, y0 + 42, 15, box.spec.inConn ?? "xlr-f");
    rings(box.outputs, y0 + 100, 15, box.spec.outConn ?? "xlr-m");
    if (n <= 8) {
      text(doc, "IN", M + 4, y0 + 30, { size: 6.5, color: "#9ca3af" });
      text(doc, "OUT", M + 4, y0 + 90, { size: 6.5, color: "#9ca3af" });
    }
  } else {
    text(doc, connectorsText(box.spec, LANG) || `${box.group} ${box.range[0]}-${box.range[1]}`, M + 14, y0 + 30, { size: 8, color: "#9ca3af" });
  }
}

/** Boxes whose Ultranet port is on the back panel, where the front drawing cannot show it. */
const ULTRANET_BAR_H = 30;

/**
 * A slim strip under a box's front for its Ultranet port (RJ45, back panel) and the personal mixers
 * plugged into it.
 */
function ultranetBar(doc: Doc, box: BoxPage, model: PatchSheetModel, y: number): void {
  doc.roundedRect(M, y, GRID, ULTRANET_BAR_H - 6, 6).fill("#2b2f38");
  doc.roundedRect(M + 12, y + 4, 30, 14, 2).fill("#9ea4ad");
  doc.roundedRect(M + 15, y + 6, 24, 9, 1.5).fill("#0d0f14");
  for (let c = 0; c < 8; c++) doc.rect(M + 16.5 + c * 2.7, y + 11, 1.3, 3.5).fill("#d4a72c");
  text(doc, L.ultranetPort, M + 50, y + 8, { size: 7.5, bold: true, color: "#c9ccd1", width: 190, height: 10 });
  const mixers = model.boxes.filter((b) => b.via === box.device);
  text(doc, mixers.length > 0 ? mixers.map((m) => `${m.device} (${m.group} ${m.range[0]}-${m.range[1]})`).join("  ·  ") : L.free, M + 250, y + 8, { size: 7.5, color: mixers.length > 0 ? "#ffffff" : "#9ca3af", width: GRID - 260, height: 10 });
}

function boxPage(doc: Doc, box: BoxPage, model: PatchSheetModel, naming: NamingMode): void {
  header(doc, box.device, [box.spec.label, box.via ? `${L.pluggedInto} ${box.via}` : `${box.group} ${box.range[0]}-${box.range[1]}`, connectorsText(box.spec, LANG), ...modeNotes(box, L)].filter(Boolean).join(" · "));
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
    const outRows = outRowsOf(box, perRow);
    const faceH = wing ? WING_FACE_H : multiRowFaceHeight(inRows, outRows);
    if (box.spec.ultranet) ultranetBar(doc, box, model, 104 + faceH + 4);
    let ry = 104 + faceH + 12 + (box.spec.ultranet ? ULTRANET_BAR_H : 0);
    // Every strip in order; what does not fit above the foot of the page goes on a continuation page.
    const strips: { label: string; cells: PortCell[]; n: number; offset: number; mirror: boolean }[] = [];
    for (let r = 0; r < inRows; r++) {
      const cells = box.inputs.filter((c) => c.port > r * perRow && c.port <= r * perRow + perRow).map((c) => ({ ...c, port: c.port - r * perRow }));
      strips.push({ label: L.inputsRange(r * perRow + 1, r * perRow + perRow), cells, n: perRow, offset: r * perRow, mirror: wing });
    }
    if (outRows <= 1) {
      if (box.outputs.length > 0) {
        const outN = Math.max(perRow, ...box.outputs.map((c) => c.port + c.span - 1));
        strips.push({ label: L.outputs, cells: box.outputs, n: outN, offset: 0, mirror: wing });
      }
    } else {
      for (let r = 0; r < outRows; r++) {
        const cells = box.outputs.filter((c) => c.port > r * perRow && c.port <= r * perRow + perRow).map((c) => ({ ...c, port: c.port - r * perRow }));
        strips.push({ label: `${L.outputs} ${r * perRow + 1}-${r * perRow + perRow}`, cells, n: perRow, offset: r * perRow, mirror: false });
      }
    }
    const pitch = wing ? WING_STRIP_PITCH : 66;
    for (const st of strips) {
      if (ry + pitch > H - 30 && ry > 120) {
        doc.addPage({ size: [W, H], margin: 0 });
        header(doc, `${box.device} ${L.cont}`, box.spec.label);
        ry = 104;
      }
      strip(doc, st.label, st.cells, st.n, ry, naming, st.offset, st.mirror ? mirrored(st.n) : undefined);
      ry += pitch;
    }
    return;
  }
  if (box.spec.ultranet && stagebox) ultranetBar(doc, box, model, 104 + 144 + 4);
  let y = (stagebox ? 264 : 200) + (box.spec.ultranet && stagebox ? ULTRANET_BAR_H : 0);
  if (stagebox && box.spec.id === "behringer-x32-rack") {
    // Two rows of eight, 1 at the right, as on the face above.
    const rowsIn = Math.max(1, Math.ceil(Math.max(...box.inputs.map((c) => c.port + c.span - 1), 1) / 8));
    for (let r = 0; r < rowsIn; r++) {
      const chunk = box.inputs.filter((c) => c.port > r * 8 && c.port <= r * 8 + 8).map((c) => ({ ...c, port: c.port - r * 8 }));
      strip(doc, L.inputsRange(r * 8 + 1, r * 8 + 8), chunk, 8, y, naming, r * 8, mirrored(8));
      y += 66;
    }
    if (box.outputs.length > 0) strip(doc, L.outputs, box.outputs, 8, y, naming, 0, mirrored(8));
    return;
  }
  if (box.inputs.length > 0) {
    strip(doc, L.inputs, box.inputs, n, y, naming);
    y += 74;
  }
  if (box.outputs.length > 0) strip(doc, L.outputs, box.outputs, n, y, naming);
}

/**
 * The console's ports, one strip each, with what is plugged into them: a hub's boxes and a converter's
 * personal mixers are indented under the device they hang off.
 */
function portsPage(doc: Doc, model: PatchSheetModel): void {
  header(doc, L.portsTitle, L.portsSubtitle);
  const per = 4;
  const gap = 12;
  const cw = (GRID - (per - 1) * gap) / per;
  const ch = 168;
  model.consolePorts.slice(0, 8).forEach((p, i) => {
    const x = M + (i % per) * (cw + gap);
    const y = 112 + Math.floor(i / per) * (ch + 16);
    const top = p.lines.find((l) => l.indent === 0);
    const color = top ? (KIND_COLOR[top.kind] ?? "#8e44ad") : COLOR_FREE;
    doc.roundedRect(x, y, cw, ch, 6).fill(CARD);
    doc.roundedRect(x + 4, y + 4, cw - 8, 5, 2.5).fill(color);
    text(doc, p.label, x + 8, y + 18, { size: 12, bold: true, width: cw - 16, align: "center", height: 16 });
    if (p.lines.length === 0) {
      text(doc, L.nothingPlugged, x + 8, y + 44, { size: 9, color: "#9ca3af", width: cw - 16, align: "center" });
      return;
    }
    const shown = p.lines.slice(0, 9);
    shown.forEach((l, j) => {
      const ly = y + 42 + j * 12.5;
      const lx = x + 10 + l.indent * 12;
      doc.roundedRect(lx, ly + 1.5, 3, 9, 1.5).fill(KIND_COLOR[l.kind] ?? "#8e44ad");
      text(doc, `${l.indent ? "– " : ""}${l.name}`, lx + 8, ly, { size: 8.5, bold: l.indent === 0, color: INK, width: cw - 24 - l.indent * 12 - 60, height: 11 });
      text(doc, l.detail, x + cw - 72, ly + 1, { size: 7, color: MUTED, width: 62, align: "right", height: 10 });
    });
    if (p.lines.length > shown.length) text(doc, `… +${p.lines.length - shown.length}`, x + 10, y + ch - 14, { size: 7, color: MUTED });
  });
}

/**
 * A HUB4: the front with its four AES50 ports and what is plugged in, then the back panel: the
 * StageCONNECT output and the local outputs of A 33-48 (four ports of MIX A L/R and MIX B L/R, XLR on
 * ports 1 and 2 for MIX A, jacks elsewhere). Anything StageCONNECT-compatible (a DN4816U...) can sit
 * on A 33-48 instead of, or besides, the local outputs.
 */
function hubPage(doc: Doc, box: BoxPage, model: PatchSheetModel, naming: NamingMode): void {
  const y0 = 104;
  doc.roundedRect(M, y0, GRID, 84, 10).fill("#1b1f27");
  text(doc, "MIDAS  HUB4", M + 14, y0 + 8, { size: 11, bold: true, color: "#e5e7eb" });
  const cw = (GRID - 3 * 12) / 4;
  for (let p = 1; p <= 4; p++) {
    const lo = (p - 1) * 8 + 1;
    const plugged = model.boxes.filter((b) => b.hub === box.device && b.range[0] <= lo + 7 && b.range[1] >= lo && b.range[0] < box.range[0]);
    const x = M + (p - 1) * (cw + 12);
    doc.roundedRect(x + 8, y0 + 28, cw - 16, 46, 6).fill("#2b2f38");
    plug(doc, "ethercon", x + 30, y0 + 51, 11, plugged.length > 0 ? "#8e44ad" : "#3a4050");
    text(doc, `PORT ${p} · ${box.group} ${lo}-${lo + 7}`, x + 48, y0 + 38, { size: 8, bold: true, color: "#e5e7eb", width: cw - 56, height: 10 });
    text(doc, plugged.length > 0 ? plugged.map((b) => b.device).join(", ") : L.free, x + 48, y0 + 52, { size: 8, color: plugged.length > 0 ? "#c9ccd1" : "#6b7280", width: cw - 56, height: 10 });
  }

  // Back panel.
  const by = y0 + 98;
  doc.roundedRect(M, by, GRID, 130, 10).fill("#1b1f27");
  text(doc, L.backPanel, M + 14, by + 8, { size: 8, bold: true, color: "#6b7280" });
  const onSc = model.boxes.filter((b) => b.hub === box.device && b.range[0] >= box.range[0]);
  // Centred on the section frames (by + 22 .. by + 122).
  plug(doc, "xlr-m", M + 52, by + 72, 14, onSc.length > 0 ? "#8e44ad" : "#3a4050");
  text(doc, "STAGECONNECT", M + 12, by + 92, { size: 6.5, bold: true, color: "#c9ccd1", width: 80, align: "center" });
  text(doc, onSc.length > 0 ? onSc.map((b) => b.device).join(", ") : `${box.group} ${box.range[0]}-${box.range[0] + 15}`, M + 12, by + 102, { size: 6.5, color: "#9ca3af", width: 80, align: "center" });
  // As on the unit, left to right: the StageCONNECT port, then sections 4, 3, 2 and 1. Each section has MIX B
  // (two stacked jacks: L above, R below) and MIX A (two stacked jacks in sections 4 and 3, two XLR side by
  // side in sections 2 and 1, the right one being the lower port number: MIX A-L).
  const groupW = (GRID - 110) / 4;
  const inner = groupW - 6;
  // Position of the connector of output `i` (0..15) and the order in which the cells are written below.
  type Spot = { cx: number; cy: number; kind: Connector; r: number; side?: "L" | "R"; below?: string };
  const spots: Spot[] = [];
  for (let i = 0; i < 16; i++) {
    const sec = Math.floor(i / 4) + 1;
    const gx = M + 104 + (4 - sec) * groupW;
    const j = i % 4; // 0 A-L, 1 A-R, 2 B-L, 3 B-R
    const xlrA = sec <= 2;
    if (j >= 2) spots[i] = { cx: gx + (xlrA ? 28 : 40), cy: by + (j === 2 ? 56 : 92), kind: "jack", r: 10, side: j === 2 ? "L" : "R" };
    else if (xlrA) spots[i] = { cx: gx + (j === 0 ? 130 : 80), cy: by + 74, kind: "xlr-m", r: 14, below: j === 0 ? "MIX A-L" : "MIX A-R" };
    else spots[i] = { cx: gx + 117, cy: by + (j === 0 ? 56 : 92), kind: "jack", r: 10, side: j === 0 ? "L" : "R" };
  }
  for (let sec = 1; sec <= 4; sec++) {
    const gx = M + 104 + (4 - sec) * groupW;
    doc.roundedRect(gx, by + 22, inner, 100, 6).lineWidth(0.8).strokeColor("#3a4050").stroke();
    text(doc, `PORT ${sec}`, gx, by + 26, { size: 6.5, bold: true, color: "#9ca3af", width: inner, align: "center" });
  }
  spots.forEach((sp, i) => {
    const cell = coveringCell(box.outputs, i + 1);
    plug(doc, sp.kind, sp.cx, sp.cy, sp.r, cell?.used ? (cell.color ?? COLOR_USER) : "#3a4050");
    text(doc, `${box.group}${box.range[0] + i}`, sp.cx - 14, sp.cy - sp.r - 9, { size: 6.5, bold: true, color: "#e5e7eb", width: 28, align: "center" });
    if (sp.side) text(doc, sp.side, sp.cx + sp.r + 3, sp.cy - 3, { size: 5.5, color: "#9ca3af" });
    if (sp.below) text(doc, sp.below, sp.cx - 20, sp.cy + sp.r + 4, { size: 5.5, color: "#9ca3af", width: 40, align: "center" });
  });
  for (let sec = 1; sec <= 4; sec++) {
    const gx = M + 104 + (4 - sec) * groupW;
    text(doc, "MIX B", gx + (sec <= 2 ? 28 : 40) - 20, by + 108, { size: 5.5, color: "#9ca3af", width: 40, align: "center" });
    if (sec > 2) text(doc, "MIX A", gx + 117 - 20, by + 108, { size: 5.5, color: "#9ca3af", width: 40, align: "center" });
  }
  // The strip below writes the 16 outputs in the order of the connectors above (left to right).
  const slotOf = (i: number): number => {
    const sec = Math.floor(i / 4) + 1;
    const j = i % 4;
    const base = (4 - sec) * 4;
    if (sec > 2) return base + (j >= 2 ? j - 2 : 2 + j); // B-L, B-R, A-L, A-R
    return base + (j >= 2 ? j - 2 : 3 - j); // B-L, B-R, A-R, A-L
  };
  const slotW = (GRID - 110) / 16;
  const hubLayout = (c: PortCell): { x: number; w: number } => {
    const slots = Array.from({ length: c.span }, (_, k) => slotOf(c.port - 1 + k));
    const lo = Math.min(...slots);
    const hi = Math.max(...slots);
    return { x: M + 104 + lo * slotW + 2, w: (hi - lo + 1) * slotW - 4 };
  };
  strip(doc, L.hubStrip(box.group, box.range[0], box.range[0] + 15), box.outputs, 16, by + 138, naming, box.range[0] - 1, hubLayout);
}

/**
 * An expansion card (WING-LIVE, Dante...): 64 channels each way, drawn as rows of 16 and only the
 * rows with something in use. A slot is drawn for the WING-LIVE's two SD cards.
 */
function cardPage(doc: Doc, box: BoxPage, naming: NamingMode): void {
  const y0 = 104;
  doc.roundedRect(M, y0, GRID, 56, 10).fill("#1b1f27");
  text(doc, box.spec.label.toUpperCase(), M + 14, y0 + 10, { size: 12, bold: true, color: "#e5e7eb" });
  text(doc, connectorsText(box.spec, LANG), M + 14, y0 + 30, { size: 8, color: "#9ca3af", width: GRID - 200 });
  if (box.spec.id === "wing-live") {
    [1, 2].forEach((n, i) => {
      doc.roundedRect(W - M - 150 + i * 70, y0 + 12, 60, 32, 4).lineWidth(1).fillAndStroke("#242933", "#3a4050");
      text(doc, `SD ${n}`, W - M - 150 + i * 70, y0 + 18, { size: 8, bold: true, color: "#c9ccd1", width: 60, align: "center" });
      text(doc, n === 1 ? "1-32" : "33-64", W - M - 150 + i * 70, y0 + 30, { size: 7, color: "#9ca3af", width: 60, align: "center" });
    });
  }
  const chunks = (cells: PortCell[], label: string): { label: string; cells: PortCell[]; offset: number }[] => {
    const out: { label: string; cells: PortCell[]; offset: number }[] = [];
    for (let r = 0; r < 4; r++) {
      const part = cells.filter((c) => c.port > r * 16 && c.port <= r * 16 + 16);
      if (part.some((c) => c.used)) out.push({ label: `${label} ${r * 16 + 1}-${r * 16 + 16}${box.spec.id === "wing-live" ? ` · SD ${Math.floor((r * 16) / 32) + 1}` : ""}`, cells: part.map((c) => ({ ...c, port: c.port - r * 16 })), offset: r * 16 });
    }
    return out;
  };
  const rows = [...chunks(box.inputs, L.inputs), ...chunks(box.outputs, L.outputs)];
  if (rows.length === 0) {
    text(doc, L.cardNone, M, y0 + 80, { size: 10, color: MUTED });
    return;
  }
  // A strip needs about 66 pt (two-line names, three in "full"): what does not fit goes on a continuation page.
  const PITCH = 66;
  const firstPage = Math.max(1, Math.floor((H - 40 - (y0 + 72)) / PITCH));
  const nextPages = Math.max(1, Math.floor((H - 40 - y0) / PITCH));
  rows.slice(0, firstPage).forEach((r, i) => strip(doc, r.label, r.cells, 16, y0 + 72 + i * PITCH, naming, r.offset));
  for (let from = firstPage; from < rows.length; from += nextPages) {
    doc.addPage({ size: [W, H], margin: 0 });
    header(doc, `${box.device} ${L.cont}`, box.spec.label);
    rows.slice(from, from + nextPages).forEach((r, i) => strip(doc, r.label, r.cells, 16, y0 + i * PITCH, naming, r.offset));
  }
}

/** Personal mixer: sixteen channel cards, 8 per row, as on the reference sheet. */
function p16Cards(doc: Doc, box: BoxPage, naming: NamingMode): void {
  const cw = (GRID - 7 * 8) / 8;
  const ch = 52;
  for (let slot = 1; slot <= 16; slot++) {
    const c = coveringCell(box.outputs, slot) ?? { port: slot, span: 1, channelNames: [], used: false };
    // Stereo: a pair is one cell over two slots, shown as ST L then ST R.
    const side = c.span === 2 ? (slot === c.port ? "ST L" : "ST R") : c.mode && c.mode !== "M" ? "ST" : "MONO";
    const col = (slot - 1) % 8;
    const row = Math.floor((slot - 1) / 8);
    const x = M + col * (cw + 8);
    const y = 210 + row * (ch + 10);
    doc.roundedRect(x, y, cw, ch, 6).fill(CARD);
    doc.save().roundedRect(x, y, cw, ch, 6).clip().rect(x, y, 4, ch).fill(c.used ? (c.color ?? COLOR_USER) : COLOR_FREE).restore();
    text(doc, String(slot), x + 12, y + 8, { size: 8, bold: true, color: MUTED });
    text(doc, side, x + cw - 40, y + 8, { size: 7, color: MUTED, width: 32, align: "right" });
    text(doc, cellLines(c, naming, L.free)[0] as string, x + 12, y + 26, { size: 10, bold: true, color: c.used ? INK : "#9ca3af", width: cw - 18, height: 12 });
  }
}

/** Renders the sheet in the reference layout: overview, then one page per box with its drawn front. */
export function writeVisualPdf(model: PatchSheetModel, naming: NamingMode, opts: { date: Date; title: string; footer: string; lang?: Lang; consolePage?: boolean; onPageCount?: (n: number) => void }): Promise<Buffer> {
  LANG = opts.lang ?? "fr";
  L = strings(LANG);
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: [W, H], margin: 0, bufferPages: true, info: { Title: pdfSafe(opts.title), CreationDate: opts.date } });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    overview(doc, model, opts.title);
    if (opts.consolePage !== false) {
      doc.addPage({ size: [W, H], margin: 0 });
      portsPage(doc, model);
    }
    for (const box of model.boxes.filter((b) => !b.hidden)) {
      doc.addPage({ size: [W, H], margin: 0 });
      boxPage(doc, box, model, naming);
    }
    const range = doc.bufferedPageRange();
    opts.onPageCount?.(range.count);
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      text(doc, `${opts.footer}`, W - M - 360, 38, { size: 8, color: MUTED, width: 360, align: "right", height: 10 });
      text(doc, `Page ${i + 1}/${range.count}`, W - M - 360, 52, { size: 8, color: MUTED, width: 360, align: "right" });
    }
    doc.end();
  });
}
