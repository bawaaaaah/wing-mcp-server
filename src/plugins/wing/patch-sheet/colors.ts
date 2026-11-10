/** The console's own palette (see WING_COLOR_NAMES in wing-param-catalog.ts), for the sheet's bars and rings. */
const WING_HEX: Record<string, string> = {
  Blue: "#3e63cc",
  Azure: "#0180ff",
  Indigo: "#5a33ff",
  Turquoise: "#00ced1",
  Green: "#00b23e",
  Lime: "#96cc00",
  Yellow: "#f2dd00",
  Brown: "#c06a1f",
  Red: "#e02040",
  Salmon: "#ff7a7a",
  Magenta: "#ff33f6",
  Purple: "#a533ff",
  Amber: "#ffb81a",
  "Sky Blue": "#25c3ff",
  "Orange Red": "#ff5a30",
  "Mint Green": "#33e6a5",
  Gray: "#707070",
  White: "#9aa3ad",
};

export const COLOR_FREE = "#b8bfc8";
/** Roles of outputs, as in the reference sheet (in-ear returns pink, house feed green, user signals light blue). */
export const COLOR_BUS = "#e0457b";
export const COLOR_MAIN = "#27ae60";
export const COLOR_USER = "#2d9cdb";
export const COLOR_COMPUTER = "#f2994a";

export function wingHex(colorName: string | undefined): string | undefined {
  return colorName ? WING_HEX[colorName] : undefined;
}
