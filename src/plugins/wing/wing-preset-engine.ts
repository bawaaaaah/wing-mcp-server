import { WingUnavailableError, WingValueError } from "./wing-errors.js";
import { buildGroupTags, parseGroupTags, TAGS_MAX_LENGTH } from "./wing-group-tags.js";
import { ioInPath, resolveStripPath, STRIP_TYPE_COUNTS, type StripType } from "./wing-node-paths.js";
import type { PresetFile, PresetSlot } from "./wing-preset-store.js";
import type { WingPluginContext } from "./wing-plugin.js";
import { resolveInputNameTarget, resolvePhysicalSource, type PhysicallyRoutableStripType } from "./tools/physical-source.js";
import { readEffectiveName } from "./tools/names.js";

function hasDuplicates(values: number[]): boolean {
  return new Set(values).size !== values.length;
}

export const PRESET_SECTION_KEYS = [
  "name",
  "gain",
  "trim",
  "pan",
  "fader",
  "mute",
  "eq",
  "gate",
  "dyn",
  "sends",
  "groups",
] as const;

export type PresetSectionKey = (typeof PRESET_SECTION_KEYS)[number];

type RawSection = PresetSectionKey | "uncategorized";

/**
 * What each strip type supports beyond its `dump()`-derived fields (fader/mute/pan/eq/gate/dyn/sends
 * — those are naturally type-agnostic: whatever a type's real dump() doesn't contain simply never
 * produces a key to classify, so e.g. a mutegroup dump yielding only `{mute, name}` already restricts
 * itself with zero extra code). Only two things genuinely need to be known ahead of a request rather
 * than discovered from dump() content:
 * - `hasTags`: whether the console exposes a `tags` leaf at all (DCA does not — verified live, see
 *   tools/groups.ts's GroupableType exclusion of "dca"). Gating this avoids an extra round trip (or
 *   worse, a timeout) against a node that will never resolve, for every capture/restore.
 * - `hasPhysicalInput`: whether the strip is wired to a physical input at all (only channel/aux are —
 *   bus/main/matrix/dca/mutegroup are internal console constructs with no `in/conn`/`in/set` nodes).
 *   Gates gain, trim, and name-source-linking.
 */
const STRIP_CAPABILITIES: Record<StripType, { hasTags: boolean; hasPhysicalInput: boolean }> = {
  channel: { hasTags: true, hasPhysicalInput: true },
  aux: { hasTags: true, hasPhysicalInput: true },
  bus: { hasTags: true, hasPhysicalInput: false },
  main: { hasTags: true, hasPhysicalInput: false },
  matrix: { hasTags: true, hasPhysicalInput: false },
  dca: { hasTags: false, hasPhysicalInput: false },
  mutegroup: { hasTags: false, hasPhysicalInput: false },
};

function isPhysicallyRoutable(type: StripType): type is PhysicallyRoutableStripType {
  return STRIP_CAPABILITIES[type].hasPhysicalInput;
}

/**
 * Channel/aux/bus/main/matrix all expose a `$name` shadow that mirrors the effective displayed name
 * (source-linked for channel/aux); DCA and mute groups have no such shadow at all — their plain
 * `name` leaf already is the live value. Mirrors tools/names.ts's NAME_CATEGORIES table exactly.
 */
function effectiveNameLivePath(type: StripType, index: number): string {
  if (type === "dca" || type === "mutegroup") {
    return resolveStripPath(type, index, "name");
  }
  return resolveStripPath(type, index, "$name");
}

/**
 * Classifies one `dump()`-derived dotted key into the section it belongs to, for load-time
 * filtering. `flt`/`peq` exist on real hardware (per http-routes.ts) but are undocumented anywhere
 * in this repo — folded into "eq" as a best guess. Safe if wrong: these prefixes then simply never
 * match a real dump() key, so nothing is silently mis-restored. Anything not recognized here falls
 * into "uncategorized" (console-surface cosmetics like col/icon/led) and is only ever restored on a
 * full, unfiltered load — see restoreSlot(). Type-agnostic by design: the same classification applies
 * whether the key came from a channel, a bus, or a DCA's dump() — each type's dump() simply never
 * contains keys for sections it doesn't support.
 */
export function classifyRawKey(key: string): RawSection {
  if (key === "pan" || key === "wid") return "pan";
  if (key === "fdr") return "fader";
  if (key === "mute") return "mute";
  if (key.startsWith("eq.") || key.startsWith("flt.") || key.startsWith("peq.")) return "eq";
  if (key.startsWith("gate.")) return "gate";
  if (key.startsWith("dyn.")) return "dyn";
  if (key.startsWith("send.") || key.startsWith("main.")) return "sends";
  return "uncategorized";
}

/**
 * Strips from a raw `dump()` map everything that must never be trusted/restored via a generic
 * bulk-set: read-only "$"-shadow mirrors (e.g. "$fdr" — see wing-osc-client.ts's isShadowAddress()
 * doc; defensive even though it's unconfirmed whether dump() itself ever surfaces one), `tags`
 * (dump() mis-keys this on deeply nested nodes — verified live, see tools/groups.ts), `name`
 * (source-linked restore needs resolveInputNameTarget(), never a blind write), and anything under
 * `in.*` (digital trim / physical-input routing, handled separately via `corrected`/`preampGain`).
 */
export function filterRawDumpForCapture(dump: Record<string, string | number>): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(dump)) {
    const lastSegment = key.split(".").pop() ?? key;
    if (lastSegment.startsWith("$")) continue;
    if (key === "tags" || key === ".tags") continue;
    if (key === "name") continue;
    if (key.startsWith("in.")) continue;
    out[key] = value;
  }
  return out;
}

/** Captures one strip's full restorable state. Throws on any read failure — a partial capture is never saved. */
export async function captureStripSlot(ctx: WingPluginContext, type: StripType, sourceIndex: number): Promise<PresetSlot> {
  const caps = STRIP_CAPABILITIES[type];
  const p = resolveStripPath(type, sourceIndex);
  const routable = isPhysicallyRoutable(type);

  const [rawDump, ownNameResult, tagsResult, trimResult, srcautoResult, source, effectiveName] = await Promise.all([
    ctx.client.dump(p),
    ctx.client.get(`${p}/name`),
    caps.hasTags ? ctx.client.get(`${p}/tags`) : Promise.resolve(null),
    routable ? ctx.client.get(`${p}/in/set/trim`) : Promise.resolve(null),
    routable ? ctx.client.get(`${p}/in/set/srcauto`) : Promise.resolve(null),
    routable ? resolvePhysicalSource(ctx, p) : Promise.resolve(null),
    readEffectiveName(ctx, resolveStripPath(type, sourceIndex, "name"), effectiveNameLivePath(type, sourceIndex)),
  ]);

  let preampGain: PresetSlot["preampGain"] = null;
  if (source) {
    const gainResult = await ctx.client.get(ioInPath(source.group, source.index, "g")).catch(() => null);
    if (gainResult && gainResult.kind === "leaf") {
      preampGain = { value: Number(gainResult.value), capturedFromSource: source };
    }
  }

  return {
    sourceIndex,
    raw: filterRawDumpForCapture(rawDump),
    corrected: {
      tags: tagsResult && tagsResult.kind === "leaf" ? String(tagsResult.value) : "",
      inConnGrp: source?.group ?? null,
      inConnIn: source?.index ?? null,
      inSetTrim: trimResult && trimResult.kind === "leaf" ? Number(trimResult.value) : null,
      inSetSrcauto: srcautoResult && srcautoResult.kind === "leaf" ? Number(srcautoResult.value) === 1 : null,
      ownName: ownNameResult.kind === "leaf" ? String(ownNameResult.value) : "",
      effectiveName,
    },
    preampGain,
  };
}

/**
 * Resolves which absolute index each preset slot should be applied to:
 * - `targetIndices` given: an explicit 1:1 mapping (must match the slot count exactly).
 * - `targetIndex` given: shifts every slot by the offset from the preset's lowest source index to
 *   `targetIndex` (e.g. a preset saved from channels 17-24 with targetIndex 9 applies to 9-16).
 * - neither given: re-applies to the exact indices the preset was saved from.
 */
export function resolveLoadTargets(
  type: StripType,
  slots: PresetSlot[],
  args: { targetIndex?: number; targetIndices?: number[] },
): number[] {
  let targets: number[];
  if (args.targetIndices) {
    if (args.targetIndices.length !== slots.length) {
      throw new WingValueError(
        `targetIndices has ${args.targetIndices.length} entries but the preset has ${slots.length} slot(s)`,
      );
    }
    targets = args.targetIndices;
  } else if (args.targetIndex !== undefined) {
    const base = Math.min(...slots.map((s) => s.sourceIndex));
    const offset = args.targetIndex - base;
    targets = slots.map((s) => s.sourceIndex + offset);
  } else {
    targets = slots.map((s) => s.sourceIndex);
  }

  const max = STRIP_TYPE_COUNTS[type];
  for (const t of targets) {
    if (!Number.isInteger(t) || t < 1 || t > max) {
      throw new WingValueError(`Resolved target ${type} index ${t} is out of range (1..${max})`);
    }
  }
  if (new Set(targets).size !== targets.length) {
    throw new WingValueError(`Resolved target ${type} indices contain duplicates: ${targets.join(", ")}`);
  }
  return targets;
}

export interface SectionOutcome {
  section: RawSection;
  status: "applied" | "skipped" | "error";
  detail?: string;
}

export interface SlotRestoreOutcome {
  sourceIndex: number;
  targetIndex: number;
  sections: SectionOutcome[];
  status: "ok" | "partial" | "failed";
  /** Set only when an unexpected/transport-level error (timeout, console unavailable) aborted this slot entirely. */
  error?: string;
}

/**
 * Applies one captured slot onto `targetIndex` of the given strip `type`, optionally restricted to
 * `sections`. Never throws for a per-section ack failure — every section's result (applied/skipped/
 * error) is reported in the returned outcome so a caller can tell exactly what did and didn't land.
 * Issues one bulk-set call PER section (rather than one combined call) because neither this repo nor
 * the WING protocol reference documents whether a multi-key bulk-set is atomic or applies in key
 * order until the first bad key — isolating each section keeps that ambiguity from smearing across
 * unrelated parameters and gives an accurate per-section report.
 *
 * `gain`/`trim` are skipped with a clear reason for strip types with no physical input (bus/main/
 * matrix/dca/mutegroup); `groups` is skipped the same way for types with no `tags` leaf (dca,
 * mutegroup). These are the only two type-dependent gates — every other section is naturally absent
 * for a type that doesn't support it, since that type's own `dump()` never produced a matching key.
 *
 * May still throw a `WingError` from an underlying transport failure (timeout, console
 * unavailable, queue overflow) — callers restoring multiple slots should catch this per slot.
 */
export async function restoreSlot(
  ctx: WingPluginContext,
  type: StripType,
  slot: PresetSlot,
  targetIndex: number,
  sections?: PresetSectionKey[],
): Promise<SlotRestoreOutcome> {
  const caps = STRIP_CAPABILITIES[type];
  const wanted = sections ? new Set<RawSection>(sections) : null;
  const targetPath = resolveStripPath(type, targetIndex);
  const outcomes: SectionOutcome[] = [];

  const bySection = new Map<RawSection, Record<string, number | string>>();
  for (const [key, value] of Object.entries(slot.raw)) {
    const section = classifyRawKey(key);
    const include = wanted === null || (section !== "uncategorized" && wanted.has(section));
    if (!include) continue;
    if (!bySection.has(section)) bySection.set(section, {});
    bySection.get(section)![key] = value;
  }
  for (const [section, assignments] of bySection) {
    if (Object.keys(assignments).length === 0) continue;
    const ack = await ctx.client.bulkSet(targetPath, assignments);
    outcomes.push({ section, status: ack.ok ? "applied" : "error", detail: ack.ok ? undefined : ack.status });
  }

  if (wanted === null || wanted.has("name")) {
    const name = slot.corrected.ownName || slot.corrected.effectiveName;
    if (!name) {
      outcomes.push({ section: "name", status: "skipped", detail: "no name captured for this slot" });
    } else {
      const target = isPhysicallyRoutable(type)
        ? await resolveInputNameTarget(ctx, type, targetIndex)
        : { baseNode: targetPath, cachePaths: [resolveStripPath(type, targetIndex, "name")], viaSource: false };
      const ack = await ctx.client.bulkSet(target.baseNode, { name });
      if (ack.ok) {
        for (const cachePath of target.cachePaths) {
          ctx.cache.applyChange({ path: cachePath, value: name });
        }
      }
      outcomes.push({ section: "name", status: ack.ok ? "applied" : "error", detail: ack.ok ? undefined : ack.status });
    }
  }

  if (wanted === null || wanted.has("trim")) {
    if (!caps.hasPhysicalInput) {
      outcomes.push({ section: "trim", status: "skipped", detail: `not applicable to a ${type}` });
    } else if (slot.corrected.inSetTrim === null) {
      outcomes.push({ section: "trim", status: "skipped", detail: "no trim captured for this slot" });
    } else {
      const ack = await ctx.client.bulkSet(`${targetPath}/in/set`, { trim: slot.corrected.inSetTrim });
      outcomes.push({ section: "trim", status: ack.ok ? "applied" : "error", detail: ack.ok ? undefined : ack.status });
    }
  }

  // Gain deliberately follows the TARGET strip's CURRENT physical routing, never the preset's
  // captured source — this feature never reassigns which physical input feeds a strip. As a
  // consequence, restoring gain can affect every other channel/aux sharing that same physical jack
  // (preamp gain is a property of the jack, not of any one strip).
  if (wanted === null || wanted.has("gain")) {
    if (!caps.hasPhysicalInput) {
      outcomes.push({ section: "gain", status: "skipped", detail: `not applicable to a ${type}` });
    } else if (slot.preampGain === null) {
      outcomes.push({ section: "gain", status: "skipped", detail: "source had no physical input at capture time" });
    } else {
      const live = await resolvePhysicalSource(ctx, targetPath);
      if (!live) {
        outcomes.push({ section: "gain", status: "skipped", detail: "target has no physical input currently routed" });
      } else {
        const ack = await ctx.client.bulkSet(ioInPath(live.group, live.index), { g: slot.preampGain.value });
        outcomes.push({
          section: "gain",
          status: ack.ok ? "applied" : "error",
          detail: ack.ok ? `applied to ${live.group}/${live.index}` : ack.status,
        });
      }
    }
  }

  // DCA/mute-group membership is REPLACED with what was captured; the target's own free-form tags
  // (anything that isn't a #D<n>/#M<n> token) are always preserved untouched.
  if (wanted === null || wanted.has("groups")) {
    if (!caps.hasTags) {
      outcomes.push({ section: "groups", status: "skipped", detail: `a ${type} has no tags/group membership` });
    } else {
      const currentTagsResult = await ctx.client.get(`${targetPath}/tags`);
      const currentTags = currentTagsResult.kind === "leaf" ? String(currentTagsResult.value) : "";
      const current = parseGroupTags(currentTags);
      const captured = parseGroupTags(slot.corrected.tags);
      const next = buildGroupTags({ dca: captured.dca, mutegroups: captured.mutegroups, other: current.other });
      if (next.length > TAGS_MAX_LENGTH) {
        outcomes.push({ section: "groups", status: "error", detail: "combined tags would exceed the console's 80-character limit" });
      } else {
        await ctx.client.set(`${targetPath}/tags`, next);
        const confirmedResult = await ctx.client.get(`${targetPath}/tags`);
        const confirmed = confirmedResult.kind === "leaf" ? String(confirmedResult.value) : "";
        outcomes.push({
          section: "groups",
          status: confirmed === next ? "applied" : "error",
          detail: confirmed === next ? undefined : "the console did not accept the new tags value",
        });
      }
    }
  }

  const anyError = outcomes.some((o) => o.status === "error");
  const anyApplied = outcomes.some((o) => o.status === "applied");
  return {
    sourceIndex: slot.sourceIndex,
    targetIndex,
    sections: outcomes,
    status: anyError ? (anyApplied ? "partial" : "failed") : "ok",
  };
}

/**
 * Curated, human-scale view of one captured slot — avoids handing a caller (LLM or dashboard) ~200
 * raw dump keys just to answer "what's in this preset". Shared by wing_preset_get (tools/presets.ts)
 * and the dashboard's GET /api/plugins/wing/presets/:name route (http-routes.ts).
 */
export function summarizeSlot(slot: PresetSlot) {
  const raw = slot.raw;
  const flagOn = (key: string): boolean | null => (raw[key] !== undefined ? Number(raw[key]) === 1 : null);
  return {
    sourceIndex: slot.sourceIndex,
    name: slot.corrected.effectiveName || slot.corrected.ownName || null,
    fader: raw.fdr !== undefined ? Number(raw.fdr) : null,
    mute: raw.mute !== undefined ? Number(raw.mute) === 1 : null,
    pan: raw.pan !== undefined ? Number(raw.pan) : null,
    trim: slot.corrected.inSetTrim,
    gain: slot.preampGain?.value ?? null,
    eqOn: flagOn("eq.on"),
    gateOn: flagOn("gate.on"),
    dynOn: flagOn("dyn.on"),
    physicalSourceAtCapture:
      slot.corrected.inConnGrp !== null && slot.corrected.inConnIn !== null
        ? { group: slot.corrected.inConnGrp, index: slot.corrected.inConnIn }
        : null,
  };
}

export interface PresetSaveArgs {
  name: string;
  type: StripType;
  indices: number[];
  overwrite?: boolean;
}

export interface PresetSaveResult {
  name: string;
  type: StripType;
  indices: number[];
  createdAt: string;
  updatedAt: string;
}

/**
 * Orchestrates a full preset save (capture every requested strip, then persist). Shared by
 * wing_preset_save (tools/presets.ts) and POST /api/plugins/wing/presets (http-routes.ts) so both
 * surfaces behave identically — the same split already used by wing-autogain.ts's
 * runCombinedAutoGain for the MCP tool vs. the dashboard's Auto Gain button.
 */
export async function performPresetSave(ctx: WingPluginContext, args: PresetSaveArgs): Promise<PresetSaveResult> {
  if (hasDuplicates(args.indices)) {
    throw new WingValueError(`indices contains duplicate entries: ${args.indices.join(", ")}`);
  }
  // Sequential, not Promise.all: each strip's capture already issues several concurrent reads
  // internally, and a large multi-strip save could otherwise exceed the OSC client's in-flight
  // request queue cap.
  const slots: PresetSlot[] = [];
  for (const index of args.indices) {
    slots.push(await captureStripSlot(ctx, args.type, index));
  }
  const file = await ctx.presetStore.save({ name: args.name, type: args.type, slots }, { overwrite: args.overwrite });
  return { name: file.name, type: file.type, indices: args.indices, createdAt: file.createdAt, updatedAt: file.updatedAt };
}

export interface PresetLoadArgs {
  name: string;
  targetIndex?: number;
  targetIndices?: number[];
  sections?: PresetSectionKey[];
}

export interface PresetLoadResult {
  name: string;
  type: StripType;
  sections: PresetSectionKey[] | null;
  results: SlotRestoreOutcome[];
  summary: { total: number; ok: number; partial: number; failed: number };
}

async function findPresetOrThrow(ctx: WingPluginContext, name: string): Promise<PresetFile> {
  const file = await ctx.presetStore.get(name);
  if (file) return file;
  const known = (await ctx.presetStore.list()).map((p) => p.name);
  throw new WingValueError(`No preset named "${name}" exists. Known presets: ${known.join(", ") || "(none)"}`);
}

/**
 * Orchestrates a full preset load: resolves targets, restores each slot (best-effort, fast-failing
 * remaining slots on a console-unavailable error), and aggregates a summary. Shared by
 * wing_preset_load (tools/presets.ts) and POST /api/plugins/wing/presets/:name/load
 * (http-routes.ts).
 */
export async function performPresetLoad(ctx: WingPluginContext, args: PresetLoadArgs): Promise<PresetLoadResult> {
  if (args.targetIndex !== undefined && args.targetIndices !== undefined) {
    throw new WingValueError("Pass either targetIndex or targetIndices, not both.");
  }
  if (args.targetIndices && hasDuplicates(args.targetIndices)) {
    throw new WingValueError(`targetIndices contains duplicate entries: ${args.targetIndices.join(", ")}`);
  }

  const file = await findPresetOrThrow(ctx, args.name);
  const targets = resolveLoadTargets(file.type, file.slots, { targetIndex: args.targetIndex, targetIndices: args.targetIndices });

  const results: SlotRestoreOutcome[] = [];
  let abortRemaining = false;
  for (let i = 0; i < file.slots.length; i++) {
    if (abortRemaining) {
      results.push({
        sourceIndex: file.slots[i].sourceIndex,
        targetIndex: targets[i],
        sections: [],
        status: "failed",
        error: "skipped after the console became unavailable while loading an earlier strip",
      });
      continue;
    }
    try {
      results.push(await restoreSlot(ctx, file.type, file.slots[i], targets[i], args.sections));
    } catch (err) {
      if (err instanceof WingUnavailableError) {
        abortRemaining = true;
      }
      results.push({
        sourceIndex: file.slots[i].sourceIndex,
        targetIndex: targets[i],
        sections: [],
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const summary = {
    total: results.length,
    ok: results.filter((r) => r.status === "ok").length,
    partial: results.filter((r) => r.status === "partial").length,
    failed: results.filter((r) => r.status === "failed").length,
  };

  return { name: file.name, type: file.type, sections: args.sections ?? null, results, summary };
}

/** Shared by wing_preset_delete (tools/presets.ts) and DELETE /api/plugins/wing/presets/:name (http-routes.ts). */
export async function performPresetDelete(ctx: WingPluginContext, name: string): Promise<{ name: string; deleted: true }> {
  const deleted = await ctx.presetStore.delete(name);
  if (!deleted) {
    throw new WingValueError(`No preset named "${name}" exists.`);
  }
  return { name, deleted: true };
}
