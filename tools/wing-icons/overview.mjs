// Usage: node overview.mjs <icons.json> <out.png> [size] — the whole grid, by category, on black.
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
const [,, file, out, size = "40"] = process.argv;
const icons = JSON.parse(readFileSync(file, "utf8"));
const cats = JSON.parse(readFileSync(new URL("./wing-icon-list.json", import.meta.url), "utf8"));
const g = (ic, s) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24">${ic.fill ? `<path d="${ic.fill}" fill="#eee"${ic.evenodd ? ' fill-rule="evenodd"' : ""}/>` : ""}${ic.stroke ? `<path d="${ic.stroke}" fill="none" stroke="#eee" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>` : ""}</svg>`;
const rows = cats.map((c) => `<div class="cat"><div class="t">${c.label}</div><div class="grid">${c.icons.map((i) => icons[i.id] ? `<div class="c"><span>${i.id}</span>${g(icons[i.id], +size)}${g(icons[i.id], 20)}</div>` : `<div class="c"><span>${i.id}</span></div>`).join("")}</div></div>`).join("");
const html = `<style>body{margin:0;background:#000;color:#aaa;font:11px sans-serif}.wrap{padding:10px;width:${5 * (+size + 60)}px}.cat{margin-bottom:10px}.t{color:#f66;margin:4px 0}.grid{display:grid;grid-template-columns:repeat(5,${+size + 56}px);gap:4px}.c{border:1px solid #333;height:${+size + 10}px;display:flex;align-items:center;gap:6px;padding:0 4px}.c span{width:22px;color:#f66}</style><div class="wrap">${rows}</div>`;
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const p = await (await b.newContext({ viewport: { width: 700, height: 800 }, deviceScaleFactor: 1.5 })).newPage();
await p.setContent(html); await p.locator(".wrap").screenshot({ path: out }); await b.close();
