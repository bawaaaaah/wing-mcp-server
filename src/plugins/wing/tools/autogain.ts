import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { AUX_COUNT, CHANNEL_COUNT } from "../wing-node-paths.js";
import { WingValueError } from "../wing-errors.js";
import { runCombinedAutoGain } from "../wing-autogain.js";
import type { WingPluginContext } from "../wing-plugin.js";
import { textResult, wrapWingTool } from "./generic.js";

const stripTypeSchema = z.enum(["channel", "aux"]);
const modeSchema = z.enum(["gain", "trim", "both"]);

export function registerAutoGainTools(server: McpServer, ctx: WingPluginContext): void {
  server.registerTool(
    "wing_auto_gain",
    {
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      title: "Wing: Auto Gain (samples the live input, adjusts preamp gain and/or trim)",
      description:
        "Samples a channel or aux's live input peak for ~1.2s and adjusts its level to land on targetDb " +
        "(default -18 dBFS, standard alignment headroom). Default mode \"both\" prefers gain-staging with trim " +
        "left at 0: if a physical input is routed, it zeroes the strip's digital trim first, then adjusts that " +
        "input's analog preamp gain (-2.5..45dB) alone to get as close to targetDb as that range allows. Trim " +
        "is only touched afterward (\"au besoin\" — only if needed) when gain alone couldn't fully reach the " +
        "target (i.e. it came back clamped) or when there's no physical input to adjust gain on at all — in " +
        "either case trim then makes up the remainder (raising or lowering it as needed). Pass mode: \"gain\" " +
        "or \"trim\" to restrict it to just that one stage (only do this if the user specifically asked for " +
        "just gain or just trim); mode: \"gain\" leaves trim completely untouched, and errors if no physical " +
        "input is routed (source OFF) rather than silently doing nothing. Same algorithm as the dashboard's " +
        "channel/aux Auto Gain button. This is the input trim/preamp stage only — NOT the gate/dynamics/" +
        "compressor block (thr, depth, fast, cmode, ...), which has no \"auto\" mode on this console; do not " +
        "try to set those fields to accomplish automatic gain, they will not do that (and unrelated writes " +
        "there have been seen to ack NODE NOT FOUND/STACK EMPTY). Fails clearly if no signal is detected or " +
        "the signal is too quiet to reach a usable level even at this field's max.",
      inputSchema: {
        type: stripTypeSchema,
        index: z.number().int().min(1),
        targetDb: z.number().optional(),
        mode: modeSchema.optional(),
      },
    },
    ({ type, index, targetDb, mode }) =>
      wrapWingTool(async () => {
        const count = type === "channel" ? CHANNEL_COUNT : AUX_COUNT;
        if (!Number.isInteger(index) || index < 1 || index > count) {
          throw new WingValueError(`${type} index out of range: ${index} (expected 1..${count})`);
        }

        const result = await runCombinedAutoGain(ctx, { type, index, targetDb, mode });

        const lines: string[] = [];
        if (result.gain) {
          lines.push(
            `Gain (${result.physicalSource!.group} ${result.physicalSource!.index}): ${result.gain.oldValue} -> ` +
              `${result.gain.newValue} dB (peak was ${result.gain.measuredPeakDb.toFixed(1)} dB` +
              `${result.gain.clamped ? ", clamped to range" : ""})`,
          );
        }
        if (result.trim) {
          lines.push(
            `Trim (${type} ${index}): ${result.trim.oldValue} -> ${result.trim.newValue} dB ` +
              `(peak was ${result.trim.measuredPeakDb.toFixed(1)} dB${result.trim.clamped ? ", clamped to range" : ""})`,
          );
        } else if (result.trimLeftAtZero) {
          lines.push(`Trim (${type} ${index}): left at 0 dB — gain alone reached the target.`);
        }

        return {
          content: [textResult(lines.join("\n"))],
          structuredContent: { type, index, ...result },
        };
      }),
  );
}
