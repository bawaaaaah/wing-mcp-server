import { useState, type JSX } from "react";
import {
  setMonitorBus,
  setSoloConfig,
  setStripSoloSafe,
  useMonitorBus,
  useSoloConfig,
  type WingChannelStrip,
  type WingMixerState,
  type WingMonitorBus,
  type WingMonitorBusPatch,
  type WingSoloConfig,
} from "../api/queries.js";
import { useThrottledCommit } from "../api/useThrottledCommit.js";
import { wingColorHex } from "../components/ParamPanel.js";
import { FaderControl, formatDb, formatPan, SliderControl } from "../components/SliderControl.js";

/** A row of mutually exclusive choices; `labels` names the console's tokens. */
function Segmented<T extends string>({
  label,
  options,
  labels,
  value,
  onChange,
}: {
  label: string;
  options: readonly T[];
  labels?: Partial<Record<T, string>>;
  value: T;
  onChange: (next: T) => void;
}) {
  return (
    <div className="param-field">
      <span className="param-field__label">{label}</span>
      <div className="segmented" role="group" aria-label={label}>
        {options.map((option) => (
          <button key={option} type="button" className="segmented__option" aria-pressed={value === option} onClick={() => onChange(option)}>
            {labels?.[option] ?? option}
          </button>
        ))}
      </div>
    </div>
  );
}

function Toggle({ label, on, onChange }: { label: string; on: boolean; onChange: (next: boolean) => void }) {
  return (
    <button type="button" className={on ? "mixer-mute mixer-mute--on" : "mixer-mute"} aria-pressed={on} onClick={() => onChange(!on)}>
      {label}
    </button>
  );
}

const SOLO_MODES = ["LIVE", "STUDIO", "SIP"] as const;
const SOLO_MONITORS = ["PH", "SPK", "PH+SPK"] as const;
const SOLO_TAPS = ["PFL", "AFL"] as const;
const TAP_FIELDS = [
  ["channelTap", "Channels"],
  ["busTap", "Buses"],
  ["mainTap", "Mains"],
  ["matrixTap", "Matrices"],
] as const;

/** `/cfg/solo`: what a Solo press does and where it is heard. Changes show at once, then go out. */
function SoloConfigCard() {
  const query = useSoloConfig();
  const [local, setLocal] = useState<Partial<WingSoloConfig>>({});
  const [error, setError] = useState<string | null>(null);
  if (query.isError) return <ErrorCard title="Solo" error={query.error} />;
  if (!query.data) return <LoadingCard title="Solo" />;
  const cfg = { ...query.data, ...local };
  const set = (patch: Partial<WingSoloConfig>) => {
    setLocal((prev) => ({ ...prev, ...patch }));
    setError(null);
    setSoloConfig(patch).catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  };

  return (
    <div className="mixer-stage-group">
      <div className="mixer-processing-card__header">
        <h3>Solo</h3>
      </div>
      <div className="param-panel">
        <Segmented
          label="Mode"
          options={SOLO_MODES}
          labels={{ LIVE: "Live", STUDIO: "Studio", SIP: "Solo in place" }}
          value={cfg.mode as (typeof SOLO_MODES)[number]}
          onChange={(mode) => set({ mode })}
        />
        <Segmented
          label="Heard on"
          options={SOLO_MONITORS}
          labels={{ PH: "Phones", SPK: "Speakers", "PH+SPK": "Both" }}
          value={cfg.monitor as (typeof SOLO_MONITORS)[number]}
          onChange={(monitor) => set({ monitor })}
        />
        <div className="param-field">
          <span className="param-field__label">Options</span>
          <div className="monitor-toggles">
            <Toggle label="Mute" on={cfg.mute} onChange={(mute) => set({ mute })} />
            <Toggle label="Dim" on={cfg.dim} onChange={(dim) => set({ dim })} />
            <Toggle label="Mono" on={cfg.mono} onChange={(mono) => set({ mono })} />
            <Toggle label="Flip L/R" on={cfg.flip} onChange={(flip) => set({ flip })} />
          </div>
        </div>
        {TAP_FIELDS.map(([field, label]) => (
          <Segmented
            key={field}
            label={`${label} tap`}
            options={SOLO_TAPS}
            value={cfg[field] as (typeof SOLO_TAPS)[number]}
            onChange={(tap) => set({ [field]: tap })}
          />
        ))}
        {error && <p className="error">{error}</p>}
      </div>
    </div>
  );
}

/** A monitor-bus slider that writes its own field, throttled, so two sliders never overwrite each other. */
function MonitorSlider({
  label,
  value,
  min,
  max,
  step,
  format,
  onLocal,
  commit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  onLocal: (v: number) => void;
  commit: (v: number) => void;
}) {
  const throttled = useThrottledCommit<number>(120, commit);
  return (
    <SliderControl
      label={label}
      value={value}
      min={min}
      max={max}
      step={step}
      format={format}
      onChange={(v) => {
        onLocal(v);
        throttled(v);
      }}
    />
  );
}

function MonitorFader({ label, value, onLocal, commit }: { label: string; value: number; onLocal: (v: number) => void; commit: (v: number) => void }) {
  const throttled = useThrottledCommit<number>(120, commit);
  return (
    <FaderControl
      label={label}
      value={value}
      onChange={(v) => {
        onLocal(v);
        throttled(v);
      }}
    />
  );
}

type SourceLists = Pick<WingMixerState, "channels" | "auxes" | "buses" | "mains" | "matrices">;

/** "MAIN.1" → "Main 1 · Main LR", from the mixer's own names. */
function sourceOptions(prefixes: readonly (readonly [string, keyof SourceLists, string])[], lists: SourceLists | undefined) {
  const options: { value: string; label: string }[] = [{ value: "OFF", label: "Off" }];
  for (const [token, list, label] of prefixes) {
    const strips: { index: number; name: string }[] = lists?.[list] ?? [];
    const count = { channels: 40, auxes: 8, buses: 16, mains: 4, matrices: 8 }[list];
    for (let n = 1; n <= count; n++) {
      const name = strips.find((s) => s.index === n)?.name;
      options.push({ value: `${token}.${n}`, label: `${label} ${n}${name ? ` · ${name}` : ""}` });
    }
  }
  return options;
}

const SOURCE_PREFIXES = [
  ["MAIN", "mains", "Main"],
  ["MTX", "matrices", "Matrix"],
  ["BUS", "buses", "Bus"],
  ["AUX", "auxes", "Aux"],
] as const;
const DIRECT_IN_PREFIXES = [
  ["CH", "channels", "Channel"],
  ["AUX", "auxes", "Aux"],
  ["BUS", "buses", "Bus"],
  ["MAIN", "mains", "Main"],
  ["MTX", "matrices", "Matrix"],
] as const;

/** One control-room monitor bus (A = 1, B = 2): what it plays, how loud, and its dim/limit/delay. */
function MonitorBusCard({ bus, lists }: { bus: 1 | 2; lists: SourceLists | undefined }) {
  const query = useMonitorBus(bus);
  const [local, setLocal] = useState<WingMonitorBusPatch>({});
  const [error, setError] = useState<string | null>(null);
  const title = `Monitor ${bus === 1 ? "A" : "B"}`;
  if (query.isError) return <ErrorCard title={title} error={query.error} />;
  if (!query.data) return <LoadingCard title={title} />;
  const mon: WingMonitorBus = { ...query.data, ...local };
  const onLocal = (patch: WingMonitorBusPatch) => setLocal((prev) => ({ ...prev, ...patch }));
  const send = (patch: WingMonitorBusPatch) => {
    setError(null);
    setMonitorBus(bus, patch).catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  };
  const set = (patch: WingMonitorBusPatch) => {
    onLocal(patch);
    send(patch);
  };
  const slider = (field: keyof WingMonitorBusPatch, label: string, min: number, max: number, step: number, format: (v: number) => string) => (
    <MonitorSlider
      label={label}
      value={Number(mon[field])}
      min={min}
      max={max}
      step={step}
      format={format}
      onLocal={(v) => onLocal({ [field]: v })}
      commit={(v) => send({ [field]: v })}
    />
  );
  const dB = (v: number) => `${v.toFixed(0)} dB`;

  return (
    <div className="mixer-stage-group">
      <div className="mixer-processing-card__header">
        <h3>{title}</h3>
        <span className="monitor-level" title={mon.levelReadOnly ? "Set with the console's monitor knob" : undefined}>
          Level {formatDb(mon.levelDb)}
        </span>
      </div>
      <div className="param-panel">
        <div className="param-field">
          <span className="param-field__label">Source</span>
          <select value={mon.source} onChange={(event) => set({ source: event.target.value })}>
            {sourceOptions(SOURCE_PREFIXES, lists).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <MonitorFader label="Source level" value={mon.sourceLevelDb} onLocal={(v) => onLocal({ sourceLevelDb: v })} commit={(v) => send({ sourceLevelDb: v })} />
        <div className="param-field">
          <span className="param-field__label">Direct in</span>
          <select value={mon.directIn} onChange={(event) => set({ directIn: event.target.value })}>
            {sourceOptions(DIRECT_IN_PREFIXES, lists).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <MonitorFader label="Direct in mix" value={mon.sourceMixDb} onLocal={(v) => onLocal({ sourceMixDb: v })} commit={(v) => send({ sourceMixDb: v })} />
        {slider("dimLevelDb", "Dim", 0, 40, 1, (v) => `-${v.toFixed(0)} dB`)}
        {slider("pflDimDb", "PFL dim", 0, 40, 1, (v) => `-${v.toFixed(0)} dB`)}
        {slider("bandSoloTrimDb", "Band solo trim", 0, 24, 1, dB)}
        {slider("limiterDb", "Limiter", -40, 0, 1, dB)}
        {slider("pan", "Pan", -100, 100, 1, formatPan)}
        {slider("width", "Width", -150, 150, 5, (v) => `${v.toFixed(0)} %`)}
        <div className="param-field">
          <span className="param-field__label">Polarity</span>
          <Toggle label="Invert" on={mon.invert} onChange={(invert) => set({ invert })} />
        </div>
        <div className="param-field">
          <span className="param-field__label">Delay</span>
          <Toggle label={mon.delayOn ? "On" : "Off"} on={mon.delayOn} onChange={(delayOn) => set({ delayOn })} />
        </div>
        {mon.delayOn && slider("delayMeters", "Distance", 0.1, 100, 0.1, (v) => `${v.toFixed(1)} m`)}
        {error && <p className="error">{error}</p>}
      </div>
    </div>
  );
}

/**
 * Solo safe, channel by channel: a safe strip keeps playing when another one is soloed in place.
 * Chips in each strip's colour, lit while safe.
 */
function SoloSafeCard({
  channels,
  auxes,
  onChannelLocal,
  onAuxLocal,
}: {
  channels: WingChannelStrip[];
  auxes: WingChannelStrip[];
  onChannelLocal: (index: number, patch: Partial<WingChannelStrip>) => void;
  onAuxLocal: (index: number, patch: Partial<WingChannelStrip>) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const chips = (type: "channel" | "aux", strips: WingChannelStrip[], onLocal: typeof onChannelLocal) =>
    strips.map((strip) => {
      const hex = wingColorHex(strip.col);
      const label = strip.name || `${type === "aux" ? "Aux" : "Ch"} ${strip.index}`;
      return (
        <button
          key={`${type}${strip.index}`}
          type="button"
          className={strip.soloSafe ? "safe-chip safe-chip--on" : "safe-chip"}
          style={hex ? { borderLeftColor: hex } : undefined}
          aria-pressed={strip.soloSafe}
          title={`${type === "aux" ? "Aux" : "Channel"} ${strip.index}${strip.soloSafe ? " — solo safe" : ""}`}
          onClick={() => {
            const next = !strip.soloSafe;
            onLocal(strip.index, { soloSafe: next });
            setError(null);
            setStripSoloSafe(type, strip.index, next).catch((err: unknown) => {
              onLocal(strip.index, { soloSafe: !next });
              setError(err instanceof Error ? err.message : String(err));
            });
          }}
        >
          {label}
        </button>
      );
    });

  return (
    <div className="mixer-stage-group">
      <div className="mixer-processing-card__header">
        <h3>Solo safe</h3>
      </div>
      <p className="card-hint">A safe strip keeps playing while another one is soloed in place: talkback, click, the pastor's mic.</p>
      <h4 className="safe-chips__title">Channels</h4>
      <div className="safe-chips">{chips("channel", channels, onChannelLocal)}</div>
      <h4 className="safe-chips__title">Aux</h4>
      <div className="safe-chips">{chips("aux", auxes, onAuxLocal)}</div>
      {error && <p className="error">{error}</p>}
    </div>
  );
}

function LoadingCard({ title }: { title: string }) {
  return (
    <div className="mixer-stage-group">
      <h3>{title}</h3>
      <p className="card-hint">Loading…</p>
    </div>
  );
}

function ErrorCard({ title, error }: { title: string; error: unknown }) {
  return (
    <div className="mixer-stage-group">
      <h3>{title}</h3>
      <p className="error">{error instanceof Error ? error.message : String(error)}</p>
    </div>
  );
}

/** The Monitor section: solo behaviour, the two monitor buses, and solo safe. */
export function MonitorSection({
  state,
  onChannelLocal,
  onAuxLocal,
}: {
  state: WingMixerState | undefined;
  onChannelLocal: (index: number, patch: Partial<WingChannelStrip>) => void;
  onAuxLocal: (index: number, patch: Partial<WingChannelStrip>) => void;
}): JSX.Element {
  return (
    <div className="mixer-processing">
      <div className="mixer-stage-groups">
        <MonitorBusCard bus={1} lists={state} />
        <MonitorBusCard bus={2} lists={state} />
        <SoloConfigCard />
        {state && <SoloSafeCard channels={state.channels} auxes={state.auxes} onChannelLocal={onChannelLocal} onAuxLocal={onAuxLocal} />}
      </div>
    </div>
  );
}
