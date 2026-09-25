import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PluginToolCatalogue, ToolCatalogueEntry, ToolGroupInfo, ToolProfile } from "../../core/tool-catalogue.js";
import { UNGROUPED_ID, summarizeDescription } from "../../core/tool-catalogue.js";
import { WING_TOOL_GROUPS, registerWingTools } from "./tools/index.js";
import type { WingPluginContext } from "./wing-plugin.js";

/**
 * The groups a show running live actually needs: the typed convenience families for channels,
 * buses, DCAs, scenes, sends and fades, plus the generic escape hatch and the batched name
 * listing. Deliberately excludes anything that measures live audio (the `automation` category),
 * patching/routing setup, and anything show-management (presets, USB, lighting) — those are
 * either one-time setup or optional extras, not what every call during a show needs.
 */
const CORE_PROFILE_GROUPS = [
  "generic",
  "journal",
  "channel",
  "bus-main-matrix",
  "dca-mutegroup",
  "names",
  "fade",
  "scenes",
  "groups",
  "routing",
  "delay",
  "selected-strip",
];

function buildProfiles(): ToolProfile[] {
  return [
    {
      id: "all",
      label: "Everything",
      description: "Every tool this server registers. The default — nothing is hidden.",
      groups: WING_TOOL_GROUPS.map((group) => group.id),
    },
    {
      id: "core",
      label: "Core mixing",
      description: "Channels, buses, DCAs, scenes, sends, fades and names — what running a show needs day to day.",
      groups: CORE_PROFILE_GROUPS,
    },
    {
      id: "none",
      label: "Nothing",
      description: "A blank slate. Pick individual groups or tools with `enable`.",
      groups: [],
    },
    {
      id: "safe",
      label: "Read-only",
      description:
        "Every tool that only reads — wing_get, wing_channel_get_fader, wing_scene_list, and so on across " +
        "every family — and nothing that can move a fader, recall a scene or touch the console in any way. " +
        "For handing to a client you don't want mutating the console at all.",
      groups: [],
      readOnlyOnly: true,
    },
  ];
}

let cached: Promise<PluginToolCatalogue> | undefined;

/**
 * Registers the whole WING tool surface into a throwaway, never-connected `McpServer` and
 * measures what a real client actually receives over `tools/list` — byte-exact, and immune to
 * SDK versions changing what gets attached to a registered tool (execution metadata, title
 * defaults, …) the way hand-rebuilding the JSON Schema would not be.
 *
 * Touches no console, no socket, no persisted config: `{} as WingPluginContext` is safe here
 * because `registerWingTools` only ever reads `ctx` from inside a tool *handler*, never at
 * registration time — already pinned by `wing-tool-annotations.test.ts`, which registers the
 * same surface the same way.
 *
 * Memoized: the catalogue describes the code, not a running instance, so it is built once per
 * process and reused for the dashboard, `GET /api/tools`, and every session's visibility check.
 */
export function buildWingToolCatalogue(): Promise<PluginToolCatalogue> {
  cached ??= doBuild();
  return cached;
}

/** Test-only: forces the next `buildWingToolCatalogue()` call to rebuild instead of reusing the cache. */
export function resetWingToolCatalogueCacheForTests(): void {
  cached = undefined;
}

async function doBuild(): Promise<PluginToolCatalogue> {
  const groupByTool = new Map<string, string>();
  const server = new McpServer({ name: "wing-tool-catalogue-probe", version: "0.0.0" });
  registerWingTools(server, {} as unknown as WingPluginContext, (groupId, name) => {
    groupByTool.set(name, groupId);
  });

  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "wing-tool-catalogue-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  try {
    const { tools: listed } = await client.listTools();
    const tools: ToolCatalogueEntry[] = listed.map((tool) => {
      const annotations = tool.annotations as { readOnlyHint?: boolean } | undefined;
      return {
        name: tool.name,
        title: tool.title,
        summary: summarizeDescription(tool.description),
        group: groupByTool.get(tool.name) ?? UNGROUPED_ID,
        bytes: Buffer.byteLength(JSON.stringify(tool)),
        readOnly: annotations?.readOnlyHint === true,
      };
    });

    const groups: ToolGroupInfo[] = WING_TOOL_GROUPS.map((group) => ({
      id: group.id,
      label: group.label,
      description: group.description,
      category: group.category,
    }));

    return { pluginId: "wing", groups, tools, profiles: buildProfiles() };
  } finally {
    await client.close();
    await server.close();
  }
}
