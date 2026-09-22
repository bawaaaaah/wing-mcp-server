// The drift guard: WING_TOOL_GROUPS is a hand-maintained table next to 38 auto-imported
// register*Tools functions. Nothing stops someone adding tools/foo.ts, wiring it into
// registerWingTools by hand, and forgetting to give it a group — the tool would then work fine
// and simply never be individually toggleable. This file fails the build the moment that happens,
// by comparing the table against the module list itself rather than a hand-copied count.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { expect } from "chai";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WING_TOOL_GROUPS, registerWingTools } from "../../../src/plugins/wing/tools/index.js";
import type { WingPluginContext } from "../../../src/plugins/wing/wing-plugin.js";

const TOOLS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../src/plugins/wing/tools");

describe("WING_TOOL_GROUPS (anti-drift guard)", () => {
  it("has a unique, kebab-case id for every group", () => {
    const ids = WING_TOOL_GROUPS.map((group) => group.id);
    expect(new Set(ids).size, "group ids must be unique").to.equal(ids.length);
    for (const id of ids) expect(id).to.match(/^[a-z0-9-]+$/);
  });

  it("gives every group a non-empty label and description", () => {
    for (const group of WING_TOOL_GROUPS) {
      expect(group.label, group.id).to.not.equal("");
      expect(group.description, group.id).to.not.equal("");
    }
  });

  it("covers every register*Tools module under tools/, except index.ts itself", () => {
    // Sourced from the filesystem by parsing the source text, not from a hand-copied count or a
    // dynamic import (whose module identity is not reliable across tsx's loader) — so a new
    // tools/*.ts file with an exported register*Tools function is caught even if index.ts's
    // WING_TOOL_GROUPS table is never touched.
    const files = fs.readdirSync(TOOLS_DIR).filter((file) => file.endsWith(".ts") && file !== "index.ts");

    const exportedByFile = new Map<string, string[]>();
    for (const file of files) {
      const source = fs.readFileSync(path.join(TOOLS_DIR, file), "utf8");
      const names = [...source.matchAll(/^export function (register\w*Tools)\(/gm)].map((match) => match[1]);
      if (names.length > 0) exportedByFile.set(file, names);
    }

    const groupedNames = new Set(WING_TOOL_GROUPS.map((group) => group.register.name));
    const missing: string[] = [];
    for (const [file, names] of exportedByFile) {
      for (const name of names) {
        if (!groupedNames.has(name)) missing.push(`${file}: ${name}`);
      }
    }
    expect(missing, "a register*Tools export with no WING_TOOL_GROUPS entry").to.deep.equal([]);

    // And the reverse: no group should name a function tools/ no longer exports (a stale entry
    // left behind by a rename), which checking "missing" alone wouldn't catch.
    const allExportedNames = new Set([...exportedByFile.values()].flat());
    const stale = WING_TOOL_GROUPS.filter((group) => !allExportedNames.has(group.register.name)).map((g) => g.id);
    expect(stale, "a WING_TOOL_GROUPS entry whose register function tools/ no longer exports").to.deep.equal([]);
  });

  it("attributes every registered tool to exactly one group, matching tools/list exactly", async () => {
    const groupByTool = new Map<string, string>();
    const server = new McpServer({ name: "groups-test", version: "0.0.0" });
    registerWingTools(server, {} as unknown as WingPluginContext, (groupId, name) => {
      expect(groupByTool.has(name), `${name} registered twice`).to.equal(false);
      groupByTool.set(name, groupId);
    });

    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "groups-test-client", version: "0.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const { tools } = await client.listTools();
      const listedNames = new Set(tools.map((tool) => tool.name));
      expect(new Set(groupByTool.keys())).to.deep.equal(listedNames);

      const validGroupIds = new Set(WING_TOOL_GROUPS.map((group) => group.id));
      for (const [name, groupId] of groupByTool) {
        expect(validGroupIds.has(groupId), `${name} attributed to unknown group ${groupId}`).to.equal(true);
      }
    } finally {
      await client.close();
    }
  });

  it("gives every group at least one tool", async () => {
    const counts = new Map<string, number>();
    const server = new McpServer({ name: "groups-nonempty-test", version: "0.0.0" });
    registerWingTools(server, {} as unknown as WingPluginContext, (groupId) => {
      counts.set(groupId, (counts.get(groupId) ?? 0) + 1);
    });
    for (const group of WING_TOOL_GROUPS) {
      expect(counts.get(group.id), `group ${group.id} registered no tools`).to.be.greaterThan(0);
    }
  });

  it("does not call the deprecated tool() overload anywhere under tools/", () => {
    // server.tool(...) returns the same RegisteredTool shape as registerTool(...) but is not
    // routed through the same call in a normal (non-catalogue-building) registration — a module
    // using it would silently escape per-tool visibility during a real session.
    const files = fs.readdirSync(TOOLS_DIR).filter((file) => file.endsWith(".ts") && file !== "index.ts");
    const offenders = files.filter((file) => /\bserver\.tool\(/.test(fs.readFileSync(path.join(TOOLS_DIR, file), "utf8")));
    expect(offenders).to.deep.equal([]);
  });
});
