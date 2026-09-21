import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WingQueueOverflowError } from "../wing-errors.js";
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
  label: string;
  count: number;
  cachePath: (n: number) => string;
  livePath: (n: number) => string;
}

const NAME_CATEGORIES: readonly NameCategory[] = [
  { key: "channels", label: "Channels", count: CHANNEL_COUNT, cachePath: (n) => channelPath(n, "name"), livePath: (n) => channelPath(n, "$name") },
  { key: "auxes", label: "Aux", count: AUX_COUNT, cachePath: (n) => auxPath(n, "name"), livePath: (n) => auxPath(n, "$name") },
  { key: "buses", label: "Buses", count: BUS_COUNT, cachePath: (n) => busPath(n, "name"), livePath: (n) => busPath(n, "$name") },
  { key: "mains", label: "Mains", count: MAIN_COUNT, cachePath: (n) => mainPath(n, "name"), livePath: (n) => mainPath(n, "$name") },
  { key: "matrices", label: "Matrices", count: MATRIX_COUNT, cachePath: (n) => matrixPath(n, "name"), livePath: (n) => matrixPath(n, "$name") },
  { key: "dcas", label: "DCAs", count: DCA_COUNT, cachePath: (n) => dcaPath(n, "name"), livePath: (n) => dcaPath(n, "name") },
  { key: "mutegroups", label: "Mute groups", count: MUTEGROUP_COUNT, cachePath: (n) => mutegroupPath(n, "name"), livePath: (n) => mutegroupPath(n, "name") },
];

/**
 * Cache-first name read: the state cache is fed live by every subsequent OSC subscription push (a
 * rename, a source re-patch, a `clink` link/unlink all provoke a fresh `$name` push that lands on
 * `cachePath` via the same canonicalization), so once warm this never touches the network. A miss
 * (nothing pushed for this path yet — e.g. right after connect, before `warmNames()` gets to it, or
 * for a value that has simply never changed) falls back to a live GET and seeds the cache with the
 * result, so the same path is never fetched live twice. Exported so per-index tools (e.g. a channel
 * summary) can share the exact same cache/fallback behavior instead of re-implementing it.
 */
export async function readEffectiveName(ctx: WingPluginContext, cachePath: string, livePath: string): Promise<string> {
  const cached = ctx.cache.get(cachePath);
  if (cached !== undefined) {
    return String(cached.value);
  }
  try {
    const result = await ctx.client.get(livePath);
    const name = result.kind === "leaf" ? String(result.value) : "";
    ctx.cache.applyChange({ path: cachePath, value: name });
    return name;
  } catch (err) {
    // A full request queue is not this entry's problem, it is the whole client's: swallowing it
    // here turned a systemic condition into a listing quietly full of blank names, with nothing
    // anywhere to say why. Everything else — an unreachable console, an out-of-range index — is
    // genuinely per-entry and still yields an empty name rather than failing the listing.
    if (err instanceof WingQueueOverflowError) {
      throw err;
    }
    return "";
  }
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
async function readAllCategoryNames(ctx: WingPluginContext): Promise<NamedEntry[][]> {
  const targets = NAME_CATEGORIES.flatMap((category, categoryIndex) =>
    Array.from({ length: category.count }, (_, i) => ({ category, categoryIndex, index: i + 1 })),
  );
  const names = await mapWithConcurrency(targets, NAME_READ_CONCURRENCY, (target) =>
    readEffectiveName(ctx, target.category.cachePath(target.index), target.category.livePath(target.index)),
  );
  const byCategory: NamedEntry[][] = NAME_CATEGORIES.map(() => []);
  targets.forEach((target, i) => {
    (byCategory[target.categoryIndex] as NamedEntry[]).push({ index: target.index, name: names[i] as string });
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
        "Reads the effective display name of every channel, aux, bus, main, matrix, DCA, and mute group in a " +
        "single tool call, served from a live-updated cache (instant once warm — only a cold, never-seen index " +
        "pays for a real OSC round trip). Always use this instead of calling `wing_get` or " +
        "`wing_channel_get_summary` once per index when you need names for more than one strip: doing that " +
        "one-by-one still funnels through the same single in-flight OSC queue underneath, so it is strictly " +
        "slower and burns one tool call per strip for no benefit. Only use a per-index tool when you already " +
        "know the specific index you need. A channel/aux/bus/main/matrix whose input is linked to its source " +
        "(auto-name from source) reports the source's name here, not its own (possibly blank) `name` field — " +
        "that's the name actually shown on the console. An index with no name at all comes back blank. Because " +
        "linked strips surface their source's name rather than their own, this listing doubles as a read of the " +
        "console's input patch: scanning it tells you which physical input feeds which channel/aux/bus/main/matrix " +
        "without a dedicated patch-table query.",
    },
    () =>
      wrapWingTool(async () => {
        const results = await readAllCategoryNames(ctx);
        const [channels, auxes, buses, mains, matrices, dcas, mutegroups] = results;

        const text = NAME_CATEGORIES.map((category, i) => formatSection(category.label, results[i])).join("\n\n");

        return {
          content: [textResult(text)],
          structuredContent: { channels, auxes, buses, mains, matrices, dcas, mutegroups },
        };
      }),
  );
}
