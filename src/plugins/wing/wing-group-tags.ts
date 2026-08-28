/**
 * DCA and mute group membership isn't a separate node in the WING protocol — verified against real
 * hardware (a live console's channels/buses already using this in production): a channel/aux/
 * bus/main/matrix is added to DCA N or Mute Group N by adding a reserved `#DN` / `#MN` token to its
 * own `tags` string (comma-separated, alongside any free-form user tags — e.g. a real channel was
 * found with `tags=#D7,#D9`, and a real aux with `tags=TALKA.ON,TALKB.ON`). `#D1..#D16` is
 * documented in the official WING Remote Protocols reference; `#M1..#M8` for mute groups is not
 * documented there but was confirmed live (tagging a channel `#M1` and muting `/mgrp/1` flipped the
 * channel's `$mute` to 2, the same "muted via group" value `#D`-tagging + a DCA mute produces).
 */

import { WingValueError } from "./wing-errors.js";
import { DCA_COUNT, MUTEGROUP_COUNT } from "./wing-node-paths.js";
import type { WingPluginContext } from "./wing-plugin.js";

const DCA_TAG_RE = /^#D(\d+)$/;
const MUTEGROUP_TAG_RE = /^#M(\d+)$/;

export const TAGS_MAX_LENGTH = 80;

export interface ParsedGroupTags {
  dca: number[];
  mutegroups: number[];
  /** Every other tag (free-form user tags, TALKA.ON/TALKB.ON, "*", ...), preserved verbatim. */
  other: string[];
}

export function parseGroupTags(tags: string): ParsedGroupTags {
  const dca = new Set<number>();
  const mutegroups = new Set<number>();
  const other: string[] = [];
  for (const raw of tags.split(",")) {
    const tag = raw.trim();
    if (!tag) continue;
    const dcaMatch = DCA_TAG_RE.exec(tag);
    if (dcaMatch) {
      dca.add(Number(dcaMatch[1]));
      continue;
    }
    const mgMatch = MUTEGROUP_TAG_RE.exec(tag);
    if (mgMatch) {
      mutegroups.add(Number(mgMatch[1]));
      continue;
    }
    other.push(tag);
  }
  return { dca: [...dca].sort((a, b) => a - b), mutegroups: [...mutegroups].sort((a, b) => a - b), other };
}

export function buildGroupTags(parsed: ParsedGroupTags): string {
  const dcaTags = [...parsed.dca].sort((a, b) => a - b).map((n) => `#D${n}`);
  const mutegroupTags = [...parsed.mutegroups].sort((a, b) => a - b).map((n) => `#M${n}`);
  return [...parsed.other, ...dcaTags, ...mutegroupTags].join(",");
}

/** Returns the new `tags` string with `kind`/`index` added or removed, or null if it would exceed the console's field length. */
export function toggleGroupTag(currentTags: string, kind: "dca" | "mutegroup", index: number, on: boolean): string | null {
  const parsed = parseGroupTags(currentTags);
  const set = new Set(kind === "dca" ? parsed.dca : parsed.mutegroups);
  if (on) set.add(index);
  else set.delete(index);
  const next: ParsedGroupTags = kind === "dca" ? { ...parsed, dca: [...set] } : { ...parsed, mutegroups: [...set] };
  const built = buildGroupTags(next);
  return built.length > TAGS_MAX_LENGTH ? null : built;
}

/**
 * Reads `tags` with a direct leaf `get()`, never `dump()` on the parent node — verified live that
 * `dump()`'s flat-assignment parser mis-keys entries (a stray leading ".") on nodes with enough
 * nested sub-sections, which a full channel/bus/etc. node very much is.
 */
export async function getTags(ctx: WingPluginContext, basePath: string): Promise<string> {
  const result = await ctx.client.get(`${basePath}/tags`);
  return result.kind === "leaf" ? String(result.value) : "";
}

export async function getGroupMembership(ctx: WingPluginContext, basePath: string): Promise<ParsedGroupTags> {
  return parseGroupTags(await getTags(ctx, basePath));
}

/**
 * Per-`basePath` queue serializing `setGroupMembership`'s read-modify-write-verify sequence below.
 * Without this, two toggles on the same strip issued close together (a double-click in the web UI,
 * or the REST route and the MCP tool firing concurrently — both funnel through this one function)
 * each read the same starting `tags`, compute their own new value in isolation, and whichever write
 * lands second silently overwrites the first — observed live against a real console. Entries are
 * never evicted, but `basePath` only ranges over a small, fixed set of strip paths, so the map stays
 * bounded for the process lifetime.
 */
const pathLocks = new Map<string, Promise<unknown>>();

function withPathLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const previous = pathLocks.get(path) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(fn);
  pathLocks.set(path, run.catch(() => undefined));
  return run;
}

/**
 * Adds or removes `basePath`'s membership in DCA/mute-group `index`, verifying the change by
 * reading `tags` back afterward (the underlying `set()` has no ack of its own — see `getTags` for
 * why this uses `set()`/`get()` rather than `bulkSet()`). Throws `WingValueError` for an
 * out-of-range group index, an overflowing tags field, or a write the console didn't apply.
 */
export async function setGroupMembership(
  ctx: WingPluginContext,
  basePath: string,
  kind: "dca" | "mutegroup",
  index: number,
  on: boolean,
): Promise<ParsedGroupTags> {
  const maxIndex = kind === "dca" ? DCA_COUNT : MUTEGROUP_COUNT;
  if (!Number.isInteger(index) || index < 1 || index > maxIndex) {
    throw new WingValueError(`${kind} index out of range: ${index} (expected 1..${maxIndex})`);
  }

  return withPathLock(basePath, async () => {
    const currentTags = await getTags(ctx, basePath);
    const nextTags = toggleGroupTag(currentTags, kind, index, on);
    if (nextTags === null) {
      throw new WingValueError("This would exceed the console's 80-character tags field on this strip — remove another tag first.");
    }

    await ctx.client.set(`${basePath}/tags`, nextTags);
    const confirmedTags = await getTags(ctx, basePath);
    if (confirmedTags !== nextTags) {
      throw new WingValueError(
        `The console didn't accept the new tags value (expected ${JSON.stringify(nextTags)}, read back ${JSON.stringify(confirmedTags)}).`,
      );
    }

    return parseGroupTags(confirmedTags);
  });
}
