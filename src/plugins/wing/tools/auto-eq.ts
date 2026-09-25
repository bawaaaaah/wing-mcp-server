import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  estimateAutoEqMs,
  runAutoEqBalance,
  undoAutoEqBalance,
  type AutoEqZoneResult,
} from "../wing-auto-eq.js";
import { assertWithinCallBudget, progressReporterFor } from "../long-running.js";
import { autoEqBalanceShape } from "../wing-input-schemas.js";
import type { WingPluginContext } from "../wing-plugin.js";
import { textResult, wrapWingTool } from "./generic.js";

function describeZone(zone: AutoEqZoneResult): string {
  const cuts = [zone.cuts.low && `low cut ${zone.cuts.low.hz} Hz ${zone.cuts.low.slope}`, zone.cuts.high && `high cut ${zone.cuts.high.hz} Hz ${zone.cuts.high.slope}`]
    .filter(Boolean)
    .join(", ");
  const range = `${zone.fromHz}-${zone.toHz} Hz${cuts ? `, ${cuts}` : ""}`;
  if (zone.eqKind === "geq") {
    const moved = (zone.geqBands ?? []).filter((b) => b.new !== b.old).length;
    const install = zone.insert?.installed ? `, GEQ installed on ${zone.insert.slot}-insert` : zone.insert?.turnedOn ? ", insert turned on" : "";
    return `${zone.type} ${zone.index} (${range}): GEQ on FX${zone.fxSlot}${install}, ${moved} band(s) changed`;
  }
  const eq = zone.peq?.new;
  const sides = eq ? (["low", "high"] as const).filter((side) => (eq[side].type === "SHV" || eq[side].type === "PEQ") && eq[side].g !== 0) : [];
  const bells = eq ? eq.bands.filter((b) => b.g !== 0).length + sides.filter((side) => eq[side].type === "PEQ").length : 0;
  const shelves = eq ? sides.filter((side) => eq[side].type === "SHV") : [];
  const why = zone.fallbackReason ? ` (GEQ unavailable: ${zone.fallbackReason})` : "";
  return (
    `${zone.type} ${zone.index} (${range}): 8-band EQ${why}, ${bells} bell(s)` +
    `${shelves.length ? ` + ${shelves.join("/")} shelf` : ""} active`
  );
}

export function registerAutoEqTools(server: McpServer, ctx: WingPluginContext): void {
  server.registerTool(
    "wing_auto_eq_balance",
    {
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
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
        "is measured or written. Calling this again with the same arguments continues from the EQ the previous " +
        "run left in place — it re-measures first — so a run that stops at \"max-iterations\" is resumed, not " +
        "restarted.",
      inputSchema: autoEqBalanceShape,
    },
    (args, extra) =>
      wrapWingTool(async () => {
        const startedAt = Date.now();
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
          `[${result.stopReason}].` +
          // Actionable, unlike the other stop reasons: the EQ is already part-way corrected and
          // another run picks up from it. See wing-auto-compress-resume.test.ts for the same
          // property on the compressor side.
          (result.stopReason === "max-iterations"
            ? " It ran out of rounds rather than settling; call this again with the same arguments to carry on " +
              "from the EQ now in place."
            : "");
        return {
          content: [textResult(text)],
          structuredContent: { ...result, elapsedMs: Date.now() - startedAt },
        };
      }),
  );

  server.registerTool(
    "wing_auto_eq_undo",
    {
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
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
