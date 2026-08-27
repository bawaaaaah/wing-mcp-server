import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runAutoCompress, type AutoCompressBlock, type AutoCompressType } from "../wing-auto-compress.js";
import type { WingPluginContext } from "../wing-plugin.js";
import { textResult, wrapWingTool } from "./generic.js";

const AUTO_COMPRESS_TYPES: readonly AutoCompressType[] = ["channel", "aux", "bus", "main", "matrix"];
const AUTO_COMPRESS_BLOCKS: readonly AutoCompressBlock[] = ["gate", "dyn"];

export function registerAutoCompressTools(server: McpServer, ctx: WingPluginContext): void {
  server.registerTool(
    "wing_auto_compress",
    {
      title: "Wing: Auto Compress (sets/searches for a compressor threshold, compensates the reduction with makeup gain)",
      description:
        "Drives one of a channel/aux/bus/main/matrix's dynamics-processing slot(s) — \"gate\" and \"dyn\" are " +
        "both generic slots on this console, not fixed algorithms: each slot's own model (`mdl`) picks what " +
        "actually runs there, so a compressor can just as easily be loaded into the \"gate\" slot as the " +
        "\"dyn\" one. `block` (default \"dyn\", the conventional placement) picks which slot to drive — check " +
        "wing_dynamics_status's `mdl` field first if unsure which slot has a compressor-type model loaded on a " +
        "given strip; \"gate\" is only valid for channel strips (aux/bus/main/matrix only have \"dyn\"). " +
        "Two mutually exclusive ways to move the threshold, both validated against the model actually loaded " +
        "there first (not every model has a \"thr\" field — 76LA/LA/NSTR/WAVE/ECL33/LMT/ONEC/L100/DS902 don't; " +
        "Dynamic EQ uses per-band \"1-thr\"/\"2-thr\" — this fails clearly, naming the model and listing its " +
        "real parameters, instead of a cryptic console rejection; same check applies to `ratio`): " +
        "`thresholdDb` sets that exact number once, turning the slot on if it wasn't; `targetReductionDb` " +
        "instead searches for whatever threshold makes real program material actually compress by that much " +
        "(e.g. -5 asks the tool to find a threshold that yields ~5dB of reduction), by repeatedly sampling the " +
        "live meter and nudging the threshold until the measured `targetMode` statistic (\"average\" reduction " +
        "across the window, default, or \"peak\", the single deepest sample) lands within ~0.75dB of the " +
        "request. Which way to move the threshold isn't a fixed rule — a compressor reduces MORE as the " +
        "threshold drops, a gate/expander reduces MORE as the threshold RISES — so it tries the compressor " +
        "assumption first and empirically flips direction once if that assumption made things worse, rather " +
        "than trusting a model->polarity table for 30+ models the documentation itself doesn't fully confirm. " +
        "Stops and reports why via `target.stopReason`: \"converged\" (hit the target), \"range-exhausted\" " +
        "(hit the model's own thr min/max and still not there), \"unresponsive\" (a move produced no " +
        "measurable change in either direction — the material isn't crossing this control's operating point " +
        "right now), or \"max-iterations\" (default 5 rounds used up while still genuinely converging). If the " +
        "current threshold already produces the requested reduction, nothing is touched at all. Either way, " +
        "once the threshold is settled, listens to the live meter for a window (default 3s per round) to " +
        "measure the actual average gain reduction now being applied to real program material, and raises or " +
        "lowers that slot's own makeup gain field by that same amount so the strip's overall loudness stays " +
        "roughly put even though it's squashing peaks harder. Omit both thresholdDb and targetReductionDb to " +
        "leave the current threshold as-is and just re-balance makeup gain against it (e.g. after moving the " +
        "threshold by hand on the console). Requires real, live program material during the sampling window — " +
        "a silent/near-silent input measures ~0dB of reduction and would produce a meaningless makeup " +
        "adjustment (and can't be searched against), so the tool fails clearly in that case instead of " +
        "guessing (any threshold change already made still sticks — only the makeup-gain step, or the rest of " +
        "the search, is skipped). This is a client-side set/search -> measure -> compensate loop, not a " +
        "hardware \"auto\" mode — the console has none.",
      inputSchema: {
        type: z.enum(AUTO_COMPRESS_TYPES as [AutoCompressType, ...AutoCompressType[]]),
        index: z.number().int().min(1),
        block: z.enum(AUTO_COMPRESS_BLOCKS as [AutoCompressBlock, ...AutoCompressBlock[]]).default("dyn"),
        thresholdDb: z.number().min(-80).max(0).optional(),
        targetReductionDb: z.number().min(-80).max(0).optional(),
        targetMode: z.enum(["average", "peak"]).optional(),
        maxIterations: z.number().int().min(1).max(15).optional(),
        ratio: z.union([z.number(), z.string()]).optional(),
        sampleMs: z.number().min(500).max(15000).optional(),
      },
    },
    ({ type, index, block, thresholdDb, targetReductionDb, targetMode, maxIterations, ratio, sampleMs }) =>
      wrapWingTool(async () => {
        const result = await runAutoCompress(ctx, {
          type,
          index,
          block,
          thresholdDb,
          targetReductionDb,
          targetMode,
          maxIterations,
          ratio,
          sampleMs,
        });
        const turnedOn = (thresholdDb !== undefined || targetReductionDb !== undefined) && !result.wasOn;
        const targetText = result.target
          ? ` [target ${result.target.reductionDb}dB ${result.target.mode}: ` +
            `${result.target.converged ? "converged" : `did not fully converge (${result.target.stopReason})`} ` +
            `after ${result.target.iterations} round(s)]`
          : "";
        const text =
          `${type} ${index} ${result.block}${result.model ? ` (model ${result.model})` : ""}: ` +
          `threshold ${result.threshold.old}dB -> ${result.threshold.new}dB${targetText}` +
          `${result.ratio ? `, ratio -> ${result.ratio.new}` : ""}${turnedOn ? " (was off, turned on)" : ""}, ` +
          `measured avg reduction ${result.measured.meanGainReductionDb.toFixed(1)}dB ` +
          `(peak ${result.measured.peakGainReductionDb.toFixed(1)}dB) over ${result.measured.sampleMs}ms — ` +
          `makeup gain ${result.makeupGain.old}dB -> ${result.makeupGain.new}dB` +
          `${result.makeupGain.clamped ? " (clamped to range)" : ""}: ${result.ack.status}`;
        return { content: [textResult(text)], structuredContent: { ...result } };
      }),
  );
}
