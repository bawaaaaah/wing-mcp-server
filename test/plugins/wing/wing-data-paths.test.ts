import { expect } from "chai";
import { besideConfig } from "../../../src/plugins/wing/wing-plugin.js";

describe("besideConfig", () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.MCP_CONFIG_PATH;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.MCP_CONFIG_PATH;
    else process.env.MCP_CONFIG_PATH = saved;
  });

  it("follows the config file, wherever it is", () => {
    process.env.MCP_CONFIG_PATH = "/Users/me/wing/data/config.json";
    expect(besideConfig("presets")).to.equal("/Users/me/wing/data/presets");
  });

  it("serves the mic calibrations directory the same way", () => {
    process.env.MCP_CONFIG_PATH = "/srv/wing/config.json";
    expect(besideConfig("mic-calibrations")).to.equal("/srv/wing/mic-calibrations");
  });

  it("is ./data/<name> when the config is at its default place", () => {
    delete process.env.MCP_CONFIG_PATH;
    expect(besideConfig("presets")).to.equal("data/presets");
  });
});
