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
}

interface WireBox {
  range: [number, number];
  device: string;
  model?: string;
  via?: string;
  hub?: string;
  feed?: { group?: string; range: [number, number] };
}

const MODELS = [
  "WING-LIVE",
  "WING-DANTE","Midas DL8", "Midas DL16", "Midas DL32", "Klark Teknik DN4816U", "Midas HUB4", "Behringer X32 Rack", "Behringer WING Rack", "Behringer WING Compact", "Behringer WING Full", "Behringer S16", "Behringer S32", "P16-M"];
/** LCL = the console's own local ports; CRD / MOD = an expansion card (WING-LIVE / Dante and others). */
const GROUPS = ["A", "B", "C", "SC", "LCL", "CRD", "MOD"];

function isPersonalMixer(model: string): boolean {
  return /P-?16/i.test(model);
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
      box.feed = { range: [r.feedFirst, r.feedLast] };
    } else if (r.via) {
      // Anything else keeps its own console ports and just sits under a hub (HUB4).
      box.hub = r.via;
    }
    (map[r.group] ??= []).push(box);
  }
  return map;
}

/** Patch sheet: the stage-box map that labels the patch, and the PDF generator. */
export function WingPatchTab(): JSX.Element {
  const config = usePluginConfig("wing");
  const save = useUpdateConfig("wing");
  const [rows, setRows] = useState<BoxRow[] | null>(null);
  const [render, setRender] = useState<"visual" | "table">("visual");
  const [naming, setNaming] = useState<"io" | "channel" | "full">("channel");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const links = useLinkStatus();
  const [detected, setDetected] = useState<{ consoleModel: string; notes: string[] } | null>(null);
  const [detectError, setDetectError] = useState<string | undefined>();
  const [presetName, setPresetName] = useState("");
  const [picked, setPicked] = useState("");

  useEffect(() => {
    if (rows === null && config.data) {
      const cfg = config.data.config as { boxMap?: Record<string, WireBox[]> };
      setRows(fromWire(cfg.boxMap));
    }
  }, [config.data, rows]);

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
  const plays = (r: BoxRow): boolean => !!r.via && isPersonalMixer(r.model);
  const patch = (i: number, change: Partial<BoxRow>): void => setRows(rows.map((r, j) => (j === i ? { ...r, ...change } : r)));
  const invalid = rows.some((r) => !r.device.trim() || r.first > r.last || (plays(r) && (r.feedFirst > r.feedLast || r.feedLast - r.feedFirst > 15)));

  async function generate(): Promise<void> {
    setBusy(true);
    setError(undefined);
    try {
      const res = await fetch(`/api/plugins/wing/io/patch.pdf?render=${render}&naming=${naming}`, { headers: { Authorization: "Bearer " + (getToken() ?? "") } });
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
          <button className="mixer-refresh" onClick={() => void generate()} disabled={busy}>
            {busy ? "Generating..." : "Generate PDF"}
          </button>
        </div>
        {error && <p className="error">{error}</p>}
      </section>

      <section className="card">
        <div className="card-header">
          <h3>From the console</h3>
        </div>
        <p className="card-hint">
          The console reports its model and the devices on its AES50 / StageConnect links. Detect builds the box list below from them (nothing is saved until you press Save boxes).
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
            <p>Console model: {detected.consoleModel || "unknown"}. Box list replaced below.</p>
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

      <section className="card">
        <div className="card-header">
          <h3>Presets</h3>
        </div>
        <p className="card-hint">Keep a stage-box setup per venue or rig, and load it back in one click.</p>
        <p>
          <select value={picked} onChange={(e) => setPicked(e.target.value)} aria-label="Saved presets">
            <option value="">- choose a preset -</option>
            {presetNames.map((n) => (
              <option key={n}>{n}</option>
            ))}
          </select>{" "}
          <button disabled={!picked} onClick={() => setRows(fromWire(presets[picked]))}>
            Load
          </button>{" "}
          <button
            disabled={!picked || save.isPending}
            onClick={() => {
              saveConfig({ boxPresets: Object.fromEntries(Object.entries(presets).filter(([n]) => n !== picked)) });
              setPicked("");
            }}
          >
            Delete
          </button>
        </p>
        <p>
          <input placeholder="Preset name" value={presetName} onChange={(e) => setPresetName(e.target.value)} maxLength={60} />{" "}
          <button disabled={!presetName.trim() || invalid || save.isPending} onClick={() => saveConfig({ boxPresets: { ...presets, [presetName.trim()]: toWire(rows) } })}>
            Save current boxes as preset
          </button>
        </p>
      </section>

      <section className="card">
        <div className="card-header">
          <h3>Stage boxes</h3>
        </div>
        <p className="card-hint">
          Which box sits on which AES50 / StageConnect ports. A box can sit under a hub (a DL8 on a HUB4 port). A personal mixer (P16-M) is hung off another box: pick the box it is plugged into and the console output ports it plays
          (default: 33-48 on a DL16, DL32 or HUB4; the first 16 ports on a DN4816U).
        </p>
        <table className="table">
          <thead>
            <tr>
              <th>Port</th>
              <th>From</th>
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
              <tr key={i}>
                <td>
                  <select value={r.group} onChange={(e) => patch(i, { group: e.target.value })}>
                    {GROUPS.map((g) => (
                      <option key={g}>{g}</option>
                    ))}
                  </select>
                </td>
                <td>
                  <input type="number" min={1} value={r.first} onChange={(e) => patch(i, { first: Number(e.target.value) })} style={{ width: "4em" }} />
                </td>
                <td>
                  <input type="number" min={1} value={r.last} onChange={(e) => patch(i, { last: Number(e.target.value) })} style={{ width: "4em" }} />
                </td>
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
                      <input type="number" min={1} value={r.feedFirst} onChange={(e) => patch(i, { feedFirst: Number(e.target.value) })} style={{ width: "4em" }} /> to{" "}
                      <input type="number" min={1} value={r.feedLast} onChange={(e) => patch(i, { feedLast: Number(e.target.value) })} style={{ width: "4em" }} />
                    </>
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
          <button onClick={() => setRows([...rows, { group: "A", first: 1, last: 8, device: "", model: "", via: "", feedFirst: 33, feedLast: 48 }])}>Add a box</button>{" "}
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
    </>
  );
}
