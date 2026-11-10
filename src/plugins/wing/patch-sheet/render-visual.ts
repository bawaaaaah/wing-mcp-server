import PDFDocument from "pdfkit";
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
    const g = s.label.split(" ")[0] as string;
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
  const computers = ["USB", "PLAY", "MOD", "CRD"].filter((g) => groups.has(g));
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

  const hosts = model.boxes.filter((b) => !b.via && !b.hub && b.group !== "LCL");
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
          k.hub && port >= 1 && port <= 4 ? `port ${port} du ${k.hub}` : k.via ? "Ultranet" : "",
        ]);
      });
    }
  });
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
/** Ports per drawn row: the whole box up to 16, then 8 (to 24) or 16 (beyond). */
function rowSize(n: number): number {
  return n > 24 ? 16 : n > 16 ? 8 : n;
}

function face(doc: Doc, box: BoxPage, n: number): void {
  // Wider than 16 ports: rows of 8 (a WING Rack's 24 inputs) or of 16 (a 32-input S32 / DL32).
  const perRow = rowSize(n);
  const colW = GRID / perRow;
  const y0 = 104;
  if (n > 16) {
    const inRows = Math.ceil(Math.max(...box.inputs.map((c) => c.port + c.span - 1), 1) / perRow);
    doc.roundedRect(M, y0, GRID, 40 + inRows * 28 + 40, 10).fill("#1b1f27");
    text(doc, box.spec.label.toUpperCase(), M + 14, y0 + 8, { size: 11, bold: true, color: "#e5e7eb" });
    const ring = (c: PortCell, y: number): void => {
      for (let k = 0; k < c.span; k++) {
        const idx = c.port - 1 + k;
        const cx = M + ((idx % perRow) + 0.5) * colW;
        const cy = y + Math.floor(idx / perRow) * 28;
        doc.circle(cx, cy, 11).lineWidth(2.5).strokeColor(c.used ? (c.color ?? COLOR_USER) : "#2a2f3a").stroke();
        doc.circle(cx, cy, 7).fill("#0d0f14");
        text(doc, String(idx + 1), cx + 14, cy - 3, { size: 6, bold: true, color: "#9ca3af" });
      }
    };
    for (const c of box.inputs) ring(c, y0 + 34);
    for (const c of box.outputs) {
      for (let k = 0; k < c.span; k++) {
        const cx = M + (c.port - 1 + k + 0.5) * colW;
        const cy = y0 + 34 + inRows * 28 + 18;
        doc.circle(cx, cy, 11).lineWidth(2.5).strokeColor(c.used ? (c.color ?? COLOR_USER) : "#2a2f3a").stroke();
        doc.circle(cx, cy, 7).fill("#0d0f14");
        text(doc, perRow > 8 ? `o${c.port + k}` : `OUT ${c.port + k}`, cx + 14, cy - 3, { size: 6, bold: true, color: "#9ca3af" });
      }
    }
    return;
  }
  const rings = (cells: PortCell[], y: number, r: number): void => {
    for (const c of cells) {
      for (let k = 0; k < c.span; k++) {
        const cx = M + (c.port - 1 + k + 0.5) * colW;
        doc.circle(cx, y, r + 3).lineWidth(3).strokeColor(c.used ? (c.color ?? COLOR_USER) : "#2a2f3a").stroke();
        doc.circle(cx, y, r - 1).fill("#0d0f14");
        if (box.spec.id.startsWith("midas")) doc.circle(cx, y, 3).fill("#3a4050");
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
  doc.roundedRect(M, y0, GRID, stagebox ? 132 : 70, 10).fill("#1b1f27");
  text(doc, box.spec.label.toUpperCase(), M, y0 + 118, { size: 8, bold: true, color: "#6b7280", width: GRID - 14, align: "right" });
  if (stagebox) {
    rings(box.inputs, y0 + 42, 15);
    rings(box.outputs, y0 + 100, 15);
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
    face(doc, box, 16);
    p16Cards(doc, box, naming);
    return;
  }
  if (box.spec.kind === "hub") {
    hubPage(doc, box, model, naming);
    return;
  }
  const n = columns(box);
  face(doc, box, n);
  const stagebox = box.spec.kind === "stagebox";
  if (n > 16) {
    // Rows of 8 or 16 inputs, then the outputs, each as its own strip.
    const perRow = rowSize(n);
    const inRows = Math.ceil(Math.max(...box.inputs.map((c) => c.port + c.span - 1), 1) / perRow);
    let ry = 104 + 40 + inRows * 28 + 40 + 12;
    for (let r = 0; r < inRows; r++) {
      const chunk = box.inputs.filter((c) => c.port > r * perRow && c.port <= r * perRow + perRow).map((c) => ({ ...c, port: c.port - r * perRow }));
      strip(doc, r === 0 ? "ENTREES" : `ENTREES ${r * perRow + 1}-${r * perRow + perRow}`, chunk, perRow, ry, naming);
      ry += 66;
    }
    if (box.outputs.length > 0) strip(doc, "SORTIES", box.outputs, Math.max(perRow, ...box.outputs.map((c) => c.port + c.span - 1)), ry, naming);
    return;
  }
  let y = stagebox ? 250 : 200;
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
    const plugged = model.boxes.filter((b) => b.hub === box.device && b.range[0] <= lo + 7 && b.range[1] >= lo);
    const x = M + (p - 1) * (cw + 12);
    doc.roundedRect(x + 8, y0 + 28, cw - 16, 46, 6).fill("#2b2f38");
    doc.circle(x + 26, y0 + 51, 11).lineWidth(2.5).strokeColor(plugged.length > 0 ? "#8e44ad" : "#3a4050").stroke();
    text(doc, `PORT ${p} · A ${lo}-${lo + 7}`, x + 44, y0 + 38, { size: 8, bold: true, color: "#e5e7eb", width: cw - 56 });
    text(doc, plugged.length > 0 ? plugged.map((b) => b.device).join(", ") : "libre", x + 44, y0 + 52, { size: 8, color: plugged.length > 0 ? "#c9ccd1" : "#6b7280", width: cw - 56 });
  }
  strip(doc, "A 33-48 SERVIS EN STAGECONNECT ET EN SORTIES LOCALES (4 PORTS x 4 SIGNAUX)", box.outputs, 16, y0 + 112, naming);
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
