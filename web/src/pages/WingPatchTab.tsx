import { useEffect, useRef, useState, type JSX } from "react";
import { apiFetch } from "../api/client.js";
import { useLinkStatus, usePluginConfig, useUpdateConfig, type PluginConfig } from "../api/queries.js";
import { clearToken, getToken } from "../auth/token-store.js";

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

/** Ports per console group: a range may not go beyond (the server refuses it too). */
const GROUP_LIMIT: Record<string, number> = { A: 48, B: 48, C: 48, SC: 32, LCL: 24, CRD: 64, MOD: 64 };

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
/** LCL = the console's own local ports; CRD / MOD = an expansion card (WING-LIVE / Dante and others). */
const GROUPS = ["A", "B", "C", "SC", "LCL", "CRD", "MOD"];

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

function specOfRow(models: ModelInfo[], r: Pick<BoxRow, "model" | "device">): ModelInfo | undefined {
  const test = (text: string): ModelInfo | undefined =>
    text
      ? models.find((m) => {
          try {
            return new RegExp(m.match.source, m.match.flags).test(text);
          } catch {
            return false;
          }
        })
      : undefined;
  // The model decides; the name only when the model matches nothing (as on the server).
  return test(r.model) ?? test(r.device);
}

function isPersonalMixer(models: ModelInfo[], r: BoxRow): boolean {
  const spec = specOfRow(models, r);
  return spec ? spec.kind === "personal-mixer" : /P-?16/i.test(`${r.model} ${r.device}`);
}

function isHubRow(models: ModelInfo[], r: BoxRow): boolean {
  const spec = specOfRow(models, r);
  return spec ? spec.kind === "hub" : /HUB-?4/i.test(`${r.model} ${r.device}`);
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
    delete box.via;
    delete box.hub;
    delete box.feed;
    delete box.outOffset;
    delete box.splitter;
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
  const limit = GROUP_LIMIT[r.group] ?? 999;
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
      if (draft.trim() !== "" && Number.isFinite(n) && n !== props.value) props.onCommit(n);
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
      style={{ width: "4em" }}
    />
  );
}

/** Patch sheet: the stage-box map that labels the patch, and the PDF generator. */
export function WingPatchTab(): JSX.Element {
  const config = usePluginConfig("wing");
  const saveBoxes = useUpdateConfig("wing");
  const savePreset = useUpdateConfig("wing");
  const [rows, setRows] = useState<BoxRow[] | null>(null);
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
  const [modelsError, setModelsError] = useState(false);
  const [tidied, setTidied] = useState(false);
  const loadedKey = useRef<string | null>(null);

  const saved = (config.data?.config as { boxMap?: WireMap } | undefined)?.boxMap;
  const savedKey = stable(saved ?? {});
  const orderOf = (m: WireMap | undefined): string => Object.keys(m ?? {}).join(",");
  const dirty = rows !== null && (stable(toWire(models, rows)) !== savedKey || orderOf(toWire(models, rows)) !== orderOf(saved));

  useEffect(() => {
    apiFetch<{ models: ModelInfo[] }>("/api/plugins/wing/io/boxmap/models")
      .then((r) => setModels(r.models))
      .catch(() => setModelsError(true));
  }, []);

  // Rows start from the saved map, and follow it when it changes elsewhere (another tab, an MCP tool)
  // as long as nothing here is being edited.
  // (Hooks stay above the early returns below: their number must not change between renders.)
  useEffect(() => {
    if (!config.data) return;
    if (rows === null || (!dirty && loadedKey.current !== null && loadedKey.current !== savedKey)) {
      loadedKey.current = savedKey;
      setRows(fromWire(saved));
      setTidied(false);
    } else if (loadedKey.current === null) {
      loadedKey.current = savedKey;
    }
  }, [config.data, savedKey, rows, dirty, saved]);

  // Once the catalogue is here, bring the saved rows within what their models and groups allow.
  useEffect(() => {
    if (models.length > 0 && rows !== null && !tidied) {
      setTidied(true);
      setRows(rows.map((r) => tidyRow(models, r, true)));
    }
  }, [models, rows, tidied]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent): void => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  if (config.isError) return <p className="error">Could not read the configuration: {(config.error as Error).message}</p>;
  if (config.isLoading || rows === null) return <p>Loading patch...</p>;

  const presets = (config.data?.config as { boxPresets?: Record<string, WireMap> } | undefined)?.boxPresets ?? {};
  const presetNames = Object.keys(presets).sort();

  /**
   * The config PUT replaces the whole file: read it again just before, and put back only the keys this
   * tab owns, so a change made elsewhere since the page opened is not undone.
   */
  async function saveKeys(mutation: typeof saveBoxes, extra: (fresh: Record<string, unknown>) => Record<string, unknown>): Promise<void> {
    const fresh = await apiFetch<PluginConfig>("/api/plugins/wing/config");
    const current = fresh.config as Record<string, unknown>;
    await mutation.mutateAsync({ ...current, ...extra(current) });
  }
  const freshPresets = (c: Record<string, unknown>): Record<string, WireMap> => (c.boxPresets as Record<string, WireMap> | undefined) ?? {};

  const confirmReplace = (): boolean => !dirty || window.confirm("Replace the boxes you changed and have not saved?");

  async function detect(): Promise<void> {
    setDetectError(undefined);
    if (!confirmReplace()) return;
    try {
      const d = await apiFetch<{ consoleModel: string; boxMap: WireMap; notes: string[] }>("/api/plugins/wing/io/boxmap/detect");
      setRows(fromWire(d.boxMap).map((r) => tidyRow(models, r, true)));
      setDetected({ consoleModel: d.consoleModel, notes: d.notes });
    } catch (err) {
      setDetectError(err instanceof Error ? err.message : String(err));
    }
  }

  /** Moves row `from` to position `to`: pages of the sheet follow this order. */
  const move = (from: number, to: number): void => {
    if (to < 0 || to >= rows.length || from === to) return;
    const next = [...rows];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item as BoxRow);
    setRows(next);
  };
  const plays = (r: BoxRow): boolean => !!r.via && isPersonalMixer(models, r);
  const onHub = (r: BoxRow): boolean => !!r.via && !isPersonalMixer(models, r) && rows.some((h) => h.device.trim() === r.via && isHubRow(models, h));
  const specOf = (r: BoxRow): ModelInfo | undefined => specOfRow(models, r);
  const limitOf = (group: string): number => GROUP_LIMIT[group] ?? 999;
  const KEYS_THAT_RESIZE = ["model", "group", "first", "last", "via"] as const;
  /** Applies a change to row `i`; the range is tidied only when a field that decides it changed (not on every letter of the name). */
  const patch = (i: number, change: Partial<BoxRow>): void => {
    const old = rows[i] as BoxRow;
    const resizes = KEYS_THAT_RESIZE.some((k) => k in change);
    const changed = { ...old, ...change };
    setRows(
      rows.map((r, j) => {
        if (j === i) return resizes ? tidyRow(models, changed) : changed;
        // Renaming a box keeps the boxes plugged into it linked to it.
        return change.device !== undefined && old.device.trim() && r.via === old.device.trim() && change.device.trim() ? { ...r, via: change.device.trim() } : r;
      }),
    );
  };

  /** Boxes a row can be plugged into: any host for a personal mixer, a hub for the rest. */
  const hostsFor = (r: BoxRow): string[] => {
    const wantsHub = !isPersonalMixer(models, r);
    const names = rows
      .filter((h) => h !== r && h.device.trim() && !(h.via && isPersonalMixer(models, h)))
      .filter((h) => (wantsHub ? isHubRow(models, h) : specOfRow(models, h)?.kind !== "card"))
      .map((h) => h.device.trim());
    return [...new Set(names)];
  };

  // Boxes are linked by name: a name twice, or a link to a name that is gone, would mix them up.
  const problems: string[] = [];
  const counts = new Map<string, number>();
  for (const r of rows) if (r.device.trim()) counts.set(r.device.trim(), (counts.get(r.device.trim()) ?? 0) + 1);
  for (const [name, n] of counts) if (n > 1) problems.push(`The name "${name}" is used by ${n} boxes: give each its own name.`);
  for (const r of rows) if (r.via && !counts.has(r.via)) problems.push(`${r.device || "A box"} is plugged into "${r.via}", which is not in the list.`);
  const groupOfHost = (name: string): string | undefined => rows.find((h) => h.device.trim() === name)?.group;
  for (const r of rows) {
    if (!plays(r) || !(r.feedTouched || r.orig?.feed)) continue;
    const feedLimit = limitOf(r.feedGroup || groupOfHost(r.via) || r.group);
    if (r.feedFirst < 1 || r.feedFirst > r.feedLast || r.feedLast - r.feedFirst > 15 || r.feedLast > feedLimit)
      problems.push(`${r.device || "A mixer"}: the played ports must be an ascending range of at most 16, within the ${r.feedGroup || groupOfHost(r.via) || r.group} group's ${feedLimit} ports.`);
  }
  for (const r of rows) {
    if (!r.device.trim()) problems.push("A box has no name: give it one.");
    else if (!plays(r) && (r.first > r.last || r.last > limitOf(r.group)))
      problems.push(`${r.device}: the range ${r.first}-${r.last} must ascend and stay within the ${limitOf(r.group)} ports of group ${r.group}.`);
  }
  for (const r of rows) {
    const spec = specOf(r);
    if (spec?.outModes && r.outOffset && r.first + r.outOffset + 7 > limitOf(r.group))
      problems.push(`${r.device || "A box"}: with its XLR outputs following channels ${r.outOffset + 1}-${r.outOffset + 8}, they would go past port ${limitOf(r.group)} of group ${r.group}.`);
  }
  const invalid = problems.length > 0;

  async function generate(): Promise<void> {
    setBusy(true);
    setError(undefined);
    try {
      const res = await fetch(`/api/plugins/wing/io/patch.pdf?render=${render}&naming=${naming}&lang=${lang}`, { headers: { Authorization: "Bearer " + (getToken() ?? "") } });
      if (res.status === 401) clearToken();
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? res.statusText);
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = "patch-plateau.pdf";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const toolbarStyle = { display: "flex", flexWrap: "wrap", gap: "0.5rem", alignItems: "center" } as const;

  return (
    <>
      <section className="card">
        <h3>Patch sheet (PDF)</h3>
        <p className="card-hint">
          Reads the live patch and the box map below, and builds an overview page, a page of the console's ports, then one page per box.
          {dirty ? " The boxes below have unsaved changes: the sheet uses the saved ones." : ""}
        </p>
        <div style={toolbarStyle}>
          <label>
            Layout{" "}
            <select value={render} onChange={(e) => setRender(e.target.value as typeof render)}>
              <option value="visual">Visual (drawn fronts, colours)</option>
              <option value="table">Tables only</option>
            </select>
          </label>
          <label>
            Names{" "}
            <select value={naming} onChange={(e) => setNaming(e.target.value as typeof naming)}>
              <option value="io">Input / output name</option>
              <option value="channel">Channel name first</option>
              <option value="full">Input + channel + output</option>
            </select>
          </label>
          <label>
            Language{" "}
            <select value={lang} onChange={(e) => setLang(e.target.value as typeof lang)}>
              <option value="fr">Français</option>
              <option value="en">English</option>
            </select>
          </label>
          <button className="mixer-refresh" onClick={() => void generate()} disabled={busy}>
            {busy ? "Generating..." : "Generate PDF"}
          </button>
        </div>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </section>

      <section className="card">
        <h3>Stage boxes</h3>
        <p className="card-hint">
          Which box sits on which AES50 / StageConnect ports. Drag a row by its handle (or use the arrows) to reorder: the pages of the sheet follow this order, boxes of the same port group staying
          together. A box can sit under a hub (a DL8 on a HUB4 port, or any StageConnect box on its StageConnect output = A 33-48; the hub's own back-panel outputs are those same 33-48). A personal
          mixer (P16-M) is plugged into the Ultranet port of another box: pick that box and the console output ports it plays (default: 33-48 on a DL16, DL32, S16, S32, X32 or HUB4; the first 16 ports on a
          DN4816U).
        </p>
        {modelsError && <p className="card-hint">The list of known models could not be read: ranges are not sized or limited here, but the server still refuses a wrong one.</p>}
        <div style={toolbarStyle} role="group" aria-label="Presets">
          <strong>Preset</strong>
          <select value={picked} onChange={(e) => setPicked(e.target.value)} aria-label="Saved presets">
            <option value="">- {presetNames.length === 0 ? "none saved" : "choose"} -</option>
            {presetNames.map((n) => (
              <option key={n}>{n}</option>
            ))}
          </select>
          <button
            disabled={!picked}
            onClick={() => {
              const preset = presets[picked];
              if (!preset) {
                setPresetNote({ text: `"${picked}" no longer exists (deleted elsewhere).`, bad: true });
                return;
              }
              if (!confirmReplace()) return;
              setRows(fromWire(preset).map((r) => tidyRow(models, r, true)));
              setPresetName(picked);
              setPresetNote({ text: `Loaded "${picked}". Press Save boxes to make it the active map.` });
            }}
          >
            Load
          </button>
          <button
            disabled={!picked || savePreset.isPending}
            onClick={() => {
              if (!window.confirm(`Delete the preset "${picked}"? This cannot be undone.`)) return;
              const name = picked;
              saveKeys(savePreset, (c) => ({ boxPresets: Object.fromEntries(Object.entries(freshPresets(c)).filter(([n]) => n !== name)) }))
                .then(() => {
                  setPresetNote({ text: `Deleted "${name}".` });
                  setPicked("");
                })
                .catch((e: unknown) => setPresetNote({ text: `Could not delete "${name}": ${e instanceof Error ? e.message : String(e)}`, bad: true }));
            }}
          >
            Delete
          </button>
          <input placeholder="Name this setup" value={presetName} onChange={(e) => setPresetName(e.target.value)} maxLength={60} aria-label="Preset name" />
          <button
            disabled={savePreset.isPending}
            onClick={() => {
              const name = presetName.trim();
              if (!name) {
                setPresetNote({ text: "Give the setup a name first.", bad: true });
                return;
              }
              if (invalid) {
                setPresetNote({ text: "Fix the boxes first: see the problems under the table.", bad: true });
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
          <p className={presetNote.bad ? "error" : "card-hint"} role={presetNote.bad ? "alert" : "status"}>
            {presetNote.text}
          </p>
        )}
        <div className="table-scroll">
          <table className="plugin-table">
            <thead>
              <tr>
                <th>
                  <span className="visually-hidden">Move</span>
                </th>
                <th>Port</th>
                <th>From</th>
                <th>Channels</th>
                <th>To</th>
                <th>Name</th>
                <th>Model</th>
                <th>Plugged into (hub / host)</th>
                <th>Plays ports</th>
                <th>Box options</th>
                <th>
                  <span className="visually-hidden">Remove</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const label = r.device.trim() || `box ${i + 1}`;
                return (
                  <tr
                    key={r.id}
                    onDragOver={(e) => {
                      if (dragFrom === null) return;
                      e.preventDefault();
                      setDragOver(i);
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      if (dragFrom !== null) move(dragFrom, i);
                      setDragFrom(null);
                      setDragOver(null);
                    }}
                    style={{ opacity: dragFrom === i ? 0.5 : 1, outline: dragOver === i && dragFrom !== null && dragFrom !== i ? "2px solid var(--accent, #2d9cdb)" : undefined }}
                  >
                    <td style={{ whiteSpace: "nowrap" }}>
                      <span
                        draggable
                        title="Drag to reorder"
                        aria-hidden="true"
                        style={{ cursor: "grab", padding: "0 0.25rem" }}
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
                      <button type="button" onClick={() => move(i, i - 1)} disabled={i === 0} aria-label={`Move ${label} up`}>
                        ↑
                      </button>
                      <button type="button" onClick={() => move(i, i + 1)} disabled={i === rows.length - 1} aria-label={`Move ${label} down`}>
                        ↓
                      </button>
                    </td>
                    <td>
                      <select value={r.group} onChange={(e) => patch(i, { group: e.target.value })} aria-label={`Port group of ${label}`}>
                        {GROUPS.map((g) => (
                          <option key={g}>{g}</option>
                        ))}
                      </select>
                    </td>
                    {plays(r) ? (
                      <td colSpan={3} style={{ opacity: 0.6 }}>
                        plays the ports on the right
                      </td>
                    ) : (
                      <>
                        <td>
                          <NumInput
                            min={1}
                            max={limitOf(r.group)}
                            value={r.first}
                            disabled={specOf(r)?.fixedStart !== undefined}
                            label={`First port of ${label}`}
                            title={specOf(r)?.fixedStart !== undefined ? `A ${specOf(r)?.label} always starts at ${specOf(r)?.fixedStart}` : undefined}
                            onCommit={(n) => patch(i, { first: n })}
                          />
                        </td>
                        <td>
                          <NumInput
                            min={1}
                            max={Math.min(limitOf(r.group), 64)}
                            value={r.last - r.first + 1}
                            disabled={(specOf(r)?.size ?? 0) > 0}
                            label={`Number of channels of ${label}`}
                            title={(specOf(r)?.size ?? 0) > 0 ? `A ${specOf(r)?.label} has ${specOf(r)?.size} channels` : `Up to ${limitOf(r.group)} on ${r.group}`}
                            onCommit={(n) => patch(i, { last: r.first + Math.max(1, n) - 1 })}
                          />
                        </td>
                        <td style={{ whiteSpace: "nowrap" }}>
                          {r.group} {r.first}-{r.last}
                        </td>
                      </>
                    )}
                    <td>
                      <input value={r.device} onChange={(e) => patch(i, { device: e.target.value })} aria-label={`Name of ${label}`} style={{ width: "9em" }} />
                    </td>
                    <td>
                      <input list="patch-models" value={r.model} onChange={(e) => patch(i, { model: e.target.value })} aria-label={`Model of ${label}`} style={{ width: "12em" }} />
                    </td>
                    <td>
                      <select value={r.via} onChange={(e) => patch(i, { via: e.target.value })} aria-label={`${label} is plugged into`}>
                        <option value="">- console port -</option>
                        {hostsFor(r).map((h) => (
                          <option key={h}>{h}</option>
                        ))}
                        {r.via && !hostsFor(r).includes(r.via) && <option key={r.via}>{r.via}</option>}
                      </select>
                    </td>
                    <td>
                      {plays(r) ? (
                        <>
                          <select
                            value={r.feedGroup}
                            onChange={(e) => patch(i, { feedGroup: e.target.value, feedTouched: true })}
                            aria-label={`Group played by ${label}`}
                          >
                            <option value="">host's group</option>
                            {["A", "B", "C", "SC"].map((g) => (
                              <option key={g}>{g}</option>
                            ))}
                          </select>{" "}
                          <input
                            type="number"
                            min={1}
                            value={r.feedFirst}
                            aria-label={`First port played by ${label}`}
                            onChange={(e) => patch(i, { feedFirst: Number(e.target.value), feedTouched: true })}
                            style={{ width: "4em" }}
                          />{" "}
                          to{" "}
                          <input
                            type="number"
                            min={1}
                            value={r.feedLast}
                            aria-label={`Last port played by ${label}`}
                            onChange={(e) => patch(i, { feedLast: Number(e.target.value), feedTouched: true })}
                            style={{ width: "4em" }}
                          />{" "}
                          <button type="button" onClick={() => patch(i, { feedGroup: "A", feedFirst: 33, feedLast: 48, feedTouched: true })} title="What a HUB4 serves on its StageConnect output">
                            StageConnect 33-48
                          </button>
                        </>
                      ) : onHub(r) ? (
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
                              Hub port {p} (A {(p - 1) * 8 + 1}-{p * 8})
                            </option>
                          ))}
                          <option value={5}>Hub StageConnect (A 33-48)</option>
                        </select>
                      ) : (
                        "-"
                      )}
                    </td>
                    <td>
                      {specOf(r)?.outModes ? (
                        <>
                          <select value={r.outOffset} onChange={(e) => patch(i, { outOffset: Number(e.target.value) as 0 | 8 | 16 })} aria-label={`XLR outputs of ${label}`}>
                            <option value={0}>XLR out = ch 1-8</option>
                            <option value={8}>XLR out = ch 9-16</option>
                            <option value={16}>XLR out = ch 17-24</option>
                          </select>{" "}
                          <label>
                            <input type="checkbox" checked={r.splitter} onChange={(e) => patch(i, { splitter: e.target.checked })} /> Splitter (Ultranet = own inputs)
                          </label>
                        </>
                      ) : (
                        "-"
                      )}
                    </td>
                    <td>
                      <button onClick={() => setRows(rows.filter((_, j) => j !== i))} aria-label={`Remove ${label}`}>
                        Remove
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <datalist id="patch-models">
          {[...new Set([...MODELS, ...models.map((m) => m.label)])].map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
        <p>
          <button
            onClick={() => setRows([...rows, { id: newId(), group: "A", first: 1, last: 8, device: "", model: "", via: "", feedFirst: 33, feedLast: 48, feedGroup: "", feedTouched: false, outOffset: 0, splitter: false }])}
          >
            Add a box
          </button>{" "}
          <button
            className="mixer-refresh"
            disabled={invalid || saveBoxes.isPending || !dirty}
            onClick={() => {
              setBoxesNote(null);
              saveKeys(saveBoxes, () => ({ boxMap: toWire(models, rows) }))
                .then(() => setBoxesNote({ text: "Saved." }))
                .catch((e: unknown) => setBoxesNote({ text: e instanceof Error ? e.message : String(e), bad: true }));
            }}
            title={invalid ? "Every box needs a name, an ascending range within its group, and a feed of at most 16 ports" : !dirty ? "Nothing to save" : undefined}
          >
            {saveBoxes.isPending ? "Saving..." : "Save boxes"}
          </button>
          {dirty && <span> Unsaved changes.</span>}
          {!dirty && boxesNote && !boxesNote.bad && <span> {boxesNote.text}</span>}
        </p>
        {problems.length > 0 && (
          <ul className="error" role="alert">
            {problems.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
        )}
        {boxesNote?.bad && (
          <p className="error" role="alert">
            {boxesNote.text}
          </p>
        )}
      </section>

      <section className="card">
        <h3>From the console</h3>
        <p className="card-hint">
          The console reports its model and the devices on its AES50 / StageConnect links. Detect builds the box list above from them (nothing is saved until you press Save boxes). The same link status is
          also on the Config tab. Expansion cards (WING-LIVE, Dante and others) are not reported: add them as a box on group CRD (WING-LIVE) or MOD.
        </p>
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
        <p>
          <button className="mixer-refresh" onClick={() => void detect()}>
            Detect from console
          </button>
        </p>
        {detectError && (
          <p className="error" role="alert">
            {detectError}
          </p>
        )}
        {detected && (
          <>
            <p>Console model: {detected.consoleModel || "unknown"}. Box list replaced above: check it, then press Save boxes.</p>
            <ul>
              {detected.notes.map((n, i) => (
                <li key={i}>
                  <small>{n}</small>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </>
  );
}
