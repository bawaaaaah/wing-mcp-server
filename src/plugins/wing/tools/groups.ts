import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
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
  mainPath,
  matrixPath,
} from "../wing-node-paths.js";
import { WingValueError } from "../wing-errors.js";
import { parseGroupTags, toggleGroupTag } from "../wing-group-tags.js";
import type { WingPluginContext } from "../wing-plugin.js";
import { textResult, wrapWingTool } from "./generic.js";

/**
 * DCA and mute-group membership for a strip. Deliberately excludes "dca" as a source: verified
 * live that `/dca/{n}` has no `tags` field at all on this console (unlike channel/aux/bus/main/
 * matrix), so a DCA cannot be added to another DCA or to a mute group through this mechanism —
 * whatever governs DCA-to-mute-group behavior (if it exists at all) lives elsewhere, most likely
 * under the unmodeled `/cfg/dcamgrp` namespace, and hasn't been verified against hardware yet.
 */
type GroupableType = "channel" | "aux" | "bus" | "main" | "matrix";

const GROUPABLE_COUNTS: Record<GroupableType, number> = {
  channel: CHANNEL_COUNT,
  aux: AUX_COUNT,
  bus: BUS_COUNT,
  main: MAIN_COUNT,
  matrix: MATRIX_COUNT,
};

function resolveGroupablePath(type: GroupableType, index: number): string {
  switch (type) {
    case "channel":
      return channelPath(index);
    case "aux":
      return auxPath(index);
    case "bus":
      return busPath(index);
    case "main":
      return mainPath(index);
    case "matrix":
      return matrixPath(index);
    default: {
      const exhaustive: never = type;
      throw new WingValueError(`Unknown groupable strip type: ${String(exhaustive)}`);
    }
  }
}

function assertIndexInRange(type: GroupableType, index: number): void {
  const max = GROUPABLE_COUNTS[type];
  if (!Number.isInteger(index) || index < 1 || index > max) {
    throw new WingValueError(`${type} index out of range: ${index} (expected 1..${max})`);
  }
}

/**
 * Reads `tags` with a direct leaf `get()`, never `dump()` on the parent node — verified live that
 * `dump()`'s flat-assignment parser mis-keys entries (a stray leading ".") on nodes with enough
 * nested sub-sections, which a full channel/bus/etc. node very much is.
 */
async function getTags(ctx: WingPluginContext, basePath: string): Promise<string> {
  const result = await ctx.client.get(`${basePath}/tags`);
  return result.kind === "leaf" ? String(result.value) : "";
}

const sourceTypeSchema = z.enum(["channel", "aux", "bus", "main", "matrix"]);

export function registerGroupTools(server: McpServer, ctx: WingPluginContext): void {
  server.registerTool(
    "wing_get_group_membership",
    {
      title: "Wing: Get DCA/mute group membership",
      description:
        "Reads which DCA(s) and mute group(s) a channel/aux/bus/main/matrix strip currently belongs to. " +
        "Membership isn't a separate OSC node — the console encodes it as reserved #D<n>/#M<n> tokens inside " +
        "the strip's own `tags` field, alongside any free-form tags — this tool decodes that for you. DCA " +
        "strips are not a valid `type` here (a DCA has no `tags` field on this console).",
      inputSchema: { type: sourceTypeSchema, index: z.number().int().min(1) },
    },
    ({ type, index }) =>
      wrapWingTool(async () => {
        assertIndexInRange(type, index);
        const path = resolveGroupablePath(type, index);
        const parsed = parseGroupTags(await getTags(ctx, path));
        return {
          content: [
            textResult(
              `${type} ${index}: DCA [${parsed.dca.join(", ") || "none"}], Mute groups [${parsed.mutegroups.join(", ") || "none"}]`,
            ),
          ],
          structuredContent: { type, index, dca: parsed.dca, mutegroups: parsed.mutegroups },
        };
      }),
  );

  server.registerTool(
    "wing_set_group_membership",
    {
      title: "Wing: Add/remove a strip's DCA or mute group membership",
      description:
        "Adds or removes a channel/aux/bus/main/matrix strip from DCA <group> or Mute group <group>, by " +
        "adding/removing the reserved #D<n>/#M<n> token in its `tags` field while preserving every other tag " +
        "already there. Uses the console's unacknowledged SET on `tags` directly rather than a bulk-set (bulk-" +
        "set's comma-separated compact format collides with a multi-tag value like \"#D3,#D9\" — confirmed " +
        "live to fail with a NODE NOT FOUND ack) and verifies the change by reading `tags` back, since SET has " +
        "no ack of its own. DCA strips are not a valid `type` here (a DCA has no `tags` field on this console, " +
        "so it cannot be assigned to another DCA or to a mute group through this mechanism).",
      inputSchema: {
        type: sourceTypeSchema,
        index: z.number().int().min(1),
        kind: z.enum(["dca", "mutegroup"]),
        group: z.number().int().min(1),
        on: z.boolean(),
      },
    },
    ({ type, index, kind, group, on }) =>
      wrapWingTool(async () => {
        assertIndexInRange(type, index);
        const maxGroup = kind === "dca" ? DCA_COUNT : MUTEGROUP_COUNT;
        if (!Number.isInteger(group) || group < 1 || group > maxGroup) {
          throw new WingValueError(`${kind} index out of range: ${group} (expected 1..${maxGroup})`);
        }

        const path = resolveGroupablePath(type, index);
        const currentTags = await getTags(ctx, path);
        const nextTags = toggleGroupTag(currentTags, kind, group, on);
        if (nextTags === null) {
          throw new WingValueError(
            "This would exceed the console's 80-character tags field on this strip — remove another tag first.",
          );
        }

        await ctx.client.set(`${path}/tags`, nextTags);
        const confirmedTags = await getTags(ctx, path);
        if (confirmedTags !== nextTags) {
          throw new WingValueError(
            `The console didn't accept the new tags value (expected ${JSON.stringify(nextTags)}, read back ${JSON.stringify(confirmedTags)}).`,
          );
        }

        const parsed = parseGroupTags(confirmedTags);
        return {
          content: [
            textResult(
              `${type} ${index} ${on ? "added to" : "removed from"} ${kind} ${group}. Now in DCA ` +
                `[${parsed.dca.join(", ") || "none"}], Mute groups [${parsed.mutegroups.join(", ") || "none"}].`,
            ),
          ],
          structuredContent: { type, index, kind, group, on, dca: parsed.dca, mutegroups: parsed.mutegroups },
        };
      }),
  );
}
