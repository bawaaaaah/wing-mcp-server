import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { WingPluginContext } from "../wing-plugin.js";
import {
  getMonitorBus,
  getSoloConfig,
  getStripSolo,
  MONITOR_BUS_DIRIN_VALUES,
  MONITOR_BUS_SRC_VALUES,
  setMonitorBus,
  setSoloConfig,
  setStripSolo,
  SOLO_MODE_VALUES,
  SOLO_MONITOR_DEST_VALUES,
  SOLO_STRIP_TYPES,
  SOLO_TAP_VALUES,
  SOURCE_SOLO_ASSIGN_VALUES,
  type MonitorBusIndex,
  type SoloMode,
  type SoloMonitorDest,
  type SoloStripType,
  type SoloTap,
  type SourceSoloAssign,
} from "../wing-solo-monitor.js";
import { textResult, wrapWingTool } from "./generic.js";

const monitorBusSchema = z.union([z.literal(1), z.literal(2)]);

export function registerSoloMonitorTools(server: McpServer, ctx: WingPluginContext): void {
  server.registerTool(
    "wing_get_strip_solo",
    {
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      title: "Wing: Get strip solo status",
      description:
        "Reads a channel/aux/bus/main/matrix/DCA strip's solo switch and solo LED, plus (channel/aux only) " +
        "solo-safe and (channel only) presolo. Not available on mutegroup strips.",
      inputSchema: {
        type: z.enum(SOLO_STRIP_TYPES as [SoloStripType, ...SoloStripType[]]),
        index: z.number().int().min(1),
      },
    },
    ({ type, index }) =>
      wrapWingTool(async () => {
        const status = await getStripSolo(ctx, type, index);
        return {
          content: [textResult(`${type} ${index} solo: ${status.solo}, led=${status.soloLed}`)],
          structuredContent: { ...status },
        };
      }),
  );

  server.registerTool(
    "wing_set_strip_solo",
    {
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      title: "Wing: Set strip solo",
      description:
        "Sets a channel/aux/bus/main/matrix/DCA strip's solo switch and/or (channel/aux only) solo-safe flag " +
        "in a single validated call — any subset of the two.",
      inputSchema: {
        type: z.enum(SOLO_STRIP_TYPES as [SoloStripType, ...SoloStripType[]]),
        index: z.number().int().min(1),
        solo: z.boolean().optional(),
        soloSafe: z.boolean().optional(),
      },
    },
    ({ type, index, solo, soloSafe }) =>
      wrapWingTool(async () => {
        const result = await setStripSolo(ctx, { type, index, solo, soloSafe });
        return {
          content: [textResult(`${type} ${index} solo updated: ${result.ack.status}`)],
          structuredContent: { ...result },
        };
      }),
  );

  server.registerTool(
    "wing_get_solo_config",
    {
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      title: "Wing: Get global solo config",
      description:
        "Reads the console's global solo-behavior config (`/cfg/solo`): mode (LIVE/STUDIO/SIP), which physical " +
        "destination(s) receive soloed audio (PH headphones / SPK speakers / PH+SPK), solo mute/dim/mono/flip, " +
        "the PFL/AFL tap point for each strip family, and the 'source solo' assignment (a spare channel/aux " +
        "dedicated to monitoring an arbitrary input, like talkback's assign mechanism).",
      inputSchema: {},
    },
    () =>
      wrapWingTool(async () => {
        const config = await getSoloConfig(ctx);
        return {
          content: [textResult(`Solo config: mode=${config.mode}, monitor=${config.monitor}`)],
          structuredContent: { ...config },
        };
      }),
  );

  server.registerTool(
    "wing_set_solo_config",
    {
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      title: "Wing: Set global solo config",
      description: "Sets any subset of the console's global solo-behavior config (`/cfg/solo`) in a single bulk-set call.",
      inputSchema: {
        mode: z.enum(SOLO_MODE_VALUES as unknown as [SoloMode, ...SoloMode[]]).optional(),
        monitor: z.enum(SOLO_MONITOR_DEST_VALUES as unknown as [SoloMonitorDest, ...SoloMonitorDest[]]).optional(),
        mute: z.boolean().optional(),
        dim: z.boolean().optional(),
        mono: z.boolean().optional(),
        flip: z.boolean().optional(),
        channelTap: z.enum(SOLO_TAP_VALUES as unknown as [SoloTap, ...SoloTap[]]).optional(),
        busTap: z.enum(SOLO_TAP_VALUES as unknown as [SoloTap, ...SoloTap[]]).optional(),
        mainTap: z.enum(SOLO_TAP_VALUES as unknown as [SoloTap, ...SoloTap[]]).optional(),
        matrixTap: z.enum(SOLO_TAP_VALUES as unknown as [SoloTap, ...SoloTap[]]).optional(),
        sourceSoloAssign: z.enum(SOURCE_SOLO_ASSIGN_VALUES as unknown as [SourceSoloAssign, ...SourceSoloAssign[]]).optional(),
        sourceSoloOn: z.boolean().optional(),
        sourceSoloGroup: z.number().int().min(1).max(13).optional(),
        sourceSoloIn: z.number().int().min(1).max(64).optional(),
      },
    },
    (opts) =>
      wrapWingTool(async () => {
        const result = await setSoloConfig(ctx, opts);
        return {
          content: [textResult(`Solo config updated: ${result.ack.status}`)],
          structuredContent: { ...result },
        };
      }),
  );

  server.registerTool(
    "wing_get_monitor_bus",
    {
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      title: "Wing: Get control-room monitor bus",
      description:
        "Reads a control-room monitor bus's core routing/level fields (bus 1 = Monitor A, bus 2 = Monitor B): " +
        "level and whether it's read-only on this bus (`levelReadOnly` — some buses have a dedicated physical " +
        "knob driving level, some don't, and this can differ per bus on the same console), invert, pan, width, " +
        "limiter, delay on/length, dim/PFL-dim levels, band-solo trim, source level/mix, source routing, " +
        "direct-in routing, and tags. Does not include the monitor bus's EQ node (6 bands + 2 shelves) — " +
        "read/write that with the generic wing_get/wing_set/wing_dump tools on /cfg/mon/{bus}/eq/*.",
      inputSchema: { bus: monitorBusSchema },
    },
    ({ bus }) =>
      wrapWingTool(async () => {
        const status = await getMonitorBus(ctx, bus as MonitorBusIndex);
        return {
          content: [textResult(`Monitor bus ${bus}: source=${status.source}, level=${status.levelDb}dB`)],
          structuredContent: { ...status },
        };
      }),
  );

  server.registerTool(
    "wing_set_monitor_bus",
    {
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      title: "Wing: Set control-room monitor bus",
      description:
        "Sets any subset of a control-room monitor bus's core fields (bus 1 = Monitor A, bus 2 = Monitor B) in a " +
        "single bulk-set call. `source` and `directIn` are \"OFF\" or a \"<TYPE>.<N>\" token — source accepts " +
        "MAIN/MTX/BUS/AUX, directIn accepts CH/AUX/BUS/MAIN/MTX. No `levelDb` field here: it's driven by a " +
        "physical monitor knob (and read-only) on some buses but not others — check `levelReadOnly` from " +
        "wing_get_monitor_bus; when false, write it directly with the generic wing_set tool.",
      inputSchema: {
        bus: monitorBusSchema,
        invert: z.boolean().optional(),
        pan: z.number().min(-100).max(100).optional(),
        width: z.number().min(-150).max(150).optional(),
        limiterDb: z.number().min(-40).max(0).optional(),
        delayOn: z.boolean().optional(),
        delayMeters: z.number().min(0.1).max(100).optional(),
        dimLevelDb: z.number().min(0).max(40).optional(),
        pflDimDb: z.number().min(0).max(40).optional(),
        bandSoloTrimDb: z.number().min(0).max(24).optional(),
        sourceLevelDb: z.number().min(-144).max(10).optional(),
        sourceMixDb: z.number().min(-144).max(10).optional(),
        source: z.enum(MONITOR_BUS_SRC_VALUES as [string, ...string[]]).optional(),
        directIn: z.enum(MONITOR_BUS_DIRIN_VALUES as [string, ...string[]]).optional(),
        tags: z.string().max(80).optional(),
      },
    },
    ({ bus, ...rest }) =>
      wrapWingTool(async () => {
        const result = await setMonitorBus(ctx, { bus: bus as MonitorBusIndex, ...rest });
        return {
          content: [textResult(`Monitor bus ${bus} updated: ${result.ack.status}`)],
          structuredContent: { ...result },
        };
      }),
  );
}
