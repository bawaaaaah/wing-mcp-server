import { expect } from "chai";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { besideConfig, dataDir } from "../../../src/plugins/wing/wing-plugin.js";

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

describe("dataDir", () => {
  const savedEnv = { config: process.env.MCP_CONFIG_PATH, presets: process.env.WING_PRESETS_DIR };
  const savedCwd = process.cwd();
  const savedWarn = console.warn;
  let dir: string;
  let warnings: string[];

  beforeEach(() => {
    // Resolved, so the warning's absolute paths compare equal on macOS, where tmpdir is a symlink.
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wing-data-dir-")));
    process.chdir(dir);
    process.env.MCP_CONFIG_PATH = path.join(dir, "elsewhere", "config.json");
    delete process.env.WING_PRESETS_DIR;
    warnings = [];
    console.warn = (...args: unknown[]) => void warnings.push(args.join(" "));
  });
  afterEach(() => {
    console.warn = savedWarn;
    process.chdir(savedCwd);
    for (const [name, value] of [["MCP_CONFIG_PATH", savedEnv.config], ["WING_PRESETS_DIR", savedEnv.presets]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function legacyPreset(): void {
    fs.mkdirSync(path.join(dir, "data", "presets"), { recursive: true });
    fs.writeFileSync(path.join(dir, "data", "presets", "kick.json"), "{}");
  }

  it("points at the files the old default left in ./data, without moving them", () => {
    legacyPreset();
    expect(dataDir("WING_PRESETS_DIR", "presets")).to.equal(path.join(dir, "elsewhere", "presets"));
    expect(warnings).to.have.length(1);
    expect(warnings[0]).to.include(path.join(dir, "data", "presets")).and.include("WING_PRESETS_DIR");
    expect(fs.existsSync(path.join(dir, "data", "presets", "kick.json"))).to.equal(true);
  });

  it("stays quiet once the new place has files of its own", () => {
    legacyPreset();
    fs.mkdirSync(path.join(dir, "elsewhere", "presets"), { recursive: true });
    fs.writeFileSync(path.join(dir, "elsewhere", "presets", "snare.json"), "{}");
    dataDir("WING_PRESETS_DIR", "presets");
    expect(warnings).to.deep.equal([]);
  });

  it("stays quiet when the config is at its default place, which is the old place too", () => {
    legacyPreset();
    delete process.env.MCP_CONFIG_PATH;
    expect(dataDir("WING_PRESETS_DIR", "presets")).to.equal("data/presets");
    expect(warnings).to.deep.equal([]);
  });

  it("returns the override when one is set", () => {
    legacyPreset();
    process.env.WING_PRESETS_DIR = "/srv/presets";
    expect(dataDir("WING_PRESETS_DIR", "presets")).to.equal("/srv/presets");
    expect(warnings).to.deep.equal([]);
  });
});
