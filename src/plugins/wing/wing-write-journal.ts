import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

/** One key a batch wrote: what it held before, and what was asked of it. */
export interface WingJournalEntry {
  path: string;
  /** `null` when the previous value could not be read (the write still happened). */
  previous: number | string | null;
  next: number | string;
  audible: boolean;
  /**
   * Not written by the batch, but lost by it: the parameters of a plugin whose model (`mdl`) the
   * batch changed. Recorded so an undo can put the old model back *with* its settings.
   */
  context?: boolean;
}

export interface WingJournalBatch {
  batchId: string;
  /** The MCP tool (or other origin) that made the writes. */
  origin: string;
  startedAt: number;
  entries: WingJournalEntry[];
  /** Set once `wing_undo` has restored this batch, so it is never restored twice. */
  undoneAt?: number;
  /** The batch an undo wrote, when this batch *is* an undo. */
  undoOf?: string;
}

/**
 * Leaves that change how a strip looks, not how it sounds. Everything else is treated as audible —
 * the safe direction to be wrong in, since `audible` gates confirmation in show mode.
 *
 * `clink` belongs here because it only decides whose name/color/icon a strip displays; `mode` does
 * not, even on a source (it switches a pair between mono and stereo).
 */
const COSMETIC_LEAVES = new Set(["name", "col", "icon", "led", "tags", "clink"]);

export function isAudiblePath(path: string): boolean {
  const leaf = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf(".")) + 1);
  return !COSMETIC_LEAVES.has(leaf);
}

const MAX_BATCHES = 200;

/**
 * Journal of console writes, grouped into one batch per tool call, so any of them can be undone and
 * so the server can tell whether the console's current state has moved since the last scene
 * load/save (the console exposes no such flag over OSC — checked against the protocol reference).
 *
 * Recording is ambient rather than threaded through every call site: `runBatch` opens a batch in
 * an AsyncLocalStorage scope, and `WingOscClient.bulkSet` records into whichever batch is current.
 * Writes made outside any batch (the dashboard's REST routes, fades, the auto-* engines, which have
 * their own undo) are not journaled — but they still count towards `unsavedChanges`.
 */
export class WingWriteJournal {
  private readonly batches: WingJournalBatch[] = [];
  private readonly scope = new AsyncLocalStorage<WingJournalBatch>();
  private changesSinceScene = 0;
  private lastSceneEvent: { kind: "load" | "save" | "connect"; at: number; detail?: string } = {
    kind: "connect",
    at: Date.now(),
  };

  /** Runs `fn` with a fresh batch open; the batch is kept only if something was written. */
  async runBatch<T>(origin: string, fn: () => Promise<T>, opts: { undoOf?: string } = {}): Promise<T> {
    const batch: WingJournalBatch = { batchId: randomUUID().slice(0, 8), origin, startedAt: Date.now(), entries: [] };
    if (opts.undoOf) batch.undoOf = opts.undoOf;
    try {
      return await this.scope.run(batch, fn);
    } finally {
      if (batch.entries.length > 0) {
        this.batches.push(batch);
        if (this.batches.length > MAX_BATCHES) this.batches.shift();
      }
    }
  }

  /** The batch open in the current async scope, if any. */
  currentBatch(): WingJournalBatch | undefined {
    return this.scope.getStore();
  }

  record(entries: WingJournalEntry[]): void {
    this.noteChange(entries.filter((e) => !e.context).length);
    const batch = this.scope.getStore();
    if (batch) batch.entries.push(...entries);
  }

  /** A change the journal cannot undo but that still makes the console differ from its scene. */
  noteChange(count = 1): void {
    this.changesSinceScene += count;
  }

  noteSceneEvent(kind: "load" | "save", detail?: string): void {
    this.changesSinceScene = 0;
    this.lastSceneEvent = { kind, at: Date.now(), detail };
  }

  unsavedChanges(): { count: number; since: { kind: string; at: string; detail?: string } } {
    return {
      count: this.changesSinceScene,
      since: { ...this.lastSceneEvent, at: new Date(this.lastSceneEvent.at).toISOString() },
    };
  }

  history(limit = 20): WingJournalBatch[] {
    return this.batches.slice(-limit).reverse();
  }

  find(batchId: string): WingJournalBatch | undefined {
    return this.batches.find((b) => b.batchId === batchId);
  }

  /** The most recent batch that has not been undone and is not itself an undo. */
  lastUndoable(): WingJournalBatch | undefined {
    for (let i = this.batches.length - 1; i >= 0; i--) {
      const batch = this.batches[i] as WingJournalBatch;
      if (!batch.undoneAt && !batch.undoOf) return batch;
    }
    return undefined;
  }

  clear(): void {
    this.batches.length = 0;
  }
}
