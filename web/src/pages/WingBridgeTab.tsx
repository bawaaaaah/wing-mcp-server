import { useState, type JSX } from "react";
import {
  useBridgeStatus,
  useConfigureBridge,
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

  if (status.isLoading) return <p>Loading bridge...</p>;
  if (status.isError) return <p className="error">{(status.error as Error).message}</p>;
  if (!status.data) return <></>;

  return (
    <>
      <BridgeStatusCard status={status.data} />
      <SafeStripsCard status={status.data} />
      <BridgeClientsCard status={status.data} />
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

function BridgeClientsCard({ status }: { status: BridgeStatus }) {
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
                <th>Subscribed</th>
                <th>Messages</th>
                <th>Writes</th>
                <th>Blocked</th>
                <th>Last seen</th>
              </tr>
            </thead>
            <tbody>
              {status.clients.map((client) => (
                <tr key={`${client.address}:${client.port}`}>
                  <td>
                    {client.address}:{client.port} <small>{client.transport.toUpperCase()}</small>
                  </td>
                  <td>{client.subscription ?? "—"}</td>
                  <td>{client.messages}</td>
                  <td>{client.writesForwarded}</td>
                  <td>{client.writesBlocked}</td>
                  <td>{time(client.lastSeenAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
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
