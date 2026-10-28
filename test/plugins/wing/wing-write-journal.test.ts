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
    expect(second.lastUndoable({ includeOtherSessions: true })?.batchId).to.equal(batchId);
  });

  it("only offers its own batches as the default undo: another session's needs its id", async () => {
    const first = new WingWriteJournal({ file });
    await write(first, "wing_channel_set_fader", "/ch/1/fdr", -10, -5);
    const earlier = first.history(1)[0]!.batchId;

    const second = new WingWriteJournal({ file });
    expect(second.isFromThisSession(earlier)).to.equal(false);
    expect(second.lastUndoable()).to.equal(undefined);

    await write(second, "wing_channel_set_fader", "/ch/2/fdr", -20, -15);
    const own = second.history(1)[0]!.batchId;
    expect(second.isFromThisSession(own)).to.equal(true);
    expect(second.lastUndoable()?.batchId).to.equal(own);
  });

  it("two processes sharing the file keep each other's batches", async () => {
    const a = new WingWriteJournal({ file });
    const b = new WingWriteJournal({ file });
    await write(a, "wing_set", "/ch/1/mute", 0, 1);
    await write(b, "wing_set", "/ch/2/mute", 0, 1);
    await write(a, "wing_set", "/ch/3/mute", 0, 1);

    const paths = new WingWriteJournal({ file }).history().map((batch) => batch.entries[0]?.path);
    expect(paths).to.have.members(["/ch/1/mute", "/ch/2/mute", "/ch/3/mute"]);
  });

  it("sees an undo another process recorded, so the batch is not restored twice", async () => {
    const a = new WingWriteJournal({ file });
    await write(a, "wing_set", "/ch/1/mute", 0, 1);
    const batchId = a.history(1)[0]!.batchId;
    const b = new WingWriteJournal({ file });

    a.markUndone(batchId);
    expect(b.find(batchId)?.undoneAt).to.equal(undefined);
    b.refresh();
    expect(b.find(batchId)?.undoneAt).to.be.a("number");
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

  it("starts empty, without throwing, on a missing or damaged file, and keeps the damaged one aside", () => {
    expect(new WingWriteJournal({ file }).history()).to.deep.equal([]);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{ not json");
    expect(new WingWriteJournal({ file }).history()).to.deep.equal([]);
    const aside = fs.readdirSync(path.dirname(file)).filter((name) => name.startsWith("journal.json.corrupt-"));
    expect(aside).to.have.length(1);
    expect(fs.readFileSync(path.join(path.dirname(file), aside[0] as string), "utf8")).to.equal("{ not json");
  });

  it("drops a malformed batch instead of failing on it later", () => {
    const good = { batchId: "good0001", origin: "wing_set", startedAt: 1, entries: [{ path: "/ch/1/mute", previous: 0, next: 1, audible: true }] };
    const bad = [
      { batchId: "bad00001", origin: "x", startedAt: 2, entries: [null] },
      { batchId: "bad00002", origin: "y", startedAt: "oops", entries: [] },
      { batchId: "bad00003", origin: "z", startedAt: 3, entries: [{ path: 42, previous: "a", next: {}, audible: true }] },
    ];
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: 1, batches: [good, ...bad] }));
    expect(new WingWriteJournal({ file }).history().map((b) => b.batchId)).to.deep.equal(["good0001"]);
  });

  it("leaves a journal in a newer format alone and keeps its own in memory", async () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const newer = JSON.stringify({ version: 2, batches: [], something: "new" });
    fs.writeFileSync(file, newer);
    const journal = new WingWriteJournal({ file });
    await write(journal, "wing_set", "/ch/2/mute", 0, 1);
    expect(journal.history()).to.have.length(1);
    expect(fs.readFileSync(file, "utf8")).to.equal(newer);
  });

  it("drops the oldest batches to keep the file under 4 MB, never the newest", async () => {
    const journal = new WingWriteJournal({ file });
    const entries = Array.from({ length: 5000 }, (_, i) => ({ path: `/ch/1/eq/${i}`, previous: -1.25, next: 1.25, audible: true }));
    for (let n = 0; n < 20; n++) {
      await journal.runBatch(`load ${n}`, async () => journal.record(entries));
    }
    expect(fs.statSync(file).size).to.be.at.most(4 * 1024 * 1024);
    const kept = new WingWriteJournal({ file }).history(200).map((b) => b.origin);
    expect(kept[0]).to.equal("load 19");
    expect(kept.length).to.be.lessThan(20);
    expect(journal.history(200).map((b) => b.origin)).to.deep.equal(kept);
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
