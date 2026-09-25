import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { WingValueError } from "../wing-errors.js";
import { joinNodePath } from "../wing-osc-client.js";
import type { WingPluginContext } from "../wing-plugin.js";
import { getCurrentScene } from "../wing-scenes.js";
import { validateNodeValue } from "../wing-value-codec.js";
import type { WingJournalBatch } from "../wing-write-journal.js";
import { assertShowModeAllows, describeWriteResult, writeAssignments, type WingWriteResult } from "../wing-write.js";
import { splitLeafPath, textResult, wrapWingTool } from "./generic.js";

function summarizeBatch(batch: WingJournalBatch): string {
  const when = new Date(batch.startedAt).toISOString();
  const flags = [batch.undoOf ? `undo of ${batch.undoOf}` : "", batch.undoneAt ? "undone" : ""].filter(Boolean);
  const head = `${batch.batchId} ${when} ${batch.origin} — ${batch.entries.length} write(s)${flags.length ? ` [${flags.join(", ")}]` : ""}`;
  const lines = batch.entries
    .slice(0, 12)
    .map((e) => `    ${e.path}: ${JSON.stringify(e.previous)} -> ${JSON.stringify(e.next)}${e.audible ? " (audible)" : ""}`);
  if (batch.entries.length > 12) lines.push(`    … ${batch.entries.length - 12} more`);
  return [head, ...lines].join("\n");
}

/**
 * The value each path held before `batch` first touched it, grouped by parent node so the restore
 * goes out as one bulk-set per node. A path written twice in the batch is restored to its value
 * before the *first* write; a path whose previous value was unreadable is skipped and reported.
 */
function planRestore(batch: WingJournalBatch): { byNode: Map<string, Record<string, number | string>>; skipped: string[] } {
  const firstPrevious = new Map<string, number | string | null>();
  for (const entry of batch.entries) {
    if (!firstPrevious.has(entry.path)) firstPrevious.set(entry.path, entry.previous);
  }
  const byNode = new Map<string, Record<string, number | string>>();
  const skipped: string[] = [];
  for (const [path, previous] of firstPrevious) {
    if (previous === null) {
      skipped.push(path);
      continue;
    }
    const { baseNode, key } = splitLeafPath(path);
    const node = byNode.get(baseNode) ?? {};
    node[key] = previous;
    byNode.set(baseNode, node);
  }
  return { byNode, skipped };
}

export function registerJournalTools(server: McpServer, ctx: WingPluginContext): void {
  server.registerTool(
    "wing_history",
    {
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      title: "Wing: Write history",
      description:
        "Lists the most recent write batches this server made (one batch per tool call), newest first, " +
        "with every key's previous and new value and whether it was audible. Pass a batch's id to " +
        "wing_undo. Covers wing_set, wing_bulk_set and every typed setter; fades and the auto-* tools " +
        "keep their own undo (wing_auto_eq_undo, wing_undo_last_adjust) and are not listed. Also reports " +
        "how many parameters have changed since the last scene load — the console itself exposes no " +
        "'unsaved' flag, so this is the server's own count (writes from any client, surface included).",
      inputSchema: { limit: z.number().int().min(1).max(200).optional() },
    },
    ({ limit }) =>
      wrapWingTool(async () => {
        const batches = ctx.journal.history(limit ?? 20);
        const unsaved = ctx.journal.unsavedChanges();
        const text =
          (batches.length === 0 ? "No journaled writes yet." : batches.map(summarizeBatch).join("\n")) +
          `\n\nParameters changed since last ${unsaved.since.kind} (${unsaved.since.at}): ${unsaved.count}`;
        return { content: [textResult(text)], structuredContent: { batches, unsavedChanges: unsaved } };
      }),
  );

  server.registerTool(
    "wing_undo",
    {
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      title: "Wing: Undo a write batch",
      description:
        "Restores every key a journaled write batch changed to the value it had before (default: the most " +
        "recent batch not yet undone; or pass `batchId` from wing_history). Restores are verified like any " +
        "write. `dryRun: true` shows what would be restored. The undo is itself journaled (and can be undone). " +
        "Undoing an old batch overwrites anything changed since on the same keys — check wing_history first.",
      inputSchema: {
        batchId: z.string().optional(),
        dryRun: z.boolean().optional(),
        confirm: z.boolean().optional().describe("Required to undo an audible batch when show mode is on."),
      },
    },
    ({ batchId, dryRun, confirm }) =>
      wrapWingTool(async () => {
        const batch = batchId ? ctx.journal.find(batchId) : ctx.journal.lastUndoable();
        if (!batch) {
          throw new WingValueError(batchId ? `No journaled batch "${batchId}" (see wing_history).` : "Nothing to undo.");
        }
        if (batch.undoneAt && !dryRun) {
          throw new WingValueError(`Batch ${batch.batchId} was already undone at ${new Date(batch.undoneAt).toISOString()}.`);
        }
        const { byNode, skipped } = planRestore(batch);
        // Validate the whole restore before writing any of it, so a value the catalog rejects cannot
        // leave the batch half undone.
        for (const [baseNode, assignments] of byNode) {
          for (const [key, value] of Object.entries(assignments)) validateNodeValue(joinNodePath(baseNode, key), value);
        }
        if (!dryRun) {
          assertShowModeAllows(ctx, batch.entries.filter((e) => e.audible).map((e) => e.path), confirm);
        }
        const run = async (): Promise<WingWriteResult[]> => {
          const writes: WingWriteResult[] = [];
          for (const [baseNode, assignments] of byNode) {
            // Show mode was checked for the whole batch above.
            writes.push(await writeAssignments(ctx, baseNode, assignments, { dryRun, confirm: true }));
          }
          return writes;
        };
        const results = dryRun ? await run() : await ctx.journal.runBatch("wing_undo", run, { undoOf: batch.batchId });
        const ok = results.every((r) => r.ok);
        if (!dryRun && ok) batch.undoneAt = Date.now();
        const text =
          `${dryRun ? "Would restore" : ok ? "Restored" : "Partially restored"} batch ${batch.batchId} (${batch.origin}):\n` +
          results.map(describeWriteResult).join("\n") +
          (skipped.length ? `\nNot restorable (previous value unknown): ${skipped.join(", ")}` : "");
        return {
          content: [textResult(text)],
          structuredContent: { undone: batch.batchId, ok, dryRun: Boolean(dryRun), results, skipped },
          isError: ok ? undefined : true,
        };
      }),
  );

  server.registerTool(
    "wing_status",
    {
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      title: "Wing: Connection status",
      description:
        "One-call health check: whether the console answers (with round-trip latency), its host, model, " +
        "name and firmware, the current scene, how many parameters have changed since the last scene load " +
        "(server-side count — the console has no 'unsaved' flag), the name cache's size and age, the OSC " +
        "queue depth, and whether show mode is on.",
    },
    () =>
      wrapWingTool(async () => {
        const config = ctx.getConfig();
        const started = Date.now();
        let reachable = true;
        let latencyMs: number | null = null;
        const info: Record<string, string> = {};
        try {
          for (const [key, path] of [
            ["model", "/$syscfg/$cnsmdl"],
            ["name", "/$syscfg/consolename"],
            ["firmware", "/$syscfg/$firmware"],
          ] as const) {
            const result = await ctx.client.get(path);
            if (latencyMs === null) latencyMs = Date.now() - started;
            if (result.kind === "leaf") info[key] = String(result.value);
          }
        } catch {
          reachable = latencyMs !== null;
        }
        let scene: Awaited<ReturnType<typeof getCurrentScene>> | null = null;
        if (reachable) {
          scene = await getCurrentScene(ctx).catch(() => null);
        }
        const cache = ctx.cache.stats();
        const unsaved = ctx.journal.unsavedChanges();
        const status = {
          reachable,
          host: config.host,
          latencyMs,
          console: info,
          scene,
          unsavedChanges: unsaved,
          cache: {
            entries: cache.entries,
            oldestAgeMs: cache.oldestAt === null ? null : Date.now() - cache.oldestAt,
            lastInvalidatedAt: cache.clearedAt === null ? null : new Date(cache.clearedAt).toISOString(),
          },
          queueDepth: ctx.client.getQueueDepth(),
          lastActivityAt: ctx.client.getLastActivityAt() === null ? null : new Date(ctx.client.getLastActivityAt() as number).toISOString(),
          showMode: config.showMode,
        };
        const text = reachable
          ? `Console ${info.name ?? "?"} (${info.model ?? "?"}, fw ${info.firmware ?? "?"}) at ${config.host} — ` +
            `${latencyMs} ms. Scene: ${scene ? `#${scene.index} ${scene.name || "(none)"}` : "?"}. ` +
            `${unsaved.count} parameter(s) changed since last ${unsaved.since.kind}. Cache: ${cache.entries} entries. ` +
            `Show mode ${config.showMode ? "ON" : "off"}.`
          : `Console at ${config.host || "(no host configured)"} is not answering.`;
        return { content: [textResult(text)], structuredContent: status };
      }),
  );
}
