import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { STRIP_TYPE_COUNTS, STRIP_TYPES } from "../wing-node-paths.js";
import { WingValueError } from "../wing-errors.js";
import {
  performPresetDelete,
  performPresetLoad,
  performPresetSave,
  PRESET_SECTION_KEYS,
  summarizeSlot,
  type SlotRestoreOutcome,
} from "../wing-preset-engine.js";
import type { WingPluginContext } from "../wing-plugin.js";
import { textResult, wrapWingTool } from "./generic.js";

// The largest count across every strip type — used only as the zod schema's static upper bound.
// The real, type-specific bound is enforced when a path is actually resolved (each of
// channelPath/auxPath/busPath/mainPath/matrixPath/dcaPath/mutegroupPath range-checks itself).
const MAX_STRIP_COUNT = Math.max(...Object.values(STRIP_TYPE_COUNTS));

const indexSchema = z.number().int().min(1).max(MAX_STRIP_COUNT);
const presetNameSchema = z.string().min(1).max(100);
const stripTypeSchema = z.enum(STRIP_TYPES);
const sectionKeySchema = z.enum(PRESET_SECTION_KEYS);

function summarizeOutcome(outcome: SlotRestoreOutcome): string {
  if (outcome.error) {
    return `${outcome.sourceIndex} -> ${outcome.targetIndex}: ${outcome.status} (${outcome.error})`;
  }
  const parts = outcome.sections.map((s) =>
    s.status === "applied" ? s.section : `${s.section}(${s.status}${s.detail ? `: ${s.detail}` : ""})`,
  );
  return `${outcome.sourceIndex} -> ${outcome.targetIndex}: ${outcome.status} [${parts.join(", ")}]`;
}

export function registerPresetTools(server: McpServer, ctx: WingPluginContext): void {
  server.registerTool(
    "wing_preset_save",
    {
      title: "Wing: Save a strip preset",
      description:
        "Captures the full current state of one or more strips of the same type and saves it to disk under a " +
        'display name — e.g. save channel 1 as "Morgane Micro KSM9", or save channels 17-24 together as ' +
        '"Drums". type selects which kind of strip is being captured (default "channel"): channel/aux capture ' +
        "fader, mute, pan, EQ, gate, compression, bus/main/matrix sends, preamp gain, digital trim, name, and " +
        "DCA/mute-group membership; bus/main/matrix capture fader, mute, pan, EQ, compression, sends, name, " +
        "and DCA/mute-group membership (no preamp gain/trim — they aren't physical inputs); dca captures only " +
        "fader, mute, and name (no tags/EQ/routing — DCAs have none); mutegroup captures only mute and name. " +
        "Fails if a preset with that name already exists unless overwrite is true.",
      inputSchema: {
        name: presetNameSchema,
        type: stripTypeSchema.default("channel"),
        indices: z.array(indexSchema).min(1).max(MAX_STRIP_COUNT),
        overwrite: z.boolean().optional(),
      },
    },
    ({ name, type, indices, overwrite }) =>
      wrapWingTool(async () => {
        const result = await performPresetSave(ctx, { name, type, indices, overwrite });
        return {
          content: [textResult(`Saved ${result.type} preset "${result.name}" (${indices.length} strip(s): ${indices.join(", ")})`)],
          structuredContent: { ...result },
        };
      }),
  );

  server.registerTool(
    "wing_preset_list",
    {
      title: "Wing: List saved strip presets",
      description: "Lists every saved strip preset with its name, strip type, saved dates, and the strip(s) it covers.",
      inputSchema: {},
    },
    () =>
      wrapWingTool(async () => {
        const presets = await ctx.presetStore.list();
        const text =
          presets.length === 0
            ? "No presets saved yet."
            : presets
                .map(
                  (p) =>
                    `${p.name} [${p.type}]: ${p.slotCount} strip(s) [${p.sourceIndices.join(", ")}], updated ${p.updatedAt}`,
                )
                .join("\n");
        return { content: [textResult(text)], structuredContent: { presets } };
      }),
  );

  server.registerTool(
    "wing_preset_get",
    {
      title: "Wing: Inspect a saved strip preset",
      description:
        "Shows what's inside a saved preset without applying it — a curated summary per slot (name, fader, " +
        "mute, pan, trim, gain, EQ/gate/compression on-off) by default, or the full raw captured data with " +
        "includeRaw: true.",
      inputSchema: { name: presetNameSchema, includeRaw: z.boolean().optional() },
    },
    ({ name, includeRaw }) =>
      wrapWingTool(async () => {
        const file = await ctx.presetStore.get(name);
        if (!file) {
          const known = (await ctx.presetStore.list()).map((p) => p.name);
          throw new WingValueError(`No preset named "${name}" exists. Known presets: ${known.join(", ") || "(none)"}`);
        }
        const summaries = file.slots.map(summarizeSlot);
        return {
          content: [
            textResult(
              `Preset "${file.name}" [${file.type}] (${file.slots.length} strip(s), updated ${file.updatedAt}):\n` +
                summaries
                  .map((s) => `  ${s.sourceIndex}: "${s.name ?? ""}" fdr=${s.fader} mute=${s.mute} pan=${s.pan}`)
                  .join("\n"),
            ),
          ],
          structuredContent: {
            name: file.name,
            type: file.type,
            createdAt: file.createdAt,
            updatedAt: file.updatedAt,
            slots: includeRaw ? file.slots : summaries,
          },
        };
      }),
  );

  server.registerTool(
    "wing_preset_delete",
    {
      title: "Wing: Delete a saved strip preset",
      description: "Permanently deletes a saved strip preset by name.",
      inputSchema: { name: presetNameSchema },
    },
    ({ name }) =>
      wrapWingTool(async () => {
        const result = await performPresetDelete(ctx, name);
        return { content: [textResult(`Deleted preset "${name}"`)], structuredContent: result };
      }),
  );

  server.registerTool(
    "wing_preset_load",
    {
      title: "Wing: Load a saved strip preset",
      description:
        "Applies a saved preset onto one or more strips of the type it was saved as (channel/aux/bus/main/" +
        "matrix/dca/mutegroup — no need to pass the type again, it's stored with the preset). Without " +
        "targetIndex/targetIndices, re-applies to the exact strip(s) it was saved from. targetIndex shifts a " +
        "whole multi-strip preset by an offset (e.g. a preset saved from channels 17-24 with targetIndex: 9 " +
        "applies to 9-16). targetIndices maps each saved slot to an explicit index list (must match the " +
        "preset's slot count). sections restricts which categories are applied (name, gain, trim, pan, fader, " +
        "mute, eq, gate, dyn, sends, groups) — omit to apply everything captured; a section that doesn't apply " +
        "to this preset's strip type (e.g. gain/trim on a bus, or anything but fader/mute/name on a DCA) is " +
        "reported as skipped rather than an error. To layer sections from different presets onto the same " +
        "strip (e.g. eq from one preset, gate from another, in a specific order), call this tool once per " +
        "source preset with a different sections filter each time, in the order desired. " +
        "IMPORTANT (channel/aux only): this never reassigns which physical input feeds a strip — gain is " +
        "always written to whichever physical input is CURRENTLY connected to the target, which means it can " +
        "affect every other channel/aux sharing that same physical input jack (preamp gain is a property of " +
        "the jack, not of any one strip). groups membership (DCA/mute-group tokens) is replaced, not merged, " +
        "while the target's own free-form tags are always preserved. Never throws for a per-strip or per-" +
        "section failure — check the structuredContent results for exactly what applied, was skipped, or " +
        "errored.",
      inputSchema: {
        name: presetNameSchema,
        targetIndex: indexSchema.optional(),
        targetIndices: z.array(indexSchema).min(1).max(MAX_STRIP_COUNT).optional(),
        sections: z.array(sectionKeySchema).min(1).optional(),
      },
    },
    ({ name, targetIndex, targetIndices, sections }) =>
      wrapWingTool(async () => {
        const result = await performPresetLoad(ctx, { name, targetIndex, targetIndices, sections });
        return {
          content: [
            textResult(
              `Loaded "${result.name}" [${result.type}] (sections: ${sections?.join(", ") ?? "all"}): ` +
                `${result.summary.ok}/${result.summary.total} fully applied` +
                (result.summary.partial || result.summary.failed
                  ? `, ${result.summary.partial} partial, ${result.summary.failed} failed`
                  : "") +
                ".\n" +
                result.results.map(summarizeOutcome).join("\n"),
            ),
          ],
          structuredContent: { ...result },
        };
      }),
  );
}
