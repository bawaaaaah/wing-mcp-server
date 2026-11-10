import { collectPatch, type CollectPatchOptions } from "../wing-patch.js";
import type { WingPluginContext } from "../wing-plugin.js";
import { buildPatchSheet, type NamingMode } from "./patch-model.js";
import { writeTablePdf } from "./pdf-writer.js";
import { buildTablePages } from "./render-table.js";

export type PatchSheetRender = "table";
export interface PatchSheetOptions extends Pick<CollectPatchOptions, "boxes" | "includeUnused"> {
  render?: PatchSheetRender;
  naming?: NamingMode;
  title?: string;
}

export interface PatchSheetResult {
  pdf: Buffer;
  pages: number;
  boxes: string[];
}

/** Reads the console and renders the patch sheet PDF. */
export async function generatePatchSheet(ctx: WingPluginContext, opts: PatchSheetOptions = {}): Promise<PatchSheetResult> {
  const naming = opts.naming ?? "channel";
  const boxMap = { ...(ctx.getConfig().boxMap ?? {}), ...(opts.boxes ?? {}) };
  const data = await collectPatch(ctx, {
    boxes: opts.boxes,
    includeUnused: true,
    // Only the groups a box hangs on: a full output read is several hundred sequential dumps.
    outputGroups: [...new Set([...Object.keys(boxMap), ...Object.values(boxMap).flatMap((l) => l.map((b) => b.feed?.group).filter((g): g is string => !!g))])],
    extraSourceGroups: Object.keys(boxMap),
  });
  const model = buildPatchSheet(data);
  const pages = buildTablePages(model, naming, opts.title);
  const date = new Date();
  const pdf = await writeTablePdf(pages, { date, footer: `${pages[0]?.title ?? "Patch"} · Behringer WING · ${date.toLocaleDateString("fr-FR")}` });
  return { pdf, pages: pages.length, boxes: model.boxes.map((b) => b.device) };
}
