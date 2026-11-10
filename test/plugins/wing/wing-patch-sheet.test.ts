import { expect } from "chai";
import type { PatchData, InputPatchRow, OutputPatchRow, SourceListEntry, UserSignal } from "../../../src/plugins/wing/wing-patch.js";
import { findDeviceSpec } from "../../../src/plugins/wing/patch-sheet/device-catalog.js";
import { buildPatchSheet, cellLines, coveringCell } from "../../../src/plugins/wing/patch-sheet/patch-model.js";
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
    expect(findDeviceSpec("Rack scène", "Behringer X32 Rack", 16).id).to.equal("behringer-x32-rack");
    expect(findDeviceSpec("Local", "Behringer WING Rack", 24).ins).to.equal(24);
    expect(findDeviceSpec("Local", "Behringer WING Compact", 24).id).to.equal("behringer-wing-compact");
    expect(findDeviceSpec("Scène", "Behringer S16", 16).ins).to.equal(16);
    expect(findDeviceSpec("Scène", "Behringer S32", 32).outs).to.equal(16);
    expect(findDeviceSpec("DL16 jardin", "Midas DL16", 16).id).to.equal("midas-dl16");
    expect(findDeviceSpec("Local", "Behringer WING Full", 8).id).to.equal("behringer-wing-full");
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
    expect(model.consoleSources).to.deep.equal([{ label: "LOCAL IN 24", name: "KSM9", channelNames: ["TB Samuel"] }]);
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

    it("plays tracks 33-48 on an S16, S32 or X32 host too", () => {
      for (const [hostModel, n] of [["Behringer S16", 16], ["Behringer S32", 32], ["Behringer X32 Rack", 16]] as const) {
        const sheet = buildPatchSheet(feedData({ B: [{ range: [1, n], device: "Scène", model: hostModel }, { range: [1, 1], device: "P16-M", model: "P16-M", via: "Scène" }] }));
        expect(p16(sheet, "P16-M").link, hostModel).to.equal("B 33-48");
      }
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
      expect(titles).to.deep.equal(["Patch plateau", "HUB-4", "P16-M"]);
    });

    it("plays the tracks of its host's own group (a DN4816U on StageConnect plays SC 1-16)", () => {
      const m = buildPatchSheet({
        ...data,
        boxMap: { SC: [{ range: [1, 16], device: "DN4816U", model: "Klark Teknik DN4816U" }], A: [{ range: [1, 1], device: "P16-M", model: "P16-M", via: "DN4816U" }] },
        outputs: [{ group: "SC", port: 1, box: null, signal: { kind: "source", group: "C", rawIn: 1, sourceName: "Lead", mode: "M", label: "C1" } }],
      });
      const box = m.boxes.find((b) => b.device === "P16-M")!;
      expect(box.link).to.equal("SC 1-16");
      expect(box.outputs.find((c) => c.port === 1)!.outputName).to.equal("Lead");
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

  it("places DL8s under a HUB4 and labels its 33-48 outputs by port", () => {
    const m = buildPatchSheet({
      ...data,
      boxMap: {
        A: [
          { range: [1, 8], device: "DL8-1", model: "Midas DL8", hub: "HUB4" },
          { range: [9, 16], device: "DL8-2", model: "Midas DL8", hub: "HUB4" },
          { range: [33, 48], device: "HUB4", model: "Midas HUB4" },
        ],
      },
      outputs: [{ group: "A", port: 33, box: null, signal: { kind: "tap", group: "BUS", rawIn: 1, strip: "bus", stripIndex: 1, side: "L", stripName: "IEM" } }],
    });
    const hub = m.boxes.find((b) => b.device === "HUB4")!;
    expect(hub.spec.kind).to.equal("hub");
    expect(hub.outputs).to.have.length(16);
    expect(hub.outputs.find((c) => c.port === 5)!.patch).to.equal("P2 MIX A-L · A37");
    expect(m.boxes.find((b) => b.device === "DL8-2")!.hub).to.equal("HUB4");
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
  it("draws a 32-input box in rows of 16 and a 24-input one in rows of 8", async () => {
    for (const [model, n, outs] of [["Behringer S32", 32, 16], ["Behringer WING Rack", 24, 8]] as const) {
      const m = buildPatchSheet({ ...data, boxMap: { A: [{ range: [1, n], device: "Scène", model }] }, outputs: [], sources: [], inputs: [], userSignals: [] });
      expect(m.boxes[0]!.inputs).to.have.length(n);
      expect(m.boxes[0]!.outputs).to.have.length(outs);
      const pdf = await writeVisualPdf(m, "full", { date: new Date("2026-09-25T00:00:00Z"), title: "t", footer: "x" });
      expect(pdf.subarray(0, 5).toString()).to.equal("%PDF-");
    }
  });

  it("draws an overview plus one page per box, hubs included", async () => {
    const m = buildPatchSheet({ ...data, boxMap: { A: [{ range: [1, 8], device: "DL8-1", model: "Midas DL8" }, { range: [33, 48], device: "HUB-4", model: "Behringer HUB4" }, { range: [1, 1], device: "P16-M", model: "P16-M", via: "HUB-4" }] } });
    for (const naming of ["io", "channel", "full"] as const) {
      const pdf = await writeVisualPdf(m, naming, { date: new Date("2026-09-25T00:00:00Z"), title: "Patch plateau", footer: "x" });
      expect(pdf.subarray(0, 5).toString()).to.equal("%PDF-");
      expect((pdf.toString("latin1").match(/\/Type \/Page\b/g) ?? []).length).to.equal(5);
    }
  });
});

import { buildBoxMapFromLinks, layoutLinkDevices } from "../../../src/plugins/wing/patch-sheet/detect-box-map.js";
describe("patch sheet — detection and cards", () => {
  const links = (a: string, b = "", sc = "") => ({
    ports: [
      { port: "A", state: a ? "OK" : "-", device: a, errorsCorrected: 0, errorsUncorrected: 0, remoteName: a ? "HUB4" : "" },
      { port: "B", state: b ? "OK" : "-", device: b, errorsCorrected: 0, errorsUncorrected: 0, remoteName: "" },
      { port: "C", state: "-", device: "", errorsCorrected: 0, errorsUncorrected: 0, remoteName: "" },
    ] as never,
    stageConnect: { status: sc ? "OK" : "-", devices: sc, upstreamCount: 0, downstreamCount: 0 },
  });

  it("describes the console's own ports from its model", () => {
    expect(buildBoxMapFromLinks("wing-rack", links("")).boxMap.LCL).to.deep.equal([{ range: [1, 24], device: "Local", model: "Behringer WING Rack" }]);
    expect(buildBoxMapFromLinks("wing-compact", links("")).boxMap.LCL![0]!.model).to.equal("Behringer WING Compact");
  });

  it("lays out a HUB4 with its DL8 and an S16 on another port", () => {
    const { boxMap } = buildBoxMapFromLinks("wing-rack", links("HUB4,DL8", "S16"));
    expect(boxMap.A).to.deep.equal([
      { range: [33, 48], device: "HUB4", model: "Midas HUB4" },
      { range: [1, 8], device: "DL8", model: "Midas DL8", hub: "HUB4" },
    ]);
    expect(boxMap.B).to.deep.equal([{ range: [1, 16], device: "S16", model: "Behringer S16" }]);
  });

  it("lists two DL8 on a HUB4 and the DN4816U on StageConnect, as the console reports them", () => {
    const { boxMap, notes } = buildBoxMapFromLinks("wing-rack", links("HUB4,DL8,DL8", "S16", "DN4816U"));
    expect(boxMap.A!.map((b) => `${b.device}:${b.range[0]}-${b.range[1]}`)).to.deep.equal(["HUB4:33-48", "DL8-1:1-8", "DL8-2:9-16"]);
    expect(boxMap.SC).to.deep.equal([{ range: [1, 16], device: "DN4816U", model: "Klark Teknik DN4816U" }]);
    expect(notes.some((n) => n.includes("P16-M"))).to.equal(true);
  });

  it("numbers repeated models and flags unknown ones and overflow", () => {
    const notes: string[] = [];
    const boxes = layoutLinkDevices("A", "DL8,DL8,Machin,S32", notes);
    expect(boxes.map((b) => b.device)).to.deep.equal(["DL8-1", "DL8-2", "Machin"]);
    expect(notes.some((n) => n.includes("unknown device"))).to.equal(true);
    expect(notes.some((n) => n.includes("does not fit"))).to.equal(true);
  });

  it("treats WING-LIVE and unknown devices on CRD/MOD as cards listing only used channels", () => {
    const m = buildPatchSheet({
      ...data,
      boxMap: { CRD: [{ range: [1, 64], device: "WING-LIVE" }], MOD: [{ range: [1, 64], device: "Carte X" }] },
      sources: [{ group: "CRD", index: 3, name: "Piste 3", mode: "M", colorName: undefined, phantom48v: false } as never],
      outputs: [],
    });
    expect(m.boxes.map((b) => b.spec.kind)).to.deep.equal(["card", "card"]);
    expect(m.boxes[0]!.inputs).to.have.length(64);
    const pages = buildTablePages(m, "io");
    expect(pages[1]!.sections[0]!.rows).to.have.length(1);
  });
});

describe("patch sheet — DN4816U on a hub's StageConnect", () => {
  const m = buildPatchSheet({
    ...data,
    boxMap: {
      A: [
        { range: [1, 8], device: "DL8", model: "Midas DL8", hub: "HUB4" },
        { range: [33, 48], device: "HUB4", model: "Midas HUB4" },
        { range: [33, 48], device: "DN4816U", model: "Klark Teknik DN4816U", hub: "HUB4" },
        { range: [1, 1], device: "P16-M", model: "P16-M", via: "DN4816U" },
      ],
    },
    outputs: [{ group: "A", port: 33, box: null, signal: { kind: "source", group: "USR", rawIn: 1, sourceName: "Lead", mode: "M", label: "USR1" } }],
    sources: [{ group: "A", index: 33, name: "Piano L", mode: "M", colorName: undefined, phantom48v: false } as never],
    inputs: [],
    userSignals: [],
  });

  it("numbers the DN4816U's tracks from A33 and has the P16 play A 33-48 by default", () => {
    const dn = m.boxes.find((b) => b.device === "DN4816U")!;
    expect(dn.hub).to.equal("HUB4");
    expect(dn.inputs[0]!.port).to.equal(1);
    expect(dn.inputs[0]!.patch).to.equal("A33");
    expect(dn.outputs.find((c) => c.port === 1)!.outputName).to.equal("Lead");
    const p16 = m.boxes.find((b) => b.device === "P16-M")!;
    expect(p16.link).to.equal("A 33-48");
    expect(p16.outputs.find((c) => c.port === 1)!.outputName).to.equal("Lead");
  });

  it("says StageConnect in the overview table", () => {
    const overview = buildTablePages(m, "io")[0]!;
    const row = overview.sections[0]!.rows.find((r) => r[0]!.startsWith("DN4816U"))!;
    expect(row[1]).to.contain("StageConnect de HUB4");
  });
});


describe("patch sheet — console ports", () => {
  const m = buildPatchSheet({
    ...data,
    boxMap: {
      A: [
        { range: [1, 8], device: "DL8-1", model: "Midas DL8", hub: "HUB4" },
        { range: [9, 16], device: "DL8-2", model: "Midas DL8", hub: "HUB4" },
        { range: [33, 48], device: "HUB4", model: "Midas HUB4" },
        { range: [33, 48], device: "DN4816U", model: "Klark Teknik DN4816U", hub: "HUB4" },
        { range: [1, 1], device: "P16-M", model: "P16-M", via: "DN4816U" },
      ],
      B: [{ range: [1, 16], device: "S16", model: "Behringer S16" }],
      LCL: [{ range: [1, 24], device: "Local", model: "Behringer WING Rack" }],
    },
    outputs: [],
    sources: [],
    inputs: [],
    userSignals: [],
  });
  const port = (g: string) => m.consolePorts.find((p) => p.group === g)!;

  it("lists what is plugged into each port, hubs and converters with their children", () => {
    expect(port("A").lines.map((l) => `${l.indent}${l.name}:${l.detail}`)).to.deep.equal([
      "0HUB4:A 33-48",
      "1DL8-1:port 1",
      "1DL8-2:port 2",
      "1DN4816U:StageConnect",
      "2P16-M:Ultranet",
    ]);
    expect(port("B").lines.map((l) => l.name)).to.deep.equal(["S16"]);
  });

  it("always has the AES50 links and StageConnect, empty when nothing is plugged in", () => {
    expect(port("C").lines).to.have.length(0);
    expect(port("SC").lines).to.have.length(0);
    expect(m.consolePorts.map((p) => p.group)).to.deep.equal(["LCL", "A", "B", "C", "SC"]);
  });

  it("adds a ports section to the table overview", () => {
    const sec = buildTablePages(m, "io")[0]!.sections.find((s) => s.heading === "PORTS DE LA CONSOLE")!;
    expect(sec.rows[1]![0]).to.equal("AES50 A");
    expect(sec.rows[1]![1]).to.contain("HUB4");
  });
});


describe("patch sheet — box sizes", () => {
  const sized = (model: string, range: [number, number], others: PatchData["boxMap"][string] = []) =>
    buildPatchSheet({ ...data, boxMap: { B: [{ range, device: "Scène", model }, ...others] }, sources: [], inputs: [], outputs: [], userSignals: [] }).boxes[0]!;

  it("gives a DL16 or S16 saved with a short range its 16 inputs and 8 outputs", () => {
    for (const model of ["Midas DL16", "Behringer S16"]) {
      const b = sized(model, [1, 8]);
      expect(b.inputs, model).to.have.length(16);
      expect(b.outputs, model).to.have.length(8);
      expect(b.link).to.equal("B 1-16");
    }
  });

  it("has 32 inputs and 16 outputs on an S32 and a DL32", () => {
    for (const model of ["Behringer S32", "Midas DL32"]) {
      const b = sized(model, [1, 32]);
      expect(b.inputs, model).to.have.length(32);
      expect(b.outputs, model).to.have.length(16);
    }
  });

  it("does not take ports another box sits on", () => {
    const b = sized("Midas DL16", [1, 8], [{ range: [9, 16], device: "Autre", model: "Midas DL8" }]);
    expect(b.inputs).to.have.length(8);
  });
});


describe("patch sheet — English", () => {
  const m = buildPatchSheet(data);

  it("prints the words in English, names untouched", () => {
    const pages = buildTablePages(m, "full", undefined, "en");
    expect(pages[0]!.title).to.equal("Stage patch");
    expect(pages[0]!.sections[0]!.heading).to.equal("BOXES");
    expect(pages[0]!.sections[0]!.columns).to.deep.equal(["Box", "Link", "Inputs used", "Outputs used"]);
    const dl8 = pages.find((p) => p.title === "DL8-2")!;
    expect(dl8.sections[0]!.heading).to.equal("INPUTS (box -> console)");
    expect(dl8.sections[0]!.columns).to.deep.equal(["Port", "Patch", "Mode", "Input", "Channel", "Output"]);
    expect(dl8.subtitle).to.contain("combo XLR/jack inputs");
    expect(dl8.sections[0]!.rows.flat()).to.include("free");
  });

  it("stays French by default", () => {
    const pages = buildTablePages(m, "full");
    expect(pages[0]!.sections[0]!.heading).to.equal("BOITIERS");
    expect(cellLines({ port: 1, span: 1, channelNames: [], used: false }, "io")).to.deep.equal(["libre"]);
    expect(cellLines({ port: 1, span: 1, channelNames: [], used: false }, "io", "free")).to.deep.equal(["free"]);
  });

  it("writes English PDFs in both layouts", async () => {
    for (const lang of ["en", "fr"] as const) {
      const table = await writeTablePdf(buildTablePages(m, "channel", undefined, lang), { date: new Date("2026-09-25T00:00:00Z"), footer: "x", lang });
      const visual = await writeVisualPdf(m, "channel", { date: new Date("2026-09-25T00:00:00Z"), title: "t", footer: "x", lang });
      expect(table.subarray(0, 5).toString()).to.equal("%PDF-");
      expect(visual.subarray(0, 5).toString()).to.equal("%PDF-");
    }
  });
});


import { validateBoxMap, GROUP_PORT_LIMIT } from "../../../src/plugins/wing/patch-sheet/box-map-validation.js";
describe("box map validation", () => {
  it("accepts a sound map, short ranges included", () => {
    expect(validateBoxMap({ A: [{ range: [1, 8], device: "DL8", model: "Midas DL8" }, { range: [1, 8], device: "DL16", model: "Midas DL16" }], CRD: [{ range: [1, 64], device: "WING-LIVE" }] })).to.deep.equal([]);
  });

  it("refuses a range beyond its group", () => {
    expect(validateBoxMap({ CRD: [{ range: [1, 100], device: "WING-LIVE" }] }).join(" ")).to.contain("group CRD has 64 ports");
    expect(validateBoxMap({ A: [{ range: [40, 60], device: "X", model: "Truc" }] }).join(" ")).to.contain("group A has 48 ports");
    expect(GROUP_PORT_LIMIT.SC).to.equal(32);
  });

  it("refuses more channels than the model has", () => {
    expect(validateBoxMap({ A: [{ range: [1, 12], device: "DL8", model: "Midas DL8" }] }).join(" ")).to.contain("has 8 channels, not 12");
    expect(validateBoxMap({ CRD: [{ range: [1, 64], device: "Dante", model: "WING-DANTE" }] })).to.deep.equal([]);
  });

  it("refuses two boxes with the same name and a link to a name that is not there", () => {
    const twice = validateBoxMap({ A: [{ range: [33, 48], device: "DN4816U", model: "Klark Teknik DN4816U" }], SC: [{ range: [1, 16], device: "DN4816U", model: "Klark Teknik DN4816U" }] });
    expect(twice.join(" ")).to.contain('The name "DN4816U" is used by 2 boxes');
    const lost = validateBoxMap({ A: [{ range: [1, 1], device: "P16", model: "P16-M", via: "DN-9" }] });
    expect(lost.join(" ")).to.contain('plugged into "DN-9"');
  });

  it("accepts a P16 on a DN4816U on StageConnect next to one on the hub", () => {
    expect(validateBoxMap({
      A: [{ range: [33, 48], device: "HUB-4", model: "Midas HUB4" }, { range: [33, 48], device: "DN-hub", model: "Klark Teknik DN4816U", hub: "HUB-4" }, { range: [1, 1], device: "P16", model: "P16-M", via: "DN-hub" }],
      SC: [{ range: [1, 16], device: "DN-local", model: "Klark Teknik DN4816U" }, { range: [1, 1], device: "P16 2", model: "P16-M", via: "DN-local" }],
    })).to.deep.equal([]);
  });

  it("refuses a feed beyond 16 tracks or its group", () => {
    expect(validateBoxMap({ A: [{ range: [1, 1], device: "P16", model: "P16-M", via: "DN", feed: { range: [30, 48] } }] }).join(" ")).to.contain("at most 16");
    expect(validateBoxMap({ SC: [{ range: [1, 1], device: "P16", model: "P16-M", via: "DN", feed: { range: [33, 48] } }] }).join(" ")).to.contain("group SC has 32 ports");
  });
});


describe("patch sheet — stereo outputs and colours", () => {
  const bus = (port: number, side: "L" | "R", idx: number, name: string, col: number): OutputPatchRow => ({
    group: "A", port, box: null, signal: { kind: "tap", group: "BUS", rawIn: port, strip: "bus", stripIndex: idx, side, stripName: name, col },
  });
  const m = buildPatchSheet({
    ...data,
    boxMap: { A: [{ range: [1, 16], device: "DL16", model: "Midas DL16" }, { range: [1, 1], device: "P16", model: "P16-M", via: "DL16", feed: { range: [33, 48] } }] },
    outputs: [bus(33, "L", 13, "Chor", 12), bus(34, "R", 13, "Chor", 12), bus(35, "L", 14, "Chor Reverb", 11), bus(36, "R", 14, "Chor Reverb", 11)],
    sources: [], inputs: [], userSignals: [],
  });
  const p16 = m.boxes.find((b) => b.device === "P16")!;

  it("takes the colour of the tapped strip, not a role colour", () => {
    expect(p16.outputs[0]!.color).to.equal("#a533ff"); // 12 = Purple
    expect(p16.outputs[1]!.color).to.equal("#ff33f6"); // 11 = Magenta
  });

  it("finds the cell covering both slots of a stereo pair", () => {
    expect(coveringCell(p16.outputs, 1)!.channelNames).to.deep.equal(["Chor"]);
    expect(coveringCell(p16.outputs, 2)).to.equal(coveringCell(p16.outputs, 1));
    expect(coveringCell(p16.outputs, 3)!.channelNames).to.deep.equal(["Chor Reverb"]);
    expect(coveringCell(p16.outputs, 5)!.used).to.equal(false);
  });
});


describe("patch sheet — two P16-M on two DN4816U", () => {
  const out = (group: string, port: number, name: string): OutputPatchRow => ({ group, port, box: null, signal: { kind: "source", group: "USR", rawIn: port, sourceName: name, mode: "M", label: `USR${port}` } });
  const m = buildPatchSheet({
    ...data,
    boxMap: {
      A: [{ range: [33, 48], device: "HUB-4", model: "Midas HUB4" }, { range: [33, 48], device: "DN-hub", model: "Klark Teknik DN4816U", hub: "HUB-4" }, { range: [1, 1], device: "P16", model: "P16-M", via: "DN-hub" }],
      SC: [{ range: [1, 16], device: "DN-local", model: "Klark Teknik DN4816U" }, { range: [1, 1], device: "P16 2", model: "P16-M", via: "DN-local" }],
    },
    outputs: [out("A", 33, "Lead"), out("A", 34, "Chor"), out("SC", 1, "Lead"), out("SC", 2, "Chor")],
    sources: [], inputs: [], userSignals: [],
  });

  it("gives each P16 the 16 return signals of its own converter", () => {
    const p = (n: string) => m.boxes.find((b) => b.device === n)!;
    expect(p("P16").link).to.equal("A 33-48");
    expect(p("P16 2").link).to.equal("SC 1-16");
    expect(p("P16").outputs.map((c) => c.outputName).slice(0, 2)).to.deep.equal(["Lead", "Chor"]);
    expect(p("P16 2").outputs.map((c) => c.outputName).slice(0, 2)).to.deep.equal(["Lead", "Chor"]);
  });
});

import { normalizeBoxMap, normalizeGroupKey, stableStringify } from "../../../src/plugins/wing/patch-sheet/box-map-validation.js";
describe("review fixes — normalisation, naming, stereo and text", () => {
  it("writes group aliases one way", () => {
    expect(normalizeGroupKey("AES50-a")).to.equal("A");
    expect(normalizeGroupKey("StageConnect")).to.equal("SC");
    expect(normalizeGroupKey("stage-connect")).to.equal("SC");
    const map = normalizeBoxMap({ "AES50-A": [{ range: [1, 8], device: "DL8-1", model: "Midas DL8" }], A: [{ range: [9, 16], device: "DL8-2", model: "Midas DL8" }], StageConnect: [{ range: [1, 16], device: "P16", model: "P16-M", via: "DL8-1", feed: { group: "StageConnect", range: [1, 16] } }] });
    expect(Object.keys(map)).to.deep.equal(["A", "SC"]);
    expect(map.A).to.have.length(2);
    expect(map.SC![0]!.feed!.group).to.equal("SC");
  });

  it("compares maps whatever the key order", () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: 3 } })).to.equal(stableStringify({ a: { c: 3, d: 2 }, b: 1 }));
  });

  it("numbers a model repeated over several links", () => {
    const l = (device: string) => ({ ports: [{ port: "A", state: "OK", device, errorsCorrected: 0, errorsUncorrected: 0, remoteName: "" }, { port: "B", state: "OK", device, errorsCorrected: 0, errorsUncorrected: 0, remoteName: "" }, { port: "C", state: "-", device: "", errorsCorrected: 0, errorsUncorrected: 0, remoteName: "" }] as never, stageConnect: { status: "-", devices: "", upstreamCount: 0, downstreamCount: 0 } });
    const { boxMap } = buildBoxMapFromLinks("wing-rack", l("S16"));
    expect([...boxMap.A!, ...boxMap.B!].map((b) => b.device)).to.deep.equal(["S16-1", "S16-2"]);
    expect(validateBoxMap(boxMap)).to.deep.equal([]);
  });

  it("lets the model win over the name", () => {
    expect(findDeviceSpec("DL8-1", "Midas DL16", 16).id).to.equal("midas-dl16");
    expect(findDeviceSpec("DL16 jardin", undefined, 16).id).to.equal("midas-dl16");
    expect(findDeviceSpec("DL8-1", "Machin", 8).id).to.equal("midas-dl8");
  });

  it("does not stretch a box past the ports its group has, nor a pair past its box", () => {
    const b = buildPatchSheet({ ...data, boxMap: { A: [{ range: [33, 48], device: "DL32", model: "Midas DL32" }] }, sources: [], inputs: [], outputs: [], userSignals: [] }).boxes[0]!;
    expect(b.range[1]).to.equal(48);
    expect(b.inputs).to.have.length(16);
    const edge = buildPatchSheet({
      ...data,
      boxMap: { A: [{ range: [2, 8], device: "Scène", model: "Midas DL8" }] },
      sources: [src2("A", 1, "Piano", [1, 2]), src2("A", 2, "Piano", [1, 2]), src2("A", 7, "Cordes", [7, 8]), src2("A", 8, "Cordes", [7, 8])],
      inputs: [], outputs: [], userSignals: [],
    }).boxes[0]!;
    expect(edge.inputs.every((c) => c.span === 1 || c.port + c.span - 1 <= 7)).to.equal(true);
  });

  it("pairs L/R outputs only from an odd connector", () => {
    const tap = (port: number, side: "L" | "R"): OutputPatchRow => ({ group: "A", port, box: null, signal: { kind: "tap", group: "BUS", rawIn: port, strip: "bus", stripIndex: 1, side, stripName: "IEM" } });
    const odd = buildPatchSheet({ ...data, boxMap: { A: [{ range: [1, 8], device: "DL8", model: "Midas DL8" }] }, outputs: [tap(1, "L"), tap(2, "R"), tap(4, "L"), tap(5, "R")], sources: [], inputs: [], userSignals: [] }).boxes[0]!;
    expect(odd.outputs.find((c) => c.port === 1)!.span).to.equal(2);
    expect(odd.outputs.find((c) => c.port === 4)!.span).to.equal(1);
  });

  it("keeps the characters Helvetica has", () => {
    expect(pdfSafe("Chœur")).to.equal("Chœur");
    expect(pdfSafe("Ça va ™ ‰")).to.equal("Ça va ™ ‰");
    expect(pdfSafe("é")).to.equal("é");
    expect(pdfSafe("日")).to.equal("?");
  });
});
function src2(group: string, index: number, name: string, pair: [number, number]): SourceListEntry {
  return { group, index, name, col: 1, colorName: undefined, icon: 0, iconName: undefined, mode: "ST", pair, gain: null, phantom48v: null, mute: null, polarityInverted: null, box: null } as SourceListEntry;
}
