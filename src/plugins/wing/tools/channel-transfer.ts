import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CHANNEL_SCOPES, transferChannel, type TransferReport } from "../wing-channel-copy.js";
import type { WingPluginContext } from "../wing-plugin.js";
import { assertShowModeAllows } from "../wing-write.js";
import { textResult, wrapWingTool } from "./generic.js";

const scopeSchema = z
  .array(z.enum(CHANNEL_SCOPES))
  .min(1)
  .optional()
  .describe(
    "What to move (default [\"all\"]): source (input patch), preamp (trim/balance/delay/invert), name (+ its " +
      "source link), color, icon, filters, gate, eq, dyn, inserts, fader, pan, mute, sends, mains, dcaTags, " +
      "muteGroups, or all — everything a scene stores for the strip.",
  );

const common = {
  kind: z.enum(["ch", "aux"]).optional().describe("Default ch."),
  scope: scopeSchema,
  dryRun: z.boolean().optional().describe("Return the key-by-key diff without writing."),
  muteDuring: z
    .boolean()
    .optional()
    .describe("Mute the strips while writing and restore the mutes afterwards, so nothing half-copied is heard."),
  confirm: z.boolean().optional().describe("Required when show mode is on (these writes are audible)."),
};

function describeReport(r: TransferReport): string {
  const lines: string[] = [];
  if (r.dryRun) {
    for (const [strip, keys] of Object.entries(r.diffs ?? {})) {
      lines.push(`${strip}: ${keys.length} key(s) would change`);
      for (const k of keys.slice(0, 40)) lines.push(`  ${k.key}: ${JSON.stringify(k.current)} -> ${JSON.stringify(k.next)}`);
      if (keys.length > 40) lines.push(`  … ${keys.length - 40} more (see structuredContent.diffs)`);
    }
  } else {
    for (const s of r.strips) {
      lines.push(`${s.strip}: ${s.status} — ${s.changed.length} key(s) written, ${s.planned} checked`);
      for (const m of s.mismatches.slice(0, 20)) lines.push(`  ✗ ${m.key}: expected ${JSON.stringify(m.expected)}, stored ${JSON.stringify(m.stored)}`);
    }
  }
  if (r.references.length) {
    lines.push(`References ${r.referencesUpdated ? "updated" : r.dryRun ? "that would be updated" : "(not updated)"}:`);
    for (const ref of r.references) lines.push(`  ${ref.what}: ${JSON.stringify(ref.current)} -> ${JSON.stringify(ref.next)}`);
  }
  for (const w of r.warnings) lines.push(`⚠ ${w}`);
  return lines.join("\n");
}

export function registerChannelTransferTools(server: McpServer, ctx: WingPluginContext): void {
  server.registerTool(
    "wing_channel_copy",
    {
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
      title: "Wing: Copy a channel onto another",
      description:
        "Copies a channel (or aux) strip onto another: everything a scene stores for it, or only the chosen " +
        "`scope`. The target's previous settings are overwritten (journaled — wing_undo restores them). Every " +
        "key is verified by re-reading the target. Run with `dryRun: true` first to see the diff. Copying " +
        "inserts makes both strips insert the same FX slot. Nothing that points at the source strip (user " +
        "signals, sidechains) is changed by a copy.",
      inputSchema: {
        from: z.number().int().min(1),
        to: z.number().int().min(1),
        ...common,
      },
    },
    ({ from, to, kind, scope, dryRun, muteDuring, confirm }) =>
      wrapWingTool(async () => {
        if (!dryRun) assertShowModeAllows(ctx, [`/${kind ?? "ch"}/${to}`], confirm);
        const report = await transferChannel(ctx, kind ?? "ch", "copy", from, to, { scopes: scope ?? ["all"], dryRun, muteDuring });
        return {
          content: [textResult(`Copy ${kind ?? "ch"} ${from} -> ${to}${dryRun ? " (dry run)" : ""}\n${describeReport(report)}`)],
          structuredContent: { ...report },
          isError: report.ok ? undefined : true,
        };
      }),
  );

  server.registerTool(
    "wing_channel_swap",
    {
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      title: "Wing: Swap two channels",
      description:
        "Swaps two channel (or aux) strips — \"move Fatouma to channel 2 and Marisa to channel 3\" — for " +
        "everything a scene stores, or only `scope`. When the input patch moves (scope all or source), whatever " +
        "pointed at either strip is re-pointed too: user signals 1-24 tapping them and every channel's gate/dyn " +
        "sidechain source; the report lists each one. `muteDuring: true` keeps both muted while writing. " +
        "Verified by re-reading both strips; journaled, so wing_undo swaps back. Try `dryRun: true` first.",
      inputSchema: {
        a: z.number().int().min(1),
        b: z.number().int().min(1),
        updateReferences: z.boolean().optional().describe("Default true."),
        ...common,
      },
    },
    ({ a, b, kind, scope, dryRun, muteDuring, confirm, updateReferences }) =>
      wrapWingTool(async () => {
        if (!dryRun) assertShowModeAllows(ctx, [`/${kind ?? "ch"}/${a}`, `/${kind ?? "ch"}/${b}`], confirm);
        const report = await transferChannel(ctx, kind ?? "ch", "swap", a, b, {
          scopes: scope ?? ["all"],
          dryRun,
          muteDuring,
          updateReferences,
        });
        return {
          content: [textResult(`Swap ${kind ?? "ch"} ${a} <-> ${b}${dryRun ? " (dry run)" : ""}\n${describeReport(report)}`)],
          structuredContent: { ...report },
          isError: report.ok ? undefined : true,
        };
      }),
  );
}
