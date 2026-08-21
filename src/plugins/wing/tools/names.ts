import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  AUX_COUNT,
  BUS_COUNT,
  CHANNEL_COUNT,
  DCA_COUNT,
  MAIN_COUNT,
  MATRIX_COUNT,
  MUTEGROUP_COUNT,
  auxPath,
  busPath,
  channelPath,
  dcaPath,
  mainPath,
  matrixPath,
  mutegroupPath,
} from "../wing-node-paths.js";
import type { WingPluginContext } from "../wing-plugin.js";
import { textResult, wrapWingTool } from "./generic.js";

interface NamedEntry {
  index: number;
  name: string;
}

/**
 * Reads the `name` leaf directly (one `get()` per index) rather than `dump()`-ing each parent node
 * — cheaper on the wire, and sidesteps a known bug where dumping certain deeply-nested nodes (see
 * wing-value-codec.ts's parseFlatAssignmentString) can mis-key fields with a spurious leading dot.
 * A console error on any single index (unreachable, out of range) yields an empty name for that
 * index rather than failing the whole listing.
 */
async function readNames(ctx: WingPluginContext, pathOf: (n: number) => string, count: number): Promise<NamedEntry[]> {
  return Promise.all(
    Array.from({ length: count }, (_, i) => i + 1).map(async (n) => {
      try {
        const result = await ctx.client.get(pathOf(n));
        return { index: n, name: result.kind === "leaf" ? String(result.value) : "" };
      } catch {
        return { index: n, name: "" };
      }
    }),
  );
}

function formatSection(label: string, entries: NamedEntry[]): string {
  const lines = entries.map((e) => `  ${e.index}: ${e.name || "(unnamed)"}`);
  return `${label}:\n${lines.join("\n")}`;
}

export function registerNameListTools(server: McpServer, ctx: WingPluginContext): void {
  server.registerTool(
    "wing_list_names",
    {
      title: "Wing: List all channel/bus/DCA/mute group names",
      description:
        "Reads the `name` field of every channel, aux, bus, main, matrix, DCA, and mute group in one call — " +
        "useful for getting an overview of how the console is labeled before referring to a specific strip by " +
        "index in another tool call. An index with no custom name comes back as whatever the console " +
        "currently has stored there (often blank).",
    },
    () =>
      wrapWingTool(async () => {
        const [channels, auxes, buses, mains, matrices, dcas, mutegroups] = await Promise.all([
          readNames(ctx, (n) => channelPath(n, "name"), CHANNEL_COUNT),
          readNames(ctx, (n) => auxPath(n, "name"), AUX_COUNT),
          readNames(ctx, (n) => busPath(n, "name"), BUS_COUNT),
          readNames(ctx, (n) => mainPath(n, "name"), MAIN_COUNT),
          readNames(ctx, (n) => matrixPath(n, "name"), MATRIX_COUNT),
          readNames(ctx, (n) => dcaPath(n, "name"), DCA_COUNT),
          readNames(ctx, (n) => mutegroupPath(n, "name"), MUTEGROUP_COUNT),
        ]);

        const text = [
          formatSection("Channels", channels),
          formatSection("Aux", auxes),
          formatSection("Buses", buses),
          formatSection("Mains", mains),
          formatSection("Matrices", matrices),
          formatSection("DCAs", dcas),
          formatSection("Mute groups", mutegroups),
        ].join("\n\n");

        return {
          content: [textResult(text)],
          structuredContent: { channels, auxes, buses, mains, matrices, dcas, mutegroups },
        };
      }),
  );
}
