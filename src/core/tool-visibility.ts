import { z } from "zod";
import type { ConfigStore } from "./config-store.js";
import { getEnvString } from "./env.js";
import type { PluginToolCatalogue } from "./tool-catalogue.js";
import { UNGROUPED_ID } from "./tool-catalogue.js";

/**
 * What the operator chose to hide from `tools/list`, layered exactly like `server.security`
 * (security-config.ts): a persisted block wins outright over the environment, a block that
 * fails its own validation is reported on stderr and skipped rather than taking the whole
 * config file — and the auth token in it — down with it, and this module never writes
 * anything back. Absent means every tool is advertised, which is today's behaviour.
 *
 * `profile`, and every entry of `enable`/`disable`, is either a tool-group id or an exact tool
 * name — this module has no idea what either of those mean; that only exists once a plugin's
 * `PluginToolCatalogue` is available (see `resolveEnabledTools` below), which happens once at
 * boot, not on every request.
 */
export const ToolVisibilitySchema = z.object({
  /** A `ToolProfile.id` from the plugin's catalogue. Unknown or absent falls back to "all". */
  profile: z.string().min(1).optional(),
  /** Group ids or tool names to force on, overriding the profile. */
  enable: z.array(z.string().min(1)).optional(),
  /** Group ids or tool names to force off — wins over `enable` at the same level. */
  disable: z.array(z.string().min(1)).optional(),
});
export type ToolVisibility = z.infer<typeof ToolVisibilitySchema>;

function splitList(value: string): string[] | undefined {
  const items = value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return items.length > 0 ? items : undefined;
}

function fromEnv(): ToolVisibility | undefined {
  const profile = getEnvString("MCP_TOOL_PROFILE", "").trim();
  const enable = splitList(getEnvString("MCP_TOOLS_ENABLE", ""));
  const disable = splitList(getEnvString("MCP_TOOLS_DISABLE", ""));

  const config: ToolVisibility = {
    ...(profile ? { profile } : {}),
    ...(enable ? { enable } : {}),
    ...(disable ? { disable } : {}),
  };
  return Object.keys(config).length > 0 ? config : undefined;
}

/**
 * Resolves the raw, plugin-agnostic visibility choice. Same layering note as
 * `resolveSecurityConfig`: this describes where and how the operator wants the server to
 * behave, not a preference persisted once and then ignored — so unlike the auth token, the
 * environment is re-read on every boot, and a stored block always wins over it rather than the
 * other way around.
 */
export function resolveToolVisibility(configStore: ConfigStore): ToolVisibility {
  const persisted = configStore.getServerTools();
  if (persisted !== undefined) {
    const parsed = ToolVisibilitySchema.safeParse(persisted);
    if (parsed.success) return parsed.data;
    console.error("Ignoring the persisted server.tools block, which failed validation:", parsed.error.message);
  }
  return fromEnv() ?? {};
}

/** Trims, dedupes and sorts before persisting, so the file stays a stable, minimal diff to read. */
export function normalizeToolVisibility(visibility: ToolVisibility): ToolVisibility {
  const dedupe = (values: string[] | undefined): string[] | undefined => {
    if (!values) return undefined;
    const cleaned = [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))].sort();
    return cleaned.length > 0 ? cleaned : undefined;
  };

  const profile = visibility.profile?.trim();
  const enable = dedupe(visibility.enable);
  const disable = dedupe(visibility.disable);

  return {
    ...(profile ? { profile } : {}),
    ...(enable ? { enable } : {}),
    ...(disable ? { disable } : {}),
  };
}

export interface ResolvedToolVisibility {
  /** Exact tool names advertised to clients. */
  enabledNames: Set<string>;
  /** Group ids forced off by `disable`, for the startup banner and the REST response. */
  hiddenGroups: string[];
  /** Tool names not in `enabledNames`, listed individually (includes ones hidden via their group). */
  hiddenTools: string[];
  /** Ids named in `profile`/`enable`/`disable` that match no known group or tool — reported, never rejected. */
  unknown: string[];
}

const ALL_GROUPS_PROFILE_ID = "all";

/**
 * Resolves a plugin-agnostic `ToolVisibility` choice against one plugin's actual tool surface.
 * Only meaningful once a catalogue exists, so this runs once at boot (and again on a `PUT
 * /api/tools`) — never per MCP session, and never per `tools/list` request.
 *
 * Resolution order, each step overriding the last: profile → enable(group) → disable(group) →
 * enable(tool) → disable(tool). An unresolvable profile id falls back to "every group enabled"
 * (fail open, same as a malformed persisted block) rather than hiding everything by surprise. A
 * profile with `readOnlyOnly` set computes its baseline from each tool's own `readOnly` flag
 * instead of group membership — group/tool overrides still apply on top of that baseline exactly
 * as they would for a group-based profile.
 */
export function resolveEnabledTools(
  visibility: ToolVisibility,
  catalogue: Pick<PluginToolCatalogue, "groups" | "tools" | "profiles">,
): ResolvedToolVisibility {
  const groupIds = new Set(catalogue.groups.map((group) => group.id));
  const toolNames = new Set(catalogue.tools.map((tool) => tool.name));

  const requestedProfileId = visibility.profile ?? ALL_GROUPS_PROFILE_ID;
  const profile = catalogue.profiles.find((candidate) => candidate.id === requestedProfileId);
  const profileGroups = new Set(profile && !profile.readOnlyOnly ? profile.groups : catalogue.groups.map((group) => group.id));
  const readOnlyBaselineOnly = profile?.readOnlyOnly === true;

  const enable = visibility.enable ?? [];
  const disable = visibility.disable ?? [];
  const enableGroups = new Set(enable.filter((id) => groupIds.has(id)));
  const disableGroups = new Set(disable.filter((id) => groupIds.has(id)));
  const enableTools = new Set(enable.filter((name) => toolNames.has(name)));
  const disableTools = new Set(disable.filter((name) => toolNames.has(name)));

  const unknown = new Set<string>();
  if (visibility.profile && !profile) unknown.add(visibility.profile);
  for (const id of [...enable, ...disable]) {
    if (!groupIds.has(id) && !toolNames.has(id)) unknown.add(id);
  }

  const enabledNames = new Set<string>();
  const hiddenTools: string[] = [];
  for (const tool of catalogue.tools) {
    const group = tool.group === UNGROUPED_ID ? undefined : tool.group;
    let enabled = readOnlyBaselineOnly ? tool.readOnly : group === undefined ? true : profileGroups.has(group);
    if (group !== undefined && enableGroups.has(group)) enabled = true;
    if (group !== undefined && disableGroups.has(group)) enabled = false;
    if (enableTools.has(tool.name)) enabled = true;
    if (disableTools.has(tool.name)) enabled = false;

    if (enabled) enabledNames.add(tool.name);
    else hiddenTools.push(tool.name);
  }

  return {
    enabledNames,
    hiddenGroups: [...disableGroups],
    hiddenTools,
    unknown: [...unknown],
  };
}

/** One line for the startup banner. */
export function describeToolVisibility(total: number, enabled: number): string {
  return enabled >= total ? `all ${total} enabled` : `${enabled}/${total} enabled`;
}
