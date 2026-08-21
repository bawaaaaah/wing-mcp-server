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
