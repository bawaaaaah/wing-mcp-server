import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  AUTO_EQ_MAX_ITERATIONS,
  AUTO_EQ_STRIP_TYPES,
  estimateAutoEqMs,
  runAutoEqBalance,
  undoAutoEqBalance,
  type AutoEqZoneResult,
} from "../wing-auto-eq.js";
import { CUT_SLOPES } from "../wing-eq-math.js";
import { assertWithinCallBudget, progressReporterFor } from "../long-running.js";
import type { WingPluginContext } from "../wing-plugin.js";
import { textResult, wrapWingTool } from "./generic.js";

const cutSchema = z.object({ hz: z.number().min(20).max(20000), slope: z.enum(CUT_SLOPES) }).optional();

function describeZone(z: AutoEqZoneResult): string {
  const cuts = [z.cuts.low && `low cut ${z.cuts.low.hz} Hz ${z.cuts.low.slope}`, z.cuts.high && `high cut ${z.cuts.high.hz} Hz ${z.cuts.high.slope}`]
    .filter(Boolean)
    .join(", ");
  const range = `${z.fromHz}-${z.toHz} Hz${cuts ? `, ${cuts}` : ""}`;
  if (z.eqKind === "geq") {
    const moved = (z.geqBands ?? []).filter((b) => b.new !== b.old).length;
    const install = z.insert?.installed ? `, GEQ installed on ${z.insert.slot}-insert` : z.insert?.turnedOn ? ", insert turned on" : "";
    return `${z.type} ${z.index} (${range}): GEQ on FX${z.fxSlot}${install}, ${moved} band(s) changed`;
  }
  const eq = z.peq?.new;
  const sides = eq ? (["low", "high"] as const).filter((side) => (eq[side].type === "SHV" || eq[side].type === "PEQ") && eq[side].g !== 0) : [];
  const bells = eq ? eq.bands.filter((b) => b.g !== 0).length + sides.filter((side) => eq[side].type === "PEQ").length : 0;
  const shelves = eq ? sides.filter((side) => eq[side].type === "SHV") : [];
  const why = z.fallbackReason ? ` (GEQ unavailable: ${z.fallbackReason})` : "";
  return (
    `${z.type} ${z.index} (${range}): 8-band EQ${why}, ${bells} bell(s)` +
    `${shelves.length ? ` + ${shelves.join("/")} shelf` : ""} active`
  );
}

export function registerAutoEqTools(server: McpServer, ctx: WingPluginContext): void {
  server.registerTool(
    "wing_auto_eq_balance",
    {
      title: "Wing: Auto EQ balance (measure a PA/wedge with a mic + pink noise, correct matrix/bus/main EQs)",
      description:
        "Pre-show system/wedge tuning. BEFORE calling: send pink noise into every zone's strip and put a measurement " +
        "mic on `micChannel`, with that channel MUTED (refused otherwise, to avoid feedback — the RTA taps the channel " +
        "input so muting doesn't affect the measurement). The console's single RTA is pointed at the first zone " +
        "strip's input (the electrical noise, used as the reference), then at the " +
        "mic; mic minus reference is the speaker+room response, averaged into 31 third-octave bands and compared to " +
        "`targetCurve` (flat by default; points are {hz, db}, interpolated in log-frequency). Each zone is a strip " +
        "(`type` \"matrix\", \"bus\" or \"main\" + `index`) plus a frequency range [fromHz, toHz) and only receives " +
        "the correction inside its range — e.g. FOH matrix 1 from 100 to 20000 Hz plus SUB matrix 5 from 20 to 100 Hz, " +
        "or a single wedge bus 3 from 20 to 20000 Hz with the mic in front of that wedge (one wedge per run). Per " +
        "zone, `eq` picks where it's written: " +
        "\"auto\" (default) uses a GEQ (31-band graphic EQ) already inserted on the strip, else loads one into an " +
        "empty FX slot (or `fxSlot`) and patches it on a free insert point, else falls back to the strip's native EQ " +
        "(reported with `fallbackReason`); \"geq\" fails instead of falling back; \"peq\" always uses the native EQ. " +
        "The native EQ has 8 bands (L, 1-6, H): bands 1-6 are bells and L/H, unless set to a cut, can each become a " +
        "shelf or a bell — whichever removes more error — so up to 8 bells are available; Q is sized to each " +
        "deviation's width (narrow peak = tight Q, broad bump = wide Q). Optional per-zone " +
        "`lowCut`/`highCut` ({hz, slope}: CUT, BW6, BW12, BS12, LR12, BW18, BW24, BS24, LR24, BW48, LR48) are written " +
        "to the L/H band (e.g. a wedge bus low cut at 100 Hz LR24), taking that band out of the fit; bands a cut attenuates by more than " +
        "1 dB — including a cut already set on the console — are left uncorrected. Mains linked to main 1 " +
        "(/cfg/mainlink) are refused. Corrections are damped and repeated measure->correct for " +
        "up to `iterations` rounds (default 2), limited to `maxBoostDb` (default +3, don't fill room nulls) and " +
        "`maxCutDb` (default -9). Bands outside 31.5 Hz-16 kHz are left alone. `apply: false` measures once and " +
        "returns the proposed values without writing anything. Each measurement takes `sampleMs` (default 4000) " +
        "plus settling, so a full run lasts ~15-25 s. The RTA source is restored afterwards. `stopReason`: " +
        "\"converged\" (every band within 1.5 dB of target), \"limits-reached\" (nothing left to move within the " +
        "limits), \"max-iterations\", or \"preview\". Undo everything the last run changed with wing_auto_eq_undo. " +
        "During the run the RTA is switched to RMS detection without auto gain (the console's PEAK/auto-gain display " +
        "setting is unusable for measurement); its original settings are restored afterwards. Mic calibration: " +
        "`micCalibration: { name, orientation? }` uses a mic saved with wing_mic_calibration_save (orientation 0 = " +
        "pointed at the source, the default when the mic has that curve; 90 = pointed at the ceiling), or " +
        "`micCalibrationCurve` passes a one-off [{hz, db}] curve; the mic's deviation is subtracted from its readings " +
        "before anything is compared to the target. An unknown mic or a missing orientation fails before anything " +
        "is measured or written.",
      inputSchema: {
        micChannel: z.number().int().min(1).max(40),
        zones: z
          .array(
            z.object({
              type: z.enum(AUTO_EQ_STRIP_TYPES),
              index: z.number().int().min(1).max(16),
              fromHz: z.number().min(20).max(20000),
              toHz: z.number().min(20).max(20000),
              eq: z.enum(["auto", "geq", "peq"]).optional(),
              fxSlot: z.number().int().min(1).max(16).optional(),
              lowCut: cutSchema,
              highCut: cutSchema,
            }),
          )
          .min(1)
          .max(8),
        targetCurve: z.array(z.object({ hz: z.number().positive(), db: z.number().min(-24).max(24) })).optional(),
        maxBoostDb: z.number().min(0).max(15).optional(),
        maxCutDb: z.number().min(-15).max(0).optional(),
        iterations: z.number().int().min(1).max(AUTO_EQ_MAX_ITERATIONS).optional(),
        sampleMs: z.number().min(1000).max(20000).optional(),
        apply: z.boolean().optional(),
        micCalibration: z.object({ name: z.string().min(1), orientation: z.union([z.literal(0), z.literal(90)]).optional() }).optional(),
        micCalibrationCurve: z.array(z.object({ hz: z.number().positive(), db: z.number() })).min(5).optional(),
      },
    },
    (args, extra) =>
      wrapWingTool(async () => {
        // At the top of its own schema this runs for over two minutes — past the point any client
        // is still listening, while the server keeps driving the desk. Refused rather than started.
        assertWithinCallBudget({
          estimateMs: estimateAutoEqMs({ iterations: args.iterations, sampleMs: args.sampleMs }),
          what: "Auto-EQ",
          howToShorten:
            "Lower sampleMs or iterations. Each run starts from where the last one left the EQ, so two shorter " +
            "passes converge like one long one.",
        });
        const result = await runAutoEqBalance(ctx, {
          ...args,
          signal: extra.signal,
          onProgress: progressReporterFor(extra),
        });
        const cal = result.micCalibration;
        const calText = cal ? (cal.name ? `, calibrated with ${cal.name} (${cal.orientation}°)` : ", calibrated with a one-off curve") : "";
        const text =
          `Auto EQ (mic ch ${result.micChannel}${calText}, reference ${result.reference.type} ${result.reference.index}): ` +
          `${result.applied ? "" : "PREVIEW, nothing written — "}` +
          `${result.zones.map(describeZone).join("; ")}. ` +
          `Residual max ${result.residualMaxDb} dB / rms ${result.residualRmsDb} dB after ${result.iterations} round(s) ` +
          `[${result.stopReason}].`;
        return { content: [textResult(text)], structuredContent: { ...result } };
      }),
  );

  server.registerTool(
    "wing_auto_eq_undo",
    {
      title: "Wing: Undo the last auto EQ balance",
      description:
        "Restores every value the last wing_auto_eq_balance run changed (GEQ band gains, native EQ bands and on " +
        "switch, insert patching, FX slot model), in reverse order. Only the most recent run is remembered, and " +
        "only until the server restarts.",
      inputSchema: {},
    },
    () =>
      wrapWingTool(async () => {
        const result = await undoAutoEqBalance(ctx);
        return {
          content: [textResult(`Auto EQ undone: ${result.restoredWrites} write(s) restored.`)],
          structuredContent: { ...result },
        };
      }),
  );
}
