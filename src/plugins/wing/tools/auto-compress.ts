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
        "The tool drives whichever ONE control this model actually uses to change how hard it compresses, " +
        "resolved from its live parameters: a threshold (`thr`; `cthr` for ECL33's split comp/limiter; `1-thr` " +
        "for a Dual Dynamic EQ's band 1), or a drive/amount knob on a model with no threshold — `in` (76LA " +
        "\"LE1176\", NSTR), `peak` (LA-2A \"LA\"), `gr` (ONEC, and L100 \"LTA100 Leveler\"), `comp` (LMT). " +
        "Models with no such control at all (DS902 de-esser, WAVE transient designer, WARM saturation) " +
        "are rejected with a clear message naming the model and its real parameters. Three mutually exclusive " +
        "ways to set that control: " +
        "`thresholdDb` sets an exact threshold once (rejected for an input-gain model — use inputGainDb); " +
        "`inputGainDb` sets an exact input-drive value once (rejected for a model that has a threshold — use " +
        "thresholdDb); `targetReductionDb` instead searches for whatever setting makes real program material " +
        "actually compress by that much (e.g. -5 finds the setting that yields ~5dB of reduction), by " +
        "repeatedly sampling the live meter and nudging the control until the measured `targetMode` statistic " +
        "(\"average\" reduction across the window, default, or \"peak\", the single deepest sample) lands " +
        "within ~0.75dB of the request. Which way to move it isn't a fixed rule — a compressor reduces MORE " +
        "as its threshold drops, a gate/expander MORE as its threshold RISES, an 1176-style model MORE as its " +
        "input drive RISES — so it seeds the direction from the resolved control and empirically flips once if " +
        "that made things worse, rather than trusting a model->polarity table the documentation doesn't fully confirm. " +
        "Stops and reports why via `target.stopReason`: \"converged\" (hit the target), \"range-exhausted\" " +
        "(hit the control's own min/max and still not there), \"unresponsive\" (a move produced no " +
        "measurable change in either direction — the material isn't crossing this control's operating point " +
        "right now), or \"max-iterations\" (default 5 rounds used up while still genuinely converging). If the " +
        "current setting already produces the requested reduction, nothing is touched at all. Either way, " +
        "once the control is settled, listens to the live meter for a window (default 3s per round) to " +
        "measure the actual average gain reduction now being applied to real program material, and raises or " +
        "lowers that slot's own makeup gain field by that same amount (plus, for a dB input-drive control, " +
        "the dB it was just pushed by) so the strip's overall loudness stays roughly put. A model with no " +
        "makeup-gain field at all (LA-2A) reports makeupGain.applied=false and nothing is written there. Omit " +
        "thresholdDb, targetReductionDb and inputGainDb to leave the current setting as-is and just re-balance " +
        "makeup gain against it (e.g. after moving it by hand on the console). Requires real, live program " +
        "material during the sampling window — a silent/near-silent input measures ~0dB of reduction and would " +
        "produce a meaningless makeup adjustment (and can't be searched against), so the tool fails clearly in " +
        "that case instead of guessing (any control change already made still sticks — only the makeup-gain " +
        "step, or the rest of the search, is skipped). This is a client-side set/search -> measure -> " +
        "compensate loop, not a hardware \"auto\" mode — the console has none.",
      inputSchema: {
        type: z.enum(AUTO_COMPRESS_TYPES as [AutoCompressType, ...AutoCompressType[]]),
        index: z.number().int().min(1),
        block: z.enum(AUTO_COMPRESS_BLOCKS as [AutoCompressBlock, ...AutoCompressBlock[]]).default("dyn"),
        // No fixed min/max: most thresholds are negative dB, but several models describe a positive
        // headroom (E88C `thr` -10..20, B560 -40..20) or a unitless `thr` altogether (B160 0.01..5
        // "logf", F670/2250 0..10) — runAutoCompress clamps to the control's own live range.
        thresholdDb: z.number().optional(),
        targetReductionDb: z.number().min(-80).max(0).optional(),
        targetMode: z.enum(["average", "peak"]).optional(),
        maxIterations: z.number().int().min(1).max(15).optional(),
        // No fixed min/max: the input-drive control's units/range vary by model (dB -48..0 for 76LA,
        // unitless 0..10 for NSTR/L100/ONEC, 0..100 for LA-2A/LMT) — runAutoCompress clamps to the live range.
        inputGainDb: z.number().optional(),
        ratio: z.union([z.number(), z.string()]).optional(),
        sampleMs: z.number().min(500).max(15000).optional(),
      },
    },
    ({ type, index, block, thresholdDb, targetReductionDb, targetMode, maxIterations, inputGainDb, ratio, sampleMs }) =>
      wrapWingTool(async () => {
        const result = await runAutoCompress(ctx, {
          type,
          index,
          block,
          thresholdDb,
          targetReductionDb,
          targetMode,
          maxIterations,
          inputGainDb,
          ratio,
          sampleMs,
        });
        const turnedOn =
          (thresholdDb !== undefined || targetReductionDb !== undefined || inputGainDb !== undefined) && !result.wasOn;
        const targetText = result.target
          ? ` [target ${result.target.reductionDb}dB ${result.target.mode}: ` +
            `${result.target.converged ? "converged" : `did not fully converge (${result.target.stopReason})`} ` +
            `after ${result.target.iterations} round(s)]`
          : "";
        const controlLabel =
          result.control.kind === "input-gain"
            ? result.control.key === "gr"
              ? "gain-reduction amount"
              : result.control.key === "comp"
                ? "compression amount"
                : result.control.key === "peak"
                  ? "peak reduction"
                  : "input gain"
            : result.control.key === "cthr"
              ? "compressor threshold"
              : result.control.key === "1-thr"
                ? "band-1 threshold"
                : "threshold";
        const u = result.control.unit ? ` ${result.control.unit}` : "";
        const controlText = `${controlLabel} ${result.control.old}${u} -> ${result.control.new}${u}`;
        const makeupText = result.makeupGain.applied
          ? `makeup gain ${result.makeupGain.old}dB -> ${result.makeupGain.new}dB` +
            `${result.makeupGain.clamped ? " (clamped to range)" : ""}`
          : "no makeup-gain field on this model";
        const text =
          `${type} ${index} ${result.block}${result.model ? ` (model ${result.model})` : ""}: ` +
          `${controlText}${targetText}` +
          `${result.ratio ? `, ratio -> ${result.ratio.new}` : ""}${turnedOn ? " (was off, turned on)" : ""}, ` +
          `measured avg reduction ${result.measured.meanGainReductionDb.toFixed(1)}dB ` +
          `(peak ${result.measured.peakGainReductionDb.toFixed(1)}dB) over ${result.measured.sampleMs}ms — ` +
          `${makeupText}: ${result.ack.status}`;
        return { content: [textResult(text)], structuredContent: { ...result } };
      }),
  );
}
