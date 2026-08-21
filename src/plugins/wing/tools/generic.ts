import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, TextContent } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { WingError, WingValueError } from "../wing-errors.js";
import { discoverWingConsoles } from "../wing-discovery.js";
import type { WingPluginContext } from "../wing-plugin.js";

/**
 * Wraps a tool handler so any thrown `WingError` (timeout, protocol ack
 * failure, out-of-range value, queue overflow, unreachable console, ...)
 * turns into a normal tool-visible failure (`{isError: true, content: [...]}`)
 * instead of propagating as a JSON-RPC error — per the plan, tool failures
 * must be visible to the calling LLM as a tool result, not a transport-level
 * error. Anything that is *not* a `WingError` (a programmer bug, e.g. a bad
 * zod schema) is rethrown so it surfaces loudly instead of being silently
 * absorbed here.
 */
export async function wrapWingTool(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof WingError) {
      return { isError: true, content: [{ type: "text", text: err.message }] };
    }
    throw err;
  }
}

export function textResult(text: string): TextContent {
  return { type: "text", text };
}

/**
 * Only per-index node roots (and the `$ctl` control/scene namespace) are
 * safe to `wing_dump`: the console's OSC transport caps a single UDP
 * datagram at 32KB, and dumping a whole root namespace (e.g. "/", "/ch",
 * "/io") is easily large enough to exceed that and fail mysteriously against
 * the console. This allowlist rejects anything else up front with a clear
 * error instead.
 */
const DUMP_ALLOWED_INDEXED_ROOT_RE = /^\/(ch|aux|bus|main|mtx|dca|mgrp|fx)\/\d+(\/[^*?#]*)?$/;
const DUMP_ALLOWED_CTL_RE = /^\/\$ctl(\/[^*?#]*)?$/;

export function assertDumpPathAllowed(path: string): void {
  if (DUMP_ALLOWED_INDEXED_ROOT_RE.test(path) || DUMP_ALLOWED_CTL_RE.test(path)) {
    return;
  }
  throw new WingValueError(
    `wing_dump only allows per-index node roots (e.g. "/ch/3", "/bus/1", "/main/2", "/mtx/1", "/dca/1", ` +
      `"/mgrp/1", "/fx/2") or "/$ctl/..." — refusing to dump "${path}" (dumping whole root namespaces like ` +
      `"/", "/ch", or "/io" can exceed the console's 32KB OSC UDP packet limit)`,
  );
}

/**
 * Splits a leaf OSC path into the `{baseNode, key}` pair expected by
 * `bulkSet()`. E.g. "/ch/1/fdr" -> {baseNode: "/ch/1", key: "fdr"};
 * "/ch/1/eq/on" -> {baseNode: "/ch/1/eq", key: "on"} — the compact bulk-set
 * format lets `baseNode` be any node (not just a top-level indexed one), so
 * a simple "split at the last slash" is sufficient and correct.
 */
export function splitLeafPath(path: string): { baseNode: string; key: string } {
  const idx = path.lastIndexOf("/");
  if (idx <= 0) {
    return { baseNode: "/", key: path.slice(idx + 1) };
  }
  return { baseNode: path.slice(0, idx), key: path.slice(idx + 1) };
}

export function registerGenericTools(server: McpServer, ctx: WingPluginContext): void {
  server.registerTool(
    "wing_get",
    {
      title: "Wing: Get node value",
      description:
        "Reads a single WING OSC node. Returns the leaf value (display string, raw 0..1, and real value) if " +
        "the path is a leaf, or the list of child names if it is a branch.",
      inputSchema: { path: z.string().regex(/^\//, "path must start with /") },
    },
    ({ path }) =>
      wrapWingTool(async () => {
        const result = await ctx.client.get(path);
        const text =
          result.kind === "leaf"
            ? `${path} = ${result.display ?? result.value} (${result.valueKind})`
            : `${path} has ${result.children.length} children: ${result.children.join(", ")}`;
        return { content: [textResult(text)], structuredContent: { ...result } };
      }),
  );

  server.registerTool(
    "wing_set",
    {
      title: "Wing: Set node value",
      description:
        "Sets a single WING OSC leaf value using the ACK'd bulk-set primitive (splits the path into its parent " +
        "node and key), so the tool call can report whether the console actually accepted it.",
      inputSchema: {
        path: z.string().regex(/^\//, "path must start with /"),
        value: z.union([z.number(), z.string()]),
      },
    },
    ({ path, value }) =>
      wrapWingTool(async () => {
        const { baseNode, key } = splitLeafPath(path);
        const ack = await ctx.client.bulkSet(baseNode, { [key]: value });
        return {
          content: [textResult(`Set ${path} = ${value}: ${ack.status}`)],
          structuredContent: { path, value, ...ack },
        };
      }),
  );

  server.registerTool(
    "wing_dump",
    {
      title: "Wing: Dump subtree",
      description:
        "Dumps every parameter under a per-index WING node (e.g. /ch/3, /bus/1, /dca/2, /$ctl/lib) as a flat " +
        "key/value map. Restricted to per-index roots to avoid exceeding the console's 32KB OSC UDP packet limit.",
      inputSchema: { path: z.string().regex(/^\//, "path must start with /") },
    },
    ({ path }) =>
      wrapWingTool(async () => {
        assertDumpPathAllowed(path);
        const entries = await ctx.client.dump(path);
        const count = Object.keys(entries).length;
        return {
          content: [textResult(`Dumped ${count} parameter(s) under ${path}`)],
          structuredContent: { path, entries },
        };
      }),
  );

  server.registerTool(
    "wing_describe",
    {
      title: "Wing: Describe node",
      description:
        "Fetches the WING console's metadata description ('?') or description+current-values ('#') for a node.",
      inputSchema: {
        path: z.string().regex(/^\//, "path must start with /"),
        includeValues: z.boolean().optional(),
      },
    },
    ({ path, includeValues }) =>
      wrapWingTool(async () => {
        const description = await ctx.client.describe(path, includeValues);
        return {
          content: [textResult(description.lines.length > 0 ? description.lines.join("\n") : description.raw)],
          structuredContent: { ...description },
        };
      }),
  );

  server.registerTool(
    "wing_discover",
    {
      title: "Wing: Discover consoles on the network",
      description:
        "Broadcasts a WING discovery query ('WING?') on the local network and returns any consoles that " +
        "reply (ip, name, model, serial, firmware). Useful for finding a console's IP address before " +
        "configuring the plugin's host. Always resolves — zero consoles responding (broadcast blocked, " +
        "different subnet, ...) is a normal outcome, not an error.",
    },
    () =>
      wrapWingTool(async () => {
        const { discoveryPort } = ctx.getConfig();
        const results = await discoverWingConsoles({ port: discoveryPort });
        const text =
          results.length === 0
            ? "No WING console responded to the discovery broadcast."
            : results.map((r) => `${r.name} (${r.model}) at ${r.ip} — serial ${r.serial}, firmware ${r.firmware}`).join("\n");
        return { content: [textResult(text)], structuredContent: { results } };
      }),
  );

  server.registerTool(
    "wing_bulk_set",
    {
      title: "Wing: Bulk set",
      description:
        "Sets multiple keys under a single WING node in one ACK'd request (the console's native compact " +
        "bulk-set format).",
      inputSchema: {
        baseNode: z.string().regex(/^\//, "baseNode must start with /"),
        assignments: z.record(z.union([z.number(), z.string()])),
      },
    },
    ({ baseNode, assignments }) =>
      wrapWingTool(async () => {
        const ack = await ctx.client.bulkSet(baseNode, assignments);
        return {
          content: [textResult(`Bulk-set ${Object.keys(assignments).length} key(s) on ${baseNode}: ${ack.status}`)],
          structuredContent: { baseNode, assignments, ...ack },
        };
      }),
  );
}
