// Every tool must declare all four MCP annotation hints. Nothing distinguished a fader read from
// wing_wlive_format_sd_card, wing_save_to_flash or wing_scene_recall before this — on a console
// driven live, that is the difference between a client asking first and not.
//
// The sweep below matters more than the spot checks: without it the next tool someone adds simply
// has no annotations, and the coverage rots from its first day.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { expect } from "chai";
import { registerWingTools } from "../../../src/plugins/wing/tools/index.js";
import type { WingPluginContext } from "../../../src/plugins/wing/wing-plugin.js";

interface ListedTool {
  name: string;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

describe("WING tool annotations", () => {
  let tools: ListedTool[];
  let client: Client;

  before(async () => {
    const server = new McpServer({ name: "annotations-test", version: "0.0.0" });
    // Registration never touches the context — only the handlers do, and none are called here.
    registerWingTools(server, {} as unknown as WingPluginContext);
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "annotations-client", version: "0.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    tools = (await client.listTools()).tools as ListedTool[];
  });

  after(async () => {
    await client.close();
  });

  const find = (name: string): ListedTool => {
    const tool = tools.find((t) => t.name === name);
    if (!tool) throw new Error(`no such tool: ${name}`);
    return tool;
  };

  it("declares all four hints, as booleans, on every single tool", () => {
    const missing = tools
      .filter((tool) => {
        const a = tool.annotations;
        return (
          typeof a?.readOnlyHint !== "boolean" ||
          typeof a?.destructiveHint !== "boolean" ||
          typeof a?.idempotentHint !== "boolean" ||
          typeof a?.openWorldHint !== "boolean"
        );
      })
      .map((tool) => tool.name);
    expect(missing, `tools missing annotations: ${missing.join(", ")}`).to.deep.equal([]);
    expect(tools.length).to.be.greaterThan(100);
  });

  it("marks reads read-only", () => {
    for (const name of ["wing_get", "wing_dump", "wing_describe", "wing_list_names", "wing_channel_get_fader"]) {
      expect(find(name).annotations?.readOnlyHint, name).to.equal(true);
    }
  });

  it("does not mark a write read-only", () => {
    for (const name of ["wing_set", "wing_channel_set_fader", "wing_scene_recall", "wing_save_to_flash"]) {
      expect(find(name).annotations?.readOnlyHint, name).to.equal(false);
    }
  });

  it("flags the tools that erase or replace something as destructive", () => {
    for (const name of [
      "wing_wlive_format_sd_card", // erases the card
      "wing_preset_delete",
      "wing_mic_calibration_delete",
      "wing_save_to_flash", // overwrites the console's stored show
      "wing_scene_recall", // replaces the entire live state
      "wing_preset_load",
    ]) {
      expect(find(name).annotations?.destructiveHint, name).to.equal(true);
    }
  });

  it("does not cry wolf on an ordinary write", () => {
    for (const name of ["wing_channel_set_fader", "wing_channel_set_mute", "wing_set_send"]) {
      expect(find(name).annotations?.destructiveHint, name).to.equal(false);
    }
  });

  it("marks toggles and relative moves as non-idempotent", () => {
    for (const name of [
      "wing_channel_toggle_mute",
      "wing_mutegroup_toggle",
      "wing_adjust_value_by_delta",
      "wing_scene_next",
      "wing_scene_prev",
      // These measure live audio and set whatever it implies, so two runs need not agree.
      "wing_auto_gain",
      "wing_auto_compress",
    ]) {
      expect(find(name).annotations?.idempotentHint, name).to.equal(false);
    }
  });

  it("marks absolute-value setters as idempotent", () => {
    for (const name of ["wing_channel_set_fader", "wing_channel_set_mute", "wing_set", "wing_bulk_set"]) {
      expect(find(name).annotations?.idempotentHint, name).to.equal(true);
    }
  });

  it("marks every tool as open-world, since they all reach a device on the network", () => {
    const closed = tools.filter((tool) => tool.annotations?.openWorldHint !== true).map((tool) => tool.name);
    expect(closed).to.deep.equal([]);
  });
});
