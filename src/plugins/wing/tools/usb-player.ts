import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  getUsbPlayerState,
  runUsbPlayAction,
  runUsbRecordAction,
  setUsbRepeat,
  USB_PLAY_ACTIONS,
  USB_REC_ACTIONS,
} from "../wing-usb-player.js";
import type { WingPluginContext } from "../wing-plugin.js";
import { textResult, wrapWingTool } from "./generic.js";

export function registerUsbPlayerTools(server: McpServer, ctx: WingPluginContext): void {
  server.registerTool(
    "wing_usb_player_status",
    {
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      title: "Wing: USB player/recorder status",
      description:
        "Reads the console's USB stereo player/recorder module — the single combined player+recorder for " +
        "whatever's plugged into the console's USB port (there is no separate SD-card module). Returns USB " +
        "drive state, the browsable track list (1-based index, matching what `wing_usb_play`'s `index` " +
        "parameter expects), current playback state/position/song metadata/repeat, and recording " +
        "state/position/file.",
      inputSchema: {},
    },
    () =>
      wrapWingTool(async () => {
        const state = await getUsbPlayerState(ctx);
        const text =
          `USB: ${state.usb.state}${state.usb.volumeName ? ` (${state.usb.volumeName})` : ""} — ` +
          `Play: ${state.play.state}${state.play.song ? ` "${state.play.song}"` : ""} ` +
          `${state.play.pos.display}/${state.play.total.display}${state.play.repeat ? " [repeat on]" : ""} — ` +
          `Rec: ${state.rec.state} ${state.rec.time.display}`;
        return { content: [textResult(text)], structuredContent: { ...state } };
      }),
  );

  server.registerTool(
    "wing_usb_play",
    {
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      title: "Wing: USB player transport",
      description:
        "Drives the USB player's transport. `action` is one of " +
        `${USB_PLAY_ACTIONS.join(", ")}. ` +
        "PLAYFILE plays an arbitrary path (requires `file`). PLAY with `index` selects a 1-based track from " +
        "the browsable list `wing_usb_player_status` returns before playing it — omit `index` to just resume " +
        "the current track. NEXT/PREV/PAUSE/STOP/IDLE take no other parameters.",
      inputSchema: {
        action: z.enum(USB_PLAY_ACTIONS),
        file: z.string().optional(),
        index: z.number().int().min(1).optional(),
      },
    },
    ({ action, file, index }) =>
      wrapWingTool(async () => {
        const ack = await runUsbPlayAction(ctx, { action, file, index });
        return {
          content: [textResult(`USB player: ${action}${file ? ` "${file}"` : ""}${index ? ` (track ${index})` : ""} — ${ack.status}`)],
          structuredContent: { action, file, index, ...ack },
        };
      }),
  );

  server.registerTool(
    "wing_usb_record",
    {
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      title: "Wing: USB recorder transport",
      description: `Drives the USB recorder's transport. \`action\` is one of ${USB_REC_ACTIONS.join(", ")}.`,
      inputSchema: {
        action: z.enum(USB_REC_ACTIONS),
      },
    },
    ({ action }) =>
      wrapWingTool(async () => {
        const ack = await runUsbRecordAction(ctx, { action });
        return { content: [textResult(`USB recorder: ${action} — ${ack.status}`)], structuredContent: { action, ...ack } };
      }),
  );

  server.registerTool(
    "wing_usb_set_repeat",
    {
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      title: "Wing: Set USB player repeat",
      description: "Turns the USB player's repeat mode on or off.",
      inputSchema: { on: z.boolean() },
    },
    ({ on }) =>
      wrapWingTool(async () => {
        const ack = await setUsbRepeat(ctx, on);
        return { content: [textResult(`USB player repeat: ${on ? "on" : "off"} — ${ack.status}`)], structuredContent: { on, ...ack } };
      }),
  );
}
