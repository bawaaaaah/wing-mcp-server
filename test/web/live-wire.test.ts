import { expect } from "chai";
import { decode, encode } from "@msgpack/msgpack";
import { asWireMessage, isHttpStatus } from "../../web/src/api/live-codec.js";

// What the dashboard's live socket accepts off the wire: a decoded frame is only handled as a message
// when it has the shape every message shares, and a `res` only settles a request with a real status.

describe("live socket wire validation", () => {
  it("accepts a map with a string t", () => {
    const message = asWireMessage(decode(encode({ t: "res", id: 3, status: 200, body: { ok: true } })));
    expect(message).to.deep.equal({ t: "res", id: 3, status: 200, body: { ok: true } });
  });

  it("refuses anything else", () => {
    for (const decoded of [null, 42, "hello", [1, 2], new Uint8Array([1]), {}, { t: 1 }, { type: "res" }]) {
      expect(asWireMessage(decoded), JSON.stringify(decoded)).to.equal(undefined);
    }
  });

  it("takes only an integer HTTP status from a res", () => {
    for (const status of [200, 204, 401, 422, 599, 100]) expect(isHttpStatus(status), String(status)).to.equal(true);
    for (const status of [undefined, null, "200", 200.5, NaN, 0, 99, 600, -1]) expect(isHttpStatus(status), String(status)).to.equal(false);
  });
});
