import { expect } from "chai";
import { encodeFloat, encodeNodeId, encodeNodeName, TOKEN_DATA_REQUEST, TOKEN_DEF_REQUEST, TOKEN_ROOT } from "../../../src/plugins/wing/wing-native-codec.js";
import { NativeTestClient, WingNativeMock } from "./wing-native-mock.js";

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("WingNativeMock (test console for the native control channel)", () => {
  let mock: WingNativeMock;
  let port: number;
  const clients: NativeTestClient[] = [];

  afterEach(async () => {
    for (const c of clients.splice(0)) c.close();
    await mock.stop();
  });

  async function client(): Promise<NativeTestClient> {
    const c = await new NativeTestClient().connect(port);
    clients.push(c);
    return c;
  }

  it("answers data and definition requests, and pushes a write to the other connections only", async () => {
    mock = new WingNativeMock();
    ({ port } = await mock.start());
    const a = await client();
    const b = await client();
    const fdr = mock.idOf("ch/1/fdr");

    a.send([TOKEN_ROOT], encodeNodeName("ch"), [TOKEN_DEF_REQUEST]);
    await waitFor(() => a.count("end") === 1);
    // Numbered strips come unnamed, told apart by index — as the real console sends them.
    expect(a.tokens.filter((t) => t.kind === "def").map((t) => (t.kind === "def" ? [t.def?.name, t.def?.index] : null))).to.deep.equal([
      ["", 1],
      ["", 2],
      ["", 3],
      ["", 4],
    ]);

    a.send(encodeNodeId(fdr), encodeFloat(-10));
    await waitFor(() => b.valuesFor(fdr).length === 1);
    expect(b.valuesFor(fdr)).to.deep.equal([-10]);
    expect(mock.get("ch/1/fdr")).to.equal(-10);

    a.send(encodeNodeId(fdr), [TOKEN_DATA_REQUEST]);
    await waitFor(() => a.count("end") === 2);
    expect(a.valuesFor(fdr)).to.deep.equal([-10]);
  });

  it("gives a subtree new ids on renumberSubtree, as a model change is assumed to", async () => {
    mock = new WingNativeMock();
    ({ port } = await mock.start());
    const before = mock.idOf("ch/2/dyn/thr");
    mock.renumberSubtree("ch/2/dyn");
    expect(mock.idOf("ch/2/dyn/thr")).to.not.equal(before);
    expect(mock.idOf("ch/2/dyn")).to.equal(mock.idOf("ch/2/dyn"));
  });
});
