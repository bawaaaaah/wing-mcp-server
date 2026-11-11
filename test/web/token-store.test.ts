import { expect } from "chai";
import { clearToken, getToken, onTokenChange, setToken } from "../../web/src/auth/token-store.js";

// The dashboard's sign-in token: a 401 clears it, and the sign-in gate must hear about it rather than
// only checking once when it mounts. Under Node there is no usable localStorage, which also covers a
// browser that refuses storage (private mode, blocked site data): the token then lives in memory.

describe("token-store", () => {
  afterEach(() => clearToken());

  it("keeps the token without storage", () => {
    setToken("abc");
    expect(getToken()).to.equal("abc");
    clearToken();
    expect(getToken()).to.equal(null);
  });

  it("tells listeners when the token is set and cleared", () => {
    const seen: (string | null)[] = [];
    const off = onTokenChange((token) => seen.push(token));
    setToken("abc");
    clearToken();
    off();
    setToken("ignored");
    expect(seen).to.deep.equal(["abc", null]);
  });

  it("says nothing when nothing changed", () => {
    setToken("abc");
    const seen: (string | null)[] = [];
    const off = onTokenChange((token) => seen.push(token));
    setToken("abc");
    clearToken();
    clearToken();
    off();
    expect(seen).to.deep.equal([null]);
  });

  it("keeps notifying the others when one listener throws", () => {
    const seen: (string | null)[] = [];
    const offBad = onTokenChange(() => {
      throw new Error("boom");
    });
    const off = onTokenChange((token) => seen.push(token));
    const error = console.error;
    console.error = () => undefined;
    try {
      setToken("abc");
    } finally {
      console.error = error;
      offBad();
      off();
    }
    expect(seen).to.deep.equal(["abc"]);
  });
});
