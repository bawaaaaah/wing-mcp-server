import { expect } from "chai";
import zlib from "node:zlib";
import { RTA_BAND_COUNT, rtaBandCenterHz } from "../../../src/plugins/wing/wing-eq-math.js";
import {
  calibrationRtaOffsetsDb,
  parseCalibrationFile,
  parseCalibrationText,
  resolveMicCurveInput,
  rtfToText,
  validateCalibrationPoints,
} from "../../../src/plugins/wing/wing-mic-calibration.js";

/** Minimal zip writer (no CRC — the reader doesn't check it). */
function makeZip(entries: { name: string; data: string | Buffer; deflate?: boolean }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, "utf8");
    const body = entry.deflate ? zlib.deflateRawSync(raw) : raw;
    const method = entry.deflate ? 8 : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const CURVE = [
  { hz: 20, db: -0.07 },
  { hz: 100.237, db: 0.493 },
  { hz: 997.064, db: 0 },
  { hz: 9038.47, db: 0.588 },
  { hz: 16144.8, db: -1.64 },
  { hz: 21999, db: -4.92 },
];

function odsContent(rows: string[]): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?><office:document-content><office:body><office:spreadsheet>' +
    `<table:table table:name="Sheet1">${rows.join("")}</table:table>` +
    '<table:table table:name="Sheet2"><table:table-row><table:table-cell/></table:table-row></table:table>' +
    "</office:spreadsheet></office:body></office:document-content>"
  );
}

const odsCell = (v: number) => `<table:table-cell office:value-type="float" office:value="${v}"><text:p>${v}</text:p></table:table-cell>`;

function makeOds(curve = CURVE): Buffer {
  const rows = [
    '<table:table-row><table:table-cell table:number-columns-repeated="2"/><table:table-cell office:value-type="string"><text:p>Hz</text:p></table:table-cell><table:table-cell office:value-type="string"><text:p>dB</text:p></table:table-cell></table:table-row>',
    ...curve.map((p) => `<table:table-row><table:table-cell table:number-columns-repeated="2"/>${odsCell(p.hz)}${odsCell(p.db)}${odsCell(12.3)}</table:table-row>`),
    '<table:table-row table:number-rows-repeated="1000"><table:table-cell table:number-columns-repeated="1024"/></table:table-row>',
  ];
  return makeZip([
    { name: "mimetype", data: "application/vnd.oasis.opendocument.spreadsheet" },
    { name: "content.xml", data: odsContent(rows), deflate: true },
  ]);
}

function makeRtf(curve = CURVE): string {
  const lines = curve.map((p) => `${p.hz.toFixed(4)} ${p.db} -10.`).join("\\line ");
  return (
    "{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0\\froman\\fprq2\\fcharset0 Times New Roman;}}" +
    "{\\*\\pgdsctbl{\\pgdsc0\\pgdscuse195\\pgwsxn12240 Default;}}\\pard\\plain \\s0\\fs24{\\rtlch \\ltrch\\loch\n" +
    "Hz, dB, phase\\line }{{\\*\\bkmkstart yui_3_5_1_1_1350597497016_373}{\\*\\bkmkend yui_3_5_1_1_1350597497016_373}" +
    `\\rtlch \\ltrch\\loch\n\\line ${lines}}\n\\par }`
  );
}

describe("wing-mic-calibration: file parsing", () => {
  it("reads REW-style text, skipping the sensitivity header, comments and the phase column", () => {
    const text = '"Sens Factor =-1.378dB, SERNO: 7000000"\n* Freq(Hz) SPL(dB) Phase(degrees)\n' + CURVE.map((p) => `${p.hz}\t${p.db}\t5.1`).join("\r\n");
    expect(parseCalibrationText(text)).to.deep.equal(CURVE);
  });

  it("reads comma, semicolon + decimal comma, and space + decimal comma CSV", () => {
    expect(parseCalibrationText("Frequency,dB\n" + CURVE.map((p) => `${p.hz}, ${p.db}`).join("\n"))).to.deep.equal(CURVE);
    const comma = (v: number) => String(v).replace(".", ",");
    expect(parseCalibrationText("Hz;dB\n" + CURVE.map((p) => `${comma(p.hz)};${comma(p.db)}`).join("\n"))).to.deep.equal(CURVE);
    expect(parseCalibrationText(CURVE.map((p) => `${comma(p.hz)} ${comma(p.db)}`).join("\n"))).to.deep.equal(CURVE);
  });

  it("sorts rows, drops duplicate frequencies and out-of-range rows, and needs 5 points", () => {
    const text = ["1000 0", "20 1", "20 2", "5000 -1", "200000 0", "500 94", "100 0.5", "10000 -2"].join("\n");
    expect(parseCalibrationText(text)).to.deep.equal([
      { hz: 20, db: 1 },
      { hz: 100, db: 0.5 },
      { hz: 1000, db: 0 },
      { hz: 5000, db: -1 },
      { hz: 10000, db: -2 },
    ]);
    expect(parseCalibrationText("20 0\n100 0\n1000 0\n10000 0")).to.equal(null);
  });

  it("reads the rows of an RTF document like Behringer's generic ECM8000 file", () => {
    expect(rtfToText("a\\line b\\par c")).to.equal("a\nb\nc");
    const [candidate] = parseCalibrationFile("Generic ECM8000 Calibration File.rtf", Buffer.from(makeRtf(), "latin1"));
    expect(candidate.points).to.deep.equal(CURVE);
    expect(candidate).to.include({ minHz: 20, maxHz: 21999, maxAbsDb: 4.92 });
  });

  it("reads an ODS spreadsheet (repeated empty cells, header row, empty second sheet)", () => {
    const [candidate] = parseCalibrationFile("ECM8000 Calibration File.ods", makeOds());
    expect(candidate.files).to.deep.equal(["ECM8000 Calibration File.ods"]);
    expect(candidate.points).to.deep.equal(CURVE);
  });

  it("reads an XLSX sheet with shared strings", () => {
    const sheet =
      '<worksheet><sheetData><row r="1"><c r="B1" t="s"><v>0</v></c><c r="A1" t="s"><v>1</v></c></row>' +
      CURVE.map((p, i) => `<row r="${i + 2}"><c r="B${i + 2}"><v>${p.db}</v></c><c r="A${i + 2}"><v>${p.hz}</v></c></row>`).join("") +
      "</sheetData></worksheet>";
    const xlsx = makeZip([
      { name: "xl/workbook.xml", data: "<workbook/>" },
      { name: "xl/sharedStrings.xml", data: "<sst><si><t>dB</t></si><si><t>Hz</t></si></sst>" },
      { name: "xl/worksheets/sheet1.xml", data: sheet, deflate: true },
    ]);
    expect(parseCalibrationFile("cal.xlsx", xlsx)[0].points).to.deep.equal(CURVE);
  });

  it("merges the same curve found in several files of a zip (ECM8000.zip: .ods + .rtf) and ignores desktop.ini", () => {
    const zip = makeZip([
      { name: "ECM8000/desktop.ini", data: "[.ShellClassInfo]\nIconIndex=12" },
      { name: "ECM8000/ECM8000 Calibration File.ods", data: makeOds(), deflate: true },
      { name: "ECM8000/Generic ECM8000 Calibration File.rtf", data: makeRtf(), deflate: true },
      { name: "ECM8000/manual.pdf", data: "%PDF-1.4 20 1\n100 1\n1000 1\n5000 1\n10000 1" },
    ]);
    const candidates = parseCalibrationFile("ECM8000.zip", zip);
    expect(candidates).to.have.length(1);
    expect(candidates[0].files).to.deep.equal(["ECM8000/ECM8000 Calibration File.ods", "ECM8000/Generic ECM8000 Calibration File.rtf"]);
    expect(candidates[0].points).to.deep.equal(CURVE);
  });

  it("returns one candidate per different curve (0° and 90° in the same zip)", () => {
    const deg90 = CURVE.map((p) => ({ hz: p.hz, db: p.db + (p.hz > 5000 ? 3 : 0) }));
    const zip = makeZip([
      { name: "__MACOSX/._mic_0.txt", data: CURVE.map((p) => `${p.hz} 9`).join("\n") },
      { name: "mic_0.txt", data: CURVE.map((p) => `${p.hz} ${p.db}`).join("\n") },
      { name: "mic_90.txt", data: deg90.map((p) => `${p.hz} ${p.db}`).join("\n"), deflate: true },
    ]);
    const candidates = parseCalibrationFile("mic.zip", zip);
    expect(candidates.map((c) => c.files)).to.deep.equal([["mic_0.txt"], ["mic_90.txt"]]);
    expect(() => resolveMicCurveInput({ fileName: "mic.zip", content: zip.toString("base64"), encoding: "base64" }, "curve0")).to.throw(
      /2 different curves — pass candidate: 0 \(mic_0.txt, 6 points\), 1 \(mic_90.txt, 6 points\)/,
    );
    const chosen = resolveMicCurveInput({ fileName: "mic.zip", content: zip.toString("base64"), encoding: "base64", candidate: 1 }, "curve90");
    expect(chosen).to.deep.equal({ sourceFiles: ["mic_90.txt"], points: deg90 });
  });

  it("decodes UTF-16 text files with a BOM", () => {
    const text = CURVE.map((p) => `${p.hz}\t${p.db}`).join("\r\n");
    const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
    expect(parseCalibrationFile("cal.txt", bytes)[0].points).to.deep.equal(CURVE);
  });

  it("names every file it read when no curve is found, and rejects a corrupt zip", () => {
    const zip = makeZip([{ name: "readme.txt", data: "Calibrated at 94 dB SPL, 1 kHz" }]);
    expect(() => parseCalibrationFile("stuff.zip", zip)).to.throw(/No calibration curve found in "stuff.zip" \(read: stuff.zip, readme.txt\)/);
    expect(() => parseCalibrationFile("broken.zip", zip.subarray(0, 40))).to.throw(/corrupt or truncated/);
  });

  it("validates hand-entered points", () => {
    expect(validateCalibrationPoints([...CURVE].reverse())).to.deep.equal(CURVE);
    expect(() => validateCalibrationPoints([{ hz: 0, db: 0 }, ...CURVE])).to.throw(/out of range/);
    expect(() => validateCalibrationPoints(CURVE.slice(0, 3))).to.throw(/at least 5/);
  });
});

describe("wing-mic-calibration: RTA offsets", () => {
  it("interpolates the curve at each RTA band in log frequency and holds the ends", () => {
    const offsets = calibrationRtaOffsetsDb([
      { hz: 100, db: 0 },
      { hz: 400, db: -2 },
      { hz: 1000, db: 0 },
      { hz: 4000, db: 2 },
      { hz: 16000, db: -4 },
    ]);
    expect(offsets).to.have.length(RTA_BAND_COUNT);
    expect(offsets[0]).to.equal(0);
    expect(offsets[RTA_BAND_COUNT - 1]).to.equal(-4);
    const i200 = offsets.findIndex((_, i) => rtaBandCenterHz(i) > 200) - 1;
    const hz = rtaBandCenterHz(i200);
    expect(offsets[i200]).to.be.closeTo((-2 * Math.log(hz / 100)) / Math.log(4), 1e-9);
  });
});
