import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { recordRegisteredTools } from "../../../core/tool-recorder.js";
import type { WingPluginContext } from "../wing-plugin.js";
import { registerAutoCompressTools } from "./auto-compress.js";
import { registerAutoEqTools } from "./auto-eq.js";
import { registerMicCalibrationTools } from "./mic-calibration.js";
import { registerAutoGainTools } from "./autogain.js";
import { registerAutoGateTools } from "./auto-gate.js";
import { registerBusMainMatrixTools } from "./bus-main-matrix.js";
import { registerChannelTools } from "./channel.js";
import { registerDcaMutegroupTools } from "./dca-mutegroup.js";
import { registerDelayTools } from "./delay.js";
import { registerDynamicsStatusTools } from "./dynamics-status.js";
import { registerFadeTools } from "./fade.js";
import { registerGenericTools } from "./generic.js";
import { registerGpioTools } from "./gpio.js";
import { registerGroupTools } from "./groups.js";
import { registerInputPatchTools } from "./input-patch.js";
import { registerInsertTools } from "./insert.js";
import { registerLightingTools } from "./lighting.js";
import { registerLinkStatusTools } from "./link-status.js";
import { registerMatrixDirectTools } from "./matrix-direct.js";
import { registerMeterStatsTools } from "./meter-stats.js";
import { registerNameListTools } from "./names.js";
import { registerOscMirrorTools } from "./osc-mirror.js";
import { registerPluginCatalogTools } from "./plugin-catalog.js";
import { registerPresetTools } from "./presets.js";
import { registerProcessingToggleTools } from "./processing-toggle.js";
import { registerProcOrderTools } from "./proc-order.js";
import { registerRoutingTools } from "./routing.js";
import { registerRtaTools } from "./rta.js";
import { registerSaveFlashTools } from "./save-flash.js";
import { registerSceneTools } from "./scenes.js";
import { registerScribbleTools } from "./scribble.js";
import { registerSelectedStripTools } from "./selected-strip.js";
import { registerSoloMonitorTools } from "./solo-monitor.js";
import { registerSourceTools } from "./source.js";
import { registerTalkbackTools } from "./talkback.js";
import { registerUsbPlayerTools } from "./usb-player.js";
import { registerValueMemoryTools } from "./value-memory.js";
import { registerWingLiveTools } from "./wing-live.js";

/**
 * One entry per `register*Tools` module. This table is the single place that says which tools
 * exist as a *unit* for visibility purposes (`server.tools` in data/config.json, and the
 * dashboard's Tools page) — `test/plugins/wing/wing-tool-groups.test.ts` fails the build if a
 * module is added here without being wired up, so a new tool cannot silently escape grouping.
 *
 * `id` is persisted verbatim wherever an operator names a group (a profile's `groups` list, or
 * `server.tools.enable`/`disable`). Treat it as a compatibility surface: renaming one silently
 * re-enables that group on every existing install.
 */
export interface WingToolGroup {
  id: string;
  label: string;
  description: string;
  /** Presentational bucket for the dashboard; has no effect on resolution. */
  category: "core" | "automation" | "processing" | "io" | "show";
  register: (server: McpServer, ctx: WingPluginContext) => void;
}

export const WING_TOOL_GROUPS: readonly WingToolGroup[] = [
  {
    id: "generic",
    label: "Generic OSC access",
    description: "The escape hatch: get/set/dump/describe any node path, plus discovery and bulk writes.",
    category: "core",
    register: registerGenericTools,
  },
  {
    id: "channel",
    label: "Input channels",
    description: "Fader, mute, name, pan and summary for the console's input channels.",
    category: "core",
    register: registerChannelTools,
  },
  {
    id: "bus-main-matrix",
    label: "Buses, mains and matrices",
    description: "Fader, mute and summary for buses, main outputs and matrices.",
    category: "core",
    register: registerBusMainMatrixTools,
  },
  {
    id: "dca-mutegroup",
    label: "DCAs and mute groups",
    description: "Fader and mute for DCAs, plus mute group membership, naming and toggling.",
    category: "core",
    register: registerDcaMutegroupTools,
  },
  {
    id: "delay",
    label: "Delay",
    description: "Read and write per-strip delay.",
    category: "core",
    register: registerDelayTools,
  },
  {
    id: "groups",
    label: "Group membership",
    description: "Read and write which channels belong to a fader/mute group.",
    category: "core",
    register: registerGroupTools,
  },
  {
    id: "routing",
    label: "Sends",
    description: "Read and write a channel's send level to a bus.",
    category: "core",
    register: registerRoutingTools,
  },
  {
    id: "scenes",
    label: "Scenes",
    description: "List, recall, and step through the console's scene list.",
    category: "core",
    register: registerSceneTools,
  },
  {
    id: "names",
    label: "Name listing",
    description: "Reads every strip's name in one batched call, across all categories.",
    category: "core",
    register: registerNameListTools,
  },
  {
    id: "fade",
    label: "Fader ramps",
    description: "Ramps a fader to a target over time, with cancellation.",
    category: "core",
    register: registerFadeTools,
  },
  {
    id: "selected-strip",
    label: "Selected strip",
    description: "Reads and sets which strip is selected on the console's own control surface.",
    category: "core",
    register: registerSelectedStripTools,
  },
  {
    id: "autogain",
    label: "Auto gain",
    description: "Measures live input level and sets gain to hit a target headroom.",
    category: "automation",
    register: registerAutoGainTools,
  },
  {
    id: "auto-compress",
    label: "Auto compress",
    description: "Measures live program material and sets compressor parameters, resumable across calls.",
    category: "automation",
    register: registerAutoCompressTools,
  },
  {
    id: "auto-gate",
    label: "Auto gate",
    description: "Measures live noise floor and sets gate threshold.",
    category: "automation",
    register: registerAutoGateTools,
  },
  {
    id: "auto-eq",
    label: "Auto EQ balance",
    description: "Measures a channel against a reference band balance and adjusts EQ, with undo.",
    category: "automation",
    register: registerAutoEqTools,
  },
  {
    id: "mic-calibration",
    label: "Mic calibration",
    description: "Saves, lists and deletes reusable per-microphone gain/EQ calibration profiles.",
    category: "automation",
    register: registerMicCalibrationTools,
  },
  {
    id: "dynamics-status",
    label: "Dynamics status",
    description: "Reads gate/compressor gain reduction and activity for a strip.",
    category: "automation",
    register: registerDynamicsStatusTools,
  },
  {
    id: "meter-stats",
    label: "Meter statistics",
    description: "Peak/RMS/LUFS-style level statistics sampled over a short window.",
    category: "automation",
    register: registerMeterStatsTools,
  },
  {
    id: "rta",
    label: "RTA",
    description: "Reads the real-time analyzer, and reads/sets which tap it is reading from.",
    category: "automation",
    register: registerRtaTools,
  },
  {
    id: "insert",
    label: "Inserts",
    description: "Reads and writes a strip's insert point assignment.",
    category: "processing",
    register: registerInsertTools,
  },
  {
    id: "processing-toggle",
    label: "Processing block bypass",
    description: "Reads and toggles whether a processing block (gate, EQ, compressor, …) is active.",
    category: "processing",
    register: registerProcessingToggleTools,
  },
  {
    id: "proc-order",
    label: "Processing order",
    description: "Reads and writes a channel's processing chain order.",
    category: "processing",
    register: registerProcOrderTools,
  },
  {
    id: "plugin-catalog",
    label: "Plugin catalog",
    description: "Looks up which effect model is loaded where, and where each model is used.",
    category: "processing",
    register: registerPluginCatalogTools,
  },
  {
    id: "value-memory",
    label: "Value memory",
    description: "Stashes and restores a single parameter value, and nudges or undoes it by a delta.",
    category: "processing",
    register: registerValueMemoryTools,
  },
  {
    id: "input-patch",
    label: "Input patching",
    description: "Reads and writes physical/alt input patching, source auto-switching and the global alt switch.",
    category: "io",
    register: registerInputPatchTools,
  },
  {
    id: "source",
    label: "Channel source",
    description: "Reads and writes which physical or USB source a channel is fed from.",
    category: "io",
    register: registerSourceTools,
  },
  {
    id: "matrix-direct",
    label: "Matrix direct inputs",
    description: "Reads and writes a matrix's direct (non-bus) input assignment.",
    category: "io",
    register: registerMatrixDirectTools,
  },
  {
    id: "link-status",
    label: "Link status",
    description: "Reads stereo/surround link error status and clears it.",
    category: "io",
    register: registerLinkStatusTools,
  },
  {
    id: "talkback",
    label: "Talkback",
    description: "Reads and writes talkback assignment, source and destination.",
    category: "io",
    register: registerTalkbackTools,
  },
  {
    id: "gpio",
    label: "GPIO",
    description: "Reads and writes the console's GPIO pin mode and state.",
    category: "io",
    register: registerGpioTools,
  },
  {
    id: "osc-mirror",
    label: "OSC mirroring",
    description: "Reads and writes forwarding of every OSC and meter packet to a second host.",
    category: "io",
    register: registerOscMirrorTools,
  },
  {
    id: "presets",
    label: "Channel presets",
    description: "Saves, lists, reads, loads and deletes reusable channel-strip presets.",
    category: "show",
    register: registerPresetTools,
  },
  {
    id: "save-flash",
    label: "Save to flash / autosave",
    description: "Triggers a save-to-flash, and reads/writes the autosave interval.",
    category: "show",
    register: registerSaveFlashTools,
  },
  {
    id: "scribble",
    label: "Scribble strips",
    description: "Reads and writes a strip's on-console scribble-strip label and color.",
    category: "show",
    register: registerScribbleTools,
  },
  {
    id: "lighting",
    label: "Lighting integration",
    description: "Reads and writes the console's lighting-control output.",
    category: "show",
    register: registerLightingTools,
  },
  {
    id: "solo-monitor",
    label: "Solo and monitor bus",
    description: "Reads and writes per-strip solo, solo configuration, and the monitor bus.",
    category: "show",
    register: registerSoloMonitorTools,
  },
  {
    id: "usb-player",
    label: "USB player/recorder",
    description: "Reads USB transport status and controls play, record and repeat.",
    category: "show",
    register: registerUsbPlayerTools,
  },
  {
    id: "wing-live",
    label: "WING LIVE recorder",
    description: "Reads status and controls the multitrack recorder: transport, sessions, markers, SD formatting.",
    category: "show",
    register: registerWingLiveTools,
  },
];

/**
 * Registers the whole WING MCP tool surface (generic escape hatch + convenience families) on
 * `server`. `onGroupTool`, when given, is told which group each registered tool belongs to — used
 * only when building the tool catalogue (tool-catalogue.ts) for the dashboard and `GET
 * /api/tools`. A real MCP session never passes it: nothing here wraps `server` in that case, so
 * per-session registration costs exactly what it always has.
 */
export function registerWingTools(
  server: McpServer,
  ctx: WingPluginContext,
  onGroupTool?: (groupId: string, name: string) => void,
): void {
  for (const group of WING_TOOL_GROUPS) {
    if (onGroupTool) {
      group.register(
        recordRegisteredTools(server, (name) => onGroupTool(group.id, name)),
        ctx,
      );
    } else {
      group.register(server, ctx);
    }
  }
}
