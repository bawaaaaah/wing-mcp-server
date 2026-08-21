import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { cancelFade, FADE_MAX_DURATION_MS, FADE_MIN_DURATION_MS, startFade } from "../wing-fade.js";
import type { WingPluginContext } from "../wing-plugin.js";
import { textResult, wrapWingTool } from "./generic.js";

/** `wing_fade`/`wing_fade_cancel` — the same software fade engine behind the dashboard's fade
 * button (see wing-fade.ts), exposed as tools so an agent can ramp a fader in/out too. There is no
 * native "fade" in the WING protocol: this starts a background ramp and returns immediately, it
 * does not block the tool call until the fade finishes. */
export function registerFadeTools(server: McpServer, ctx: WingPluginContext): void {
  server.registerTool(
    "wing_fade",
    {
      title: "Wing: Fade a fader in/out",
      description:
        "Ramps a fader-shaped leaf (e.g. /ch/3/fdr, /bus/1/fdr, /main/1/fdr, /mtx/2/fdr, /dca/4/fdr) from its " +
        "current value to a target over durationMs, in the background — this call returns immediately once " +
        "the ramp has started, it does not wait for it to finish. Without `to`/`deltaDb`, direction 'in' " +
        "targets 0dB and 'out' targets -oo (-144dB). Starting a new fade on a path that's already fading " +
        "cancels the earlier one rather than fighting over the fader.",
      inputSchema: {
        path: z.string().regex(/^\//, "path must start with /"),
        durationMs: z
          .number()
          .min(FADE_MIN_DURATION_MS)
          .max(FADE_MAX_DURATION_MS)
          .describe(`Fade duration in milliseconds (${FADE_MIN_DURATION_MS}..${FADE_MAX_DURATION_MS}).`),
        direction: z.enum(["in", "out"]),
        to: z.number().optional().describe("Absolute target level in dB. Takes precedence over deltaDb."),
        deltaDb: z.number().optional().describe("Relative target: (level at fade start) + deltaDb."),
      },
    },
    ({ path, durationMs, direction, to, deltaDb }) =>
      wrapWingTool(async () => {
        const result = await startFade(ctx, { path, durationMs, direction, to, deltaDb });
        return {
          content: [
            textResult(`Fading ${path} from ${result.from} dB to ${result.to} dB over ${result.durationMs}ms (started, not yet finished).`),
          ],
          structuredContent: { status: "started", ...result },
        };
      }),
  );

  server.registerTool(
    "wing_fade_cancel",
    {
      title: "Wing: Cancel an in-progress fade",
      description:
        "Stops an in-progress fade on `path` started by wing_fade, leaving the fader wherever it currently " +
        "is rather than snapping to either end. Not an error if nothing is fading on that path.",
      inputSchema: { path: z.string().regex(/^\//, "path must start with /") },
    },
    ({ path }) =>
      wrapWingTool(async () => {
        const wasActive = cancelFade(path);
        return {
          content: [textResult(wasActive ? `Cancelled the in-progress fade on ${path}.` : `No fade was in progress on ${path}.`)],
          structuredContent: { status: "cancelled", path, wasActive },
        };
      }),
  );
}
