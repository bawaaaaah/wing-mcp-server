import { expect } from "chai";
import { ackError, ParamEdits, rejectionError } from "../../web/src/components/param-edits.js";

// The dashboard's describe-driven panels: what a field shows while its write travels, and after.
// The failures below were seen live on a WING Rack's Dynamics card (2026-10-28).

const CONSOLE = { mdl: "NSTR", ratio: "3:1", thr: -20 };

describe("ParamEdits", () => {
  it("shows a value as soon as it is set, over the console's", () => {
    const edits = new ParamEdits();
    edits.edit("ratio", "8:1");
    expect(edits.shown(CONSOLE)).to.deep.equal({ mdl: "NSTR", ratio: "8:1", thr: -20 });
  });

  it("rolls a refused write back to the console's value and says why", () => {
    const edits = new ParamEdits();
    edits.edit("ratio", "4:1");
    const seq = edits.sending("ratio");
    edits.answered("ratio", seq, rejectionError(new Error('Invalid value "4:1" for /ch/{n}/dyn/ratio')));
    expect(edits.shown(CONSOLE).ratio).to.equal("3:1");
    expect(edits.error("ratio")).to.equal('Not set: Invalid value "4:1" for /ch/{n}/dyn/ratio');
    expect(edits.busy).to.equal(false);
  });

  it("treats an ack that is not OK as a refusal", () => {
    const edits = new ParamEdits();
    edits.edit("ratio", "NUKE");
    const seq = edits.sending("ratio");
    edits.answered("ratio", seq, ackError({ ok: false, status: "VALUE ERROR" }));
    expect(edits.shown(CONSOLE).ratio).to.equal("3:1");
    expect(edits.error("ratio")).to.equal("Not set: the console answered VALUE ERROR.");
  });

  it("keeps a written value only until the console is read again", () => {
    const edits = new ParamEdits();
    edits.edit("ratio", "-5");
    const seq = edits.sending("ratio");
    edits.answered("ratio", seq, ackError({ ok: true, status: "OK" }));
    expect(edits.shown(CONSOLE).ratio, "until the read-back").to.equal("-5");
    // The console clamped it: the read shows what it really holds.
    expect(edits.consoleRead()).to.equal(true);
    expect(edits.shown({ ...CONSOLE, ratio: 1.1 }).ratio).to.equal(1.1);
    expect(edits.error("ratio")).to.equal(undefined);
  });

  it("keeps a value whose write is still on its way through a read", () => {
    const edits = new ParamEdits();
    edits.edit("thr", -30);
    edits.sending("thr");
    expect(edits.busy).to.equal(true);
    expect(edits.consoleRead()).to.equal(false);
    expect(edits.shown(CONSOLE).thr).to.equal(-30);
  });

  it("keeps a slider's newer value when an earlier write of the drag comes back", () => {
    const edits = new ParamEdits();
    edits.edit("thr", -25);
    const first = edits.sending("thr");
    // Moved on before the first write came back; the throttle holds this one back.
    edits.edit("thr", -28);
    edits.answered("thr", first);
    edits.consoleRead();
    expect(edits.shown(CONSOLE).thr, "an unsent value survives a read").to.equal(-28);

    const second = edits.sending("thr");
    edits.answered("thr", second);
    edits.consoleRead();
    expect(edits.shown(CONSOLE).thr).to.equal(-20);
  });

  it("does not roll back a value set again after the write that failed", () => {
    const edits = new ParamEdits();
    edits.edit("thr", -90);
    const seq = edits.sending("thr");
    edits.edit("thr", -40);
    edits.answered("thr", seq, "Not set: out of range");
    expect(edits.shown(CONSOLE).thr).to.equal(-40);
  });

  it("forgets the error once the field is set again or written fine", () => {
    const edits = new ParamEdits();
    edits.edit("ratio", "4:1");
    edits.answered("ratio", edits.sending("ratio"), "Not set: no");
    edits.edit("ratio", "8:1");
    expect(edits.error("ratio")).to.equal(undefined);

    edits.answered("ratio", edits.sending("ratio"), "Not set: no");
    edits.edit("ratio", "8:1");
    edits.answered("ratio", edits.sending("ratio"));
    expect(edits.error("ratio")).to.equal(undefined);
  });

  it("drops what was set under the old model when the model changes", () => {
    const edits = new ParamEdits();
    edits.edit("ratio", "8:1");
    edits.answered("ratio", edits.sending("ratio"));
    edits.edit("thr", -50);
    edits.answered("thr", edits.sending("thr"), "Not set: no");
    edits.edit("mdl", "B560");
    edits.keepOnly("mdl");
    // The old ratio would match none of B560's options; the console's own value shows instead.
    expect(edits.shown(CONSOLE)).to.deep.equal({ mdl: "B560", ratio: "3:1", thr: -20 });
    expect(edits.error("thr")).to.equal(undefined);
    expect(edits.isEdited("ratio")).to.equal(false);
  });
});

describe("ackError", () => {
  it("passes an OK ack", () => {
    expect(ackError({ ok: true, status: "OK" })).to.equal(undefined);
  });

  it("names a value the console stored differently", () => {
    expect(ackError({ ok: false, status: "MISMATCH" })).to.equal("The console stored a different value.");
  });

  it("names the console's refusal", () => {
    expect(ackError({ ok: false, status: "NODE NOT FOUND" })).to.equal("Not set: the console answered NODE NOT FOUND.");
  });
});
