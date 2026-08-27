import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runAutoGate, type AutoGateBlock, type AutoGateType } from "../wing-auto-gate.js";
import type { WingPluginContext } from "../wing-plugin.js";
import { textResult, wrapWingTool } from "./generic.js";

const AUTO_GATE_TYPES: readonly AutoGateType[] = ["channel", "aux", "bus", "main", "matrix"];
const AUTO_GATE_BLOCKS: readonly AutoGateBlock[] = ["gate", "dyn"];

export function registerAutoGateTools(server: McpServer, ctx: WingPluginContext): void {
  server.registerTool(
    "wing_auto_gate",
    {
      title: "Wing: Auto Gate (measures noise floor vs signal peak, sets a gate threshold automatically)",
      description:
        "Drives one of a channel/aux/bus/main/matrix's dynamics-processing slot(s) — \"gate\" and \"dyn\" are " +
        "both generic slots on this console, not fixed algorithms (see wing_auto_compress's description for " +
        "why) — `block` (default \"gate\", the conventional placement) picks which slot to drive; \"gate\" is " +
        "only valid for channel strips (aux/bus/main/matrix only have \"dyn\"). Unlike wing_auto_compress " +
        "(which needs the caller to already know/choose a threshold), this measures the slot's own live " +
        "detector (\"key\") level for a window (default 4s) against real program material, works out the " +
        "\"noise floor\" (quiet moments — room tone, bleed) and \"signal peak\" (loud moments — the actual " +
        "wanted signal), and sets the threshold `marginDb` (default 6dB) above the noise floor — enough to " +
        "open cleanly for real signal and stay shut during quiet/bleed, without the caller having to guess a " +
        "number. Fails clearly (nothing changed) if the program material during the window didn't have a " +
        "clear quiet/loud contrast to measure from, or if the model loaded in that slot has no settable " +
        "\"thr\" field at all (not every one of the 30+ gate/dyn models does — e.g. 76LA/LA/NSTR use " +
        "different controls entirely). This is a client-side measure -> compute -> set loop, not a hardware " +
        "\"auto\" mode — the console has none.",
      inputSchema: {
        type: z.enum(AUTO_GATE_TYPES as [AutoGateType, ...AutoGateType[]]),
        index: z.number().int().min(1),
        block: z.enum(AUTO_GATE_BLOCKS as [AutoGateBlock, ...AutoGateBlock[]]).default("gate"),
        marginDb: z.number().min(0).max(40).optional(),
        sampleMs: z.number().min(500).max(20000).optional(),
      },
    },
    ({ type, index, block, marginDb, sampleMs }) =>
      wrapWingTool(async () => {
        const result = await runAutoGate(ctx, { type, index, block, marginDb, sampleMs });
        const turnedOn = !result.wasOn;
        const text =
          `${type} ${index} ${result.block}${result.model ? ` (model ${result.model})` : ""}: measured noise floor ` +
          `${result.measured.noiseFloorDb.toFixed(1)}dB, signal peak ${result.measured.signalPeakDb.toFixed(1)}dB ` +
          `over ${result.measured.sampleMs}ms (margin ${result.measured.marginDb}dB) — threshold ` +
          `${result.threshold.old}dB -> ${result.threshold.new}dB` +
          `${result.threshold.clamped ? " (clamped to range)" : ""}${turnedOn ? " (was off, turned on)" : ""}: ${result.ack.status}`;
        return { content: [textResult(text)], structuredContent: { ...result } };
      }),
  );
}
