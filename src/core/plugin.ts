import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Router } from "express";
import type { PluginToolCatalogue } from "./tool-catalogue.js";

export interface PluginHealth {
  status: "HEALTHY" | "DEGRADED" | "ERROR";
  detail?: Record<string, unknown>;
  errorMessage?: string;
}

/** Which WebSocket connection kind carries a live topic — see docs/websocket-protocol.md. */
export type LiveChannel = "control" | "stream";

/**
 * One topic a plugin offers over the WebSocket hub (core/ws-hub.ts), addressed by clients as
 * `"<pluginId>:<name>"`. The hub owns the sockets; a topic only says what a subscriber gets.
 */
export interface LiveTopic {
  /**
   * `control` topics are never dropped and share the connection with REST-over-WS replies;
   * `stream` topics are high-rate, superseded by the next frame, and dropped under backpressure.
   */
  channel: LiveChannel;
  /** The EventBus event type this topic is built from. Defaults to the topic's own name. */
  source?: string;
  /** Whether the frame is worth handing to permessage-deflate. Default true. */
  compress?: boolean;
  /**
   * Validates a subscription's params (throw to refuse them, with a message the client sees) and
   * returns what the hub needs: `key` groups subscribers whose params are equivalent, so each
   * frame is built and serialized once per group rather than once per socket; `ack` is returned
   * to the subscriber. Absent: the topic takes no params and every subscriber shares one group.
   */
  subscribe?(params: unknown): { key: string; params: unknown; ack?: unknown };
  /**
   * Builds a group's frame from the bus event's payload, or returns null to send nothing. Absent:
   * the payload as-is. Runs on the EventBus publisher's stack: it must be synchronous and cheap.
   */
  encode?(payload: unknown, params: unknown): unknown;
}

export interface McpPlugin {
  readonly id: string;
  readonly name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  getHealth(): Promise<PluginHealth>;
  registerTools(server: McpServer): void;
  /**
   * Guidance returned to the client in `initialize`, telling a model how this plugin's tools are
   * meant to be used before it has called any of them. Optional, and composed with the other
   * plugins' by the gateway — the gateway itself knows nothing about any particular console.
   */
  getInstructions?(): string;
  getConfigSchema(): object;
  getConfig(): unknown;
  setConfig(config: unknown): Promise<void>;
  registerHttpRoutes?(router: Router): void;
  /**
   * Static description of this plugin's tool surface, for the dashboard's tool-visibility page
   * and for `GET /api/tools`. Must not touch a device or a live connection — it describes what
   * the code registers, not the state of any console — so the gateway can build it once at boot
   * and reuse it for every session. A plugin that omits this still gets per-tool toggling; its
   * tools are reported under the synthetic "other" group with no named profiles.
   */
  getToolCatalogue?(): Promise<PluginToolCatalogue>;
  /**
   * The topics this plugin offers over the WebSocket hub, keyed by topic name. Read once when the
   * gateway starts. A plugin that omits this offers none.
   */
  liveTopics?(): Record<string, LiveTopic>;
}
