// Usage: node render.mjs <icons.json> <out.png> [id,id,...]
// icons.json: { "<wing id>": { "stroke": "<path drawn as a 1.5-wide round line>", "fill": "<optional path drawn solid>", "evenodd": true|false }, ... }
// (the older { "d", "evenodd" } solid format still renders)
// Draws, per icon: a 144px light view with a faint 24x24 grid and the 2px safe margin, then the
// icon at real dashboard sizes (20px and 32px) on light and dark backgrounds, and its WING name.
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
const [,, file, out, only] = process.argv;
const icons = JSON.parse(readFileSync(file, "utf8"));
const names = Object.fromEntries(JSON.parse(readFileSync(new URL("./wing-icon-list.json", import.meta.url), "utf8")).flatMap((c) => c.icons.map((i) => [i.id, i.name])));
const ids = (only ? only.split(",") : Object.keys(icons)).filter((id) => icons[id]);
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
const paths = (ic, fg) =>
  (ic.fill || ic.d ? `<path d="${ic.fill || ic.d}" fill="${fg}"${ic.evenodd ? ' fill-rule="evenodd"' : ""}/>` : "") +
  (ic.stroke ? `<path d="${ic.stroke}" fill="none" stroke="${fg}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>` : "");
const glyph = (ic, size, fg) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24">${paths(ic, fg)}</svg>`;
const grid = Array.from({ length: 25 }, (_, i) => `<line x1="${i}" y1="0" x2="${i}" y2="24"/><line x1="0" y1="${i}" x2="24" y2="${i}"/>`).join("");
const cells = ids.map((id) => {
  const ic = icons[id];
  return `<div class="cell"><div class="big"><svg width="144" height="144" viewBox="0 0 24 24"><g stroke="#ddd" stroke-width="0.03">${grid}</g><rect x="2" y="2" width="20" height="20" fill="none" stroke="#9cf" stroke-width="0.06"/>${paths(ic, "#222")}</svg></div>
  <div class="small"><span class="l">${glyph(ic, 20, "#222")}${glyph(ic, 32, "#222")}</span><span class="d">${glyph(ic, 20, "#e7e9ee")}${glyph(ic, 32, "#e7e9ee")}</span></div>
  <div class="name">${esc(id)} · ${esc(names[id] ?? "?")}</div></div>`;
}).join("");
const html = `<style>body{margin:0;font:12px sans-serif;background:#fff}.wrap{display:flex;flex-wrap:wrap;gap:10px;padding:10px;width:${5 * 170}px}
.cell{width:160px}.big{background:#f4f4f4}.small{display:flex;gap:6px;margin-top:4px}.small span{display:flex;gap:6px;align-items:center;padding:4px}
.l{background:#f4f5f8}.d{background:#16191f}.name{margin-top:3px;height:30px;overflow:hidden}</style><div class="wrap">${cells}</div>`;
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const p = await (await b.newContext({ viewport: { width: 880, height: 600 }, deviceScaleFactor: 1.5 })).newPage();
await p.setContent(html);
await p.locator(".wrap").screenshot({ path: out, timeout: 20000 });
await b.close();
console.log(`rendered ${ids.length} icons -> ${out}`);
