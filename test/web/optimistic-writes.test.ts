import { expect } from "chai";
import { ackError, OptimisticWrites, rejectionError, writeOutcome } from "../../web/src/api/optimistic-writes.js";

// The mixer's direct writes (faders, mutes, colours, sends): what a control goes back to when a
// write it showed ahead of the console does not take.

describe("OptimisticWrites", () => {
  it("leaves the field alone when its write takes", () => {
    const writes = new OptimisticWrites<number>();
    writes.edit("fdr", -10, -5);
    const ticket = writes.sending("fdr");
    expect(writes.answered("fdr", ticket)).to.equal(undefined);
  });

  it("puts a refused write back on the value shown before it", () => {
    const writes = new OptimisticWrites<boolean>();
    writes.edit("mute", false, true);
    const ticket = writes.sending("mute");
    expect(writes.answered("mute", ticket, "Not set: the console answered VALUE ERROR.")).to.deep.equal({ value: false });
  });

  it("goes back to the last value the console acknowledged, not the first", () => {
    const writes = new OptimisticWrites<number>();
    writes.edit("fdr", -20, -15);
    const first = writes.sending("fdr");
    writes.edit("fdr", -15, -10);
    const second = writes.sending("fdr");
    expect(writes.answered("fdr", first)).to.equal(undefined);
    expect(writes.answered("fdr", second, "Not set: The console did not answer in time.")).to.deep.equal({ value: -15 });
  });

  it("leaves an older write's failure to the newer edit on its way", () => {
    const writes = new OptimisticWrites<number>();
    writes.edit("fdr", -20, -15);
    const first = writes.sending("fdr");
    // A drag goes on while the first write travels: its value waits in the throttle.
    writes.edit("fdr", -15, -10);
    expect(writes.answered("fdr", first, "Not set: The console did not answer in time.")).to.equal(undefined);
    const second = writes.sending("fdr");
    expect(writes.answered("fdr", second)).to.equal(undefined);
  });

  it("goes back to the value from before the burst when every write of it fails", () => {
    const writes = new OptimisticWrites<number>();
    writes.edit("fdr", -20, -15);
    const first = writes.sending("fdr");
    writes.edit("fdr", -15, -10);
    const second = writes.sending("fdr");
    expect(writes.answered("fdr", first, "Not set: offline")).to.equal(undefined);
    expect(writes.answered("fdr", second, "Not set: offline")).to.deep.equal({ value: -20 });
  });

  it("starts again from what is shown once a burst has settled", () => {
    const writes = new OptimisticWrites<number>();
    writes.edit("col", 3, 5);
    expect(writes.answered("col", writes.sending("col"), "Not set: the console answered VALUE ERROR.")).to.deep.equal({ value: 3 });
    writes.edit("col", 3, 7);
    expect(writes.answered("col", writes.sending("col"), "Not set: the console answered VALUE ERROR.")).to.deep.equal({ value: 3 });
  });

  it("ignores a late answer from a burst already settled", () => {
    const writes = new OptimisticWrites<number>();
    writes.edit("fdr", -20, -15);
    const first = writes.sending("fdr");
    writes.edit("fdr", -15, -10);
    const second = writes.sending("fdr");
    // The newer write's answer came first and settled the burst; then the user moved on.
    expect(writes.answered("fdr", second)).to.equal(undefined);
    writes.edit("fdr", -10, 0);
    const third = writes.sending("fdr");
    expect(writes.answered("fdr", first)).to.equal(undefined);
    expect(writes.answered("fdr", third, "Not set: offline")).to.deep.equal({ value: -10 });
  });

  it("keeps each field to itself", () => {
    const writes = new OptimisticWrites<number | boolean>();
    writes.edit("fdr", -20, -10);
    const fader = writes.sending("fdr");
    writes.edit("mute", false, true);
    const mute = writes.sending("mute");
    expect(writes.answered("mute", mute, "Not set: offline")).to.deep.equal({ value: false });
    expect(writes.answered("fdr", fader)).to.equal(undefined);
  });
});

describe("writeOutcome", () => {
  it("is undefined for an OK ack", async () => {
    expect(await writeOutcome(Promise.resolve({ ok: true, status: "OK" }))).to.equal(undefined);
  });

  it("names the console's answer when the ack is not OK", async () => {
    expect(await writeOutcome(Promise.resolve({ ok: false, status: "NODE NOT FOUND" }))).to.equal("Not set: the console answered NODE NOT FOUND.");
  });

  it("turns a rejected request into its reason instead of rejecting", async () => {
    const refused = Promise.reject(new Error("value 12 is above the maximum of 10 for /ch/3/fdr"));
    expect(await writeOutcome(refused)).to.equal("Not set: value 12 is above the maximum of 10 for /ch/3/fdr");
  });

  it("words acks and rejections as the param panels do", () => {
    expect(ackError({ ok: false, status: "MISMATCH" })).to.equal("The console stored a different value.");
    expect(ackError(undefined)).to.equal(undefined);
    expect(rejectionError("offline")).to.equal("Not set: offline");
  });
});
