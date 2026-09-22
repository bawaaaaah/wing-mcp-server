import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { WingValueError } from "../wing-errors.js";
import {
  findPluginModelsById,
  listPluginModels,
  listPluginModelsByUsage,
  WING_PLUGIN_MODELS,
  type WingPluginCategory,
  type WingPluginModel,
} from "../wing-plugin-catalog.js";
import type { WingPluginContext } from "../wing-plugin.js";
import { textResult, wrapWingTool } from "./generic.js";

const CATEGORIES: readonly WingPluginCategory[] = ["dynamics", "eq", "fx"];

function formatModel(m: WingPluginModel): string {
  const emulates = m.emulates ? ` (emulates ${m.emulates})` : "";
  const tier = m.fxTier ? ` [${m.fxTier} tier]` : "";
  return `${m.id} — ${m.name}${emulates}${tier}: ${m.shortDescription} [good for: ${m.goodFor.join(", ")}]`;
}

export function registerPluginCatalogTools(server: McpServer, ctx: WingPluginContext): void {
  server.registerTool(
    "wing_get_plugin_model",
    {
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      title: "Wing: Get gate/dyn/EQ/FX plugin model info",
      description:
        "Looks up WING's built-in gate/dyn/EQ processing models (the `mdl` field under a strip's gate/dyn/eq " +
        "node) or insert-effect models (the `mdl` field under an `fx.n` engine slot, see wing_get_insert / " +
        "wing_set_insert) by exact id (e.g. \"76LA\", \"DEQ2\", \"HALL\"), or lists every model in a category " +
        "(\"dynamics\" for the 32 models loadable into either a gate or dyn slot — they're interchangeable — " +
        "\"eq\" for the 7 EQ models, or \"fx\" for the 63 FX-engine-slot models, each tagged with an `fxTier` " +
        "of \"premium\" [FX engine slots 1-8 only], \"standard\", or \"channel\" [either tier loads into any " +
        "of FX1-16]). With neither argument, returns a terse id+name summary of the full catalog. Static " +
        "reference data transcribed from the protocol manual — does not read anything from the console.",
      inputSchema: {
        id: z.string().min(1).optional(),
        category: z.enum(CATEGORIES as [WingPluginCategory, ...WingPluginCategory[]]).optional(),
      },
    },
    ({ id, category }) =>
      wrapWingTool(async () => {
        if (id !== undefined) {
          const matches = findPluginModelsById(id).filter((m) => category === undefined || m.category === category);
          if (matches.length === 0) {
            throw new WingValueError(
              `No plugin model with id "${id}"${category ? ` in category "${category}"` : ""}. ` +
                `Call wing_get_plugin_model with no arguments for the full list of known ids.`,
            );
          }
          return {
            content: [textResult(matches.map(formatModel).join("\n"))],
            structuredContent: { models: matches },
          };
        }
        if (category !== undefined) {
          const models = listPluginModels(category);
          return {
            content: [textResult(models.map(formatModel).join("\n"))],
            structuredContent: { category, models },
          };
        }
        const summary = WING_PLUGIN_MODELS.map((m) => `${m.id} (${m.category}) — ${m.name}`);
        return {
          content: [textResult(summary.join("\n"))],
          structuredContent: { models: WING_PLUGIN_MODELS.map(({ id: modelId, category: cat, name }) => ({ id: modelId, category: cat, name })) },
        };
      }),
  );

  server.registerTool(
    "wing_list_plugins_by_usage",
    {
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      title: "Wing: Find plugin models by intended use",
      description:
        "Finds gate/dyn/EQ/FX processing models whose tagged use cases (e.g. \"vocals\", \"de-essing\", \"mix bus\", " +
        "\"mastering\", \"reverb\"-adjacent tags like \"long ambient tails\") match the given usage text — helps " +
        "pick a suitable model before setting a strip's gate/dyn/eq `mdl` field or an `fx.n` insert slot's `mdl`. " +
        "Static reference data — does not read anything from the console.",
      inputSchema: {
        usage: z.string().min(1),
      },
    },
    ({ usage }) =>
      wrapWingTool(async () => {
        const models = listPluginModelsByUsage(usage);
        const text =
          models.length > 0
            ? models.map(formatModel).join("\n")
            : `No known plugin model is tagged for "${usage}". Call wing_get_plugin_model with no arguments to see the full catalog.`;
        return { content: [textResult(text)], structuredContent: { usage, models } };
      }),
  );
}
