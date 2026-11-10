import { COLOR_COMPUTER, COLOR_FREE } from "./colors.js";
import { cellLines, type BoxPage, type NamingMode, type PatchSheetModel, type PortCell } from "./patch-model.js";

/** A page of the sheet as plain tables — what the PDF writer draws and what the tests read. */
export interface TablePage {
  title: string;
  subtitle: string;
  sections: { heading: string; columns: string[]; rows: string[][]; /** One colour per row (hex): drawn as a bar and a tinted background. */ rowColors?: (string | undefined)[]; /** Relative column widths; default by header. */ weights?: number[] }[];
}

const NAMING_COLUMNS: Record<NamingMode, string[]> = {
  io: ["Nom"],
  channel: ["Channel"],
  full: ["Entrée", "Channel", "Sortie"],
};

/** Used cells take their colour, free ones are grey. */
function cellColor(cell: PortCell): string {
  return cell.used ? (cell.color ?? "#2d9cdb") : COLOR_FREE;
}

function portLabel(cell: PortCell): string {
  return cell.span === 2 ? `${cell.port}-${cell.port + 1}` : String(cell.port);
}

function rowFor(cell: PortCell, naming: NamingMode): string[] {
  const common = [portLabel(cell), cell.patch ?? "", cell.mode && cell.mode !== "M" ? cell.mode : cell.phantom48v ? "48V" : ""];
  if (naming === "full") {
    const free = !cell.used;
    return [...common, free ? "libre" : (cell.inputName ?? ""), cell.channelNames.join(" + "), cell.outputName ?? ""];
  }
  return [...common, cellLines(cell, naming).join(" / ")];
}

function boxSections(box: BoxPage, naming: NamingMode): TablePage["sections"] {
  // A 64-channel card lists only the channels in use.
  if (box.spec.kind === "card") box = { ...box, inputs: box.inputs.filter((c) => c.used), outputs: box.outputs.filter((c) => c.used) };
  const cols = ["Port", "Patch", "Mode", ...NAMING_COLUMNS[naming]];
  const sections: TablePage["sections"] = [];
  if (box.inputs.length > 0) sections.push({ heading: "ENTREES (boîtier -> console)", columns: cols, rows: box.inputs.map((c) => rowFor(c, naming)), rowColors: box.inputs.map(cellColor) });
  if (box.outputs.length > 0) {
    const heading = box.spec.kind === "personal-mixer" ? "VOIES (console -> boîtier)" : "SORTIES (console -> boîtier)";
    sections.push({ heading, columns: cols, rows: box.outputs.map((c) => rowFor(c, naming)), rowColors: box.outputs.map(cellColor) });
  }
  return sections;
}

export function buildTablePages(model: PatchSheetModel, naming: NamingMode, title = "Patch plateau"): TablePage[] {
  const pages: TablePage[] = [];
  pages.push({
    title,
    subtitle: "Vue d'ensemble du câblage",
    sections: [
      {
        heading: "BOITIERS",
        columns: ["Boîtier", "Liaison", "Entrées utilisées", "Sorties utilisées"],
        weights: [3, 2, 1.2, 1.2],
        rowColors: model.boxes.map((b) => (b.outputs.some((c) => c.used) || b.inputs.some((c) => c.used) ? (b.spec.kind === "stagebox" || b.spec.kind === "generic" ? "#8e44ad" : "#2d9cdb") : COLOR_FREE)),
        rows: model.boxes.map((b) => [
          b.spec.label === b.device || b.spec.kind === "generic" ? b.device : `${b.device} (${b.spec.label})`,
          b.via ? `via ${b.via} (${b.link})` : b.hub ? `${b.link} · sur ${b.hub}` : b.link,
          b.via ? "-" : `${b.inputs.filter((c) => c.used).length}/${b.inputs.length}`,
          `${b.outputs.filter((c) => c.used).length}/${b.outputs.length}`,
        ]),
      },
      ...(model.consoleSources.length > 0
        ? [{ heading: "SOURCES REGIE (Local, USB...)", columns: ["Source", "Nom", "Channel"], rows: model.consoleSources.map((s) => [s.label, s.name, s.channelNames.join(" + ")]), rowColors: model.consoleSources.map((s) => s.color ?? COLOR_COMPUTER) }]
        : []),
    ],
  });
  for (const box of model.boxes) {
    pages.push({
      title: box.device,
      subtitle: [box.spec.label, box.via ? `branché sur ${box.via}` : `${box.group} ${box.range[0]}-${box.range[1]}`, box.spec.connectors].filter(Boolean).join(" · "),
      sections: boxSections(box, naming),
    });
  }
  return pages;
}
