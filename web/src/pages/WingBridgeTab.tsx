import { useState, type JSX } from "react";
import {
  useBridgeStatus,
  useConfigureBridge,
  useDeleteBridgeProfile,
  useSaveBridgeProfile,
  type BridgeClient,
  type BridgeProfile,
  type BridgeSafes,
  useMixerState,
  useSetBridgeSafes,
  type BridgeSafeKind,
  type BridgeStatus,
  type WingMixerState,
} from "../api/queries.js";
import { wingColorHex } from "../components/ParamPanel.js";

const SECTIONS: readonly { kind: BridgeSafeKind; list: keyof WingMixerState; title: string; short: string; count: number }[] = [
  { kind: "ch", list: "channels", title: "Channels", short: "Ch", count: 40 },
  { kind: "aux", list: "auxes", title: "Aux", short: "Aux", count: 8 },
  { kind: "bus", list: "buses", title: "Buses", short: "Bus", count: 16 },
  { kind: "main", list: "mains", title: "Mains", short: "Main", count: 4 },
  { kind: "mtx", list: "matrices", title: "Matrices", short: "Mtx", count: 8 },
  { kind: "dca", list: "dcas", title: "DCAs", short: "DCA", count: 16 },
];

const SAFE_HELP: Record<BridgeSafeKind, string> = {
  ch: "the strip and its patched input; its sends stay with their bus",
  aux: "the strip and its patched input; its sends stay with their bus",
  bus: "the bus and every send coming into it",
  main: "the main and every assign coming into it",
  mtx: "the matrix and every send coming into it",
  dca: "the DCA",
};

function time(ms: number): string {
  return new Date(ms).toLocaleTimeString();
}

/**
 * Tablets and OSC apps connect to the server instead of the console. Strips marked safe here cannot
 * be changed from them (the dashboard and MCP tools are not restricted). Every change is saved in
 * the plugin config, like the Config tab.
 */
export function WingBridgeTab(): JSX.Element {
  const status = useBridgeStatus();
  // The profile being written, shared so a connected app's row can start one.
  const [draft, setDraft] = useState<BridgeProfile | null>(null);

  if (status.isLoading) return <p>Loading bridge...</p>;
  if (status.isError) return <p className="error">{(status.error as Error).message}</p>;
  if (!status.data) return <></>;

  return (
    <>
      <BridgeStatusCard status={status.data} />
      <SafeStripsCard status={status.data} />
      <BridgeClientsCard status={status.data} onProfile={(client) => setDraft(profileFromClient(client, status.data.profiles))} />
      <DeviceProfilesCard status={status.data} draft={draft} setDraft={setDraft} />
      <RecentBlocksCard status={status.data} />
    </>
  );
}

function BridgeStatusCard({ status }: { status: BridgeStatus }) {
  const configure = useConfigureBridge();
  const [port, setPort] = useState(String(status.osc?.port ?? 2223));
  const listening = status.osc?.listening ?? false;
  const pill = !status.enabled ? "" : listening ? " status-pill--ok" : " status-pill--error";
  const label = !status.enabled ? "Off" : listening ? `Listening for OSC on port ${status.osc?.port}` : "Not listening";

  return (
    <section className="card">
      <div className="mixer-processing-card__header">
        <h3>Bridge</h3>
        <span className={"status-pill" + pill}>
          <span className="status-pill__dot" />
          {label}
        </span>
      </div>
      <p className="card-hint">
        OSC apps (TouchOSC, Companion…) and the console's own apps (WING-Q, Co-Pilot, WING Edit) point at this server
        instead of the console. The console then sees a single connection per protocol, and the strips marked safe
        below cannot be changed from those apps. Safes only hold if the apps cannot reach the console directly: keep
        it on its own network, VLAN or behind a firewall.
      </p>
      <div className="mixer-fade-actions">
        <button type="button" disabled={configure.isPending} onClick={() => configure.mutate({ enabled: !status.enabled })}>
          {status.enabled ? "Turn bridge off" : "Turn bridge on"}
        </button>
        <label className="json-schema-form__field">
          <span>OSC port</span>
          <input type="number" min={1} max={65535} value={port} onChange={(event) => setPort(event.target.value)} />
        </label>
        <button
          type="button"
          disabled={configure.isPending || Number(port) === status.osc?.port || !Number.isInteger(Number(port))}
          onClick={() => configure.mutate({ oscPort: Number(port) })}
        >
          Apply port
        </button>
        <label className="json-schema-form__field json-schema-form__field--checkbox">
          <input
            type="checkbox"
            checked={status.protectGlobal}
            disabled={configure.isPending}
            onChange={(event) => configure.mutate({ protectGlobal: event.target.checked })}
          />
          <span>Also lock scene recall and console config while anything is safe</span>
        </label>
      </div>
      <NativeAppsSection status={status} />
      {configure.isError && <p className="error">{configure.error.message}</p>}
      {status.lastError && <p className="error">{status.lastError}</p>}
      {status.osc && status.enabled && (
        <dl className="kv-list">
          <dt>Interface</dt>
          <dd>{status.bindAddress || "every interface"}</dd>
          <dt>Traffic</dt>
          <dd>
            {status.osc.messagesIn} in · {status.osc.forwarded} forwarded · {status.osc.pushesSent} pushed · {status.osc.blocked} blocked
          </dd>
        </dl>
      )}
    </section>
  );
}

const MAP_STATE_TEXT: Record<string, string> = {
  idle: "not needed yet",
  walking: "mapping the safe strips… native writes wait until it is done",
  ready: "ready",
  error: "failed — native writes stay blocked while anything is safe",
};

/** WING-Q / Co-Pilot / WING Edit: one console connection for all of them, and WING? discovery. */
function NativeAppsSection({ status }: { status: BridgeStatus }) {
  const configure = useConfigureBridge();
  const proxy = status.native.proxy;
  const responder = status.discovery.responder;
  const [port, setPort] = useState(String(proxy?.listenPort ?? 2222));

  return (
    <>
      <h4>Native apps (WING-Q, Co-Pilot, WING Edit)</h4>
      <p className="card-hint">
        Beta: built from the console's protocol documentation, not yet checked against a real tablet. All native apps
        share one connection to the console; their meters come from the server's own meter stream.
      </p>
      <div className="mixer-fade-actions">
        <label className="json-schema-form__field json-schema-form__field--checkbox">
          <input
            type="checkbox"
            checked={status.native.enabled}
            disabled={configure.isPending}
            onChange={(event) => configure.mutate({ native: event.target.checked })}
          />
          <span>Serve native apps</span>
        </label>
        <label className="json-schema-form__field json-schema-form__field--checkbox">
          <input
            type="checkbox"
            checked={status.discovery.enabled}
            disabled={configure.isPending || !status.native.enabled}
            onChange={(event) => configure.mutate({ discovery: event.target.checked })}
          />
          <span>Answer discovery (apps list the bridge)</span>
        </label>
        <label className="json-schema-form__field">
          <span>Native port</span>
          <input type="number" min={1} max={65535} value={port} onChange={(event) => setPort(event.target.value)} />
        </label>
        <button
          type="button"
          disabled={configure.isPending || Number(port) === proxy?.listenPort || !Number.isInteger(Number(port))}
          onClick={() => configure.mutate({ nativePort: Number(port) })}
        >
          Apply port
        </button>
      </div>
      {status.enabled && status.native.enabled && (
        <dl className="kv-list">
          <dt>Listener</dt>
          <dd>{proxy?.listening ? `TCP ${proxy.listenPort}` : "not listening"}</dd>
          <dt>Console link</dt>
          <dd>{proxy?.upstream ?? "disconnected"} (one connection for every native app)</dd>
          <dt>Node map</dt>
          <dd>
            {MAP_STATE_TEXT[proxy?.map.state ?? "idle"]}
            {proxy && proxy.map.nodes > 0 ? ` · ${proxy.map.nodes} nodes` : ""}
            {proxy?.map.lastError ? ` · ${proxy.map.lastError}` : ""}
          </dd>
          <dt>Meters</dt>
          <dd>
            {status.native.meters.streaming}/{status.native.meters.tablets} apps streaming · {status.native.meters.extraGroups} extra groups
          </dd>
          {status.discovery.enabled && (
            <>
              <dt>Discovery</dt>
              <dd>
                {responder?.advertised
                  ? `answering as “${responder.advertised.name}” (serial ${responder.advertised.serial}) · ${responder.queries} queries`
                  : (responder?.lastError ?? "waiting for the console's identity")}
              </dd>
            </>
          )}
          {proxy?.lastError && (
            <>
              <dt>Last error</dt>
              <dd className="error">{proxy.lastError}</dd>
            </>
          )}
        </dl>
      )}
    </>
  );
}

function SafeStripsCard({ status }: { status: BridgeStatus }) {
  const mixer = useMixerState();
  const setSafes = useSetBridgeSafes();
  // Shown at once; the server's answer then replaces it.
  const [pending, setPending] = useState<Map<string, boolean>>(new Map());

  const isSafe = (kind: BridgeSafeKind, index: number) => pending.get(`${kind}:${index}`) ?? status.safes[kind].includes(index);

  function flip(kind: BridgeSafeKind, index: number) {
    const key = `${kind}:${index}`;
    const on = !isSafe(kind, index);
    setPending((prev) => new Map(prev).set(key, on));
    setSafes.mutate(
      { mode: on ? "add" : "remove", [kind]: [index] },
      {
        onSettled: () =>
          setPending((prev) => {
            const next = new Map(prev);
            next.delete(key);
            return next;
          }),
      },
    );
  }

  const stateText =
    status.safesState === "resolving"
      ? "Reading the safe channels' input patch… every input is locked until then."
      : `${status.safeCount} safe`;

  return (
    <section className="card">
      <div className="mixer-processing-card__header">
        <h3>Safe strips</h3>
        <span className="card-hint">{stateText}</span>
        <button type="button" disabled={status.safeCount === 0 || setSafes.isPending} onClick={() => setSafes.mutate({ mode: "replace" })}>
          Clear all
        </button>
      </div>
      {SECTIONS.map(({ kind, list, title, short, count }) => {
        const strips: { index: number; name: string; col?: number }[] =
          (mixer.data?.[list] as { index: number; name: string; col?: number }[] | undefined) ??
          Array.from({ length: count }, (_, i) => ({ index: i + 1, name: "" }));
        return (
          <div key={kind}>
            <h4 className="safe-chips__title" title={`A safe ${title.toLowerCase()} entry locks ${SAFE_HELP[kind]}.`}>
              {title}
            </h4>
            <div className="safe-chips">
              {strips.map((strip) => {
                const on = isSafe(kind, strip.index);
                const hex = strip.col !== undefined ? wingColorHex(strip.col) : undefined;
                return (
                  <button
                    key={strip.index}
                    type="button"
                    className={on ? "safe-chip safe-chip--on" : "safe-chip"}
                    style={hex ? { borderLeftColor: hex } : undefined}
                    aria-pressed={on}
                    title={`${short} ${strip.index}${on ? ` — safe: ${SAFE_HELP[kind]}` : ""}`}
                    onClick={() => flip(kind, strip.index)}
                  >
                    {strip.name || `${short} ${strip.index}`}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
      {setSafes.isError && <p className="error">{setSafes.error.message}</p>}
    </section>
  );
}

function emptySafes(): BridgeSafes {
  return { ch: [], aux: [], bus: [], main: [], mtx: [], dca: [] };
}

function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .normalize("NFD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "device"
  );
}

/** A new profile matching a connected app: its MAC when known (stable), else its IP, plus its model. */
function profileFromClient(client: BridgeClient, existing: BridgeProfile[]): BridgeProfile {
  const name = client.identity.model ?? client.address;
  let id = slug(name);
  for (let n = 2; existing.some((p) => p.id === id); n++) id = `${slug(name)}-${n}`;
  const match = client.identity.mac ? { mac: client.identity.mac } : { ip: client.address };
  return { id, name, match: { ...match, ...(client.identity.model ? { model: client.identity.model } : {}) }, mode: "allow", scope: "mix", allow: emptySafes(), safes: emptySafes() };
}

function listText(safes: BridgeSafes): string {
  return SECTIONS.filter(({ kind }) => safes[kind].length > 0)
    .map(({ kind, short }) => `${short} ${safes[kind].join(", ")}`)
    .join(" · ");
}

function rightsText(profile: BridgeProfile): string {
  if (profile.mode === "safes") return `extra safes: ${listText(profile.safes) || "none"}`;
  return `only ${listText(profile.allow) || "nothing"} — ${profile.scope === "mix" ? "mix: the bus itself, levels/pan of its sends" : "everything"}`;
}

function matchText(match: BridgeProfile["match"]): string {
  return [match.mac && `MAC ${match.mac}`, match.ip && `IP ${match.ip}`, match.model && `model ${match.model}`].filter(Boolean).join(" + ");
}

function BridgeClientsCard({ status, onProfile }: { status: BridgeStatus; onProfile: (client: BridgeClient) => void }) {
  const profileName = (id: string | null | undefined) => (id === undefined ? "identifying…" : id === null ? "global safes" : (status.profiles.find((p) => p.id === id)?.name ?? id));
  return (
    <section className="card">
      <h3>Connected apps</h3>
      {status.clients.length === 0 ? (
        <p className="card-hint">No app has talked to the bridge recently.</p>
      ) : (
        <div className="table-scroll">
          <table className="plugin-table">
            <thead>
              <tr>
                <th>App</th>
                <th>Device</th>
                <th>Rights</th>
                <th>Writes</th>
                <th>Blocked</th>
                <th>Last seen</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {status.clients.map((client) => (
                <tr key={`${client.address}:${client.port}`}>
                  <td>
                    {client.address}:{client.port} <small>{client.transport.toUpperCase()}</small>
                  </td>
                  <td>
                    {client.identity.model ?? "—"}
                    {client.identity.mac && <small> {client.identity.mac}</small>}
                  </td>
                  <td>{profileName(client.identity.profile)}</td>
                  <td>{client.writesForwarded}</td>
                  <td>{client.writesBlocked}</td>
                  <td>{time(client.lastSeenAt)}</td>
                  <td>
                    {!client.identity.profile && (
                      <button type="button" onClick={() => onProfile(client)} title="Give this device its own rights">
                        Profile…
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** Per-device rights: who may change what, recognised by MAC, IP and/or model. */
function DeviceProfilesCard({ status, draft, setDraft }: { status: BridgeStatus; draft: BridgeProfile | null; setDraft: (p: BridgeProfile | null) => void }) {
  const remove = useDeleteBridgeProfile();
  return (
    <section className="card">
      <div className="mixer-processing-card__header">
        <h3>Device profiles</h3>
        <button
          type="button"
          onClick={() => setDraft({ id: "", name: "", match: {}, mode: "allow", scope: "mix", allow: emptySafes(), safes: emptySafes() })}
        >
          New profile
        </button>
      </div>
      <p className="card-hint">
        Give one device its own rights, e.g. a musician's tablet that may only mix its in-ear bus. A device no profile
        matches gets the global safes above, which always apply on top.
      </p>
      {status.profiles.length > 0 && (
        <div className="table-scroll">
          <table className="plugin-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Recognised by</th>
                <th>Rights</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {status.profiles.map((profile) => (
                <tr key={profile.id}>
                  <td>{profile.name}</td>
                  <td>{matchText(profile.match)}</td>
                  <td>{rightsText(profile)}</td>
                  <td>
                    <button type="button" onClick={() => setDraft(profile)}>
                      Edit
                    </button>{" "}
                    <button type="button" disabled={remove.isPending} onClick={() => remove.mutate(profile.id)}>
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {remove.isError && <p className="error">{remove.error.message}</p>}
      {draft && <ProfileEditor key={draft.id || "new"} initial={draft} onDone={() => setDraft(null)} />}
    </section>
  );
}

function parseList(text: string): number[] {
  return [...new Set(text.split(/[\s,;]+/).map(Number).filter((n) => Number.isInteger(n) && n >= 1))].sort((a, b) => a - b);
}

function ProfileEditor({ initial, onDone }: { initial: BridgeProfile; onDone: () => void }) {
  const save = useSaveBridgeProfile();
  const [profile, setProfile] = useState(initial);
  const lists = profile.mode === "allow" ? profile.allow : profile.safes;
  const [texts, setTexts] = useState<Record<string, string>>(() => Object.fromEntries(SECTIONS.map(({ kind }) => [kind, lists[kind].join(", ")])));
  const set = (patch: Partial<BridgeProfile>) => setProfile((p) => ({ ...p, ...patch }));
  const setMatch = (key: "ip" | "mac" | "model", value: string) => set({ match: { ...profile.match, [key]: value.trim() || undefined } });

  function submit() {
    const strips = Object.fromEntries(SECTIONS.map(({ kind }) => [kind, parseList(texts[kind] ?? "")])) as BridgeSafes;
    const id = profile.id || slug(profile.name);
    const next = { ...profile, id, ...(profile.mode === "allow" ? { allow: strips, safes: emptySafes() } : { safes: strips, allow: emptySafes() }) };
    save.mutate(next, { onSuccess: onDone });
  }

  return (
    <div className="profile-editor">
      <h4>{initial.id ? `Edit “${initial.name}”` : "New profile"}</h4>
      <div className="mixer-fade-actions">
        <label className="json-schema-form__field">
          <span>Name</span>
          <input value={profile.name} onChange={(e) => set({ name: e.target.value })} placeholder="Drummer's tablet" />
        </label>
        <label className="json-schema-form__field">
          <span>MAC</span>
          <input value={profile.match.mac ?? ""} onChange={(e) => setMatch("mac", e.target.value)} placeholder="d2:e2:2d:b9:f4:86" />
        </label>
        <label className="json-schema-form__field">
          <span>IP</span>
          <input value={profile.match.ip ?? ""} onChange={(e) => setMatch("ip", e.target.value)} placeholder="192.168.20.20" />
        </label>
        <label className="json-schema-form__field">
          <span>Model</span>
          <input value={profile.match.model ?? ""} onChange={(e) => setMatch("model", e.target.value)} placeholder="SM-X700" />
        </label>
      </div>
      <div className="mixer-fade-actions">
        <label className="json-schema-form__field">
          <span>Rights</span>
          <select value={profile.mode} onChange={(e) => set({ mode: e.target.value as BridgeProfile["mode"] })}>
            <option value="allow">Only these strips</option>
            <option value="safes">Extra safe strips</option>
          </select>
        </label>
        {profile.mode === "allow" && (
          <label className="json-schema-form__field">
            <span>On them</span>
            <select value={profile.scope} onChange={(e) => set({ scope: e.target.value as BridgeProfile["scope"] })}>
              <option value="mix">Mix: its own bus (not its sends out), levels/pan of the sends into it</option>
              <option value="full">Everything (EQ, dynamics…)</option>
            </select>
          </label>
        )}
      </div>
      <p className="card-hint">
        {profile.mode === "allow"
          ? "Strip numbers this device may change; everything else is read-only for it. For a bus, main or matrix that includes every send into it."
          : "Strip numbers this device may not change, on top of the global safes."}
      </p>
      <div className="mixer-fade-actions">
        {SECTIONS.map(({ kind, short }) => (
          <label key={kind} className="json-schema-form__field">
            <span>{short}</span>
            <input value={texts[kind] ?? ""} onChange={(e) => setTexts((t) => ({ ...t, [kind]: e.target.value }))} placeholder="e.g. 3, 5" size={8} />
          </label>
        ))}
      </div>
      <div className="mixer-fade-actions">
        <button type="button" disabled={save.isPending || !profile.name.trim() || !(profile.match.ip || profile.match.mac || profile.match.model)} onClick={submit}>
          Save profile
        </button>
        <button type="button" onClick={onDone}>
          Cancel
        </button>
      </div>
      {save.isError && <p className="error">{save.error.message}</p>}
    </div>
  );
}

function RecentBlocksCard({ status }: { status: BridgeStatus }) {
  return (
    <section className="card">
      <h3>Recently blocked writes</h3>
      {status.recentBlocks.length === 0 ? (
        <p className="card-hint">Nothing blocked yet.</p>
      ) : (
        <div className="table-scroll">
          <table className="plugin-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>App</th>
                <th>Path</th>
                <th>Protected by</th>
              </tr>
            </thead>
            <tbody>
              {status.recentBlocks.map((block, i) => (
                <tr key={`${block.at}-${i}`}>
                  <td>{time(block.at)}</td>
                  <td>{block.client}</td>
                  <td>
                    <code>{block.path}</code>
                  </td>
                  <td>{block.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
