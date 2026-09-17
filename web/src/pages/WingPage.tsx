import { useMemo, useState } from "react";
import { useEventSource } from "../api/useEventSource.js";
import {
  useClearLinkErrors,
  useLinkStatus,
  RTA_SOURCE_TYPES,
  RTA_TAP_VALUES,
  setWingValue,
  useDeletePreset,
  useLoadPreset,
  useMediaState,
  usePlayAction,
  usePluginConfig,
  useRecAction,
  useRecallScene,
  useRtaSource,
  useSavePreset,
  useSetRtaSource,
  useStepScene,
  useUpdateConfig,
  useWingDiscover,
  useWingPresets,
  useWingScenes,
  useWingState,
  WING_STRIP_TYPES,
  type RtaSourceType,
  type WingPlayAction,
  type WingPresetLoadResult,
  type WingStripType,
} from "../api/queries.js";
import { JsonSchemaForm } from "../components/JsonSchemaForm.js";
import { MeterBar } from "../components/MeterBar.js";
import { RtaSpectrum } from "../components/RtaSpectrum.js";
import { WingAutoEqTab } from "./WingAutoEqTab.js";
import { WingIdentityTab } from "./WingIdentityTab.js";
import { WingMixerTab } from "./WingMixerTab.js";

type Tab = "mixer" | "identity" | "config" | "meters" | "autoeq" | "scenes" | "media" | "presets";

interface MeterEntry {
  key: string;
  label: string;
  db: number;
}

const METER_TYPE_ORDER = ["channel", "aux", "bus", "main", "matrix", "dca"];

/** Entry keys are "type:index" (see WingMetersTab below); sorts by signal-flow type order first, then numerically by index within each type. */
function meterSortKey(key: string): [number, number] {
  const [type, indexStr] = key.split(":");
  const rank = METER_TYPE_ORDER.indexOf(type);
  return [rank === -1 ? METER_TYPE_ORDER.length : rank, Number(indexStr)];
}

/** Meter frame payloads vary by meter type; scan for the first *_dB numeric field. */
function extractDb(frame: Record<string, unknown>): number {
  for (const [key, fieldValue] of Object.entries(frame)) {
    if (/_dB$/i.test(key) && typeof fieldValue === "number") {
      return fieldValue;
    }
  }
  return -144;
}

export function WingPage() {
  const [tab, setTab] = useState<Tab>("mixer");

  return (
    <div className="page">
      <h2>Wing</h2>
      <div className="tabs">
        <button className={tab === "mixer" ? "tabs__button tabs__button--active" : "tabs__button"} onClick={() => setTab("mixer")}>
          Mixer
        </button>
        <button className={tab === "identity" ? "tabs__button tabs__button--active" : "tabs__button"} onClick={() => setTab("identity")}>
          Identity
        </button>
        <button className={tab === "config" ? "tabs__button tabs__button--active" : "tabs__button"} onClick={() => setTab("config")}>
          Config
        </button>
        <button className={tab === "meters" ? "tabs__button tabs__button--active" : "tabs__button"} onClick={() => setTab("meters")}>
          Meters
        </button>
        <button className={tab === "autoeq" ? "tabs__button tabs__button--active" : "tabs__button"} onClick={() => setTab("autoeq")}>
          Auto EQ
        </button>
        <button className={tab === "scenes" ? "tabs__button tabs__button--active" : "tabs__button"} onClick={() => setTab("scenes")}>
          Scenes
        </button>
        <button className={tab === "media" ? "tabs__button tabs__button--active" : "tabs__button"} onClick={() => setTab("media")}>
          Media
        </button>
        <button className={tab === "presets" ? "tabs__button tabs__button--active" : "tabs__button"} onClick={() => setTab("presets")}>
          Presets
        </button>
      </div>

      {tab === "mixer" && <WingMixerTab />}
      {tab === "identity" && <WingIdentityTab />}
      {tab === "config" && <WingConfigTab />}
      {tab === "meters" && <WingMetersTab />}
      {tab === "autoeq" && <WingAutoEqTab />}
      {tab === "scenes" && <WingScenesTab />}
      {tab === "media" && <WingMediaTab />}
      {tab === "presets" && <WingPresetsTab />}
    </div>
  );
}

function WingConfigTab() {
  const configQuery = usePluginConfig("wing");
  const updateConfig = useUpdateConfig("wing");
  const discover = useWingDiscover();

  // Picking a discovered console overrides just the `host` field of whatever the form would
  // otherwise show. Bumping `formKey` remounts JsonSchemaForm so its internal state (initialized
  // once from `value` on mount) picks up the override, without needing to touch that component.
  const [hostOverride, setHostOverride] = useState<string | null>(null);
  const [formKey, setFormKey] = useState(0);

  if (configQuery.isLoading) return <p>Loading config...</p>;
  if (configQuery.isError) return <p className="error">{(configQuery.error as Error).message}</p>;
  if (!configQuery.data) return null;

  const formValue =
    hostOverride !== null
      ? { ...(configQuery.data.config as Record<string, unknown>), host: hostOverride }
      : configQuery.data.config;

  return (
    <section className="card">
      <div className="discover">
        <button type="button" onClick={() => discover.mutate()} disabled={discover.isPending}>
          {discover.isPending ? "Searching..." : "Discover on network"}
        </button>
        {discover.isError && <p className="error">{(discover.error as Error).message}</p>}
        {discover.isSuccess && discover.data.length === 0 && (
          <p>No WING console responded (it may be on a different subnet, or broadcast may be blocked).</p>
        )}
        {discover.isSuccess && discover.data.length > 0 && (
          <ul className="discover-list">
            {discover.data.map((result) => (
              <li key={result.ip}>
                <button
                  type="button"
                  onClick={() => {
                    setHostOverride(result.ip);
                    setFormKey((key) => key + 1);
                  }}
                >
                  {result.name} — {result.model} ({result.ip})
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <JsonSchemaForm
        key={formKey}
        schema={configQuery.data.schema}
        value={formValue}
        onSubmit={(value) => {
          updateConfig.mutate(value);
          setHostOverride(null);
        }}
      />
      {updateConfig.isPending && <p>Saving...</p>}
      {updateConfig.isError && <p className="error">{(updateConfig.error as Error).message}</p>}
      {updateConfig.isSuccess && <p className="success">Saved.</p>}

      <LinkStatusCard />
    </section>
  );
}

/** AES50 A/B/C + StageConnect link diagnostics — read-only status plus a per-port error-counter reset. */
function LinkStatusCard() {
  const linkStatus = useLinkStatus();
  const clearErrors = useClearLinkErrors();

  return (
    <section className="card">
      <h3>AES50 / StageConnect link status</h3>
      {linkStatus.isLoading && <p>Loading link status...</p>}
      {linkStatus.isError && <p className="error">{(linkStatus.error as Error).message}</p>}
      {linkStatus.data && (
        <>
          <ul className="scene-list">
            {linkStatus.data.ports.map((port) => (
              <li key={port.port} className="scene-list__item">
                <span>
                  AES50 {port.port}: {port.state}
                  {port.device ? ` (${port.device})` : ""}
                  {port.remoteName ? ` — connected to "${port.remoteName}"` : ""} — corrected {port.errorsCorrected}, uncorrected{" "}
                  {port.errorsUncorrected}
                </span>
                <button type="button" disabled={clearErrors.isPending} onClick={() => clearErrors.mutate(port.port)}>
                  Reset counters
                </button>
              </li>
            ))}
          </ul>
          <dl className="kv-list">
            <dt>StageConnect</dt>
            <dd>
              {linkStatus.data.stageConnect.status} — up {linkStatus.data.stageConnect.upstreamCount}, down{" "}
              {linkStatus.data.stageConnect.downstreamCount}
              {linkStatus.data.stageConnect.devices ? ` (${linkStatus.data.stageConnect.devices})` : ""}
            </dd>
          </dl>
        </>
      )}
      {clearErrors.isError && <p className="error">{(clearErrors.error as Error).message}</p>}
    </section>
  );
}

const RTA_SOURCE_INDEX_MAX: Record<RtaSourceType, number> = { channel: 40, aux: 8, bus: 16, main: 4, matrix: 8 };

/**
 * Lets the RTA be pointed at a different strip. Deliberately not pre-filled from the console's
 * current selection — the raw rtasrc→strip mapping is inferred, not officially documented (see
 * wing-rta-source.ts on the server), so this shows the current source as read-only text and keeps
 * "pick a new one" as a separate, explicit action rather than risking a stale/incorrect prefill.
 */
function RtaSourceSelector() {
  const sourceQuery = useRtaSource();
  const setSource = useSetRtaSource();
  const [type, setType] = useState<RtaSourceType>("channel");
  const [index, setIndex] = useState(1);
  const [tap, setTap] = useState("");

  const current = sourceQuery.data;
  const currentLabel = sourceQuery.isLoading
    ? "loading..."
    : current?.source
      ? `${current.source.type} ${current.source.index}`
      : `raw index ${current?.rawIndex ?? "?"} (unrecognized)`;

  return (
    <div className="rta-source">
      <p className="meters-status">
        Current source: {currentLabel}
        {current?.tap ? ` — tap ${current.tap}` : ""}
      </p>
      <div className="param-field">
        <select
          value={type}
          onChange={(event) => {
            const nextType = event.target.value as RtaSourceType;
            setType(nextType);
            setIndex((prevIndex) => Math.min(prevIndex, RTA_SOURCE_INDEX_MAX[nextType]));
          }}
        >
          {RTA_SOURCE_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <input
          type="number"
          min={1}
          max={RTA_SOURCE_INDEX_MAX[type]}
          value={index}
          onChange={(event) => setIndex(Math.min(RTA_SOURCE_INDEX_MAX[type], Math.max(1, Number(event.target.value) || 1)))}
        />
        <select value={tap} onChange={(event) => setTap(event.target.value)}>
          <option value="">(keep tap)</option>
          {RTA_TAP_VALUES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <button type="button" disabled={setSource.isPending} onClick={() => setSource.mutate({ type, index, tap: tap || undefined })}>
          Set RTA source
        </button>
      </div>
      {setSource.isError && <p className="error">{(setSource.error as Error).message}</p>}
    </div>
  );
}

function WingMetersTab() {
  const [meters, setMeters] = useState<Map<string, MeterEntry>>(new Map());
  const [rtaBands, setRtaBands] = useState<number[] | null>(null);
  const stateQuery = useWingState();

  const nameByIndex = useMemo(() => {
    const map = new Map<number, string>();
    for (const channel of stateQuery.data ?? []) {
      map.set(channel.index, channel.name);
    }
    return map;
  }, [stateQuery.data]);

  const status = useEventSource("/api/plugins/wing/events", (type, data) => {
    if (type !== "meters") return;
    const envelope = data as { payload?: { frames?: Array<Record<string, unknown>> } } | undefined;
    const frames = envelope?.payload?.frames;
    if (!Array.isArray(frames)) return;

    // RTA is a singleton spectrum (120 unindexed bands), not a fader-shaped level meter — it gets
    // its own dedicated visualization below rather than a bogus "rta 0" entry in the generic grid
    // (extractDb would find nothing to show for it there, since its value is an array, not a scalar).
    const rtaFrame = frames.find((frame) => frame.type === "rta");
    if (rtaFrame && Array.isArray(rtaFrame.bands_dB)) {
      setRtaBands(rtaFrame.bands_dB as number[]);
    }

    setMeters((prev) => {
      const next = new Map(prev);
      for (const frame of frames) {
        const frameType = typeof frame.type === "string" ? frame.type : "unknown";
        if (frameType === "rta") continue;
        const index = typeof frame.index === "number" ? frame.index : 0;
        const key = frameType + ":" + index;
        const name = frameType === "channel" ? nameByIndex.get(index) : undefined;
        next.set(key, { key, label: name ?? frameType + " " + index, db: extractDb(frame) });
      }
      return next;
    });
  });

  const entries = Array.from(meters.values()).sort((a, b) => {
    const [aRank, aIndex] = meterSortKey(a.key);
    const [bRank, bIndex] = meterSortKey(b.key);
    return aRank - bRank || aIndex - bIndex;
  });

  return (
    <section className="card">
      <p className="meters-status">SSE: {status}</p>

      <h3>RTA</h3>
      <RtaSourceSelector />
      {rtaBands ? <RtaSpectrum bandsDb={rtaBands} /> : <p>Waiting for RTA data...</p>}

      <h3>Levels</h3>
      {entries.length === 0 && <p>Waiting for meter data...</p>}
      <div className="meter-grid">
        {entries.map((entry) => (
          <MeterBar key={entry.key} label={entry.label} db={entry.db} />
        ))}
      </div>
    </section>
  );
}

/**
 * Verified against real hardware: describing the $scenes *leaf* directly never replies, but
 * describing its *parent branch* ("/$ctl/lib") does, and that reply's inline enum for $scenes is
 * the actual full scene list in order — array position matches $actidx. See the matching route doc
 * in http-routes.ts.
 */
function WingScenesTab() {
  const scenesQuery = useWingScenes();
  const recallScene = useRecallScene();
  const stepScene = useStepScene();
  const [tagTarget, setTagTarget] = useState("");

  if (scenesQuery.isLoading) return <p>Loading scenes...</p>;
  if (scenesQuery.isError) return <p className="error">{(scenesQuery.error as Error).message}</p>;
  if (!scenesQuery.data) return null;

  const current = scenesQuery.data.current as { index: number | null; name: string; show: string; tagId: number | null };

  return (
    <section className="card">
      <dl className="kv-list">
        <dt>Show</dt>
        <dd>{current.show || "—"}</dd>
        <dt>Active snap</dt>
        <dd>{current.name || "—"}</dd>
      </dl>

      <div className="mixer-fade-actions">
        <button disabled={stepScene.isPending} onClick={() => stepScene.mutate("prev")}>
          Prev
        </button>
        <button disabled={stepScene.isPending} onClick={() => stepScene.mutate("next")}>
          Next
        </button>
      </div>
      {stepScene.isError && <p className="error">{(stepScene.error as Error).message}</p>}

      <ul className="scene-list">
        {scenesQuery.data.scenes.map((scene) => (
          <li
            key={scene.index}
            className={scene.index === current.index ? "scene-list__item scene-list__item--current" : "scene-list__item"}
          >
            <span>
              {scene.index}. {scene.name}
            </span>
            <button disabled={recallScene.isPending} onClick={() => recallScene.mutate({ target: scene.index })}>
              Recall
            </button>
          </li>
        ))}
      </ul>
      {recallScene.isError && <p className="error">{(recallScene.error as Error).message}</p>}

      <div className="param-field">
        <span className="param-field__label">Tag</span>
        <input type="text" value={tagTarget} onChange={(event) => setTagTarget(event.target.value)} placeholder="e.g. 1..16384" />
        <button
          disabled={!tagTarget || recallScene.isPending}
          onClick={() => recallScene.mutate({ target: tagTarget, byTag: true })}
        >
          Recall by tag
        </button>
      </div>
    </section>
  );
}

function parsePresetIndices(text: string): number[] {
  return text
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0);
}

function presetSectionOutcomeLabel(section: WingPresetLoadResult["results"][number]["sections"][number]): string {
  return section.status === "applied" ? section.section : `${section.section}(${section.status}${section.detail ? `: ${section.detail}` : ""})`;
}

/**
 * Save/load/delete strip presets — the web counterpart of the wing_preset_save/load/list/delete MCP
 * tools (src/plugins/wing/tools/presets.ts), both backed by the same performPresetSave/Load/Delete
 * orchestration in wing-preset-engine.ts so this UI and an LLM client behave identically.
 */
function WingPresetsTab() {
  const presetsQuery = useWingPresets();
  const savePreset = useSavePreset();
  const loadPreset = useLoadPreset();
  const deletePreset = useDeletePreset();

  const [name, setName] = useState("");
  const [type, setType] = useState<WingStripType>("channel");
  const [indicesText, setIndicesText] = useState("");
  const [overwrite, setOverwrite] = useState(false);
  const [loadTargets, setLoadTargets] = useState<Record<string, string>>({});
  const [lastLoadResult, setLastLoadResult] = useState<WingPresetLoadResult | null>(null);

  const parsedIndices = parsePresetIndices(indicesText);

  function handleSave() {
    if (!name || parsedIndices.length === 0) return;
    savePreset.mutate(
      { name, type, indices: parsedIndices, overwrite },
      {
        onSuccess: () => {
          setName("");
          setIndicesText("");
          setOverwrite(false);
        },
      },
    );
  }

  function handleLoad(presetName: string) {
    const targetText = (loadTargets[presetName] ?? "").trim();
    const targetIndex = targetText ? Number(targetText) : undefined;
    loadPreset.mutate(
      { name: presetName, targetIndex },
      { onSuccess: (result) => setLastLoadResult(result) },
    );
  }

  function handleDelete(presetName: string) {
    if (!window.confirm(`Delete preset "${presetName}"? This cannot be undone.`)) return;
    deletePreset.mutate(presetName, {
      onSuccess: () => {
        if (lastLoadResult?.name === presetName) setLastLoadResult(null);
      },
    });
  }

  return (
    <section className="card">
      <h3>Save a new preset</h3>
      <div className="param-field">
        <span className="param-field__label">Name</span>
        <input type="text" value={name} onChange={(event) => setName(event.target.value)} placeholder='e.g. "Morgane Micro KSM9"' />
      </div>
      <div className="param-field">
        <span className="param-field__label">Type</span>
        <select value={type} onChange={(event) => setType(event.target.value as WingStripType)}>
          {WING_STRIP_TYPES.map((stripType) => (
            <option key={stripType} value={stripType}>
              {stripType}
            </option>
          ))}
        </select>
      </div>
      <div className="param-field">
        <span className="param-field__label">Indices</span>
        <input
          type="text"
          value={indicesText}
          onChange={(event) => setIndicesText(event.target.value)}
          placeholder="e.g. 1 or 17,18,19,20,21,22,23,24"
        />
      </div>
      <div className="param-field">
        <span className="param-field__label">Overwrite</span>
        <input type="checkbox" checked={overwrite} onChange={(event) => setOverwrite(event.target.checked)} />
      </div>
      <button disabled={!name || parsedIndices.length === 0 || savePreset.isPending} onClick={handleSave}>
        Save preset
      </button>
      {savePreset.isError && <p className="error">{(savePreset.error as Error).message}</p>}

      <h3>Saved presets</h3>
      {presetsQuery.isLoading && <p>Loading presets...</p>}
      {presetsQuery.isError && <p className="error">{(presetsQuery.error as Error).message}</p>}
      {presetsQuery.data && presetsQuery.data.presets.length === 0 && <p>No presets saved yet.</p>}

      <ul className="scene-list">
        {presetsQuery.data?.presets.map((preset) => (
          <li key={preset.name} className="scene-list__item">
            <span>
              {preset.name} [{preset.type}] — {preset.slotCount} strip(s) [{preset.sourceIndices.join(", ")}], updated {preset.updatedAt}
            </span>
            <input
              type="text"
              placeholder="target index (optional)"
              value={loadTargets[preset.name] ?? ""}
              onChange={(event) => setLoadTargets((prev) => ({ ...prev, [preset.name]: event.target.value }))}
            />
            <button disabled={loadPreset.isPending} onClick={() => handleLoad(preset.name)}>
              Load
            </button>
            <button disabled={deletePreset.isPending} onClick={() => handleDelete(preset.name)}>
              Delete
            </button>
          </li>
        ))}
      </ul>
      {loadPreset.isError && <p className="error">{(loadPreset.error as Error).message}</p>}
      {deletePreset.isError && <p className="error">{(deletePreset.error as Error).message}</p>}

      {lastLoadResult && (
        <section className="card">
          <h4>
            Load result: {lastLoadResult.name} — {lastLoadResult.summary.ok}/{lastLoadResult.summary.total} fully applied
            {lastLoadResult.summary.partial || lastLoadResult.summary.failed
              ? `, ${lastLoadResult.summary.partial} partial, ${lastLoadResult.summary.failed} failed`
              : ""}
          </h4>
          <ul>
            {lastLoadResult.results.map((result) => (
              <li key={`${result.sourceIndex}-${result.targetIndex}`}>
                {result.sourceIndex} → {result.targetIndex}: {result.status}
                {result.error ? ` (${result.error})` : ""}
                {result.sections.length > 0 ? ` [${result.sections.map(presetSectionOutcomeLabel).join(", ")}]` : ""}
              </li>
            ))}
          </ul>
        </section>
      )}
    </section>
  );
}

/**
 * The console's single USB player/recorder module — verified against real hardware (a WING Rack
 * unit) that there is no separate SD-card module; whatever's plugged into the one USB port is what
 * both `/play` and `/rec` operate on. Polls every 3s (not SSE-driven, unlike the Mixer tab) since
 * these fields don't currently push subscription updates the way channel/bus params do.
 */
function WingMediaTab() {
  const mediaQuery = useMediaState();
  const playAction = usePlayAction();
  const recAction = useRecAction();
  const [playFile, setPlayFile] = useState("");

  if (mediaQuery.isLoading) return <p>Loading USB media module state...</p>;
  if (mediaQuery.isError) return <p className="error">{(mediaQuery.error as Error).message}</p>;
  if (!mediaQuery.data) return null;

  const { usb, play, rec } = mediaQuery.data;

  return (
    <div className="mixer-stage-groups">
      <section className="card">
        <h3>USB</h3>
        <dl className="kv-list">
          <dt>State</dt>
          <dd>{usb.state}</dd>
          <dt>Volume</dt>
          <dd>{usb.volumeName.trim() || "none plugged in"}</dd>
        </dl>
      </section>

      <section className="card">
        <h3>Player</h3>
        <dl className="kv-list">
          <dt>State</dt>
          <dd>{play.state}</dd>
          <dt>File</dt>
          <dd>{play.file || "—"}</dd>
          <dt>Track</dt>
          <dd>{[play.artist, play.song].filter(Boolean).join(" — ") || "—"}{play.album ? ` (${play.album})` : ""}</dd>
          <dt>Position</dt>
          <dd>
            {play.pos.display} / {play.total.display}
          </dd>
          <dt>Format</dt>
          <dd>
            {play.format} {play.resolution}-bit {play.rate}kHz {play.channels}ch
          </dd>
        </dl>
        <div className="mixer-fade-actions">
          <button onClick={() => playAction.mutate({ action: "PREV" as WingPlayAction })} disabled={playAction.isPending}>
            Prev
          </button>
          <button
            className={play.state === "PLAY" ? "mixer-mute mixer-mute--on" : "mixer-mute"}
            onClick={() => playAction.mutate({ action: "PLAY" as WingPlayAction })}
            disabled={playAction.isPending}
          >
            Play
          </button>
          <button onClick={() => playAction.mutate({ action: "PAUSE" as WingPlayAction })} disabled={playAction.isPending}>
            Pause
          </button>
          <button onClick={() => playAction.mutate({ action: "STOP" as WingPlayAction })} disabled={playAction.isPending}>
            Stop
          </button>
          <button onClick={() => playAction.mutate({ action: "NEXT" as WingPlayAction })} disabled={playAction.isPending}>
            Next
          </button>
          <button
            className={play.repeat ? "mixer-mute mixer-mute--on" : "mixer-mute"}
            onClick={() => void setWingValue("/play/repeat", play.repeat ? 0 : 1)}
          >
            Repeat: {play.repeat ? "On" : "Off"}
          </button>
        </div>
        {playAction.isError && <p className="error">{(playAction.error as Error).message}</p>}

        {play.songs.length > 0 && (
          <ul className="scene-list">
            {play.songs.map((track) => (
              <li
                key={track.index}
                className={track.index === play.currentIndex ? "scene-list__item scene-list__item--current" : "scene-list__item"}
              >
                <span>
                  {track.index}. {track.name}
                </span>
                <button
                  disabled={playAction.isPending}
                  onClick={() => playAction.mutate({ action: "PLAY" as WingPlayAction, index: track.index })}
                >
                  Play
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="param-field">
          <span className="param-field__label">Play file</span>
          <input type="text" value={playFile} onChange={(event) => setPlayFile(event.target.value)} placeholder="path on the USB stick" />
          <button
            onClick={() => playAction.mutate({ action: "PLAYFILE" as WingPlayAction, file: playFile })}
            disabled={!playFile || playAction.isPending}
          >
            Play file
          </button>
        </div>
      </section>

      <section className="card">
        <h3>Recorder</h3>
        <dl className="kv-list">
          <dt>State</dt>
          <dd>{rec.state}</dd>
          <dt>File</dt>
          <dd>{rec.file || "—"}</dd>
          <dt>Path</dt>
          <dd>{rec.path || "—"}</dd>
          <dt>Elapsed</dt>
          <dd>{rec.time.display}</dd>
          <dt>Format</dt>
          <dd>
            {rec.resolution}-bit {rec.channels}ch
          </dd>
        </dl>
        <div className="mixer-fade-actions">
          <button
            className={rec.state === "REC" ? "mixer-mute mixer-mute--active" : "mixer-mute"}
            onClick={() => recAction.mutate("REC")}
            disabled={recAction.isPending}
          >
            Rec
          </button>
          <button onClick={() => recAction.mutate("PAUSE")} disabled={recAction.isPending}>
            Pause
          </button>
          <button onClick={() => recAction.mutate("STOP")} disabled={recAction.isPending}>
            Stop
          </button>
          <button onClick={() => recAction.mutate("NEWFILE")} disabled={recAction.isPending}>
            New File
          </button>
        </div>
        {recAction.isError && <p className="error">{(recAction.error as Error).message}</p>}
      </section>
    </div>
  );
}
