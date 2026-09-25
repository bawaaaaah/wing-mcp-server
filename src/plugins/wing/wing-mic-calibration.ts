import path from "node:path";
import zlib from "node:zlib";
import { WingValueError } from "./wing-errors.js";
import { type CurvePoint, interpolateCurveDb, RTA_BAND_COUNT, rtaBandCenterHz } from "./wing-eq-math.js";

/**
 * Measurement-mic calibration files: a mic's own frequency response as "frequency dB [phase]" rows,
 * subtracted from what the mic measures. Manufacturers ship them in whatever format was at hand —
 * REW/ARTA/Smaart-style `.txt`/`.cal`/`.frd`, CSV, and e.g. Behringer's ECM8000.zip, which holds the
 * same curve as a LibreOffice `.ods` sheet and as an `.rtf` document. Everything is decoded here
 * without dependencies (zip via zlib, RTF/ODS/XLSX by pattern), keeping only rows whose first two
 * values are a plausible frequency and dB deviation. Sensitivity headers are ignored: the auto-EQ
 * normalises the level, only the shape matters.
 */

export interface CalibrationCandidate {
  /** Where the curve was read from (several files when they hold the same curve). */
  files: string[];
  points: CurvePoint[];
  minHz: number;
  maxHz: number;
  maxAbsDb: number;
}

const MIN_POINTS = 5;
const MAX_POINTS = 50_000;
const MIN_HZ = 1;
const MAX_HZ = 100_000;
const MAX_ABS_DB = 30;
const MAX_ZIP_DEPTH = 2;
const MAX_INFLATED_BYTES = 32 * 1024 * 1024;
const TEXT_EXTENSIONS = new Set([".txt", ".cal", ".frd", ".csv", ".tsv", ".dat", ".rtf", ".mic", ".text"]);
const CONTAINER_EXTENSIONS = new Set([".zip", ".ods", ".xlsx"]);
const IGNORED_NAMES = new Set(["desktop.ini", "thumbs.db"]);

const NUMBER_RE = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;

/** Splits a data line into value tokens, guessing the separator and decimal mark from the line itself. */
function tokenize(line: string): string[] {
  const t = line.trim();
  if (!t) return [];
  if (/[;\t]/.test(t)) {
    return t.split(/\s*[;\t]\s*/).map((s) => s.replace(",", "."));
  }
  if (t.includes(",")) {
    const words = t.split(/\s+/);
    // "20,5 -1,2": whitespace-separated with decimal commas.
    if (words.length >= 2 && words.every((w) => /^[-+]?\d+,\d+$/.test(w) || NUMBER_RE.test(w))) {
      return words.map((w) => w.replace(",", "."));
    }
    return t.split(/\s*,\s*|\s+/);
  }
  return t.split(/\s+/);
}

function normalizePoints(points: CurvePoint[]): CurvePoint[] | null {
  const sorted = [...points].sort((a, b) => a.hz - b.hz);
  const unique = sorted.filter((p, i) => i === 0 || p.hz !== sorted[i - 1].hz);
  return unique.length >= MIN_POINTS ? unique : null;
}

/** Rows of "frequency dB [anything]"; headers, comments and other lines are skipped. */
export function parseCalibrationText(text: string): CurvePoint[] | null {
  const points: CurvePoint[] = [];
  for (const line of text.split(/\r\n|\r|\n/)) {
    const tokens = tokenize(line).filter((s) => s !== "");
    if (tokens.length < 2 || !NUMBER_RE.test(tokens[0]) || !NUMBER_RE.test(tokens[1])) continue;
    const hz = Number(tokens[0]);
    const db = Number(tokens[1]);
    if (!(hz >= MIN_HZ && hz <= MAX_HZ) || !(Math.abs(db) <= MAX_ABS_DB)) continue;
    points.push({ hz, db });
    if (points.length > MAX_POINTS) {
      throw new WingValueError(`Calibration file has more than ${MAX_POINTS} rows.`);
    }
  }
  return normalizePoints(points);
}

/** Plain text out of an RTF document: `\line`/`\par` become line breaks, everything else is dropped. */
export function rtfToText(rtf: string): string {
  let s = rtf;
  let previous: string;
  do {
    previous = s;
    s = s.replace(/\{\\\*[^{}]*\}/g, "");
  } while (s !== previous);
  return s
    .replace(/\\(?:line|par)(?![a-zA-Z])-?\d* ?/g, "\n")
    .replace(/\\'[0-9a-fA-F]{2}/g, "")
    .replace(/\\[a-zA-Z]+-?\d* ?/g, "")
    .replace(/\\[{}\\]/g, "")
    .replace(/[{}]/g, "");
}

function decodeXmlText(xml: string): string {
  return xml
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, "&");
}

function xmlAttr(attrs: string, name: string): string | undefined {
  const match = new RegExp(`${name.replace(":", "\\:")}="([^"]*)"`).exec(attrs);
  return match?.[1];
}

/** One tab-separated text per sheet of an OpenDocument spreadsheet's content.xml. */
export function odsSheetsToText(contentXml: string): { sheet: string; text: string }[] {
  const sheets: { sheet: string; text: string }[] = [];
  for (const table of contentXml.matchAll(/<table:table\b([^>]*)>([\s\S]*?)<\/table:table>/g)) {
    const lines: string[] = [];
    for (const row of table[2].matchAll(/<table:table-row\b[^>]*?(?:\/>|>([\s\S]*?)<\/table:table-row>)/g)) {
      const cells: string[] = [];
      const cellRe = /<table:(?:covered-)?table-cell\b([^>]*?)(?:\/>|>([\s\S]*?)<\/table:(?:covered-)?table-cell>)/g;
      for (const cell of (row[1] ?? "").matchAll(cellRe)) {
        const value = xmlAttr(cell[1], "office:value") ?? decodeXmlText(cell[2] ?? "").trim();
        const repeat = Math.min(Number(xmlAttr(cell[1], "table:number-columns-repeated") ?? 1) || 1, 64);
        if (value !== "") for (let i = 0; i < repeat; i++) cells.push(value);
      }
      if (cells.length) lines.push(cells.join("\t"));
    }
    sheets.push({ sheet: xmlAttr(table[1], "table:name") ?? `Sheet${sheets.length + 1}`, text: lines.join("\n") });
  }
  return sheets;
}

function columnNumber(ref: string): number {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? "";
  return [...letters].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);
}

/** Tab-separated text of one XLSX worksheet (shared strings resolved, cells ordered by column). */
export function xlsxSheetToText(sheetXml: string, sharedStringsXml: string | undefined): string {
  const shared = [...(sharedStringsXml ?? "").matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((m) =>
    [...m[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => decodeXmlText(t[1])).join(""),
  );
  const lines: string[] = [];
  for (const row of sheetXml.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const cells: { col: number; value: string }[] = [];
    for (const cell of (row[1] ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const type = xmlAttr(cell[1], "t");
      const body = cell[2] ?? "";
      const raw = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
      let value: string;
      if (type === "s") value = shared[Number(raw)] ?? "";
      else if (type === "inlineStr") value = decodeXmlText(/<is>([\s\S]*?)<\/is>/.exec(body)?.[1] ?? "");
      else value = decodeXmlText(raw ?? "");
      if (value.trim() !== "") cells.push({ col: columnNumber(xmlAttr(cell[1], "r") ?? ""), value: value.trim() });
    }
    if (cells.length) lines.push(cells.sort((a, b) => a.col - b.col).map((c) => c.value).join("\t"));
  }
  return lines.join("\n");
}

interface ZipEntry {
  name: string;
  read(): Buffer;
}

function isZip(bytes: Buffer): boolean {
  return bytes.length >= 4 && bytes.readUInt32LE(0) === 0x04034b50;
}

/** Minimal zip reader (central directory; stored or deflated entries). */
export function readZipEntries(bytes: Buffer): ZipEntry[] {
  const corrupt = () => new WingValueError("The zip archive is corrupt or truncated.");
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (bytes.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw corrupt();
  const count = bytes.readUInt16LE(eocd + 10);
  let p = bytes.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (p + 46 > bytes.length || bytes.readUInt32LE(p) !== 0x02014b50) throw corrupt();
    const method = bytes.readUInt16LE(p + 10);
    const compressedSize = bytes.readUInt32LE(p + 20);
    const nameLength = bytes.readUInt16LE(p + 28);
    const extraLength = bytes.readUInt16LE(p + 30);
    const commentLength = bytes.readUInt16LE(p + 32);
    const localOffset = bytes.readUInt32LE(p + 42);
    const name = bytes.toString("utf8", p + 46, p + 46 + nameLength);
    p += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith("/")) continue;
    entries.push({
      name,
      read() {
        if (localOffset + 30 > bytes.length || bytes.readUInt32LE(localOffset) !== 0x04034b50) throw corrupt();
        const start = localOffset + 30 + bytes.readUInt16LE(localOffset + 26) + bytes.readUInt16LE(localOffset + 28);
        const data = bytes.subarray(start, start + compressedSize);
        if (data.length !== compressedSize) throw corrupt();
        if (method === 0) return data;
        if (method === 8) {
          try {
            return zlib.inflateRawSync(data, { maxOutputLength: MAX_INFLATED_BYTES });
          } catch {
            throw corrupt();
          }
        }
        throw new WingValueError(`"${name}" uses an unsupported zip compression method (${method}).`);
      },
    });
  }
  return entries;
}

function decodeText(bytes: Buffer): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString("utf16le");
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const swapped = Buffer.from(bytes.subarray(2));
    swapped.swap16();
    return swapped.toString("utf16le");
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return bytes.subarray(3).toString("utf8");
  return bytes.toString("utf8");
}

interface Found {
  file: string;
  points: CurvePoint[];
}

function parseAny(label: string, bytes: Buffer, depth: number, tried: string[]): Found[] {
  tried.push(label);
  if (isZip(bytes)) {
    const entries = readZipEntries(bytes);
    const byName = new Map(entries.map((e) => [e.name, e]));
    const mimetype = byName.get("mimetype")?.read().toString("utf8").trim() ?? "";
    const content = byName.get("content.xml");
    if (mimetype.startsWith("application/vnd.oasis.opendocument") && content) {
      const sheets = odsSheetsToText(content.read().toString("utf8"));
      return sheetsFound(label, sheets);
    }
    const sheetEntries = entries
      .filter((e) => /^xl\/worksheets\/sheet\d+\.xml$/.test(e.name))
      .sort((a, b) => Number(/\d+/.exec(a.name)![0]) - Number(/\d+/.exec(b.name)![0]));
    if (byName.has("xl/workbook.xml") && sheetEntries.length) {
      const shared = byName.get("xl/sharedStrings.xml")?.read().toString("utf8");
      const sheets = sheetEntries.map((e) => ({ sheet: path.posix.basename(e.name, ".xml"), text: xlsxSheetToText(e.read().toString("utf8"), shared) }));
      return sheetsFound(label, sheets);
    }
    if (depth >= MAX_ZIP_DEPTH) return [];
    const found: Found[] = [];
    for (const entry of entries) {
      const base = path.posix.basename(entry.name);
      const ext = path.posix.extname(base).toLowerCase();
      if (entry.name.startsWith("__MACOSX/") || base.startsWith(".") || IGNORED_NAMES.has(base.toLowerCase())) continue;
      if (ext && !TEXT_EXTENSIONS.has(ext) && !CONTAINER_EXTENSIONS.has(ext)) continue;
      found.push(...parseAny(entry.name, entry.read(), depth + 1, tried));
    }
    return found;
  }
  const text = decodeText(bytes);
  const points = parseCalibrationText(/^\s*\{\\rtf/.test(text) ? rtfToText(text) : text);
  return points ? [{ file: label, points }] : [];
}

function sheetsFound(label: string, sheets: { sheet: string; text: string }[]): Found[] {
  const found = sheets.flatMap((s) => {
    const points = parseCalibrationText(s.text);
    return points ? [{ sheet: s.sheet, points }] : [];
  });
  return found.map((f) => ({ file: found.length > 1 ? `${label} (${f.sheet})` : label, points: f.points }));
}

/**
 * Every distinct calibration curve found in an uploaded file (identical curves from several files of
 * the same archive are merged). Throws a WingValueError naming what was tried when none is found.
 */
export function parseCalibrationFile(fileName: string, bytes: Buffer): CalibrationCandidate[] {
  const tried: string[] = [];
  const found = parseAny(fileName, bytes, 0, tried);
  const candidates = new Map<string, CalibrationCandidate>();
  for (const f of found) {
    const key = JSON.stringify(f.points.map((p) => [p.hz, p.db]));
    const existing = candidates.get(key);
    if (existing) {
      existing.files.push(f.file);
      continue;
    }
    candidates.set(key, {
      files: [f.file],
      points: f.points,
      minHz: f.points[0].hz,
      maxHz: f.points[f.points.length - 1].hz,
      maxAbsDb: Math.max(...f.points.map((p) => Math.abs(p.db))),
    });
  }
  if (candidates.size === 0) {
    throw new WingValueError(
      `No calibration curve found in "${fileName}" (read: ${tried.join(", ")}). Expected at least ${MIN_POINTS} rows of ` +
        `"frequency dB" values — as txt/cal/frd/csv, rtf, ods or xlsx, or a zip of those.`,
    );
  }
  return [...candidates.values()];
}

/** Checks hand-entered points the same way file rows are checked, and sorts them. */
export function validateCalibrationPoints(points: readonly CurvePoint[], label = "Calibration curve"): CurvePoint[] {
  for (const p of points) {
    if (!(p.hz >= MIN_HZ && p.hz <= MAX_HZ) || !(Math.abs(p.db) <= MAX_ABS_DB)) {
      throw new WingValueError(`${label}: point ${JSON.stringify(p)} is out of range (${MIN_HZ}-${MAX_HZ} Hz, ±${MAX_ABS_DB} dB).`);
    }
  }
  if (points.length > MAX_POINTS) throw new WingValueError(`${label} has more than ${MAX_POINTS} points.`);
  const normalized = normalizePoints([...points]);
  if (!normalized) throw new WingValueError(`${label} needs at least ${MIN_POINTS} distinct frequencies.`);
  return normalized;
}

/**
 * The mic's deviation at each of the console's 120 RTA band centers, interpolated in log frequency
 * and held flat beyond the file's first/last point. Subtract it from the mic's RTA reading.
 */
export function calibrationRtaOffsetsDb(points: readonly CurvePoint[]): number[] {
  const sorted = [...points].sort((a, b) => a.hz - b.hz);
  return Array.from({ length: RTA_BAND_COUNT }, (_, i) => interpolateCurveDb(sorted, rtaBandCenterHz(i)));
}

/** A calibration curve as given to the save tool/route: explicit points, or an uploaded file's content. */
export type MicCurveInput =
  | { points: CurvePoint[]; sourceFiles?: string[] }
  | { fileName: string; content: string; encoding?: "text" | "base64"; candidate?: number };

/** Turns a curve input into stored form, parsing file content and picking `candidate` when a file holds several curves. */
export function resolveMicCurveInput(input: MicCurveInput, label: string): { sourceFiles: string[]; points: CurvePoint[] } {
  if ("points" in input) {
    return { sourceFiles: input.sourceFiles ?? [], points: validateCalibrationPoints(input.points, label) };
  }
  const bytes = input.encoding === "base64" ? Buffer.from(input.content, "base64") : Buffer.from(input.content, "utf8");
  const candidates = parseCalibrationFile(input.fileName, bytes);
  if (candidates.length > 1 && input.candidate === undefined) {
    throw new WingValueError(
      `${label}: "${input.fileName}" holds ${candidates.length} different curves — pass candidate: ` +
        candidates.map((c, i) => `${i} (${c.files.join(" + ")}, ${c.points.length} points)`).join(", ") +
        ".",
    );
  }
  const chosen = candidates[input.candidate ?? 0];
  if (!chosen) {
    throw new WingValueError(`${label}: candidate ${input.candidate} doesn't exist (0-${candidates.length - 1}).`);
  }
  return { sourceFiles: chosen.files, points: chosen.points };
}
