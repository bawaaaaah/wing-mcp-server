import { useState } from "react";
import { setWingValue, useInputPatch, useIoIn, useSetSrcAuto, type WingChannelStrip, type WingStageStrip } from "../api/queries.js";
import { ColorField, IconField } from "../components/ParamPanel.js";
import { ProcessingCard } from "./WingMixerTab.js";
import { useWingMixer } from "./useWingMixer.js";

type IdentityStripType = "channel" | "aux" | "bus" | "main" | "matrix";
const IDENTITY_STRIP_TYPES: readonly IdentityStripType[] = ["channel", "aux", "bus", "main", "matrix"];
const IS_ROUTABLE: Record<IdentityStripType, boolean> = { channel: true, aux: true, bus: false, main: false, matrix: false };
const STRIP_LABEL: Record<IdentityStripType, string> = { channel: "Channel", aux: "Aux", bus: "Bus", main: "Main", matrix: "Matrix" };
const STRIP_PATH_PREFIX: Record<IdentityStripType, string> = { channel: "/ch", aux: "/aux", bus: "/bus", main: "/main", matrix: "/mtx" };

type IdentityStrip = WingChannelStrip | WingStageStrip;

function hasSrcAuto(strip: IdentityStrip): strip is WingChannelStrip {
  return "srcAuto" in strip;
}

/**
 * One tab for name/color/icon across every strip type that has them (channel/aux/bus/main/matrix —
 * DCA/mute groups have no icon and aren't in scope here), plus, for channel/aux, managing whether
 * the strip's name is linked to its physical source (`clink`, see wing-input-patch.ts) and editing
 * that source's own identity directly — the only way to change what's actually displayed while
 * linked, since the strip's own name field is silently ignored in that state.
 */
export function WingIdentityTab() {
  const mixer = useWingMixer();
  const [type, setType] = useState<IdentityStripType>("channel");
  const [index, setIndex] = useState(1);

  function selectType(next: IdentityStripType) {
    setType(next);
    setIndex(1);
  }

  const list: IdentityStrip[] = mixer.state
    ? { channel: mixer.state.channels, aux: mixer.state.auxes, bus: mixer.state.buses, main: mixer.state.mains, matrix: mixer.state.matrices }[type]
    : [];
  const selected = list.find((s) => s.index === index);

  return (
    <div className="mixer-processing">
      <div className="mixer-routing__select-row">
        <label className="mixer-routing__select">
          <span>Type</span>
          <select value={type} onChange={(event) => selectType(event.target.value as IdentityStripType)}>
            {IDENTITY_STRIP_TYPES.map((t) => (
              <option key={t} value={t}>
                {STRIP_LABEL[t]}
              </option>
            ))}
          </select>
        </label>
        <label className="mixer-routing__select">
          <span>{STRIP_LABEL[type]}</span>
          <select value={index} onChange={(event) => setIndex(Number(event.target.value))}>
            {list.map((s) => (
              <option key={s.index} value={s.index}>
                {s.index}: {s.name || (hasSrcAuto(s) && s.srcAuto ? "(linked to source)" : "(unnamed)")}
              </option>
            ))}
          </select>
        </label>
        <button className="mixer-refresh" onClick={mixer.refresh} disabled={mixer.isLoading}>
          {mixer.isLoading ? "Loading..." : "Refresh"}
        </button>
      </div>

      {mixer.isError && <p className="error">{(mixer.error as Error).message}</p>}
      {selected && (
        <IdentityEditor
          key={`${type}-${index}`}
          type={type}
          index={index}
          strip={selected}
          setChannelLocal={mixer.setChannelLocal}
          setAuxLocal={mixer.setAuxLocal}
        />
      )}
    </div>
  );
}

function IdentityEditor({
  type,
  index,
  strip,
  setChannelLocal,
  setAuxLocal,
}: {
  type: IdentityStripType;
  index: number;
  strip: IdentityStrip;
  setChannelLocal: (index: number, patch: Partial<WingChannelStrip>) => void;
  setAuxLocal: (index: number, patch: Partial<WingChannelStrip>) => void;
}) {
  const basePath = `${STRIP_PATH_PREFIX[type]}/${index}`;
  const routable = IS_ROUTABLE[type];

  const patchQuery = useInputPatch(routable ? (type as "channel" | "aux") : null, routable ? index : null);
  const setSrcAuto = useSetSrcAuto();
  // `strip.srcAuto` is a one-shot snapshot from the mixer-state dump, only refreshed afterward by
  // an SSE push on `clink` — which the real console may never send (unverified, see
  // project_wing_srcauto_feature memory). `patchQuery` fetches this exact field independently and
  // IS reliably refetched right after a successful toggle (see the mutate() call below), so once
  // it has loaded it is the authoritative value; the strip snapshot is only a placeholder before
  // that first load completes, so the button isn't stuck showing whatever it looked like on the
  // initial ~92-request mixer snapshot.
  const srcAuto = patchQuery.data ? patchQuery.data.srcAuto : hasSrcAuto(strip) && strip.srcAuto;
  const source = patchQuery.data?.main ?? null;
  // Shown whenever a physical source is patched, regardless of whether the name link is on — the
  // patched source is useful context either way, not just while linked.
  const sourceQuery = useIoIn(source ? source.group : null, source ? source.index : null);

  const [localName, setLocalName] = useState(strip.name);

  return (
    <div className="mixer-stage-group">
      <div className="mixer-processing-card__header">
        <h3>
          {STRIP_LABEL[type]} {index}
        </h3>
      </div>
      <div className="param-panel">
        <div className="param-field">
          <span className="param-field__label">name</span>
          <input
            type="text"
            maxLength={16}
            value={localName}
            disabled={srcAuto}
            onChange={(event) => setLocalName(event.target.value)}
            onBlur={() => {
              if (!srcAuto) void setWingValue(`${basePath}/name`, localName);
            }}
          />
        </div>
        <ColorField value={strip.col} onChange={(next) => void setWingValue(`${basePath}/col`, next)} />
        <IconField value={strip.icon} onChange={(next) => void setWingValue(`${basePath}/icon`, next)} />

        {routable && (
          <>
            {patchQuery.isError && <p className="error">{(patchQuery.error as Error).message}</p>}
            {setSrcAuto.isError && <p className="error">{(setSrcAuto.error as Error).message}</p>}
            <div className="param-field">
              <span className="param-field__label">Link customization to source</span>
              <button
                className={srcAuto ? "mixer-mute mixer-mute--on" : "mixer-mute"}
                onClick={() => {
                  const linked = !srcAuto;
                  setSrcAuto.mutate(
                    { kind: type as "channel" | "aux", index, linked },
                    {
                      onSuccess: () => {
                        const patch: Partial<WingChannelStrip> = { srcAuto: linked };
                        if (type === "channel") setChannelLocal(index, patch);
                        else setAuxLocal(index, patch);
                      },
                    },
                  );
                }}
                disabled={setSrcAuto.isPending || patchQuery.isLoading}
              >
                {srcAuto ? "Linked" : "Custom"}
              </button>
            </div>
            {source ? (
              <p>
                Attached source: {source.group}
                {source.index}
                {srcAuto
                  ? " — this name mirrors it, so the name field above is ignored while linked. Edit the source's own identity below, or turn linking off to give this " +
                    type +
                    " its own independent name again."
                  : ` — turn linking on to make this ${type}'s name/customization follow it automatically.`}
              </p>
            ) : (
              <p>No physical source is currently patched to this {type}.</p>
            )}
          </>
        )}
      </div>

      {routable && source && (
        <ProcessingCard
          title={`Attached source: ${source.group}${source.index}`}
          query={sourceQuery}
          basePath={`/io/in/${source.group}/${source.index}`}
        />
      )}
    </div>
  );
}
