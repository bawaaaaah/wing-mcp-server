/**
 * The shape a plugin reports its tool surface in, so the gateway can offer per-tool /
 * per-group visibility without knowing anything about what the tools actually do.
 *
 * A catalogue describes the *code*, not a running instance: building one must never touch a
 * device, a socket, or this plugin's live config. `bytes` is measured from what a real MCP
 * client actually receives (see wing-tool-catalogue.ts for how the WING plugin builds one),
 * not recomputed by hand — that stays correct across SDK upgrades that change what gets
 * attached to a registered tool.
 */
export interface ToolGroupInfo {
  /**
   * Persisted verbatim in `data/config.json` (`server.tools.enable`/`disable`, and inside a
   * profile's `groups` list). Renaming one silently re-enables that group on every existing
   * install — treat ids as a compatibility surface, not a display string.
   */
  id: string;
  label: string;
  description: string;
  /** Optional bucket for grouping cards in the dashboard; purely presentational. */
  category?: string;
}

export interface ToolCatalogueEntry {
  name: string;
  title?: string;
  /** First sentence of the description, clipped — enough to recognize the tool, not its full text. */
  summary?: string;
  /** A `ToolGroupInfo.id`, or `UNGROUPED_ID` for a tool no group claims. */
  group: string;
  /** Exact bytes this tool contributes to `tools/list`, as JSON. */
  bytes: number;
  readOnly: boolean;
}

/** A named, pre-picked baseline — "core", "everything", "nothing", "read-only only", etc. */
export interface ToolProfile {
  id: string;
  label: string;
  description: string;
  /**
   * Group ids enabled by this profile. A group absent from every profile is off under all of
   * them. Ignored (may be left `[]`) when `readOnlyOnly` is set — that baseline is computed from
   * each tool's own `readOnly` flag instead of group membership.
   */
  groups: string[];
  /**
   * When set, this profile's baseline is "every tool whose readOnlyHint is true", cutting across
   * every group rather than picking whole ones — a profile a caller can hand to a client it does
   * not want mutating the console at all. `enable`/`disable` overrides still apply on top, same as
   * any other profile, so a caller can still force one write tool back on if it needs to.
   */
  readOnlyOnly?: boolean;
}

export interface PluginToolCatalogue {
  pluginId: string;
  groups: ToolGroupInfo[];
  tools: ToolCatalogueEntry[];
  profiles: ToolProfile[];
}

/** Group id for a tool that no `ToolGroupInfo` claims — still individually toggleable. */
export const UNGROUPED_ID = "other";

/**
 * First sentence of a description, clipped to `max` characters. Good enough to recognize a tool
 * in a table row without shipping the whole (often multi-paragraph) description to the dashboard.
 */
export function summarizeDescription(description: string | undefined, max = 140): string | undefined {
  if (!description) return undefined;
  const firstSentence = description.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? description;
  const trimmed = firstSentence.trim();
  return trimmed.length > max ? trimmed.slice(0, max - 1).trimEnd() + "…" : trimmed;
}
