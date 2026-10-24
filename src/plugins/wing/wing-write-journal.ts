import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import nodePath from "node:path";

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
 *
 * `unsavedChanges` counts distinct parameters, not events. Counting events used to report three
 * "changes" for one fader write — the write itself, then the console's push of it on the plain
 * address and again on its `$` shadow — and dozens for one DCA move or fade.
 */
export class WingWriteJournal {
  private readonly batches: WingJournalBatch[] = [];
  private readonly file: string | undefined;
  private readonly scope = new AsyncLocalStorage<WingJournalBatch>();
  private readonly changedSinceScene = new Set<string>();
  private lastSceneEvent: { kind: "load" | "save" | "connect"; at: number; detail?: string } = {
    kind: "connect",
    at: Date.now(),
  };

  /**
   * With a `file`, the batches survive a restart of the server: they are loaded here and the file
   * is rewritten whenever they change. A stdio server restarts with every client session, so a
   * memory-only journal would make `wing_undo` useless the next day. The unsaved-changes tracking
   * is not persisted — it is relative to the scene loaded in *this* connection.
   */
  constructor(opts: { file?: string } = {}) {
    this.file = opts.file;
    if (this.file) this.batches.push(...readBatches(this.file));
  }

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
        this.persist();
      }
    }
  }

  /** The batch open in the current async scope, if any. */
  currentBatch(): WingJournalBatch | undefined {
    return this.scope.getStore();
  }

  record(entries: WingJournalEntry[]): void {
    this.noteChanged(entries.filter((e) => !e.context).map((e) => e.path));
    const batch = this.scope.getStore();
    if (batch) batch.entries.push(...entries);
  }

  /**
   * Parameters that now differ from the loaded scene, whether or not the journal can undo them.
   * Pass canonical paths (no `$` shadow segment), so a write and its pushes count once.
   */
  noteChanged(paths: readonly string[]): void {
    for (const path of paths) this.changedSinceScene.add(path);
  }

  noteSceneEvent(kind: "load" | "save", detail?: string): void {
    this.changedSinceScene.clear();
    this.lastSceneEvent = { kind, at: Date.now(), detail };
  }

  /** `count` is the number of distinct parameters changed since `since`, from any client or the surface. */
  unsavedChanges(): { count: number; since: { kind: string; at: string; detail?: string } } {
    return {
      count: this.changedSinceScene.size,
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

  /** Marks a batch as restored by `wing_undo`, so it is never restored twice, even after a restart. */
  markUndone(batchId: string): void {
    const batch = this.find(batchId);
    if (!batch) return;
    batch.undoneAt = Date.now();
    this.persist();
  }

  clear(): void {
    this.batches.length = 0;
    this.persist();
  }

  /** Best effort: a journal that cannot be saved must never fail the write it describes. */
  private persist(): void {
    if (!this.file) return;
    try {
      fs.mkdirSync(nodePath.dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, batches: this.batches }), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.warn(`[wing-journal] could not save ${this.file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

function readBatches(file: string): WingJournalBatch[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`[wing-journal] ignoring unreadable ${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
    return [];
  }
  const list = (parsed as { batches?: unknown } | null)?.batches;
  if (!Array.isArray(list)) return [];
  return (list as unknown[]).filter(isBatch).slice(-MAX_BATCHES);
}

function isBatch(value: unknown): value is WingJournalBatch {
  if (typeof value !== "object" || value === null) return false;
  const b = value as Partial<Record<keyof WingJournalBatch, unknown>>;
  return typeof b.batchId === "string" && typeof b.origin === "string" && Array.isArray(b.entries);
}
