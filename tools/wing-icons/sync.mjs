// Usage: node tools/wing-icons/sync.mjs 0-14,100-114
// Writes web/src/wing-icons/line-icons.ts's LINE_ICONS from line-icons.json, for the ids in the
// given ranges — the categories switched over so far. line-icons.json stays the source: retouch an
// icon there, then sync again with the same ranges.
import { readFileSync, writeFileSync } from "node:fs";

const ranges = (process.argv[2] ?? "").split(",").filter(Boolean).map((r) => r.split("-").map(Number));
if (ranges.length === 0) throw new Error("Give the id ranges to include, e.g. 0-14,100-114");
const icons = JSON.parse(readFileSync(new URL("./line-icons.json", import.meta.url), "utf8"));
const target = new URL("../../web/src/wing-icons/line-icons.ts", import.meta.url);

const ids = Object.keys(icons)
  .map(Number)
  .filter((id) => ranges.some(([lo, hi = lo]) => id >= lo && id <= hi))
  .sort((a, b) => a - b);
const entries = ids.map((id) => {
  const { stroke, fill, evenodd } = icons[id];
  const fields = [stroke && `stroke: ${JSON.stringify(stroke)}`, fill && `fill: ${JSON.stringify(fill)}`, evenodd && "evenodd: true"].filter(Boolean);
  return `  ${id}: { ${fields.join(", ")} },`;
});

const source = readFileSync(target, "utf8");
const start = source.indexOf("export const LINE_ICONS");
if (start < 0) throw new Error("LINE_ICONS not found in line-icons.ts");
const head = source.slice(0, start);
writeFileSync(target, `${head}// Synced from tools/wing-icons/line-icons.json for: ${process.argv[2]}\nexport const LINE_ICONS: Record<number, LineIcon> = {\n${entries.join("\n")}\n};\n`);
console.log(`line-icons.ts: ${ids.length} icons (${process.argv[2]})`);
