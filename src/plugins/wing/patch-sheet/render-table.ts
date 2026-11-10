import { COLOR_COMPUTER, COLOR_FREE } from "./colors.js";
import { connectorsText } from "./device-catalog.js";
import { strings, type Lang, type Strings } from "./strings.js";
import type { PortLine } from "./patch-model.js";
import { cellLines, type BoxPage, type NamingMode, type PatchSheetModel, type PortCell } from "./patch-model.js";

/** A page of the sheet as plain tables — what the PDF writer draws and what the tests read. */
export interface TablePage {
  title: string;
  subtitle: string;
  sections: { heading: string; columns: string[]; rows: string[][]; /** One colour per row (hex): drawn as a bar and a tinted background. */ rowColors?: (string | undefined)[]; /** Relative column widths; default by header. */ weights?: number[] }[];
}

function namingColumns(naming: NamingMode, t: Strings): string[] {
  return naming === "io" ? [t.colName] : naming === "channel" ? [t.colChannel] : [t.colInput, t.colChannel, t.colOutput];
}

/** Used cells take their colour, free ones are grey. */
function cellColor(cell: PortCell): string {
  return cell.used ? (cell.color ?? "#2d9cdb") : COLOR_FREE;
}

function portLabel(cell: PortCell): string {
  return cell.span === 2 ? `${cell.port}-${cell.port + 1}` : String(cell.port);
}

function rowFor(cell: PortCell, naming: NamingMode, t: Strings): string[] {
  const common = [portLabel(cell), cell.patch ?? "", cell.mode && cell.mode !== "M" ? cell.mode : cell.phantom48v ? "48V" : ""];
  if (naming === "full") {
    const free = !cell.used;
    return [...common, free ? t.free : (cell.inputName ?? ""), cell.channelNames.join(" + "), cell.outputName ?? ""];
  }
  return [...common, cellLines(cell, naming, t.free).join(" / ")];
}

function boxSections(box: BoxPage, naming: NamingMode, t: Strings): TablePage["sections"] {
  // A 64-channel card lists only the channels in use.
  if (box.spec.kind === "card") box = { ...box, inputs: box.inputs.filter((c) => c.used), outputs: box.outputs.filter((c) => c.used) };
  const cols = ["Port", "Patch", "Mode", ...namingColumns(naming, t)];
  const sections: TablePage["sections"] = [];
  if (box.inputs.length > 0) sections.push({ heading: t.tableInputs, columns: cols, rows: box.inputs.map((c) => rowFor(c, naming, t)), rowColors: box.inputs.map(cellColor) });
  if (box.outputs.length > 0) {
    const heading = box.spec.kind === "personal-mixer" ? t.tableChannels : t.tableOutputs;
    sections.push({ heading, columns: cols, rows: box.outputs.map((c) => rowFor(c, naming, t)), rowColors: box.outputs.map(cellColor) });
  }
  return sections;
}

/** "HUB4 (A 33-48): DL8-1 (port 1), DL8-2 (port 2) · S16 (B 1-16)": a device, then what hangs off it. */
function portSummary(lines: PortLine[]): string {
  const out: string[] = [];
  for (const l of lines) {
    if (l.indent === 0) out.push(`${l.name} (${l.detail})`);
    else out[out.length - 1] += `${out[out.length - 1]?.includes(":") ? ", " : ": "}${l.name} (${l.detail})`;
  }
  return out.join(" · ");
}

/** What a box's subtitle adds about its modes: where its XLR outputs come from, a splitter Ultranet. */
export function modeNotes(box: BoxPage, t: Strings): string[] {
  return [box.outRange ? t.outputsOn(box.group, box.outRange[0], box.outRange[1]) : "", box.splitter ? t.splitterNote : ""].filter(Boolean);
}

export function buildTablePages(model: PatchSheetModel, naming: NamingMode, title?: string, lang?: Lang): TablePage[] {
  const t = strings(lang);
  title ??= t.title;
  const pages: TablePage[] = [];
  pages.push({
    title,
    subtitle: t.overviewSubtitle,
    sections: [
      {
        heading: t.boxes,
        columns: [t.colBox, t.colLink, t.colInputsUsed, t.colOutputsUsed],
        weights: [3, 2, 1.2, 1.2],
        rowColors: model.boxes.map((b) => (b.outputs.some((c) => c.used) || b.inputs.some((c) => c.used) ? (b.spec.kind === "stagebox" || b.spec.kind === "generic" ? "#8e44ad" : "#2d9cdb") : COLOR_FREE)),
        rows: model.boxes.map((b) => [
          b.spec.label === b.device || b.spec.kind === "generic" ? b.device : `${b.device} (${b.spec.label})`,
          b.via ? `${t.via(b.via)} (${b.link})` : b.hub ? `${b.link} · ${b.range[0] >= 33 ? `${t.scOf} ` : `${t.on} `}${b.hub}` : b.link,
          b.via ? "-" : `${b.inputs.filter((c) => c.used).length}/${b.inputs.length}`,
          `${b.outputs.filter((c) => c.used).length}/${b.outputs.length}`,
        ]),
      },
      {
        heading: t.consolePorts,
        columns: ["Port", t.colPluggedIn],
        weights: [1.2, 5],
        rows: model.consolePorts.map((p) => [p.label, p.lines.length === 0 ? t.nothingPlugged : portSummary(p.lines)]),
        rowColors: model.consolePorts.map((p) => (p.lines.length === 0 ? COLOR_FREE : "#8e44ad")),
      },
      ...(model.consoleSources.length > 0
        ? [{ heading: t.consoleSources, columns: ["Source", t.colName, t.colChannel], rows: model.consoleSources.map((s) => [s.label, s.name, s.channelNames.join(" + ")]), rowColors: model.consoleSources.map((s) => s.color ?? COLOR_COMPUTER) }]
        : []),
    ],
  });
  for (const box of model.boxes) {
    pages.push({
      title: box.device,
      subtitle: [box.spec.label, box.via ? `${t.pluggedInto} ${box.via}` : `${box.group} ${box.range[0]}-${box.range[1]}`, connectorsText(box.spec, lang), ...modeNotes(box, t)].filter(Boolean).join(" · "),
      sections: boxSections(box, naming, t),
    });
  }
  return pages;
}
