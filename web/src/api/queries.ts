import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "./client.js";

export type HealthStatus = "HEALTHY" | "DEGRADED" | "ERROR";

export interface PluginHealth {
  status: HealthStatus;
  detail?: Record<string, unknown>;
  errorMessage?: string;
}

export interface PluginSummary {
  id: string;
  name: string;
  health: PluginHealth;
}

export interface ServerStatus {
  server: {
    uptimeSeconds: number;
    version: string;
    startedAt: number;
    nodeVersion: string;
  };
  plugins: PluginSummary[];
}

export interface PluginConfig {
  schema: Record<string, unknown>;
  config: unknown;
}

export interface WingChannelState {
  index: number;
  name: string;
  muted: boolean;
  db: number;
}

export interface WingScene {
  index: number;
  name: string;
}

export interface WingScenesResult {
  scenes: WingScene[];
  current: unknown;
}

export interface RecallSceneRequest {
  target: number | string;
  byTag?: boolean;
}

export interface WingDiscoveryResult {
  ip: string;
  name: string;
  model: string;
  serial: string;
  firmware: string;
}

export interface WingChannelStrip {
  index: number;
  name: string;
  fader: number;
  muted: boolean;
  pan: number;
}

export interface WingStageStrip {
  index: number;
  name: string;
  fader: number;
  muted: boolean;
}

export interface WingMutegroupStrip {
  index: number;
  name: string;
  muted: boolean;
}

export interface WingMixerState {
  channels: WingChannelStrip[];
  auxes: WingChannelStrip[];
  buses: WingStageStrip[];
  mains: WingStageStrip[];
  matrices: WingStageStrip[];
  dcas: WingStageStrip[];
  mutegroups: WingMutegroupStrip[];
}

/** A channel's send to a bus/matrix — verified against real hardware: PRE/POST/GRP mode + pan. */
export interface WingBusMtxSendState {
  index: number;
  on: boolean;
  levelDb: number;
  mode: string;
  pan: number;
}

/** A channel's send to a main — verified against real hardware: a plain pre/post boolean, no pan. */
export interface WingMainSendState {
  index: number;
  on: boolean;
  levelDb: number;
  pre: boolean;
}

export interface WingChannelSends {
  bus: WingBusMtxSendState[];
  mtx: WingBusMtxSendState[];
  main: WingMainSendState[];
}

/**
 * A bus's sends to every OTHER bus (self excluded server-side, see /bus/:index/sends), every
 * matrix, and every main. Verified against real hardware: unlike a channel/aux's sends, ALL THREE
 * of a bus's sends carry the reduced {on,lvl,pre} shape (no mode enum, no pan) — so every field
 * here is WingMainSendState, not WingBusMtxSendState.
 */
export interface WingBusSends {
  bus: WingMainSendState[];
  mtx: WingMainSendState[];
  main: WingMainSendState[];
}

/**
 * A main's sends — verified against real hardware to be matrix-only (no send-to-main, no
 * send-to-bus), and to carry the same reduced {on,lvl,pre} shape as a channel/bus's send-to-main
 * (a plain pre/post boolean, no mode enum, no pan) rather than the fuller bus/matrix send shape.
 */
export interface WingMainSends {
  mtx: WingMainSendState[];
}

export interface WingIoGroup {
  group: string;
  count: number;
}

export interface WingIoGroups {
  inputGroups: WingIoGroup[];
  outputGroups: WingIoGroup[];
}

export interface WingAck {
  status: string;
  ok: boolean;
}

export interface WingDescribeParam {
  key: string;
  kind: "int" | "lin" | "log" | "list" | "string" | "fader" | "unknown";
  min?: number;
  max?: number;
  unit?: string;
  steps?: number;
  options?: string[];
  maxLength?: number;
}

export interface WingParamPanel {
  params: WingDescribeParam[];
  values: Record<string, string | number>;
}

export function usePlugins() {
  return useQuery({
    queryKey: ["plugins"],
    queryFn: () => apiFetch<PluginSummary[]>("/api/plugins"),
    refetchInterval: 8000,
  });
}

export function useStatus() {
  return useQuery({
    queryKey: ["status"],
    queryFn: () => apiFetch<ServerStatus>("/api/status"),
    refetchInterval: 8000,
  });
}

export function usePluginConfig(id: string) {
  return useQuery({
    queryKey: ["plugin-config", id],
    queryFn: () => apiFetch<PluginConfig>("/api/plugins/" + id + "/config"),
    staleTime: 30_000,
  });
}

export function useUpdateConfig(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (value: unknown) =>
      apiFetch<{ config: unknown }>("/api/plugins/" + id + "/config", {
        method: "PUT",
        body: JSON.stringify(value),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["plugin-config", id] });
    },
  });
}

// These two queries depend on the WING console actually being reachable over the network.
// The default retry behavior (3 attempts with exponential backoff, up to ~30s) combined with a
// short refetchInterval means a genuinely unreachable console spends most of its time hidden
// behind a "Loading..." state with only brief flashes of the real error — fail fast instead so
// connectivity problems are visible almost as soon as the request itself times out.
export function useWingState() {
  return useQuery({
    queryKey: ["wing-state"],
    queryFn: () => apiFetch<WingChannelState[]>("/api/plugins/wing/state"),
    refetchInterval: 5000,
    retry: 1,
    retryDelay: 300,
  });
}

export function useWingScenes() {
  return useQuery({
    queryKey: ["wing-scenes"],
    queryFn: () => apiFetch<WingScenesResult>("/api/plugins/wing/scenes"),
    refetchInterval: 10_000,
    retry: 1,
    retryDelay: 300,
  });
}

// Loaded once (staleTime: Infinity) via a full-tree dump; kept in sync afterward by merging the
// "param-change" SSE stream in useWingMixer.ts rather than by refetching (refetching this ~92-request
// snapshot on an interval would be both slow and pointless once the live subscription is doing the
// same job incrementally).
export function useMixerState() {
  return useQuery({
    queryKey: ["wing-mixer-state"],
    queryFn: () => apiFetch<WingMixerState>("/api/plugins/wing/mixer-state"),
    // No retry: the server already applies an 8s budget internally before giving up (see
    // /mixer-state), so a retry would just double an already-deliberate wait for no real chance
    // of a different outcome. The "Refresh" button lets the user retry explicitly instead.
    retry: false,
    staleTime: Infinity,
  });
}

export function useChannelSends(channel: number | null) {
  return useQuery({
    queryKey: ["wing-channel-sends", channel],
    queryFn: () => apiFetch<WingChannelSends>("/api/plugins/wing/channels/" + channel + "/sends"),
    enabled: channel !== null,
    // Same rationale as useMixerState: the server already applies its own timeout budget.
    retry: false,
  });
}

/** Aux verified against real hardware to share the exact same sends shape as a channel. */
export function useAuxSends(aux: number | null) {
  return useQuery({
    queryKey: ["wing-aux-sends", aux],
    queryFn: () => apiFetch<WingChannelSends>("/api/plugins/wing/aux/" + aux + "/sends"),
    enabled: aux !== null,
    retry: false,
  });
}

/** A bus is itself a routing source too — verified against real hardware (bus.md's send/1..16,
 * send/MX1..8, main/1..4) — not just a destination for channel/aux sends. */
export function useBusSends(bus: number | null) {
  return useQuery({
    queryKey: ["wing-bus-sends", bus],
    queryFn: () => apiFetch<WingBusSends>("/api/plugins/wing/bus/" + bus + "/sends"),
    enabled: bus !== null,
    retry: false,
  });
}

export function useMainSends(main: number | null) {
  return useQuery({
    queryKey: ["wing-main-sends", main],
    queryFn: () => apiFetch<WingMainSends>("/api/plugins/wing/main/" + main + "/sends"),
    enabled: main !== null,
    retry: false,
  });
}

export type GroupMemberKind = "channel" | "aux" | "bus" | "main" | "mtx";

const GROUP_MEMBER_PATH_SEGMENT: Record<GroupMemberKind, string> = { channel: "channels", aux: "aux", bus: "bus", main: "main", mtx: "mtx" };

export interface WingGroups {
  dca: number[];
  mutegroups: number[];
}

/**
 * DCA/mute group membership — verified against real hardware to NOT be a separate node; it's
 * reserved `#D<n>`/`#M<n>` tokens inside the strip's own `tags` field (see wing-group-tags.ts on
 * the server). Available for channel/aux/bus/main/matrix — every node type confirmed to have a
 * `tags` field.
 */
export function useGroups(kind: GroupMemberKind, index: number | null) {
  return useQuery({
    queryKey: ["wing-groups", kind, index],
    queryFn: () => apiFetch<WingGroups>(`/api/plugins/wing/${GROUP_MEMBER_PATH_SEGMENT[kind]}/${index}/groups`),
    enabled: index !== null,
    retry: false,
  });
}

export interface ToggleGroupRequest {
  kind: GroupMemberKind;
  index: number;
  group: "dca" | "mutegroup";
  groupIndex: number;
  on: boolean;
}

export function useToggleGroup() {
  return useMutation({
    mutationFn: (req: ToggleGroupRequest) =>
      apiFetch<WingGroups>(`/api/plugins/wing/${GROUP_MEMBER_PATH_SEGMENT[req.kind]}/${req.index}/groups/toggle`, {
        method: "POST",
        body: JSON.stringify({ kind: req.group, index: req.groupIndex, on: req.on }),
      }),
  });
}

export type RtaSourceType = "channel" | "aux" | "bus" | "main" | "matrix";

export const RTA_SOURCE_TYPES: readonly RtaSourceType[] = ["channel", "aux", "bus", "main", "matrix"];

export const RTA_TAP_VALUES = [
  "IN", "POST", "FILT", "PREEQ", "POSTEQ", "PREFDR", "GATEK", "DYNK", "DYNXO", "PRETAP", "SOLO",
  "MON.PH", "MON.SPK", "FXIN", "FXOUT",
] as const;

export interface WingRtaSourceState {
  rawIndex: number;
  source: { type: RtaSourceType; index: number } | null;
  tap: string | null;
}

/** What the RTA (see wing_get_rta) is currently analyzing — the console's own numeric encoding for
 * this is not officially documented past its 0..76 range; see wing-rta-source.ts on the server for
 * how `source` is inferred from `rawIndex`. */
export function useRtaSource() {
  return useQuery({
    queryKey: ["wing-rta-source"],
    queryFn: () => apiFetch<WingRtaSourceState>("/api/plugins/wing/rta/source"),
    retry: false,
  });
}

export interface SetRtaSourceRequest {
  type: RtaSourceType;
  index: number;
  tap?: string;
}

export function useSetRtaSource() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (req: SetRtaSourceRequest) =>
      apiFetch("/api/plugins/wing/rta/source", { method: "POST", body: JSON.stringify(req) }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["wing-rta-source"] });
    },
  });
}

export function useIoGroups() {
  return useQuery({
    queryKey: ["wing-io-groups"],
    queryFn: () => apiFetch<WingIoGroups>("/api/plugins/wing/io"),
    retry: false,
    staleTime: 60_000,
  });
}

/** A physical input's own properties (gain trim, 48V phantom, polarity, mute, name/color/icon) —
 * same describe+dump ParamPanel mechanism as EQ/Gate/Dynamics, just pointed at /io/in/<group>/<n>. */
export function useIoIn(group: string | null, index: number | null) {
  return useQuery({
    queryKey: ["wing-io-in", group, index],
    queryFn: () => apiFetch<WingParamPanel>("/api/plugins/wing/io/in/" + group + "/" + index),
    enabled: group !== null && index !== null,
    retry: false,
  });
}

/** A physical output's patch ({grp, in}: which internal source feeds this physical output). */
export function useIoOut(group: string | null, index: number | null) {
  return useQuery({
    queryKey: ["wing-io-out", group, index],
    queryFn: () => apiFetch<WingParamPanel>("/api/plugins/wing/io/out/" + group + "/" + index),
    enabled: group !== null && index !== null,
    retry: false,
  });
}

/** A channel's physical input mapping ({grp, in, altgrp, altin}) — how "map channel 3 to AES
 * input 7" is expressed on the wire. */
export function useChannelInConn(channel: number | null) {
  return useQuery({
    queryKey: ["wing-channel-in-conn", channel],
    queryFn: () => apiFetch<WingParamPanel>("/api/plugins/wing/channels/" + channel + "/in/conn"),
    enabled: channel !== null,
    retry: false,
  });
}

/** Aux shares the exact same {grp,in,altgrp,altin} input-mapping shape as a channel. */
export function useAuxInConn(aux: number | null) {
  return useQuery({
    queryKey: ["wing-aux-in-conn", aux],
    queryFn: () => apiFetch<WingParamPanel>("/api/plugins/wing/aux/" + aux + "/in/conn"),
    enabled: aux !== null,
    retry: false,
  });
}

/**
 * EQ/Gate/Dynamics/FX panels: each is a "describe (types/ranges/enums) + dump (current values)"
 * pair for one processing node, loaded on demand (not part of the initial ~92-request mixer
 * snapshot) since there are far too many of these nodes to warm eagerly. Not merged with the
 * live SSE stream — like Routing's sends, these refresh via an explicit "Refresh"/reselect rather
 * than incremental push, since generating per-field regexes for every eq/gate/dyn/fx parameter
 * across every node type would be a lot of code for a low-traffic panel.
 */
export function useChannelEq(channel: number | null) {
  return useQuery({
    queryKey: ["wing-channel-eq", channel],
    queryFn: () => apiFetch<WingParamPanel>("/api/plugins/wing/channels/" + channel + "/eq"),
    enabled: channel !== null,
    retry: false,
  });
}

export function useChannelGate(channel: number | null) {
  return useQuery({
    queryKey: ["wing-channel-gate", channel],
    queryFn: () => apiFetch<WingParamPanel>("/api/plugins/wing/channels/" + channel + "/gate"),
    enabled: channel !== null,
    retry: false,
  });
}

export function useChannelDyn(channel: number | null) {
  return useQuery({
    queryKey: ["wing-channel-dyn", channel],
    queryFn: () => apiFetch<WingParamPanel>("/api/plugins/wing/channels/" + channel + "/dyn"),
    enabled: channel !== null,
    retry: false,
  });
}

/** Aux has EQ and Dynamics like a channel, but no Gate — verified against real hardware (its
 * branch listing has no "gate"/"gatesc" field at all), so there is no useAuxGate. */
export function useAuxEq(aux: number | null) {
  return useQuery({
    queryKey: ["wing-aux-eq", aux],
    queryFn: () => apiFetch<WingParamPanel>("/api/plugins/wing/aux/" + aux + "/eq"),
    enabled: aux !== null,
    retry: false,
  });
}

export function useAuxDyn(aux: number | null) {
  return useQuery({
    queryKey: ["wing-aux-dyn", aux],
    queryFn: () => apiFetch<WingParamPanel>("/api/plugins/wing/aux/" + aux + "/dyn"),
    enabled: aux !== null,
    retry: false,
  });
}

/** Processing order (Gate/EQ/Dynamics/Insert reordering) — channel-exclusive, see the matching
 * route doc in http-routes.ts for why this can't use the same describe+dump mechanism as EQ/Gate/Dyn. */
export function useChannelProc(channel: number | null) {
  return useQuery({
    queryKey: ["wing-channel-proc", channel],
    queryFn: () => apiFetch<{ value: string }>("/api/plugins/wing/channels/" + channel + "/proc"),
    enabled: channel !== null,
    retry: false,
  });
}

export function useStripEq(type: "bus" | "main" | "mtx" | null, index: number | null) {
  return useQuery({
    queryKey: ["wing-strip-eq", type, index],
    queryFn: () => apiFetch<WingParamPanel>("/api/plugins/wing/strips/" + type + "/" + index + "/eq"),
    enabled: type !== null && index !== null,
    retry: false,
  });
}

export function useStripDyn(type: "bus" | "main" | "mtx" | null, index: number | null) {
  return useQuery({
    queryKey: ["wing-strip-dyn", type, index],
    queryFn: () => apiFetch<WingParamPanel>("/api/plugins/wing/strips/" + type + "/" + index + "/dyn"),
    enabled: type !== null && index !== null,
    retry: false,
  });
}

export function useFx(index: number | null) {
  return useQuery({
    queryKey: ["wing-fx", index],
    queryFn: () => apiFetch<WingParamPanel>("/api/plugins/wing/fx/" + index),
    enabled: index !== null,
    retry: false,
  });
}

export interface WingAutogainResult {
  measuredPeakDb: number;
  targetDb: number;
  oldValue: number;
  newValue: number;
  clamped: boolean;
  ack: WingAck;
}

/**
 * A channel/aux Auto Gain run: gain-staging first (the connected physical input's preamp, if any),
 * trim only "as needed" afterward — see the matching algorithm doc on `runCombinedAutoGain()` in
 * wing-autogain.ts. Distinct from `WingAutogainResult` (the single-field shape `kind: "io"` still
 * returns, for the dedicated physical-input Preamp Gain card).
 */
export interface WingCombinedAutogainResult {
  mode: "gain" | "trim" | "both";
  physicalSource: { group: string; index: number } | null;
  gain: WingAutogainResult | null;
  trim: WingAutogainResult | null;
  trimLeftAtZero: boolean;
}

type AutogainRequest =
  | { kind: "channel" | "aux"; index: number; targetDb: number }
  /** Adjusts a physical input's own analog preamp gain, sampling whichever channel/aux it's
   * currently routed to (see useIoRoutedChannels) since the metering protocol has no verified way
   * to sample the physical input's level directly. */
  | { kind: "io"; group: string; index: number; meterType: "channel" | "aux"; meterIndex: number; targetDb: number };

/** Samples the target's live input peak for ~1.2s server-side, then adjusts its gain/trim to hit
 * `targetDb` — see the matching route doc in http-routes.ts for why this can't be a single GET. */
export function useAutogain() {
  return useMutation<WingAutogainResult | WingCombinedAutogainResult, Error, AutogainRequest>({
    mutationFn: (req) => {
      if (req.kind === "io") {
        return apiFetch<WingAutogainResult>(`/api/plugins/wing/io/in/${req.group}/${req.index}/autogain`, {
          method: "POST",
          body: JSON.stringify({ meterType: req.meterType, meterIndex: req.meterIndex, targetDb: req.targetDb }),
        });
      }
      return apiFetch<WingCombinedAutogainResult>(
        "/api/plugins/wing/" + (req.kind === "channel" ? "channels" : "aux") + "/" + req.index + "/autogain",
        { method: "POST", body: JSON.stringify({ targetDb: req.targetDb }) },
      );
    },
  });
}

export interface WingIoRoutedChannels {
  channels: number[];
  auxes: number[];
}

/** Which channels/aux currently have this physical input as their primary source — see the
 * matching route doc in http-routes.ts for why this needs a reverse lookup across every
 * channel/aux rather than a single GET. */
export function useIoRoutedChannels(group: string | null, index: number | null) {
  return useQuery({
    queryKey: ["wing-io-routed-channels", group, index],
    queryFn: () => apiFetch<WingIoRoutedChannels>(`/api/plugins/wing/io/in/${group}/${index}/routed-channels`),
    enabled: group !== null && index !== null,
    retry: false,
  });
}

export interface FadeRequest {
  path: string;
  durationMs: number;
  direction: "in" | "out";
  /** Absolute target in dB. Omit both this and `deltaDb` to get the direction's default (0dB for "in", -∞ for "out"). */
  to?: number;
  /** Relative target: resolves server-side to (current value) + deltaDb. */
  deltaDb?: number;
}

export interface FadeResult {
  status: string;
  path: string;
  from: number;
  to: number;
  durationMs: number;
  steps: number;
}

/** Starts a server-driven fader ramp — see the matching route doc in http-routes.ts. Returns as
 * soon as the ramp is scheduled, not when it finishes; the fader's live value (and this call's
 * `to`/`durationMs`) let the UI show its own progress locally. */
export function useFade() {
  return useMutation({
    mutationFn: (request: FadeRequest) =>
      apiFetch<FadeResult>("/api/plugins/wing/fade", { method: "POST", body: JSON.stringify(request) }),
  });
}

export function useCancelFade() {
  return useMutation({
    mutationFn: (path: string) => apiFetch<{ status: string }>("/api/plugins/wing/fade/cancel", { method: "POST", body: JSON.stringify({ path }) }),
  });
}

export interface WingTimeField {
  display: string;
  seconds: number;
}

export interface WingMediaSong {
  index: number;
  name: string;
}

export interface WingMediaState {
  usb: { state: string; volumeName: string };
  play: {
    state: string;
    /** Verified against real hardware: describing the $songs *leaf* never replies, but describing
     * its parent branch "/play" does, and its inline enum for $songs is the actual file list. */
    songs: WingMediaSong[];
    currentIndex: number | null;
    file: string;
    song: string;
    album: string;
    artist: string;
    pos: WingTimeField;
    total: WingTimeField;
    resolution: string;
    channels: string;
    rate: string;
    format: string;
    repeat: boolean;
  };
  rec: {
    state: string;
    file: string;
    path: string;
    time: WingTimeField;
    resolution: string;
    channels: string;
  };
}

/** Verified against real hardware: WING exposes one combined USB player/recorder module (no
 * separate SD-card module) — see the matching route doc in http-routes.ts. */
export function useMediaState() {
  return useQuery({
    queryKey: ["wing-media"],
    queryFn: () => apiFetch<WingMediaState>("/api/plugins/wing/media"),
    refetchInterval: 3000,
    retry: false,
  });
}

export type WingPlayAction = "IDLE" | "STOP" | "PLAY" | "PAUSE" | "NEXT" | "PREV" | "PLAYFILE";
export type WingRecAction = "IDLE" | "STOP" | "REC" | "PAUSE" | "NEWFILE";

export function usePlayAction() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ action, file, index }: { action: WingPlayAction; file?: string; index?: number }) =>
      apiFetch<WingAck>("/api/plugins/wing/media/play", { method: "POST", body: JSON.stringify({ action, file, index }) }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["wing-media"] }),
  });
}

export function useRecAction() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (action: WingRecAction) =>
      apiFetch<WingAck>("/api/plugins/wing/media/rec", { method: "POST", body: JSON.stringify({ action }) }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["wing-media"] }),
  });
}

/**
 * Plain (non-hook) write primitives for the Mixer tab's controls: called directly from
 * throttled slider/button callbacks rather than through useMutation, since each control
 * manages its own throttling/optimistic-update lifecycle rather than React Query's.
 */
export function setWingValue(path: string, value: number | string): Promise<WingAck> {
  return apiFetch<WingAck>("/api/plugins/wing/set", { method: "POST", body: JSON.stringify({ path, value }) });
}

export function bulkSetWing(baseNode: string, assignments: Record<string, number | string>): Promise<WingAck> {
  return apiFetch<WingAck>("/api/plugins/wing/bulk-set", {
    method: "POST",
    body: JSON.stringify({ baseNode, assignments }),
  });
}

export function useWingDiscover() {
  return useMutation({
    mutationFn: () => apiFetch<WingDiscoveryResult[]>("/api/plugins/wing/discover"),
  });
}

export function useRecallScene() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (request: RecallSceneRequest) =>
      apiFetch<unknown>("/api/plugins/wing/scenes/recall", {
        method: "POST",
        body: JSON.stringify(request),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["wing-scenes"] });
    },
  });
}

/** NEXT/PREV through the open show's scenes — verified working on real hardware, unlike full
 * enumeration (see WingScenesResult). */
export function useStepScene() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (direction: "next" | "prev") =>
      apiFetch<WingAck>("/api/plugins/wing/scenes/step", { method: "POST", body: JSON.stringify({ direction }) }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["wing-scenes"] });
    },
  });
}
