import { WingValueError } from "../wing-errors.js";
import { collectPatch, type CollectPatchOptions } from "../wing-patch.js";
import { normalizeBoxMap, stableStringify, validateBoxMap } from "./box-map-validation.js";
import type { WingPluginContext } from "../wing-plugin.js";
import { strings, type Lang } from "./strings.js";
import { buildPatchSheet, type NamingMode } from "./patch-model.js";
import { renderTablePdf } from "./pdf-writer.js";
import { writeVisualPdf } from "./render-visual.js";
import { buildTablePages } from "./render-table.js";

export type PatchSheetRender = "table" | "visual";
export interface PatchSheetOptions extends Pick<CollectPatchOptions, "boxes" | "includeUnused"> {
  render?: PatchSheetRender;
  naming?: NamingMode;
  title?: string;
  /** Words printed on the sheet: French (default) or English. */
  lang?: Lang;
}

export interface PatchSheetResult {
  pdf: Buffer;
  pages: number;
  boxes: string[];
}

/** How long one sheet may take: it is several hundred sequential reads of the console. */
const SHEET_TIMEOUT_MS = 180_000;

/** Sheets being made, by what they depend on: a second click while one runs shares it instead of queueing hundreds of reads again. */
const inFlight = new Map<string, Promise<PatchSheetResult>>();

/** Reads the console and renders the patch sheet PDF (one at a time for the same map and options). */
export function generatePatchSheet(ctx: WingPluginContext, opts: PatchSheetOptions = {}): Promise<PatchSheetResult> {
  const key = stableStringify({ opts, saved: ctx.getConfig().boxMap ?? {} });
  const running = inFlight.get(key);
  if (running) return running;
  const work = Promise.race([
    makePatchSheet(ctx, opts),
    new Promise<never>((_, reject) => setTimeout(() => reject(new WingValueError("The patch sheet took too long to build: the console did not answer in time.")), SHEET_TIMEOUT_MS).unref()),
  ]).finally(() => inFlight.delete(key));
  inFlight.set(key, work);
  return work;
}

async function makePatchSheet(ctx: WingPluginContext, opts: PatchSheetOptions): Promise<PatchSheetResult> {
  const naming = opts.naming ?? "channel";
  // One spelling per group (AES50-A, StageConnect...) whatever way the map came in.
  const boxMap = normalizeBoxMap({ ...normalizeBoxMap(ctx.getConfig().boxMap ?? {}), ...normalizeBoxMap(opts.boxes ?? {}) });
  if (opts.boxes) {
    const problems = validateBoxMap(boxMap);
    if (problems.length > 0) throw new WingValueError(problems.join(" "));
  }
  const data = await collectPatch(ctx, {
    boxes: boxMap,
    includeUnused: true,
    // Only the groups a box hangs on: a full output read is several hundred sequential dumps.
    outputGroups: [...new Set([...Object.keys(boxMap), ...Object.values(boxMap).flatMap((l) => l.map((b) => b.feed?.group).filter((g): g is string => !!g))])],
    extraSourceGroups: Object.keys(boxMap),
  });
  const model = buildPatchSheet({ ...data, boxMap });
  const date = new Date();
  const t = strings(opts.lang);
  const title = opts.title ?? t.title;
  const footer = `${title} · Behringer WING · ${date.toLocaleDateString(t.locale, { day: "numeric", month: "short", year: "numeric" })}`;
  if (opts.render !== "table") {
    const visual = await writeVisualPdf(model, naming, { date, title, footer, lang: opts.lang });
    return { pdf: visual, pages: 2 + model.boxes.length, boxes: model.boxes.map((b) => b.device) };
  }
  const pages = buildTablePages(model, naming, opts.title, opts.lang);
  const { pdf, pageCount } = await renderTablePdf(pages, { date, footer, lang: opts.lang });
  return { pdf, pages: pageCount, boxes: model.boxes.map((b) => b.device) };
}
