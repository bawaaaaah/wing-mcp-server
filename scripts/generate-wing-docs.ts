// Regenerates the auto-generated per-namespace node-tree reference tables under
// docs/wing-protocol/05-node-tree/*.md from the single source of truth,
// src/plugins/wing/wing-param-catalog.ts.
//
// Run via `npm run docs:gen:wing` (wired up in package.json as `tsx scripts/generate-wing-docs.ts`).
//
// Design notes:
// - docs/wing-protocol/05-node-tree/README.md is intentionally NEVER touched by this script. It is a
//   hand-written narrative file (the root namespace map) maintained like the other narrative docs
//   (01, 02, 03, 04, 06, 07, 08, 09, and the top-level README.md). Only the per-category tables listed
//   in CATEGORY_MATCHERS below (channel.md, bus.md, ...) are generated/overwritten here.
// - Entries whose pathTemplate doesn't match any known top-level namespace are collected into a
//   catch-all "misc.md" file (with a console.warn per entry) rather than silently dropped, so nothing
//   in the catalog can vanish from the docs without at least leaving a trace in the generator's own
//   output. Extend CATEGORY_MATCHERS if the catalog grows a namespace that deserves its own file.
// - The actual rendering logic lives in the exported `renderNodeTreeDocs()` pure function so that
//   test/docs/wing-docs-sync.spec.ts can regenerate content in memory and compare it against what's
//   committed on disk, without this script needing to touch the filesystem to be testable.

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WING_PARAM_CATALOG, type WingParamMeta } from "../src/plugins/wing/wing-param-catalog.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NODE_TREE_DIR = path.join(__dirname, "..", "docs", "wing-protocol", "05-node-tree");

const GENERATED_BANNER =
  "<!-- GÉNÉRÉ — ne pas éditer à la main. Source : src/plugins/wing/wing-param-catalog.ts -->";

interface CategoryDef {
  file: string; // filename within docs/wing-protocol/05-node-tree/, e.g. "channel.md"
  title: string; // heading title, e.g. "Channel"
  match: (pathTemplate: string) => boolean;
}

// Order matters: more specific prefixes (e.g. "/$ctl/lib/") must be listed and checked
// before broader ones (e.g. "/$ctl/") that would otherwise swallow them.
const CATEGORY_MATCHERS: CategoryDef[] = [
  { file: "channel.md", title: "Channel", match: (p) => p.startsWith("/ch/") },
  { file: "aux.md", title: "Aux", match: (p) => p.startsWith("/aux/") },
  { file: "bus.md", title: "Bus", match: (p) => p.startsWith("/bus/") },
  { file: "main.md", title: "Main", match: (p) => p.startsWith("/main/") },
  { file: "matrix.md", title: "Matrix", match: (p) => p.startsWith("/mtx/") },
  { file: "dca.md", title: "DCA", match: (p) => p.startsWith("/dca/") },
  { file: "mutegroup.md", title: "Mute Group", match: (p) => p.startsWith("/mgrp/") },
  { file: "scenes-library.md", title: "Scenes & Library", match: (p) => p.startsWith("/$ctl/lib/") },
  {
    file: "system-status.md",
    title: "System Status",
    match: (p) => p.startsWith("/$stat/") || p.startsWith("/$syscfg/") || p.startsWith("/$globals/"),
  },
  // Must come after scenes-library's "/$ctl/lib/" check above.
  { file: "control-surface.md", title: "Control Surface", match: (p) => p.startsWith("/$ctl/") },
  { file: "io-routing.md", title: "I/O Routing", match: (p) => p.startsWith("/io/") },
  { file: "fx.md", title: "FX", match: (p) => p.startsWith("/fx/") },
  { file: "config.md", title: "Config", match: (p) => p.startsWith("/cfg/") },
];

const MISC_FILE = "misc.md";
const MISC_TITLE = "Miscellaneous";

function categorize(catalog: readonly WingParamMeta[]): Map<string, { title: string; entries: WingParamMeta[] }> {
  const groups = new Map<string, { title: string; entries: WingParamMeta[] }>();
  for (const def of CATEGORY_MATCHERS) {
    groups.set(def.file, { title: def.title, entries: [] });
  }

  for (const meta of catalog) {
    const def = CATEGORY_MATCHERS.find((c) => c.match(meta.pathTemplate));
    if (def) {
      groups.get(def.file)!.entries.push(meta);
      continue;
    }
    if (!groups.has(MISC_FILE)) {
      groups.set(MISC_FILE, { title: MISC_TITLE, entries: [] });
    }
    groups.get(MISC_FILE)!.entries.push(meta);
    console.warn(
      `[generate-wing-docs] "${meta.pathTemplate}" matched no known top-level namespace; filed under ${MISC_FILE}`,
    );
  }

  return groups;
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function formatRangeOrEnum(meta: WingParamMeta): string {
  if (meta.type === "enum") {
    return meta.enumValues && meta.enumValues.length > 0 ? meta.enumValues.join(", ") : "";
  }
  if (meta.type === "float" || meta.type === "int") {
    if (meta.min === undefined && meta.max === undefined) return "";
    const min = meta.min ?? "?";
    const max = meta.max ?? "?";
    const range = `${min}..${max}`;
    return meta.step !== undefined ? `${range} (${meta.step})` : range;
  }
  return "";
}

function formatModels(meta: WingParamMeta): string {
  return meta.models && meta.models.length > 0 ? meta.models.join(", ") : "all";
}

function renderTable(entries: readonly WingParamMeta[]): string {
  const header = "| Path | Type | Range/Enum | Unit | RO | Models | Description |";
  const divider = "|---|---|---|---|---|---|---|";
  const rows = entries.map((meta) => {
    const pathCell = `\`${meta.pathTemplate}\``;
    const rangeCell = escapeCell(formatRangeOrEnum(meta));
    const unitCell = escapeCell(meta.unit ?? "");
    const roCell = meta.readOnly ? "yes" : "";
    const modelsCell = escapeCell(formatModels(meta));
    const descriptionCell = escapeCell(meta.description ?? "");
    return `| ${pathCell} | ${meta.type} | ${rangeCell} | ${unitCell} | ${roCell} | ${modelsCell} | ${descriptionCell} |`;
  });
  return [header, divider, ...rows].join("\n");
}

/**
 * Pure rendering function: groups the catalog by top-level namespace and returns a map of
 * filename (relative to docs/wing-protocol/05-node-tree/, e.g. "channel.md") -> full markdown
 * file content. Exported so test/docs/wing-docs-sync.spec.ts can regenerate in memory and diff
 * against the committed files without touching disk itself.
 */
export function renderNodeTreeDocs(catalog: readonly WingParamMeta[]): Record<string, string> {
  const groups = categorize(catalog);
  const files: Record<string, string> = {};

  for (const [file, { title, entries }] of groups) {
    if (entries.length === 0) continue; // never emit an empty category file (e.g. an unused misc.md)
    const lines = [
      GENERATED_BANNER,
      "",
      `# ${title} Node Tree`,
      "",
      `${entries.length} parameter${entries.length === 1 ? "" : "s"} from \`WING_PARAM_CATALOG\`.`,
      "",
      renderTable(entries),
      "",
    ];
    files[file] = lines.join("\n");
  }

  return files;
}

async function main(): Promise<void> {
  const files = renderNodeTreeDocs(WING_PARAM_CATALOG);

  await fs.mkdir(NODE_TREE_DIR, { recursive: true });

  const summary: { file: string; entryCount: number }[] = [];
  for (const [file, content] of Object.entries(files)) {
    await fs.writeFile(path.join(NODE_TREE_DIR, file), content, "utf8");
    const entryCount = content.split("\n").filter((line) => line.startsWith("| `")).length;
    summary.push({ file, entryCount });
  }

  console.log(
    `[generate-wing-docs] wrote ${summary.length} file(s) to ${path.relative(process.cwd(), NODE_TREE_DIR)}/`,
  );
  for (const { file, entryCount } of summary) {
    console.log(`  - ${file}: ${entryCount} entr${entryCount === 1 ? "y" : "ies"}`);
  }
}

const isMainModule = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainModule) {
  main().catch((err) => {
    console.error("[generate-wing-docs] failed:", err);
    process.exitCode = 1;
  });
}
