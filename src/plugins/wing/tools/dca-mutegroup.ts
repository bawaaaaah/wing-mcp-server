import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DCA_COUNT, MUTEGROUP_COUNT, dcaPath, mutegroupPath } from "../wing-node-paths.js";
import type { WingPluginContext } from "../wing-plugin.js";
import { faderDbSchema, textResult, wrapWingTool } from "./generic.js";

const dcaIndexSchema = z.number().int().min(1).max(DCA_COUNT);
const mutegroupIndexSchema = z.number().int().min(1).max(MUTEGROUP_COUNT);

export function registerDcaMutegroupTools(server: McpServer, ctx: WingPluginContext): void {
  server.registerTool(
    "wing_dca_get_fader",
    {
      title: "Wing: Get DCA fader",
      description: "Reads a DCA's fader level in dB.",
      inputSchema: { dca: dcaIndexSchema },
    },
    ({ dca }) =>
      wrapWingTool(async () => {
        const result = await ctx.client.get(dcaPath(dca, "fdr"));
        const db = result.kind === "leaf" ? Number(result.value) : NaN;
        return {
          content: [textResult(`DCA ${dca} fader: ${db} dB`)],
          structuredContent: { dca, db },
        };
      }),
  );

  server.registerTool(
    "wing_dca_set_fader",
    {
      title: "Wing: Set DCA fader",
      description: "Sets a DCA's fader level in dB (-144..10, -144 = -oo) via an ACK'd bulk-set.",
      inputSchema: { dca: dcaIndexSchema, db: faderDbSchema },
    },
    ({ dca, db }) =>
      wrapWingTool(async () => {
        const ack = await ctx.client.bulkSet(dcaPath(dca), { fdr: db });
        return {
          content: [textResult(`DCA ${dca} fader set to ${db} dB: ${ack.status}`)],
          structuredContent: { dca, db, ...ack },
        };
      }),
  );

  server.registerTool(
    "wing_dca_get_mute",
    {
      title: "Wing: Get DCA mute",
      description: "Reads whether a DCA is muted.",
      inputSchema: { dca: dcaIndexSchema },
    },
    ({ dca }) =>
      wrapWingTool(async () => {
        const result = await ctx.client.get(dcaPath(dca, "mute"));
        const muted = result.kind === "leaf" && Number(result.value) === 1;
        return {
          content: [textResult(`DCA ${dca} is ${muted ? "muted" : "unmuted"}`)],
          structuredContent: { dca, muted },
        };
      }),
  );

  server.registerTool(
    "wing_dca_set_mute",
    {
      title: "Wing: Set DCA mute",
      description: "Sets a DCA's mute state via an ACK'd bulk-set.",
      inputSchema: { dca: dcaIndexSchema, muted: z.boolean() },
    },
    ({ dca, muted }) =>
      wrapWingTool(async () => {
        const ack = await ctx.client.bulkSet(dcaPath(dca), { mute: muted ? 1 : 0 });
        return {
          content: [textResult(`DCA ${dca} mute set to ${muted}: ${ack.status}`)],
          structuredContent: { dca, muted, ...ack },
        };
      }),
  );

  server.registerTool(
    "wing_dca_get_summary",
    {
      title: "Wing: Get DCA summary",
      description: "Dumps a DCA's key parameters (name, fader dB, mute) in one request.",
      inputSchema: { dca: dcaIndexSchema },
    },
    ({ dca }) =>
      wrapWingTool(async () => {
        const dump = await ctx.client.dump(dcaPath(dca));
        const summary = {
          dca,
          name: dump.name !== undefined ? String(dump.name) : "",
          db: dump.fdr !== undefined ? Number(dump.fdr) : NaN,
          muted: Number(dump.mute) === 1,
        };
        return {
          content: [
            textResult(`DCA ${dca}: "${summary.name}", ${summary.db} dB, ${summary.muted ? "muted" : "unmuted"}`),
          ],
          structuredContent: summary,
        };
      }),
  );

  server.registerTool(
    "wing_mutegroup_set",
    {
      title: "Wing: Set mute group",
      description: "Sets a mute group's mute state via an ACK'd bulk-set.",
      inputSchema: { mutegroup: mutegroupIndexSchema, muted: z.boolean() },
    },
    ({ mutegroup, muted }) =>
      wrapWingTool(async () => {
        const ack = await ctx.client.bulkSet(mutegroupPath(mutegroup), { mute: muted ? 1 : 0 });
        return {
          content: [textResult(`Mute group ${mutegroup} set to ${muted}: ${ack.status}`)],
          structuredContent: { mutegroup, muted, ...ack },
        };
      }),
  );

  server.registerTool(
    "wing_mutegroup_set_name",
    {
      title: "Wing: Set mute group name",
      description: "Sets a mute group's display name (max 8 characters) via an ACK'd bulk-set.",
      inputSchema: { mutegroup: mutegroupIndexSchema, name: z.string().min(1).max(8) },
    },
    ({ mutegroup, name }) =>
      wrapWingTool(async () => {
        const ack = await ctx.client.bulkSet(mutegroupPath(mutegroup), { name });
        if (ack.ok) {
          ctx.cache.applyChange({ path: mutegroupPath(mutegroup, "name"), value: name });
        }
        return {
          content: [textResult(`Mute group ${mutegroup} name set to "${name}": ${ack.status}`)],
          structuredContent: { mutegroup, name, ...ack },
        };
      }),
  );

  server.registerTool(
    "wing_mutegroup_toggle",
    {
      title: "Wing: Toggle mute group",
      description:
        "Toggles a mute group's state. Tries the ACK'd bulk-set toggle convention (mute=-1) first; falls " +
        "back to the primitive SET -1 toggle (no ack) if that is not acknowledged as OK.",
      inputSchema: { mutegroup: mutegroupIndexSchema },
    },
    ({ mutegroup }) =>
      wrapWingTool(async () => {
        const ack = await ctx.client.bulkSet(mutegroupPath(mutegroup), { mute: -1 });
        if (ack.ok) {
          return {
            content: [textResult(`Mute group ${mutegroup} toggled: ${ack.status}`)],
            structuredContent: { mutegroup, ackOk: true, status: ack.status },
          };
        }
        await ctx.client.toggle(mutegroupPath(mutegroup, "mute"));
        return {
          content: [
            textResult(
              `Mute group ${mutegroup} toggled via fallback SET -1 (bulk-set toggle was not acknowledged as ` +
                `OK: ${ack.status}; no ack is available for the fallback)`,
            ),
          ],
          structuredContent: { mutegroup, ackOk: false },
        };
      }),
  );
}
