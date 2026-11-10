import { useEffect, useState, type JSX } from "react";
import { apiFetch } from "../api/client.js";
import { useLinkStatus, usePluginConfig, useUpdateConfig } from "../api/queries.js";
import { getToken } from "../auth/token-store.js";

interface BoxRow {
  group: string;
  first: number;
  last: number;
  device: string;
  model: string;
  /** Host device for a personal mixer (P16-M) hung off another box. */
  via: string;
  feedFirst: number;
  feedLast: number;
  /** Group the played ports are on; empty = the host's own. */
  feedGroup: string;
}

interface WireBox {
  range: [number, number];
  device: string;
  model?: string;
  via?: string;
  hub?: string;
  feed?: { group?: string; range: [number, number] };
}

/** What the server's catalogue says about a box: its size, and where it must start. */
interface ModelInfo {
  id: string;
  label: string;
  kind: string;
  /** Channels the box takes on the console; 0 when it takes none of its own range. */
  size: number;
  fixedStart?: number;
  match: { source: string; flags: string };
}

/** Ports per console group: a range may not go beyond. */
const GROUP_LIMIT: Record<string, number> = { A: 48, B: 48, C: 48, SC: 32, LCL: 24, CRD: 64, MOD: 64 };

const MODELS = [
  "WING-LIVE",
  "WING-DANTE","Midas DL8", "Midas DL16", "Midas DL32", "Klark Teknik DN4816U", "Midas HUB4", "Behringer X32 Rack", "Behringer WING Rack", "Behringer WING Compact", "Behringer WING Full", "Behringer S16", "Behringer S32", "P16-M"];
/** LCL = the console's own local ports; CRD / MOD = an expansion card (WING-LIVE / Dante and others). */
const GROUPS = ["A", "B", "C", "SC", "LCL", "CRD", "MOD"];

function isPersonalMixer(model: string): boolean {
  return /P-?16/i.test(model);
}

/** A HUB4 has four ports of eight channels each (A 1-8, 9-16, 17-24, 25-32). */
function isHub(model: string, device: string): boolean {
  return /HUB-?4/i.test(`${model} ${device}`);
}

function fromWire(map: Record<string, WireBox[]> | undefined): BoxRow[] {
  const rows: BoxRow[] = [];
  for (const [group, boxes] of Object.entries(map ?? {})) {
    for (const b of boxes) {
      rows.push({
        group,
        first: b.range[0],
        last: b.range[1],
        device: b.device,
        model: b.model ?? "",
        via: b.via ?? b.hub ?? "",
        feedFirst: b.feed?.range[0] ?? 33,
        feedLast: b.feed?.range[1] ?? 48,
        feedGroup: b.feed?.group ?? "",
      });
    }
  }
  return rows;
}

function toWire(rows: BoxRow[]): Record<string, WireBox[]> {
  const map: Record<string, WireBox[]> = {};
  for (const r of rows) {
    const box: WireBox = { range: [r.first, r.last], device: r.device.trim() };
    if (r.model.trim()) box.model = r.model.trim();
    if (r.via && isPersonalMixer(r.model)) {
      // A personal mixer plays console output ports through its host.
      box.via = r.via;
      box.feed = { ...(r.feedGroup ? { group: r.feedGroup } : {}), range: [r.feedFirst, r.feedLast] };
    } else if (r.via) {
      // Anything else keeps its own console ports and just sits under a hub (HUB4).
      box.hub = r.via;
    }
    (map[r.group] ??= []).push(box);
  }
  return map;
}

function specOfRow(models: ModelInfo[], r: BoxRow): ModelInfo | undefined {
  const hay = `${r.model} ${r.device}`;
  return models.find((m) => {
    try {
      return new RegExp(m.match.source, m.match.flags).test(hay);
    } catch {
      return false;
    }
  });
}

/**
 * Keeps a row's range possible: a known box takes exactly its channels (a DL8 eight, a card 64), a hub
 * starts at 33 and a card at 1, nothing goes past the ports its group has, and a personal mixer has
 * no range of its own (it plays a feed).
 */
function tidyRow(models: ModelInfo[], r: BoxRow): BoxRow {
  if (r.via && isPersonalMixer(r.model)) return r;
  const spec = specOfRow(models, r);
  const size = spec && spec.size > 0 ? spec.size : 0;
  const limit = GROUP_LIMIT[r.group] ?? 999;
  let length = size > 0 ? size : Math.max(1, r.last - r.first + 1);
  length = Math.min(length, limit);
  const first = Math.min(spec?.fixedStart ?? Math.max(1, r.first), limit - length + 1);
  return { ...r, first, last: first + length - 1 };
}

/** Patch sheet: the stage-box map that labels the patch, and the PDF generator. */
export function WingPatchTab(): JSX.Element {
  const config = usePluginConfig("wing");
  const save = useUpdateConfig("wing");
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
  const [presetNote, setPresetNote] = useState("");
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [tidied, setTidied] = useState(false);

  useEffect(() => {
    apiFetch<{ models: ModelInfo[] }>("/api/plugins/wing/io/boxmap/models")
      .then((r) => setModels(r.models))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (rows === null && config.data) {
      const cfg = config.data.config as { boxMap?: Record<string, WireBox[]> };
      setRows(fromWire(cfg.boxMap));
    }
  }, [config.data, rows]);

  // Once the catalogue is here, bring the saved rows within what their models and groups allow.
  // (Hooks stay above the early return below: their number must not change between renders.)
  useEffect(() => {
    if (models.length > 0 && rows !== null && !tidied) {
      setTidied(true);
      setRows(rows.map((r) => tidyRow(models, r)));
    }
  }, [models, rows, tidied]);

  if (config.isLoading || rows === null) return <p>Loading patch...</p>;
  if (config.isError) return <p className="error">{(config.error as Error).message}</p>;

  const presets = (config.data?.config as { boxPresets?: Record<string, Record<string, WireBox[]>> } | undefined)?.boxPresets ?? {};
  const presetNames = Object.keys(presets).sort();
  const saveConfig = (extra: object): void => save.mutate({ ...(config.data?.config as object), ...extra });

  async function detect(): Promise<void> {
    setDetectError(undefined);
    try {
      const d = await apiFetch<{ consoleModel: string; boxMap: Record<string, WireBox[]>; notes: string[] }>("/api/plugins/wing/io/boxmap/detect");
      setRows(fromWire(d.boxMap));
      setDetected({ consoleModel: d.consoleModel, notes: d.notes });
    } catch (err) {
      setDetectError(err instanceof Error ? err.message : String(err));
    }
  }

  const hosts = rows.filter((r) => !r.via).map((r) => r.device);
  /** Moves row `from` to position `to`: pages of the sheet follow this order. */
  const move = (from: number, to: number): void => {
    if (to < 0 || to >= rows.length || from === to) return;
    const next = [...rows];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item as BoxRow);
    setRows(next);
  };
  const onHub = (r: BoxRow): boolean => !!r.via && !isPersonalMixer(r.model) && rows.some((h) => h.device === r.via && isHub(h.model, h.device));
  const plays = (r: BoxRow): boolean => !!r.via && isPersonalMixer(r.model);
  const specOf = (r: BoxRow): ModelInfo | undefined => specOfRow(models, r);
  const limitOf = (group: string): number => GROUP_LIMIT[group] ?? 999;
  const tidy = (r: BoxRow): BoxRow => tidyRow(models, r);
  const patch = (i: number, change: Partial<BoxRow>): void => setRows(rows.map((r, j) => (j === i ? tidy({ ...r, ...change }) : r)));

  const invalid = rows.some((r) => !r.device.trim() || r.first > r.last || (!(r.via && isPersonalMixer(r.model)) && r.last > limitOf(r.group)) || (plays(r) && (r.feedFirst > r.feedLast || r.feedLast - r.feedFirst > 15)));

  async function generate(): Promise<void> {
    setBusy(true);
    setError(undefined);
    try {
      const res = await fetch(`/api/plugins/wing/io/patch.pdf?render=${render}&naming=${naming}&lang=${lang}`, { headers: { Authorization: "Bearer " + (getToken() ?? "") } });
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

  return (
    <>

      <section className="card">
        <div className="card-header">
          <h3>Patch sheet (PDF)</h3>
        </div>
        <p className="card-hint">
          Reads the live patch and the box map below, and builds an overview page plus one page per box. Save the box map first if you changed it.
        </p>
        <div className="mixer-toolbar">
          <label>
            Layout{" "}
            <select value={render} onChange={(e) => setRender(e.target.value as typeof render)}>
              <option value="visual">Visual (drawn fronts, colours)</option>
              <option value="table">Tables only</option>
            </select>
          </label>{" "}
          <label>
            Names{" "}
            <select value={naming} onChange={(e) => setNaming(e.target.value as typeof naming)}>
              <option value="io">Input / output name</option>
              <option value="channel">Channel name first</option>
              <option value="full">Input + channel + output</option>
            </select>
          </label>{" "}
          <label>
            Language{" "}
            <select value={lang} onChange={(e) => setLang(e.target.value as typeof lang)}>
              <option value="fr">Français</option>
              <option value="en">English</option>
            </select>
          </label>{" "}
          <button className="mixer-refresh" onClick={() => void generate()} disabled={busy}>
            {busy ? "Generating..." : "Generate PDF"}
          </button>
        </div>
        {error && <p className="error">{error}</p>}
      </section>



      <section className="card">
        <div className="card-header">
          <h3>Stage boxes</h3>
        </div>
        <p className="card-hint">
          Which box sits on which AES50 / StageConnect ports. Drag the rows (or use the arrows) to reorder: the pages of the sheet follow this order, boxes of the same port group staying together. A box can sit under a hub (a DL8 on a HUB4 port, or any StageConnect box on its StageConnect output = A 33-48; the hub's own back-panel outputs are those same 33-48). A personal mixer (P16-M) is hung off another box: pick the box it is plugged into and the console output ports it plays
          (default: 33-48 on a DL16, DL32, S16, S32, X32 or HUB4; the first 16 ports on a DN4816U).
        </p>
        <div className="mixer-toolbar" role="group" aria-label="Presets">
          <strong>Preset</strong>{" "}
          <select value={picked} onChange={(e) => setPicked(e.target.value)} aria-label="Saved presets">
            <option value="">- {presetNames.length === 0 ? "none saved" : "choose"} -</option>
            {presetNames.map((n) => (
              <option key={n}>{n}</option>
            ))}
          </select>{" "}
          <button
            disabled={!picked}
            onClick={() => {
              setRows(fromWire(presets[picked]));
              setPresetName(picked);
              setPresetNote(`Loaded "${picked}". Press Save boxes to make it the active map.`);
            }}
          >
            Load
          </button>{" "}
          <button
            disabled={!picked || save.isPending}
            onClick={() => {
              saveConfig({ boxPresets: Object.fromEntries(Object.entries(presets).filter(([n]) => n !== picked)) });
              setPresetNote(`Deleted "${picked}".`);
              setPicked("");
            }}
          >
            Delete
          </button>{" "}
          <input placeholder="Name this setup" value={presetName} onChange={(e) => setPresetName(e.target.value)} maxLength={60} aria-label="Preset name" />{" "}
          <button
            disabled={save.isPending}
            onClick={() => {
              const name = presetName.trim();
              if (!name) {
                setPresetNote("Give the setup a name first.");
                return;
              }
              if (invalid) {
                setPresetNote("Fix the boxes first: every one needs a name and an ascending range.");
                return;
              }
              saveConfig({ boxPresets: { ...presets, [name]: toWire(rows) } });
              setPicked(name);
              setPresetNote(`Saved the ${rows.length} boxes as "${name}".`);
            }}
          >
            Save as preset
          </button>
        </div>
        {presetNote && <p className="card-hint">{presetNote}</p>}
        <table className="table">
          <thead>
            <tr>
              <th />
              <th>Port</th>
              <th>From</th>
              <th>Channels</th>
              <th>To</th>
              <th>Name</th>
              <th>Model</th>
              <th>Plugged into (hub / host)</th>
              <th>Plays ports</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr
                key={i}
                draggable
                onDragStart={() => setDragFrom(i)}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOver(i);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragFrom !== null) move(dragFrom, i);
                  setDragFrom(null);
                  setDragOver(null);
                }}
                onDragEnd={() => {
                  setDragFrom(null);
                  setDragOver(null);
                }}
                style={{ opacity: dragFrom === i ? 0.5 : 1, outline: dragOver === i && dragFrom !== null && dragFrom !== i ? "2px solid var(--accent, #2d9cdb)" : undefined }}
              >
                <td style={{ whiteSpace: "nowrap", cursor: "grab" }} title="Drag to reorder">
                  <span aria-hidden="true">⠿</span>{" "}
                  <button type="button" onClick={() => move(i, i - 1)} disabled={i === 0} aria-label={`Move ${r.device || "box"} up`}>
                    ↑
                  </button>
                  <button type="button" onClick={() => move(i, i + 1)} disabled={i === rows.length - 1} aria-label={`Move ${r.device || "box"} down`}>
                    ↓
                  </button>
                </td>
                <td>
                  <select value={r.group} onChange={(e) => patch(i, { group: e.target.value })}>
                    {GROUPS.map((g) => (
                      <option key={g}>{g}</option>
                    ))}
                  </select>
                </td>
                {r.via && isPersonalMixer(r.model) ? (
                  <td colSpan={3} style={{ opacity: 0.6 }}>
                    plays the ports on the right
                  </td>
                ) : (
                  <>
                    <td>
                      <input
                        type="number"
                        min={1}
                        max={limitOf(r.group)}
                        value={r.first}
                        disabled={specOf(r)?.fixedStart !== undefined}
                        title={specOf(r)?.fixedStart !== undefined ? `A ${specOf(r)?.label} always starts at ${specOf(r)?.fixedStart}` : undefined}
                        onChange={(e) => patch(i, { first: Number(e.target.value) })}
                        style={{ width: "4em" }}
                      />
                    </td>
                    <td>
                      <input
                        type="number"
                        min={1}
                        max={Math.min(limitOf(r.group), 64)}
                        value={r.last - r.first + 1}
                        disabled={(specOf(r)?.size ?? 0) > 0}
                        title={(specOf(r)?.size ?? 0) > 0 ? `A ${specOf(r)?.label} has ${specOf(r)?.size} channels` : `Up to ${limitOf(r.group)} on ${r.group}`}
                        onChange={(e) => patch(i, { last: r.first + Math.max(1, Number(e.target.value)) - 1 })}
                        style={{ width: "4em" }}
                      />
                    </td>
                    <td style={{ whiteSpace: "nowrap" }}>
                      {r.group} {r.first}-{r.last}
                    </td>
                  </>
                )}
                <td>
                  <input value={r.device} onChange={(e) => patch(i, { device: e.target.value })} style={{ width: "9em" }} />
                </td>
                <td>
                  <input list="patch-models" value={r.model} onChange={(e) => patch(i, { model: e.target.value })} style={{ width: "12em" }} />
                </td>
                <td>
                  <select value={r.via} onChange={(e) => patch(i, { via: e.target.value })}>
                    <option value="">- console port -</option>
                    {hosts
                      .filter((h) => h !== r.device)
                      .map((h) => (
                        <option key={h}>{h}</option>
                      ))}
                  </select>
                </td>
                <td>
                  {plays(r) ? (
                    <>
                      <select value={r.feedGroup} onChange={(e) => patch(i, { feedGroup: e.target.value })} aria-label={`Group played by ${r.device}`}>
                        <option value="">host's group</option>
                        {["A", "B", "C", "SC"].map((g) => (
                          <option key={g}>{g}</option>
                        ))}
                      </select>{" "}
                      <input type="number" min={1} value={r.feedFirst} onChange={(e) => patch(i, { feedFirst: Number(e.target.value) })} style={{ width: "4em" }} /> to{" "}
                      <input type="number" min={1} value={r.feedLast} onChange={(e) => patch(i, { feedLast: Number(e.target.value) })} style={{ width: "4em" }} />{" "}
                      <button type="button" onClick={() => patch(i, { feedGroup: "A", feedFirst: 33, feedLast: 48 })} title="What a HUB4 serves on its StageConnect output">
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
                      aria-label={`Hub port of ${r.device}`}
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
                  <button onClick={() => setRows(rows.filter((_, j) => j !== i))} aria-label={`Remove ${r.device}`}>
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <datalist id="patch-models">
          {MODELS.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
        <p>
          <button onClick={() => setRows([...rows, { group: "A", first: 1, last: 8, device: "", model: "", via: "", feedFirst: 33, feedLast: 48, feedGroup: "" }])}>Add a box</button>{" "}
          <button
            className="mixer-refresh"
            disabled={invalid || save.isPending}
            // The config PUT replaces the whole file: send everything else back unchanged.
            onClick={() => save.mutate({ ...(config.data?.config as object), boxMap: toWire(rows) })}
            title={invalid ? "Every box needs a name, an ascending range, and at most 16 played ports" : undefined}
          >
            {save.isPending ? "Saving..." : "Save boxes"}
          </button>
          {save.isSuccess && <span> Saved.</span>}
        </p>
        {save.isError && <p className="error">{save.error.message}</p>}
      </section>



      <section className="card">
        <div className="card-header">
          <h3>From the console</h3>
        </div>
        <p className="card-hint">
          The console reports its model and the devices on its AES50 / StageConnect links. Detect builds the box list above from them (nothing is saved until you press Save boxes).
          The same link status is also on the Config tab. Expansion cards (WING-LIVE, Dante and others) are not reported: add them as a box on group CRD (WING-LIVE) or MOD.
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
        {detectError && <p className="error">{detectError}</p>}
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
