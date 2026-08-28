import { expect } from "chai";
import { WingConfigSchema } from "../../../src/plugins/wing/wing-config.js";

describe("WingConfigSchema", () => {
  it("defaults the OSC mirror to disabled with an empty target", () => {
    const parsed = WingConfigSchema.parse({ host: "192.168.1.10" });
    expect(parsed.oscMirrorEnabled).to.equal(false);
    expect(parsed.oscMirrorHost).to.equal("");
    expect(parsed.oscMirrorPort).to.equal(0);
  });

  it("accepts a fully-disabled mirror even with a leftover host/port from a previous session", () => {
    const parsed = WingConfigSchema.parse({ host: "192.168.1.10", oscMirrorEnabled: false, oscMirrorHost: "10.0.0.5", oscMirrorPort: 9000 });
    expect(parsed.oscMirrorEnabled).to.equal(false);
  });

  it("accepts enabling the mirror with a valid host and port", () => {
    const parsed = WingConfigSchema.parse({ host: "192.168.1.10", oscMirrorEnabled: true, oscMirrorHost: "10.0.0.5", oscMirrorPort: 9000 });
    expect(parsed).to.deep.include({ oscMirrorEnabled: true, oscMirrorHost: "10.0.0.5", oscMirrorPort: 9000 });
  });

  it("rejects enabling the mirror without a host", () => {
    expect(() => WingConfigSchema.parse({ host: "192.168.1.10", oscMirrorEnabled: true, oscMirrorPort: 9000 })).to.throw();
  });

  it("rejects enabling the mirror with an out-of-range port", () => {
    expect(() => WingConfigSchema.parse({ host: "192.168.1.10", oscMirrorEnabled: true, oscMirrorHost: "10.0.0.5", oscMirrorPort: 0 })).to.throw();
    expect(() => WingConfigSchema.parse({ host: "192.168.1.10", oscMirrorEnabled: true, oscMirrorHost: "10.0.0.5", oscMirrorPort: 70000 })).to.throw();
  });
});
