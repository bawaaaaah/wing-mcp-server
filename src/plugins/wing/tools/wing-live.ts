import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  formatWLiveCard,
  getWLiveStatus,
  manageWLiveMarker,
  manageWLiveSession,
  runWLiveTransport,
  WLIVE_CARD_SLOTS,
  WLIVE_MARKER_ACTIONS,
  WLIVE_SESSION_ACTIONS,
  WLIVE_TRANSPORT_ACTIONS,
  type WLiveMarkerAction,
  type WLiveSessionAction,
  type WLiveTransportAction,
} from "../wing-live.js";
import type { WingPluginContext } from "../wing-plugin.js";
import { textResult, wrapWingTool } from "./generic.js";

const cardSchema = z.number().int().refine((n) => (WLIVE_CARD_SLOTS as readonly number[]).includes(n), {
  message: "card must be 1 or 2",
});

export function registerWingLiveTools(server: McpServer, ctx: WingPluginContext): void {
  server.registerTool(
    "wing_get_wlive_status",
    {
      title: "Wing: Get WING Live card status",
      description:
        "Reads the WING Live expansion card's status: whether one is installed at all (vs. no card or a " +
        "different card like WDANTE/WMADI), global settings (SD link mode, battery, auto-input, auto " +
        "stop/play/rec behavior), and per-slot (1/2) session/recording status. `installed: false` means no " +
        "further per-slot data was even attempted. Each slot also reports `reachable: false` if its status " +
        "couldn't be read (e.g. no SD card inserted) — this never throws for that case.",
      inputSchema: {},
    },
    () =>
      wrapWingTool(async () => {
        const status = await getWLiveStatus(ctx);
        const text = status.installed
          ? `WING Live installed. Slots: ${status.cards.map((c) => `${c.card}=${c.reachable ? c.state : "unreachable"}`).join(", ")}`
          : `No WING Live card installed (cards/$type: ${status.cardType}).`;
        return { content: [textResult(text)], structuredContent: { ...status } };
      }),
  );

  server.registerTool(
    "wing_wlive_transport",
    {
      title: "Wing: WING Live transport control",
      description: "Stops, pauses, plays, or starts recording on one WING Live SD slot (1 or 2).",
      inputSchema: {
        card: cardSchema,
        action: z.enum(WLIVE_TRANSPORT_ACTIONS as unknown as [WLiveTransportAction, ...WLiveTransportAction[]]),
      },
    },
    ({ card, action }) =>
      wrapWingTool(async () => {
        const ack = await runWLiveTransport(ctx, { card, action });
        return {
          content: [textResult(`WING Live card ${card} transport set to ${action}: ${ack.status}`)],
          structuredContent: { card, action, ...ack },
        };
      }),
  );

  server.registerTool(
    "wing_wlive_session",
    {
      title: "Wing: WING Live session management",
      description:
        'Opens ("open", needs sessionIndex 0..100), deletes ("delete", needs sessionIndex), or renames ' +
        '("rename", needs name) a session on one WING Live SD slot. Renaming only applies while the slot ' +
        "is stopped.",
      inputSchema: {
        card: cardSchema,
        action: z.enum(WLIVE_SESSION_ACTIONS as unknown as [WLiveSessionAction, ...WLiveSessionAction[]]),
        sessionIndex: z.number().int().min(0).max(100).optional(),
        name: z.string().max(19).optional(),
      },
    },
    ({ card, action, sessionIndex, name }) =>
      wrapWingTool(async () => {
        const ack = await manageWLiveSession(ctx, { card, action, sessionIndex, name });
        return {
          content: [textResult(`WING Live card ${card} session ${action}: ${ack.status}`)],
          structuredContent: { card, action, ...ack },
        };
      }),
  );

  server.registerTool(
    "wing_wlive_marker",
    {
      title: "Wing: WING Live marker management",
      description:
        'Sets a marker at the current position ("set"), edits/goes to/deletes a marker by index ' +
        '("edit"/"goto"/"delete", need markerIndex 0..100), or seeks to an arbitrary time ("seek", needs ' +
        "timeMs — internally writes stime then gotomarker=101 to commit it; 101 is an internal commit " +
        "signal, not a real marker, so it isn't accepted as markerIndex for the other actions).",
      inputSchema: {
        card: cardSchema,
        action: z.enum(WLIVE_MARKER_ACTIONS as unknown as [WLiveMarkerAction, ...WLiveMarkerAction[]]),
        markerIndex: z.number().int().min(0).max(100).optional(),
        timeMs: z.number().min(0).optional(),
      },
    },
    ({ card, action, markerIndex, timeMs }) =>
      wrapWingTool(async () => {
        const ack = await manageWLiveMarker(ctx, { card, action, markerIndex, timeMs });
        return {
          content: [textResult(`WING Live card ${card} marker ${action}: ${ack.status}`)],
          structuredContent: { card, action, ...ack },
        };
      }),
  );

  server.registerTool(
    "wing_wlive_format_sd_card",
    {
      title: "Wing: Format a WING Live SD card",
      description:
        "DESTRUCTIVE — erases every session on the SD card in the given WING Live slot (1 or 2). There is no " +
        "undo. Only call this after explicit user confirmation of the slot and that its contents are meant to " +
        "be erased; never call it speculatively or in a retry loop.",
      inputSchema: {
        card: cardSchema,
      },
    },
    ({ card }) =>
      wrapWingTool(async () => {
        const ack = await formatWLiveCard(ctx, card);
        return {
          content: [textResult(`WING Live card ${card} SD card format requested: ${ack.status}`)],
          structuredContent: { card, ...ack },
        };
      }),
  );
}
