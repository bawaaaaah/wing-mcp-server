import { CHANNEL_COUNT } from "./wing-node-paths.js";

interface CacheEntry {
  value: number | string;
  raw?: number;
  updatedAt: number;
}

export interface ChannelSummary {
  index: number;
  name: string;
  muted: boolean;
  db: number;
}

const CHANNEL_FIELD_RE = /^\/ch\/(\d+)\/(fdr|mute|name)$/;

/**
 * In-memory last-known-value cache, fed by the OSC subscription's change
 * events. Backed by a flat `Map<path, entry>` — no attempt is made to model
 * the node tree's shape, since the only consumers are point lookups by exact
 * path and a best-effort channel-strip summary.
 */
export class WingStateCache {
  private readonly entries = new Map<string, CacheEntry>();
  /** Channel indices for which we've seen at least one fdr push — used as the "warm" heuristic. */
  private readonly seenChannelFader = new Set<number>();

  applyChange(change: { path: string; value: number | string; raw?: number }): void {
    this.entries.set(change.path, { value: change.value, raw: change.raw, updatedAt: Date.now() });

    const m = CHANNEL_FIELD_RE.exec(change.path);
    if (m && m[2] === "fdr") {
      this.seenChannelFader.add(Number(m[1]));
    }
  }

  get(path: string): CacheEntry | undefined {
    return this.entries.get(path);
  }

  /**
   * Best-effort channel strip summary for the overview snapshot. A channel
   * is only included once its name, mute, and fader are all known (rather
   * than guessing at a placeholder for a field we haven't received yet).
   */
  snapshotChannels(): ChannelSummary[] {
    const summaries: ChannelSummary[] = [];
    for (let n = 1; n <= CHANNEL_COUNT; n++) {
      const nameEntry = this.entries.get(`/ch/${n}/name`);
      const muteEntry = this.entries.get(`/ch/${n}/mute`);
      const fdrEntry = this.entries.get(`/ch/${n}/fdr`);
      if (!nameEntry || !muteEntry || !fdrEntry) {
        continue;
      }
      summaries.push({
        index: n,
        name: String(nameEntry.value),
        muted: Number(muteEntry.value) === 1,
        db: Number(fdrEntry.value),
      });
    }
    return summaries;
  }

  /** True once at least one fader value has been observed for every channel. */
  isWarm(): boolean {
    return this.seenChannelFader.size >= CHANNEL_COUNT;
  }
}
