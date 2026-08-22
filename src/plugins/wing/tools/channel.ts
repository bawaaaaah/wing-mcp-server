import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CHANNEL_COUNT, channelPath, ioInPath } from "../wing-node-paths.js";
import type { WingPluginContext } from "../wing-plugin.js";
import { textResult, wrapWingTool } from "./generic.js";
import { readEffectiveName } from "./names.js";
import { resolvePhysicalSource } from "./physical-source.js";

const channelIndexSchema = z.number().int().min(1).max(CHANNEL_COUNT);

/**
 * Where a rename of this channel should actually be written. Verified against real hardware: with
 * `in/set/srcauto=1` the console mirrors the connected physical input's own name as the channel's
 * effective `$name`, ignoring the channel's own `name` leaf entirely — so writing `name` on a linked
 * channel is silently invisible. In that state the only way to change what's actually shown is to
 * rename the source itself, which is also what every other channel/aux linked to the same input will
 * then display — an inherent consequence of the console's own design, not something to special-case.
 * Falls back to renaming the channel directly if the link state can't be determined (timeout) or the
 * channel isn't linked (same as today).
 */
async function resolveChannelNameTarget(
  ctx: WingPluginContext,
  channel: number,
): Promise<{ baseNode: string; cachePaths: string[]; viaSource: boolean }> {
  const direct = { baseNode: channelPath(channel), cachePaths: [channelPath(channel, "name")], viaSource: false };
  const srcauto = await ctx.client.get(channelPath(channel, "in/set/srcauto")).catch(() => null);
  if (!srcauto || srcauto.kind !== "leaf" || Number(srcauto.value) !== 1) {
    return direct;
  }
  const source = await resolvePhysicalSource(ctx, channelPath(channel));
  if (!source) {
    return direct;
  }
  return {
    baseNode: ioInPath(source.group, source.index),
    cachePaths: [ioInPath(source.group, source.index, "name"), channelPath(channel, "name")],
    viaSource: true,
  };
}

export function registerChannelTools(server: McpServer, ctx: WingPluginContext): void {
  server.registerTool(
    "wing_channel_get_fader",
    {
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
      title: "Wing: Set channel fader",
      description: "Sets a channel's fader level in dB (-144..10, -144 = -oo) via an ACK'd bulk-set.",
      inputSchema: { channel: channelIndexSchema, db: z.number() },
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
        const target = await resolveChannelNameTarget(ctx, channel);
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
      title: "Wing: Get channel summary",
      description:
        "Dumps a channel strip's key parameters (name, fader dB, mute, pan) in one request. `name` is the " +
        "effective display name — the linked source's name when the channel's input has auto-name-from-source " +
        "enabled, not the channel's own (possibly blank) name field.",
      inputSchema: { channel: channelIndexSchema },
    },
    ({ channel }) =>
      wrapWingTool(async () => {
        const [dump, name] = await Promise.all([
          ctx.client.dump(channelPath(channel)),
          readEffectiveName(ctx, channelPath(channel, "name"), channelPath(channel, "$name")),
        ]);
        const summary = {
          channel,
          name,
          db: dump.fdr !== undefined ? Number(dump.fdr) : NaN,
          muted: Number(dump.mute) === 1,
          pan: dump.pan !== undefined ? Number(dump.pan) : NaN,
        };
        return {
          content: [
            textResult(
              `Channel ${channel}: "${summary.name}", ${summary.db} dB, ` +
                `${summary.muted ? "muted" : "unmuted"}, pan ${summary.pan}`,
            ),
          ],
          structuredContent: summary,
        };
      }),
  );
}
