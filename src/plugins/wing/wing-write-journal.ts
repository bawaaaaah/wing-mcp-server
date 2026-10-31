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
 * `MAX_BATCHES` alone does not bound the file, and it is rewritten after every journaled tool call:
 * a preset loaded onto one channel journals ~250 keys (~18 KB), onto 40 channels ~700 KB.
 */
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const FILE_VERSION = 1;

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
  /** Cleared when the file turns out to be in a newer format, so this process never overwrites it. */
  private file: string | undefined;
  /**
   * The batches this process made. Only these are `wing_undo`'s default target: one loaded from the
   * file comes from an earlier session or another process, maybe days old or from another show.
   */
  private readonly ownBatchIds = new Set<string>();
  /**
   * The file as this process last wrote or read it, so an unchanged file is not parsed again. Every
   * save replaces the file by a rename, so its inode alone tells another process's save apart.
   */
  private seen: { ino: number; size: number; mtimeMs: number } | undefined;
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
   *
   * Several processes may share the file (two stdio client sessions, say): each save first folds in
   * what the others wrote, so none of them drops the others' batches.
   */
  constructor(opts: { file?: string } = {}) {
    this.file = opts.file;
    this.refresh();
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
        this.ownBatchIds.add(batch.batchId);
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

  /**
   * The most recent batch that has not been undone and is not itself an undo, among the batches this
   * process made unless `includeOtherSessions` — another session's can still be undone, by its id.
   */
  lastUndoable(opts: { includeOtherSessions?: boolean } = {}): WingJournalBatch | undefined {
    for (let i = this.batches.length - 1; i >= 0; i--) {
      const batch = this.batches[i] as WingJournalBatch;
      if (batch.undoneAt || batch.undoOf) continue;
      if (opts.includeOtherSessions || this.ownBatchIds.has(batch.batchId)) return batch;
    }
    return undefined;
  }

  /** Whether this process made the batch, rather than an earlier run or another process. */
  isFromThisSession(batchId: string): boolean {
    return this.ownBatchIds.has(batchId);
  }

  /**
   * Folds in what other processes sharing the file recorded since: their batches, and undos of
   * batches this process holds too. A stat when nothing changed. Never throws.
   */
  refresh(): void {
    try {
      this.merge(this.readIfChanged());
    } catch (err) {
      console.warn(`[wing-journal] could not read ${this.file}: ${err instanceof Error ? err.message : String(err)}`);
    }
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
    this.ownBatchIds.clear();
    this.persist({ merge: false });
  }

  /**
   * Best effort: a journal that cannot be saved must never fail the write it describes. Folds in
   * the file first (unless `merge: false`), so a save never drops what another process recorded;
   * two saves at the very same moment can still race, and the later one wins.
   */
  private persist(opts: { merge?: boolean } = {}): void {
    if (!this.file) return;
    try {
      if (opts.merge !== false) this.merge(this.readIfChanged());
      if (!this.file) return;
      const body = this.serialize();
      fs.mkdirSync(nodePath.dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, body, { mode: 0o600 });
      fs.renameSync(tmp, this.file);
      const stat = fs.statSync(this.file);
      this.seen = { ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs };
    } catch (err) {
      console.warn(`[wing-journal] could not save ${this.file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** New batches are added in start order, and an undo another process recorded is kept. */
  private merge(incoming: WingJournalBatch[]): void {
    if (incoming.length === 0) return;
    for (const batch of incoming) {
      const known = this.find(batch.batchId);
      if (!known) this.batches.push(batch);
      else if (batch.undoneAt && !known.undoneAt) known.undoneAt = batch.undoneAt;
    }
    this.batches.sort((a, b) => a.startedAt - b.startedAt);
    if (this.batches.length > MAX_BATCHES) this.batches.splice(0, this.batches.length - MAX_BATCHES);
  }

  /** The file's JSON, dropping the oldest batches (here too) until it fits `MAX_FILE_BYTES`. */
  private serialize(): string {
    const parts = this.batches.map((b) => JSON.stringify(b));
    let bytes = parts.reduce((n, p) => n + Buffer.byteLength(p) + 1, 0);
    let drop = 0;
    // The newest batch is always kept, however large.
    while (bytes > MAX_FILE_BYTES && drop < parts.length - 1) {
      bytes -= Buffer.byteLength(parts[drop] as string) + 1;
      drop++;
    }
    if (drop > 0) {
      this.batches.splice(0, drop);
      parts.splice(0, drop);
    }
    return `{"version":${FILE_VERSION},"batches":[${parts.join(",")}]}`;
  }

  private readIfChanged(): WingJournalBatch[] {
    if (!this.file) return [];
    let stat: fs.Stats;
    try {
      stat = fs.statSync(this.file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const seen = this.seen;
    if (seen?.ino === stat.ino && seen.size === stat.size && seen.mtimeMs === stat.mtimeMs) return [];
    const batches = this.load(this.file);
    this.seen = { ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs };
    return batches;
  }

  /**
   * A file that is not a journal is moved aside rather than overwritten by the next save. One in a
   * newer format is left alone, and this process keeps its journal in memory only.
   */
  private load(file: string): WingJournalBatch[] {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      setAside(file, err instanceof Error ? err.message : String(err));
      return [];
    }
    const { version, batches: list } = (typeof parsed === "object" && parsed !== null ? parsed : {}) as {
      version?: unknown;
      batches?: unknown;
    };
    if (typeof version === "number" && version > FILE_VERSION) {
      console.warn(
        `[wing-journal] ${file} is format version ${version}, newer than this server's ${FILE_VERSION}: ` +
          "leaving it alone and keeping this session's journal in memory only",
      );
      this.file = undefined;
      return [];
    }
    if (version !== FILE_VERSION || !Array.isArray(list)) {
      setAside(file, "not a journal file");
      return [];
    }
    const batches = list.filter(isBatch);
    if (batches.length < list.length) {
      console.warn(`[wing-journal] ignored ${list.length - batches.length} malformed batch(es) in ${file}`);
    }
    return batches;
  }
}

/** journal.json → journal.json.corrupt-<time>, so a damaged journal can still be looked at. */
function setAside(file: string, reason: string): void {
  const aside = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  try {
    fs.renameSync(file, aside);
    console.warn(`[wing-journal] ${file} is unreadable (${reason}); moved it to ${aside} and started an empty journal`);
  } catch (err) {
    console.warn(`[wing-journal] ${file} is unreadable (${reason}) and could not be moved aside: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function isScalar(value: unknown): value is number | string {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

function isEntry(value: unknown): value is WingJournalEntry {
  if (typeof value !== "object" || value === null) return false;
  const e = value as Partial<Record<keyof WingJournalEntry, unknown>>;
  return (
    typeof e.path === "string" &&
    e.path.startsWith("/") &&
    (e.previous === null || isScalar(e.previous)) &&
    isScalar(e.next) &&
    typeof e.audible === "boolean" &&
    (e.context === undefined || typeof e.context === "boolean")
  );
}

/** Every field `wing_history` and `wing_undo` read, so a damaged batch is dropped, not tripped over. */
function isBatch(value: unknown): value is WingJournalBatch {
  if (typeof value !== "object" || value === null) return false;
  const b = value as Partial<Record<keyof WingJournalBatch, unknown>>;
  return (
    typeof b.batchId === "string" &&
    typeof b.origin === "string" &&
    typeof b.startedAt === "number" &&
    Number.isFinite(b.startedAt) &&
    Array.isArray(b.entries) &&
    b.entries.every(isEntry) &&
    (b.undoneAt === undefined || (typeof b.undoneAt === "number" && Number.isFinite(b.undoneAt))) &&
    (b.undoOf === undefined || typeof b.undoOf === "string")
  );
}
