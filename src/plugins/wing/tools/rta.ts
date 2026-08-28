import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getRtaSource, RTA_SOURCE_TYPES, RTA_TAP_VALUES, setRtaSource, type RtaSourceType, type RtaTap } from "../wing-rta-source.js";
import type { WingPluginContext } from "../wing-plugin.js";
import { textResult, wrapWingTool } from "./generic.js";

/**
 * The RTA (real-time spectrum analyzer) is a push-only stream on the binary metering protocol
 * (TCP:2222), not a request/response OSC leaf — there is no "ask the console for the RTA right
 * now" primitive to wrap. Instead the plugin keeps subscribed to it continuously (see
 * buildDefaultMeterRequests in wing-plugin.ts) and caches whatever snapshot arrived most recently;
 * this tool just returns that cache, the same way a live dashboard would.
 */
export function registerRtaTools(server: McpServer, ctx: WingPluginContext): void {
  server.registerTool(
    "wing_get_rta",
    {
      title: "Wing: Get the real-time spectrum analyzer (RTA) snapshot",
      description:
        "Returns the most recently received RTA snapshot: 120 frequency bands in dB, from the console's " +
        "binary metering stream (separate from the OSC control protocol). The protocol reference documents " +
        "the band count but not each band's exact center frequency, so bands are returned in their raw wire " +
        "order (index 0..119, ascending frequency) rather than labeled in Hz. `available: false` means no " +
        "RTA frame has been received yet (e.g. just after startup, or the meter client is disconnected) — " +
        "retrying in a second or two usually resolves it.",
    },
    () =>
      wrapWingTool(async () => {
        const snapshot = ctx.getLastRta();
        if (!snapshot) {
          return {
            content: [textResult("No RTA snapshot received yet — the metering connection may still be starting up or is disconnected.")],
            structuredContent: { available: false },
          };
        }
        const ageMs = Date.now() - snapshot.receivedAt;
        const min = Math.min(...snapshot.bandsDb);
        const max = Math.max(...snapshot.bandsDb);
        return {
          content: [
            textResult(
              `RTA snapshot: ${snapshot.bandsDb.length} bands, ${ageMs}ms old, range ${min.toFixed(1)}..${max.toFixed(1)} dB.`,
            ),
          ],
          structuredContent: { available: true, bandsDb: snapshot.bandsDb, receivedAt: snapshot.receivedAt, ageMs },
        };
      }),
  );

  server.registerTool(
    "wing_get_rta_source",
    {
      title: "Wing: Get the RTA's current source and tap point",
      description:
        "Reads which strip the RTA is currently analyzing (/cfg/rta/rtasrc) and which point in that strip's " +
        "signal chain it's tapping (/cfg/rta/rtatap) — this is what wing_get_rta's spectrum actually reflects. " +
        "`source` is null if the raw index doesn't decode to a known channel/aux/bus/main/matrix (e.g. the " +
        "console reports 0); `rawIndex` is always included so nothing is lost even then.",
    },
    () =>
      wrapWingTool(async () => {
        const result = await getRtaSource(ctx);
        return {
          content: [
            textResult(
              result.source
                ? `RTA source: ${result.source.type} ${result.source.index} (raw index ${result.rawIndex}), tap ${result.tap ?? "unknown"}.`
                : `RTA source: raw index ${result.rawIndex} (does not decode to a known strip), tap ${result.tap ?? "unknown"}.`,
            ),
          ],
          structuredContent: { ...result },
        };
      }),
  );

  server.registerTool(
    "wing_set_rta_source",
    {
      title: "Wing: Set the RTA's source and (optionally) tap point",
      description:
        "Points the RTA at a different strip — `type` + `index` select which channel/aux/bus/main/matrix " +
        "feeds it, and the optional `tap` picks where in that strip's chain to analyze (input, post-EQ, " +
        "pre-fader, gate key, ...). Omit `tap` to leave it as-is. " +
        "Caveat: the console documents rtasrc's numeric range (0..76) but not which sub-range maps to which " +
        "strip type — this mapping is inferred (channel 1-40, aux 41-48, bus 49-64, main 65-68, matrix 69-76) " +
        "from converging evidence elsewhere in the protocol reference, not from an official table, and hasn't " +
        "been visually confirmed on the console's own screen. If the RTA ends up pointed at the wrong strip, " +
        "that's the place to double-check (see wing-rta-source.ts).",
      inputSchema: {
        type: z.enum(RTA_SOURCE_TYPES as [RtaSourceType, ...RtaSourceType[]]),
        index: z.number().int(),
        tap: z.enum([...RTA_TAP_VALUES] as [RtaTap, ...RtaTap[]]).optional(),
      },
    },
    ({ type, index, tap }) =>
      wrapWingTool(async () => {
        const result = await setRtaSource(ctx, { type, index }, tap);
        return {
          content: [
            textResult(
              `RTA source set to ${type} ${index} (raw index ${result.rawIndex})${tap ? `, tap ${tap}` : ""}: ${result.status}`,
            ),
          ],
          structuredContent: { ...result },
        };
      }),
  );
}
