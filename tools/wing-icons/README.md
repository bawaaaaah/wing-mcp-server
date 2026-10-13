# Line-style strip icons

The dashboard's strip icons: a complete, original set of the WING's icon ids — 124, every one in
the console's grid but 0 ("no icon") — drawn for this project as 24×24 line art. The dashboard reads
them from `web/src/wing-icons/line-icons.ts`, which `sync.mjs` writes from `line-icons.json`:
retouch an icon in the JSON, check it with `render.mjs`, then run
`node tools/wing-icons/sync.mjs 0-14,100-114,200-224,300-319,400-409,500-524,600-614`.

- `line-icons.json` — `{ "<wing id>": { "stroke", "fill"?, "evenodd" } }`. `stroke` is drawn with
  `fill="none"`, `stroke-width="1.5"`, round caps and joins; `fill`, when present, is drawn solid
  (with the even-odd rule when `evenodd`). Both in `currentColor`. Letters that tell ids apart on the
  console (tom H/M/L/F, cymbal C/R, speaker L/R, talkback A/B…) are drawn into the icon.
- `wing-icon-list.json` — the console's grid, by category, with each id's name.
- `render.mjs` — `node tools/wing-icons/render.mjs <icons.json> <out.png> [id,id,…]`: each icon
  enlarged on a 24×24 grid, plus at 20 and 32 px on light and dark.
- `overview.mjs` — `node tools/wing-icons/overview.mjs <icons.json> <out.png>`: the whole grid on
  black, for checking the set reads as one family.

The icons are original drawings, MIT like the rest of the project. The console's own icon sheet
(Music Tribe's WING remote protocol manual) was only used to know which object, which point of view
and which letter each id shows; no outline was traced or copied from it.
