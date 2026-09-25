import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { WingQueueOverflowError } from "../wing-errors.js";
import { readStripIdentity, type StripIdentity, type StripKind } from "../wing-identity.js";
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
  /** "cache": served from the push-fed cache; "live": read from the console for this call. */
  source: "cache" | "live";
  /** When the served value was last known good (ISO time). */
  cachedAt: string;
}

/**
 * One name-bearing category. `cachePath` is the plain `name` leaf, which is also the address the
 * OSC subscription's shadow-canonicalization collapses `$name` pushes onto (see
 * `canonicalizeShadowAddress` in wing-osc-client.ts) — so it's the key both the live-updated state
 * cache and a cold-start fetch agree to store under.
 *
 * `livePath` is what actually gets GET'd on a cache miss. Channel/aux/bus/main/matrix strips expose
 * a read-only `$name` shadow that mirrors the *effective* displayed name — verified against real
 * hardware that when a strip's input is connected with `clink=1`, `$name` mirrors the
 * connected physical input's own name (`/io/in/{grp}/{n}/name`) rather than the strip's own `name`
 * field, which can sit blank or stale while linked. DCAs and mute groups aren't tied to a physical
 * source and have no `$name` shadow at all, so their live path is just the plain leaf.
 */
interface NameCategory {
  key: "channels" | "auxes" | "buses" | "mains" | "matrices" | "dcas" | "mutegroups";
  kind: StripKind;
  label: string;
  count: number;
  cachePath: (n: number) => string;
  livePath: (n: number) => string;
}

const NAME_CATEGORIES: readonly NameCategory[] = [
  { key: "channels", kind: "ch", label: "Channels", count: CHANNEL_COUNT, cachePath: (n) => channelPath(n, "name"), livePath: (n) => channelPath(n, "$name") },
  { key: "auxes", kind: "aux", label: "Aux", count: AUX_COUNT, cachePath: (n) => auxPath(n, "name"), livePath: (n) => auxPath(n, "$name") },
  { key: "buses", kind: "bus", label: "Buses", count: BUS_COUNT, cachePath: (n) => busPath(n, "name"), livePath: (n) => busPath(n, "$name") },
  { key: "mains", kind: "main", label: "Mains", count: MAIN_COUNT, cachePath: (n) => mainPath(n, "name"), livePath: (n) => mainPath(n, "$name") },
  { key: "matrices", kind: "mtx", label: "Matrices", count: MATRIX_COUNT, cachePath: (n) => matrixPath(n, "name"), livePath: (n) => matrixPath(n, "$name") },
  { key: "dcas", kind: "dca", label: "DCAs", count: DCA_COUNT, cachePath: (n) => dcaPath(n, "name"), livePath: (n) => dcaPath(n, "name") },
  { key: "mutegroups", kind: "mgrp", label: "Mute groups", count: MUTEGROUP_COUNT, cachePath: (n) => mutegroupPath(n, "name"), livePath: (n) => mutegroupPath(n, "name") },
];

/**
 * How long a cached name is trusted without a push confirming it. The cache is push-fed and pushes
 * are reliable while the subscription is live, so this is a backstop, not the mechanism: it bounds
 * how long a name can stay wrong through a failure nothing detected (a scene loaded while the
 * console was unreachable, a push lost to UDP). Re-reading ~100 names every few minutes costs well
 * under a second on a LAN.
 */
const NAME_CACHE_TTL_MS = 5 * 60_000;

/**
 * Cache-first name read: the state cache is fed live by every OSC subscription push (a rename, a
 * source re-patch, a `clink` link/unlink, a rename of the linked source all push a fresh `$name` —
 * each verified against real hardware), so once warm this rarely touches the network. A miss, an
 * entry older than `NAME_CACHE_TTL_MS`, or `fresh` falls back to a live GET and re-seeds the cache.
 * Exported so per-index tools (e.g. a channel summary) share the exact same behavior.
 */
export async function readEffectiveNameEntry(
  ctx: WingPluginContext,
  cachePath: string,
  livePath: string,
  opts: { fresh?: boolean } = {},
): Promise<{ name: string; source: "cache" | "live"; cachedAt: number }> {
  const cached = ctx.cache.get(cachePath);
  if (cached !== undefined && !opts.fresh && Date.now() - cached.updatedAt < NAME_CACHE_TTL_MS) {
    return { name: String(cached.value), source: "cache", cachedAt: cached.updatedAt };
  }
  try {
    const result = await ctx.client.get(livePath);
    const name = result.kind === "leaf" ? String(result.value) : "";
    ctx.cache.applyChange({ path: cachePath, value: name });
    return { name, source: "live", cachedAt: Date.now() };
  } catch (err) {
    // A full request queue is not this entry's problem, it is the whole client's: swallowing it
    // here turned a systemic condition into a listing quietly full of blank names, with nothing
    // anywhere to say why. Everything else — an unreachable console, an out-of-range index — is
    // genuinely per-entry and still yields the last known name (or an empty one).
    if (err instanceof WingQueueOverflowError) {
      throw err;
    }
    return cached ? { name: String(cached.value), source: "cache", cachedAt: cached.updatedAt } : { name: "", source: "live", cachedAt: Date.now() };
  }
}

export async function readEffectiveName(ctx: WingPluginContext, cachePath: string, livePath: string): Promise<string> {
  return (await readEffectiveNameEntry(ctx, cachePath, livePath)).name;
}

/**
 * How many name reads may be in flight at once.
 *
 * This is not a throughput knob, it is a correctness one. The categories below total exactly 100
 * entries (40+8+16+4+8+16+8), and `WingOscClient`'s request queue holds exactly 100 by default —
 * so issuing them all in one tick, as a plain `Promise.all` did, filled the queue to the brim.
 * `enqueue()` rejects rather than blocks once full, so *every* concurrent caller — any MCP tool
 * call, any dashboard route, the 7s heartbeat — was rejected outright with "request queue is
 * full" for as long as the warm-up lasted, which against a slow console is one full
 * `requestTimeoutMs` per queued entry. Keeping a small number in flight leaves the queue almost
 * empty for everyone else, at no real cost to the warm-up: it is fired in the background anyway.
 */
const NAME_READ_CONCURRENCY = 8;

/** Runs `fn` over `items` with at most `limit` in flight, preserving input order in the results. */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let i = next++; i < items.length; i = next++) {
      results[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Reads every category's names under a single global concurrency bound. Bounding per category
 * would not help: all seven run together, so the in-flight total is what has to be capped.
 */
async function readAllCategoryNames(
  ctx: WingPluginContext,
  opts: { fresh?: boolean; categories?: readonly NameCategory[] } = {},
): Promise<NamedEntry[][]> {
  const categories = opts.categories ?? NAME_CATEGORIES;
  const targets = categories.flatMap((category, categoryIndex) =>
    Array.from({ length: category.count }, (_, i) => ({ category, categoryIndex, index: i + 1 })),
  );
  const names = await mapWithConcurrency(targets, NAME_READ_CONCURRENCY, (target) =>
    readEffectiveNameEntry(ctx, target.category.cachePath(target.index), target.category.livePath(target.index), opts),
  );
  const byCategory: NamedEntry[][] = categories.map(() => []);
  targets.forEach((target, i) => {
    const entry = names[i] as Awaited<ReturnType<typeof readEffectiveNameEntry>>;
    (byCategory[target.categoryIndex] as NamedEntry[]).push({
      index: target.index,
      name: entry.name,
      source: entry.source,
      cachedAt: new Date(entry.cachedAt).toISOString(),
    });
  });
  return byCategory;
}

/**
 * Eagerly warms the name cache for every category right after connecting, so the first real
 * `wing_list_names` call (or any per-strip name lookup) doesn't have to pay for ~100 sequential OSC
 * round trips itself. Meant to be fired in the background (not awaited by `start()`) — a slow or
 * partially-completed warm-up never produces a wrong answer, only a slower first read for whichever
 * indices it didn't get to in time, since the read path falls back to a live fetch and self-heals
 * the cache for anything still missing.
 */
export async function warmNames(ctx: WingPluginContext): Promise<void> {
  await readAllCategoryNames(ctx);
}

function formatSection(label: string, entries: { index: number; name: string }[]): string {
  const lines = entries.map((e) => `  ${e.index}: ${e.name || "(unnamed)"}`);
  return `${label}:\n${lines.join("\n")}`;
}

function formatDetailed(label: string, entries: StripIdentity[]): string {
  const lines = entries.map((e) => {
    const shown = e.effective.name || "(unnamed)";
    const parts = [`  ${e.index}: ${shown}`];
    if (e.nameLinkedToSource) parts.push(`[linked to ${e.source?.label ?? "no source"}; own name ${JSON.stringify(e.own.name)}]`);
    else if (e.source) parts.push(`<- ${e.source.label}${e.source.identity?.name ? ` "${e.source.identity.name}"` : ""}`);
    return parts.join(" ");
  });
  return `${label}:\n${lines.join("\n")}`;
}

const CATEGORY_KEYS = NAME_CATEGORIES.map((c) => c.key) as [NameCategory["key"], ...NameCategory["key"][]];

export function registerNameListTools(server: McpServer, ctx: WingPluginContext): void {
  server.registerTool(
    "wing_list_names",
    {
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      title: "Wing: List all channel/bus/DCA/mute group names",
      description:
        "Reads the effective display name of every channel, aux, bus, main, matrix, DCA, and mute group in a " +
        "single tool call — the name the console surface actually shows. Served from a cache fed by the " +
        "console's own change pushes (renames from the surface, re-patches, link toggles and scene loads all " +
        "update or flush it); every entry says whether it came from the `cache` or a `live` read and since " +
        "when. `fresh: true` forces a live read of everything. Always use this instead of calling `wing_get` " +
        "or `wing_channel_get_summary` once per index. A channel/aux linked to its source (`clink`) shows the " +
        "source's name. `detail: true` returns, per strip, the own vs effective name/color/icon, " +
        "`nameLinkedToSource`, and the patched source (group, index, stereo pair) with the source's own name — " +
        "slower (a few reads per strip, always live), so narrow it with `categories`.",
      inputSchema: {
        fresh: z.boolean().optional().describe("Bypass the cache and read every name from the console."),
        detail: z.boolean().optional().describe("Own/source/effective name, color, icon and patch per strip."),
        categories: z.array(z.enum(CATEGORY_KEYS)).optional().describe("Limit to these categories."),
      },
    },
    ({ fresh, detail, categories: wanted }) =>
      wrapWingTool(async () => {
        const categories = wanted ? NAME_CATEGORIES.filter((c) => wanted.includes(c.key)) : NAME_CATEGORIES;
        if (detail) {
          const targets = categories.flatMap((c) => Array.from({ length: c.count }, (_, i) => ({ c, index: i + 1 })));
          const identities = await mapWithConcurrency(targets, NAME_READ_CONCURRENCY, (t) =>
            readStripIdentity(ctx, t.c.kind, t.index),
          );
          const detailed: Record<string, StripIdentity[]> = {};
          categories.forEach((c) => (detailed[c.key] = identities.filter((id) => id.kind === c.kind)));
          const detailText = categories.map((c) => formatDetailed(c.label, detailed[c.key] as StripIdentity[])).join("\n\n");
          return { content: [textResult(detailText)], structuredContent: detailed };
        }
        const results = await readAllCategoryNames(ctx, { fresh, categories });
        const structured: Record<string, NamedEntry[]> = {};
        categories.forEach((c, i) => (structured[c.key] = results[i] as NamedEntry[]));
        const liveCount = results.flat().filter((e) => e.source === "live").length;
        const text =
          categories.map((category, i) => formatSection(category.label, results[i] as NamedEntry[])).join("\n\n") +
          `\n\n(${liveCount} read live, ${results.flat().length - liveCount} from cache)`;
        return {
          content: [textResult(text)],
          structuredContent: structured,
        };
      }),
  );
}
