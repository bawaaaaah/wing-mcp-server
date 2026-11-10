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

  describe("P16-M feed", () => {
    const usr = (n: number, name: string): OutputPatchRow => ({ group: "A", port: n, box: null, signal: { kind: "source", group: "USR", rawIn: n, sourceName: name, mode: "M", label: `USR${n}` } });
    const feedData = (boxes: PatchData["boxMap"]): PatchData => ({ ...data, boxMap: boxes, outputs: [usr(1, "Un"), usr(33, "T33"), usr(48, "T48"), usr(40, "Quarante")] });
    const p16 = (m: ReturnType<typeof buildPatchSheet>, device: string) => m.boxes.find((b) => b.device === device)!;

    it("plays tracks 33-48 of a DL16 host by default", () => {
      const m = buildPatchSheet(feedData({ A: [{ range: [1, 16], device: "DL16", model: "Midas DL16" }, { range: [1, 1], device: "P16-M", model: "P16-M", via: "DL16" }] }));
      const box = p16(m, "P16-M");
      expect(box.link).to.equal("A 33-48");
      expect(box.outputs.find((c) => c.port === 1)!.outputName).to.equal("T33");
      expect(box.outputs.find((c) => c.port === 16)!.outputName).to.equal("T48");
      expect(box.outputs.find((c) => c.port === 8)!.outputName).to.equal("Quarante");
    });

    it("plays the first 16 ports of a DN4816U host by default", () => {
      const m = buildPatchSheet(feedData({ A: [{ range: [1, 16], device: "DN4816U", model: "Klark Teknik DN4816U" }, { range: [1, 1], device: "P16-M", model: "P16-M", via: "DN4816U" }] }));
      expect(p16(m, "P16-M").outputs.find((c) => c.port === 1)!.outputName).to.equal("Un");
    });

    it("plays tracks 33-48 of a HUB-4 by default, and the hub gets no page", () => {
      const m = buildPatchSheet(feedData({ A: [{ range: [1, 16], device: "HUB-4", model: "Behringer HUB4" }, { range: [1, 1], device: "P16-M", model: "P16-M", via: "HUB-4" }] }));
      expect(p16(m, "P16-M").link).to.equal("A 33-48");
      expect(p16(m, "P16-M").outputs.find((c) => c.port === 1)!.outputName).to.equal("T33");
      const titles = buildTablePages(m, "channel").map((pg) => pg.title);
      expect(titles).to.deep.equal(["Patch plateau", "P16-M"]);
    });

    it("lets each P16 name its own tracks", () => {
      const m = buildPatchSheet(feedData({
        A: [
          { range: [1, 16], device: "DL16", model: "Midas DL16" },
          { range: [1, 1], device: "P16 gauche", model: "P16-M", via: "DL16", feed: { range: [33, 48] } },
          { range: [1, 1], device: "P16 droite", model: "P16-M", via: "DL16", feed: { range: [1, 16] } },
        ],
      }));
      expect(p16(m, "P16 gauche").outputs.find((c) => c.port === 1)!.outputName).to.equal("T33");
      expect(p16(m, "P16 droite").outputs.find((c) => c.port === 1)!.outputName).to.equal("Un");
    });
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

import { writeVisualPdf } from "../../../src/plugins/wing/patch-sheet/render-visual.js";
describe("patch sheet — visual", () => {
  it("draws an overview plus one page per box (hubs get none)", async () => {
    const m = buildPatchSheet({ ...data, boxMap: { A: [{ range: [1, 8], device: "DL8-1", model: "Midas DL8" }, { range: [33, 48], device: "HUB-4", model: "Behringer HUB4" }, { range: [1, 1], device: "P16-M", model: "P16-M", via: "HUB-4" }] } });
    for (const naming of ["io", "channel", "full"] as const) {
      const pdf = await writeVisualPdf(m, naming, { date: new Date("2026-09-25T00:00:00Z"), title: "Patch plateau", footer: "x" });
      expect(pdf.subarray(0, 5).toString()).to.equal("%PDF-");
      expect((pdf.toString("latin1").match(/\/Type \/Page\b/g) ?? []).length).to.equal(3);
    }
  });
});
