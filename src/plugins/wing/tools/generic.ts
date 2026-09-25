import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, TextContent } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { WingError, WingTimeoutError, WingValueError } from "../wing-errors.js";
import { pathHint } from "../wing-path-hints.js";
import { discoverWingConsoles } from "../wing-discovery.js";
import { FADER_DB_MAX, FADER_DB_MIN } from "../wing-node-paths.js";
import type { WingPluginContext } from "../wing-plugin.js";
import { COLOR_DESCRIPTION, wingColorName } from "../wing-param-catalog.js";
import { describeWriteResult, writeAssignments } from "../wing-write.js";

/**
 * Shared by every `*_set_fader` tool. These setters call `bulkSet` directly rather than going
 * through `validateNodeValue`, so without bounds here nothing between the model and the console
 * checks the value at all — the range lived only in one tool's description text.
 */
export const faderDbSchema = z.number().min(FADER_DB_MIN).max(FADER_DB_MAX);

/** True for any node whose leaf is a `col` (channel/bus/main/mtx/dca/mgrp strip color) parameter. */
function isColorPath(path: string): boolean {
  return /\/col$/.test(path);
}

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

/**
 * Runs a read and, if the console never answered (its only way of saying "no such path"), rethrows
 * with the closest existing paths appended.
 */
async function withPathHint<T>(ctx: WingPluginContext, path: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof WingTimeoutError) {
      throw new WingTimeoutError(`${err.message} for ${path} — the console does not answer an unknown path.${await pathHint(ctx, path)}`);
    }
    throw err;
  }
}

export function textResult(text: string): TextContent {
  return { type: "text", text };
}

/**
 * Only nodes known to be small are safe to `wing_dump`: the console's OSC transport caps a single
 * UDP datagram at 32KB, and dumping a whole root namespace (e.g. "/", "/ch", "/io") is easily large
 * enough to exceed that and fail mysteriously against the console. Allowed: per-index strip/fx
 * roots, one I/O port or user signal (`/io/in/A/9`, `/io/out/LCL/3`, `/io/in/USR/14` — about a dozen
 * keys each), and the `$ctl` control/scene namespace.
 */
const DUMP_ALLOWED_INDEXED_ROOT_RE = /^\/(ch|aux|bus|main|mtx|dca|mgrp|fx)\/\d+(\/[^*?#]*)?$/;
const DUMP_ALLOWED_IO_PORT_RE = /^\/io\/(in|out)\/[A-Z]+\/\d+(\/[^*?#]*)?$/;
const DUMP_ALLOWED_CTL_RE = /^\/\$ctl(\/[^*?#]*)?$/;

export function assertDumpPathAllowed(path: string): void {
  if (DUMP_ALLOWED_INDEXED_ROOT_RE.test(path) || DUMP_ALLOWED_IO_PORT_RE.test(path) || DUMP_ALLOWED_CTL_RE.test(path)) {
    return;
  }
  throw new WingValueError(
    `wing_dump only allows per-index node roots (e.g. "/ch/3", "/bus/1", "/main/2", "/mtx/1", "/dca/1", ` +
      `"/mgrp/1", "/fx/2"), a single I/O port or user signal ("/io/in/A/9", "/io/out/LCL/3", "/io/in/USR/14") ` +
      `or "/$ctl/..." — refusing to dump "${path}" (dumping whole namespaces like "/", "/ch", or "/io" can ` +
      "exceed the console's 32KB OSC UDP packet limit). For many paths at once, use wing_get_many.",
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
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      title: "Wing: Get node value",
      description:
        "Reads a single WING OSC node. Returns the leaf value (display string, raw 0..1, and real value) if " +
        `the path is a leaf, or the list of child names if it is a branch. For a "col" leaf (channel/bus/main/` +
        "mtx/dca/mgrp strip color), the value is the console's 1..18 palette index — the returned text names " +
        `the color; the full palette is ${COLOR_DESCRIPTION}.`,
      inputSchema: { path: z.string().regex(/^\//, "path must start with /") },
    },
    ({ path }) =>
      wrapWingTool(async () => {
        const result = await withPathHint(ctx, path, () => ctx.client.get(path));
        const colorName =
          result.kind === "leaf" && isColorPath(path) && typeof result.value === "number"
            ? wingColorName(result.value)
            : undefined;
        const text =
          result.kind === "leaf"
            ? `${path} = ${result.display ?? result.value} (${result.valueKind})` + (colorName ? ` — ${colorName}` : "")
            : `${path} has ${result.children.length} children: ${result.children.join(", ")}`;
        return {
          content: [textResult(text)],
          structuredContent: colorName ? { ...result, colorName } : { ...result },
        };
      }),
  );

  server.registerTool(
    "wing_set",
    {
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      title: "Wing: Set node value",
      description:
        "Sets a single WING OSC leaf through the ACK'd bulk-set primitive, then reads it back: the result's " +
        "`results[0]` gives `previous`, `sent`, `stored` and `match`, and `status` is MISMATCH (not OK) if the " +
        "console stored something else. Strings are passed as-is — do not add quotes around them; spaces, " +
        "accents and punctuation are encoded for you. An empty string clears a name. `name` holds 16 UTF-8 " +
        "bytes and `tags` 80 (an accented letter counts 2); longer is refused rather than truncated. " +
        "`dryRun: true` reports current vs target without writing. `audible` says whether the write changes " +
        "the sound (anything but name/col/icon/led/tags/clink); with the server's show mode on, audible " +
        "writes need `confirm: true`. Every write is journaled — see wing_history / wing_undo.",
      inputSchema: {
        path: z.string().regex(/^\//, "path must start with /"),
        value: z.union([z.number(), z.string()]).describe("A number, an enum member, or free text (\"\" clears it)."),
        dryRun: z.boolean().optional(),
        verify: z.boolean().optional().describe("Read back and compare after writing. Default true; false for speed."),
        confirm: z.boolean().optional().describe("Required for an audible write when show mode is on."),
      },
    },
    ({ path, value, dryRun, verify, confirm }) =>
      wrapWingTool(async () => {
        const { baseNode, key } = splitLeafPath(path);
        const result = await writeAssignments(ctx, baseNode, { [key]: value }, { dryRun, verify, confirm });
        const hint = result.status === "NODE NOT FOUND" ? await pathHint(ctx, path) : "";
        return {
          content: [textResult(describeWriteResult(result) + hint)],
          structuredContent: { path, ...result },
          isError: result.ok ? undefined : true,
        };
      }),
  );

  server.registerTool(
    "wing_get_many",
    {
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      title: "Wing: Get many node values",
      description:
        "Reads up to 200 WING OSC leaves in one tool call and returns a `path -> value` map (plus a " +
        "per-path `display` for numeric leaves). Same single OSC queue underneath as wing_get, but one " +
        "round trip for the client — use it for audits instead of a wing_get per path. A path that fails " +
        "to read (unknown node, branch, timeout) comes back under `errors` rather than failing the call.",
      inputSchema: {
        paths: z.array(z.string().regex(/^\//, "path must start with /")).min(1).max(200),
      },
    },
    ({ paths }) =>
      wrapWingTool(async () => {
        const values: Record<string, number | string> = {};
        const displays: Record<string, string> = {};
        const errors: Record<string, string> = {};
        for (const path of paths) {
          try {
            const result = await ctx.client.get(path);
            if (result.kind !== "leaf") {
              errors[path] = `branch with children: ${result.children.join(", ")}`;
              continue;
            }
            values[path] = result.value;
            if (result.display !== undefined && result.display !== String(result.value)) displays[path] = result.display;
          } catch (err) {
            if (!(err instanceof WingError)) throw err;
            errors[path] = err.message;
          }
        }
        const lines = paths.map((p) => (p in values ? `${p} = ${displays[p] ?? values[p]}` : `${p}: ${errors[p]}`));
        return {
          content: [textResult(lines.join("\n"))],
          structuredContent: { values, displays, errors },
        };
      }),
  );

  server.registerTool(
    "wing_dump",
    {
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      title: "Wing: Dump subtree",
      description:
        "Dumps every parameter under a per-index WING node (e.g. /ch/3, /bus/1, /dca/2, /$ctl/lib) as a flat " +
        "key/value map. Restricted to per-index roots to avoid exceeding the console's 32KB OSC UDP packet limit.",
      inputSchema: { path: z.string().regex(/^\//, "path must start with /") },
    },
    ({ path }) =>
      wrapWingTool(async () => {
        assertDumpPathAllowed(path);
        const entries = await withPathHint(ctx, path, () => ctx.client.dump(path));
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
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      title: "Wing: Describe node",
      description:
        "Fetches the WING console's metadata description ('?') or description+current-values ('#') for a node. " +
        `A "col" leaf describes as a bare "int [1..18]" with no names — the console's fixed palette is ` +
        `${COLOR_DESCRIPTION}.`,
      inputSchema: {
        path: z.string().regex(/^\//, "path must start with /"),
        includeValues: z.boolean().optional(),
      },
    },
    ({ path, includeValues }) =>
      wrapWingTool(async () => {
        const description = await withPathHint(ctx, path, () => ctx.client.describe(path, includeValues));
        const lines = description.lines.length > 0 ? description.lines.join("\n") : description.raw;
        const text = isColorPath(path) ? `${lines}\nColor palette: ${COLOR_DESCRIPTION}` : lines;
        return {
          content: [textResult(text)],
          structuredContent: { ...description },
        };
      }),
  );

  server.registerTool(
    "wing_discover",
    {
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
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
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      title: "Wing: Bulk set",
      description:
        "Sets multiple keys under a single WING node in one ACK'd request (the console's native compact " +
        "bulk-set format; nested keys are dot-separated, e.g. {\"eq.on\": 1}), then reads every key back. " +
        "`results` lists {key, previous, sent, stored, match} per key and `status` is MISMATCH if any key " +
        "was stored differently — an OK ack alone does not prove the write. Strings are passed as-is, " +
        "without extra quotes. `dryRun`, `verify`, `confirm` and `audible` work as in wing_set.",
      inputSchema: {
        baseNode: z.string().regex(/^\//, "baseNode must start with /"),
        assignments: z.record(z.union([z.number(), z.string()])),
        dryRun: z.boolean().optional(),
        verify: z.boolean().optional(),
        confirm: z.boolean().optional(),
      },
    },
    ({ baseNode, assignments, dryRun, verify, confirm }) =>
      wrapWingTool(async () => {
        const result = await writeAssignments(ctx, baseNode, assignments, { dryRun, verify, confirm });
        let hint = "";
        if (result.status === "NODE NOT FOUND") {
          // The ack does not say which key; a key that cannot even be read back is the likely one.
          for (const r of result.results.filter((x) => x.previous === null)) hint += await pathHint(ctx, r.path);
        }
        return {
          content: [textResult(describeWriteResult(result) + hint)],
          structuredContent: { baseNode, ...result },
          isError: result.ok ? undefined : true,
        };
      }),
  );
}
