import type { WingPluginContext } from "./wing-plugin.js";

function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) (dp[0] as number[])[j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const row = dp[i] as number[];
      const prev = dp[i - 1] as number[];
      row[j] = Math.min((prev[j] as number) + 1, (row[j - 1] as number) + 1, (prev[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return (dp[a.length] as number[])[b.length] as number;
}

/**
 * The closest existing paths to one the console did not recognize. The console gives no error for
 * an unknown path — a GET simply never gets a reply, a bulk-set acks NODE NOT FOUND — so this walks
 * up to the deepest ancestor that answers as a branch, then ranks its children against the first
 * segment that failed. Best effort: returns [] when nothing above the path answers either.
 */
export async function suggestPaths(ctx: WingPluginContext, path: string, limit = 5): Promise<string[]> {
  const segments = path.split("/").filter(Boolean);
  for (let depth = segments.length - 1; depth >= 0 && depth >= segments.length - 3; depth--) {
    const parent = `/${segments.slice(0, depth).join("/")}`;
    const result = await ctx.client.get(parent).catch(() => null);
    if (!result || result.kind !== "branch") continue;
    const wanted = (segments[depth] ?? "").toLowerCase();
    const rest = segments.slice(depth + 1).join("/");
    const prefix = parent === "/" ? "" : parent;
    return result.children
      .map((child) => ({ child, score: editDistance(wanted, child.toLowerCase()) - (child.toLowerCase().startsWith(wanted.slice(0, 2)) ? 1 : 0) }))
      .sort((x, y) => x.score - y.score)
      .slice(0, limit)
      .map(({ child }) => `${prefix}/${child}${rest ? `/${rest}` : ""}`);
  }
  return [];
}

export async function pathHint(ctx: WingPluginContext, path: string): Promise<string> {
  const suggestions = await suggestPaths(ctx, path).catch(() => []);
  return suggestions.length ? ` Did you mean: ${suggestions.join(", ")}? (wing_get on a branch lists its children.)` : "";
}
