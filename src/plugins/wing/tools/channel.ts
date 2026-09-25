import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CHANNEL_COUNT, channelPath } from "../wing-node-paths.js";
import type { WingPluginContext } from "../wing-plugin.js";
import { parseDumpNumber } from "../wing-value-codec.js";
import { faderDbSchema, textResult, wrapWingTool } from "./generic.js";
import { flattenIdentity, readStripIdentity } from "../wing-identity.js";
import { resolveInputNameTarget } from "./physical-source.js";

const channelIndexSchema = z.number().int().min(1).max(CHANNEL_COUNT);

export function registerChannelTools(server: McpServer, ctx: WingPluginContext): void {
  server.registerTool(
    "wing_channel_get_fader",
    {
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      title: "Wing: Get channel fader",
      description: "Reads a channel's fader level in dB.",
      inputSchema: { channel: channelIndexSchema },
    },
    ({ channel }) =>
      wrapWingTool(async () => {
        const result = await ctx.client.get(channelPath(channel, "fdr"));
        const db = result.kind === "leaf" ? Number(result.value) : NaN;
        return {
          content: [textResult(`Channel ${channel} fader: ${db} dB`)],
          structuredContent: { channel, db },
        };
      }),
  );

  server.registerTool(
    "wing_channel_set_fader",
    {
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      title: "Wing: Set channel fader",
      description: "Sets a channel's fader level in dB (-144..10, -144 = -oo) via an ACK'd bulk-set.",
      inputSchema: { channel: channelIndexSchema, db: faderDbSchema },
    },
    ({ channel, db }) =>
      wrapWingTool(async () => {
        const ack = await ctx.client.bulkSet(channelPath(channel), { fdr: db });
        return {
          content: [textResult(`Channel ${channel} fader set to ${db} dB: ${ack.status}`)],
          structuredContent: { channel, db, ...ack },
        };
      }),
  );

  server.registerTool(
    "wing_channel_get_mute",
    {
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      title: "Wing: Get channel mute",
      description: "Reads whether a channel is muted.",
      inputSchema: { channel: channelIndexSchema },
    },
    ({ channel }) =>
      wrapWingTool(async () => {
        const result = await ctx.client.get(channelPath(channel, "mute"));
        const muted = result.kind === "leaf" && Number(result.value) === 1;
        return {
          content: [textResult(`Channel ${channel} is ${muted ? "muted" : "unmuted"}`)],
          structuredContent: { channel, muted },
        };
      }),
  );

  server.registerTool(
    "wing_channel_set_mute",
    {
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      title: "Wing: Set channel mute",
      description: "Sets a channel's mute state via an ACK'd bulk-set.",
      inputSchema: { channel: channelIndexSchema, muted: z.boolean() },
    },
    ({ channel, muted }) =>
      wrapWingTool(async () => {
        const ack = await ctx.client.bulkSet(channelPath(channel), { mute: muted ? 1 : 0 });
        return {
          content: [textResult(`Channel ${channel} mute set to ${muted}: ${ack.status}`)],
          structuredContent: { channel, muted, ...ack },
        };
      }),
  );

  server.registerTool(
    "wing_channel_toggle_mute",
    {
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      title: "Wing: Toggle channel mute",
      description:
        "Toggles a channel's mute state. Tries the ACK'd bulk-set toggle convention (mute=-1) first; if the " +
        "console does not acknowledge that as OK, falls back to the primitive SET -1 toggle (which has no " +
        "ack) and reports that no ack was available for that fallback.",
      inputSchema: { channel: channelIndexSchema },
    },
    ({ channel }) =>
      wrapWingTool(async () => {
        const ack = await ctx.client.bulkSet(channelPath(channel), { mute: -1 });
        if (ack.ok) {
          return {
            content: [textResult(`Channel ${channel} mute toggled: ${ack.status}`)],
            structuredContent: { channel, ackOk: true, status: ack.status },
          };
        }
        await ctx.client.toggle(channelPath(channel, "mute"));
        return {
          content: [
            textResult(
              `Channel ${channel} mute toggled via fallback SET -1 (bulk-set toggle was not acknowledged as ` +
                `OK: ${ack.status}; no ack is available for the fallback)`,
            ),
          ],
          structuredContent: { channel, ackOk: false },
        };
      }),
  );

  server.registerTool(
    "wing_channel_set_name",
    {
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      title: "Wing: Set channel name",
      description:
        "Sets a channel's display name (max 16 characters) via an ACK'd bulk-set. If the channel's input is " +
        "linked to its physical source (auto-name-from-source enabled), the channel's own name field is not " +
        "what's displayed — this renames the source instead, which is what will actually show on the console " +
        "(and affects every other channel/aux sharing that same source).",
      inputSchema: { channel: channelIndexSchema, name: z.string().min(1).max(16) },
    },
    ({ channel, name }) =>
      wrapWingTool(async () => {
        const target = await resolveInputNameTarget(ctx, "channel", channel);
        const ack = await ctx.client.bulkSet(target.baseNode, { name });
        if (ack.ok) {
          for (const path of target.cachePaths) {
            ctx.cache.applyChange({ path, value: name });
          }
        }
        return {
          content: [
            textResult(
              target.viaSource
                ? `Channel ${channel}'s name is linked to its input source — renamed the source ` +
                    `(${target.baseNode}) to "${name}" instead: ${ack.status}`
                : `Channel ${channel} name set to "${name}": ${ack.status}`,
            ),
          ],
          structuredContent: { channel, name, viaSource: target.viaSource, baseNode: target.baseNode, ...ack },
        };
      }),
  );

  server.registerTool(
    "wing_channel_set_pan",
    {
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      title: "Wing: Set channel pan",
      description: "Sets a channel's pan position (-100..100) via an ACK'd bulk-set.",
      inputSchema: { channel: channelIndexSchema, pan: z.number().min(-100).max(100) },
    },
    ({ channel, pan }) =>
      wrapWingTool(async () => {
        const ack = await ctx.client.bulkSet(channelPath(channel), { pan });
        return {
          content: [textResult(`Channel ${channel} pan set to ${pan}: ${ack.status}`)],
          structuredContent: { channel, pan, ...ack },
        };
      }),
  );

  server.registerTool(
    "wing_channel_get_summary",
    {
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      title: "Wing: Get channel summary",
      description:
        "Dumps a channel strip's key parameters (name, fader dB, mute, pan) in one request. `name` is the " +
        "effective display name — what the console surface shows. Identity is also broken down: `ownName` / " +
        "`sourceName` / `effectiveName` (and the same for col and icon), `nameLinkedToSource` (the strip's " +
        "`clink`; not `in/set/srcauto`, which is the unrelated auto source switch), and the patched `source` " +
        "{group, index, stereo, pair, label} as the console displays it (a stereo pair is reported by its first " +
        "member, e.g. A9-10).",
      inputSchema: { channel: channelIndexSchema },
    },
    ({ channel }) =>
      wrapWingTool(async () => {
        const dump = await ctx.client.dump(channelPath(channel));
        const identity = flattenIdentity(await readStripIdentity(ctx, "ch", channel, dump));
        ctx.cache.applyChange({ path: channelPath(channel, "name"), value: identity.effectiveName });
        const summary = {
          channel,
          name: identity.effectiveName,
          db: dump.fdr !== undefined ? (parseDumpNumber(dump.fdr) ?? NaN) : NaN,
          muted: Number(dump.mute) === 1,
          pan: dump.pan !== undefined ? (parseDumpNumber(dump.pan) ?? NaN) : NaN,
          ...identity,
        };
        const link = identity.nameLinkedToSource ? ` (linked to ${identity.source?.label ?? "source"})` : "";
        const src = identity.source ? `, input ${identity.source.label}${identity.sourceName ? ` "${identity.sourceName}"` : ""}` : "";
        return {
          content: [
            textResult(
              `Channel ${channel}: "${summary.name}"${link}, ${summary.db} dB, ` +
                `${summary.muted ? "muted" : "unmuted"}, pan ${summary.pan}${src}`,
            ),
          ],
          structuredContent: summary,
        };
      }),
  );
}
