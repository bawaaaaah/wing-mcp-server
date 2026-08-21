import fs from "node:fs/promises";
import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WingPluginContext } from "./wing-plugin.js";

interface WingDocManifestEntry {
  id: string;
  path: string;
  title: string;
}

/**
 * Mirrors the doc manifest in docs/wing-protocol/README.md. Kept in sync by
 * hand — both sides are small and reviewed as normal code (per the plan),
 * rather than generated, since this list changes rarely.
 */
const WING_DOC_MANIFEST: WingDocManifestEntry[] = [
  { id: "overview", path: "docs/wing-protocol/01-overview.md", title: "WING Overview" },
  { id: "osc-protocol", path: "docs/wing-protocol/02-osc-protocol.md", title: "OSC Protocol" },
  {
    id: "native-binary-protocol",
    path: "docs/wing-protocol/03-native-binary-protocol.md",
    title: "Native Binary Protocol",
  },
  { id: "metering", path: "docs/wing-protocol/04-metering.md", title: "Metering" },
  { id: "node-tree", path: "docs/wing-protocol/05-node-tree/README.md", title: "Node Tree Overview" },
  { id: "node-tree/channel", path: "docs/wing-protocol/05-node-tree/channel.md", title: "Channel Node Tree" },
  { id: "node-tree/bus", path: "docs/wing-protocol/05-node-tree/bus.md", title: "Bus Node Tree" },
  { id: "node-tree/main", path: "docs/wing-protocol/05-node-tree/main.md", title: "Main Node Tree" },
  { id: "node-tree/matrix", path: "docs/wing-protocol/05-node-tree/matrix.md", title: "Matrix Node Tree" },
  { id: "node-tree/dca", path: "docs/wing-protocol/05-node-tree/dca.md", title: "DCA Node Tree" },
  { id: "node-tree/mutegroup", path: "docs/wing-protocol/05-node-tree/mutegroup.md", title: "Mute Group Node Tree" },
  { id: "scenes-and-library", path: "docs/wing-protocol/06-scenes-and-library.md", title: "Scenes & Library" },
  { id: "value-encoding", path: "docs/wing-protocol/07-value-encoding.md", title: "Value Encoding" },
  { id: "model-differences", path: "docs/wing-protocol/08-model-differences.md", title: "Model Differences" },
  { id: "error-codes", path: "docs/wing-protocol/09-error-codes.md", title: "Error Codes" },
];

/**
 * Resolves a manifest entry to a real file:// URL, relative to this file's
 * own location (src/plugins/wing/resources.ts) rather than `process.cwd()`
 * — three levels up from here is the project root, where docs/wing-protocol
 * lives.
 */
function docFileUrl(entry: WingDocManifestEntry): URL {
  return new URL(`../../../${entry.path}`, import.meta.url);
}

export function registerWingResources(server: McpServer, ctx: WingPluginContext): void {
  server.registerResource(
    "wing-console-overview",
    "wing://console/overview",
    {
      title: "WING Console Overview",
      description:
        "Live snapshot of the console's cached state (channel names/mute/fader, DCAs, active scene) — " +
        "instantaneous if the cache is warm, otherwise bounded to a first-access refresh.",
      mimeType: "application/json",
    },
    async (uri) => {
      const snapshot = await ctx.buildOverviewSnapshot();
      return {
        contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(snapshot) }],
      };
    },
  );

  // "+file" (RFC 6570 reserved expansion) rather than plain "file" so that
  // ids containing a "/" (e.g. "node-tree/channel") are captured whole
  // instead of being blocked at the first path separator.
  const docsTemplate = new ResourceTemplate("wing-docs://{+file}", {
    list: async () => ({
      resources: WING_DOC_MANIFEST.map((entry) => ({
        uri: `wing-docs://${entry.id}`,
        name: entry.id,
        title: entry.title,
        mimeType: "text/markdown",
      })),
    }),
  });

  server.registerResource(
    "wing-docs",
    docsTemplate,
    {
      title: "WING Protocol Docs",
      description: "Serves the markdown files under docs/wing-protocol/ as navigable MCP resources.",
      mimeType: "text/markdown",
    },
    async (uri, variables) => {
      const fileId = Array.isArray(variables.file) ? variables.file[0] : variables.file;
      const entry = WING_DOC_MANIFEST.find((candidate) => candidate.id === fileId);
      if (!entry) {
        throw new Error(`Unknown wing-docs resource id: ${String(fileId)}`);
      }
      // Missing file at read time (e.g. still being written by the docs
      // agent) is allowed to propagate as-is rather than being masked here.
      const text = await fs.readFile(docFileUrl(entry), "utf8");
      return {
        contents: [{ uri: uri.href, mimeType: "text/markdown", text }],
      };
    },
  );
}
