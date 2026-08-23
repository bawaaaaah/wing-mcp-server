import { expect } from "chai";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { slugifyPresetName, WingPresetStore, type PresetSlot } from "../../../src/plugins/wing/wing-preset-store.js";

function fakeSlot(sourceIndex: number): PresetSlot {
  return {
    sourceIndex,
    raw: { fdr: -6, mute: 0, pan: 0 },
    corrected: {
      tags: "",
      inConnGrp: null,
      inConnIn: null,
      inSetTrim: null,
      inSetSrcauto: null,
      ownName: `Channel ${sourceIndex}`,
      effectiveName: `Channel ${sourceIndex}`,
    },
    preampGain: null,
  };
}

describe("slugifyPresetName", () => {
  it("lowercases and hyphenates a display name", () => {
    expect(slugifyPresetName("Morgane Micro KSM9")).to.equal("morgane-micro-ksm9");
  });

  it("normalizes accented characters to ASCII", () => {
    expect(slugifyPresetName("Basse Réverbe")).to.equal("basse-reverbe");
  });

  it("throws for a name with no usable characters", () => {
    expect(() => slugifyPresetName("!!!")).to.throw(/no usable characters/);
  });
});

describe("WingPresetStore", () => {
  let dir: string;
  let store: WingPresetStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "wing-mcp-test-presets-"));
    store = new WingPresetStore({ dir });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns an empty list before any preset directory exists", async () => {
    expect(await store.list()).to.deep.equal([]);
  });

  it("get() returns null for a preset that doesn't exist", async () => {
    expect(await store.get("Nope")).to.equal(null);
  });

  it("round-trips a saved preset", async () => {
    await store.save({ name: "Morgane Micro KSM9", type: "channel", slots: [fakeSlot(1)] });
    const file = await store.get("Morgane Micro KSM9");
    expect(file).to.not.equal(null);
    expect(file!.name).to.equal("Morgane Micro KSM9");
    expect(file!.type).to.equal("channel");
    expect(file!.slots).to.have.lengthOf(1);
    expect(file!.slots[0].sourceIndex).to.equal(1);
    expect(fs.existsSync(path.join(dir, "morgane-micro-ksm9.json"))).to.equal(true);
  });

  it("round-trips a non-channel strip type (e.g. a DCA preset)", async () => {
    await store.save({ name: "Vocals DCA", type: "dca", slots: [fakeSlot(2)] });
    const file = await store.get("Vocals DCA");
    expect(file!.type).to.equal("dca");
  });

  it("list() summarizes every saved preset, sorted by name", async () => {
    await store.save({ name: "Zebra", type: "channel", slots: [fakeSlot(3)] });
    await store.save({ name: "Drums", type: "channel", slots: [fakeSlot(17), fakeSlot(18)] });

    const list = await store.list();
    expect(list.map((p) => p.name)).to.deep.equal(["Drums", "Zebra"]);
    expect(list[0]).to.deep.equal({
      name: "Drums",
      type: "channel",
      createdAt: list[0].createdAt,
      updatedAt: list[0].updatedAt,
      slotCount: 2,
      sourceIndices: [17, 18],
    });
  });

  it("rejects overwriting an existing preset by default, naming the existing preset", async () => {
    await store.save({ name: "Morgane Micro KSM9", type: "channel", slots: [fakeSlot(1)] });
    let error: Error | undefined;
    try {
      await store.save({ name: "Morgane Micro KSM9", type: "channel", slots: [fakeSlot(2)] });
    } catch (err) {
      error = err as Error;
    }
    expect(error?.message).to.include('"Morgane Micro KSM9"');
    expect(error?.message).to.include("overwrite: true");
  });

  it("overwrite: true replaces the content but preserves the original createdAt", async () => {
    const first = await store.save({ name: "Morgane Micro KSM9", type: "channel", slots: [fakeSlot(1)] });
    const second = await store.save(
      { name: "Morgane Micro KSM9", type: "channel", slots: [fakeSlot(1), fakeSlot(2)] },
      { overwrite: true },
    );

    expect(second.createdAt).to.equal(first.createdAt);
    expect(second.slots).to.have.lengthOf(2);
    const reloaded = await store.get("Morgane Micro KSM9");
    expect(reloaded!.slots).to.have.lengthOf(2);
  });

  it("delete() removes a preset and returns true, false when it doesn't exist", async () => {
    await store.save({ name: "Drums", type: "channel", slots: [fakeSlot(17)] });
    expect(await store.delete("Drums")).to.equal(true);
    expect(await store.get("Drums")).to.equal(null);
    expect(await store.delete("Drums")).to.equal(false);
  });

  it("quarantines a corrupt preset file without affecting other presets", async () => {
    await store.save({ name: "Good One", type: "channel", slots: [fakeSlot(1)] });
    fs.writeFileSync(path.join(dir, "bad-one.json"), "{ this is not valid json");

    const list = await store.list();
    expect(list.map((p) => p.name)).to.deep.equal(["Good One"]);

    const corruptFiles = fs.readdirSync(dir).filter((name) => name.includes(".corrupt-"));
    expect(corruptFiles).to.have.lengthOf(1);
    expect(corruptFiles[0]).to.include("bad-one.json");
  });

  it("quarantines a schema-invalid preset file (valid JSON, wrong shape)", async () => {
    fs.writeFileSync(path.join(dir, "wrong-shape.json"), JSON.stringify({ hello: "world" }));

    expect(await store.get("wrong-shape")).to.equal(null);
    const corruptFiles = fs.readdirSync(dir).filter((name) => name.includes(".corrupt-"));
    expect(corruptFiles).to.have.lengthOf(1);
  });

  it("quarantines a preset file with an unknown strip type", async () => {
    fs.writeFileSync(
      path.join(dir, "bad-type.json"),
      JSON.stringify({ formatVersion: 1, name: "x", type: "not-a-real-type", createdAt: "now", updatedAt: "now", slots: [] }),
    );
    expect(await store.get("bad-type")).to.equal(null);
  });

  it("leaves no leftover .tmp- files after a save", async () => {
    await store.save({ name: "Drums", type: "channel", slots: [fakeSlot(17)] });
    const leftoverTmpFiles = fs.readdirSync(dir).filter((name) => name.includes(".tmp-"));
    expect(leftoverTmpFiles).to.have.lengthOf(0);
  });

  it("serializes concurrent saves to the same preset name into one final, valid file", async () => {
    const writes = Array.from({ length: 10 }, (_, i) =>
      store.save({ name: "Drums", type: "channel", slots: [fakeSlot(17 + i)] }, { overwrite: true }).catch(() => null),
    );
    await Promise.all(writes);

    const file = await store.get("Drums");
    expect(file).to.not.equal(null);
    expect(file!.slots).to.have.lengthOf(1);
    const leftoverTmpFiles = fs.readdirSync(dir).filter((name) => name.includes(".tmp-"));
    expect(leftoverTmpFiles).to.have.lengthOf(0);
  });

  it("does not block saving a different preset while another is in flight", async () => {
    const [a, b] = await Promise.all([
      store.save({ name: "Drums", type: "channel", slots: [fakeSlot(17)] }),
      store.save({ name: "Morgane Micro KSM9", type: "channel", slots: [fakeSlot(1)] }),
    ]);
    expect(a.name).to.equal("Drums");
    expect(b.name).to.equal("Morgane Micro KSM9");
    expect((await store.list()).map((p) => p.name).sort()).to.deep.equal(["Drums", "Morgane Micro KSM9"]);
  });
});
