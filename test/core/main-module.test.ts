import { expect } from "chai";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isMainModule } from "../../src/index.js";

describe("isMainModule", () => {
  let dir: string;

  beforeEach(() => {
    // A space and an accent: both are escaped in a file:// URL, which is what the old
    // `"file://" + argv[1]` comparison never matched.
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "wing mcp é-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("recognizes the entry point in a directory whose path needs URL escaping", () => {
    const entry = path.join(dir, "index.js");
    fs.writeFileSync(entry, "");
    expect(isMainModule(entry, pathToFileURL(fs.realpathSync(entry)).href)).to.equal(true);
  });

  it("follows a symlink to the real module, as Node does for import.meta.url", function () {
    if (process.platform === "win32") this.skip();
    const real = path.join(dir, "real.js");
    const link = path.join(dir, "link.js");
    fs.writeFileSync(real, "");
    fs.symlinkSync(real, link);
    expect(isMainModule(link, pathToFileURL(fs.realpathSync(real)).href)).to.equal(true);
  });

  it("is false for another module, a missing file, or no entry at all", () => {
    const entry = path.join(dir, "index.js");
    fs.writeFileSync(entry, "");
    expect(isMainModule(entry, pathToFileURL(path.join(dir, "other.js")).href)).to.equal(false);
    expect(isMainModule(path.join(dir, "missing.js"), "file:///x")).to.equal(false);
    expect(isMainModule(undefined, "file:///x")).to.equal(false);
  });
});
