// The glyph shown for each of the WING's strip icon ids (the `icon` parameter, 0..999), matched to
// the console's icon grid (names in components/ParamPanel.tsx's ICON_CATEGORIES). Every one is an
// original line drawing from line-icons.ts; letters the console tells ids apart by (tom H/M/L/F,
// cymbal C/R, speaker L/R, talkback A/B) are part of the drawings.

import { LINE_ICONS, type LineIcon } from "./line-icons.js";

/** The glyph for a WING icon id, or undefined for 0 ("Vide", no icon) and ids outside the grid. */
export function wingGlyph(id: number): LineIcon | undefined {
  return LINE_ICONS[id];
}
