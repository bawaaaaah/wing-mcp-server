import { expect } from "chai";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConfigFileUnreadableError, ConfigStore } from "../../src/core/config-store.js";

describe("ConfigStore", () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "wing-mcp-test-"));
    filePath = path.join(dir, "config.json");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("starts with in-memory defaults and does not create a file when missing", async () => {
    const store = new ConfigStore({ filePath });
    await store.load();

    expect(store.getServerAuthToken()).to.be.undefined;
    expect(store.getPluginConfig("wing")).to.be.undefined;
    expect(fs.existsSync(filePath)).to.equal(false);
  });

  it("creates the parent directory recursively if missing", async () => {
    const nestedPath = path.join(dir, "nested", "deeper", "config.json");
    const store = new ConfigStore({ filePath: nestedPath });
    await store.load();

    expect(fs.existsSync(path.dirname(nestedPath))).to.equal(true);
  });

  it("round-trips persisted config across store instances", async () => {
    const store = new ConfigStore({ filePath });
    await store.load();
    await store.setServerAuthToken("abc123");
    await store.setPluginConfig("wing", { host: "1.2.3.4" });

    const reloaded = new ConfigStore({ filePath });
    await reloaded.load();

    expect(reloaded.getServerAuthToken()).to.equal("abc123");
    expect(reloaded.getPluginConfig("wing")).to.deep.equal({ host: "1.2.3.4" });
  });

  it("recovers from a corrupt config file by renaming it and using defaults", async () => {
    fs.writeFileSync(filePath, "{ this is not valid json");

    const store = new ConfigStore({ filePath });
    await store.load();

    expect(store.getServerAuthToken()).to.be.undefined;
    expect(fs.existsSync(filePath)).to.equal(false);

    const corruptFiles = fs.readdirSync(dir).filter((name) => name.includes(".corrupt-"));
    expect(corruptFiles).to.have.lengthOf(1);
    const corruptContents = fs.readFileSync(path.join(dir, corruptFiles[0]), "utf8");
    expect(corruptContents).to.equal("{ this is not valid json");
  });

  it("refuses to start from defaults when the file exists but cannot be read, and leaves it alone", async () => {
    // A directory where the file should be: readFile fails with EISDIR, the same path an EACCES
    // takes, without depending on the test running as a non-root user.
    fs.mkdirSync(filePath);
    const store = new ConfigStore({ filePath });
    const err = await store.load().catch((e: unknown) => e);
    expect(err).to.be.instanceOf(ConfigFileUnreadableError);
    expect((err as Error).message).to.include("EISDIR");
    expect(fs.statSync(filePath).isDirectory(), "nothing may have been written over it").to.equal(true);
  });

  it("recovers from syntactically valid JSON with an unexpected shape", async () => {
    fs.writeFileSync(filePath, "{}");

    const store = new ConfigStore({ filePath });
    await store.load();

    expect(store.getServerAuthToken()).to.be.undefined;
    expect(store.getPluginConfig("wing")).to.be.undefined;
    expect(fs.existsSync(filePath)).to.equal(false);

    const corruptFiles = fs.readdirSync(dir).filter((name) => name.includes(".corrupt-"));
    expect(corruptFiles).to.have.lengthOf(1);
  });

  it("serializes concurrent writes into a single valid JSON file", async () => {
    const store = new ConfigStore({ filePath });
    await store.load();

    const writes = Array.from({ length: 25 }, (_, i) => store.setPluginConfig("plugin" + i, { i }));
    await Promise.all(writes);

    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as { version: number; plugins: Record<string, { i: number }> };

    expect(parsed.version).to.equal(1);
    for (let i = 0; i < 25; i++) {
      expect(parsed.plugins["plugin" + i]).to.deep.equal({ i });
    }

    const leftoverTmpFiles = fs.readdirSync(dir).filter((name) => name.includes(".tmp-"));
    expect(leftoverTmpFiles).to.have.lengthOf(0);
  });

  it("scoped() reads and writes through the parent store", async () => {
    const store = new ConfigStore({ filePath });
    await store.load();
    const scoped = store.scoped("wing");

    expect(scoped.get()).to.be.undefined;
    await scoped.set({ host: "wing.local" });

    expect(scoped.get()).to.deep.equal({ host: "wing.local" });
    expect(store.getPluginConfig("wing")).to.deep.equal({ host: "wing.local" });
  });

  // This file holds the master auth token, every dynamically-registered OAuth client's secret, and
  // the passkey state. Node defaults new files to 0o666 & ~umask — 0644 under the usual umask 022
  // — so any local account could read the lot.
  describe("file permissions", () => {
    // eslint-disable-next-line no-bitwise -- the permission bits of a file mode
    const modeOf = (target: string): number => fs.statSync(target).mode & 0o777;

    it("writes the config file readable only by its owner", async function () {
      if (process.platform === "win32") this.skip();
      const store = new ConfigStore({ filePath });
      await store.load();
      await store.setServerAuthToken("s3cret");

      expect(modeOf(filePath).toString(8)).to.equal("600");
    });

    it("creates the parent directory accessible only by its owner", async function () {
      if (process.platform === "win32") this.skip();
      const nestedPath = path.join(dir, "fresh", "config.json");
      const store = new ConfigStore({ filePath: nestedPath });
      await store.load();

      expect(modeOf(path.dirname(nestedPath)).toString(8)).to.equal("700");
    });

    it("tightens a config file written before the server enforced permissions", async function () {
      if (process.platform === "win32") this.skip();
      // What an install upgraded from an earlier version actually looks like on disk.
      fs.writeFileSync(filePath, JSON.stringify({ version: 1, server: { authToken: "old" }, plugins: {} }));
      fs.chmodSync(filePath, 0o644);

      const store = new ConfigStore({ filePath });
      await store.load();

      expect(modeOf(filePath).toString(8)).to.equal("600");
      expect(store.getServerAuthToken(), "the contents must survive the chmod").to.equal("old");
    });
  });
});
