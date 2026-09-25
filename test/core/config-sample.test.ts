// data/config.sample.json is the only file under data/ that is tracked: the real config.json holds the
// auth token, the OAuth clients' credentials and the passkeys, and is never committed. The sample is
// what someone copies to start from, so it must stay loadable by the current schemas — and must never
// grow a secret.

import { expect } from "chai";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigStore } from "../../src/core/config-store.js";
import { SecurityConfigSchema } from "../../src/core/security-config.js";
import { resolveEnabledTools, ToolVisibilitySchema } from "../../src/core/tool-visibility.js";
import { TransportConfigSchema } from "../../src/core/transport-config.js";
import { buildWingToolCatalogue } from "../../src/plugins/wing/tool-catalogue.js";
import { WingConfigSchema } from "../../src/plugins/wing/wing-config.js";

const SAMPLE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "data", "config.sample.json");

describe("data/config.sample.json", () => {
  const sample = JSON.parse(fs.readFileSync(SAMPLE_PATH, "utf8")) as {
    server: Record<string, unknown>;
    plugins: Record<string, unknown>;
  };

  it("carries no secret: no auth token, OAuth client, OAuth token or passkey", () => {
    for (const key of ["authToken", "oauthClients", "oauthTokens", "passkeys"]) {
      expect(sample.server, key).to.not.have.property(key);
    }
  });

  it("loads through ConfigStore without being quarantined as corrupt", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wing-mcp-sample-"));
    try {
      const filePath = path.join(dir, "config.json");
      fs.copyFileSync(SAMPLE_PATH, filePath);
      const store = new ConfigStore({ filePath });
      await store.load();
      expect(fs.readdirSync(dir).filter((name) => name.includes(".corrupt-"))).to.deep.equal([]);
      expect(store.getPluginConfig("wing")).to.deep.equal(sample.plugins.wing);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("validates every block against its own schema, with no key that the schema would drop", () => {
    // `.strict()` so a key renamed in the code but not in the sample fails here instead of being
    // silently stripped the first time the server rewrites the file.
    expect(() => SecurityConfigSchema.strict().parse(sample.server.security)).to.not.throw();
    expect(() => TransportConfigSchema.strict().parse(sample.server.transports)).to.not.throw();
    expect(() => ToolVisibilitySchema.strict().parse(sample.server.tools)).to.not.throw();
    const wing = WingConfigSchema.parse(sample.plugins.wing);
    expect(Object.keys(wing).sort()).to.deep.equal(Object.keys(sample.plugins.wing as object).sort());
  });

  it("names a tool profile the WING catalogue actually has", async () => {
    const catalogue = await buildWingToolCatalogue();
    const resolved = resolveEnabledTools(ToolVisibilitySchema.parse(sample.server.tools), catalogue);
    expect(resolved.unknown).to.deep.equal([]);
  });
});
