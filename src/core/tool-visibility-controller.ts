import type { RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ConfigStore } from "./config-store.js";
import type { McpPlugin } from "./plugin.js";
import type { PluginToolCatalogue } from "./tool-catalogue.js";
import {
  ALL_GROUPS_PROFILE_ID,
  normalizeToolVisibility,
  resolveEnabledTools,
  resolveToolVisibility,
  type ToolVisibility,
} from "./tool-visibility.js";

/** Called after every change; returns whether it changed anything on its side (one live session). */
export type ToolVisibilityListener = () => boolean;

/**
 * The one place that knows which tools are hidden, shared by every transport a process serves.
 *
 * It used to live inside the HTTP gateway, which meant a stdio session — the usual way a desktop
 * client runs this server — got every tool whatever `server.tools` said: a client handed the
 * read-only `safe` profile could still move faders. Owning it here, and handing the same instance
 * to the gateway and the stdio endpoint, makes the choice apply to both, and makes a live change
 * from the dashboard reach both.
 *
 * Holds the operator's raw choice (`resolveToolVisibility`), the plugins' static catalogues that
 * give it meaning, and the flat hidden-name set derived from the two — recomputed on a change,
 * never per session or per `tools/list`.
 */
export class ToolVisibilityController {
  private visibility: ToolVisibility;
  private catalogues: PluginToolCatalogue[] = [];
  private hidden = new Set<string>();
  private unknown: string[] = [];
  private loading: Promise<void> | undefined;
  private readonly listeners = new Set<ToolVisibilityListener>();

  constructor(
    private readonly plugins: readonly McpPlugin[],
    private readonly configStore: ConfigStore,
  ) {
    this.visibility = resolveToolVisibility(configStore);
  }

  /**
   * Builds each plugin's catalogue once — idempotent, so whichever transport starts first pays for
   * it. A catalogue describes the code, not a console: nothing here touches a device. Fails open per
   * plugin: one whose catalogue cannot be built keeps its tools visible (there is nothing to hide
   * them against) rather than taking the server down over a dashboard convenience.
   */
  load(): Promise<void> {
    this.loading ??= this.doLoad();
    return this.loading;
  }

  private async doLoad(): Promise<void> {
    const catalogues: PluginToolCatalogue[] = [];
    for (const plugin of this.plugins) {
      if (!plugin.getToolCatalogue) continue;
      try {
        catalogues.push(await plugin.getToolCatalogue());
      } catch (err) {
        console.error(`Plugin ${plugin.id} failed to report its tool catalogue (visibility left off for it):`, err);
      }
    }
    this.catalogues = catalogues;
    this.recompute();
    if (this.unknown.length > 0) {
      console.warn(
        "server.tools names ids that match no tool, group or profile: " +
          this.unknown.join(", ") +
          (this.visibility.profile && this.unknown.includes(this.visibility.profile)
            ? ` — the unknown profile "${this.visibility.profile}" falls back to read-only tools only`
            : ""),
      );
    }
  }

  private recompute(): void {
    const hidden = new Set<string>();
    const unknown = new Set<string>();
    for (const catalogue of this.catalogues) {
      const resolved = resolveEnabledTools(this.visibility, catalogue);
      for (const name of resolved.hiddenTools) hidden.add(name);
      for (const id of resolved.unknown) unknown.add(id);
    }
    this.hidden = hidden;
    this.unknown = [...unknown];
  }

  isHidden(name: string): boolean {
    return this.hidden.has(name);
  }

  get hiddenCount(): number {
    return this.hidden.size;
  }

  getVisibility(): ToolVisibility {
    return this.visibility;
  }

  getCatalogues(): readonly PluginToolCatalogue[] {
    return this.catalogues;
  }

  getUnknown(): string[] {
    return this.unknown;
  }

  /** `all` is built in; anything else must be declared by at least one plugin's catalogue. */
  isKnownProfile(id: string): boolean {
    return id === ALL_GROUPS_PROFILE_ID || this.catalogues.some((catalogue) => catalogue.profiles.some((profile) => profile.id === id));
  }

  /**
   * Appended to the plugins' own instructions whenever something is hidden. A plugin's instructions
   * are written assuming its whole surface is visible, and hiding part of it would otherwise leave
   * `initialize` contradicting `tools/list` with no way for a model to notice on its own.
   */
  instructionsAddendum(): string | undefined {
    if (this.hidden.size === 0) return undefined;
    return (
      "Some tool families are disabled on this server. `tools/list` is authoritative — treat any " +
      "family named above that does not appear in it as unavailable."
    );
  }

  /**
   * Applies the hidden set to one session's registered handles, writing `enabled` directly rather
   * than through `enable()`/`disable()`: those fire one `tools/list_changed` per tool, well over a
   * hundred for one config change. Returns whether anything changed, so the caller notifies once.
   */
  applyTo(toolHandles: ReadonlyMap<string, RegisteredTool>): boolean {
    let changed = false;
    for (const [name, tool] of toolHandles) {
      const shouldBeEnabled = !this.hidden.has(name);
      if (tool.enabled !== shouldBeEnabled) {
        tool.enabled = shouldBeEnabled;
        changed = true;
      }
    }
    return changed;
  }

  /**
   * Persists, then applies. Persisting first means a failed write never leaves live sessions ahead of
   * the file, which a restart would otherwise silently roll back. Returns how many subscribed
   * sessions actually changed.
   */
  async update(next: ToolVisibility): Promise<number> {
    const normalized = normalizeToolVisibility(next);
    await this.configStore.setServerTools(normalized);
    this.visibility = normalized;
    this.recompute();
    let affected = 0;
    for (const listener of [...this.listeners]) {
      try {
        if (listener()) affected += 1;
      } catch (err) {
        console.warn("A tool-visibility listener failed:", err);
      }
    }
    return affected;
  }

  /** Subscribes a live session to changes; returns the unsubscribe function. */
  onChange(listener: ToolVisibilityListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
