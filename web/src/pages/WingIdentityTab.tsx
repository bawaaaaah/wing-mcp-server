import { useEffect, useRef, useState, type JSX } from "react";
import { setWingValue, useInputPatch, useIoIn, useSetSrcAuto, type WingChannelStrip, type WingStageStrip } from "../api/queries.js";
import { useOptimisticWrites } from "../api/useOptimisticWrites.js";
import { useUrlStrip, type StripKind } from "../api/useUrlStrip.js";
import { ColorField, IconField } from "../components/ParamPanel.js";
import { sourceLabel } from "./StripActions.js";
import { IoPhysicalPropertiesPanel, ProcessingCard } from "./WingMixerTab.js";
import { useWingMixer } from "./useWingMixer.js";

type IdentityStripType = "channel" | "aux" | "bus" | "main" | "matrix";
/** The strip types plus "source" (a physical input — Local In / AES50 / AES / USB / card …). */
type IdentityTarget = IdentityStripType | "source";
const IDENTITY_TARGETS: readonly IdentityTarget[] = ["channel", "aux", "bus", "main", "matrix", "source"];
const IS_ROUTABLE: Record<IdentityStripType, boolean> = { channel: true, aux: true, bus: false, main: false, matrix: false };
const STRIP_LABEL: Record<IdentityStripType, string> = { channel: "Channel", aux: "Aux", bus: "Bus", main: "Main", matrix: "Matrix" };
const TARGET_LABEL: Record<IdentityTarget, string> = { ...STRIP_LABEL, source: "Source" };
const STRIP_PATH_PREFIX: Record<IdentityStripType, string> = { channel: "/ch", aux: "/aux", bus: "/bus", main: "/main", matrix: "/mtx" };
const STAGE_LIST: Record<Exclude<IdentityStripType, "channel" | "aux">, "buses" | "mains" | "matrices"> = { bus: "buses", main: "mains", matrix: "matrices" };
const TYPE_OF_KIND: Partial<Record<StripKind, IdentityStripType>> = { ch: "channel", aux: "aux", bus: "bus", main: "main", mtx: "matrix" };
const KIND_OF_TYPE: Record<IdentityStripType, StripKind> = { channel: "ch", aux: "aux", bus: "bus", main: "main", matrix: "mtx" };

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
 *
 * "Source" in the Type selector switches to editing a physical input (Local In / AES50 / AES / USB
 * / card …) directly — the same name/color/icon assignment, plus gain / 48V / polarity / mute —
 * regardless of whether that input is currently patched to any strip. It reuses the Mixer tab's
 * `IoPhysicalPropertiesPanel` (which brings its own group + index pickers).
 */
export function WingIdentityTab(): JSX.Element {
  const mixer = useWingMixer();
  // The strip is the URL's (see useUrlStrip), so a strip's "Name, colour & icon" menu item opens it
  // here; a DCA isn't edited here, and "Source" is this tab's own.
  const [strip, setStrip] = useUrlStrip();
  const stripType = (strip && TYPE_OF_KIND[strip.kind]) ?? "channel";
  const index = strip && TYPE_OF_KIND[strip.kind] ? strip.index : 1;
  const setIndex = (n: number) => setStrip({ kind: KIND_OF_TYPE[stripType], index: n });
  const [editingSource, setEditingSource] = useState(false);
  const target: IdentityTarget = editingSource ? "source" : stripType;
  const [srcGroup, setSrcGroup] = useState<string | null>(null);
  const [srcIndex, setSrcIndex] = useState(1);

  function selectTarget(next: IdentityTarget) {
    if (next === "source") {
      // Straight to the input the current strip is patched from, when it has one.
      const patched = (stripType === "channel" ? mixer.state?.channels : stripType === "aux" ? mixer.state?.auxes : undefined)?.find((s) => s.index === index)?.source;
      if (patched) {
        setSrcGroup(patched.group);
        setSrcIndex(patched.index);
      }
      setEditingSource(true);
      return;
    }
    setEditingSource(false);
    setStrip({ kind: KIND_OF_TYPE[next], index: 1 });
  }

  const isSource = target === "source";
  const list: IdentityStrip[] =
    !isSource && mixer.state
      ? { channel: mixer.state.channels, aux: mixer.state.auxes, bus: mixer.state.buses, main: mixer.state.mains, matrix: mixer.state.matrices }[
          target as IdentityStripType
        ]
      : [];
  const selected = list.find((s) => s.index === index);

  return (
    <section className="card mixer-processing">
      <div className="mixer-routing__select-row">
        <label className="mixer-routing__select">
          <span>Type</span>
          <select value={target} onChange={(event) => selectTarget(event.target.value as IdentityTarget)}>
            {IDENTITY_TARGETS.map((t) => (
              <option key={t} value={t}>
                {TARGET_LABEL[t]}
              </option>
            ))}
          </select>
        </label>
        {!isSource && (
          <>
            <label className="mixer-routing__select">
              <span>{TARGET_LABEL[target]}</span>
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
          </>
        )}
      </div>

      {isSource ? (
        <IoPhysicalPropertiesPanel
          direction="in"
          group={srcGroup}
          onGroupChange={setSrcGroup}
          index={srcIndex}
          onIndexChange={setSrcIndex}
        />
      ) : (
        <>
          {mixer.isError && <p className="error">{(mixer.error as Error).message}</p>}
          {selected && (
            <IdentityEditor
              key={`${target}-${index}`}
              type={target as IdentityStripType}
              index={index}
              strip={selected}
              onLocal={(patch) => {
                if (target === "channel") mixer.setChannelLocal(index, patch);
                else if (target === "aux") mixer.setAuxLocal(index, patch);
                else mixer.setStageLocal(STAGE_LIST[target as Exclude<IdentityStripType, "channel" | "aux">], index, patch);
              }}
            />
          )}
        </>
      )}
    </section>
  );
}

function IdentityEditor({
  type,
  index,
  strip,
  onLocal,
}: {
  type: IdentityStripType;
  index: number;
  strip: IdentityStrip;
  /** Shows a change on this strip in every view of the mixer. */
  onLocal: (patch: Partial<WingChannelStrip>) => void;
}) {
  const basePath = `${STRIP_PATH_PREFIX[type]}/${index}`;
  const routable = IS_ROUTABLE[type];

  const patchQuery = useInputPatch(routable ? (type as "channel" | "aux") : null, routable ? index : null);
  const setSrcAuto = useSetSrcAuto();
  // `strip.srcAuto` is a one-shot snapshot from the mixer-state dump, only refreshed afterward by
  // a live push on `clink` — which the real console may never send (unverified, see
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

  // A strip that follows its source shows the source's name, colour and icon — or, with nothing
  // patched, none at all (`$name` "", `$col` 1, verified on a WING Rack): its own are kept but
  // hidden, so writing them changes nothing anyone sees. Locked until it is unlinked.
  const locked = routable && srcAuto;
  const followed = source ? sourceLabel(source) : "";

  const [localName, setLocalName] = useState(strip.name);
  const editing = useRef(false);
  // Linking, unlinking, a rename on the console or a refused one put back changes the name shown;
  // the field follows it unless it is being typed in.
  useEffect(() => {
    if (!editing.current) setLocalName(strip.name);
  }, [strip.name]);

  // Name, colour and icon show at once (the console never pushes back a write of ours) and go back
  // when it does not take; why, under the fields, until the next write.
  const [writeError, setWriteError] = useState<string>();
  const writes = useOptimisticWrites<Partial<WingChannelStrip>>(onLocal, setWriteError);
  function write(key: "name" | "col" | "icon", what: string, value: number | string, shown: Partial<WingChannelStrip>, next: Partial<WingChannelStrip>) {
    setWriteError(undefined);
    writes.edit(key, shown, next);
    writes.send(key, what, setWingValue(`${basePath}/${key}`, value));
  }

  return (
    <div className="mixer-stage-group">
      <div className="mixer-processing-card__header">
        <h3>
          {STRIP_LABEL[type]} {index}
        </h3>
      </div>
      <div className="param-panel">
        <div className="param-field">
          <span className="param-field__label">Name</span>
          <input
            type="text"
            maxLength={16}
            value={localName}
            readOnly={locked}
            aria-readonly={locked}
            aria-describedby={locked ? "identity-lock" : undefined}
            className={locked ? "identity-name--locked" : undefined}
            title={locked ? (source ? `Follows ${followed}` : "Follows its source, with nothing patched") : undefined}
            onFocus={() => {
              editing.current = true;
            }}
            onChange={(event) => setLocalName(event.target.value)}
            onBlur={() => {
              editing.current = false;
              if (!locked && localName !== strip.name) write("name", "Name", localName, { name: strip.name }, { name: localName });
            }}
          />
        </div>
        {locked && source && (
          <p className="identity-lock" id="identity-lock">
            <span aria-hidden="true">🔒</span> Name, colour and icon follow <strong>{followed}</strong>. Rename it in{" "}
            <button
              type="button"
              className="link-button"
              onClick={() => {
                const card = document.getElementById("identity-source");
                card?.scrollIntoView({ behavior: "smooth", block: "start" });
                card?.querySelector<HTMLInputElement>("input[type=text]")?.focus({ preventScroll: true });
              }}
            >
              Attached source
            </button>{" "}
            below — every strip following it shows the new name — or switch Link to source to Custom.
          </p>
        )}
        {locked && !source && (
          <p className="identity-lock" id="identity-lock">
            <span aria-hidden="true">🔒</span> Name, colour and icon follow the source, and nothing is patched to this {type}: the
            console shows no name. Switch Link to source to Custom to name it.
          </p>
        )}
        <ColorField value={strip.col} disabled={locked} onChange={(col) => write("col", "Colour", col, { col: strip.col }, { col })} />
        <IconField value={strip.icon} disabled={locked} onChange={(icon) => write("icon", "Icon", icon, { icon: strip.icon }, { icon })} />
        {writeError && <p className="error">{writeError}</p>}

        {routable && (
          <>
            {patchQuery.isError && <p className="error">{(patchQuery.error as Error).message}</p>}
            {setSrcAuto.isError && <p className="error">{(setSrcAuto.error as Error).message}</p>}
            <div className="param-field">
              <span className="param-field__label">Link to source</span>
              <button
                className={srcAuto ? "mixer-mute mixer-mute--on" : "mixer-mute"}
                onClick={() => {
                  const linked = !srcAuto;
                  setSrcAuto.mutate(
                    { kind: type as "channel" | "aux", index, linked },
                    {
                      onSuccess: () => onLocal({ srcAuto: linked }),
                    },
                  );
                }}
                disabled={setSrcAuto.isPending || patchQuery.isLoading}
              >
                {srcAuto ? "Linked" : "Custom"}
              </button>
            </div>
            {source ? (
              !srcAuto && <p className="card-hint">Attached source: {followed} — link it to make this {type}'s name, colour and icon follow it.</p>
            ) : (
              <p className="card-hint">No physical source is currently patched to this {type}.</p>
            )}
          </>
        )}
      </div>

      {routable && source && (
        <div id="identity-source">
          <ProcessingCard title={`Attached source: ${followed}`} query={sourceQuery} basePath={`/io/in/${source.group}/${source.index}`} />
        </div>
      )}
    </div>
  );
}
