import { expect } from "chai";
import type { PatchData, InputPatchRow, OutputPatchRow, SourceListEntry, UserSignal } from "../../../src/plugins/wing/wing-patch.js";
import { findDeviceSpec } from "../../../src/plugins/wing/patch-sheet/device-catalog.js";
import { buildPatchSheet, cellLines } from "../../../src/plugins/wing/patch-sheet/patch-model.js";
import { buildTablePages } from "../../../src/plugins/wing/patch-sheet/render-table.js";
import { pdfSafe, writeTablePdf } from "../../../src/plugins/wing/patch-sheet/pdf-writer.js";

function src(group: string, index: number, name: string, extra: Partial<SourceListEntry> = {}): SourceListEntry {
  return { group, index, name, col: 1, colorName: undefined, icon: 0, iconName: undefined, mode: "M", gain: null, phantom48v: null, mute: null, polarityInverted: null, box: null, ...extra } as SourceListEntry;
}
function chan(index: number, ownName: string, group: string, srcIndex: number, extra: Record<string, unknown> = {}): InputPatchRow {
  return {
    strip: "ch", index, effectiveName: ownName, ownName, nameLinkedToSource: false,
    source: { group, index: srcIndex, storedIndex: srcIndex, stereo: false, mode: "M", label: `${group}${srcIndex}`, sourceName: null, phantom48v: null, gain: null, ...extra },
    altSource: null,
  } as InputPatchRow;
}

const data: PatchData = {
  boxMap: {
    A: [
      { range: [9, 16], device: "DL8-2", model: "Midas DL8" },
      { range: [33, 48], device: "DN4816U", model: "Klark Teknik DN4816U" },
      { range: [33, 48], device: "P16-M", model: "P16-M", via: "DN4816U" },
    ],
  },
  sources: [
    src("A", 9, "Drums L", { mode: "ST", pair: [9, 10] }),
    src("A", 10, "Drums R", { mode: "ST", pair: [9, 10] }),
    src("A", 11, "GTR"),
    src("LCL", 24, "KSM9"),
  ],
  inputs: [
    chan(5, "Drums", "A", 9, { stereo: true, mode: "ST", pair: [9, 10] }),
    chan(6, "Guitare A", "A", 11),
    // Through a user patch: USR 25 -> LCL 24.
    chan(7, "TB Samuel", "USR", 25),
  ],
  userSignals: [
    { index: 25, range: "patch", name: "", col: 1, colorName: undefined, icon: 0, iconName: undefined, mode: "M", mute: false, polarityInverted: false, link: { kind: "source", group: "LCL", index: 24 } } as UserSignal,
    { index: 1, range: "signal", name: "Morgane", col: 1, colorName: undefined, icon: 0, iconName: undefined, mode: "M", mute: false, polarityInverted: false, link: { kind: "strip", group: "CH", index: 1, targetName: "Morgane" } } as UserSignal,
  ],
  outputs: [
    { group: "A", port: 9, box: null, signal: { kind: "tap", group: "BUS", rawIn: 7, strip: "bus", stripIndex: 4, side: "L", stripName: "IEM Karina" } },
    { group: "A", port: 10, box: null, signal: { kind: "tap", group: "BUS", rawIn: 8, strip: "bus", stripIndex: 4, side: "R", stripName: "IEM Karina" } },
    { group: "A", port: 33, box: null, signal: { kind: "source", group: "USR", rawIn: 1, sourceName: "Morgane", mode: "M", label: "USR1" } },
  ] as OutputPatchRow[],
};

describe("patch sheet", () => {
  it("matches the phase-1 devices and falls back to a generic one", () => {
    expect(findDeviceSpec("DL8-2", "Midas DL8", 8).id).to.equal("midas-dl8");
    expect(findDeviceSpec("DN4816U", undefined, 16).id).to.equal("klark-teknik-dn4816u");
    expect(findDeviceSpec("x", "Behringer P16-M", 16).id).to.equal("behringer-p16m");
    const g = findDeviceSpec("Truc", "Machin", 12);
    expect(g.id).to.equal("generic");
    expect(g.ins).to.equal(12);
  });

  const model = buildPatchSheet(data);
  const dl8 = model.boxes.find((b) => b.device === "DL8-2")!;

  it("folds a stereo input into one two-wide cell carrying its channels", () => {
    const drums = dl8.inputs.find((c) => c.port === 1)!;
    expect(drums.span).to.equal(2);
    expect(drums.channelNames).to.deep.equal(["Drums"]);
    expect(dl8.inputs.find((c) => c.port === 2)).to.equal(undefined);
    expect(dl8.inputs.find((c) => c.port === 3)!.channelNames).to.deep.equal(["Guitare A"]);
  });

  it("merges an L/R bus output pair and fills unpatched outputs as free", () => {
    const iem = dl8.outputs.find((c) => c.port === 1)!;
    expect(iem.span).to.equal(2);
    expect(iem.patch).to.equal("Bus 4 · L/R");
    expect(dl8.outputs.find((c) => c.port === 3)!.used).to.equal(false);
  });

  it("follows user patches and lists non-box sources", () => {
    expect(model.consoleSources).to.deep.equal([{ label: "LCL 24", name: "KSM9", channelNames: ["TB Samuel"] }]);
  });

  it("hangs the P16-M off the converter's outputs only", () => {
    const p16 = model.boxes.find((b) => b.device === "P16-M")!;
    expect(p16.inputs).to.have.length(0);
    expect(p16.outputs.find((c) => c.port === 1)!.outputName).to.equal("Morgane");
  });

  it("labels cells per naming mode", () => {
    const cell = dl8.inputs.find((c) => c.port === 3)!;
    const named = { ...cell, inputName: "GTR" };
    expect(cellLines(named, "io")).to.deep.equal(["GTR"]);
    expect(cellLines(named, "channel")).to.deep.equal(["Guitare A"]);
    expect(cellLines({ ...named, channelNames: [] }, "channel")).to.deep.equal(["GTR"]);
    const out = { port: 1, span: 1, channelNames: ["IEM Karina"], outputName: "Bus 4", used: true };
    expect(cellLines(out, "full")).to.deep.equal(["IEM Karina", "Bus 4"]);
    expect(cellLines({ port: 1, span: 1, channelNames: [], used: false }, "io")).to.deep.equal(["libre"]);
  });

  it("builds table pages: overview + one per box, with naming columns", () => {
    const pages = buildTablePages(model, "full");
    expect(pages).to.have.length(1 + model.boxes.length);
    expect(pages[1]!.sections[0]!.columns).to.deep.equal(["Port", "Patch", "Mode", "Entrée", "Channel", "Sortie"]);
  });

  it("writes a PDF with at least one page per table page (a 16+16 box spills onto a second one)", async () => {
    const pdf = await writeTablePdf(buildTablePages(model, "channel"), { date: new Date("2026-09-25T00:00:00Z"), footer: "Patch plateau" });
    expect(pdf.subarray(0, 5).toString()).to.equal("%PDF-");
    expect((pdf.toString("latin1").match(/\/Type \/Page\b/g) ?? []).length).to.be.at.least(1 + model.boxes.length);
  });

  it("replaces characters Helvetica cannot print", () => {
    expect(pdfSafe("A → B · é")).to.equal("A -> B · é");
    expect(pdfSafe("日本")).to.equal("??");
  });
});
