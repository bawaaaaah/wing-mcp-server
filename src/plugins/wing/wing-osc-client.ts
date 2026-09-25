import { EventEmitter } from "node:events";
import osc from "osc";
import type { OscArgument, OscMessage, OscRemoteInfo, UDPPort } from "osc";
import { discoverWingConsoles, type WingDiscoveryResult } from "./wing-discovery.js";
import { createDropReporter, isFromConsole, resolveConsoleSources, type ConsoleSources } from "./wing-source-filter.js";
import { isAudiblePath, type WingJournalEntry, type WingWriteJournal } from "./wing-write-journal.js";
import { WingQueueOverflowError, WingTimeoutError, WingUnavailableError } from "./wing-errors.js";
import {
  assertBulkSetKey,
  assertStringFits,
  buildBulkSetString,
  parseBulkSetAck,
  parseFlatAssignmentString,
  parseOscGetReply,
  stringLeafMaxBytes,
} from "./wing-value-codec.js";

export interface WingOscClientOptions {
  host: string;
  port?: number;
  discoveryPort?: number;
  requestTimeoutMs?: number;
  subscriptionMode?: "/*S" | "/*s";
  subscriptionRenewalIntervalMs?: number;
  maxQueueLength?: number;
  /**
   * How long a request may sit in the queue before it is even sent. `requestTimeoutMs` only starts
   * counting once an entry reaches the head, so without this a queued request has no deadline of
   * its own at all: behind a full queue against an unresponsive console it could wait
   * `maxQueueLength * requestTimeoutMs` — a minute and a half at the defaults — before its own
   * clock so much as started. Defaults to 10x `requestTimeoutMs`.
   */
  maxQueueWaitMs?: number;
  /**
   * The console's own inactivity timeout, used only to recognize a renewal that came too late.
   * Defaults to the documented 10s (docs/wing-protocol/02-osc-protocol.md); tests shorten it.
   */
  subscriptionInactivityTimeoutMs?: number;
}

export interface WingGetResult {
  path: string;
  kind: "leaf";
  valueKind: "float" | "int" | "string";
  display?: string;
  raw?: number;
  value: number | string;
}

export interface WingBranchResult {
  path: string;
  kind: "branch";
  children: string[];
}

export interface WingBulkSetResult {
  status: string;
  ok: boolean;
  raw: string;
  /**
   * Present only when `status` is "MISMATCH": text keys the console acked but stored differently.
   * See `bulkSet`.
   */
  mismatches?: Array<{ key: string; requested: string; stored: string | null }>;
}

export interface WingBulkSetOptions {
  /** Read written name/tags keys back and report MISMATCH if they differ. Default true. */
  verifyText?: boolean;
  /** Previous values the caller already read, so journaling does not read them again. */
  knownPrevious?: Record<string, number | string | null>;
}

export interface WingNodeDescription {
  path: string;
  raw: string;
  lines: string[];
}

export interface WingParamChange {
  path: string;
  shadow: boolean;
  raw?: number;
  value: number | string;
  valueKind: "float" | "int" | "string";
  receivedAt: number;
}

/**
 * Emitted when two consecutive renewals were further apart than the console's inactivity timeout,
 * meaning the subscription was dead for part of the gap and any change made during it was never
 * pushed. See `subscribe()`.
 */
export interface WingSubscriptionGap {
  gapMs: number;
  inactivityTimeoutMs: number;
}

export interface WingSubscriptionHandle {
  close(): void;
  on(event: "change", cb: (c: WingParamChange) => void): void;
  on(event: "renewal-gap", cb: (gap: WingSubscriptionGap) => void): void;
  off(event: "change", cb: (c: WingParamChange) => void): void;
  off(event: "renewal-gap", cb: (gap: WingSubscriptionGap) => void): void;
}

interface QueueEntry {
  send: () => void;
  matches: (msg: { address: string; args: OscArgument[] }) => boolean;
  resolve: (msg: { address: string; args: OscArgument[] }) => void;
  reject: (err: Error) => void;
  timer?: NodeJS.Timeout;
  /** Bounds the wait *before* `send()`; cleared the moment the entry reaches the head. */
  queueTimer?: NodeJS.Timeout;
  /** See `enqueue`. */
  trackLateReply?: boolean;
}

/**
 * A request that timed out and was rejected, but whose reply may still be in flight. Kept just
 * long enough to recognize and swallow that late reply — see `consumeAbandonedReply`.
 */
interface AbandonedReply {
  matches: QueueEntry["matches"];
  expiresAt: number;
}

/**
 * A live subscription registration. Extends EventEmitter so it can satisfy
 * `WingSubscriptionHandle`'s on/off surface directly; `emit` stays available
 * (if untyped by the public interface) for the client to push parsed
 * changes into it.
 */
class SubscriptionHandleImpl extends EventEmitter implements WingSubscriptionHandle {
  private disposed = false;

  constructor(private readonly disposer: () => void) {
    super();
  }

  close(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.disposer();
  }
}

/** "/ch/1" + "eq.on" -> "/ch/1/eq/on"; "/" + "ch.1.fdr" -> "/ch/1/fdr". */
export function joinNodePath(baseNode: string, key: string): string {
  const suffix = key.replace(/\./g, "/");
  return baseNode === "/" ? `/${suffix}` : `${baseNode}/${suffix}`;
}

function normalizeArgs(raw: OscMessage["args"]): OscArgument[] {
  if (Array.isArray(raw)) {
    return raw as OscArgument[];
  }
  if (raw === undefined || raw === null) {
    return [];
  }
  return [raw as OscArgument];
}

/**
 * A handful of catalogued nodes have "$" as part of their only, permanent name — not a shadow
 * mirroring a plain sibling like "/ch/1/$fdr" does. Confirmed against wing-param-catalog.ts: none of
 * these has a plain-named counterpart anywhere in the catalog. Treating them as ordinary shadows
 * would strip their "$" into a nonexistent path and corrupt the cache key for their subscription
 * pushes (e.g. a scene-recall push on "/$ctl/lib/$actidx" would get canonicalized to the nonexistent
 * "/$ctl/lib/actidx", which nothing that reads the real path via get()/dump() ever queries).
 */
const PERMANENT_SHADOW_ONLY_ADDRESSES = new Set([
  "/$ctl/lib/$scenes",
  "/$ctl/lib/$actidx",
  "/$ctl/lib/$active",
  "/$ctl/lib/$actshow",
  "/$ctl/lib/$action",
  "/$ctl/lib/$actionidx",
  "/$ctl/lib/$activeid",
]);
const PERMANENT_SHADOW_ONLY_PATTERN = /^\/dca\/\d+\/\$solo$/;

function isPermanentShadowOnly(address: string): boolean {
  return PERMANENT_SHADOW_ONLY_ADDRESSES.has(address) || PERMANENT_SHADOW_ONLY_PATTERN.test(address);
}

/**
 * WING exposes real read-only "shadow" nodes prefixed with "$" on their leaf
 * segment (e.g. "/ch/1/$fdr" reflects the DCA/mutegroup-adjusted fader).
 * Subscription pushes for these mirror the same shape as their normal
 * counterpart, so we detect them structurally rather than tracking a
 * separate address list — except for the permanent-$-only nodes above, which
 * must never be treated as a shadow of a (nonexistent) plain sibling.
 */
function isShadowAddress(address: string): boolean {
  if (isPermanentShadowOnly(address)) return false;
  const segments = address.split("/").filter(Boolean);
  const last = segments[segments.length - 1];
  return last !== undefined && last.startsWith("$");
}

/**
 * Strips the shadow "$" marker from an address's last segment, e.g.
 * "/ch/1/$fdr" -> "/ch/1/fdr". Verified against real hardware: a `/*S`
 * subscription only ever pushes changes on the shadow address, never on the
 * plain one — even for a plain (non-DCA/mutegroup-affected) write — so
 * callers that key state by the plain path (the state cache, the dashboard's
 * live-merge regexes) need this canonical form rather than the raw address.
 * Leaves a permanent-$-only address (see above) unchanged instead.
 */
function canonicalizeShadowAddress(address: string): string {
  if (isPermanentShadowOnly(address)) return address;
  const idx = address.lastIndexOf("/$");
  return idx < 0 ? address : `${address.slice(0, idx + 1)}${address.slice(idx + 2)}`;
}


/**
 * OSC control-plane client for a WING console (UDP, default port 2223).
 *
 * Implements a single FIFO in-flight-request queue: the WING OSC protocol
 * carries no request id, so a reply can only be correlated to a request by
 * its address. Only one request is ever "awaiting a reply" at a time; every
 * other call queues behind it. This also means an invalid address (which
 * gets no reply at all from the console) is indistinguishable from a slow
 * one until `requestTimeoutMs` elapses — same as the console's own
 * documented behavior, not a limitation introduced here.
 *
 * Known race (documented, not fixed): because unsolicited subscription
 * pushes share the same address space as GET replies, a value received
 * immediately after issuing a `get()` on the same path could theoretically
 * be a push rather than "the" reply. In practice this is harmless — the
 * value is correct either way — so v1 accepts the ambiguity rather than
 * adding request tagging the console protocol doesn't support.
 *
 * A second, sharper race *is* handled here, for `bulkSet` only: a request that times out is
 * rejected and its successor promoted immediately, but the console's reply may simply have been
 * slow rather than lost. Since correlation is by address alone, that late ack would otherwise
 * satisfy the new head's matcher — and `bulkSet`'s matcher is the catch-all `"/*"`, so *any* late
 * ack matches *any* pending bulk-set, letting a write report another write's status as its own.
 * A timed-out bulk-set therefore leaves its matcher in `abandoned` for a grace period, and an ack
 * claimed there is swallowed rather than offered to the queue. The cost is that a genuinely lost
 * ack makes the *next* write time out too; that is the safe direction to fail, unlike a wrong
 * `ok: true`. Reads opt out of this — see `enqueue`.
 *
 * Extends EventEmitter solely to expose a "raw" event — every message received from the console,
 * verbatim, before any queue-matching/subscription-dispatch logic below runs — for wing-osc-mirror.ts
 * to tap. Purely additive: nothing else here is event-driven.
 */
export class WingOscClient extends EventEmitter {
  private readonly host: string;
  private readonly remotePort: number;
  private readonly discoveryPort: number;
  private readonly requestTimeoutMs: number;
  private readonly defaultSubscriptionMode: "/*S" | "/*s";
  private readonly subscriptionRenewalIntervalMs: number;
  private readonly subscriptionInactivityTimeoutMs: number;
  private readonly maxQueueLength: number;
  private readonly maxQueueWaitMs: number;

  private udpPort: UDPPort | null = null;
  /** Who may answer: see wing-source-filter.ts. Resolved in connect(). */
  private consoleSources: ConsoleSources = null;
  private readonly reportDrop: (address: string | undefined) => void;
  private journal: WingWriteJournal | null = null;
  private readonly queue: QueueEntry[] = [];
  /** Matchers of timed-out requests whose reply may still arrive. See the class doc. */
  private readonly abandoned: AbandonedReply[] = [];
  private readonly activeHandles = new Set<SubscriptionHandleImpl>();
  private lastSuccessAt: number | null = null;
  /**
   * Distinct from `lastSuccessAt`: also updated by unsolicited subscription pushes, not just
   * request/response round trips. Verified against real hardware that a live Mixer session can go
   * many seconds without issuing a single GET/dump/bulkSet (it loads once, then relies entirely on
   * `/*S` pushes) — using `lastSuccessAt` alone for a health/staleness check would report a
   * perfectly healthy connection as an error just because nobody happened to ask it anything.
   */
  private lastActivityAt: number | null = null;

  constructor(opts: WingOscClientOptions) {
    super();
    this.host = opts.host;
    this.remotePort = opts.port ?? 2223;
    this.discoveryPort = opts.discoveryPort ?? 2222;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 1000;
    this.defaultSubscriptionMode = opts.subscriptionMode ?? "/*S";
    this.subscriptionRenewalIntervalMs = opts.subscriptionRenewalIntervalMs ?? 4000;
    this.subscriptionInactivityTimeoutMs = opts.subscriptionInactivityTimeoutMs ?? 10_000;
    this.maxQueueLength = opts.maxQueueLength ?? 100;
    this.maxQueueWaitMs = opts.maxQueueWaitMs ?? this.requestTimeoutMs * 10;
    this.reportDrop = createDropReporter("wing-osc-client", this.host);
  }

  async connect(): Promise<void> {
    this.consoleSources = await resolveConsoleSources(this.host);
    await new Promise<void>((resolve, reject) => {
      const port = new osc.UDPPort({
        localAddress: "0.0.0.0",
        localPort: 0,
        remoteAddress: this.host,
        remotePort: this.remotePort,
        metadata: true,
      });

      let settled = false;
      const onReady = () => {
        if (settled) {
          return;
        }
        settled = true;
        this.udpPort = port;
        port.on("message", this.handleMessage);
        port.on("error", (err: Error) => {
          console.error("[wing-osc-client] socket error:", err);
        });
        resolve();
      };
      const onError = (err: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        reject(new WingUnavailableError(`Failed to open WING OSC UDP port: ${err.message}`));
      };

      port.once("ready", onReady);
      port.once("error", onError);
      port.open();
    });
  }

  async close(): Promise<void> {
    for (const handle of Array.from(this.activeHandles)) {
      handle.close();
    }
    for (const entry of this.queue.splice(0)) {
      if (entry.timer) {
        clearTimeout(entry.timer);
      }
      if (entry.queueTimer) {
        clearTimeout(entry.queueTimer);
      }
      entry.reject(new WingUnavailableError("WING OSC client closed"));
    }
    this.abandoned.length = 0;
    if (this.udpPort) {
      this.udpPort.close();
      this.udpPort = null;
    }
  }

  static async discover(opts?: { timeoutMs?: number; broadcastAddress?: string }): Promise<WingDiscoveryResult[]> {
    return discoverWingConsoles(opts);
  }

  async get(path: string): Promise<WingGetResult | WingBranchResult> {
    const { args } = await this.enqueue({
      send: () => this.sendRaw(path, []),
      matches: (msg) => msg.address === path,
    });
    return this.parseGetReply(path, args);
  }

  async dump(path: string): Promise<Record<string, string | number>> {
    const { args } = await this.enqueue({
      send: () => this.sendRaw(path, [{ type: "s", value: "*" }]),
      matches: (msg) => msg.address === path,
    });
    const raw = args.length > 0 ? String(args[0].value) : "";
    return parseFlatAssignmentString(raw);
  }

  /**
   * Best-effort parse of the "?"/"#" description text. Verified against real hardware: parameter
   * nodes (e.g. "/ch/1/eq", "/fx/1") separate records with newlines, not "~" as the protocol
   * reference could be read to suggest — split on either so a firmware/node type that does use
   * "~" is still handled.
   */
  async describe(path: string, includeValues = false): Promise<WingNodeDescription> {
    const { args } = await this.enqueue({
      send: () => this.sendRaw(path, [{ type: "s", value: includeValues ? "#" : "?" }]),
      matches: (msg) => msg.address === path,
    });
    const raw = args.length > 0 ? String(args[0].value) : "";
    const lines = raw
      .split(/[~\n]+/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    return { path, raw, lines };
  }

  /**
   * An "OK" ack only says the console parsed the assignment, not that it stored what was asked:
   * verified against real hardware that an unquoted "TB Samuel" was acked OK and stored "TBSamuel",
   * and an over-long name is acked OK and truncated. So free-text keys (`name`, `tags`) are read
   * back after an OK ack, and a difference turns the result into `status: "MISMATCH"`, `ok: false`.
   * Numeric and enum keys are not re-read here — they cost a round trip each on hot paths (fades,
   * auto-compress) and have no comparable failure mode; `wing_set`/`wing_bulk_set` verify every key.
   */
  async bulkSet(
    baseNode: string,
    assignments: Record<string, number | string>,
    opts: WingBulkSetOptions = {},
  ): Promise<WingBulkSetResult> {
    for (const key of Object.keys(assignments)) assertBulkSetKey(key);
    const textKeys = Object.entries(assignments).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string" && stringLeafMaxBytes(entry[0]) !== undefined,
    );
    for (const [key, value] of textKeys) {
      assertStringFits(joinNodePath(baseNode, key), value);
    }
    const journalEntries = this.journal?.currentBatch()
      ? await this.readPreviousValues(baseNode, assignments, opts.knownPrevious)
      : null;
    const ack = await this.sendBulkSet(baseNode, assignments);
    if (ack.ok) {
      if (journalEntries) this.journal?.record(journalEntries);
      else this.journal?.noteChanged(Object.keys(assignments).map((key) => joinNodePath(baseNode, key)));
    }
    if (!ack.ok || opts.verifyText === false || textKeys.length === 0) {
      return ack;
    }
    const mismatches: NonNullable<WingBulkSetResult["mismatches"]> = [];
    for (const [key, requested] of textKeys) {
      const result = await this.get(joinNodePath(baseNode, key));
      const stored = result.kind === "leaf" ? String(result.value) : null;
      if (stored !== requested) {
        mismatches.push({ key, requested, stored });
      }
    }
    return mismatches.length === 0 ? ack : { status: "MISMATCH", ok: false, raw: ack.raw, mismatches };
  }

  /** Attaches the journal `bulkSet` records into (see wing-write-journal.ts). */
  setJournal(journal: WingWriteJournal | null): void {
    this.journal = journal;
  }

  private async readPreviousValues(
    baseNode: string,
    assignments: Record<string, number | string>,
    known: Record<string, number | string | null> = {},
  ): Promise<WingJournalEntry[]> {
    const entries: WingJournalEntry[] = [];
    for (const [key, next] of Object.entries(assignments)) {
      const path = joinNodePath(baseNode, key);
      if (key in known) {
        entries.push({ path, previous: known[key] ?? null, next, audible: isAudiblePath(path) });
        continue;
      }
      let previous: number | string | null = null;
      try {
        const result = await this.get(path);
        previous = result.kind === "leaf" ? result.value : null;
      } catch {
        // Unreadable (write-only command node, timeout): still journal the write, just not undoably.
      }
      entries.push({ path, previous, next, audible: isAudiblePath(path) });
    }
    // Switching a plugin model replaces every parameter under it. Journal the old model's settings
    // too (one dump of the section), so undoing the switch restores them rather than the new
    // model's defaults. Appended after the written keys, so an undo writes `mdl` before them.
    for (const entry of [...entries]) {
      if (!entry.path.endsWith("/mdl") || entry.previous === null || String(entry.previous) === String(entry.next)) continue;
      const section = entry.path.slice(0, -"/mdl".length);
      const dumped = await this.dump(section).catch(() => null);
      for (const [key, value] of Object.entries(dumped ?? {})) {
        const path = joinNodePath(section, key);
        if (key === "mdl" || entries.some((e) => e.path === path)) continue;
        entries.push({ path, previous: value, next: value, audible: isAudiblePath(path), context: true });
      }
    }
    return entries;
  }

  private async sendBulkSet(baseNode: string, assignments: Record<string, number | string>): Promise<WingBulkSetResult> {
    // Verified against real hardware (firmware as of 2026-08-21): the console always acks a
    // bulk-set on "/*", regardless of the target node's depth — the protocol reference's "<node>*"
    // wording for non-root nodes does not match observed behavior.
    const { args } = await this.enqueue({
      send: () => this.sendRaw(baseNode, [{ type: "s", value: buildBulkSetString(assignments) }]),
      matches: (msg) => msg.address === "/*",
      // The "/*" matcher above accepts *any* bulk-set ack, so a late one from a timed-out write
      // would otherwise be reported as this write's result. See `enqueue`.
      trackLateReply: true,
    });
    const raw = args.length > 0 ? String(args[0].value) : "";
    const { status, ok } = parseBulkSetAck(raw);
    return { status, ok, raw };
  }

  /**
   * Fire-and-forget primitive SET (no ack, no queueing). Prefer `bulkSet()`
   * for anything that matters — it's the only way to know whether the
   * console actually accepted the value. This exists mainly to back
   * `toggle()`, and as an escape hatch documented in the plan for hardware
   * verification of the `mute=-1` bulk-set toggle behavior.
   *
   * Since this client has no catalog knowledge of the target node's real
   * OSC type, numeric values are sent as an int ("i") tag when they are
   * integers and a float ("f") tag otherwise — this is a heuristic, not a
   * guarantee of correctness for every node. A caller that knows the node's
   * type passes it: a fader ramp from -20 to 0 dB lands on whole numbers at
   * every other step, and a float parameter must not get an int then.
   */
  async set(path: string, value: number | string, opts: { type?: "f" | "i" } = {}): Promise<void> {
    const arg: OscArgument =
      typeof value === "string"
        ? { type: "s", value }
        : { type: opts.type ?? (Number.isInteger(value) ? "i" : "f"), value };
    this.sendRaw(path, [arg]);
  }

  async toggle(path: string): Promise<void> {
    await this.set(path, -1);
  }

  /**
   * Opens a `/*S` (or `/*s`) subscription and keeps it alive by re-sending that same command on a
   * timer — the command *is* the renewal, which is why a missed one repairs itself on the next tick.
   *
   * What does not repair itself is the state. Node coalesces the ticks an interval misses, so a
   * stall longer than the console's 10s inactivity timeout — plausible during the heavy synchronous
   * DSP work in wing-auto-eq.ts / wing-auto-compress.ts — leaves the console-side subscription dead
   * for part of the gap. Every change made in that window is never pushed and is simply lost, while
   * the heartbeat keeps `lastActivityAt` fresh so health still reads green. Name fields are the
   * worst of it: they are only re-pushed on an actual rename, so nothing ever naturally overwrites
   * a value that went stale in the dark (the same poisoning mode wing-plugin.ts documents for a
   * different cause). Rather than guess, the handle reports the gap and lets the owner of the cache
   * decide — see `renewal-gap`.
   */
  subscribe(mode: "/*S" | "/*s" = this.defaultSubscriptionMode): WingSubscriptionHandle {
    let lastRenewAt = Date.now();
    const renew = () => {
      const now = Date.now();
      const gapMs = now - lastRenewAt;
      lastRenewAt = now;
      // Measured against the wall clock, not counted in missed ticks: a coalesced interval gives
      // no indication that it skipped any.
      if (gapMs > this.subscriptionInactivityTimeoutMs) {
        handle.emit("renewal-gap", {
          gapMs,
          inactivityTimeoutMs: this.subscriptionInactivityTimeoutMs,
        } satisfies WingSubscriptionGap);
      }
      try {
        this.sendRaw(mode, []);
      } catch (err) {
        console.error("[wing-osc-client] failed to send subscription renewal:", err);
      }
    };

    const interval = setInterval(renew, this.subscriptionRenewalIntervalMs);
    const handle = new SubscriptionHandleImpl(() => {
      clearInterval(interval);
      this.activeHandles.delete(handle);
    });
    this.activeHandles.add(handle);
    renew();
    return handle;
  }

  getQueueDepth(): number {
    return this.queue.length;
  }

  getLastSuccessAt(): number | null {
    return this.lastSuccessAt;
  }

  /** See the field doc on `lastActivityAt` — use this (not `getLastSuccessAt`) for staleness/health checks. */
  getLastActivityAt(): number | null {
    return this.lastActivityAt;
  }

  private sendRaw(address: string, args: OscArgument[]): void {
    if (!this.udpPort) {
      throw new WingUnavailableError("WING OSC client is not connected");
    }
    this.udpPort.send({ address, args });
  }

  /**
   * `trackLateReply` marks a request whose reply carries request-specific information, so that a
   * reply arriving after the request timed out must not be handed to whatever is now at the head.
   * Only `bulkSet` sets it: its ack reports the status of *that* write, so a stale one misreports.
   *
   * A GET deliberately does not, even though its address matches just as loosely: a GET reply is
   * the parameter's current value whoever asked for it, so swallowing it would trade the harmless
   * ambiguity the class doc already accepts for a request that fails outright — which is exactly
   * what happens to the first read after a console restart, where the reply to a new GET arrives
   * while the timed-out one's grace period is still open.
   */
  private enqueue(opts: {
    send: () => void;
    matches: (msg: { address: string; args: OscArgument[] }) => boolean;
    trackLateReply?: boolean;
  }): Promise<{ address: string; args: OscArgument[] }> {
    if (this.queue.length >= this.maxQueueLength) {
      return Promise.reject(
        new WingQueueOverflowError(`WING OSC request queue is full (max ${this.maxQueueLength})`)
      );
    }
    return new Promise((resolve, reject) => {
      const wasEmpty = this.queue.length === 0;
      const entry: QueueEntry = {
        send: opts.send,
        matches: opts.matches,
        resolve,
        reject,
        trackLateReply: opts.trackLateReply,
      };
      this.queue.push(entry);
      if (wasEmpty) {
        this.activateHead();
        return;
      }
      // Only entries that queue behind something need this; activateHead() clears it on promotion,
      // so if it ever fires the entry is still waiting its turn and has never been sent.
      entry.queueTimer = setTimeout(() => {
        this.dropQueuedEntry(
          entry,
          new WingTimeoutError(`WING OSC request waited more than ${this.maxQueueWaitMs}ms in the queue without being sent`),
        );
      }, this.maxQueueWaitMs);
      entry.queueTimer.unref?.();
    });
  }

  /** Removes a still-unsent entry from wherever it sits in the queue and rejects it. */
  private dropQueuedEntry(entry: QueueEntry, err: Error): void {
    const index = this.queue.indexOf(entry);
    if (index < 0) {
      return;
    }
    this.queue.splice(index, 1);
    if (entry.queueTimer) {
      clearTimeout(entry.queueTimer);
    }
    entry.reject(err);
  }

  private activateHead(): void {
    const head = this.queue[0];
    if (!head) {
      return;
    }
    if (head.queueTimer) {
      clearTimeout(head.queueTimer);
      head.queueTimer = undefined;
    }
    head.timer = setTimeout(() => {
      // Only a timeout can leave a reply in flight: a `send()` failure below never put anything on
      // the wire, and close() tears the socket down entirely.
      this.failHead(new WingTimeoutError(`WING OSC request timed out after ${this.requestTimeoutMs}ms`), {
        replyMayStillArrive: true,
      });
    }, this.requestTimeoutMs);
    try {
      head.send();
    } catch (err) {
      this.failHead(err instanceof Error ? err : new WingUnavailableError(String(err)));
    }
  }

  private resolveHead(msg: { address: string; args: OscArgument[] }): void {
    const head = this.queue.shift();
    if (!head) {
      return;
    }
    if (head.timer) {
      clearTimeout(head.timer);
    }
    this.lastSuccessAt = Date.now();
    this.lastActivityAt = this.lastSuccessAt;
    head.resolve(msg);
    this.activateHead();
  }

  private failHead(err: Error, opts?: { replyMayStillArrive?: boolean }): void {
    const head = this.queue.shift();
    if (!head) {
      return;
    }
    if (head.timer) {
      clearTimeout(head.timer);
    }
    if (opts?.replyMayStillArrive && head.trackLateReply) {
      this.rememberAbandonedReply(head.matches);
    }
    head.reject(err);
    this.activateHead();
  }

  private rememberAbandonedReply(matches: QueueEntry["matches"]): void {
    // Bounded like the queue itself: a console that answers nothing must not grow this list
    // without limit. Dropping the oldest is right — it is also the one most likely expired.
    if (this.abandoned.length >= this.maxQueueLength) {
      this.abandoned.shift();
    }
    this.abandoned.push({ matches, expiresAt: Date.now() + this.requestTimeoutMs * 2 });
  }

  /**
   * Claims `msg` for at most one timed-out request, and prunes expired entries in the same pass.
   * Returns true when the message was a late reply and must not reach the queue.
   */
  private consumeAbandonedReply(msg: { address: string; args: OscArgument[] }): boolean {
    const now = Date.now();
    let claimed = false;
    for (let i = 0; i < this.abandoned.length; ) {
      const entry = this.abandoned[i] as AbandonedReply;
      if (entry.expiresAt <= now) {
        this.abandoned.splice(i, 1);
        continue;
      }
      if (!claimed && entry.matches(msg)) {
        this.abandoned.splice(i, 1);
        claimed = true;
        continue;
      }
      i += 1;
    }
    return claimed;
  }

  private parseGetReply(path: string, args: OscArgument[]): WingGetResult | WingBranchResult {
    // ",sff"/",sfi" leaves are always exactly 3 args starting with (s, f);
    // plain string/enum leaves are exactly 1 arg. Anything else is treated
    // as a branch listing (child name args) — this is a best-effort
    // heuristic since a single-child branch is structurally indistinguishable
    // from a single-string leaf reply (both are one "s" arg).
    const looksLikeLeaf = (args.length === 3 && args[0]?.type === "s" && args[1]?.type === "f") || args.length === 1;
    if (!looksLikeLeaf) {
      return { path, kind: "branch", children: args.map((a) => String(a.value)) };
    }
    const parsed = parseOscGetReply(args);
    return {
      path,
      kind: "leaf",
      valueKind: parsed.valueKind,
      display: parsed.display,
      raw: parsed.raw,
      value: parsed.value,
    };
  }

  private handleMessage = (message: OscMessage, _timeTag?: unknown, info?: OscRemoteInfo): void => {
    // Before anything else — the mirror included: a datagram that is not from the console is not
    // console traffic, whatever it claims to be.
    if (info && !isFromConsole(this.consoleSources, info.address)) {
      this.reportDrop(info.address);
      return;
    }
    const args = normalizeArgs(message.args);
    this.emit("raw", { address: message.address, args });
    const msg = { address: message.address, args };
    if (this.consumeAbandonedReply(msg)) {
      // A reply to a request we already timed out and rejected. It proves the link is alive, so it
      // counts as activity — but it must reach neither the queue (it would resolve a *different*
      // request; see the class doc) nor the subscription handlers: it answers something we asked
      // for rather than reporting unsolicited state, and a "/*" bulk-set ack carries no node path
      // to report a change on.
      this.lastActivityAt = Date.now();
      return;
    }
    const head = this.queue[0];
    if (head && head.matches(msg)) {
      this.resolveHead(msg);
      return;
    }
    this.dispatchSubscriptionPush(message.address, args);
  };

  private dispatchSubscriptionPush(address: string, args: OscArgument[]): void {
    // Any unsolicited message from the console — even one we end up dropping below — proves the
    // link is alive, which is exactly what a health/staleness check cares about.
    this.lastActivityAt = Date.now();
    if (this.activeHandles.size === 0) {
      return;
    }
    let parsed;
    try {
      parsed = parseOscGetReply(args);
    } catch {
      // Malformed/unrecognized unsolicited push — drop silently, never throw
      // from the socket message handler.
      return;
    }
    const change: WingParamChange = {
      path: canonicalizeShadowAddress(address),
      shadow: isShadowAddress(address),
      raw: parsed.raw,
      value: parsed.value,
      valueKind: parsed.valueKind,
      receivedAt: Date.now(),
    };
    for (const handle of this.activeHandles) {
      handle.emit("change", change);
    }
  }
}
