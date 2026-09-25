import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { recordRegisteredTools } from "../../../core/tool-recorder.js";
import type { WingPluginContext } from "../wing-plugin.js";
import { registerAutoCompressTools } from "./auto-compress.js";
import { registerAutoEqTools } from "./auto-eq.js";
import { registerMicCalibrationTools } from "./mic-calibration.js";
import { registerAutoGainTools } from "./autogain.js";
import { registerAutoGateTools } from "./auto-gate.js";
import { registerBusMainMatrixTools } from "./bus-main-matrix.js";
import { registerChannelTools } from "./channel.js";
import { registerChannelTransferTools } from "./channel-transfer.js";
import { registerDcaMutegroupTools } from "./dca-mutegroup.js";
import { registerDelayTools } from "./delay.js";
import { registerDynamicsStatusTools } from "./dynamics-status.js";
import { registerFadeTools } from "./fade.js";
import { registerGenericTools } from "./generic.js";
import { registerGpioTools } from "./gpio.js";
import { registerGroupTools } from "./groups.js";
import { registerInputPatchTools } from "./input-patch.js";
import { registerInsertTools } from "./insert.js";
import { registerJournalTools } from "./journal.js";
import { registerLightingTools } from "./lighting.js";
import { registerLinkStatusTools } from "./link-status.js";
import { registerMatrixDirectTools } from "./matrix-direct.js";
import { registerMeterStatsTools } from "./meter-stats.js";
import { registerNameListTools } from "./names.js";
import { registerOscMirrorTools } from "./osc-mirror.js";
import { registerPatchTools } from "./patch.js";
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
    id: "journal",
    label: "History, undo and status",
    description: "Write history with previous values, undo of any journaled write, and a one-call connection status.",
    category: "core",
    register: registerJournalTools,
  },
  {
    id: "patch",
    label: "Patch, user signals and identity",
    description:
      "Batch reads of the input/output patch, user signals and sources; copy/clear name-color-icon; icon search; stage-box map and patch export.",
    category: "io",
    register: registerPatchTools,
  },
  {
    id: "channel-transfer",
    label: "Channel copy and swap",
    description: "Copy one channel/aux strip onto another, or swap two, in whole or by section, with a dry-run diff.",
    category: "io",
    register: registerChannelTransferTools,
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
  const journaled = journalWriteTools(server, ctx);
  for (const group of WING_TOOL_GROUPS) {
    if (onGroupTool) {
      group.register(
        recordRegisteredTools(journaled, (name) => onGroupTool(group.id, name)),
        ctx,
      );
    } else {
      group.register(journaled, ctx);
    }
  }
}

/**
 * Write tools whose calls are *not* opened as a journal batch. Each either keeps its own undo
 * (auto-*, fades, value memory), writes transport/command nodes whose "previous value" means nothing
 * (scene actions, USB/WING LIVE transport, flash save), or manages its own batch (wing_undo). A fade
 * or an auto-compress run also writes dozens of times a second, which is exactly where reading every
 * previous value first would hurt.
 */
const UNJOURNALED_TOOLS = new Set([
  "wing_undo",
  "wing_fade",
  "wing_fade_cancel",
  "wing_auto_gain",
  "wing_auto_compress",
  "wing_auto_gate",
  "wing_auto_eq_balance",
  "wing_auto_eq_undo",
  "wing_adjust_value_by_delta",
  "wing_restore_value",
  "wing_undo_last_adjust",
  "wing_scene_recall",
  "wing_scene_next",
  "wing_scene_prev",
  "wing_save_to_flash",
  "wing_usb_play",
  "wing_usb_record",
  "wing_usb_set_repeat",
  "wing_wlive_transport",
  "wing_wlive_session",
  "wing_wlive_marker",
  "wing_wlive_format_sd_card",
  "wing_clear_link_errors",
]);

/**
 * Write tools that enforce show mode themselves, per key (a cosmetic key never needs confirming), or
 * that cannot be heard at all — they touch only names/colors/labels, server-side state, or the
 * surface. Every other write tool needs `confirm: true` while show mode is on.
 */
const SHOW_MODE_EXEMPT_TOOLS = new Set([
  // Checked per key inside the tool.
  "wing_set",
  "wing_bulk_set",
  "wing_usr_set",
  "wing_copy_identity",
  "wing_clear_identity",
  "wing_bus_set_mono",
  "wing_channel_copy",
  "wing_channel_swap",
  "wing_undo",
  // Inaudible.
  "wing_channel_set_name",
  "wing_mutegroup_set_name",
  "wing_set_scribble",
  "wing_set_srcauto",
  "wing_set_selected_strip",
  "wing_set_lighting",
  "wing_set_box_map",
  "wing_set_osc_mirror",
  "wing_set_autosave_config",
  "wing_save_to_flash",
  "wing_clear_link_errors",
  "wing_preset_save",
  "wing_preset_delete",
  "wing_mic_calibration_save",
  "wing_mic_calibration_delete",
  "wing_fade_cancel",
]);

type ToolConfig = { annotations?: { readOnlyHint?: boolean }; inputSchema?: Record<string, z.ZodTypeAny> };

/**
 * Wraps `server` so every non-read-only tool call runs inside its own journal batch (see
 * wing-write-journal.ts): whatever the handler writes through `ctx.client.bulkSet` is recorded with
 * its previous value, under one batch id per call, without any tool having to know about it.
 *
 * It also enforces show mode for the typed setters, which predate it: each audible write tool gains
 * an optional `confirm` parameter, and while show mode is on a call without it is refused before
 * the handler runs.
 */
function journalWriteTools(server: McpServer, ctx: WingPluginContext): McpServer {
  return new Proxy(server, {
    get(target, prop) {
      if (prop === "registerTool") {
        const original = Reflect.get(target, prop, target) as (...args: unknown[]) => unknown;
        return (name: string, config: ToolConfig, handler: (...a: unknown[]) => unknown) => {
          if (config?.annotations?.readOnlyHint || typeof handler !== "function") {
            return original.call(target, name, config, handler);
          }
          let wrapped = handler;
          let effectiveConfig = config;
          if (!SHOW_MODE_EXEMPT_TOOLS.has(name)) {
            const hasArgs = config.inputSchema !== undefined;
            effectiveConfig = {
              ...config,
              inputSchema: {
                ...(config.inputSchema ?? {}),
                confirm: z.boolean().optional().describe("Required while the server's show mode is on: this write is audible."),
              },
            };
            const inner = wrapped;
            wrapped = (...handlerArgs: unknown[]) => {
              const args = handlerArgs[0] as { confirm?: boolean } | undefined;
              if (ctx.getConfig().showMode && !args?.confirm) {
                return {
                  isError: true,
                  content: [
                    {
                      type: "text",
                      text: `Show mode is on and ${name} changes the sound. Confirm with the operator, then call again with confirm: true.`,
                    },
                  ],
                };
              }
              // A tool registered without arguments is called with (extra) only; keep that shape.
              return hasArgs ? inner(...handlerArgs) : inner(...handlerArgs.slice(1));
            };
          }
          if (!UNJOURNALED_TOOLS.has(name)) {
            const inner = wrapped;
            wrapped = (...handlerArgs: unknown[]) => ctx.journal.runBatch(name, async () => inner(...handlerArgs));
          }
          return original.call(target, name, effectiveConfig, wrapped);
        };
      }
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  }) as McpServer;
}
