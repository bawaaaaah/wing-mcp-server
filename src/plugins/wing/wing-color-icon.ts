import { WingValueError } from "./wing-errors.js";
import { WING_COLOR_NAMES, WING_ICON_CATEGORIES, wingColorName, wingIconName } from "./wing-param-catalog.js";

/** Lowercase, accents stripped, punctuation collapsed — so "Rosé", "rose" and "ROSE" compare equal. */
export function normalizeWord(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/œ/g, "oe")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * French and English words for the console's 18 palette slots. The palette has no pink: "rose" and
 * "pink" land on Magenta (11), the closest hue; Salmon (10) is the paler alternative and is reachable
 * as "saumon"/"salmon". Likewise there is no black; "noir"/"black" are deliberately absent rather than
 * mapped to something misleading.
 */
const COLOR_ALIASES: Record<string, number> = {
  bleu: 1, blue: 1,
  azur: 2, azure: 2, "bleu clair": 2, "light blue": 2,
  indigo: 3, "bleu violet": 3,
  turquoise: 4, cyan: 4, "bleu vert": 4, teal: 4,
  vert: 5, green: 5,
  lime: 6, "vert clair": 6, "vert citron": 6, "light green": 6,
  jaune: 7, yellow: 7,
  marron: 8, brun: 8, brown: 8,
  rouge: 9, red: 9,
  saumon: 10, salmon: 10, corail: 10, coral: 10, "rose pale": 10, "light pink": 10,
  magenta: 11, rose: 11, pink: 11, fuchsia: 11,
  violet: 12, purple: 12, pourpre: 12, mauve: 12,
  ambre: 13, amber: 13, or: 13, gold: 13, dore: 13,
  "bleu ciel": 14, "sky blue": 14, sky: 14, ciel: 14,
  orange: 15, "orange red": 15, "rouge orange": 15,
  menthe: 16, "vert menthe": 16, mint: 16, "mint green": 16,
  gris: 17, gray: 17, grey: 17,
  blanc: 18, white: 18,
};

for (const [i, name] of WING_COLOR_NAMES.entries()) {
  COLOR_ALIASES[normalizeWord(name)] = i + 1;
}

export interface ResolvedColor {
  col: number;
  colorName: string;
  /** Set when the input was a word, to show what it became (e.g. "rose" -> Magenta). */
  from?: string;
}

/** Accepts a palette index 1..18, a numeric string, or a French/English color word. */
export function resolveColor(input: number | string): ResolvedColor {
  const asNumber = typeof input === "number" ? input : /^\d+$/.test(input.trim()) ? Number(input) : NaN;
  if (Number.isFinite(asNumber)) {
    const name = wingColorName(asNumber);
    if (!Number.isInteger(asNumber) || !name) {
      throw new WingValueError(`Color index must be 1..18 — got ${input}.`);
    }
    return { col: asNumber, colorName: name };
  }
  const key = normalizeWord(String(input));
  const col = COLOR_ALIASES[key];
  if (col === undefined) {
    const known = WING_COLOR_NAMES.map((n, i) => `${i + 1}=${n}`).join(", ");
    throw new WingValueError(
      `Unknown color "${input}". Use 1..18 or a color word (FR/EN: bleu, rouge, vert, jaune, violet, rose→Magenta, ` +
        `saumon, orange, gris, blanc, ...). Palette: ${known}. There is no pink or black in the palette.`,
    );
  }
  return { col, colorName: wingColorName(col) as string, from: String(input) };
}

/**
 * Extra search words per icon, for queries the transcribed names do not contain ("femme" is in
 * "Chanteuse (femme)", but "voix" or "vocal" is in none of them).
 */
const ICON_KEYWORDS: Record<number, string[]> = {
  100: ["voix", "vocal", "vox", "chant", "micro"],
  102: ["hf", "sans fil"],
  105: ["pasteur", "discours", "speech", "orateur", "pupitre"],
  107: ["serre tete"],
  112: ["choir", "choeur", "chorale", "back", "backing", "choristes"],
  113: ["femme", "woman", "female", "chanteuse", "voix", "lead"],
  114: ["homme", "man", "male", "chanteur", "voix", "lead", "talkback"],
  200: ["bd", "bass drum"],
  210: ["drums", "batterie", "kit", "overhead", "oh"],
  223: ["sequence", "seq", "sampler", "pad", "electro", "backing track"],
  300: ["gtr", "guitare", "guitar"],
  301: ["acoustic", "folk", "gtr"],
  309: ["bass", "basse", "bgtr"],
  400: ["piano", "grand"],
  402: ["synth", "clavier", "keys", "keyboard"],
  407: ["clavier", "keys", "keyboard", "piano"],
  408: ["clavier", "keys", "keyboard", "piano"],
  409: ["orgue", "organ", "hammond"],
  503: ["pa", "facade", "foh", "main"],
  506: ["sub", "caisson"],
  522: ["retour", "wedge", "monitor", "ear"],
  602: ["casque", "headphones", "iem", "ear"],
  605: ["ordi", "laptop", "computer", "playback"],
  606: ["playback", "lecteur", "mp3"],
  607: ["telephone", "phone", "bluetooth"],
};

export interface IconMatch {
  id: number;
  name: string;
  category: string;
  score: number;
}

/** Ranks every known icon against a free-text query (FR or EN), best first. */
export function searchIcons(query: string, limit = 10): IconMatch[] {
  const words = normalizeWord(query).split(" ").filter(Boolean);
  if (words.length === 0) return [];
  const matches: IconMatch[] = [];
  for (const category of WING_ICON_CATEGORIES) {
    category.names.forEach((name, i) => {
      const id = category.min + i;
      const haystack = normalizeWord(`${name} ${(ICON_KEYWORDS[id] ?? []).join(" ")} ${category.label}`);
      const tokens = new Set(haystack.split(" "));
      let score = 0;
      for (const w of words) {
        if (tokens.has(w)) score += 3;
        else if (haystack.includes(w)) score += 1;
      }
      if (score > 0) matches.push({ id, name, category: category.label, score });
    });
  }
  return matches.sort((a, b) => b.score - a.score || a.id - b.id).slice(0, limit);
}

export interface ResolvedIcon {
  icon: number;
  iconName: string | undefined;
  from?: string;
  /** Other close matches, when the word was ambiguous. */
  alternatives?: IconMatch[];
}

/** Accepts an icon id 0..999, a numeric string, or a word matched with `searchIcons`. */
export function resolveIcon(input: number | string): ResolvedIcon {
  const asNumber = typeof input === "number" ? input : /^\d+$/.test(input.trim()) ? Number(input) : NaN;
  if (Number.isFinite(asNumber)) {
    if (!Number.isInteger(asNumber) || asNumber < 0 || asNumber > 999) {
      throw new WingValueError(`Icon must be 0..999 — got ${input}.`);
    }
    return { icon: asNumber, iconName: wingIconName(asNumber) };
  }
  const found = searchIcons(String(input), 5);
  const best = found[0];
  if (!best) {
    throw new WingValueError(`No icon matches "${input}". Try wing_icon_search, or pass an icon number.`);
  }
  const alternatives = found.slice(1).filter((m) => m.score === best.score);
  return { icon: best.id, iconName: best.name, from: String(input), ...(alternatives.length ? { alternatives } : {}) };
}
