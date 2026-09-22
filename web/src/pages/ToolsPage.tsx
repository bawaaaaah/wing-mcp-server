import { useMemo, useState } from "react";
import {
  useToolCatalogue,
  useUpdateToolVisibility,
  type ToolCatalogueResponse,
  type ToolVisibilityRequest,
} from "../api/queries.js";

/** What the page is editing, before it's turned into the request body a Save actually sends. */
interface Draft {
  profile: string;
  enable: Set<string>;
  disable: Set<string>;
}

const CATEGORY_LABELS: Record<string, string> = {
  core: "Core mixing",
  automation: "Automation",
  processing: "Processing",
  io: "I/O & patching",
  show: "Show management",
  other: "Other",
};

function draftFromResponse(data: ToolCatalogueResponse): Draft {
  return {
    profile: data.visibility.profile ?? "all",
    enable: new Set(data.visibility.enable ?? []),
    disable: new Set(data.visibility.disable ?? []),
  };
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}

/**
 * Mirrors the server's resolveEnabledTools exactly (core/tool-visibility.ts): profile →
 * enable(group) → disable(group) → enable(tool) → disable(tool), each step overriding the last.
 * Kept client-side so every checkbox click is instant instead of a round trip, and the Save
 * button sends only what actually changed.
 */
function resolveEnabledNames(data: ToolCatalogueResponse, draft: Draft): Set<string> {
  const groupIds = new Set(data.groups.map((group) => group.id));
  const toolNames = new Set(data.tools.map((tool) => tool.name));
  const profile = data.profiles.find((candidate) => candidate.id === draft.profile);
  const profileGroups = new Set(profile && !profile.readOnlyOnly ? profile.groups : data.groups.map((group) => group.id));
  const readOnlyBaselineOnly = profile?.readOnlyOnly === true;

  const enableGroups = new Set([...draft.enable].filter((id) => groupIds.has(id)));
  const disableGroups = new Set([...draft.disable].filter((id) => groupIds.has(id)));
  const enableTools = new Set([...draft.enable].filter((id) => toolNames.has(id)));
  const disableTools = new Set([...draft.disable].filter((id) => toolNames.has(id)));

  const enabled = new Set<string>();
  for (const tool of data.tools) {
    let on = readOnlyBaselineOnly ? tool.readOnly : profileGroups.has(tool.group);
    if (enableGroups.has(tool.group)) on = true;
    if (disableGroups.has(tool.group)) on = false;
    if (enableTools.has(tool.name)) on = true;
    if (disableTools.has(tool.name)) on = false;
    if (on) enabled.add(tool.name);
  }
  return enabled;
}

function formatKiB(bytes: number): string {
  return (bytes / 1024).toFixed(1) + " KiB";
}

function approxTokens(bytes: number): number {
  return Math.round(bytes / 4);
}

export function ToolsPage() {
  const query = useToolCatalogue();
  const mutation = useUpdateToolVisibility();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  const data = query.data;
  const effectiveDraft = draft ?? (data ? draftFromResponse(data) : null);

  const enabledNames = useMemo(
    () => (data && effectiveDraft ? resolveEnabledNames(data, effectiveDraft) : new Set<string>()),
    [data, effectiveDraft],
  );

  if (query.isLoading) {
    return (
      <div className="page">
        <h2>Tools</h2>
        <p>Loading tool catalogue...</p>
      </div>
    );
  }

  if (query.isError || !data || !effectiveDraft) {
    return (
      <div className="page">
        <h2>Tools</h2>
        <p className="error">{query.isError ? (query.error as Error).message : "No tool catalogue reported."}</p>
      </div>
    );
  }

  const savedProfile = data.visibility.profile ?? "all";
  const savedEnable = new Set(data.visibility.enable ?? []);
  const savedDisable = new Set(data.visibility.disable ?? []);
  const isDirty =
    effectiveDraft.profile !== savedProfile ||
    !setsEqual(effectiveDraft.enable, savedEnable) ||
    !setsEqual(effectiveDraft.disable, savedDisable);

  const enabledBytes = data.tools.filter((tool) => enabledNames.has(tool.name)).reduce((sum, t) => sum + t.bytes, 0);
  const genericGroupOn = data.tools.some((tool) => tool.group === "generic" && enabledNames.has(tool.name));

  function updateDraft(mutate: (current: Draft) => Draft): void {
    setDraft((prev) => mutate(prev ?? draftFromResponse(data as ToolCatalogueResponse)));
  }

  function selectProfile(profileId: string): void {
    const current = effectiveDraft as Draft;
    if (current.enable.size > 0 || current.disable.size > 0) {
      if (!window.confirm("Changing the profile clears your group/tool overrides. Continue?")) return;
    }
    setDraft({ profile: profileId, enable: new Set(), disable: new Set() });
  }

  function toggleGroup(groupId: string, nextOn: boolean): void {
    updateDraft((current) => {
      const enable = new Set(current.enable);
      const disable = new Set(current.disable);
      enable.delete(groupId);
      disable.delete(groupId);
      // Clear any per-tool overrides inside this group, so the group's new state is unambiguous
      // rather than immediately contradicted by a leftover single-tool override.
      for (const tool of (data as ToolCatalogueResponse).tools) {
        if (tool.group !== groupId) continue;
        enable.delete(tool.name);
        disable.delete(tool.name);
      }
      (nextOn ? enable : disable).add(groupId);
      return { ...current, enable, disable };
    });
  }

  function toggleTool(name: string, nextOn: boolean): void {
    updateDraft((current) => {
      const enable = new Set(current.enable);
      const disable = new Set(current.disable);
      enable.delete(name);
      disable.delete(name);
      (nextOn ? enable : disable).add(name);
      return { ...current, enable, disable };
    });
  }

  function toggleExpanded(groupId: string): void {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  }

  function save(): void {
    const current = effectiveDraft as Draft;
    const payload: ToolVisibilityRequest = {
      profile: current.profile,
      ...(current.enable.size > 0 ? { enable: [...current.enable] } : {}),
      ...(current.disable.size > 0 ? { disable: [...current.disable] } : {}),
    };
    mutation.mutate(payload, { onSuccess: () => setDraft(null) });
  }

  function reset(): void {
    setDraft(null);
  }

  const categories = [...new Set(data.groups.map((group) => group.category ?? "other"))];

  return (
    <div className="page">
      <h2>Tools</h2>
      <p>
        Every enabled tool is sent to any connected MCP client on every <code>tools/list</code> — descriptions,
        parameter schemas and all. Hiding what a session doesn't need keeps that catalogue smaller and cheaper
        for every client that connects.
      </p>

      <section className="card">
        <h3>Current catalogue</h3>
        <p className="tools-total">
          <strong>
            {enabledNames.size}/{data.totals.tools} tools
          </strong>{" "}
          enabled · {formatKiB(enabledBytes)} · ≈{approxTokens(enabledBytes)} tokens
          {enabledNames.size < data.totals.tools && (
            <span className="tools-total__all">
              {" "}
              (everything on would be {formatKiB(data.totals.bytes)}, ≈{data.totals.approxTokens} tokens)
            </span>
          )}
        </p>

        {enabledNames.size === 0 && (
          <p className="error">
            No tools would be enabled. Some MCP clients treat a server that advertises no tools as broken.
          </p>
        )}
        {!genericGroupOn && (
          <p className="tools-warning">
            The generic group is off — <code>wing_get</code>/<code>wing_set</code>/<code>wing_dump</code> are the
            escape hatch for the parts of the node tree no typed family covers.
          </p>
        )}
        {data.unknown.length > 0 && (
          <p className="tools-warning">Not recognized in the saved configuration, ignored: {data.unknown.join(", ")}</p>
        )}

        <div className="tools-profiles">
          {data.profiles.map((profile) => (
            <button
              key={profile.id}
              type="button"
              className={"tools-profiles__button" + (effectiveDraft.profile === profile.id ? " tools-profiles__button--active" : "")}
              title={profile.description}
              onClick={() => selectProfile(profile.id)}
            >
              {profile.label}
            </button>
          ))}
        </div>

        <div className="tools-actions">
          <button type="button" className="json-schema-form__save" disabled={!isDirty || mutation.isPending} onClick={save}>
            {mutation.isPending ? "Saving..." : "Save"}
          </button>
          <button type="button" disabled={!isDirty || mutation.isPending} onClick={reset}>
            Reset
          </button>
        </div>
        {mutation.isError && <p className="error">{(mutation.error as Error).message}</p>}
        {!isDirty && mutation.isSuccess && <p className="success">Saved.</p>}
        <p className="tools-note">
          Connected MCP clients are notified immediately. A client that ignores that notification picks up the
          change the next time it connects.
        </p>
      </section>

      {categories.map((category) => (
        <section className="card" key={category}>
          <h3>{CATEGORY_LABELS[category] ?? category}</h3>
          <ul className="tool-group-list">
            {data.groups
              .filter((group) => (group.category ?? "other") === category)
              .sort((a, b) => b.bytes - a.bytes)
              .map((group) => {
                const groupTools = data.tools.filter((tool) => tool.group === group.id);
                const enabledInGroup = groupTools.filter((tool) => enabledNames.has(tool.name));
                const allOn = enabledInGroup.length === groupTools.length;
                const allOff = enabledInGroup.length === 0;
                const isExpanded = expandedGroups.has(group.id);
                return (
                  <li className="tool-group-list__item" key={group.id}>
                    <div className="tool-group-list__row">
                      <label className="json-schema-form__field--checkbox">
                        <input
                          type="checkbox"
                          checked={allOn}
                          ref={(el) => {
                            if (el) el.indeterminate = !allOn && !allOff;
                          }}
                          onChange={(event) => toggleGroup(group.id, event.target.checked)}
                        />
                        <span>{group.label}</span>
                      </label>
                      <span className="tool-group-list__meta">
                        {enabledInGroup.length}/{groupTools.length} tools ·{" "}
                        {formatKiB(enabledInGroup.reduce((sum, tool) => sum + tool.bytes, 0))}
                      </span>
                      <button type="button" className="tool-group-list__expand" onClick={() => toggleExpanded(group.id)}>
                        {isExpanded ? "Hide tools" : "Show tools"}
                      </button>
                    </div>
                    <p className="tool-group-list__description">{group.description}</p>
                    {isExpanded && (
                      <ul className="tool-list">
                        {groupTools.map((tool) => (
                          <li className="tool-list__item" key={tool.name}>
                            <label className="json-schema-form__field--checkbox">
                              <input
                                type="checkbox"
                                checked={enabledNames.has(tool.name)}
                                onChange={(event) => toggleTool(tool.name, event.target.checked)}
                              />
                              <span>{tool.name}</span>
                            </label>
                            <span className="tool-list__meta">
                              {tool.readOnly ? "read-only" : "write"} · {(tool.bytes / 1024).toFixed(1)} KiB
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                );
              })}
          </ul>
        </section>
      ))}
    </div>
  );
}
