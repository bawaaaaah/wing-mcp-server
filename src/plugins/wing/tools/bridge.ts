import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  BRIDGE_CONFIGURE_SHAPE,
  BRIDGE_PROFILES_SHAPE,
  BRIDGE_SAFES_SHAPE,
  configureBridge,
  setBridgeProfiles,
  setBridgeSafes,
  type BridgeStatus,
} from "../wing-bridge.js";
import { SAFE_KINDS } from "../wing-bridge-safes.js";
import type { WingPluginContext } from "../wing-plugin.js";
import { textResult, wrapWingTool } from "./generic.js";

function formatSafes(status: BridgeStatus): string {
  const parts = SAFE_KINDS.filter((kind) => status.safes[kind].length > 0).map((kind) => `${kind} ${status.safes[kind].join(",")}`);
  const profiles = status.profiles.length ? `; ${status.profiles.length} device profile(s): ${status.profiles.map((p) => p.name).join(", ")}` : "";
  return (parts.length === 0 ? "no safe strips" : `safe: ${parts.join("; ")} (${status.safesState})`) + profiles;
}

function formatStatus(status: BridgeStatus): string {
  if (!status.enabled) return `Bridge is OFF (${formatSafes(status)})`;
  const osc = status.osc;
  const oscText = osc?.listening ? `OSC on port ${osc.port}` : `OSC not listening${status.lastError ? ` (${status.lastError})` : ""}`;
  return `Bridge ON: ${oscText}, ${status.clients.length} client(s), ${osc?.blocked ?? 0} write(s) blocked; ${formatSafes(status)}`;
}

function result(status: BridgeStatus) {
  return { content: [textResult(formatStatus(status))], structuredContent: { ...status } };
}

export function registerBridgeTools(server: McpServer, ctx: WingPluginContext): void {
  server.registerTool(
    "wing_bridge_status",
    {
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      title: "Wing: Bridge status",
      description:
        "Reads the bridge: tablets and OSC apps connect to this server instead of the console, so the console " +
        "sees one connection and strips marked safe cannot be changed from them. Returns whether it is on, the " +
        "OSC and native listeners and their counters, discovery, connected clients (OSC and native), the safe strips " +
        "and the paths they protect, the native node map's state (writes wait while it is mapped), and the " +
        "most recent refused writes. Safes bind bridged clients only, never these MCP tools or the dashboard.",
      inputSchema: {},
    },
    () => wrapWingTool(async () => result(ctx.bridge.getStatus())),
  );

  server.registerTool(
    "wing_bridge_configure",
    {
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      title: "Wing: Configure the bridge",
      description:
        "Turns the bridge on or off and sets its listeners: OSC apps (port), the console's own apps WING-Q/Co-Pilot/" +
        "WING Edit (native port, all multiplexed onto one console connection, meters included), WING? discovery " +
        "(name, advertised address, serial), the interface, and whether safes also lock scene recall and /cfg. Any " +
        "subset of fields, merged onto the saved config; persisted like the dashboard's Config tab. Never reconnects " +
        "the console. Apps then point at this server's address (or pick it in discovery) instead of the console's. " +
        "Safes only hold if the apps cannot reach the console directly (separate network, VLAN or firewall).",
      inputSchema: BRIDGE_CONFIGURE_SHAPE,
    },
    (input) => wrapWingTool(async () => result(await configureBridge(ctx, input))),
  );

  server.registerTool(
    "wing_bridge_set_safes",
    {
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      title: "Wing: Set bridge safe strips",
      description:
        "Marks strips safe: bridged clients may not change them. A channel/aux safe covers the strip and the input " +
        "it is patched from, but not its sends or main assigns (sends belong to their destination). A bus/main/" +
        "matrix safe covers the strip and every send coming into it, not its own outgoing sends. A DCA safe covers " +
        "the DCA. Indexes are 1-based as on the console. mode replace (default) sets the whole list; add/remove " +
        "change only what is given. Persisted.",
      inputSchema: BRIDGE_SAFES_SHAPE,
    },
    ({ mode, ...change }) => wrapWingTool(async () => result(await setBridgeSafes(ctx, mode ?? "replace", change))),
  );

  server.registerTool(
    "wing_bridge_set_profiles",
    {
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      title: "Wing: Set bridge device profiles",
      description:
        "Gives a device on the bridge (a musician's tablet, ...) its own rights. A profile matches by every one of " +
        "match.ip, match.mac (from the server's ARP table, same network only) and match.model (WING-Q's device model, " +
        'e.g. "SM-X700") it gives. mode "allow": only the strips in `allow` may be changed, everything else is read-only; ' +
        'scope "mix" (default): an allowed bus/main/matrix entirely (EQ, compression, fader... it is the device\'s own ' +
        "mix; its inserts switch on/off and the inserted FX's parameters are settable, not which FX is loaded nor " +
        "its model, nor its own sends to matrices/buses/mains), only the mixing controls of every send into it (level, on, pan, pre/post, pan links), and only fader/" +
        'mute/pan of an allowed channel/aux/DCA, whose processing reaches every mix; scope "full": everything about them. ' +
        'mode "safes": `safes` are added to the global safes for that device. Global safes apply on top, unless an ' +
        '"allow" profile sets applyGlobal: false (its list then wins, even on strips safe for everyone else); a ' +
        "device no profile matches gets the global list only. wing_bridge_status lists connected clients with their " +
        "MAC, model and matched profile, to write a profile from. Persisted.",
      inputSchema: BRIDGE_PROFILES_SHAPE,
    },
    ({ mode, profiles, ids }) => wrapWingTool(async () => result(await setBridgeProfiles(ctx, mode ?? "replace", profiles, ids))),
  );
}
