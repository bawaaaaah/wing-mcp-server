import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { WingUnavailableError, WingValueError } from "../wing-errors.js";
import { resolveStripPath } from "../wing-node-paths.js";
import { gainReductionFullScaleDb, gainReductionScaleCorrection, isBidirectionalDynModel } from "../wing-dynamics-models.js";
import type { WingPluginContext } from "../wing-plugin.js";
import { textResult, wrapWingTool } from "./generic.js";

type DynStatusType = "channel" | "aux" | "bus" | "main" | "matrix";
type DynBlock = "gate" | "dyn";

const DYN_STATUS_TYPES: readonly DynStatusType[] = ["channel", "aux", "bus", "main", "matrix"];
const DYN_STATUS_MIN_SAMPLE_MS = 200;
const DYN_STATUS_MAX_SAMPLE_MS = 10_000;
const DYN_STATUS_DEFAULT_SAMPLE_MS = 600;
/**
 * The meter never quite settles at a perfectly flat 0dB even fully open — verified against real
 * hardware that some models idle with a slight positive wobble (detector ripple, not an actual gain
 * boost) as large as ~0.5dB, not just negative noise. A dead zone keeps that from being reported as
 * "actively reducing"; critically, for a cut-only model (see wing-dynamics-models.ts)  "active"
 * additionally requires the value to be *negative* beyond the dead zone, since a positive reading is
 * exactly the idle-noise case, never real compression. A bidirectional model (Dynamic EQ) can be
 * legitimately active in either direction, so for those the dead zone alone gates "active".
 */
const GAIN_REDUCTION_ACTIVE_EPSILON_DB = 0.15;

const BLOCK_FIELDS: Record<DynBlock, { keyField: string; gainField: string; label: string }> = {
  gate: { keyField: "gateKey_dB", gainField: "gateGain_dB", label: "Gate slot" },
  dyn: { keyField: "dynKey_dB", gainField: "dynGain_dB", label: "Dyn slot" },
};

export function registerDynamicsStatusTools(server: McpServer, ctx: WingPluginContext): void {
  server.registerTool(
    "wing_dynamics_status",
    {
      title: "Wing: Read gate/compressor status and live gain reduction",
      description:
        "Reports a channel/aux/bus/main/matrix's \"gate\" and/or \"dyn\" dynamics-processing slot: its current " +
        "settings (on/off, model, threshold, ratio, makeup gain, ...) read from the OSC control plane, plus " +
        "how much gain reduction that slot is applying right now, sampled briefly from the live meter stream " +
        "(default 600ms). \"gate\" and \"dyn\" are both generic slots on this console, not fixed algorithms — " +
        "each slot's own model (`mdl`, included in the settings) picks what actually runs there, so a " +
        "compressor-type model may be loaded into the \"gate\" slot (or a gate/ducker-type model into \"dyn\") " +
        "just as easily as the conventional pairing; use `mdl` to see which is which before assuming from the " +
        "slot name alone. The reported gain figure is the actual attenuation currently applied, in dB (0 = " +
        "wide open, negative = reducing) — the same number a hardware compressor's gain-reduction meter would " +
        "show. The meter protocol's raw gate/dyn gain words aren't plain dB — they're a ratio of a model-" +
        "dependent full-scale range (WING_Remote-Protocols-3.1-03.pdf p.98), always looked up fresh from this " +
        "slot's own current settings (model, and for the \"GATE\" model specifically, its own live `range` " +
        "knob) before any value is returned, so it can never go stale if the model or range is changed — " +
        "`live.gainReductionFullScaleDb` in the structured result shows exactly what was used. Verified against " +
        "real hardware that some models idle with a slight positive wobble instead of " +
        "a flat 0 (detector ripple, not an actual gain boost), so for a cut-only model `active` only fires on a " +
        "genuinely negative reading past a small dead zone, never on that positive idle noise. A Dynamic EQ " +
        "model (mdl starting with \"DEQ\", confirmed live) is the one exception — it can legitimately boost a " +
        "detected band as well as cut it, so both directions past the dead zone count as active there, and the " +
        "summary text says \"boosting\"/\"cutting\" instead of always \"reducing\". The \"gate\" slot only exists on " +
        "channel strips; block: \"both\" (the default) silently reports \"dyn\" only for aux/bus/main/matrix. " +
        "Requesting block: \"gate\" on an aux/bus/main/matrix strip is an error.",
      inputSchema: {
        type: z.enum(DYN_STATUS_TYPES as [DynStatusType, ...DynStatusType[]]),
        index: z.number().int(),
        block: z.enum(["gate", "dyn", "both"]).default("both"),
        sampleMs: z
          .number()
          .min(DYN_STATUS_MIN_SAMPLE_MS)
          .max(DYN_STATUS_MAX_SAMPLE_MS)
          .default(DYN_STATUS_DEFAULT_SAMPLE_MS),
      },
    },
    ({ type, index, block, sampleMs }) =>
      wrapWingTool(async () => {
        const stripPath = resolveStripPath(type, index);
        if (block === "gate" && type !== "channel") {
          throw new WingValueError(
            `The "gate" slot only exists on channel strips — ${type} strips only have the "dyn" slot. Use ` +
              `block: "dyn" (or omit block), or type: "channel".`,
          );
        }
        const blocks: DynBlock[] = block === "both" ? (type === "channel" ? ["gate", "dyn"] : ["dyn"]) : [block];

        const settingsEntries = await Promise.all(
          blocks.map(async (b) => [b, await ctx.client.dump(`${stripPath}/${b}`)] as const),
        );

        // The meter protocol's gate/dyn gain words only carry the DEFAULT 20dB-full-scale scaling
        // (it has no way to know which model is loaded — see wing-meter-protocol.ts's
        // toGainReductionDb) — correct for the one documented exception (the "GATE" model's 60dB
        // range) now that the model is known, from the settings just read above.
        const correctionByBlock: Partial<Record<DynBlock, number>> = {};
        const fullScaleByBlock: Partial<Record<DynBlock, number>> = {};
        for (const [b, settings] of settingsEntries) {
          fullScaleByBlock[b] = gainReductionFullScaleDb(settings);
          correctionByBlock[b] = gainReductionScaleCorrection(settings);
        }

        const gainSamples: Record<DynBlock, number[]> = { gate: [], dyn: [] };
        const keySamples: Record<DynBlock, number[]> = { gate: [], dyn: [] };
        const onSnapshot = (snapshot: { frames: Array<Record<string, unknown>> }) => {
          for (const frame of snapshot.frames) {
            if (frame.type === type && frame.index === index) {
              for (const b of blocks) {
                const fields = BLOCK_FIELDS[b];
                gainSamples[b].push(Number(frame[fields.gainField]) * (correctionByBlock[b] ?? 1));
                keySamples[b].push(Number(frame[fields.keyField]));
              }
            }
          }
        };
        // Captured once: ctx.meterClient is a live getter that can re-resolve to a new instance
        // across this await (a host/config change mid-sample) — see wing-auto-compress.ts's
        // sampleReduction for the same fix and full rationale.
        const meterClient = ctx.meterClient;
        meterClient.on("snapshot", onSnapshot);
        await new Promise((resolve) => setTimeout(resolve, sampleMs));
        meterClient.off("snapshot", onSnapshot);

        if (blocks.every((b) => gainSamples[b].length === 0)) {
          throw new WingUnavailableError(
            `No live meter data received for ${type} ${index} over ${sampleMs}ms — is the meter client connected?`,
          );
        }

        const lines: string[] = [`${type} ${index}:`];
        const structured: Record<string, unknown> = {};
        for (const [b, settings] of settingsEntries) {
          const fields = BLOCK_FIELDS[b];
          const gains = gainSamples[b];
          const keys = keySamples[b];
          const bidirectional = isBidirectionalDynModel(settings.mdl);
          const current = gains.length > 0 ? gains[gains.length - 1] : 0;
          // Peak-by-magnitude rather than always Math.min: a cut-only model's values are already
          // <=0 in practice so this agrees with the old "deepest cut" behavior, but a bidirectional
          // model (Dynamic EQ) can swing either way and its biggest *boost* is just as much "the
          // peak" as its biggest cut.
          const peak = gains.length > 0 ? gains.reduce((p, v) => (Math.abs(v) > Math.abs(p) ? v : p), 0) : 0;
          const mean = gains.length > 0 ? gains.reduce((sum, v) => sum + v, 0) / gains.length : 0;
          const currentKey = keys.length > 0 ? keys[keys.length - 1] : 0;
          // Cut-only models (everything except Dynamic EQ, see wing-dynamics-models.ts): only a
          // genuinely negative reading past the dead zone counts as active reduction, never that
          // positive idle-detector wobble. Bidirectional models can be legitimately active in either
          // direction, so any reading past the dead zone (either sign) counts.
          const active = bidirectional ? Math.abs(current) > GAIN_REDUCTION_ACTIVE_EPSILON_DB : current < -GAIN_REDUCTION_ACTIVE_EPSILON_DB;
          const on = Number(settings.on) === 1;

          const activityText = !active
            ? bidirectional
              ? "not currently adjusting"
              : "not currently reducing"
            : bidirectional
              ? current < 0
                ? `cutting ${Math.abs(current).toFixed(1)}dB now`
                : `boosting ${current.toFixed(1)}dB now`
              : `reducing ${current.toFixed(1)}dB now`;

          lines.push(
            `  ${fields.label}: ${on ? "ON" : "OFF"}` +
              `${settings.mdl !== undefined ? `, model ${settings.mdl}` : ""}` +
              `${settings.thr !== undefined ? `, threshold ${settings.thr}dB` : ""}` +
              `${settings.ratio !== undefined ? `, ratio ${settings.ratio}` : ""}` +
              `${settings.gain !== undefined ? `, makeup gain ${settings.gain}dB` : ""} — ` +
              `${activityText} ` +
              `(key ${currentKey.toFixed(1)}dB, peak ${peak.toFixed(1)}dB, mean ${mean.toFixed(1)}dB, ${gains.length} samples)`,
          );
          structured[b] = {
            settings,
            live: {
              bidirectional,
              gainReductionFullScaleDb: fullScaleByBlock[b],
              currentGainReductionDb: current,
              peakGainReductionDb: peak,
              meanGainReductionDb: mean,
              currentKeyDb: currentKey,
              active,
              sampleCount: gains.length,
            },
          };
        }

        return {
          content: [textResult(lines.join("\n"))],
          structuredContent: { type, index, sampleMs, blocks: structured },
        };
      }),
  );
}
