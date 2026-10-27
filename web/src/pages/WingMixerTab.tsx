import { useEffect, useMemo, useRef, useState, type CSSProperties, type JSX, type ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  bulkSetWing,
  setWingValue,
  useAutoCompress,
  useGroupMembers,
  useAutoGate,
  useAutogain,
  useAuxDyn,
  useAuxEq,
  useAuxInConn,
  useAuxSends,
  useBusSends,
  EASING_NAMES,
  useCancelFade,
  useChannelDyn,
  useChannelEq,
  useChannelGate,
  useChannelInConn,
  useChannelProc,
  useChannelSends,
  useDelay,
  useFade,
  useFx,
  useGroups,
  useInputPatch,
  useInsert,
  useIoGroups,
  useIoIn,
  useIoOut,
  useIoRoutedChannels,
  useMainSends,
  useMatrixDirectInput,
  useSetAltSourceActive,
  useSetChannelProc,
  useSetSrcAuto,
  useSetDelay,
  useSetInsert,
  useSetMatrixDirectInput,
  useStripDyn,
  useStripEq,
  useToggleGroup,
  type AutoCompressBlock,
  type AutoCompressTargetMode,
  type EasingName,
  type GroupMemberKind,
  type WingBusMtxSendState,
  type WingBusSends,
  type WingChannelSends,
  type WingChannelStrip,
  type WingDescribeParam,
  type WingGroups,
  type WingIoGroup,
  type WingMainSendState,
  type WingMainSends,
  type WingGroupMember,
  type WingMixerState,
  type WingMutegroupStrip,
  type WingParamPanel,
  type WingStageStrip,
} from "../api/queries.js";
import { useStripMeters } from "../api/useLive.js";
import { useThrottledCommit } from "../api/useThrottledCommit.js";
import { MeterBar } from "../components/MeterBar.js";
import { useUrlChoice } from "../api/useUrlChoice.js";
import { useUrlStrip, type StripKind } from "../api/useUrlStrip.js";
import { TabList } from "../components/TabList.js";
import { FX_PARAM_LABELS, ParamPanel, wingColorHex } from "../components/ParamPanel.js";
import { StripMeter, useRowMeters } from "../components/StripMeter.js";
import { WingIcon } from "../components/WingIcon.js";
import { FaderControl, formatDb, formatPan, SliderControl } from "../components/SliderControl.js";
import { useWingMixer } from "./useWingMixer.js";
import { SoloButton, SoloIndicator, SoloProvider, useSolo } from "./useSolo.js";
import { StripActionsProvider, StripRow, StripShortcutsButton, useStripList, type StripControls, type StripList } from "./StripActions.js";
import { MonitorSection } from "./WingMonitorSection.js";
import { GroupMembersEditor } from "./GroupMembersEditor.js";

type MixerSection = "channels" | "aux" | "stage" | "dca" | "mutegroups" | "routing" | "processing" | "fx" | "fade" | "io" | "monitor";
type StripType = "bus" | "main" | "mtx";
type FadeTargetType = "channel" | "aux" | "bus" | "main" | "mtx" | "dca";
type RoutingSourceType = "channel" | "aux" | "bus" | "main";

// Mirrors src/plugins/wing/wing-node-paths.ts — kept in sync by hand since the two workspaces
// (server/dashboard) don't share code; these are stable, documented OSC path templates.
const stagePathPrefix: Record<"buses" | "mains" | "matrices", string> = { buses: "/bus", mains: "/main", matrices: "/mtx" };
const sendToBusPath = (channel: number, busIndex: number) => `/ch/${channel}/send/${busIndex}`;
const sendToMatrixPath = (channel: number, mtxIndex: number) => `/ch/${channel}/send/MX${mtxIndex}`;
const sendToMainPath = (channel: number, mainIndex: number) => `/ch/${channel}/main/${mainIndex}`;
const sendToAuxBusPath = (aux: number, busIndex: number) => `/aux/${aux}/send/${busIndex}`;
const sendToAuxMatrixPath = (aux: number, mtxIndex: number) => `/aux/${aux}/send/MX${mtxIndex}`;
const sendToAuxMainPath = (aux: number, mainIndex: number) => `/aux/${aux}/main/${mainIndex}`;
// Bus/main as routing SOURCES — verified against real hardware: a bus can send to another bus, a
// matrix, or a main; a main can only send to a matrix (no send-to-main, no send-to-bus at all).
const sendBusToBusPath = (bus: number, targetBus: number) => `/bus/${bus}/send/${targetBus}`;
const sendBusToMatrixPath = (bus: number, mtxIndex: number) => `/bus/${bus}/send/MX${mtxIndex}`;
const sendBusToMainPath = (bus: number, mainIndex: number) => `/bus/${bus}/main/${mainIndex}`;
const sendMainToMatrixPath = (main: number, mtxIndex: number) => `/main/${main}/send/MX${mtxIndex}`;
const stripPathPrefix: Record<StripType, string> = { bus: "/bus", main: "/main", mtx: "/mtx" };
const STRIP_COUNTS: Record<StripType, number> = { bus: 16, main: 4, mtx: 8 };
const AUX_COUNT = 8;
const DCA_COUNT = 16;
const MUTEGROUP_COUNT = 8;
const FADE_PATH_PREFIX: Record<FadeTargetType, string> = { channel: "/ch", aux: "/aux", bus: "/bus", main: "/main", mtx: "/mtx", dca: "/dca" };
const FADE_COUNTS: Record<FadeTargetType, number> = { channel: 40, aux: AUX_COUNT, bus: 16, main: 4, mtx: 8, dca: 16 };
const FADE_STATE_KEY: Record<FadeTargetType, "channels" | "auxes" | "buses" | "mains" | "matrices" | "dcas"> = {
  channel: "channels",
  aux: "auxes",
  bus: "buses",
  main: "mains",
  mtx: "matrices",
  dca: "dcas",
};
const EASING_LABELS: Record<EasingName, string> = {
  linear: "Linear",
  "quad-in": "Quad — ease in",
  "quad-out": "Quad — ease out",
  "quad-in-out": "Quad — ease in-out",
  "cubic-in": "Cubic — ease in",
  "cubic-out": "Cubic — ease out",
  "cubic-in-out": "Cubic — ease in-out",
  "sine-in": "Sine — ease in",
  "sine-out": "Sine — ease out",
  "sine-in-out": "Sine — ease in-out",
  "expo-in": "Exponential — ease in",
  "expo-out": "Exponential — ease out",
  "expo-in-out": "Exponential — ease in-out",
};

const MIXER_SECTION_TABS: readonly (readonly [MixerSection, string])[] = [
  ["channels", "Channels"],
  ["aux", "Aux"],
  ["stage", "Bus / Main / Matrix"],
  ["dca", "DCA"],
  ["mutegroups", "Mute Groups"],
  ["routing", "Routing"],
  ["processing", "EQ / Gate / Dyn"],
  ["fx", "FX"],
  ["fade", "Fade"],
  ["io", "I/O"],
  ["monitor", "Monitor / Solo"],
];
const MIXER_SECTIONS = MIXER_SECTION_TABS.map(([id]) => id);

const SOLO_TYPE = { buses: "bus", mains: "main", matrices: "matrix", dcas: "dca" } as const;
const MEMBER_TYPE = { buses: "bus", mains: "main", matrices: "mtx" } as const;

/** Which muted DCAs and mute groups silence a strip, by name; empty when none does. */
type MutedBy = (type: WingGroupMember["type"], index: number) => string[];

/**
 * A strip silenced by a muted DCA or mute group keeps its own Mute switch off: the console only says
 * so through `$mute` = 2. Worked out here from the groups' membership and mute state instead, so it
 * shows from the first load and follows the group's Mute, whether pressed here or on the console.
 */
function useGroupMutes(state: WingMixerState | undefined): MutedBy {
  const members = useGroupMembers(state !== undefined);
  return useMemo(() => {
    const byStrip = new Map<string, string[]>();
    if (state && members.data) {
      const add = (groups: Record<string, WingGroupMember[]>, list: { index: number; name: string; muted: boolean }[], kind: string) => {
        for (const [n, groupMembers] of Object.entries(groups)) {
          const group = list.find((g) => g.index === Number(n));
          if (!group?.muted) continue;
          const label = `${kind} ${group.index}${group.name ? ` (${group.name})` : ""}`;
          for (const m of groupMembers) byStrip.set(`${m.type}:${m.index}`, [...(byStrip.get(`${m.type}:${m.index}`) ?? []), label]);
        }
      };
      add(members.data.mutegroups, state.mutegroups, "mute group");
      add(members.data.dca, state.dcas, "DCA");
    }
    return (type, index) => byStrip.get(`${type}:${index}`) ?? [];
  }, [state, members.data]);
}

/** A strip's Mute: lit when its own switch is on, outlined when a muted group silences it anyway. */
function MuteButton({ muted, mutedBy, onClick }: { muted: boolean; mutedBy: string[]; onClick: () => void }) {
  const byGroup = mutedBy.length > 0;
  return (
    <button
      className={muted ? "mixer-mute mixer-mute--active" : byGroup ? "mixer-mute mixer-mute--group" : "mixer-mute"}
      aria-pressed={muted}
      title={byGroup ? `Muted by ${mutedBy.join(", ")}` : undefined}
      onClick={onClick}
    >
      Mute
    </button>
  );
}

export function WingMixerTab(): JSX.Element {
  return (
    <SoloProvider>
      <StripActionsProvider>
        <MixerTabContent />
      </StripActionsProvider>
    </SoloProvider>
  );
}

/** The sections whose strips have a right-click menu and shortcuts. */
const STRIP_LIST_SECTIONS: readonly MixerSection[] = ["channels", "aux", "stage", "dca"];

function MixerTabContent(): JSX.Element {
  const [section, setSection] = useUrlChoice<MixerSection>("section", MIXER_SECTIONS, "channels");
  const mixer = useWingMixer();
  const mutedBy = useGroupMutes(mixer.state);

  return (
    <section className="card">
      <div className="tabs tabs--sub">
        <TabList className="tabs__list" tabs={MIXER_SECTION_TABS} value={section} onChange={setSection} label="Mixer sections" />
        <SoloIndicator />
        {STRIP_LIST_SECTIONS.includes(section) && <StripShortcutsButton />}
        <button className="mixer-refresh" onClick={mixer.refresh} disabled={mixer.isLoading}>
          {mixer.isLoading ? "Loading..." : "Refresh"}
        </button>
      </div>

      {mixer.isError && <p className="error">{(mixer.error as Error).message}</p>}
      {!mixer.state && mixer.isLoading && <p>Loading full mixer state from the console (this reads every channel/bus/main/matrix/DCA/mute group once, then stays live)...</p>}

      {mixer.state && section === "channels" && <ChannelsSection channels={mixer.state.channels} onLocal={mixer.setChannelLocal} mutedBy={mutedBy} />}
      {mixer.state && section === "aux" && <ChannelsSection channels={mixer.state.auxes} onLocal={mixer.setAuxLocal} pathPrefix="/aux" mutedBy={mutedBy} />}
      {mixer.state && section === "stage" && (
        <div className="mixer-stage-groups">
          <StageSection title="Bus" kind="buses" mutedBy={mutedBy} items={mixer.state.buses} onLocal={mixer.setStageLocal} />
          <StageSection title="Main" kind="mains" mutedBy={mutedBy} items={mixer.state.mains} onLocal={mixer.setStageLocal} />
          <StageSection title="Matrix" kind="matrices" mutedBy={mutedBy} items={mixer.state.matrices} onLocal={mixer.setStageLocal} />
        </div>
      )}
      {mixer.state && section === "dca" && (
        <div className="mixer-stage-groups">
          <GroupMembersEditor group="dca" groups={mixer.state.dcas} state={mixer.state} />
          <StageSection title="DCA" kind="dcas" items={mixer.state.dcas} onLocal={mixer.setStageLocal} membersOf={mixer.state} />
        </div>
      )}
      {mixer.state && section === "mutegroups" && (
        <MutegroupsSection items={mixer.state.mutegroups} onLocal={mixer.setMutegroupLocal} state={mixer.state} />
      )}
      {section === "routing" && (
        <RoutingSection
          channels={mixer.state?.channels ?? []}
          auxes={mixer.state?.auxes ?? []}
          buses={mixer.state?.buses ?? []}
          mains={mixer.state?.mains ?? []}
          matrices={mixer.state?.matrices ?? []}
        />
      )}
      {section === "processing" && (
        <ProcessingSection
          channels={mixer.state?.channels ?? []}
          auxes={mixer.state?.auxes ?? []}
          buses={mixer.state?.buses ?? []}
          mains={mixer.state?.mains ?? []}
          matrices={mixer.state?.matrices ?? []}
          dcas={mixer.state?.dcas ?? []}
          mutegroups={mixer.state?.mutegroups ?? []}
        />
      )}
      {section === "fx" && <FxSection />}
      {section === "monitor" && <MonitorSection state={mixer.state} onChannelLocal={mixer.setChannelLocal} onAuxLocal={mixer.setAuxLocal} />}
      {section === "io" && <IoSection channels={mixer.state?.channels ?? []} auxes={mixer.state?.auxes ?? []} />}
      {section === "fade" && <FadeSection mixerState={mixer.state} channels={mixer.state?.channels ?? []} />}
    </section>
  );
}

/** A strip's console colour, as the `--strip-color` its row draws its edge in. */
function stripColorStyle(col: number): CSSProperties | undefined {
  const hex = wingColorHex(col);
  return hex ? ({ "--strip-color": hex } as CSSProperties) : undefined;
}

function StripName({ name }: { name: string }) {
  return name ? (
    <span className="mixer-strip__name" title={name}>
      {name}
    </span>
  ) : (
    <span className="mixer-strip__name mixer-strip__name--empty">Unnamed</span>
  );
}

function ChannelsSection({
  channels,
  onLocal,
  pathPrefix = "/ch",
  mutedBy,
}: {
  channels: WingChannelStrip[];
  onLocal: (index: number, patch: Partial<WingChannelStrip>) => void;
  pathPrefix?: string;
  mutedBy: MutedBy;
}) {
  const [query, setQuery] = useState("");
  const [namedOnly, setNamedOnly] = useState(false);
  const needle = query.trim().toLowerCase();
  // A number matches that channel; anything else matches inside the name.
  const shown = channels.filter(
    (ch) => (!namedOnly || ch.name.trim() !== "") && (needle === "" || String(ch.index) === needle || ch.name.toLowerCase().includes(needle)),
  );
  const meterRef = useRowMeters(
    pathPrefix === "/aux" ? "aux" : "channel",
    shown.map((ch) => ch.index),
  );
  const list = useStripList(
    pathPrefix === "/aux" ? "aux" : "ch",
    shown.map((ch) => ch.index),
  );
  return (
    <>
      <div className="strip-filter">
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={pathPrefix === "/aux" ? "Filter auxes by name or number" : "Filter channels by name or number"}
          aria-label="Filter strips"
        />
        <label className="strip-filter__toggle">
          <input type="checkbox" checked={namedOnly} onChange={(event) => setNamedOnly(event.target.checked)} />
          Hide unnamed
        </label>
        <span className="strip-filter__count">
          {shown.length} / {channels.length}
        </span>
      </div>
      <div className="mixer-strip-list">
        {shown.map((ch) => (
          <ChannelRow
            key={ch.index}
            list={list}
            strip={ch}
            onLocal={onLocal}
            pathPrefix={pathPrefix}
            meterRef={meterRef(ch.index)}
            mutedBy={mutedBy(pathPrefix === "/aux" ? "aux" : "channel", ch.index)}
          />
        ))}
        {shown.length === 0 && <p className="card-hint">No strip matches.</p>}
      </div>
    </>
  );
}

function ChannelRow({
  list,
  strip,
  onLocal,
  pathPrefix,
  meterRef,
  mutedBy,
}: {
  list: StripList;
  strip: WingChannelStrip;
  onLocal: (index: number, patch: Partial<WingChannelStrip>) => void;
  pathPrefix: string;
  meterRef: (el: HTMLElement | null) => void;
  mutedBy: string[];
}) {
  const base = `${pathPrefix}/${strip.index}`;
  const commitFader = useThrottledCommit<number>(120, (v) => void setWingValue(`${base}/fdr`, v));
  const commitPan = useThrottledCommit<number>(120, (v) => void setWingValue(`${base}/pan`, v));
  const solo = useSolo();
  const setSrcAuto = useSetSrcAuto();
  const kind = pathPrefix === "/aux" ? "aux" : "channel";

  function toggleMute() {
    const next = !strip.muted;
    onLocal(strip.index, { muted: next });
    void setWingValue(`${base}/mute`, next ? 1 : 0);
  }

  function rename(target: string, name: string) {
    const previous = strip.name;
    onLocal(strip.index, { name });
    return setWingValue(target, name).catch((err: unknown) => {
      onLocal(strip.index, { name: previous });
      throw err;
    });
  }

  const controls: StripControls = {
    strip: { kind: kind === "aux" ? "aux" : "ch", index: strip.index },
    name: strip.name,
    col: strip.col,
    muted: strip.muted,
    soloed: solo.isSoloed(kind, strip.index),
    fader: strip.fader,
    toggleMute,
    toggleSolo: () => solo.toggle(kind, strip.index),
    setFader: (db) => {
      onLocal(strip.index, { fader: db });
      commitFader(db);
    },
    setColor: (col) => {
      onLocal(strip.index, { col });
      void setWingValue(`${base}/col`, col);
    },
    rename: (name) => rename(`${base}/name`, name),
    centrePan: () => {
      onLocal(strip.index, { pan: 0 });
      commitPan(0);
    },
    link: {
      linked: strip.srcAuto,
      source: strip.source,
      toggle: () => {
        const linked = !strip.srcAuto;
        // The console then pushes the name, colour and icon it shows now (the source's, or the strip's own).
        setSrcAuto.mutate({ kind, index: strip.index, linked }, { onSuccess: () => onLocal(strip.index, { srcAuto: linked }) });
      },
    },
    // While linked the strip shows its source's name, so that is the one a rename has to reach.
    renameSource: strip.source ? (name) => rename(`/io/in/${strip.source?.group}/${strip.source?.index}/name`, name) : undefined,
  };

  return (
    <StripRow list={list} controls={controls} className="mixer-strip" style={stripColorStyle(strip.col)}>
      {({ name, menuButton }) => (
        <>
          <span className="mixer-strip__index">{strip.index}</span>
          <span className="mixer-strip__identity">
            <span className="mixer-strip__name-line">
              <WingIcon id={strip.icon} />
              {name}
            </span>
            <StripMeter meterRef={meterRef} />
          </span>
          <span className="mixer-strip__buttons">
            <MuteButton muted={strip.muted} mutedBy={mutedBy} onClick={toggleMute} />
            <SoloButton type={kind} index={strip.index} />
            {menuButton}
          </span>
          <FaderControl
            label="Fader"
            value={strip.fader}
            onChange={(v) => {
              onLocal(strip.index, { fader: v });
              commitFader(v);
            }}
          />
          <SliderControl
            label="Pan"
            value={strip.pan}
            min={-100}
            max={100}
            step={1}
            format={formatPan}
            resetValue={0}
            onChange={(v) => {
              onLocal(strip.index, { pan: v });
              commitPan(v);
            }}
          />
        </>
      )}
    </StripRow>
  );
}

/** The meter stream each stage section's strips are reported under. */
const STAGE_METER_TYPE: Record<"buses" | "mains" | "matrices" | "dcas", string> = { buses: "bus", mains: "main", matrices: "matrix", dcas: "dca" };
const STAGE_STRIP_KIND: Record<"buses" | "mains" | "matrices" | "dcas", StripKind> = { buses: "bus", mains: "main", matrices: "mtx", dcas: "dca" };

function StageSection({
  title,
  kind,
  items,
  onLocal,
  membersOf,
  mutedBy,
}: {
  title: string;
  kind: "buses" | "mains" | "matrices" | "dcas";
  items: WingStageStrip[];
  onLocal: (kind: "buses" | "mains" | "matrices" | "dcas", index: number, patch: Partial<WingStageStrip>) => void;
  /** For DCAs: the mixer state to name each DCA's member strips from. */
  membersOf?: WingMixerState;
  /** For buses, mains and matrices: the muted groups silencing each one. */
  mutedBy?: MutedBy;
}) {
  const members = useGroupMembers(membersOf !== undefined);
  const pathPrefix = kind === "dcas" ? "/dca" : stagePathPrefix[kind];
  const meterRef = useRowMeters(
    STAGE_METER_TYPE[kind],
    items.map((item) => item.index),
  );
  const list = useStripList(
    STAGE_STRIP_KIND[kind],
    items.map((item) => item.index),
  );
  return (
    <div className="mixer-stage-group">
      <h3>{title}</h3>
      <div className="mixer-strip-list">
        {items.map((item) => (
          <StageRow
            key={item.index}
            list={list}
            pathPrefix={pathPrefix}
            strip={item}
            kind={kind}
            onLocal={onLocal}
            meterRef={meterRef(item.index)}
            mutedBy={mutedBy && kind !== "dcas" ? mutedBy(MEMBER_TYPE[kind], item.index) : []}
          >
            {/* An unused DCA stays one line high: its empty member list says nothing its "Unnamed" doesn't. */}
            {membersOf && members.data?.dca[item.index] && <GroupMemberList members={members.data.dca[item.index]} state={membersOf} />}
          </StageRow>
        ))}
      </div>
    </div>
  );
}

function StageRow({
  list,
  pathPrefix,
  strip,
  kind,
  onLocal,
  meterRef,
  mutedBy,
  children,
}: {
  list: StripList;
  mutedBy: string[];
  /** An extra line under the row (a DCA's members). */
  children?: ReactNode;
  pathPrefix: string;
  strip: WingStageStrip;
  kind: "buses" | "mains" | "matrices" | "dcas";
  onLocal: (kind: "buses" | "mains" | "matrices" | "dcas", index: number, patch: Partial<WingStageStrip>) => void;
  meterRef: (el: HTMLElement | null) => void;
}) {
  const base = `${pathPrefix}/${strip.index}`;
  const commitFader = useThrottledCommit<number>(120, (v) => void setWingValue(`${base}/fdr`, v));
  const solo = useSolo();
  const soloType = SOLO_TYPE[kind];

  function toggleMute() {
    const next = !strip.muted;
    onLocal(kind, strip.index, { muted: next });
    void setWingValue(`${base}/mute`, next ? 1 : 0);
  }

  const controls: StripControls = {
    strip: { kind: STAGE_STRIP_KIND[kind], index: strip.index },
    name: strip.name,
    col: strip.col,
    muted: strip.muted,
    soloed: solo.isSoloed(soloType, strip.index),
    fader: strip.fader,
    toggleMute,
    toggleSolo: () => solo.toggle(soloType, strip.index),
    setFader: (db) => {
      onLocal(kind, strip.index, { fader: db });
      commitFader(db);
    },
    setColor: (col) => {
      onLocal(kind, strip.index, { col });
      void setWingValue(`${base}/col`, col);
    },
    rename: (name) => {
      const previous = strip.name;
      onLocal(kind, strip.index, { name });
      return setWingValue(`${base}/name`, name).catch((err: unknown) => {
        onLocal(kind, strip.index, { name: previous });
        throw err;
      });
    },
  };

  return (
    <StripRow list={list} controls={controls} className="mixer-strip mixer-strip--stage" style={stripColorStyle(strip.col)}>
      {({ name, menuButton }) => (
        <>
          <span className="mixer-strip__index">{strip.index}</span>
          <span className="mixer-strip__identity">
            <span className="mixer-strip__name-line">
              <WingIcon id={strip.icon} />
              {name}
            </span>
            <StripMeter meterRef={meterRef} />
          </span>
          <span className="mixer-strip__buttons">
            <MuteButton muted={strip.muted} mutedBy={mutedBy} onClick={toggleMute} />
            <SoloButton type={soloType} index={strip.index} />
            {menuButton}
          </span>
          <FaderControl
            label="Fader"
            value={strip.fader}
            onChange={(v) => {
              onLocal(kind, strip.index, { fader: v });
              commitFader(v);
            }}
          />
          {children}
        </>
      )}
    </StripRow>
  );
}

const MEMBER_LISTS = { channel: "channels", aux: "auxes", bus: "buses", main: "mains", mtx: "matrices" } as const;
const MEMBER_SHORT = { channel: "Ch", aux: "Aux", bus: "Bus", main: "Main", mtx: "Mtx" } as const;

/** A DCA's or mute group's members, as chips in each strip's colour; "No members" when empty. */
function GroupMemberList({ members, state }: { members: WingGroupMember[]; state: WingMixerState }) {
  if (members.length === 0) return <span className="group-members group-members--empty">No members</span>;
  return (
    <span className="group-members">
      {members.map((m) => {
        const strip = state[MEMBER_LISTS[m.type]].find((s) => s.index === m.index);
        const id = `${MEMBER_SHORT[m.type]} ${m.index}`;
        return (
          <span key={`${m.type}${m.index}`} className="group-members__chip" style={strip ? stripColorStyle(strip.col) : undefined} title={id}>
            {strip?.name || id}
          </span>
        );
      })}
    </span>
  );
}

function MutegroupsSection({
  items,
  onLocal,
  state,
}: {
  items: WingMutegroupStrip[];
  onLocal: (index: number, patch: Partial<WingMutegroupStrip>) => void;
  state: WingMixerState;
}) {
  const members = useGroupMembers();
  return (
    <div className="mixer-stage-groups">
      <GroupMembersEditor group="mutegroup" groups={items} state={state} />
      <div className="mixer-stage-group">
        <h3>Mute Groups</h3>
        <div className="mixer-strip-list">
          {items.map((group) => (
            <div key={group.index} className="mixer-strip mixer-strip--compact">
              <span className="mixer-strip__index">{group.index}</span>
              <StripName name={group.name} />
              <button
                className={group.muted ? "mixer-mute mixer-mute--active" : "mixer-mute"}
                aria-pressed={group.muted}
                onClick={() => {
                  const next = !group.muted;
                  onLocal(group.index, { muted: next });
                  void setWingValue(`/mgrp/${group.index}/mute`, next ? 1 : 0);
                }}
              >
                Mute
              </button>
              {members.data && <GroupMemberList members={members.data.mutegroups[group.index] ?? []} state={state} />}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

const SEND_MODES = ["PRE", "POST", "GRP"] as const;

const ROUTING_SOURCE_LABEL: Record<RoutingSourceType, string> = { channel: "Channel", aux: "Aux", bus: "Bus", main: "Main" };

// WingChannelSends and WingBusSends are structurally identical ({bus,mtx,main}); this alias just
// gives the four query branches in RoutingSection one concrete type to narrow against instead of
// the much wider type react-query's generics would otherwise infer through the source-type ternary.
type RoutingSends = WingChannelSends | WingBusSends | WingMainSends;

function RoutingSection({
  channels,
  auxes,
  buses,
  mains,
  matrices,
}: {
  channels: WingChannelStrip[];
  auxes: WingChannelStrip[];
  buses: WingStageStrip[];
  mains: WingStageStrip[];
  matrices: WingStageStrip[];
}) {
  // The URL's strip (see useUrlStrip), as this section names sources; a matrix or DCA sends nowhere.
  const [strip, setStrip] = useUrlStrip();
  const source: RoutingSourceType =
    strip?.kind === "ch" ? "channel" : strip?.kind === "aux" || strip?.kind === "bus" || strip?.kind === "main" ? strip.kind : "channel";
  const sourceList: { index: number; name: string }[] =
    source === "channel" ? channels : source === "aux" ? auxes : source === "bus" ? buses : mains;
  const index: number | null =
    strip !== null && strip.kind !== "mtx" && strip.kind !== "dca" && sourceList.some((s) => s.index === strip.index) ? strip.index : (sourceList[0]?.index ?? 1);
  const setIndex = (n: number) => setStrip({ kind: source === "channel" ? "ch" : source, index: n });

  const channelSends = useChannelSends(source === "channel" ? index : null);
  const auxSends = useAuxSends(source === "aux" ? index : null);
  const busSends = useBusSends(source === "bus" ? index : null);
  const mainSends = useMainSends(source === "main" ? index : null);
  const sendsQuery = source === "channel" ? channelSends : source === "aux" ? auxSends : source === "bus" ? busSends : mainSends;
  const [overrides, setOverrides] = useState<WingChannelSends | WingBusSends | WingMainSends | null>(null);

  const sends = (overrides ?? sendsQuery.data) as RoutingSends | undefined;
  // A main only ever sends to a matrix (no send-to-main, no send-to-bus at all — verified against
  // real hardware), so its query response has no "bus"/"main" keys at all; narrow on that directly
  // rather than a separate capability table, so the UI can never drift out of sync with what the
  // backend actually returns.
  const busPathFor = source === "bus" ? sendBusToBusPath : source === "aux" ? sendToAuxBusPath : sendToBusPath;
  const mtxPathFor =
    source === "bus" ? sendBusToMatrixPath : source === "aux" ? sendToAuxMatrixPath : source === "main" ? sendMainToMatrixPath : sendToMatrixPath;
  const mainPathFor = source === "bus" ? sendBusToMainPath : source === "aux" ? sendToAuxMainPath : sendToMainPath;

  function selectSource(next: RoutingSourceType) {
    const list = next === "channel" ? channels : next === "aux" ? auxes : next === "bus" ? buses : mains;
    setStrip({ kind: next === "channel" ? "ch" : next, index: list[0]?.index ?? 1 });
    setOverrides(null);
  }

  // Only ever invoked from a BusMtxRoutingGroup, which (per the render logic below) only renders
  // for a channel/aux source — a bus source's own "bus"/"mtx" fields are main-shaped instead (see
  // applyMainShapedLocal) — so this guard effectively only ever fires for those two sources.
  function applyBusMtxLocal(kind: "bus" | "mtx", idx: number, patch: Partial<WingBusMtxSendState>) {
    setOverrides((prev) => {
      const base = (prev ?? sendsQuery.data) as WingChannelSends | undefined;
      if (!base || !("bus" in base)) return prev;
      if (kind === "bus") {
        return { ...base, bus: base.bus.map((s) => (s.index === idx ? { ...s, ...patch } : s)) };
      }
      return { ...base, mtx: base.mtx.map((s) => (s.index === idx ? { ...s, ...patch } : s)) };
    });
  }

  function applyMainLocal(idx: number, patch: Partial<WingMainSendState>) {
    setOverrides((prev) => {
      const base = (prev ?? sendsQuery.data) as RoutingSends | undefined;
      if (!base || !("main" in base)) return prev;
      return { ...base, main: base.main.map((s: WingMainSendState) => (s.index === idx ? { ...s, ...patch } : s)) };
    });
  }

  // Verified against real hardware: a bus's sends to another bus AND to a matrix, and a main's send
  // to a matrix, all carry the same reduced {on,lvl,pre} shape as a send-to-main (see WingMainSends
  // / WingBusSends) — not the fuller {on,lvl,pon,mode,plink,pan} shape a channel/aux uses. So when
  // source is "bus" (both its "bus" and "mtx" fields) or "main" (its "mtx" field), the group renders
  // via MainRoutingGroup instead of BusMtxRoutingGroup, and this setter (not applyBusMtxLocal)
  // updates its local overrides.
  function applyMainShapedLocal(field: "bus" | "mtx", idx: number, patch: Partial<WingMainSendState>) {
    setOverrides((prev) => {
      const base = (prev ?? sendsQuery.data) as RoutingSends | undefined;
      if (!base || !(field in base)) return prev;
      const apply = (list: WingMainSendState[]) => list.map((s) => (s.index === idx ? { ...s, ...patch } : s));
      if (field === "bus") {
        return { ...(base as WingBusSends), bus: apply((base as WingBusSends).bus) };
      }
      return { ...base, mtx: apply(base.mtx as WingMainSendState[]) } as RoutingSends;
    });
  }

  return (
    <div className="mixer-routing">
      <div className="mixer-routing__select-row">
        <label className="mixer-routing__select">
          <span>Source</span>
          <select value={source} onChange={(event) => selectSource(event.target.value as RoutingSourceType)}>
            <option value="channel">Channel</option>
            <option value="aux">Aux</option>
            <option value="bus">Bus</option>
            <option value="main">Main</option>
          </select>
        </label>
        <label className="mixer-routing__select">
          <span>{ROUTING_SOURCE_LABEL[source]}</span>
          <select
            value={index ?? ""}
            onChange={(event) => {
              setIndex(Number(event.target.value));
              setOverrides(null);
            }}
          >
            {sourceList.map((item) => (
              <option key={item.index} value={item.index}>
                {item.index}. {item.name || `${ROUTING_SOURCE_LABEL[source]} ${item.index}`}
              </option>
            ))}
          </select>
        </label>
      </div>

      {sendsQuery.isLoading && <p>Loading sends...</p>}
      {sendsQuery.isError && <p className="error">{(sendsQuery.error as Error).message}</p>}
      {source === "main" && <p>A main only sends to a matrix — verified against real hardware, no send-to-main or send-to-bus exists.</p>}

      {sends && index !== null && (
        <>
          {"bus" in sends &&
            (source === "bus" ? (
              <MainRoutingGroup
                title="Other Buses"
                indexPrefix="B"
                targets={buses}
                channel={index}
                items={sends.bus as WingMainSendState[]}
                pathFor={busPathFor}
                onLocal={(idx, patch) => applyMainShapedLocal("bus", idx, patch)}
              />
            ) : (
              <BusMtxRoutingGroup title="Bus" kind="bus" targets={buses} channel={index} items={sends.bus as WingBusMtxSendState[]} pathFor={busPathFor} onLocal={applyBusMtxLocal} />
            ))}
          {source === "main" || source === "bus" ? (
            <MainRoutingGroup
              title="Matrix"
              indexPrefix="MX"
              targets={matrices}
              channel={index}
              items={sends.mtx as WingMainSendState[]}
              pathFor={mtxPathFor}
              onLocal={(idx, patch) => applyMainShapedLocal("mtx", idx, patch)}
            />
          ) : (
            "mtx" in sends && (
              <BusMtxRoutingGroup title="Matrix" kind="mtx" targets={matrices} channel={index} items={sends.mtx as WingBusMtxSendState[]} pathFor={mtxPathFor} onLocal={applyBusMtxLocal} />
            )
          )}
          {"main" in sends && <MainRoutingGroup targets={mains} channel={index} items={sends.main} pathFor={mainPathFor} onLocal={applyMainLocal} />}
        </>
      )}
    </div>
  );
}

/** Where a send goes: its short id (B3, MX2), and the strip's own name and colour when it has them. */
function RoutingTarget({ prefix, index, target }: { prefix: string; index: number; target?: WingStageStrip }) {
  return (
    <span className="routing-target" style={target ? stripColorStyle(target.col) : undefined}>
      <span className="routing-target__id">
        {prefix}
        {index}
      </span>
      {target?.name && <span className="routing-target__name">{target.name}</span>}
    </span>
  );
}

function BusMtxRoutingGroup({
  title,
  kind,
  targets,
  channel,
  items,
  pathFor,
  onLocal,
}: {
  title: string;
  kind: "bus" | "mtx";
  /** The strips sent to, for their names and colours. */
  targets: WingStageStrip[];
  channel: number;
  items: WingBusMtxSendState[];
  pathFor: (channel: number, index: number) => string;
  onLocal: (kind: "bus" | "mtx", index: number, patch: Partial<WingBusMtxSendState>) => void;
}) {
  return (
    <div className="mixer-stage-group">
      <h3>{title}</h3>
      <div className="mixer-strip-list">
        {items.map((send) => (
          <BusMtxRoutingRow
            key={send.index}
            prefix={kind === "mtx" ? "MX" : "B"}
            target={targets.find((t) => t.index === send.index)}
            kind={kind}
            channel={channel}
            send={send}
            pathFor={pathFor}
            onLocal={onLocal}
          />
        ))}
      </div>
    </div>
  );
}

function BusMtxRoutingRow({
  prefix,
  target,
  kind,
  channel,
  send,
  pathFor,
  onLocal,
}: {
  prefix: string;
  target?: WingStageStrip;
  kind: "bus" | "mtx";
  channel: number;
  send: WingBusMtxSendState;
  pathFor: (channel: number, index: number) => string;
  onLocal: (kind: "bus" | "mtx", index: number, patch: Partial<WingBusMtxSendState>) => void;
}) {
  const basePath = pathFor(channel, send.index);
  const commitLevel = useThrottledCommit<number>(120, (v) => void bulkSetWing(basePath, { lvl: v }));
  const commitPan = useThrottledCommit<number>(120, (v) => void bulkSetWing(basePath, { pan: v }));

  function toggleOn() {
    const next = !send.on;
    onLocal(kind, send.index, { on: next });
    void bulkSetWing(basePath, { on: next ? 1 : 0 });
  }

  function setMode(mode: string) {
    onLocal(kind, send.index, { mode });
    void bulkSetWing(basePath, { mode });
  }

  return (
    <div className={send.on ? "mixer-strip mixer-strip--routing" : "mixer-strip mixer-strip--routing mixer-strip--send-off"}>
      <RoutingTarget prefix={prefix} index={send.index} target={target} />
      <button className={send.on ? "mixer-mute mixer-mute--on" : "mixer-mute"} onClick={toggleOn}>
        {send.on ? "On" : "Off"}
      </button>
      <select className="mixer-routing__mode" value={send.mode} onChange={(event) => setMode(event.target.value)}>
        {SEND_MODES.map((mode) => (
          <option key={mode} value={mode}>
            {mode}
          </option>
        ))}
      </select>
      <FaderControl
        label="Level"
        value={send.levelDb}
        onChange={(v) => {
          onLocal(kind, send.index, { levelDb: v });
          commitLevel(v);
        }}
      />
      <SliderControl
        label="Pan"
        value={send.pan}
        min={-100}
        max={100}
        step={1}
        format={formatPan}
        resetValue={0}
        onChange={(v) => {
          onLocal(kind, send.index, { pan: v });
          commitPan(v);
        }}
      />
    </div>
  );
}

function MainRoutingGroup({
  title = "Main",
  indexPrefix = "M",
  targets,
  channel,
  items,
  pathFor,
  onLocal,
}: {
  title?: string;
  indexPrefix?: string;
  /** The strips sent to, for their names and colours. */
  targets: WingStageStrip[];
  channel: number;
  items: WingMainSendState[];
  pathFor: (channel: number, index: number) => string;
  onLocal: (index: number, patch: Partial<WingMainSendState>) => void;
}) {
  return (
    <div className="mixer-stage-group">
      <h3>{title}</h3>
      <div className="mixer-strip-list">
        {items.map((send) => (
          <MainRoutingRow
            key={send.index}
            indexPrefix={indexPrefix}
            target={targets.find((t) => t.index === send.index)}
            channel={channel}
            send={send}
            pathFor={pathFor}
            onLocal={onLocal}
          />
        ))}
      </div>
    </div>
  );
}

function ProcessingSection({
  channels,
  auxes,
  buses,
  mains,
  matrices,
  dcas,
  mutegroups,
}: {
  channels: WingChannelStrip[];
  auxes: WingChannelStrip[];
  buses: WingStageStrip[];
  mains: WingStageStrip[];
  matrices: WingStageStrip[];
  dcas: WingStageStrip[];
  mutegroups: WingMutegroupStrip[];
}) {
  // The URL's strip (see useUrlStrip), as this section names strip types; a DCA has no processing.
  const [strip, setStrip] = useUrlStrip();
  const target: "channel" | "aux" | StripType = strip?.kind === "ch" ? "channel" : strip && strip.kind !== "dca" ? strip.kind : "channel";
  const maxIndex = target === "channel" ? channels.length || 40 : target === "aux" ? auxes.length || AUX_COUNT : STRIP_COUNTS[target];
  const index = strip && strip.kind !== "dca" && strip.index <= maxIndex ? strip.index : 1;
  const setIndex = (n: number) => setStrip({ kind: target === "channel" ? "ch" : target, index: n });

  function selectTarget(next: "channel" | "aux" | StripType) {
    setStrip({ kind: next === "channel" ? "ch" : next, index: 1 });
  }

  return (
    <div className="mixer-processing">
      <div className="mixer-routing__select-row">
        <label className="mixer-routing__select">
          <span>Type</span>
          <select value={target} onChange={(event) => selectTarget(event.target.value as "channel" | "aux" | StripType)}>
            <option value="channel">Channel</option>
            <option value="aux">Aux</option>
            <option value="bus">Bus</option>
            <option value="main">Main</option>
            <option value="mtx">Matrix</option>
          </select>
        </label>
        <label className="mixer-routing__select">
          <span>{{ channel: "Channel", aux: "Aux", bus: "Bus", main: "Main", mtx: "Matrix" }[target]}</span>
          <select value={index} onChange={(event) => setIndex(Number(event.target.value))}>
            {Array.from({ length: maxIndex }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>
                {`${n}. ${
                  { channel: channels, aux: auxes, bus: buses, main: mains, mtx: matrices }[target].find((x) => x.index === n)?.name ||
                  `${{ channel: "Channel", aux: "Aux", bus: "Bus", main: "Main", mtx: "Matrix" }[target]} ${n}`
                }`}
              </option>
            ))}
          </select>
        </label>
      </div>

      {target === "channel" ? (
        <ChannelProcessingPanels key={`channel-${index}`} channel={index} dcas={dcas} mutegroups={mutegroups} />
      ) : target === "aux" ? (
        <AuxProcessingPanels key={`aux-${index}`} aux={index} dcas={dcas} mutegroups={mutegroups} />
      ) : (
        <StripProcessingPanels key={`${target}-${index}`} type={target} index={index} dcas={dcas} mutegroups={mutegroups} />
      )}
    </div>
  );
}

function ChannelProcessingPanels({
  channel,
  dcas,
  mutegroups,
}: {
  channel: number;
  dcas: WingStageStrip[];
  mutegroups: WingMutegroupStrip[];
}) {
  const eqQuery = useChannelEq(channel);
  const gateQuery = useChannelGate(channel);
  const dynQuery = useChannelDyn(channel);
  const basePath = `/ch/${channel}`;

  return (
    <div className="mixer-stage-groups">
      <AutogainCard buildRequest={(targetDb) => ({ kind: "channel", index: channel, targetDb })} />
      <GroupsCard kind="channel" index={channel} dcas={dcas} mutegroups={mutegroups} />
      <InputPatchCard kind="channel" index={channel} />
      <ProcessingOrderCard channel={channel} />
      <InsertCard kind="channel" index={channel} slot="pre" />
      <InsertCard kind="channel" index={channel} slot="post" />
      <DelayCard kind="channel" index={channel} />
      <ProcessingCard title="EQ" wide query={eqQuery} basePath={`${basePath}/eq`} />
      <ProcessingCard title="Gate" query={gateQuery} basePath={`${basePath}/gate`} />
      <DynamicsLiveCard title="Gate" kind="channel" index={channel} block="gate" model={gateQuery.data?.values.mdl} range={gateQuery.data?.values.range} params={gateQuery.data?.params} />
      <ProcessingCard title="Dynamics (Compressor)" query={dynQuery} basePath={`${basePath}/dyn`} />
      <DynamicsLiveCard title="Dynamics" kind="channel" index={channel} block="dyn" model={dynQuery.data?.values.mdl} range={dynQuery.data?.values.range} params={dynQuery.data?.params} />
    </div>
  );
}

/** Aux has an input trim (so Autogain applies) and EQ/Dynamics like a channel, but verified against
 * real hardware to have no Gate stage at all — no Gate card, unlike ChannelProcessingPanels. */
function AuxProcessingPanels({
  aux,
  dcas,
  mutegroups,
}: {
  aux: number;
  dcas: WingStageStrip[];
  mutegroups: WingMutegroupStrip[];
}) {
  const eqQuery = useAuxEq(aux);
  const dynQuery = useAuxDyn(aux);
  const basePath = `/aux/${aux}`;

  return (
    <div className="mixer-stage-groups">
      <AutogainCard buildRequest={(targetDb) => ({ kind: "aux", index: aux, targetDb })} />
      <GroupsCard kind="aux" index={aux} dcas={dcas} mutegroups={mutegroups} />
      <InputPatchCard kind="aux" index={aux} />
      {/* Aux has no post-insert stage (see wing-insert.ts) — only the pre-insert card is rendered. */}
      <InsertCard kind="aux" index={aux} slot="pre" />
      <DelayCard kind="aux" index={aux} />
      <ProcessingCard title="EQ" wide query={eqQuery} basePath={`${basePath}/eq`} />
      <ProcessingCard title="Dynamics (Compressor)" query={dynQuery} basePath={`${basePath}/dyn`} />
      <DynamicsLiveCard title="Dynamics" kind="aux" index={aux} block="dyn" model={dynQuery.data?.values.mdl} range={dynQuery.data?.values.range} params={dynQuery.data?.params} />
    </div>
  );
}

/** All 24 orderings of Gate/EQ/Dynamics/Insert — pure combinatorics (4! permutations of 4 fixed
 * letters), not sourced from the console: describe() on "/ch/N/proc" never replies (same "list []"
 * dead end as $scenes), but unlike $scenes there's no parent-branch workaround since /ch/N itself
 * has far too many other children to usefully describe as a whole. */
function generateGediPermutations(): string[] {
  const letters = ["G", "E", "D", "I"];
  const results: string[] = [];
  function permute(prefix: string, remaining: string[]) {
    if (remaining.length === 0) {
      results.push(prefix);
      return;
    }
    for (let i = 0; i < remaining.length; i++) {
      permute(prefix + remaining[i], [...remaining.slice(0, i), ...remaining.slice(i + 1)]);
    }
  }
  permute("", letters);
  return results;
}

const GEDI_PERMUTATIONS = generateGediPermutations();

function ProcessingOrderCard({ channel }: { channel: number }) {
  const procQuery = useChannelProc(channel);
  const setProc = useSetChannelProc();
  const [local, setLocal] = useState<string | null>(null);

  if (procQuery.isLoading || !procQuery.data) {
    return (
      <div className="mixer-stage-group">
        <h3>Processing Order</h3>
        {procQuery.isError && <p className="error">{(procQuery.error as Error).message}</p>}
      </div>
    );
  }

  const value = local ?? procQuery.data.value;

  return (
    <div className="mixer-stage-group">
      <h3>Processing Order</h3>
      <div className="param-field">
        <span className="param-field__label">G/E/D/I</span>
        <select
          value={value}
          onChange={(event) => {
            setLocal(event.target.value);
            setProc.mutate({ channel, order: event.target.value });
          }}
        >
          {GEDI_PERMUTATIONS.map((perm) => (
            <option key={perm} value={perm}>
              {perm}
            </option>
          ))}
        </select>
      </div>
      {setProc.isError && <p className="error">{(setProc.error as Error).message}</p>}
    </div>
  );
}

/**
 * Samples this channel's live input peak for ~1.2s (server-side) and adjusts its trim to land on
 * `targetDb` — see the matching route doc in http-routes.ts. -18dBFS is the default target: a
 * standard alignment/headroom convention, not an arbitrary number.
 */
function AutogainCard({
  title = "Input Gain",
  fieldLabel = "trim",
  buildRequest,
}: {
  title?: string;
  fieldLabel?: string;
  buildRequest: (targetDb: number) => Exclude<Parameters<ReturnType<typeof useAutogain>["mutate"]>[0], never>;
}) {
  // Raw text so a leading "-" isn't wiped by the controlled input — see parseNumberField.
  const [targetText, setTargetText] = useState("-18");
  const targetDb = parseNumberField(targetText) ?? -18;
  const autogain = useAutogain();

  return (
    <div className="mixer-stage-group">
      <div className="mixer-processing-card__header">
        <h3>{title}</h3>
      </div>
      <div className="param-panel">
        <div className="param-field">
          <span className="param-field__label">Target</span>
          <input
            type="number"
            inputMode="decimal"
            step={0.5}
            value={targetText}
            onChange={(event) => setTargetText(event.target.value)}
            style={{ flex: "none", width: "5rem" }}
          />
          <span className="param-field__value">dB</span>
        </div>
        <button className="mixer-refresh" onClick={() => autogain.mutate(buildRequest(targetDb))} disabled={autogain.isPending}>
          {autogain.isPending ? "Measuring (~1.2s)..." : "Auto Gain"}
        </button>
        {autogain.isError && <p className="error">{(autogain.error as Error).message}</p>}
        {autogain.isSuccess && (
          <div className="success">
            {"gain" in autogain.data ? (
              // Combined channel/aux result: gain-staging first, trim only if it was actually needed.
              <>
                {autogain.data.gain && (
                  <p>
                    Gain ({autogain.data.physicalSource!.group} {autogain.data.physicalSource!.index}): measured peak{" "}
                    {autogain.data.gain.measuredPeakDb.toFixed(1)} dB — {autogain.data.gain.oldValue.toFixed(1)} dB →{" "}
                    {autogain.data.gain.newValue.toFixed(1)} dB
                    {autogain.data.gain.clamped ? " (clamped to gain range)" : ""}
                  </p>
                )}
                {autogain.data.trim ? (
                  <p>
                    Trim: measured peak {autogain.data.trim.measuredPeakDb.toFixed(1)} dB —{" "}
                    {autogain.data.trim.oldValue.toFixed(1)} dB → {autogain.data.trim.newValue.toFixed(1)} dB
                    {autogain.data.trim.clamped ? " (clamped to trim range)" : ""}
                  </p>
                ) : (
                  autogain.data.trimLeftAtZero && <p>Trim: left at 0 dB — gain alone reached the target.</p>
                )}
              </>
            ) : (
              // Single-field result (the physical input's own Preamp Gain card).
              <p>
                Measured peak {autogain.data.measuredPeakDb.toFixed(1)} dB — {fieldLabel} {autogain.data.oldValue.toFixed(1)} dB →{" "}
                {autogain.data.newValue.toFixed(1)} dB{autogain.data.clamped ? ` (clamped to ${fieldLabel} range)` : ""}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

type AutoCompressKind = "channel" | "aux" | "bus" | "main" | "mtx";
// "mtx" is this dashboard's own route-param spelling for bus/main/matrix (see stripPathPrefix);
// the meter protocol frames (and the server's AutoCompressOptions) spell the matrix type out.
const AUTO_COMPRESS_METER_TYPE: Record<AutoCompressKind, "channel" | "aux" | "bus" | "main" | "matrix"> = {
  channel: "channel",
  aux: "aux",
  bus: "bus",
  main: "main",
  mtx: "matrix",
};

/**
 * How fast the peak-hold reduction indicator releases back toward 0 once the compressor lets go,
 * in dB/second — chosen so a brief transient (a snare hit grabbing 5dB for a fraction of a second)
 * stays visible for roughly half a second instead of vanishing before a human eye (or the next
 * ~100ms-throttled meter update) can register it. Standard peak-meter ballistics: instant on a deeper
 * reduction, gradual release otherwise — the same reason a hardware compressor's own GR meter shows
 * far more motion than a single raw instantaneous sample ever would.
 */
const GR_PEAK_RELEASE_DB_PER_SEC = 12;
const GR_PEAK_DECAY_TICK_MS = 50;

/**
 * Mirrors `isBidirectionalDynModel` in src/plugins/wing/wing-dynamics-models.ts — kept in sync by
 * hand since the two workspaces don't share code (same pattern as the OSC path templates at the top
 * of this file). Every gate/compressor/ducker-type model verified against real hardware (CMB, 76LA,
 * SBUS, NSTR, GATE, COMP, ...) can only ever cut, so a positive reading is idle-detector noise, never
 * real. A Dynamic EQ model is the one exception — confirmed live as "DEQ2" on channel 3's gate slot —
 * it can legitimately boost a detected band as well as cut it, so a positive reading there is real
 * activity that must not be hidden or mislabeled as "reducing".
 */
function isBidirectionalDynModel(mdl: string | number | undefined): boolean {
  return mdl !== undefined && String(mdl).toUpperCase().startsWith("DEQ");
}

/**
 * Mirrors `resolveCompressionControl` in src/plugins/wing/wing-dynamics-models.ts — kept in sync by
 * hand, same as above. Keyed on the slot's live describe() param keys (already fetched by the
 * ProcessingCard query), NOT a model list: `thr`/`cthr`/`1-thr` → the tool drives a threshold;
 * `peak`/`gr`/`comp`/`in` → it drives a drive/amount knob (LA-2A "LA", ONEC, L100, LMT, 76LA
 * "LE1176", NSTR — no threshold). `ingain` is deliberately NOT here: on the only models that expose
 * it (LA/L100) it's an inert make-up trim, and both also expose a real amount knob that wins. Only
 * the "input-gain" case needs different UI here (the "New threshold" field becomes "New drive amount").
 */
function resolveCompressionControlKind(paramKeys: readonly string[]): "threshold" | "input-gain" | null {
  if (["thr", "cthr", "1-thr"].some((k) => paramKeys.includes(k))) return "threshold";
  if (["peak", "gr", "comp", "in", "ingain"].some((k) => paramKeys.includes(k))) return "input-gain";
  return null;
}

/**
 * A controlled `<input type="number">` whose `value` is forced back from `Number(e.target.value)`
 * can't be typed into with a leading "-" or a mid-entry "." — while those are the only char in the
 * box the browser reports `value === ""`, so a `number | ""` state snaps to "" and React wipes the
 * keystroke (worst on Safari). The fix: hold the raw text and parse only when the value is actually
 * used. This returns `undefined` for anything not yet a finite number ("", "-", ".", "-.", "1e"),
 * so callers can `?? default` or pass `undefined` straight through to an optional request field.
 */
function parseNumberField(text: string): number | undefined {
  const t = text.trim();
  if (t === "") return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

const DEFAULT_GAIN_REDUCTION_FULL_SCALE_DB = 20;

/**
 * Mirrors `gainReductionScaleCorrection`/`gainReductionFullScaleDb` in
 * src/plugins/wing/wing-dynamics-models.ts — kept in sync by hand, same as above. The `wing:meters`
 * stream's `gateGain_dB`/`dynGain_dB` fields only carry the meter protocol's documented DEFAULT
 * full-scale range (20dB — the server-side parsing layer has no way to know which model is loaded).
 * The one documented exception is the model named exactly "GATE" (WING_Remote-Protocols-3.1-03.pdf
 * p.98: "Standard Wing gate is 60 dB") — but 60dB isn't a constant to hardcode, it's that model's own
 * `range` setting (describe()'d 3..60dB, user-adjustable) at its default/max; reading the slot's
 * *current* `range` value (passed in as a prop, sourced from the same ProcessingCard query that
 * already fetches this slot's settings) instead of assuming 60 keeps this correct if the range knob
 * is ever turned down.
 */
function gainReductionScaleCorrection(mdl: string | number | undefined, range: string | number | undefined): number {
  if (mdl === undefined || String(mdl).toUpperCase() !== "GATE") return 1;
  const rangeDb = Number(range);
  return (Number.isFinite(rangeDb) ? rangeDb : 60) / DEFAULT_GAIN_REDUCTION_FULL_SCALE_DB;
}

/**
 * Live gain-reduction readout + Auto Compress control for one dynamics-processing slot ("gate" or
 * "dyn" — see wing-auto-compress.ts on the server for why either can host a compressor). The live
 * reading reuses the same `wing:meters` topic the Meters tab and PhysicalInputMeterAndGain already
 * consume — no new live-data plumbing needed, just reading the gate/dyn key+gain fields every frame
 * already carries. The meter bar shows a peak-held reading (see GR_PEAK_RELEASE_DB_PER_SEC above) —
 * verified against a real console that its own GR meter reads several dB on transient material while
 * a naive "just show the latest sample" reading mostly missed those brief dips and sat near 0, since
 * meter updates land only every ~100ms and typical compressor release times are much faster than that.
 * Shown as "amount of reduction happening" (0 = idle, positive = squashing), mirroring the server's
 * own idle-noise clamp (wing-auto-compress.ts) so a cut-only model's slight positive detector wobble
 * at rest never displays as looking like a boost. `model` (the slot's `mdl`) is used to detect the
 * one exception, a Dynamic EQ (isBidirectionalDynModel above) — that model can legitimately boost as
 * well as cut, so for it the peak-hold/active/label logic tracks and shows either direction instead
 * of only ever the deepest cut. `range` is this slot's own live `range` setting (only meaningful for
 * the "GATE" model — see gainReductionScaleCorrection above), passed down so the gain-reduction scale
 * correction tracks the actual knob instead of assuming a fixed 60dB. Also offers "Auto Gate" (see
 * wing-auto-gate.ts on the server), behind a switch with Auto Compress — unlike Auto Compress, which
 * needs a threshold already chosen, Auto Gate measures the slot's own noise floor vs signal peak and
 * picks one automatically.
 */
function DynamicsLiveCard({
  title,
  kind,
  index,
  block,
  model,
  range,
  params,
}: {
  title: string;
  kind: AutoCompressKind;
  index: number;
  block: AutoCompressBlock;
  model?: string | number;
  range?: string | number;
  params?: WingDescribeParam[];
}) {
  const meterType = AUTO_COMPRESS_METER_TYPE[kind];
  const bidirectional = isBidirectionalDynModel(model);
  const inputDriven = resolveCompressionControlKind((params ?? []).map((p) => p.key)) === "input-gain";
  const [gainDb, setGainDb] = useState<number | null>(null);
  const [keyDb, setKeyDb] = useState<number | null>(null);
  const [peakGainDb, setPeakGainDb] = useState(0);
  const peakGainRef = useRef(0);
  const bidirectionalRef = useRef(bidirectional);
  bidirectionalRef.current = bidirectional;
  const gainScaleCorrectionRef = useRef(1);
  gainScaleCorrectionRef.current = gainReductionScaleCorrection(model, range);

  useStripMeters([{ type: meterType, index }], (readings) => {
    for (const { values } of readings) {
      const gain = (values[block === "gate" ? "gateGain_dB" : "dynGain_dB"] ?? Number.NaN) * gainScaleCorrectionRef.current;
      const key = values[block === "gate" ? "gateKey_dB" : "dynKey_dB"] ?? Number.NaN;
      if (Number.isFinite(gain)) {
        setGainDb(gain);
        // Cut-only models: only a deeper (more negative) sample overrides the held peak. A
        // Dynamic EQ can legitimately swing either way, so the peak there is whichever sample has
        // the larger magnitude, positive or negative — a real boost must never be discarded just
        // because it's not "more negative" than a smaller earlier cut.
        const deeper = bidirectionalRef.current ? Math.abs(gain) > Math.abs(peakGainRef.current) : gain < peakGainRef.current;
        if (deeper) {
          peakGainRef.current = gain;
          setPeakGainDb(gain);
        }
      }
      if (Number.isFinite(key)) setKeyDb(key);
    }
  });

  // Releases the held peak back toward 0 at a fixed rate; a fresh, more extreme sample (handled
  // above) always overrides this immediately regardless of where the release is at.
  useEffect(() => {
    const releasePerTick = (GR_PEAK_RELEASE_DB_PER_SEC * GR_PEAK_DECAY_TICK_MS) / 1000;
    const timer = setInterval(() => {
      if (peakGainRef.current < 0) {
        peakGainRef.current = Math.min(0, peakGainRef.current + releasePerTick);
        setPeakGainDb(peakGainRef.current);
      } else if (peakGainRef.current > 0) {
        peakGainRef.current = Math.max(0, peakGainRef.current - releasePerTick);
        setPeakGainDb(peakGainRef.current);
      }
    }, GR_PEAK_DECAY_TICK_MS);
    return () => clearInterval(timer);
  }, []);

  // Raw text (not number | "") so a leading "-" / mid-entry "." isn't wiped — see parseNumberField.
  const [thresholdText, setThresholdText] = useState("");
  const [inputGainText, setInputGainText] = useState("");
  const [targetReductionText, setTargetReductionText] = useState("");
  const [targetMode, setTargetMode] = useState<AutoCompressTargetMode>("average");
  const [sampleMsText, setSampleMsText] = useState("3000");
  const autoCompress = useAutoCompress();
  const [marginText, setMarginText] = useState("");
  const autoGate = useAutoGate();
  // Either slot can host a compressor or a gate (see above), so both tools are on offer; the one shown
  // first follows the slot's name.
  const [tool, setTool] = useState<"compress" | "gate">(block === "gate" ? "gate" : "compress");

  const driveText = inputDriven ? inputGainText : thresholdText;
  const hasDrive = driveText.trim() !== "";
  const hasTarget = targetReductionText.trim() !== "";
  // Clamp to the schema's own 500..15000 so a fat-fingered value can't reach the server as an error.
  const sampleMs = Math.min(15000, Math.max(500, parseNumberField(sampleMsText) ?? 3000));

  // Idle detector noise on a cut-only model reads slightly positive instead of a flat 0 — treat that
  // (and "no data yet") as zero reduction, never as a boost, matching the server's own clamp. A
  // Dynamic EQ's positive readings are real, so its meter shows the peak's actual magnitude either way.
  const reductionDb = bidirectional ? Math.abs(peakGainDb) : Math.max(0, -peakGainDb);
  const active = gainDb !== null && (bidirectional ? Math.abs(gainDb) > 0.15 : gainDb < -0.15);
  const activityText =
    gainDb === null
      ? "Waiting for live meter data..."
      : !active
        ? bidirectional
          ? "Not currently adjusting"
          : "Not currently reducing"
        : bidirectional
          ? gainDb < 0
            ? `Cutting ${Math.abs(gainDb).toFixed(1)} dB now`
            : `Boosting ${gainDb.toFixed(1)} dB now`
          : `Reducing ${Math.abs(gainDb).toFixed(1)} dB now`;

  return (
    <div className="mixer-stage-group">
      <div className="mixer-processing-card__header">
        <h3>{title} — live</h3>
        <div className="segmented" role="group" aria-label={`${title} automatic setup`}>
          {(["compress", "gate"] as const).map((m) => (
            <button key={m} type="button" className="segmented__option" aria-pressed={tool === m} onClick={() => setTool(m)}>
              {m === "compress" ? "Auto compress" : "Auto gate"}
            </button>
          ))}
        </div>
      </div>
      <div className="dyn-live">
        <MeterBar label={bidirectional ? "adjustment peak" : "GR peak"} db={reductionDb} min={0} max={20} orangeAt={6} redAt={12} />
        <div className="dyn-live__body">
          <p className={active ? "dyn-live__status dyn-live__status--active" : "dyn-live__status"}>
            {activityText}
            {keyDb !== null && <span className="dyn-live__key"> · key {keyDb.toFixed(1)} dB</span>}
          </p>
          <div className="param-panel">
            {tool === "compress" ? (
              <>
                <div className="param-field">
                  <span className="param-field__label">{inputDriven ? "Set drive amount" : "Set threshold"}</span>
                  <input
                    type="number"
                    inputMode="decimal"
                    step={inputDriven ? 1 : 0.5}
                    placeholder="unchanged"
                    value={driveText}
                    disabled={hasTarget}
                    onChange={(event) => (inputDriven ? setInputGainText : setThresholdText)(event.target.value)}
                    style={{ flex: "none", width: "6rem" }}
                  />
                  <span className="param-field__value">{inputDriven ? "" : "dB"}</span>
                </div>
                <div className="param-field">
                  <span className="param-field__label">Or aim for reduction of</span>
                  <input
                    type="number"
                    inputMode="decimal"
                    step={0.5}
                    placeholder="e.g. -5"
                    value={targetReductionText}
                    disabled={hasDrive}
                    onChange={(event) => setTargetReductionText(event.target.value)}
                    style={{ flex: "none", width: "6rem" }}
                  />
                  <span className="param-field__value">dB</span>
                  <select value={targetMode} onChange={(event) => setTargetMode(event.target.value as AutoCompressTargetMode)}>
                    <option value="average">on average</option>
                    <option value="peak">at peak</option>
                  </select>
                </div>
              </>
            ) : (
              <div className="param-field">
                <span className="param-field__label">Margin</span>
                <input
                  type="number"
                  inputMode="decimal"
                  step={1}
                  placeholder="6"
                  value={marginText}
                  onChange={(event) => setMarginText(event.target.value)}
                  style={{ flex: "none", width: "6rem" }}
                />
                <span className="param-field__value">dB above noise floor</span>
              </div>
            )}
            <div className="param-field">
              <span className="param-field__label">Sample</span>
              <input
                type="number"
                inputMode="numeric"
                step={500}
                min={500}
                max={15000}
                value={sampleMsText}
                onChange={(event) => setSampleMsText(event.target.value)}
                style={{ flex: "none", width: "6rem" }}
              />
              <span className="param-field__value">ms/round</span>
            </div>
            {tool === "compress" ? (
              <>
                <button
                  className="button--primary dyn-live__run"
                  onClick={() =>
                    autoCompress.mutate({
                      kind,
                      index,
                      block,
                      thresholdDb: inputDriven ? undefined : parseNumberField(thresholdText),
                      inputGainDb: inputDriven ? parseNumberField(inputGainText) : undefined,
                      targetReductionDb: parseNumberField(targetReductionText),
                      targetMode: hasTarget ? targetMode : undefined,
                      sampleMs,
                    })
                  }
                  disabled={autoCompress.isPending}
                >
                  {autoCompress.isPending
                    ? !hasTarget
                      ? `Measuring (~${(sampleMs / 1000).toFixed(1)}s)...`
                      : inputDriven
                        ? "Searching for drive amount..."
                        : "Searching for threshold..."
                    : "Auto Compress"}
                </button>
                {autoCompress.isError && <p className="error">{(autoCompress.error as Error).message}</p>}
                {autoCompress.isSuccess && (
                  <div className="success">
                    <p>
                      {autoCompress.data.model && `Model ${autoCompress.data.model} — `}
                      {(() => {
                        const c = autoCompress.data.control;
                        const label =
                          c.kind === "input-gain"
                            ? c.key === "gr"
                              ? "gain-reduction amount"
                              : c.key === "comp"
                                ? "compression amount"
                                : c.key === "peak"
                                  ? "peak reduction"
                                  : "input gain"
                            : c.key === "cthr"
                              ? "compressor threshold"
                              : c.key === "1-thr"
                                ? "band-1 threshold"
                                : "threshold";
                        const u = c.unit ? ` ${c.unit}` : "";
                        return `${label} ${c.old}${u} → ${c.new}${u}`;
                      })()}
                      {autoCompress.data.target &&
                        ` (target ${autoCompress.data.target.reductionDb} dB ${autoCompress.data.target.mode}: ${
                          autoCompress.data.target.converged ? "converged" : `did not fully converge (${autoCompress.data.target.stopReason})`
                        } after ${autoCompress.data.target.iterations} round(s))`}
                      {`, measured avg reduction ${autoCompress.data.measured.meanGainReductionDb.toFixed(1)} dB`}
                      {autoCompress.data.makeupGain.applied
                        ? ` — makeup gain ${autoCompress.data.makeupGain.old} dB → ${autoCompress.data.makeupGain.new} dB${
                            autoCompress.data.makeupGain.clamped ? " (clamped to range)" : ""
                          }`
                        : " — no makeup-gain field on this model"}
                    </p>
                  </div>
                )}
              </>
            ) : (
              <>
                <button
                  className="button--primary dyn-live__run"
                  onClick={() =>
                    autoGate.mutate({
                      kind,
                      index,
                      block,
                      marginDb: parseNumberField(marginText),
                      sampleMs,
                    })
                  }
                  disabled={autoGate.isPending}
                >
                  {autoGate.isPending ? `Measuring (~${(sampleMs / 1000).toFixed(1)}s)...` : "Auto Gate"}
                </button>
                {autoGate.isError && <p className="error">{(autoGate.error as Error).message}</p>}
                {autoGate.isSuccess && (
                  <div className="success">
                    <p>
                      {autoGate.data.model && `Model ${autoGate.data.model} — `}
                      noise floor {autoGate.data.measured.noiseFloorDb.toFixed(1)} dB, signal peak{" "}
                      {autoGate.data.measured.signalPeakDb.toFixed(1)} dB — threshold {autoGate.data.threshold.old} dB →{" "}
                      {autoGate.data.threshold.new} dB
                      {autoGate.data.threshold.clamped ? " (clamped to range)" : ""}
                    </p>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function StripProcessingPanels({
  type,
  index,
  dcas,
  mutegroups,
}: {
  type: StripType;
  index: number;
  dcas: WingStageStrip[];
  mutegroups: WingMutegroupStrip[];
}) {
  const eqQuery = useStripEq(type, index);
  const dynQuery = useStripDyn(type, index);
  const basePath = `${stripPathPrefix[type]}/${index}`;

  return (
    <div className="mixer-stage-groups">
      <GroupsCard kind={type} index={index} dcas={dcas} mutegroups={mutegroups} />
      <InsertCard kind={type} index={index} slot="pre" />
      <InsertCard kind={type} index={index} slot="post" />
      <DelayCard kind={type} index={index} />
      {type === "mtx" && <MatrixDirectInputCard index={index} />}
      <ProcessingCard title="EQ" wide query={eqQuery} basePath={`${basePath}/eq`} />
      <ProcessingCard title="Dynamics (Compressor)" query={dynQuery} basePath={`${basePath}/dyn`} />
      <DynamicsLiveCard title="Dynamics" kind={type} index={index} block="dyn" model={dynQuery.data?.values.mdl} range={dynQuery.data?.values.range} params={dynQuery.data?.params} />
    </div>
  );
}

/**
 * DCA/mute group membership toggle grid — verified against real hardware to NOT be a separate
 * node (see wing-group-tags.ts on the server for the full writeup): a channel/aux/bus/main/matrix
 * joins DCA N or Mute Group N via a reserved `#DN`/`#MN` token in its own `tags` string. `dcas`/
 * `mutegroups` (from the top-level mixer state) supply names for the button tooltips; when that
 * state hasn't loaded yet, falls back to a plain 1..16 / 1..8 range so the grid still works.
 */
function GroupsCard({
  kind,
  index,
  dcas,
  mutegroups,
}: {
  kind: GroupMemberKind;
  index: number;
  dcas: WingStageStrip[];
  mutegroups: WingMutegroupStrip[];
}) {
  const groupsQuery = useGroups(kind, index);
  const toggleGroup = useToggleGroup();
  const [overrides, setOverrides] = useState<WingGroups | null>(null);
  // This card shares one `toggleGroup` mutation and one `overrides` slot between its DCA row and its
  // Mute Group row — two quick clicks (one per row) are genuinely concurrent. Tracks which dispatched
  // toggle is the most recent so a slower, now-stale response can't clobber a faster one's already-
  // applied, already-confirmed change by blindly overwriting `overrides` with an outdated snapshot.
  const latestRequestRef = useRef(0);
  const groups = overrides ?? groupsQuery.data;

  const dcaList = dcas.length > 0 ? dcas : Array.from({ length: DCA_COUNT }, (_, i) => ({ index: i + 1, name: "", fader: 0, muted: false }));
  const mutegroupList = mutegroups.length > 0 ? mutegroups : Array.from({ length: MUTEGROUP_COUNT }, (_, i) => ({ index: i + 1, name: "", muted: false }));

  function toggle(group: "dca" | "mutegroup", groupIndex: number) {
    const current = groups ?? { dca: [], mutegroups: [] };
    const on = !(group === "dca" ? current.dca : current.mutegroups).includes(groupIndex);
    const apply = (list: number[]) => (on ? [...list, groupIndex].sort((a, b) => a - b) : list.filter((n) => n !== groupIndex));
    const next: WingGroups = group === "dca" ? { ...current, dca: apply(current.dca) } : { ...current, mutegroups: apply(current.mutegroups) };
    setOverrides(next);
    const requestId = ++latestRequestRef.current;
    toggleGroup.mutate(
      { kind, index, group, groupIndex, on },
      {
        onSuccess: (result) => {
          if (requestId === latestRequestRef.current) setOverrides(result);
        },
        onError: () => {
          if (requestId === latestRequestRef.current) setOverrides(null);
        },
      },
    );
  }

  return (
    <div className="mixer-stage-group">
      <div className="mixer-processing-card__header">
        <h3>DCA / Mute Group Assignment</h3>
      </div>
      {groupsQuery.isLoading && <p>Loading...</p>}
      {groupsQuery.isError && <p className="error">{(groupsQuery.error as Error).message}</p>}
      {toggleGroup.isError && <p className="error">{(toggleGroup.error as Error).message}</p>}
      {groups && (
        <>
          <div className="mixer-groups__row">
            <span className="param-field__label">DCA</span>
            {dcaList.map((dca) => (
              <button
                key={dca.index}
                className={groups.dca.includes(dca.index) ? "mixer-mute mixer-mute--on" : "mixer-mute"}
                onClick={() => toggle("dca", dca.index)}
                title={dca.name || `DCA ${dca.index}`}
              >
                {dca.index}
              </button>
            ))}
          </div>
          <div className="mixer-groups__row">
            <span className="param-field__label">Mute Grp</span>
            {mutegroupList.map((mg) => (
              <button
                key={mg.index}
                className={groups.mutegroups.includes(mg.index) ? "mixer-mute mixer-mute--active" : "mixer-mute"}
                onClick={() => toggle("mutegroup", mg.index)}
                title={mg.name || `Mute Group ${mg.index}`}
              >
                {mg.index}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export function ProcessingCard({
  title,
  query,
  basePath,
  wide = false,
}: {
  title: string;
  /** Takes the whole row of the two-column processing grid (the EQ, whose bands sit side by side). */
  wide?: boolean;
  query: { data?: WingParamPanel; isLoading: boolean; isError: boolean; error: unknown; refetch: () => void };
  basePath: string;
}): JSX.Element {
  return (
    <div className={wide ? "mixer-stage-group mixer-stage-group--wide" : "mixer-stage-group"}>
      <div className="mixer-processing-card__header">
        <h3>{title}</h3>
        <button className="mixer-refresh" onClick={() => void query.refetch()} disabled={query.isLoading}>
          {query.isLoading ? "Loading..." : "Refresh"}
        </button>
      </div>
      {query.isError && <p className="error">{(query.error as Error).message}</p>}
      {query.data && (
        <ParamPanel
          panel={query.data}
          onSet={(key, value) => setWingValue(`${basePath}/${key}`, value)}
          onStructuralChange={() => void query.refetch()}
        />
      )}
    </div>
  );
}

const INSERT_FX_OPTIONS = ["NONE", ...Array.from({ length: 16 }, (_, i) => `FX${i + 1}`)];
const POST_INSERT_MODES = ["FX", "AUTO_X", "AUTO_Y"];

/** Pre/post insert on/off + FX patch point — post-insert additionally has a routing mode and a
 * wet/dry mix; aux has no post-insert stage at all (see wing-insert.ts on the server), so callers
 * simply don't render a `slot="post"` card for aux. */
function InsertCard({ kind, index, slot }: { kind: "channel" | "aux" | StripType; index: number; slot: "pre" | "post" }) {
  const insertQuery = useInsert(kind, index, slot);
  const setInsert = useSetInsert();
  const data = insertQuery.data;
  // Buffers what the user is typing so a mutation firing mid-keystroke (which re-renders this
  // component before the server value updates) can't snap the input back to the old value — same
  // pattern as ProcessingOrderCard's `local` above.
  const [localMix, setLocalMix] = useState<string | null>(null);

  return (
    <div className="mixer-stage-group">
      <div className="mixer-processing-card__header">
        <h3>{slot === "pre" ? "Pre-Insert" : "Post-Insert"}</h3>
        <button className="mixer-refresh" onClick={() => void insertQuery.refetch()} disabled={insertQuery.isLoading}>
          {insertQuery.isLoading ? "Loading..." : "Refresh"}
        </button>
      </div>
      {insertQuery.isError && <p className="error">{(insertQuery.error as Error).message}</p>}
      {setInsert.isError && <p className="error">{(setInsert.error as Error).message}</p>}
      {data && (
        <div className="param-panel">
          <div className="param-field">
            <span className="param-field__label">On</span>
            <button
              className={data.on ? "mixer-mute mixer-mute--on" : "mixer-mute"}
              onClick={() => setInsert.mutate({ kind, index, slot, on: !data.on })}
            >
              {data.on ? "On" : "Off"}
            </button>
          </div>
          <div className="param-field">
            <span className="param-field__label">FX</span>
            <select value={data.fx} onChange={(event) => setInsert.mutate({ kind, index, slot, fx: event.target.value })}>
              {INSERT_FX_OPTIONS.map((fx) => (
                <option key={fx} value={fx}>
                  {fx}
                </option>
              ))}
            </select>
          </div>
          {slot === "post" && (
            <>
              <div className="param-field">
                <span className="param-field__label">Mode</span>
                <select value={data.mode ?? "FX"} onChange={(event) => setInsert.mutate({ kind, index, slot, mode: event.target.value })}>
                  {POST_INSERT_MODES.map((mode) => (
                    <option key={mode} value={mode}>
                      {mode}
                    </option>
                  ))}
                </select>
              </div>
              <div className="param-field">
                <span className="param-field__label">Mix</span>
                <input
                  type="number"
                  min={-12}
                  max={12}
                  step={0.5}
                  value={localMix ?? data.w ?? 0}
                  onChange={(event) => setLocalMix(event.target.value)}
                  onBlur={() => {
                    if (localMix !== null) {
                      const parsed = Number(localMix);
                      if (Number.isFinite(parsed)) setInsert.mutate({ kind, index, slot, w: parsed });
                    }
                    setLocalMix(null);
                  }}
                />
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

const DELAY_MODES = ["M", "FT", "MS", "SMP"];

/** Delay line on/off + unit + amount. Channel/aux delay is on the input stage, bus/main/matrix
 * delay is its own output-stage node — see wing-delay.ts on the server for the two shapes; this
 * card doesn't need to know which one it's talking to. */
function DelayCard({ kind, index }: { kind: "channel" | "aux" | "bus" | "main" | "mtx"; index: number }) {
  const delayQuery = useDelay(kind, index);
  const setDelay = useSetDelay();
  const data = delayQuery.data;
  // See InsertCard's localMix for why this buffer exists — without it, a mutation firing mid-
  // keystroke snaps this input back to the old server value before a second digit can be typed.
  const [localValue, setLocalValue] = useState<string | null>(null);

  return (
    <div className="mixer-stage-group">
      <div className="mixer-processing-card__header">
        <h3>Delay</h3>
        <button className="mixer-refresh" onClick={() => void delayQuery.refetch()} disabled={delayQuery.isLoading}>
          {delayQuery.isLoading ? "Loading..." : "Refresh"}
        </button>
      </div>
      {delayQuery.isError && <p className="error">{(delayQuery.error as Error).message}</p>}
      {setDelay.isError && <p className="error">{(setDelay.error as Error).message}</p>}
      {data && (
        <div className="param-panel">
          <div className="param-field">
            <span className="param-field__label">On</span>
            <button
              className={data.on ? "mixer-mute mixer-mute--on" : "mixer-mute"}
              onClick={() => setDelay.mutate({ kind, index, on: !data.on })}
            >
              {data.on ? "On" : "Off"}
            </button>
          </div>
          <div className="param-field">
            <span className="param-field__label">Unit</span>
            <select value={data.mode} onChange={(event) => setDelay.mutate({ kind, index, mode: event.target.value })}>
              {DELAY_MODES.map((mode) => (
                <option key={mode} value={mode}>
                  {mode}
                </option>
              ))}
            </select>
          </div>
          <div className="param-field">
            <span className="param-field__label">Value</span>
            <input
              type="number"
              step={0.1}
              value={localValue ?? data.value}
              onChange={(event) => setLocalValue(event.target.value)}
              onBlur={() => {
                if (localValue !== null) {
                  const parsed = Number(localValue);
                  if (Number.isFinite(parsed)) setDelay.mutate({ kind, index, value: parsed });
                }
                setLocalValue(null);
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

const MATRIX_DIR_IN_VALUES = ["OFF", "AES", "MON.PH", "MON.SPK", "MON.BUS"];

/** Matrix-exclusive "Direct Input" sub-mixer — taps a signal directly into the matrix ahead of its
 * normal bus/main sends. Distinct from the matrix's Sends panel (see wing-matrix-direct.ts on the
 * server); only ever rendered for matrix strips. */
function MatrixDirectInputCard({ index }: { index: number }) {
  const directQuery = useMatrixDirectInput(index);
  const setDirect = useSetMatrixDirectInput();
  const data = directQuery.data;
  // See InsertCard's localMix for why this buffer exists — without it, a mutation firing mid-
  // keystroke snaps this input back to the old server value before a second digit can be typed.
  const [localLevel, setLocalLevel] = useState<string | null>(null);

  return (
    <div className="mixer-stage-group">
      <div className="mixer-processing-card__header">
        <h3>Direct Input</h3>
        <button className="mixer-refresh" onClick={() => void directQuery.refetch()} disabled={directQuery.isLoading}>
          {directQuery.isLoading ? "Loading..." : "Refresh"}
        </button>
      </div>
      {directQuery.isError && <p className="error">{(directQuery.error as Error).message}</p>}
      {setDirect.isError && <p className="error">{(setDirect.error as Error).message}</p>}
      {data && (
        <div className="param-panel">
          <div className="param-field">
            <span className="param-field__label">On</span>
            <button
              className={data.on ? "mixer-mute mixer-mute--on" : "mixer-mute"}
              onClick={() => setDirect.mutate({ index, on: !data.on })}
            >
              {data.on ? "On" : "Off"}
            </button>
          </div>
          <div className="param-field">
            <span className="param-field__label">Source</span>
            <select value={data.input} onChange={(event) => setDirect.mutate({ index, input: event.target.value })}>
              {MATRIX_DIR_IN_VALUES.map((source) => (
                <option key={source} value={source}>
                  {source}
                </option>
              ))}
            </select>
          </div>
          <div className="param-field">
            <span className="param-field__label">Level</span>
            <input
              type="number"
              min={-144}
              max={10}
              step={0.5}
              value={localLevel ?? data.levelDb}
              onChange={(event) => setLocalLevel(event.target.value)}
              onBlur={() => {
                if (localLevel !== null) {
                  const parsed = Number(localLevel);
                  if (Number.isFinite(parsed)) setDirect.mutate({ index, levelDb: parsed });
                }
                setLocalLevel(null);
              }}
            />
          </div>
          <div className="param-field">
            <span className="param-field__label">Invert</span>
            <button
              className={data.invert ? "mixer-mute mixer-mute--on" : "mixer-mute"}
              onClick={() => setDirect.mutate({ index, invert: !data.invert })}
            >
              {data.invert ? "On" : "Off"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Main/Alt active-source selector — deliberately doesn't duplicate the grp/index patch editor
 * already in the I/O tab's Mapping view (StripRow below, which writes Main via grp/in and Alt via
 * altgrp/altin through the generic bulk-set path): that's the "patch grp/index" side already
 * covered. What's genuinely missing there is which of the two patched sources is actually live —
 * `in/set/altsrc`, read/written here through the dedicated wing-input-patch.ts module.
 */
function InputPatchCard({ kind, index }: { kind: "channel" | "aux"; index: number }) {
  const patchQuery = useInputPatch(kind, index);
  const setActive = useSetAltSourceActive();
  const data = patchQuery.data;

  return (
    <div className="mixer-stage-group">
      <div className="mixer-processing-card__header">
        <h3>Input Source (Main/Alt)</h3>
        <button className="mixer-refresh" onClick={() => void patchQuery.refetch()} disabled={patchQuery.isLoading}>
          {patchQuery.isLoading ? "Loading..." : "Refresh"}
        </button>
      </div>
      {patchQuery.isError && <p className="error">{(patchQuery.error as Error).message}</p>}
      {setActive.isError && <p className="error">{(setActive.error as Error).message}</p>}
      {data && (
        <div className="param-panel">
          <div className="param-field">
            <span className="param-field__label">Main</span>
            <span className="param-field__value">{data.main ? describeSource(data.main.group, data.main.index) : "unrouted"}</span>
          </div>
          <div className="param-field">
            <span className="param-field__label">Alt</span>
            <span className="param-field__value">{data.alt ? describeSource(data.alt.group, data.alt.index) : "unrouted"}</span>
          </div>
          <div className="param-field">
            <span className="param-field__label">Active</span>
            <button
              className={data.altActive ? "mixer-mute mixer-mute--on" : "mixer-mute"}
              onClick={() => setActive.mutate({ kind, index, active: !data.altActive })}
              disabled={setActive.isPending}
            >
              {data.altActive ? "Alt" : "Main"}
            </button>
          </div>
          <p className="card-hint">
            Change the patch itself in <Link to="/wing?tab=mixer&section=io">I/O → Mapping</Link>; rename, recolour or link this {kind}'s
            name to its source in <Link to="/wing?tab=identity">Identity</Link>.
          </p>
        </div>
      )}
    </div>
  );
}

type IoView = "mapping" | "inputs" | "outputs";

// Short, honest hints for the group codes the console itself returns — only for groups whose
// meaning is actually confirmed; deliberately no entry for MOD/USR/OSC (real hardware exposes
// them but their exact purpose wasn't verified, so guessing a label would be worse than the bare code).
const GROUP_HINTS: Record<string, string> = {
  OFF: "no source",
  LCL: "local inputs",
  AUX: "aux in/out block",
  A: "AES50 port A",
  B: "AES50 port B",
  C: "AES50 port C",
  SC: "StageConnect",
  USB: "USB audio",
  CRD: "expansion card",
  PLAY: "USB media player",
  AES: "AES/EBU digital pair",
  REC: "USB recorder",
  BUS: "internal bus tap",
  MAIN: "internal main tap",
  MTX: "internal matrix tap",
  SEND: "internal send tap",
  MON: "internal monitor tap",
};

// BUS/MAIN/MTX aren't in GET /io's group listing (they're internal taps, not physical jacks with
// their own gain/phantom/name — see http-routes.ts's /io route), so their real counts are mirrored
// here from wing-node-paths.ts's constants rather than discovered live. SEND/MON counts aren't
// verified against hardware at all, so those fall back to the field's own describe()'d 1..64 range.
const INTERNAL_GROUP_COUNT: Record<string, number> = { BUS: 16, MAIN: 4, MTX: 8 };

function groupOptionLabel(group: string): string {
  const hint = GROUP_HINTS[group];
  return hint ? `${group} — ${hint}` : group;
}

/** How many physical/tap items exist in `group`, or null if genuinely unknown (falls back to the field's own describe() range). */
function groupItemCount(group: string, ioGroups: WingIoGroup[] | undefined): number | null {
  if (group === "OFF") return null;
  if (group in INTERNAL_GROUP_COUNT) return INTERNAL_GROUP_COUNT[group];
  return ioGroups?.find((g) => g.group === group)?.count ?? null;
}

function describeSource(group: string, index: number): string {
  if (group === "OFF") return "nothing (disabled)";
  const hint = GROUP_HINTS[group];
  return hint ? `${group} ${index} (${hint})` : `${group} ${index}`;
}

/**
 * Physical I/O — verified against real hardware: `/ch/N/in/conn` and `/aux/N/in/conn` map a
 * channel/aux to a physical source group+index (e.g. grp=AES, in=7 — "map channel 3 to AES input
 * 7"), while `/io/in/<group>/<n>` carries that physical input's own properties (gain trim, 48V
 * phantom power, polarity, mute, name/color/icon — "name it Guitar, green, guitar icon") and
 * `/io/out/<group>/<n>` carries a physical output's patch (which internal bus/main/matrix/send/
 * monitor source feeds it). The mapping/patch views use hand-built forms (SourceMappingCard) with
 * plain-language labels and index dropdowns bounded to the selected group's real count, since a
 * raw grp/in/altgrp/altin ParamPanel with an unbounded 1..64 slider tested as too cryptic to
 * actually use. The physical input/output *property* editors (name/gain/phantom/etc.) still reuse
 * the generic ParamPanel/ProcessingCard — those fields don't have the same "which of several
 * differently-sized groups" ambiguity.
 */
function IoSection({ channels, auxes }: { channels: WingChannelStrip[]; auxes: WingChannelStrip[] }) {
  const [view, setView] = useState<IoView>("mapping");
  const [physicalGroup, setPhysicalGroup] = useState<string | null>(null);
  const [physicalIndex, setPhysicalIndex] = useState(1);

  function editPhysicalInput(group: string, index: number) {
    setPhysicalGroup(group);
    setPhysicalIndex(index);
    setView("inputs");
  }

  return (
    <div className="mixer-processing">
      <div className="mixer-routing__select-row">
        <label className="mixer-routing__select">
          <span>View</span>
          <select value={view} onChange={(event) => setView(event.target.value as IoView)}>
            <option value="mapping">Channel/Aux Input Mapping</option>
            <option value="inputs">Physical Inputs (gain, 48V, name, color...)</option>
            <option value="outputs">Physical Outputs</option>
          </select>
        </label>
      </div>

      {view === "mapping" && <IoMappingPanel channels={channels} auxes={auxes} onEditPhysicalInput={editPhysicalInput} />}
      {view === "inputs" && (
        <IoPhysicalPropertiesPanel direction="in" group={physicalGroup} onGroupChange={setPhysicalGroup} index={physicalIndex} onIndexChange={setPhysicalIndex} />
      )}
      {view === "outputs" && <IoOutputPatchPanel />}
    </div>
  );
}

function IoMappingPanel({
  channels,
  auxes,
  onEditPhysicalInput,
}: {
  channels: WingChannelStrip[];
  auxes: WingChannelStrip[];
  onEditPhysicalInput: (group: string, index: number) => void;
}) {
  const [target, setTarget] = useState<"channel" | "aux">("channel");
  const [index, setIndex] = useState(1);
  const list = target === "channel" ? channels : auxes;
  const maxIndex = target === "channel" ? channels.length || 40 : auxes.length || AUX_COUNT;
  const label = list.find((c) => c.index === index)?.name || `${target === "channel" ? "Channel" : "Aux"} ${index}`;

  const channelQuery = useChannelInConn(target === "channel" ? index : null);
  const auxQuery = useAuxInConn(target === "aux" ? index : null);
  const query = target === "channel" ? channelQuery : auxQuery;
  const basePath = target === "channel" ? `/ch/${index}/in/conn` : `/aux/${index}/in/conn`;
  const ioGroupsQuery = useIoGroups();

  function selectTarget(next: "channel" | "aux") {
    setTarget(next);
    setIndex(1);
  }

  return (
    <div className="mixer-stage-groups">
      <div className="mixer-routing__select-row">
        <label className="mixer-routing__select">
          <span>Type</span>
          <select value={target} onChange={(event) => selectTarget(event.target.value as "channel" | "aux")}>
            <option value="channel">Channel</option>
            <option value="aux">Aux</option>
          </select>
        </label>
        <label className="mixer-routing__select">
          <span>{target === "channel" ? "Channel" : "Aux"}</span>
          <select value={index} onChange={(event) => setIndex(Number(event.target.value))}>
            {Array.from({ length: maxIndex }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>
                {n}. {list.find((c) => c.index === n)?.name || `${target === "channel" ? "Channel" : "Aux"} ${n}`}
              </option>
            ))}
          </select>
        </label>
      </div>

      {query.isLoading && <p>Loading...</p>}
      {query.isError && <p className="error">{(query.error as Error).message}</p>}
      {query.data && (
        <SourceMappingCard
          key={`${target}-${index}-in-conn`}
          heading={`Where does ${label} get its audio from?`}
          basePath={basePath}
          values={query.data.values}
          params={query.data.params}
          ioGroups={ioGroupsQuery.data?.inputGroups}
          onRefetch={() => void query.refetch()}
          onEditPhysicalSource={onEditPhysicalInput}
          hasAlternate
        />
      )}
    </div>
  );
}

/**
 * Shared hand-built form for any {grp,in} (optionally +altgrp/altin) node — channel/aux input
 * mapping and a physical output's patch are structurally the same shape, just pointed at different
 * base paths and (for the output patch) not having an alternate. Renders a plain-language "current
 * state" summary plus a group dropdown (labelled with a short hint where known) and an index
 * dropdown bounded to that group's actual item count, instead of a describe()-driven 1..64 slider
 * that let you "select" indices the group doesn't even have.
 */
function SourceMappingCard({
  heading,
  basePath,
  values,
  params,
  ioGroups,
  onRefetch,
  onEditPhysicalSource,
  hasAlternate = false,
}: {
  heading: string;
  basePath: string;
  values: Record<string, string | number>;
  params: WingDescribeParam[];
  ioGroups: WingIoGroup[] | undefined;
  onRefetch: () => void;
  onEditPhysicalSource?: (group: string, index: number) => void;
  hasAlternate?: boolean;
}) {
  const [overrides, setOverrides] = useState<Record<string, string | number>>({});
  const describedGroups = params.find((p) => p.key === "grp")?.options ?? [];

  const grp = String(overrides.grp ?? values.grp ?? "OFF");
  const inIdx = Number(overrides.in ?? values.in ?? 1);
  const altgrp = String(overrides.altgrp ?? values.altgrp ?? "OFF");
  // The patched groups always appear in the pickers, even when describe() didn't list them (or
  // hasn't answered yet), so a select never shows blank over a real patch.
  const groupOptions = [...new Set([...describedGroups, grp, altgrp])];
  const altin = Number(overrides.altin ?? values.altin ?? 1);

  const grpMax = groupItemCount(grp, ioGroups) ?? 64;
  const altgrpMax = groupItemCount(altgrp, ioGroups) ?? 64;
  const canEditSource = grp !== "OFF" && onEditPhysicalSource !== undefined;

  function commitGroup(groupKey: "grp" | "altgrp", indexKey: "in" | "altin", nextGroup: string, currentIndex: number) {
    const clampedIndex = Math.min(currentIndex, groupItemCount(nextGroup, ioGroups) ?? 64);
    setOverrides((prev) => ({ ...prev, [groupKey]: nextGroup, [indexKey]: clampedIndex }));
    void bulkSetWing(basePath, { [groupKey]: nextGroup, [indexKey]: clampedIndex });
  }

  function commitIndex(indexKey: "in" | "altin", nextIndex: number) {
    setOverrides((prev) => ({ ...prev, [indexKey]: nextIndex }));
    void setWingValue(`${basePath}/${indexKey}`, nextIndex);
  }

  return (
    <div className="mixer-stage-group">
      <div className="mixer-processing-card__header">
        <h3>{heading}</h3>
        <button className="mixer-refresh" onClick={onRefetch}>
          Refresh
        </button>
      </div>
      <p>
        Currently: <strong>{describeSource(grp, inIdx)}</strong>
      </p>
      <div className="param-panel">
        <div className="param-field">
          <span className="param-field__label">Source</span>
          <select value={grp} onChange={(event) => commitGroup("grp", "in", event.target.value, inIdx)}>
            {groupOptions.map((opt) => (
              <option key={opt} value={opt}>
                {groupOptionLabel(opt)}
              </option>
            ))}
          </select>
        </div>
        {grp !== "OFF" && (
          <div className="param-field">
            <span className="param-field__label">Input number</span>
            <select value={inIdx} onChange={(event) => commitIndex("in", Number(event.target.value))}>
              {Array.from({ length: grpMax }, (_, i) => i + 1).map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </div>
        )}
        {canEditSource && (
          <button className="mixer-refresh" onClick={() => onEditPhysicalSource!(grp, inIdx)}>
            Edit {grp} {inIdx}'s name/gain/phantom →
          </button>
        )}
      </div>

      {hasAlternate && (
        <details className="io-alternate">
          <summary>Alternate source</summary>
          <p className="card-hint">The main source above still applies first: this is a secondary mapping, not a verified automatic failover.</p>
          <div className="param-panel">
            <div className="param-field">
              <span className="param-field__label">Alternate source</span>
              <select value={altgrp} onChange={(event) => commitGroup("altgrp", "altin", event.target.value, altin)}>
                {groupOptions.map((opt) => (
                  <option key={opt} value={opt}>
                    {groupOptionLabel(opt)}
                  </option>
                ))}
              </select>
            </div>
            {altgrp !== "OFF" && (
              <div className="param-field">
                <span className="param-field__label">Alternate input number</span>
                <select value={altin} onChange={(event) => commitIndex("altin", Number(event.target.value))}>
                  {Array.from({ length: altgrpMax }, (_, i) => i + 1).map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>
        </details>
      )}
    </div>
  );
}

/**
 * Editing a physical input's own properties (gain, 48V phantom, polarity, mute, name/color/icon) —
 * still a plain describe+dump ParamPanel, since these fields don't have the "which group" ambiguity
 * the mapping views do. Exported so the Identity tab can offer "Source" alongside its strip types
 * (see WingIdentityTab.tsx) and reuse this exact editor rather than duplicating the group/index
 * pickers and the name/ColorField/IconField panel.
 */
export function IoPhysicalPropertiesPanel({
  direction,
  group,
  onGroupChange,
  index,
  onIndexChange,
}: {
  direction: "in";
  group: string | null;
  onGroupChange: (group: string) => void;
  index: number;
  onIndexChange: (index: number) => void;
}): JSX.Element {
  const groupsQuery = useIoGroups();
  const groups = groupsQuery.data?.inputGroups;
  const groupExists = groups?.some((g) => g.group === group);
  const effectiveGroup = groupExists ? group : (groups?.[0]?.group ?? null);
  const count = groups?.find((g) => g.group === effectiveGroup)?.count ?? 0;

  const query = useIoIn(effectiveGroup, index);
  const basePath = `/io/${direction}/${effectiveGroup}/${index}`;

  if (groupsQuery.isLoading) return <p>Loading I/O groups...</p>;
  if (groupsQuery.isError) return <p className="error">{(groupsQuery.error as Error).message}</p>;
  if (!groups || groups.length === 0) return <p>No input groups reported by the console.</p>;

  return (
    <div className="mixer-stage-groups">
      <div className="mixer-routing__select-row">
        <label className="mixer-routing__select">
          <span>Group</span>
          <select
            value={effectiveGroup ?? ""}
            onChange={(event) => {
              onGroupChange(event.target.value);
              onIndexChange(1);
            }}
          >
            {groups.map((g) => (
              <option key={g.group} value={g.group}>
                {groupOptionLabel(g.group)} ({g.count})
              </option>
            ))}
          </select>
        </label>
        <label className="mixer-routing__select">
          <span>Index</span>
          <select value={index} onChange={(event) => onIndexChange(Number(event.target.value))}>
            {Array.from({ length: count }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
      </div>
      {effectiveGroup && (
        <>
          <PhysicalInputMeterAndGain key={`meter-${effectiveGroup}-${index}`} group={effectiveGroup} index={index} />
          <ProcessingCard key={`${direction}-${effectiveGroup}-${index}`} title={`${effectiveGroup} ${index} properties`} query={query} basePath={basePath} />
        </>
      )}
    </div>
  );
}

/**
 * Live level + Auto Gain for a physical input — verified against real hardware that the metering
 * protocol's "source"/"output" token types exist but their index space does NOT line up with
 * /io/in's group+index addressing in any simple, safely-guessable way (tested by bumping a known
 * input's analog gain live and watching which meter index actually moved — see session notes), so
 * this instead reverse-looks-up whichever channel/aux currently has this input as its primary
 * source (in/conn.grp+.in) and reuses that channel/aux's own already-verified meter, the same way
 * a human would watch the channel's meter while turning the physical gain knob.
 */
function PhysicalInputMeterAndGain({ group, index }: { group: string; index: number }) {
  const routedQuery = useIoRoutedChannels(group, index);
  const options: { type: "channel" | "aux"; index: number }[] = [
    ...(routedQuery.data?.channels ?? []).map((i) => ({ type: "channel" as const, index: i })),
    ...(routedQuery.data?.auxes ?? []).map((i) => ({ type: "aux" as const, index: i })),
  ];
  const [selected, setSelected] = useState<{ type: "channel" | "aux"; index: number } | null>(null);
  const active = selected && options.some((o) => o.type === selected.type && o.index === selected.index) ? selected : (options[0] ?? null);

  const [db, setDb] = useState(-144);
  useStripMeters(active ? [active] : null, (readings) => {
    for (const { values } of readings) {
      setDb(Math.max(values.inputL_dB ?? -144, values.inputR_dB ?? -144));
    }
  });

  if (routedQuery.isLoading) return <p>Looking up which channel/aux uses this input...</p>;
  if (routedQuery.isError) return <p className="error">{(routedQuery.error as Error).message}</p>;
  if (!active) {
    return <p>This input isn't currently routed to any channel or aux — assign it under "Channel/Aux Input Mapping" first to see its level and use Auto Gain.</p>;
  }

  return (
    <div className="mixer-stage-group">
      <div className="mixer-processing-card__header">
        <h3>
          Live level ({active.type} {active.index})
        </h3>
        {options.length > 1 && (
          <select
            value={`${active.type}:${active.index}`}
            onChange={(event) => {
              const [t, i] = event.target.value.split(":");
              setSelected({ type: t as "channel" | "aux", index: Number(i) });
            }}
          >
            {options.map((o) => (
              <option key={`${o.type}:${o.index}`} value={`${o.type}:${o.index}`}>
                {o.type} {o.index}
              </option>
            ))}
          </select>
        )}
      </div>
      <div style={{ display: "flex", gap: "1.5rem", alignItems: "flex-start", flexWrap: "wrap" }}>
        <MeterBar label={`${active.type} ${active.index}`} db={db} />
        <div style={{ flex: "1 1 16rem" }}>
          <AutogainCard
            title="Preamp Gain"
            fieldLabel="gain"
            buildRequest={(targetDb) => ({ kind: "io", group, index, meterType: active.type, meterIndex: active.index, targetDb })}
          />
        </div>
      </div>
    </div>
  );
}

/** A physical output's patch: which internal bus/main/matrix/send/monitor (or looped-back physical) source feeds it — e.g. "AES50 port A, output 1 <- Bus 3". */
function IoOutputPatchPanel() {
  const groupsQuery = useIoGroups();
  const groups = groupsQuery.data?.outputGroups;
  const [group, setGroup] = useState<string | null>(null);
  const [index, setIndex] = useState(1);

  const effectiveGroup = group ?? groups?.[0]?.group ?? null;
  const count = groups?.find((g) => g.group === effectiveGroup)?.count ?? 0;

  const query = useIoOut(effectiveGroup, index);
  const basePath = `/io/out/${effectiveGroup}/${index}`;

  if (groupsQuery.isLoading) return <p>Loading I/O groups...</p>;
  if (groupsQuery.isError) return <p className="error">{(groupsQuery.error as Error).message}</p>;
  if (!groups || groups.length === 0) return <p>No output groups reported by the console.</p>;

  return (
    <div className="mixer-stage-groups">
      <div className="mixer-routing__select-row">
        <label className="mixer-routing__select">
          <span>Physical output — Group</span>
          <select
            value={effectiveGroup ?? ""}
            onChange={(event) => {
              setGroup(event.target.value);
              setIndex(1);
            }}
          >
            {groups.map((g) => (
              <option key={g.group} value={g.group}>
                {groupOptionLabel(g.group)} ({g.count})
              </option>
            ))}
          </select>
        </label>
        <label className="mixer-routing__select">
          <span>Physical output — Number</span>
          <select value={index} onChange={(event) => setIndex(Number(event.target.value))}>
            {Array.from({ length: count }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
      </div>

      {query.isLoading && <p>Loading...</p>}
      {query.isError && <p className="error">{(query.error as Error).message}</p>}
      {effectiveGroup && query.data && (
        <SourceMappingCard
          key={`out-${effectiveGroup}-${index}`}
          heading={`What feeds ${effectiveGroup} output ${index}?`}
          basePath={basePath}
          values={query.data.values}
          params={query.data.params}
          ioGroups={groupsQuery.data?.inputGroups}
          onRefetch={() => void query.refetch()}
        />
      )}
    </div>
  );
}

function FxSection() {
  const [slot, setSlot] = useState(1);
  const fxQuery = useFx(slot);
  const model = fxQuery.data?.values.mdl;

  return (
    <div className="mixer-processing">
      <label className="mixer-routing__select">
        <span>FX Slot</span>
        <select value={slot} onChange={(event) => setSlot(Number(event.target.value))}>
          {Array.from({ length: 16 }, (_, i) => i + 1).map((n) => (
            <option key={n} value={n}>
              FX {n}
            </option>
          ))}
        </select>
      </label>

      <div className="mixer-stage-group">
        <div className="mixer-processing-card__header">
          <h3>
            FX {slot}
            {model && model !== "NONE" ? ` · ${model}` : ""}
          </h3>
          <button className="mixer-refresh" onClick={() => void fxQuery.refetch()} disabled={fxQuery.isLoading}>
            {fxQuery.isLoading ? "Loading..." : "Refresh"}
          </button>
        </div>
        {fxQuery.isError && <p className="error">{(fxQuery.error as Error).message}</p>}
        {fxQuery.data && fxQuery.data.params.length === 0 && (
          <p className="card-hint">The console reported no parameters for this slot. Refresh, or load an effect on it from the console.</p>
        )}
        {fxQuery.data && fxQuery.data.params.length > 0 && (
          <ParamPanel
            key={`fx-${slot}`}
            panel={fxQuery.data}
            leadingKeys={["mdl", "fxmix"]}
            labels={FX_PARAM_LABELS}
            onSet={(key, value) => setWingValue(`/fx/${slot}/${key}`, value)}
            onStructuralChange={() => void fxQuery.refetch()}
          />
        )}
      </div>
    </div>
  );
}

/** No `pan` and no `mode` here, unlike bus/matrix sends — verified against real hardware: a channel's
 * send to a main is just {on, lvl, pre}. */
function MainRoutingRow({
  indexPrefix = "M",
  target,
  channel,
  send,
  pathFor,
  onLocal,
}: {
  indexPrefix?: string;
  target?: WingStageStrip;
  channel: number;
  send: WingMainSendState;
  pathFor: (channel: number, index: number) => string;
  onLocal: (index: number, patch: Partial<WingMainSendState>) => void;
}) {
  const basePath = pathFor(channel, send.index);
  const commitLevel = useThrottledCommit<number>(120, (v) => void bulkSetWing(basePath, { lvl: v }));

  function toggleOn() {
    const next = !send.on;
    onLocal(send.index, { on: next });
    void bulkSetWing(basePath, { on: next ? 1 : 0 });
  }

  function togglePre() {
    const next = !send.pre;
    onLocal(send.index, { pre: next });
    void bulkSetWing(basePath, { pre: next ? 1 : 0 });
  }

  return (
    <div className={send.on ? "mixer-strip mixer-strip--main-routing" : "mixer-strip mixer-strip--main-routing mixer-strip--send-off"}>
      <RoutingTarget prefix={indexPrefix} index={send.index} target={target} />
      <button className={send.on ? "mixer-mute mixer-mute--on" : "mixer-mute"} onClick={toggleOn}>
        {send.on ? "On" : "Off"}
      </button>
      <button className="mixer-mute" onClick={togglePre}>
        {send.pre ? "PRE" : "POST"}
      </button>
      <FaderControl
        label="Level"
        value={send.levelDb}
        onChange={(v) => {
          onLocal(send.index, { levelDb: v });
          commitLevel(v);
        }}
      />
    </div>
  );
}

/**
 * Server-driven fader ramp for any channel/bus/main/matrix/DCA fader. Value semantics match what
 * was asked for: leave "Value" empty for the direction's default (0dB for Fade In, -∞ for Fade
 * Out), or fill it in as either an absolute target ("Absolute") or a delta from the current value
 * ("Relative", e.g. -6 to fade out by 6dB from wherever the fader currently sits).
 */
function FadeSection({ mixerState, channels }: { mixerState: WingMixerState | undefined; channels: WingChannelStrip[] }) {
  const [type, setType] = useState<FadeTargetType>("channel");
  const [index, setIndex] = useState(1);
  const [mode, setMode] = useState<"absolute" | "relative">("absolute");
  const [valueStr, setValueStr] = useState("");
  const [durationSec, setDurationSec] = useState(3);
  const [easing, setEasing] = useState<EasingName>("linear");
  const [isFading, setIsFading] = useState(false);
  const fadeTimeoutRef = useRef<number | undefined>(undefined);

  const fade = useFade();
  const cancelFade = useCancelFade();

  const maxIndex = type === "channel" ? channels.length || 40 : FADE_COUNTS[type];
  const path = `${FADE_PATH_PREFIX[type]}/${index}/fdr`;
  const items = mixerState?.[FADE_STATE_KEY[type]];
  const current = items?.find((item) => item.index === index);

  function selectType(next: FadeTargetType) {
    setType(next);
    setIndex(1);
  }

  function armFadeTimer(durationMs: number) {
    setIsFading(true);
    if (fadeTimeoutRef.current !== undefined) window.clearTimeout(fadeTimeoutRef.current);
    fadeTimeoutRef.current = window.setTimeout(() => setIsFading(false), durationMs);
  }

  function trigger(direction: "in" | "out") {
    const value = valueStr.trim() === "" ? undefined : Number(valueStr);
    const body: { path: string; durationMs: number; direction: "in" | "out"; to?: number; deltaDb?: number; easing: EasingName } = {
      path,
      durationMs: Math.round(durationSec * 1000),
      direction,
      easing,
    };
    if (value !== undefined && Number.isFinite(value)) {
      if (mode === "absolute") body.to = value;
      else body.deltaDb = value;
    }
    fade.mutate(body, { onSuccess: (result) => armFadeTimer(result.durationMs) });
  }

  function stop() {
    if (fadeTimeoutRef.current !== undefined) window.clearTimeout(fadeTimeoutRef.current);
    setIsFading(false);
    cancelFade.mutate(path);
  }

  return (
    <div className="mixer-processing">
      <div className="mixer-routing__select-row">
        <label className="mixer-routing__select">
          <span>Type</span>
          <select value={type} onChange={(event) => selectType(event.target.value as FadeTargetType)}>
            <option value="channel">Channel</option>
            <option value="aux">Aux</option>
            <option value="bus">Bus</option>
            <option value="main">Main</option>
            <option value="mtx">Matrix</option>
            <option value="dca">DCA</option>
          </select>
        </label>
        <label className="mixer-routing__select">
          <span>{type === "channel" || type === "aux" ? "Channel" : "Index"}</span>
          <select value={index} onChange={(event) => setIndex(Number(event.target.value))}>
            {Array.from({ length: maxIndex }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>
                {type === "channel" || type === "aux"
                  ? `${n}. ${items?.find((c) => c.index === n)?.name || (type === "channel" ? "Channel " : "Aux ") + n}`
                  : n}
              </option>
            ))}
          </select>
        </label>
      </div>

      {current && (
        <p className="meters-status">
          Current: {formatDb(current.fader)}
          {isFading ? " — fading..." : ""}
        </p>
      )}

      <div className="param-panel">
        <div className="param-field">
          <span className="param-field__label">Mode</span>
          <select value={mode} onChange={(event) => setMode(event.target.value as "absolute" | "relative")}>
            <option value="absolute">Absolute target (dB)</option>
            <option value="relative">Relative (add dB)</option>
          </select>
        </div>
        <div className="param-field">
          <span className="param-field__label">Value</span>
          <input
            type="number"
            step={0.5}
            placeholder={mode === "absolute" ? "default: 0 in / -∞ out" : "e.g. -6 or 6"}
            value={valueStr}
            onChange={(event) => setValueStr(event.target.value)}
          />
        </div>
        <div className="param-field">
          <span className="param-field__label">Duration</span>
          <input
            type="number"
            step={0.5}
            min={0.1}
            value={durationSec}
            onChange={(event) => setDurationSec(Number(event.target.value))}
            style={{ flex: "none", width: "5rem" }}
          />
          <span className="param-field__value">sec</span>
        </div>
        <div className="param-field">
          <span className="param-field__label">Curve</span>
          <select value={easing} onChange={(event) => setEasing(event.target.value as EasingName)}>
            {EASING_NAMES.map((name) => (
              <option key={name} value={name}>
                {EASING_LABELS[name]}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="mixer-fade-actions">
        <button className="mixer-mute mixer-mute--on" onClick={() => trigger("in")} disabled={isFading}>
          Fade In
        </button>
        <button className="mixer-mute mixer-mute--active" onClick={() => trigger("out")} disabled={isFading}>
          Fade Out
        </button>
        <button className="mixer-mute" onClick={stop} disabled={!isFading}>
          Stop
        </button>
      </div>

      {fade.isError && <p className="error">{(fade.error as Error).message}</p>}
      {fade.isSuccess && (
        <p className="success">
          Fading {path} from {fade.data.from.toFixed(1)} dB to {fade.data.to <= -144 ? "-∞" : fade.data.to.toFixed(1) + " dB"} over{" "}
          {(fade.data.durationMs / 1000).toFixed(1)}s ({EASING_LABELS[fade.data.easing]})
        </p>
      )}
    </div>
  );
}
