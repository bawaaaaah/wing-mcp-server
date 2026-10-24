import { expect } from "chai";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WingWriteJournal } from "../../../src/plugins/wing/wing-write-journal.js";

describe("WingWriteJournal persistence", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "wing-journal-"));
    file = path.join(dir, "nested", "journal.json");
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  async function write(journal: WingWriteJournal, origin: string, path_: string, previous: number, next: number) {
    await journal.runBatch(origin, async () => {
      journal.record([{ path: path_, previous, next, audible: true }]);
    });
  }

  it("a new journal on the same file still holds the batches of the previous process", async () => {
    const first = new WingWriteJournal({ file });
    await write(first, "wing_channel_set_fader", "/ch/1/fdr", -10, -5);
    const batchId = first.history(1)[0]?.batchId;

    const second = new WingWriteJournal({ file });
    expect(second.history()).to.have.length(1);
    expect(second.find(batchId as string)?.entries).to.deep.equal([
      { path: "/ch/1/fdr", previous: -10, next: -5, audible: true },
    ]);
    expect(second.lastUndoable()?.batchId).to.equal(batchId);
  });

  it("keeps an undo, and the fact that its batch was undone, across a restart", async () => {
    const first = new WingWriteJournal({ file });
    await write(first, "wing_channel_set_fader", "/ch/1/fdr", -10, -5);
    const original = first.history(1)[0]!;
    await first.runBatch(
      "wing_undo",
      async () => first.record([{ path: "/ch/1/fdr", previous: -5, next: -10, audible: true }]),
      { undoOf: original.batchId },
    );
    first.markUndone(original.batchId);

    const second = new WingWriteJournal({ file });
    expect(second.history()).to.have.length(2);
    expect(second.find(original.batchId)?.undoneAt).to.be.a("number");
    expect(second.lastUndoable()).to.equal(undefined);
  });

  it("starts empty, without throwing, on a missing or damaged file", () => {
    expect(new WingWriteJournal({ file }).history()).to.deep.equal([]);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{ not json");
    expect(new WingWriteJournal({ file }).history()).to.deep.equal([]);
  });

  it("writes the file readable by its owner only", async () => {
    const journal = new WingWriteJournal({ file });
    await write(journal, "wing_set", "/ch/2/mute", 0, 1);
    expect(fs.statSync(file).mode.toString(8)).to.match(/600$/);
  });

  it("clear() empties the file too", async () => {
    const journal = new WingWriteJournal({ file });
    await write(journal, "wing_set", "/ch/2/mute", 0, 1);
    journal.clear();
    expect(new WingWriteJournal({ file }).history()).to.deep.equal([]);
  });

  it("without a file nothing is written", async () => {
    const journal = new WingWriteJournal();
    await write(journal, "wing_set", "/ch/2/mute", 0, 1);
    expect(fs.existsSync(file)).to.equal(false);
    expect(journal.history()).to.have.length(1);
  });
});
