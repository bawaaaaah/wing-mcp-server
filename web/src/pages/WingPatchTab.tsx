import { useEffect, useRef, useState, type CSSProperties, type JSX } from "react";
import { apiFetch, apiFetchBlob } from "../api/client.js";
import { useLinkStatus, usePluginConfig, useUpdateConfig, type PluginConfig } from "../api/queries.js";

interface BoxRow {
  /** Stable key of the row: its position changes when rows are moved. */
  id: number;
  group: string;
  first: number;
  last: number;
  device: string;
  model: string;
  /** The box this one is plugged into: a hub (DL8 on a HUB4) or the host of a personal mixer (P16-M). */
  via: string;
  feedFirst: number;
  feedLast: number;
  /** Group the played ports are on; empty = the host's own. */
  feedGroup: string;
  /** The feed was set or changed here: otherwise a mixer keeps the server's default for its host. */
  feedTouched: boolean;
  /** DL16 / S16 modes: the XLR outputs follow AES50 ch 1-8 (0), 9-16 (8) or 17-24 (16); splitter = the Ultranet carries the box's own inputs. */
  outOffset: 0 | 8 | 16;
  splitter: boolean;
  /** On the patch sheet (false = kept in the map, but no page for it). */
  inPdf: boolean;
  /** The box as it was saved: fields this editor does not show (localPorts...) are kept as they were. */
  orig?: WireBox;
}

interface WireBox {
  range: [number, number];
  device: string;
  model?: string;
  localPorts?: [number, number];
  via?: string;
  hub?: string;
  outOffset?: 0 | 8 | 16;
  splitter?: boolean;
  pdf?: boolean;
  feed?: { group?: string; range: [number, number] };
}

type WireMap = Record<string, WireBox[]>;

/** What the server's catalogue says about a box: its size, and where it must start. */
interface ModelInfo {
  id: string;
  label: string;
  kind: string;
  /** Channels the box takes on the console; 0 when it takes none of its own range. */
  size: number;
  fixedStart?: number;
  outModes?: boolean;
  match: { source: string; flags: string };
}

/** Ports per console group: a range may not go beyond (the server refuses it too). Fallback until /io/boxmap/models answers. */
const DEFAULT_GROUP_LIMIT: Record<string, number> = { A: 48, B: 48, C: 48, SC: 32, LCL: 24, CRD: 64, MOD: 64 };

/** Offered in the model field before the catalogue arrives; any text is accepted. */
const MODELS = [
  "Midas DL8",
  "Midas DL16",
  "Midas DL32",
  "Klark Teknik DN4816U",
  "Midas HUB4",
  "Behringer X32 Rack",
  "Behringer WING Rack",
  "Behringer WING Compact",
  "Behringer WING Full",
  "Behringer S16",
  "Behringer S32",
  "WING-LIVE",
  "WING-DANTE",
  "P16-M",
];
/** The three WING consoles: their own back panels (the LCL ports) differ, so the sheet draws the one chosen here. */
const CONSOLE_TYPES = [
  { id: "behringer-wing-full", label: "WING (full-size) — 8 local inputs", model: "Behringer WING Full", size: 8 },
  { id: "behringer-wing-rack", label: "WING Rack — 24 local inputs", model: "Behringer WING Rack", size: 24 },
  { id: "behringer-wing-compact", label: "WING Compact — 24 local inputs", model: "Behringer WING Compact", size: 24 },
] as const;

/** Saves are queued behind each other. */
let saveChain: Promise<void> = Promise.resolve();
/** Edits not yet saved: kept when the tab is left and come back. */
let unsavedRows: BoxRow[] | null = null;

/** The group limits tidyRow reads (module-level helper, set when the catalogue arrives). */
let activeLimits: Record<string, number> = DEFAULT_GROUP_LIMIT;

let rowCounter = 0;
const newId = (): number => ++rowCounter;

/** JSON with sorted keys: two maps that differ only in key order are the same map. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** Catalogue patterns, compiled once (null = an invalid pattern). */
const regexCache = new Map<string, RegExp | null>();
function compiled(m: ModelInfo): RegExp | null {
  const key = `${m.match.flags}/${m.match.source}`;
  let re = regexCache.get(key);
  if (re === undefined) {
    try {
      re = new RegExp(m.match.source, m.match.flags);
    } catch {
      re = null;
    }
    regexCache.set(key, re);
  }
  return re;
}

function specOfRow(models: ModelInfo[], r: Pick<BoxRow, "model" | "device">): ModelInfo | undefined {
  const test = (text: string): ModelInfo | undefined => (text ? models.find((m) => compiled(m)?.test(text)) : undefined);
  // The model decides; the name only when the model matches nothing (as on the server).
  return test(r.model) ?? test(r.device);
}

function isPersonalMixer(models: ModelInfo[], r: BoxRow): boolean {
  const spec = specOfRow(models, r);
  return spec ? spec.kind === "personal-mixer" : /\bP-?16-?M\b/i.test(`${r.model} ${r.device}`);
}

function isHubRow(models: ModelInfo[], r: BoxRow): boolean {
  const spec = specOfRow(models, r);
  return spec ? spec.kind === "hub" : /\bHUB-?4\b/i.test(`${r.model} ${r.device}`);
}

function fromWire(map: WireMap | undefined): BoxRow[] {
  const rows: BoxRow[] = [];
  for (const [group, boxes] of Object.entries(map ?? {})) {
    for (const b of boxes) {
      rows.push({
        id: newId(),
        group,
        first: b.range[0],
        last: b.range[1],
        device: b.device,
        model: b.model ?? "",
        via: b.via ?? b.hub ?? "",
        feedFirst: b.feed?.range[0] ?? 33,
        feedLast: b.feed?.range[1] ?? 48,
        feedGroup: b.feed?.group ?? "",
        feedTouched: false,
        outOffset: b.outOffset ?? 0,
        splitter: !!b.splitter,
        inPdf: b.pdf !== false,
        orig: b,
      });
    }
  }
  return rows;
}

/** Back to the saved shape: what was saved is kept, only what this editor sets is written over it. */
function toWire(models: ModelInfo[], rows: BoxRow[]): WireMap {
  const map: WireMap = {};
  for (const r of rows) {
    const box: WireBox = { ...(r.orig ?? {}), range: [r.first, r.last], device: r.device.trim() };
    if (box.localPorts === undefined) delete box.localPorts;
    delete box.via;
    delete box.hub;
    delete box.feed;
    delete box.outOffset;
    delete box.splitter;
    delete box.pdf;
    if (!r.inPdf) box.pdf = false;
    // Output modes belong to the models that have them (DL16, S16).
    const spec = specOfRow(models, r);
    if (spec ? spec.outModes : models.length === 0 || !spec) {
      // Known model with modes: what is set here. Catalogue missing or model unknown: keep what was saved.
      const offset = spec ? r.outOffset : (r.orig?.outOffset ?? r.outOffset);
      const splitter = spec ? r.splitter : (r.orig?.splitter ?? r.splitter);
      if (offset) box.outOffset = offset;
      if (splitter) box.splitter = true;
    }
    if (r.model.trim()) box.model = r.model.trim();
    else delete box.model;
    if (r.via && isPersonalMixer(models, r)) {
      // A personal mixer plays console output ports through its host; with no feed set the server's default applies.
      box.via = r.via;
      if (r.feedTouched || r.orig?.feed) box.feed = { ...(r.feedGroup ? { group: r.feedGroup } : {}), range: [r.feedFirst, r.feedLast] };
    } else if (r.via) {
      // Anything else keeps its own console ports and just sits under a hub (HUB4).
      box.hub = r.via;
    }
    (map[r.group] ??= []).push(box);
  }
  return map;
}

/**
 * Keeps a row's range possible: a known box takes exactly its channels (a DL8 eight, a card 64), a hub
 * starts at 33 and a card at 1, nothing goes past the ports its group has, and a personal mixer has
 * no range of its own (it plays a feed).
 */
function tidyRow(models: ModelInfo[], r: BoxRow, clampOnly = false): BoxRow {
  if (r.via && isPersonalMixer(models, r)) return r;
  const spec = specOfRow(models, r);
  // clampOnly (loading a saved map): never grow a range the server accepts, only keep it inside its group.
  const size = !clampOnly && spec && spec.size > 0 ? spec.size : 0;
  const limit = activeLimits[r.group] ?? 999;
  let length = size > 0 ? size : Math.max(1, r.last - r.first + 1);
  length = Math.min(length, limit);
  const first = Math.min(clampOnly ? Math.max(1, r.first) : (spec?.fixedStart ?? Math.max(1, r.first)), limit - length + 1);
  return { ...r, first, last: first + length - 1 };
}

/** A number field that keeps what is being typed and applies it on blur or Enter (no re-snapping on each digit). */
function NumInput(props: { value: number; onCommit: (n: number) => void; min?: number; max?: number; disabled?: boolean; title?: string; label: string }): JSX.Element {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = (): void => {
    if (draft !== null) {
      const n = Number(draft);
      if (draft.trim() !== "" && Number.isInteger(n) && n !== props.value) props.onCommit(n);
      setDraft(null);
    }
  };
  return (
    <input
      type="number"
      min={props.min}
      max={props.max}
      value={draft ?? props.value}
      disabled={props.disabled}
      title={props.title}
      aria-label={props.label}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") setDraft(null);
      }}
      className="patch-num"
    />
  );
}

/** A text field that applies what was typed on blur or Enter (so a rename is one change, not one per letter). */
function DraftText(props: { value: string; onCommit: (v: string) => void; label: string; invalid?: boolean; placeholder?: string; focusKey?: string; describedBy?: string }): JSX.Element {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = (): void => {
    if (draft !== null) {
      if (draft !== props.value) props.onCommit(draft);
      setDraft(null);
    }
  };
  return (
    <input
      value={draft ?? props.value}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") setDraft(null);
      }}
      aria-label={props.label}
      aria-invalid={props.invalid ? true : undefined}
      placeholder={props.placeholder}
      data-focus={props.focusKey}
      aria-describedby={props.describedBy}
    />
  );
}

/** The box a row hangs under (its hub, or the host of a personal mixer), when that box is in the list. */
function parentOf(rows: BoxRow[], r: BoxRow): BoxRow | undefined {
  const name = r.via.trim();
  if (!name) return undefined;
  const host = rows.find((h) => h !== r && h.device.trim() === name);
  return host;
}

/** Rows with every box directly under the one it hangs off (and what hangs off that, in turn), order otherwise kept. */
function nestedOrder(rows: BoxRow[]): BoxRow[] {
  const out: BoxRow[] = [];
  const seen = new Set<BoxRow>();
  const place = (r: BoxRow): void => {
    if (seen.has(r)) return;
    seen.add(r);
    out.push(r);
    for (const c of rows) if (parentOf(rows, c) === r) place(c);
  };
  for (const r of rows) if (!parentOf(rows, r)) place(r);
  for (const r of rows) place(r); // a loop of links: keep them all
  return out;
}

/** A row and everything below it (contiguous once the rows are nested). */
function blockOf(rows: BoxRow[], r: BoxRow): BoxRow[] {
  const block = new Set<BoxRow>([r]);
  for (const x of rows) {
    const p = parentOf(rows, x);
    if (p && block.has(p)) block.add(x);
  }
  return rows.filter((x) => block.has(x));
}

/** The row, or the box above it, that is a sibling of `of` (same parent): where a drop on `target` lands. */
function siblingFor(rows: BoxRow[], of: BoxRow, target: BoxRow): BoxRow | undefined {
  const wanted = parentOf(rows, of);
  for (let t: BoxRow | undefined = target, guard = 0; t && guard < 10; t = parentOf(rows, t), guard++) {
    if (parentOf(rows, t) === wanted) return t === of ? undefined : t;
  }
  return undefined;
}

/** `r` with its boxes moved before or after the block of `target`. */
function moveBlock(rows: BoxRow[], r: BoxRow, target: BoxRow, before: boolean): BoxRow[] {
  const moving = blockOf(rows, r);
  const rest = rows.filter((x) => !moving.includes(x));
  const targetBlock = blockOf(rest, target);
  const at = rest.indexOf(before ? (targetBlock[0] as BoxRow) : (targetBlock[targetBlock.length - 1] as BoxRow));
  rest.splice(before ? at : at + 1, 0, ...moving);
  return rest;
}

/** Patch sheet: the stage-box map that labels the patch, and the PDF generator. */
export function WingPatchTab(): JSX.Element {
  const config = usePluginConfig("wing");
  const saveBoxes = useUpdateConfig("wing");
  const savePreset = useUpdateConfig("wing");
  const [rows, setRows] = useState<BoxRow[] | null>(() => unsavedRows);
  const [render, setRender] = useState<"visual" | "table">("visual");
  const [naming, setNaming] = useState<"io" | "channel" | "full">("channel");
  const [lang, setLang] = useState<"fr" | "en">("fr");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const links = useLinkStatus();
  const [detected, setDetected] = useState<{ consoleModel: string; notes: string[] } | null>(null);
  const [detectError, setDetectError] = useState<string | undefined>();
  const [presetName, setPresetName] = useState("");
  const [picked, setPicked] = useState("");
  const [presetNote, setPresetNote] = useState<{ text: string; bad?: boolean } | null>(null);
  const [boxesNote, setBoxesNote] = useState<{ text: string; bad?: boolean } | null>(null);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [groupLimits, setGroupLimits] = useState<Record<string, number>>(DEFAULT_GROUP_LIMIT);
  const [modelsError, setModelsError] = useState(false);
  const [tidied, setTidied] = useState(false);
  // The console's own ports page: on the sheet unless switched off (remembered in this browser).
  const [consolePage, setConsolePage] = useState<boolean>(() => {
    try {
      return localStorage.getItem("wing-patch-console") !== "0";
    } catch {
      return true;
    }
  });
  const chooseConsolePage = (on: boolean): void => {
    setConsolePage(on);
    try {
      localStorage.setItem("wing-patch-console", on ? "1" : "0");
    } catch {
      /* not remembered: fine */
    }
  };
  const loadedKey = useRef<string | null>(null);
  const [detecting, setDetecting] = useState(false);
  // What a screen reader is told after a move or a removal (the rows change silently otherwise).
  const [announcement, setAnnouncement] = useState<{ text: string; n: number }>({ text: "", n: 0 });
  const announce = (text: string): void => setAnnouncement((a) => ({ text, n: a.n + 1 }));
  // The control to focus once the next render is done: a button that moved, got disabled or was removed would drop focus on <body>.
  const pendingFocus = useRef<string | null>(null);
  useEffect(() => {
    const key = pendingFocus.current;
    if (!key) return;
    pendingFocus.current = null;
    const el = document.querySelector<HTMLElement>(`[data-focus="${CSS.escape(key)}"]`);
    el?.scrollIntoView?.({ block: "nearest" });
    el?.focus();
  });

  const saved = (config.data?.config as { boxMap?: WireMap } | undefined)?.boxMap;
  const savedKey = stable(saved ?? {});
  const orderOf = (m: WireMap | undefined): string => Object.keys(m ?? {}).join(",");
  // What the editor shows for the saved map once its boxes are put under their parents: that is the baseline.
  const baseline = toWire(models, nestedOrder(fromWire(saved).map((r) => tidyRow(models, r, true))));
  const current = rows === null ? null : toWire(models, rows);
  const dirty = current !== null && (stable(current) !== stable(baseline) || orderOf(current) !== orderOf(baseline));

  // Leaving the tab does not lose what was being edited.
  useEffect(() => {
    unsavedRows = dirty ? rows : null;
  }, [dirty, rows]);

  useEffect(() => {
    apiFetch<{ models: ModelInfo[]; groupLimits?: Record<string, number> }>("/api/plugins/wing/io/boxmap/models")
      .then((r) => {
        setModels(r.models);
        if (r.groupLimits) {
          setGroupLimits(r.groupLimits);
          activeLimits = r.groupLimits;
        }
      })
      .catch(() => setModelsError(true));
  }, []);

  // Rows start from the saved map, and follow it when it changes elsewhere (another tab, an MCP tool)
  // as long as nothing here is being edited.
  // (Hooks stay above the early returns below: their number must not change between renders.)
  useEffect(() => {
    if (!config.data) return;
    if (rows === null || (!dirty && loadedKey.current !== null && loadedKey.current !== savedKey)) {
      loadedKey.current = savedKey;
      setRows(nestedOrder(fromWire(saved)));
      setTidied(false);
    } else if (loadedKey.current === null) {
      loadedKey.current = savedKey;
    }
  }, [config.data, savedKey, rows, dirty, saved]);

  // Once the catalogue is here, bring the saved rows within what their models and groups allow.
  useEffect(() => {
    if (models.length > 0 && rows !== null && !tidied) {
      setTidied(true);
      setRows(nestedOrder(rows.map((r) => tidyRow(models, r, true))));
    }
  }, [models, rows, tidied]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent): void => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  if (config.isError) return <p className="error">Could not read the configuration: {(config.error as Error).message}</p>;
  if (config.isLoading || rows === null) return <p role="status">Loading patch...</p>;

  const presets = (config.data?.config as { boxPresets?: Record<string, WireMap> } | undefined)?.boxPresets ?? {};
  const presetNames = Object.keys(presets).sort();

  /**
   * The config PUT replaces the whole file: read it again just before, and put back only the keys this
   * tab owns, so a change made elsewhere since the page opened is not undone.
   */
  async function saveKeys(mutation: typeof saveBoxes, extra: (fresh: Record<string, unknown>) => Record<string, unknown>): Promise<void> {
    // One save at a time (box map and presets share the same file): a second waits for the first.
    const run = saveChain.then(async () => {
      const fresh = await apiFetch<PluginConfig>("/api/plugins/wing/config");
      const onDisk = fresh.config as Record<string, unknown>;
      await mutation.mutateAsync({ ...onDisk, ...extra(onDisk) });
    });
    saveChain = run.catch(() => undefined);
    await run;
  }
  const freshPresets = (c: Record<string, unknown>): Record<string, WireMap> => (c.boxPresets as Record<string, WireMap> | undefined) ?? {};

  const confirmReplace = (): boolean => !dirty || window.confirm("Replace the boxes you changed and have not saved?");

  async function detect(): Promise<void> {
    setDetectError(undefined);
    if (detecting || !confirmReplace()) return;
    setDetecting(true);
    try {
      const d = await apiFetch<{ consoleModel: string; boxMap: WireMap; notes: string[] }>("/api/plugins/wing/io/boxmap/detect");
      setRows(nestedOrder(fromWire(d.boxMap).map((r) => tidyRow(models, r, true))));
      setDetected({ consoleModel: d.consoleModel, notes: d.notes });
    } catch (err) {
      setDetectError(err instanceof Error ? err.message : String(err));
    } finally {
      pendingFocus.current = "detect";
      setDetecting(false);
    }
  }

  /** Moves row `from` to position `to`: pages of the sheet follow this order. */
  const move = (from: number, to: number): void => {
    const row = rows[from];
    const over = rows[to];
    if (!row || !over) return;
    // A box moves with what hangs under it, and only among the boxes under the same parent.
    const target = siblingFor(rows, row, over);
    if (!target) return;
    const next = moveBlock(rows, row, target, to < from);
    setRows(next);
    const dir = to < from ? -1 : 1;
    // Keep the arrow the user pressed if it still works, else the other one: the pressed one may now be disabled.
    pendingFocus.current = `${row.id}:${neighbourOf(next, row, dir) >= 0 ? (dir < 0 ? "up" : "down") : neighbourOf(next, row, dir === -1 ? 1 : -1) >= 0 ? (dir < 0 ? "down" : "up") : "name"}`;
    const siblings = next.filter((x) => parentOf(next, x) === parentOf(next, row));
    const parent = parentOf(next, row);
    announce(`${row.device.trim() || "Box"} moved to position ${siblings.indexOf(row) + 1} of ${siblings.length}${parent ? ` under ${parent.device.trim() || "its host"}` : ""}.`);
  };
  /** The sibling a row moves past when the arrow is pressed (none when it is first or last under its parent). */
  const neighbourOf = (list: BoxRow[], row: BoxRow, dir: -1 | 1): number => {
    const siblings = list.filter((x) => parentOf(list, x) === parentOf(list, row));
    const sib = siblings[siblings.indexOf(row) + dir];
    return sib ? list.indexOf(sib) : -1;
  };
  const neighbour = (i: number, dir: -1 | 1): number => neighbourOf(rows, rows[i] as BoxRow, dir);
  const plays = (r: BoxRow): boolean => !!r.via && isPersonalMixer(models, r);
  const onHub = (r: BoxRow): boolean => !!r.via && !isPersonalMixer(models, r) && rows.some((h) => h.device.trim() === r.via && isHubRow(models, h));
  const specOf = (r: BoxRow): ModelInfo | undefined => specOfRow(models, r);
  const limitOf = (group: string): number => groupLimits[group] ?? 999;
  /** LCL = the console's own local ports; CRD / MOD = an expansion card (WING-LIVE / Dante and others). */
  const GROUPS = Object.keys(groupLimits);
  const KEYS_THAT_RESIZE = ["model", "group", "first", "last", "via"] as const;
  /** Applies a change to row `i`; the range is tidied only when a field that decides it changed (not on every letter of the name). */
  const patch = (i: number, change: Partial<BoxRow>): void => {
    const old = rows[i] as BoxRow;
    const changed = { ...old, ...change };
    // A name alone can decide the model (no model typed): re-tidy when the rename changes what the box is.
    const resizes = KEYS_THAT_RESIZE.some((k) => k in change) || ("device" in change && specOfRow(models, changed)?.id !== specOfRow(models, old)?.id);
    const next = rows.map((r, j) => {
      if (j === i) return resizes ? tidyRow(models, changed) : changed;
      // Renaming a box keeps the boxes plugged into it linked to it.
      return change.device !== undefined && old.device.trim() && (counts.get(old.device.trim()) ?? 0) === 1 && r.via === old.device.trim() && change.device.trim() ? { ...r, via: change.device.trim() } : r;
    });
    // Plugging a box into another puts it right under it, on its port group.
    if ("via" in change) {
      const host = next.find((h, j) => j !== i && h.device.trim() === (change.via ?? "").trim() && change.via);
      if (host) next[i] = { ...(next[i] as BoxRow), group: host.group };
    }
    setRows("via" in change || "device" in change ? nestedOrder(next) : next);
  };

  /** Removes a box; what hung under it goes back to the console ports (after asking). */
  const removeRow = (i: number): void => {
    const row = rows[i] as BoxRow;
    const kids = rows.filter((x) => parentOf(rows, x) === row);
    if (kids.length > 0 && !window.confirm(`"${row.device || "This box"}" has ${kids.length} box${kids.length > 1 ? "es" : ""} plugged into it (${kids.map((k) => k.device || "unnamed").join(", ")}). They will go back to the console ports. Remove it?`)) return;
    const next = nestedOrder(rows.filter((x) => x !== row).map((x) => (kids.includes(x) ? { ...x, via: "" } : x)));
    setRows(next);
    // The row that takes its place gets the focus (or the "Add a box" button when none is left).
    const heir = next[Math.min(i, next.length - 1)];
    pendingFocus.current = heir ? `${heir.id}:name` : "add";
    announce(`${row.device.trim() || "Box"} removed.`);
  };

  /** The console's own ports (group LCL) are the box named "Local": choosing a console type sets its model and size, "not drawn" removes it. */
  const consoleRow = rows.find((r) => r.group === "LCL" && !r.via);
  const consoleType = consoleRow ? (specOf(consoleRow)?.id ?? "") : "";
  const chooseConsole = (id: string): void => {
    if (id === "custom") return;
    const type = CONSOLE_TYPES.find((c) => c.id === id);
    if (!type) {
      if (consoleRow) setRows(nestedOrder(rows.filter((r) => r !== consoleRow)));
      announce("The console's own ports are no longer drawn.");
      return;
    }
    if (consoleRow) {
      setRows(rows.map((r) => (r === consoleRow ? { ...r, model: type.model, first: 1, last: type.size } : r)));
    } else {
      setRows(nestedOrder([{ id: newId(), group: "LCL", first: 1, last: type.size, device: "Local", model: type.model, via: "", feedFirst: 33, feedLast: 48, feedGroup: "", feedTouched: false, outOffset: 0, splitter: false, inPdf: true }, ...rows]));
    }
    announce(`Console set to ${type.label}.`);
  };

  /** Boxes a row can be plugged into: any host for a personal mixer, a hub for the rest. */
  const hostsFor = (r: BoxRow): string[] => {
    const wantsHub = !isPersonalMixer(models, r);
    const names = rows
      .filter((h) => h !== r && h.device.trim() && !(h.via && isPersonalMixer(models, h)))
      .filter((h) => (wantsHub ? isHubRow(models, h) && !h.via : specOfRow(models, h)?.kind !== "card"))
      .map((h) => h.device.trim());
    return [...new Set(names)];
  };

  // Boxes are linked by name: a name twice, or a link to a name that is gone, would mix them up.
  const problems: { text: string; id?: number }[] = [];
  const addProblem = (text: string, row?: BoxRow): void => void problems.push({ text, id: row?.id });
  for (const r of rows) {
    let up: BoxRow | undefined = r;
    for (let n = 0; up && n <= rows.length; n++) up = parentOf(rows, up);
    if (up) addProblem(`${r.device || "A box"} is part of a loop of links: unplug one of them.`, r);
  }
  const counts = new Map<string, number>();
  for (const r of rows) if (r.device.trim()) counts.set(r.device.trim(), (counts.get(r.device.trim()) ?? 0) + 1);
  for (const r of rows) {
    const n = counts.get(r.device.trim()) ?? 0;
    if (r.device.trim() && n > 1) addProblem(`The name "${r.device.trim()}" is used by ${n} boxes: give each its own name.`, r);
  }
  for (const r of rows) if (r.via && !counts.has(r.via)) addProblem(`${r.device || "A box"} is plugged into "${r.via}", which is not in the list.`, r);
  const groupOfHost = (name: string): string | undefined => rows.find((h) => h.device.trim() === name)?.group;
  for (const r of rows) {
    if (!plays(r) || !(r.feedTouched || r.orig?.feed)) continue;
    const feedLimit = limitOf(r.feedGroup || groupOfHost(r.via) || r.group);
    if (r.feedFirst < 1 || r.feedFirst > r.feedLast || r.feedLast - r.feedFirst > 15 || r.feedLast > feedLimit)
      addProblem(`${r.device || "A mixer"}: the played ports must be an ascending range of at most 16, within the ${r.feedGroup || groupOfHost(r.via) || r.group} group's ${feedLimit} ports.`, r);
  }
  for (const r of rows) {
    if (!r.device.trim()) addProblem("A box has no name: give it one.", r);
    else if (!plays(r) && (r.first > r.last || r.last > limitOf(r.group)))
      addProblem(`${r.device}: the range ${r.first}-${r.last} must ascend and stay within the ${limitOf(r.group)} ports of group ${r.group}.`, r);
  }
  for (const r of rows) {
    const spec = specOf(r);
    if (spec?.outModes && r.outOffset && r.first + r.outOffset + 7 > limitOf(r.group))
      addProblem(`${r.device || "A box"}: with its XLR outputs following channels ${r.outOffset + 1}-${r.outOffset + 8}, they would go past port ${limitOf(r.group)} of group ${r.group}.`, r);
  }
  const invalid = problems.length > 0;
  // Two boxes on the same console ports are accepted (the server does not check) but almost surely a mistake: warn, don't block.
  const warnings: { text: string; id: number }[] = [];
  for (const r of rows) {
    if (isPersonalMixer(models, r) && !r.via.trim()) warnings.push({ text: `${r.device || "A personal mixer"} is plugged into no box: plug it into the box whose Ultranet port it uses, or it is drawn as a box of its own.`, id: r.id });
  }
  const ownPorts = rows.filter((r) => !plays(r) && specOf(r)?.size !== 0 && r.first <= r.last);
  for (let a = 0; a < ownPorts.length; a++) {
    for (let b = a + 1; b < ownPorts.length; b++) {
      const x = ownPorts[a] as BoxRow;
      const y = ownPorts[b] as BoxRow;
      if (x.group === y.group && x.first <= y.last && y.first <= x.last)
        warnings.push({ text: `${x.device || "A box"} (${x.group} ${x.first}-${x.last}) and ${y.device || "another box"} (${y.group} ${y.first}-${y.last}) share console ports.`, id: y.id });
    }
  }

  async function generate(): Promise<void> {
    setBusy(true);
    setError(undefined);
    try {
      const pdf = await apiFetchBlob(`/api/plugins/wing/io/patch.pdf?render=${render}&naming=${naming}&lang=${lang}&console=${consolePage ? 1 : 0}`);
      const url = URL.createObjectURL(pdf);
      const a = document.createElement("a");
      a.href = url;
      a.download = "patch-plateau.pdf";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      pendingFocus.current = "generate";
      setBusy(false);
    }
  }


  const addBox = (): void => {
    const id = newId();
    pendingFocus.current = `${id}:name`;
    setRows([...rows, { id, group: "A", first: 1, last: 8, device: "", model: "", via: "", feedFirst: 33, feedLast: 48, feedGroup: "", feedTouched: false, outOffset: 0, splitter: false, inPdf: true }]);
  };

  /** Back to the saved map: the only way to drop edits without reloading the page. */
  const discard = (): void => {
    if (!window.confirm("Discard the changes you have not saved?")) return;
    pendingFocus.current = "add";
    setRows(nestedOrder(fromWire(saved).map((r) => tidyRow(models, r, true))));
    setDetected(null);
    setBoxesNote(null);
  };

  const saveAll = (): void => {
    setBoxesNote(null);
    saveKeys(saveBoxes, () => ({ boxMap: toWire(models, rows) }))
      .then(() => {
        setBoxesNote({ text: "Saved." });
        setDetected(null);
        pendingFocus.current = "add";
      })
      .catch((e: unknown) => setBoxesNote({ text: e instanceof Error ? e.message : String(e), bad: true }));
  };
  const saveBlockedBy = invalid
    ? `Fix the ${problems.length === 1 ? "problem" : `${problems.length} problems`} shown on the boxes and below first.`
    : !dirty
      ? "No changes to save."
      : undefined;

  /** What the box takes on the console, as the summary at the start of its row says it. */
  const rangeText = (r: BoxRow): string => {
    if (!plays(r)) return `${r.group} ${r.first}-${r.last}`;
    if (!(r.feedTouched || r.orig?.feed)) return "default ports";
    return `${r.feedGroup || groupOfHost(r.via) || r.group} ${r.feedFirst}-${r.feedLast}`;
  };
  const nameTaken = (r: BoxRow): boolean => (counts.get(r.device.trim()) ?? 0) > 1;

  function boxSettings(r: BoxRow, i: number, label: string): JSX.Element {
    const spec = specOf(r);
    const hosts = hostsFor(r);
    return (
      <div className="patch-box__settings">
        <label className="patch-field">
          <span className="patch-field__label">Plugged into</span>
          <select value={r.via} onChange={(e) => patch(i, { via: e.target.value })} aria-label={`${label} is plugged into`}>
            <option value="">Console port</option>
            {hosts.map((h) => (
              <option key={h}>{h}</option>
            ))}
            {r.via && !hosts.includes(r.via) && <option key={r.via}>{r.via}</option>}
          </select>
        </label>
        {onHub(r) && (
          <label className="patch-field patch-field--wide">
            <span className="patch-field__label">Hub port</span>
            <select
              value={r.first >= 33 ? 5 : Math.floor((r.first - 1) / 8) + 1}
              onChange={(e) => {
                const p = Number(e.target.value);
                // 5 = the hub's StageConnect output: a StageConnect box there (DN4816U...) is A 33-48, its track 1 being A33.
                patch(i, p === 5 ? { first: 33, last: 48 } : { first: (p - 1) * 8 + 1, last: p * 8 });
              }}
              aria-label={`Hub port of ${label}`}
            >
              {[1, 2, 3, 4].map((p) => (
                <option key={p} value={p}>
                  Port {p} · {r.group} {(p - 1) * 8 + 1}-{p * 8}
                </option>
              ))}
              <option value={5}>StageConnect · {r.group} 33-48</option>
            </select>
          </label>
        )}
        <label className="patch-field">
          <span className="patch-field__label">Port group</span>
          <select value={r.group} onChange={(e) => patch(i, { group: e.target.value })} aria-label={`Port group of ${label}`}>
            {GROUPS.map((g) => (
              <option key={g}>{g}</option>
            ))}
          </select>
        </label>
        {plays(r) ? (
          <fieldset className="patch-field patch-feed">
            <legend className="patch-field__label">Plays console outputs</legend>
            {(rows ?? []).some((h) => h.device.trim() === r.via.trim() && h.splitter && specOf(h)?.outModes) && (
              <p className="card-hint">{r.via} is in splitter mode: the sheet shows its own inputs on the Ultranet output, so the ports set here are not used.</p>
            )}
            <div className="patch-feed__controls">
              <select value={r.feedGroup} onChange={(e) => patch(i, { feedGroup: e.target.value, feedTouched: true })} aria-label={`Group played by ${label}`}>
                <option value="">Host's group</option>
                {[...new Set(["A", "B", "C", "SC", ...(r.feedGroup ? [r.feedGroup] : [])])].map((g) => (
                  <option key={g}>{g}</option>
                ))}
              </select>
              <NumInput value={r.feedFirst} min={1} label={`First port played by ${label}`} onCommit={(n) => patch(i, { feedFirst: n, feedTouched: true })} />
              <span aria-hidden="true">to</span>
              <NumInput value={r.feedLast} min={1} label={`Last port played by ${label}`} onCommit={(n) => patch(i, { feedLast: n, feedTouched: true })} />
              <button
                type="button"
                className="patch-chip-button"
                onClick={() => patch(i, { feedGroup: "A", feedFirst: 33, feedLast: 48, feedTouched: true })}
                title="What a HUB4 serves on its StageConnect output"
              >
                StageConnect A 33-48
              </button>
              <button
                type="button"
                title="Forget the ports set here: the server picks them from the box it is plugged into"
                onClick={() => patch(i, { feedTouched: false, feedGroup: "", feedFirst: 33, feedLast: 48, orig: r.orig ? { ...r.orig, feed: undefined } : undefined })}
              >
                Default
              </button>
            </div>
          </fieldset>
        ) : (
          <>
            <label className="patch-field">
              <span className="patch-field__label">First port</span>
              <NumInput
                min={1}
                max={limitOf(r.group)}
                value={r.first}
                disabled={spec?.fixedStart !== undefined}
                label={`First port of ${label}`}
                title={spec?.fixedStart !== undefined ? `A ${spec.label} always starts at ${spec.fixedStart}` : undefined}
                onCommit={(n) => patch(i, { first: n })}
              />
            </label>
            <label className="patch-field">
              <span className="patch-field__label">Channels</span>
              <NumInput
                min={1}
                max={Math.min(limitOf(r.group), 64)}
                value={r.last - r.first + 1}
                disabled={(spec?.size ?? 0) > 0}
                label={`Number of channels of ${label}`}
                title={spec && spec.size > 0 ? `A ${spec.label} has ${spec.size} channels` : `Up to ${limitOf(r.group)} on ${r.group}`}
                onCommit={(n) => patch(i, { last: r.first + Math.max(1, n) - 1 })}
              />
            </label>
          </>
        )}
        <label className="patch-check" style={{ alignSelf: "end", paddingBottom: "0.45rem" }} title="Untick to keep this box in the map but leave its page out of the PDF">
          <input type="checkbox" checked={r.inPdf} onChange={(e) => patch(i, { inPdf: e.target.checked })} aria-label={`${label}: include in the PDF`} />
          <span>In the PDF</span>
        </label>
        {r.orig?.localPorts && (
          <div className="patch-field">
            <span className="patch-field__label">Local port numbers</span>
            <div className="patch-feed__controls">
              <span>
                {r.orig.localPorts[0]}-{r.orig.localPorts[1]}
              </span>
              <button type="button" title="Number this box's own ports from 1 again" onClick={() => patch(i, { orig: { ...r.orig, localPorts: undefined } as WireBox })}>
                Clear
              </button>
            </div>
          </div>
        )}
        {spec?.outModes && (
          <div className="patch-field">
            <span className="patch-field__label">Outputs</span>
            <div className="patch-feed__controls">
              <select value={r.outOffset} onChange={(e) => patch(i, { outOffset: Number(e.target.value) as 0 | 8 | 16 })} aria-label={`XLR outputs of ${label}`}>
                <option value={0}>XLR out = ch 1-8</option>
                <option value={8}>XLR out = ch 9-16</option>
                <option value={16}>XLR out = ch 17-24</option>
              </select>
              <label className="patch-check" title="The Ultranet output carries the box's own inputs instead of console outputs">
                <input type="checkbox" checked={r.splitter} onChange={(e) => patch(i, { splitter: e.target.checked })} aria-label={`${label}: Ultranet carries its own inputs (splitter)`} />
                <span>Splitter</span>
              </label>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <>
      <section className="card">
        <h3>Patch sheet (PDF)</h3>
        <p className="card-hint patch-lead">
          Reads the live patch and the box map below, and builds an overview page, a page of the console's ports, then one page per box.
          {dirty ? " The boxes below have unsaved changes: the sheet uses the saved ones." : ""}
        </p>
        <div className="patch-toolbar">
          <label className="patch-field">
            <span className="patch-field__label">Layout</span>
            <select value={render} onChange={(e) => setRender(e.target.value as typeof render)}>
              <option value="visual">Visual (drawn fronts, colours)</option>
              <option value="table">Tables only</option>
            </select>
          </label>
          <label className="patch-field">
            <span className="patch-field__label">Names</span>
            <select value={naming} onChange={(e) => setNaming(e.target.value as typeof naming)}>
              <option value="io">Input / output name</option>
              <option value="channel">Channel name first</option>
              <option value="full">Input + channel + output</option>
            </select>
          </label>
          <label className="patch-field">
            <span className="patch-field__label">Language</span>
            <select value={lang} onChange={(e) => setLang(e.target.value as typeof lang)}>
              <option value="fr">Français</option>
              <option value="en">English</option>
            </select>
          </label>
          <label className="patch-check" title="The page listing the console's own ports and what is plugged into them">
            <input type="checkbox" checked={consolePage} onChange={(e) => chooseConsolePage(e.target.checked)} aria-label="Include the console's ports page in the PDF" />
            <span>Console ports page</span>
          </label>
          <button type="button" className="button--primary patch-toolbar__end" data-focus="generate" onClick={() => void generate()} disabled={busy}>
            {busy ? "Generating..." : dirty ? "Generate PDF (saved boxes)" : "Generate PDF"}
          </button>
        </div>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </section>

      <section className="card" aria-labelledby="patch-boxes-title">
        <div className="mixer-processing-card__header">
          <h3 id="patch-boxes-title">Stage boxes</h3>
          {dirty ? (
            <span className="status-pill status-pill--warn" role="status">
              <span className="status-pill__dot" />
              Unsaved changes
            </span>
          ) : boxesNote && !boxesNote.bad ? (
            <span className="status-pill status-pill--ok" role="status">
              <span className="status-pill__dot" />
              {boxesNote.text}
            </span>
          ) : null}
        </div>
        <p className="card-hint patch-lead">Which box sits on which console ports. The order below is the order of the box pages in the PDF (boxes of one port group stay together).</p>
        <details className="patch-help">
          <summary>Hubs, personal mixers and box options</summary>
          <ul>
            <li>Reorder with the handle (drag) or the ↑ ↓ buttons.</li>
            <li>
              <strong>Hub</strong>: a box can sit under a HUB4 — a DL8 on a hub port, or any StageConnect box on its StageConnect output (= A 33-48; the hub's own back-panel outputs are those same 33-48).
            </li>
            <li>
              <strong>Personal mixer</strong> (P16-M): plug it into the Ultranet port of another box, then pick the console outputs it plays. Default: 33-48 on a DL16, DL32, S16, S32, X32 or HUB4; the
              first 16 ports on a DN4816U.
            </li>
            <li>
              <strong>DL16 / S16</strong>: choose which channels the XLR outputs follow; <em>Splitter</em> means the Ultranet output carries the box's own inputs.
            </li>
          </ul>
        </details>
        {modelsError && <p className="card-hint">The list of known models could not be read: ranges are not sized or limited here, but the server still refuses a wrong one.</p>}

        <div className="patch-actions">
          <button type="button" data-focus="add" onClick={addBox}>
            Add a box
          </button>
          <button type="button" data-focus="detect" onClick={() => void detect()} disabled={detecting}>
            {detecting ? "Detecting..." : "Detect from console"}
          </button>
          <span className="patch-actions__end">
            {saveBlockedBy && !saveBoxes.isPending && (
              <span className="patch-actions__why" id="patch-save-why">
                {saveBlockedBy}
              </span>
            )}
            <button type="button" className="button--primary" disabled={invalid || saveBoxes.isPending || savePreset.isPending || !dirty} onClick={saveAll} aria-describedby={saveBlockedBy ? "patch-save-why" : undefined}>
              {saveBoxes.isPending ? "Saving..." : "Save boxes"}
            </button>
            {dirty && (
              <button type="button" onClick={discard} disabled={saveBoxes.isPending}>
                Discard changes
              </button>
            )}
          </span>
        </div>
        {detectError && (
          <p className="error" role="alert">
            {detectError}
          </p>
        )}
        {detected && (
          <div className="patch-detected" role="status">
            <p>Console model: {detected.consoleModel || "unknown"}. Box list replaced below: check it, then press Save boxes.</p>
            {detected.notes.length > 0 && (
              <ul>
                {detected.notes.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        <div className="patch-root">
          <div>
            <strong>Console (WING)</strong>
            <span className="patch-root__hint"> root of the tree: every box below hangs off its ports</span>
          </div>
          <label className="patch-field patch-root__model" title="The back panel differs between the three consoles: the sheet draws the one chosen here">
            <span className="patch-field__label">Console model</span>
            <select value={consoleRow ? consoleType || "custom" : ""} onChange={(e) => chooseConsole(e.target.value)} aria-label="Console model (its back panel is drawn on the sheet)">
              <option value="">Not drawn</option>
              {CONSOLE_TYPES.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
              {consoleRow && !consoleType && (
                <option value="custom" disabled>
                  Other ({consoleRow.model || consoleRow.device})
                </option>
              )}
            </select>
          </label>
          <label className="patch-check" title="The page listing the console's own ports and what is plugged into them">
            <input type="checkbox" checked={consolePage} onChange={(e) => chooseConsolePage(e.target.checked)} aria-label="Include the console's ports page in the PDF" />
            <span>Console ports page in the PDF</span>
          </label>
        </div>

        <div className="visually-hidden" aria-live="polite" role="status">
          <span key={announcement.n}>{announcement.text}</span>
        </div>
        {rows.length === 0 ? (
          <p className="patch-empty">No boxes yet. Add one, or detect them from the console.</p>
        ) : (
          <ol className="patch-boxes" aria-label="Stage boxes, in sheet order">
            {rows.map((r, i) => {
              const label = r.device.trim() || `box ${i + 1}`;
              const spec = specOf(r);
              let depth = 0;
              for (let up = parentOf(rows, r); up && depth < 6; up = parentOf(rows, up)) depth++;
              const child = depth > 0;
              const classes = ["patch-box"];
              if (child) classes.push("patch-box--child");
              if (dragFrom === i) classes.push("patch-box--dragging");
              if (dragOver === i && dragFrom !== null && dragFrom !== i) classes.push("patch-box--drop");
              return (
                <li
                  key={r.id}
                  className={classes.join(" ")}
                  style={depth > 0 ? ({ "--depth": depth } as CSSProperties) : undefined}
                  aria-label={label}
                  aria-describedby={problems.some((x) => x.id === r.id) ? `patch-err-${r.id}` : undefined}
                  onDragOver={(e) => {
                    const dragged = dragFrom === null ? undefined : rows[dragFrom];
                    // Only a target the row can really move to (same parent) takes the drop.
                    if (!dragged || !siblingFor(rows, dragged, r)) {
                      if (dragOver === i) setDragOver(null);
                      return;
                    }
                    e.preventDefault();
                    setDragOver(i);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (dragFrom !== null) move(dragFrom, i);
                    setDragFrom(null);
                    setDragOver(null);
                  }}
                >
                  <div className="patch-box__main">
                    <div className="patch-box__move">
                      <span
                        className="patch-box__handle"
                        draggable
                        title="Drag to reorder"
                        aria-hidden="true"
                        onDragStart={(e) => {
                          // Firefox starts no drag without data.
                          e.dataTransfer.setData("text/plain", String(i));
                          e.dataTransfer.effectAllowed = "move";
                          setDragFrom(i);
                        }}
                        onDragEnd={() => {
                          setDragFrom(null);
                          setDragOver(null);
                        }}
                      >
                        ⠿
                      </span>
                      <button type="button" className="patch-icon-button" data-focus={`${r.id}:up`} onClick={() => move(i, neighbour(i, -1))} disabled={neighbour(i, -1) < 0} aria-label={`Move ${label} up`} title="Move up">
                        ↑
                      </button>
                      <button type="button" className="patch-icon-button" data-focus={`${r.id}:down`} onClick={() => move(i, neighbour(i, 1))} disabled={neighbour(i, 1) < 0} aria-label={`Move ${label} down`} title="Move down">
                        ↓
                      </button>
                    </div>
                    <span className={plays(r) ? "patch-range patch-range--plays" : "patch-range"} title={plays(r) ? `Plays these console outputs through ${r.via}` : "Console ports this box takes"}>
                      {plays(r) && <span className="patch-range__kind">plays</span>}
                      {rangeText(r)}
                    </span>
                    <label className="patch-field patch-box__name">
                      <span className="patch-field__label">Name</span>
                      <DraftText value={r.device} onCommit={(v) => patch(i, { device: v })} label={`Name of ${label}`} invalid={!r.device.trim() || nameTaken(r)} placeholder="e.g. Stage left" focusKey={`${r.id}:name`} describedBy={problems.some((x) => x.id === r.id) ? `patch-err-${r.id}` : undefined} />
                    </label>
                    <label className="patch-field patch-box__model">
                      <span className="patch-field__label">
                        Model{spec && spec.label !== r.model.trim() ? <span className="patch-field__note"> · {spec.label}</span> : null}
                      </span>
                      <input list="patch-models" value={r.model} onChange={(e) => patch(i, { model: e.target.value })} aria-label={`Model of ${label}`} placeholder="e.g. Midas DL16" />
                    </label>
                    <button type="button" className="patch-remove" onClick={() => removeRow(i)} aria-label={`Remove ${label}`} title="Remove this box">
                      Remove
                    </button>
                  </div>
                  {boxSettings(r, i, label)}
                  {warnings.some((w) => w.id === r.id) && (
                    <ul className="card-hint patch-row-warnings">
                      {warnings.filter((w) => w.id === r.id).map((w, k) => (
                        <li key={k}>Warning: {w.text}</li>
                      ))}
                    </ul>
                  )}
                  {problems.some((x) => x.id === r.id) && (
                    <ul className="error patch-row-problems" role="status" id={`patch-err-${r.id}`}>
                      {problems.filter((x) => x.id === r.id).map((x, k) => (
                        <li key={k}>{x.text}</li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ol>
        )}
        <datalist id="patch-models">
          {[...new Set([...MODELS, ...models.map((m) => m.label)])].map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
        {problems.some((x) => x.id === undefined) && (
          <ul className="error patch-problems" role="status">
            {problems.filter((x) => x.id === undefined).map((p, i) => (
              <li key={i}>{p.text}</li>
            ))}
          </ul>
        )}
        {boxesNote?.bad && (
          <p className="error" role="alert">
            {boxesNote.text}
          </p>
        )}

        <div className="patch-presets" role="group" aria-labelledby="patch-presets-title">
          <h4 id="patch-presets-title" className="patch-presets__title">
            Presets
          </h4>
          <div className="patch-presets__row">
            <select value={picked} data-focus="preset-select" onChange={(e) => setPicked(e.target.value)} aria-label="Saved presets">
              <option value="">{presetNames.length === 0 ? "No preset saved" : "Choose a preset"}</option>
              {presetNames.map((n) => (
                <option key={n}>{n}</option>
              ))}
            </select>
            <button
              type="button"
              disabled={!picked}
              onClick={() => {
                const preset = presets[picked];
                if (!preset) {
                  setPresetNote({ text: `"${picked}" no longer exists (deleted elsewhere).`, bad: true });
                  return;
                }
                if (!confirmReplace()) return;
                setRows(nestedOrder(fromWire(preset).map((r) => tidyRow(models, r, true))));
                setPresetName(picked);
                setDetected(null);
                setPresetNote({ text: `Loaded "${picked}". Press Save boxes to make it the active map.` });
              }}
            >
              Load
            </button>
            <button
              type="button"
              disabled={!picked || savePreset.isPending || saveBoxes.isPending}
              onClick={() => {
                if (!window.confirm(`Delete the preset "${picked}"? This cannot be undone.`)) return;
                const name = picked;
                saveKeys(savePreset, (c) => ({ boxPresets: Object.fromEntries(Object.entries(freshPresets(c)).filter(([n]) => n !== name)) }))
                  .then(() => {
                    setPresetNote({ text: `Deleted "${name}".` });
                    setPicked("");
                    pendingFocus.current = "preset-select";
                  })
                  .catch((e: unknown) => setPresetNote({ text: `Could not delete "${name}": ${e instanceof Error ? e.message : String(e)}`, bad: true }));
              }}
            >
              Delete
            </button>
          </div>
          <div className="patch-presets__row">
            <input placeholder="Name this setup" value={presetName} onChange={(e) => setPresetName(e.target.value)} maxLength={60} aria-label="Preset name" />
            <button
              type="button"
              disabled={savePreset.isPending || saveBoxes.isPending}
              onClick={() => {
                const name = presetName.trim();
                if (!name) {
                  setPresetNote({ text: "Give the setup a name first.", bad: true });
                  return;
                }
                if (invalid) {
                  setPresetNote({ text: "Fix the boxes first: see the problems listed above.", bad: true });
                  return;
                }
                if (presets[name] && !window.confirm(`A preset called "${name}" exists. Replace it?`)) return;
                saveKeys(savePreset, (c) => ({ boxPresets: { ...freshPresets(c), [name]: toWire(models, rows) } }))
                  .then(() => {
                    setPicked(name);
                    setPresetNote({ text: `Saved the ${rows.length} boxes as "${name}".` });
                  })
                  .catch((e: unknown) => setPresetNote({ text: `Could not save "${name}": ${e instanceof Error ? e.message : String(e)}`, bad: true }));
              }}
            >
              {savePreset.isPending ? "Saving..." : "Save as preset"}
            </button>
          </div>
          {presetNote && (
            <p className={presetNote.bad ? "error patch-presets__note" : "card-hint patch-presets__note"} role={presetNote.bad ? "alert" : "status"}>
              {presetNote.text}
            </p>
          )}
        </div>
      </section>

      <section className="card">
        <h3>Console links</h3>
        <p className="card-hint patch-lead">
          The devices the console reports on its AES50 / StageConnect links (also on the Config tab). <em>Detect from console</em> above builds the box list from them. Expansion cards (WING-LIVE, Dante
          and others) are not reported: add them as a box on group CRD (WING-LIVE) or MOD.
        </p>
        {links.isLoading && <p role="status">Reading the links...</p>}
        {links.isError && <p className="error">Could not read the links: {(links.error as Error).message}</p>}
        <ul className="scene-list">
          {links.data?.ports.map((p) => (
            <li key={p.port} className="scene-list__item">
              <span>
                <strong>AES50 {p.port}</strong> {p.state.trim() && p.state.trim() !== "-" ? p.state : "no link"} {p.device}
                {p.remoteName ? ` → "${p.remoteName}"` : ""}
              </span>
            </li>
          ))}
          {links.data?.stageConnect.devices ? (
            <li className="scene-list__item">
              <span>
                <strong>StageConnect</strong> {links.data.stageConnect.devices}
              </span>
            </li>
          ) : null}
        </ul>
      </section>
    </>
  );
}
