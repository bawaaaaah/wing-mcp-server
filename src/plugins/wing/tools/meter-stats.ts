import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { gainReductionFullScaleDb, gainReductionScaleCorrection } from "../wing-dynamics-models.js";
import { WingUnavailableError, WingValueError } from "../wing-errors.js";
import { abortableDelay, LONG_TOOL_BUDGET_MS } from "../long-running.js";
import { AUX_COUNT, BUS_COUNT, CHANNEL_COUNT, MAIN_COUNT, MATRIX_COUNT, resolveStripPath } from "../wing-node-paths.js";
import type { WingPluginContext } from "../wing-plugin.js";
import { textResult, wrapWingTool } from "./generic.js";

type MeterStatsType = "channel" | "aux" | "bus" | "main" | "matrix";
type MeterStatsSignal = "input" | "output" | "gate" | "dyn";

const METER_STATS_TYPES: readonly MeterStatsType[] = ["channel", "aux", "bus", "main", "matrix"];
const METER_STATS_INDEX_COUNTS: Record<MeterStatsType, number> = {
  channel: CHANNEL_COUNT,
  aux: AUX_COUNT,
  bus: BUS_COUNT,
  main: MAIN_COUNT,
  matrix: MATRIX_COUNT,
};

const METER_STATS_MIN_DURATION_MS = 500;
// Was 60_000 — exactly the MCP client's default request timeout, so at its own documented maximum
// this tool was guaranteed to be abandoned mid-sample while the server kept measuring. Tied to the
// shared budget so the two cannot drift apart again.
const METER_STATS_MAX_DURATION_MS = LONG_TOOL_BUDGET_MS;
const METER_STATS_DEFAULT_DURATION_MS = 5000;
/** Matches the existing autogain route's AUTOGAIN_LOW_SIGNAL_FLOOR_DB (http-routes/) — the level
 * below which a reading is treated as silence/noise floor rather than real signal. */
const METER_STATS_DEFAULT_EXCLUDE_BELOW_DB = -50;

/**
 * `input`/`output` are genuinely the same quantity in stereo (left/right), so their two channels
 * are reported separately rather than pooled — averaging them together would mask a left/right
 * imbalance that's often exactly what someone checking levels wants to see. `gate`/`dyn` are
 * reported as their two components (`key` = what the detector sees, `gain` = how much reduction is
 * being applied right now) — these are two different physical quantities, not stereo channels of
 * the same one, so combining them into a single min/max would be actively misleading.
 */
const SIGNAL_FIELDS: Record<MeterStatsSignal, { aLabel: string; aKey: string; bLabel: string; bKey: string }> = {
  input: { aLabel: "left", aKey: "inputL_dB", bLabel: "right", bKey: "inputR_dB" },
  output: { aLabel: "left", aKey: "outputL_dB", bLabel: "right", bKey: "outputR_dB" },
  gate: { aLabel: "key", aKey: "gateKey_dB", bLabel: "gain", bKey: "gateGain_dB" },
  dyn: { aLabel: "key", aKey: "dynKey_dB", bLabel: "gain", bKey: "dynGain_dB" },
};

interface FieldStats {
  min: number;
  max: number;
  mean: number;
  median: number;
  /** min() again, but ignoring samples below `excludeBelowDb` — lets silence/gaps between phrases
   * not drag the "real" minimum level down to the meter's noise floor. `null` if every sample
   * collected was below the threshold (e.g. the source was silent for the whole window). */
  minAboveThreshold: number | null;
}

function computeFieldStats(samples: number[], excludeBelowDb: number): FieldStats {
  const sorted = [...samples].sort((a, b) => a - b);
  const mean = samples.reduce((sum, v) => sum + v, 0) / samples.length;
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  const aboveThreshold = sorted.filter((v) => v >= excludeBelowDb);
  return {
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean,
    median,
    minAboveThreshold: aboveThreshold.length > 0 ? aboveThreshold[0] : null,
  };
}

function assertMeterIndexInRange(type: MeterStatsType, index: number): void {
  const max = METER_STATS_INDEX_COUNTS[type];
  if (!Number.isInteger(index) || index < 1 || index > max) {
    throw new WingValueError(`${type} index out of range: ${index} (expected 1..${max})`);
  }
}

export function registerMeterStatsTools(server: McpServer, ctx: WingPluginContext): void {
  server.registerTool(
    "wing_meter_stats",
    {
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      title: "Wing: Sample live meter levels over time (min/max/mean/median)",
      description:
        "Listens to a channel/aux/bus/main/matrix's live meter stream for a window of time (default 5s) and " +
        "returns level statistics: min, max, mean, median, and a min that ignores samples below " +
        "excludeBelowDb (so brief silence/gaps don't drag the 'real' minimum down to the noise floor). " +
        "`signal` picks which pair of meter fields to report — 'input'/'output' report separate left/right " +
        "stats, 'gate'/'dyn' report separate key(detector)/gain(reduction) stats, since those are two " +
        "distinct quantities rather than stereo channels of the same one. For 'gate'/'dyn', this always looks " +
        "up the slot's current model (and, for the \"GATE\" model specifically, its own live `range` setting) " +
        "before sampling and corrects the raw meter protocol reading for it (see wing_dynamics_status's " +
        "description for why this correction is needed at all) — `settings`/`gainReductionFullScaleDb` in the " +
        "structured result show exactly what was looked up and used. The \"gate\" slot only exists on channel " +
        "strips; signal: \"gate\" on any other type is an error. This call blocks for the full duration before " +
        "returning.",
      inputSchema: {
        type: z.enum(METER_STATS_TYPES as [MeterStatsType, ...MeterStatsType[]]),
        index: z.number().int(),
        signal: z.enum(["input", "output", "gate", "dyn"]).default("input"),
        durationMs: z
          .number()
          .min(METER_STATS_MIN_DURATION_MS)
          .max(METER_STATS_MAX_DURATION_MS)
          .default(METER_STATS_DEFAULT_DURATION_MS)
          .describe(
            "How long to sample for, in ms. The call blocks for this long, so it is also what the tool costs: " +
              `${METER_STATS_MIN_DURATION_MS}..${METER_STATS_MAX_DURATION_MS}, default ` +
              `${METER_STATS_DEFAULT_DURATION_MS}. For a longer observation, take several windows and compare ` +
              "them rather than asking for one very long one.",
          ),
        excludeBelowDb: z.number().default(METER_STATS_DEFAULT_EXCLUDE_BELOW_DB),
      },
    },
    ({ type, index, signal, durationMs, excludeBelowDb }, extra) =>
      wrapWingTool(async () => {
        const startedAt = Date.now();
        assertMeterIndexInRange(type, index);
        if (signal === "gate" && type !== "channel") {
          throw new WingValueError(
            `The "gate" slot only exists on channel strips — ${type} strips only have the "dyn" slot. Use ` +
              `signal: "dyn", or type: "channel".`,
          );
        }
        const fields = SIGNAL_FIELDS[signal];
        const isDynSlot = signal === "gate" || signal === "dyn";

        // Gate/dyn gain words need a model+range-aware correction (see wing-dynamics-models.ts) —
        // always look up this slot's CURRENT settings before sampling, so the correction can never be
        // computed from a stale model/range if the plugin loaded there (or its range knob) changed.
        const settings = isDynSlot ? await ctx.client.dump(`${resolveStripPath(type, index)}/${signal}`) : undefined;
        const gainCorrection = gainReductionScaleCorrection(settings);

        const aSamples: number[] = [];
        const bSamples: number[] = [];
        const onSnapshot = (snapshot: { frames: Record<string, unknown>[] }) => {
          for (const frame of snapshot.frames) {
            if (frame.type === type && frame.index === index) {
              aSamples.push(Number(frame[fields.aKey]));
              bSamples.push(Number(frame[fields.bKey]) * (isDynSlot ? gainCorrection : 1));
            }
          }
        };
        // Captured once: ctx.meterClient is a live getter that can re-resolve to a new instance
        // across this await (a host change mid-sample), and attaching on one instance while
        // detaching from another would strand the listener on the discarded one. Same reason the
        // auto-compress and dynamics-status samplers do this.
        const meterClient = ctx.meterClient;
        meterClient.on("snapshot", onSnapshot);
        try {
          await abortableDelay(durationMs, extra.signal, "Meter sampling");
        } finally {
          meterClient.off("snapshot", onSnapshot);
        }

        if (aSamples.length === 0) {
          throw new WingUnavailableError(
            `No live meter data received for ${type} ${index} over ${durationMs}ms — is the meter client connected?`,
          );
        }

        const aStats = computeFieldStats(aSamples, excludeBelowDb);
        const bStats = computeFieldStats(bSamples, excludeBelowDb);

        return {
          content: [
            textResult(
              `${type} ${index} ${signal} over ${durationMs}ms (${aSamples.length} samples): ` +
                `${fields.aLabel} min ${aStats.min.toFixed(1)}/max ${aStats.max.toFixed(1)}/mean ${aStats.mean.toFixed(1)}/median ${aStats.median.toFixed(1)}dB, ` +
                `${fields.bLabel} min ${bStats.min.toFixed(1)}/max ${bStats.max.toFixed(1)}/mean ${bStats.mean.toFixed(1)}/median ${bStats.median.toFixed(1)}dB.`,
            ),
          ],
          structuredContent: {
            type,
            index,
            signal,
            durationMs,
            excludeBelowDb,
            sampleCount: aSamples.length,
            elapsedMs: Date.now() - startedAt,
            channels: { [fields.aLabel]: aStats, [fields.bLabel]: bStats },
            ...(settings ? { settings, gainReductionFullScaleDb: gainReductionFullScaleDb(settings) } : {}),
          },
        };
      }),
  );
}
