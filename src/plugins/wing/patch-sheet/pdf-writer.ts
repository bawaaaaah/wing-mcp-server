import PDFDocument from "pdfkit";
import type { TablePage } from "./render-table.js";
import { strings, type Lang } from "./strings.js";

/** Helvetica is WinAnsi: keep Latin-1 plus the few typographic marks it has, replace the rest. */
export function pdfSafe(text: string): string {
  return text
    .replace(/→/g, "->")
    .replace(/←/g, "<-")
    .replace(/[^\x20-\x7e\xa0-\xff–—‘’“”•…€]/g, "?");
}

const MARGIN = 40;
const ROW_H = 16;

/** Renders table pages to an A4-landscape PDF. `date` is fixed by the caller so output is stable. */
export function writeTablePdf(pages: TablePage[], opts: { date: Date; footer: string; lang?: Lang }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", layout: "landscape", margin: MARGIN, bufferPages: true, info: { Title: pdfSafe(pages[0]?.title ?? "Patch"), CreationDate: opts.date } });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const width = doc.page.width - 2 * MARGIN;
    const bottom = () => doc.page.height - MARGIN - 20;
    let first = true;
    for (const page of pages) {
      if (!first) doc.addPage();
      first = false;
      doc.font("Helvetica-Bold").fontSize(22).fillColor("#1f2430").text(pdfSafe(page.title), MARGIN, MARGIN);
      doc.font("Helvetica").fontSize(10).fillColor("#6b7280").text(pdfSafe(page.subtitle), MARGIN, doc.y + 2);
      doc.moveTo(MARGIN, doc.y + 8).lineTo(MARGIN + width, doc.y + 8).strokeColor("#d8dbe0").stroke();
      let y = doc.y + 20;
      for (const section of page.sections) {
        const weights = section.weights ?? section.columns.map((c, i) => (i === 0 ? 0.6 : c === "Patch" ? 1.2 : c === "Mode" ? 0.6 : 2));
        const total = weights.reduce((a, b) => a + b, 0);
        const colW = weights.map((w) => (w / total) * width);
        const drawHeader = () => {
          doc.font("Helvetica-Bold").fontSize(9).fillColor("#6b7280").text(pdfSafe(section.heading), MARGIN, y);
          y += 14;
          doc.rect(MARGIN, y, width, ROW_H).fill("#f1f3f5");
          let x = MARGIN;
          section.columns.forEach((c, i) => {
            doc.font("Helvetica-Bold").fontSize(9).fillColor("#374151").text(pdfSafe(c), x + 4, y + 4, { width: (colW[i] as number) - 8, lineBreak: false });
            x += colW[i] as number;
          });
          y += ROW_H;
        };
        if (y + 40 > bottom()) { doc.addPage(); y = MARGIN; }
        drawHeader();
        for (const [ri, row] of section.rows.entries()) {
          if (y + ROW_H > bottom()) { doc.addPage(); y = MARGIN; drawHeader(); }
          const rowColor = section.rowColors?.[ri];
          if (rowColor) {
            // A faint tint across the row and a solid bar on its left edge.
            doc.save().fillOpacity(0.12).rect(MARGIN, y, width, ROW_H).fill(rowColor).restore();
            doc.rect(MARGIN, y, 4, ROW_H).fill(rowColor);
          }
          let x = MARGIN;
          row.forEach((cell, i) => {
            const free = cell === strings(opts.lang).free;
            doc.font(i === 0 ? "Helvetica-Bold" : "Helvetica").fontSize(9).fillColor(free ? "#9ca3af" : "#1f2430").text(pdfSafe(cell), x + (i === 0 ? 10 : 4), y + 4, { width: (colW[i] as number) - 8, lineBreak: false, ellipsis: true });
            x += colW[i] as number;
          });
          doc.moveTo(MARGIN, y + ROW_H).lineTo(MARGIN + width, y + ROW_H).strokeColor("#eceef1").lineWidth(0.5).stroke();
          y += ROW_H;
        }
        y += 16;
      }
    }
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      doc.font("Helvetica").fontSize(8).fillColor("#6b7280");
      // Below the bottom margin: pdfkit would start a new page for text there, so lift the margin first.
      doc.page.margins.bottom = 0;
      doc.text(pdfSafe(`${opts.footer} · Page ${i + 1}/${range.count}`), MARGIN, doc.page.height - 30, { width, align: "right", lineBreak: false });
    }
    doc.end();
  });
}
