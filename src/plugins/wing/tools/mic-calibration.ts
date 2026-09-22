import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { WingValueError } from "../wing-errors.js";
import { resolveMicCurveInput, type MicCurveInput } from "../wing-mic-calibration.js";
import { summarizeMicCalibration, type MicCalibrationSummary } from "../wing-mic-calibration-store.js";
import type { WingPluginContext } from "../wing-plugin.js";
import { textResult, wrapWingTool } from "./generic.js";

const micNameSchema = z.string().min(1).max(100);
const pointSchema = z.object({ hz: z.number(), db: z.number() });
const curveInputSchema = z
  .union([
    z.object({ points: z.array(pointSchema).min(5), sourceFiles: z.array(z.string()).optional() }),
    z.object({
      fileName: z.string().min(1),
      content: z.string().min(1),
      encoding: z.enum(["text", "base64"]).optional(),
      candidate: z.number().int().min(0).optional(),
    }),
  ])
  .optional();

function describeMic(m: MicCalibrationSummary): string {
  const curves = (["deg0", "deg90"] as const)
    .flatMap((key) => {
      const r = m.ranges[key];
      return r ? [`${key === "deg0" ? "0°" : "90°"} ${r.pointCount} pts ${r.minHz}-${r.maxHz} Hz`] : [];
    })
    .join(", ");
  return `${m.name}${m.serial ? ` (SN ${m.serial})` : ""}: ${curves}${m.notes ? ` — ${m.notes}` : ""}`;
}

export function registerMicCalibrationTools(server: McpServer, ctx: WingPluginContext): void {
  server.registerTool(
    "wing_mic_calibration_list",
    {
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      title: "Wing: List saved measurement mics (calibration curves)",
      description:
        "Lists the measurement mics saved with wing_mic_calibration_save (name, serial, available 0°/90° curves and " +
        "their frequency range). With `name`, returns that mic in full, calibration points included.",
      inputSchema: { name: micNameSchema.optional() },
    },
    ({ name }) =>
      wrapWingTool(async () => {
        if (name === undefined) {
          const mics = await ctx.micCalibrationStore.list();
          const text = mics.length === 0 ? "No measurement mics saved yet." : mics.map(describeMic).join("\n");
          return { content: [textResult(text)], structuredContent: { mics } };
        }
        const file = await ctx.micCalibrationStore.get(name);
        if (!file) {
          const known = (await ctx.micCalibrationStore.list()).map((m) => m.name);
          throw new WingValueError(`No saved mic named "${name}". Saved mics: ${known.join(", ") || "(none)"}`);
        }
        return { content: [textResult(describeMic(summarizeMicCalibration(file)))], structuredContent: { ...file } };
      }),
  );

  server.registerTool(
    "wing_mic_calibration_save",
    {
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      title: "Wing: Save a measurement mic with its calibration file",
      description:
        "Saves a measurement mic (e.g. \"ECM8000\") with its calibration — the mic's own frequency response, which " +
        "wing_auto_eq_balance subtracts from what the mic measures when called with micCalibration: { name }. A mic " +
        "can hold a 0° curve (pointed at the source) and/or a 90° curve (pointed at the ceiling). Each curve is " +
        "either `points` ([{hz, db}], at least 5) or a calibration file: `fileName` + `content` (`encoding` " +
        "\"text\" by default, or \"base64\" for binary files). Accepted files: REW/ARTA/Smaart-style txt/cal/frd, " +
        "CSV (comma, semicolon or tab, decimal point or comma), RTF, ODS or XLSX spreadsheets, or a zip of those — " +
        "any rows whose first two values are a frequency and a dB deviation; headers, sensitivity lines and phase " +
        "columns are ignored. Identical curves found in several files of a zip count once; when a file holds " +
        "several different curves, pick one with `candidate`. Fails if the name exists unless overwrite is true.",
      inputSchema: {
        name: micNameSchema,
        serial: z.string().max(100).optional(),
        notes: z.string().max(1000).optional(),
        curve0: curveInputSchema,
        curve90: curveInputSchema,
        overwrite: z.boolean().optional(),
      },
    },
    ({ name, serial, notes, curve0, curve90, overwrite }) =>
      wrapWingTool(async () => {
        const deg0 = curve0 ? resolveMicCurveInput(curve0 as MicCurveInput, "curve0") : null;
        const deg90 = curve90 ? resolveMicCurveInput(curve90 as MicCurveInput, "curve90") : null;
        const file = await ctx.micCalibrationStore.save({ name, serial, notes, curves: { deg0, deg90 } }, { overwrite });
        const summary = summarizeMicCalibration(file);
        return { content: [textResult(`Saved mic ${describeMic(summary)}`)], structuredContent: { ...summary } };
      }),
  );

  server.registerTool(
    "wing_mic_calibration_delete",
    {
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      title: "Wing: Delete a saved measurement mic",
      description: "Deletes a mic saved with wing_mic_calibration_save.",
      inputSchema: { name: micNameSchema },
    },
    ({ name }) =>
      wrapWingTool(async () => {
        const deleted = await ctx.micCalibrationStore.delete(name);
        if (!deleted) throw new WingValueError(`No saved mic named "${name}".`);
        return { content: [textResult(`Deleted mic "${name}".`)], structuredContent: { name, deleted } };
      }),
  );
}
