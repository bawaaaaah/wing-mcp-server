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
  col: number;
  icon: number;
  /** `in/set/srcauto` — whether this strip's name/customization is linked to its physical source. */
  srcAuto: boolean;
}

export interface WingStageStrip {
  index: number;
  name: string;
  fader: number;
  muted: boolean;
  col: number;
  icon: number;
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

export interface PasskeySummary {
  id: string;
  name: string;
  rpId: string;
  createdAt: string;
  lastUsedAt?: string;
}

export function usePasskeys() {
  return useQuery({
    queryKey: ["passkeys"],
    queryFn: () => apiFetch<{ passkeys: PasskeySummary[] }>("/api/auth/passkeys"),
  });
}

/** The static token MCP clients authenticate with — not necessarily what this browser signed in with
 * (a passkey login holds a web session token instead). */
export function useServerToken() {
  return useQuery({
    queryKey: ["server-token"],
    queryFn: () => apiFetch<{ token: string }>("/api/auth/server-token"),
    staleTime: Infinity,
  });
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
      // A config change (e.g. switching the WING host to a different physical console) can make
      // every other query for this plugin stale, not just the config itself — mixer state, names,
      // scenes, etc. all describe the *previous* console until refetched. Everything else in this
      // file keys its plugin-specific queries as `${id}-...`, so a prefix match catches all of them
      // without this generic hook needing to know their exact names.
      void queryClient.invalidateQueries({
        predicate: (query) => {
          const key = query.queryKey[0];
          return typeof key === "string" && key.startsWith(`${id}-`);
        },
      });
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

/** Sets a channel's Gate/EQ/Dynamics/Insert processing order — see wing-proc-order.ts on the
 * server for the 24-permutation validation (this dedicated route rejects a bad order with a 422
 * before ever touching the console, unlike the generic wing_set path). */
export function useSetChannelProc() {
  const queryClient = useQueryClient();
  return useMutation<{ channel: number; order: string; ack: WingAck }, Error, { channel: number; order: string }>({
    mutationFn: (req) =>
      apiFetch("/api/plugins/wing/channels/" + req.channel + "/proc", {
        method: "POST",
        body: JSON.stringify({ order: req.order }),
      }),
    onSuccess: (_data, req) => {
      void queryClient.invalidateQueries({ queryKey: ["wing-channel-proc", req.channel] });
    },
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

export interface WingInsertStatus {
  type: "channel" | "aux" | "bus" | "main" | "matrix";
  index: number;
  slot: "pre" | "post";
  on: boolean;
  fx: string;
  /** Only present for slot "post" — pre-insert has no mode/w fields. */
  mode?: string;
  w?: number;
  status: string | null;
}

function insertPath(kind: "channel" | "aux" | "bus" | "main" | "mtx", index: number, slot: "pre" | "post"): string {
  if (kind === "channel") return `/api/plugins/wing/channels/${index}/insert/${slot}`;
  if (kind === "aux") return `/api/plugins/wing/aux/${index}/insert/${slot}`;
  return `/api/plugins/wing/strips/${kind}/${index}/insert/${slot}`;
}

/** Reads a channel/aux/bus/main/matrix strip's pre- or post-insert status — see wing-insert.ts on
 * the server. Aux has no post-insert stage (the panel that renders this simply doesn't ask for it). */
export function useInsert(kind: "channel" | "aux" | "bus" | "main" | "mtx" | null, index: number | null, slot: "pre" | "post") {
  return useQuery({
    queryKey: ["wing-insert", kind, index, slot],
    queryFn: () => apiFetch<WingInsertStatus>(insertPath(kind as Exclude<typeof kind, null>, index as number, slot)),
    enabled: kind !== null && index !== null,
    retry: false,
  });
}

type SetInsertRequest = {
  kind: "channel" | "aux" | "bus" | "main" | "mtx";
  index: number;
  slot: "pre" | "post";
  on?: boolean;
  fx?: string;
  mode?: string;
  w?: number;
};

/** Turns a strip's pre/post insert on/off and/or patches an FX engine slot into it — see
 * wing-insert.ts on the server for the aux-has-no-post-insert validation. */
export function useSetInsert() {
  const queryClient = useQueryClient();
  return useMutation<WingInsertStatus & { ack: WingAck }, Error, SetInsertRequest>({
    mutationFn: (req) =>
      apiFetch(insertPath(req.kind, req.index, req.slot), {
        method: "POST",
        body: JSON.stringify({ on: req.on, fx: req.fx, mode: req.mode, w: req.w }),
      }),
    onSuccess: (_data, req) => {
      void queryClient.invalidateQueries({ queryKey: ["wing-insert", req.kind, req.index, req.slot] });
    },
  });
}

export interface WingDelayStatus {
  type: "channel" | "aux" | "bus" | "main" | "matrix";
  index: number;
  on: boolean;
  mode: "M" | "FT" | "MS" | "SMP";
  value: number;
}

function delayPath(kind: "channel" | "aux" | "bus" | "main" | "mtx", index: number): string {
  if (kind === "channel") return `/api/plugins/wing/channels/${index}/delay`;
  if (kind === "aux") return `/api/plugins/wing/aux/${index}/delay`;
  return `/api/plugins/wing/strips/${kind}/${index}/delay`;
}

/** Reads a channel/aux/bus/main/matrix strip's delay line — see wing-delay.ts on the server.
 * Channel/aux delay is on the input stage, bus/main/matrix delay is its own output-stage node. */
export function useDelay(kind: "channel" | "aux" | "bus" | "main" | "mtx" | null, index: number | null) {
  return useQuery({
    queryKey: ["wing-delay", kind, index],
    queryFn: () => apiFetch<WingDelayStatus>(delayPath(kind as Exclude<typeof kind, null>, index as number)),
    enabled: kind !== null && index !== null,
    retry: false,
  });
}

type SetDelayRequest = {
  kind: "channel" | "aux" | "bus" | "main" | "mtx";
  index: number;
  on?: boolean;
  mode?: string;
  value?: number;
};

/** Turns a strip's delay line on/off and/or sets its unit + amount — any subset of the three. */
export function useSetDelay() {
  const queryClient = useQueryClient();
  return useMutation<{ type: string; index: number; ack: WingAck }, Error, SetDelayRequest>({
    mutationFn: (req) =>
      apiFetch(delayPath(req.kind, req.index), {
        method: "POST",
        body: JSON.stringify({ on: req.on, mode: req.mode, value: req.value }),
      }),
    onSuccess: (_data, req) => {
      void queryClient.invalidateQueries({ queryKey: ["wing-delay", req.kind, req.index] });
    },
  });
}

export interface WingMatrixDirectInputStatus {
  index: number;
  on: boolean;
  levelDb: number;
  invert: boolean;
  input: string;
}

/** Matrix-exclusive "Direct Input" sub-mixer — see wing-matrix-direct.ts on the server. */
export function useMatrixDirectInput(index: number | null) {
  return useQuery({
    queryKey: ["wing-matrix-direct-input", index],
    queryFn: () => apiFetch<WingMatrixDirectInputStatus>(`/api/plugins/wing/mtx/${index}/direct-input`),
    enabled: index !== null,
    retry: false,
  });
}

type SetMatrixDirectInputRequest = {
  index: number;
  on?: boolean;
  levelDb?: number;
  invert?: boolean;
  input?: string;
};

export function useSetMatrixDirectInput() {
  const queryClient = useQueryClient();
  return useMutation<{ index: number; ack: WingAck }, Error, SetMatrixDirectInputRequest>({
    mutationFn: (req) =>
      apiFetch(`/api/plugins/wing/mtx/${req.index}/direct-input`, {
        method: "POST",
        body: JSON.stringify({ on: req.on, levelDb: req.levelDb, invert: req.invert, input: req.input }),
      }),
    onSuccess: (_data, req) => {
      void queryClient.invalidateQueries({ queryKey: ["wing-matrix-direct-input", req.index] });
    },
  });
}

export interface WingInputPatchStatus {
  type: "channel" | "aux";
  index: number;
  main: { group: string; index: number } | null;
  alt: { group: string; index: number } | null;
  /** true = the Alt source is currently active, false = Main is active. */
  altActive: boolean;
  /** true = the strip's name/customization is linked to its physical source rather than independent. */
  srcAuto: boolean;
}

function inputPatchPath(kind: "channel" | "aux", index: number): string {
  return kind === "channel" ? `/api/plugins/wing/channels/${index}/in/patch` : `/api/plugins/wing/aux/${index}/in/patch`;
}

function altSourceActivePath(kind: "channel" | "aux", index: number): string {
  return kind === "channel" ? `/api/plugins/wing/channels/${index}/in/set/altsrc` : `/api/plugins/wing/aux/${index}/in/set/altsrc`;
}

function srcAutoPath(kind: "channel" | "aux", index: number): string {
  return kind === "channel" ? `/api/plugins/wing/channels/${index}/in/set/srcauto` : `/api/plugins/wing/aux/${index}/in/set/srcauto`;
}

/** Reads a channel/aux's Main+Alt physical input patch and which of the two is active — see wing-input-patch.ts on the server. */
export function useInputPatch(kind: "channel" | "aux" | null, index: number | null) {
  return useQuery({
    queryKey: ["wing-input-patch", kind, index],
    queryFn: () => apiFetch<WingInputPatchStatus>(inputPatchPath(kind as Exclude<typeof kind, null>, index as number)),
    enabled: kind !== null && index !== null,
    retry: false,
  });
}

type SetInputConnectionRequest = { kind: "channel" | "aux"; index: number; slot: "main" | "alt"; grp: string; in: number };

/** Patches a channel/aux's Main or Alt physical input source — see wing-input-patch.ts on the server. */
export function useSetInputConnection() {
  const queryClient = useQueryClient();
  return useMutation<{ type: string; index: number; ack: WingAck }, Error, SetInputConnectionRequest>({
    mutationFn: (req) =>
      apiFetch(inputPatchPath(req.kind, req.index), {
        method: "POST",
        body: JSON.stringify({ slot: req.slot, grp: req.grp, in: req.in }),
      }),
    onSuccess: (_data, req) => {
      void queryClient.invalidateQueries({ queryKey: ["wing-input-patch", req.kind, req.index] });
    },
  });
}

type SetAltSourceActiveRequest = { kind: "channel" | "aux"; index: number; active: boolean };

/** Switches a channel/aux between its Main and Alt physical input source. */
export function useSetAltSourceActive() {
  const queryClient = useQueryClient();
  return useMutation<{ type: string; index: number; ack: WingAck }, Error, SetAltSourceActiveRequest>({
    mutationFn: (req) =>
      apiFetch(altSourceActivePath(req.kind, req.index), {
        method: "POST",
        body: JSON.stringify({ active: req.active }),
      }),
    onSuccess: (_data, req) => {
      void queryClient.invalidateQueries({ queryKey: ["wing-input-patch", req.kind, req.index] });
    },
  });
}

type SetSrcAutoRequest = { kind: "channel" | "aux"; index: number; linked: boolean };

/** Links/unlinks a channel/aux's name/customization to its physical source (`in/set/srcauto`). */
export function useSetSrcAuto() {
  const queryClient = useQueryClient();
  return useMutation<{ type: string; index: number; ack: WingAck }, Error, SetSrcAutoRequest>({
    mutationFn: (req) =>
      apiFetch(srcAutoPath(req.kind, req.index), {
        method: "POST",
        body: JSON.stringify({ linked: req.linked }),
      }),
    onSuccess: (_data, req) => {
      void queryClient.invalidateQueries({ queryKey: ["wing-input-patch", req.kind, req.index] });
    },
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

export type AutoCompressBlock = "gate" | "dyn";
export type AutoCompressTargetMode = "average" | "peak";
export type AutoCompressTargetStopReason = "converged" | "unresponsive" | "range-exhausted" | "max-iterations";

export interface WingAutoCompressResult {
  type: "channel" | "aux" | "bus" | "main" | "matrix";
  index: number;
  block: AutoCompressBlock;
  model: string | undefined;
  wasOn: boolean;
  /** The one control the tool actually drove — a threshold key (`thr`/`cthr`/`1-thr`) or a
   * drive/amount key (`in`/`ingain`/`gr`/`comp`). `unit` is `"dB"` or `""` (unitless knob).
   * `threshold` below mirrors this for threshold-kind models. */
  control: { kind: "threshold" | "input-gain"; key: string; old: number; new: number; unit: string };
  threshold: { old: number; new: number };
  ratio: { new: number | string } | null;
  target: {
    reductionDb: number;
    mode: AutoCompressTargetMode;
    converged: boolean;
    iterations: number;
    stopReason: AutoCompressTargetStopReason;
  } | null;
  measured: {
    meanGainReductionDb: number;
    peakGainReductionDb: number;
    sampleCount: number;
    sampleMs: number;
    gainReductionFullScaleDb: number;
  };
  /** `applied: false` when the model has no makeup-gain field at all (LA-2A) — nothing was written. */
  makeupGain: { old: number; new: number; clamped: boolean; applied: boolean };
  ack: WingAck;
}

type AutoCompressRequest = {
  kind: "channel" | "aux" | "bus" | "main" | "mtx";
  index: number;
  block: AutoCompressBlock;
  thresholdDb?: number;
  targetReductionDb?: number;
  targetMode?: AutoCompressTargetMode;
  maxIterations?: number;
  /** Direct input-drive setter for a model with no threshold (76LA "LE1176", NSTR, L100, LA). */
  inputGainDb?: number;
  ratio?: number | string;
  sampleMs?: number;
};

/**
 * Sets a new threshold (or searches for one that hits a target reduction amount — see
 * `targetReductionDb`/`targetMode` in wing-auto-compress.ts on the server) on a channel/aux/bus/
 * main/matrix's "gate" or "dyn" dynamics-processing slot (either can host a compressor), then
 * measures the actual gain reduction against real program material and compensates it with that
 * slot's own makeup gain — see the matching route doc in http-routes.ts. "gate" is only valid for
 * `kind: "channel"`.
 */
export function useAutoCompress() {
  return useMutation<WingAutoCompressResult, Error, AutoCompressRequest>({
    mutationFn: (req) => {
      const body = JSON.stringify({
        thresholdDb: req.thresholdDb,
        targetReductionDb: req.targetReductionDb,
        targetMode: req.targetMode,
        maxIterations: req.maxIterations,
        inputGainDb: req.inputGainDb,
        ratio: req.ratio,
        sampleMs: req.sampleMs,
      });
      if (req.kind === "channel") {
        return apiFetch<WingAutoCompressResult>(`/api/plugins/wing/channels/${req.index}/${req.block}/auto-compress`, {
          method: "POST",
          body,
        });
      }
      if (req.kind === "aux") {
        return apiFetch<WingAutoCompressResult>(`/api/plugins/wing/aux/${req.index}/dyn/auto-compress`, { method: "POST", body });
      }
      return apiFetch<WingAutoCompressResult>(`/api/plugins/wing/strips/${req.kind}/${req.index}/dyn/auto-compress`, {
        method: "POST",
        body,
      });
    },
  });
}

export interface WingAutoGateResult {
  type: "channel" | "aux" | "bus" | "main" | "matrix";
  index: number;
  block: AutoCompressBlock;
  model: string | undefined;
  wasOn: boolean;
  measured: { noiseFloorDb: number; signalPeakDb: number; marginDb: number; sampleCount: number; sampleMs: number };
  threshold: { old: number; new: number; clamped: boolean };
  ack: WingAck;
}

type AutoGateRequest = {
  kind: "channel" | "aux" | "bus" | "main" | "mtx";
  index: number;
  block: AutoCompressBlock;
  marginDb?: number;
  sampleMs?: number;
};

/**
 * Measures a channel/aux/bus/main/matrix's "gate" or "dyn" dynamics-processing slot's own detector
 * ("key") level against real program material and sets a threshold automatically — see
 * wing-auto-gate.ts on the server for the noise-floor/signal-peak algorithm. "gate" is only valid
 * for `kind: "channel"`.
 */
export function useAutoGate() {
  return useMutation<WingAutoGateResult, Error, AutoGateRequest>({
    mutationFn: (req) => {
      const body = JSON.stringify({ marginDb: req.marginDb, sampleMs: req.sampleMs });
      if (req.kind === "channel") {
        return apiFetch<WingAutoGateResult>(`/api/plugins/wing/channels/${req.index}/${req.block}/auto-gate`, {
          method: "POST",
          body,
        });
      }
      if (req.kind === "aux") {
        return apiFetch<WingAutoGateResult>(`/api/plugins/wing/aux/${req.index}/dyn/auto-gate`, { method: "POST", body });
      }
      return apiFetch<WingAutoGateResult>(`/api/plugins/wing/strips/${req.kind}/${req.index}/dyn/auto-gate`, {
        method: "POST",
        body,
      });
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

export const EASING_NAMES = [
  "linear",
  "quad-in",
  "quad-out",
  "quad-in-out",
  "cubic-in",
  "cubic-out",
  "cubic-in-out",
  "sine-in",
  "sine-out",
  "sine-in-out",
  "expo-in",
  "expo-out",
  "expo-in-out",
] as const;
export type EasingName = (typeof EASING_NAMES)[number];

export interface FadeRequest {
  path: string;
  durationMs: number;
  direction: "in" | "out";
  /** Absolute target in dB. Omit both this and `deltaDb` to get the direction's default (0dB for "in", -∞ for "out"). */
  to?: number;
  /** Relative target: resolves server-side to (current value) + deltaDb. */
  deltaDb?: number;
  /** Progress-shaping curve, default "linear" (constant rate). */
  easing?: EasingName;
}

export interface FadeResult {
  status: string;
  path: string;
  from: number;
  to: number;
  durationMs: number;
  steps: number;
  easing: EasingName;
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

export type WingStripType = "channel" | "aux" | "bus" | "main" | "matrix" | "dca" | "mutegroup";

export const WING_STRIP_TYPES: readonly WingStripType[] = ["channel", "aux", "bus", "main", "matrix", "dca", "mutegroup"];

export interface WingPresetSummary {
  name: string;
  type: WingStripType;
  createdAt: string;
  updatedAt: string;
  slotCount: number;
  sourceIndices: number[];
}

export function useWingPresets() {
  return useQuery({
    queryKey: ["wing-presets"],
    queryFn: () => apiFetch<{ presets: WingPresetSummary[] }>("/api/plugins/wing/presets"),
    retry: false,
  });
}

export interface WingPresetSlotSummary {
  sourceIndex: number;
  name: string | null;
  fader: number | null;
  mute: boolean | null;
  pan: number | null;
  trim: number | null;
  gain: number | null;
  eqOn: boolean | null;
  gateOn: boolean | null;
  dynOn: boolean | null;
}

export interface WingPresetDetail {
  name: string;
  type: WingStripType;
  createdAt: string;
  updatedAt: string;
  slots: WingPresetSlotSummary[];
}

export function useWingPreset(name: string | null) {
  return useQuery({
    queryKey: ["wing-preset", name],
    queryFn: () => apiFetch<WingPresetDetail>(`/api/plugins/wing/presets/${encodeURIComponent(name ?? "")}`),
    enabled: name !== null,
    retry: false,
  });
}

export interface SavePresetRequest {
  name: string;
  type: WingStripType;
  indices: number[];
  overwrite?: boolean;
}

export function useSavePreset() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (req: SavePresetRequest) =>
      apiFetch<{ name: string; type: WingStripType; indices: number[] }>("/api/plugins/wing/presets", {
        method: "POST",
        body: JSON.stringify(req),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["wing-presets"] });
    },
  });
}

export interface LoadPresetRequest {
  name: string;
  targetIndex?: number;
  targetIndices?: number[];
  sections?: string[];
}

export interface WingPresetSectionOutcome {
  section: string;
  status: "applied" | "skipped" | "error";
  detail?: string;
}

export interface WingPresetSlotOutcome {
  sourceIndex: number;
  targetIndex: number;
  status: "ok" | "partial" | "failed";
  sections: WingPresetSectionOutcome[];
  error?: string;
}

export interface WingPresetLoadResult {
  name: string;
  type: WingStripType;
  sections: string[] | null;
  results: WingPresetSlotOutcome[];
  summary: { total: number; ok: number; partial: number; failed: number };
}

export function useLoadPreset() {
  return useMutation({
    mutationFn: (req: LoadPresetRequest) =>
      apiFetch<WingPresetLoadResult>(`/api/plugins/wing/presets/${encodeURIComponent(req.name)}/load`, {
        method: "POST",
        body: JSON.stringify({ targetIndex: req.targetIndex, targetIndices: req.targetIndices, sections: req.sections }),
      }),
  });
}

export function useDeletePreset() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) =>
      apiFetch<{ name: string; deleted: boolean }>(`/api/plugins/wing/presets/${encodeURIComponent(name)}`, { method: "DELETE" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["wing-presets"] });
    },
  });
}

export const AES_PORTS = ["A", "B", "C"] as const;
export type AesPort = (typeof AES_PORTS)[number];

export interface WingAesPortStatus {
  port: AesPort;
  state: string;
  device: string;
  errorsCorrected: number;
  errorsUncorrected: number;
  remoteName: string;
}

export interface WingLinkStatus {
  ports: WingAesPortStatus[];
  stageConnect: { status: string; devices: string; upstreamCount: number; downstreamCount: number };
}

export function useLinkStatus() {
  return useQuery({
    queryKey: ["wing-link-status"],
    queryFn: () => apiFetch<WingLinkStatus>("/api/plugins/wing/link-status"),
    refetchInterval: 5000,
  });
}

export function useClearLinkErrors() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (port: AesPort) =>
      apiFetch<{ port: AesPort; ack: { status: string; ok: boolean; raw: string } }>("/api/plugins/wing/link-status/clear-errors", {
        method: "POST",
        body: JSON.stringify({ port }),
      }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["wing-link-status"] }),
  });
}

export type AutoEqKind = "auto" | "geq" | "peq";
export type AutoEqStripType = "matrix" | "bus" | "main";
/** The WING's low/high band cut types — see CUT_SLOPES in wing-eq-math.ts. */
export const AUTO_EQ_CUT_SLOPES = ["LR24", "LR12", "LR48", "BW6", "BW12", "BW18", "BW24", "BW48", "BS12", "BS24", "CUT"] as const;
export type AutoEqCutSlope = (typeof AUTO_EQ_CUT_SLOPES)[number];

export interface AutoEqCut {
  hz: number;
  slope: AutoEqCutSlope;
}

export interface AutoEqZoneRequest {
  type: AutoEqStripType;
  index: number;
  lowCut?: AutoEqCut;
  highCut?: AutoEqCut;
  fromHz: number;
  toHz: number;
  eq?: AutoEqKind;
  fxSlot?: number;
}

export interface AutoEqBalanceRequest {
  micChannel: number;
  zones: AutoEqZoneRequest[];
  targetCurve?: Array<{ hz: number; db: number }>;
  maxBoostDb?: number;
  maxCutDb?: number;
  iterations?: number;
  sampleMs?: number;
  apply: boolean;
  /** A saved measurement mic whose calibration is subtracted from the mic readings. */
  micCalibration?: { name: string; orientation: MicOrientation };
}

export interface AutoEqPeqBand {
  f: number;
  g: number;
  q: number;
}

export interface AutoEqZoneResult {
  type: AutoEqStripType;
  index: number;
  fromHz: number;
  toHz: number;
  eqKind: "geq" | "peq";
  fallbackReason?: string;
  fxSlot?: number;
  insert?: { slot: "pre" | "post"; installed: boolean; turnedOn: boolean };
  geqBands?: Array<{ hz: number; old: number; new: number; clamped: boolean }>;
  peq?: { old: AutoEqNativeEq; new: AutoEqNativeEq };
  cuts: { low: AutoEqCut | null; high: AutoEqCut | null };
  nativeEqTurnedOn: boolean;
}

/** Native EQ low/high band; `type` is the console's leq/heq value (PEQ, SHV or a cut slope). */
export interface AutoEqNativeSide extends AutoEqPeqBand {
  type: string;
}

export interface AutoEqNativeEq {
  bands: AutoEqPeqBand[];
  low: AutoEqNativeSide;
  high: AutoEqNativeSide;
}

export interface AutoEqBalanceResult {
  micChannel: number;
  applied: boolean;
  frequenciesHz: number[];
  target: number[];
  before: Array<number | null>;
  after: Array<number | null>;
  reference: { type: AutoEqStripType; index: number; sampleCount: number; sampleMs: number };
  zones: AutoEqZoneResult[];
  iterations: number;
  stopReason: "converged" | "limits-reached" | "max-iterations" | "preview";
  residualMaxDb: number;
  residualRmsDb: number;
  micCalibration: { name: string | null; orientation: MicOrientation | null; pointCount: number; minHz: number; maxHz: number } | null;
}

/** Pink-noise system/wedge EQ: measures a mic against a zone strip's input and corrects each zone's GEQ/EQ — see wing-auto-eq.ts. */
export function useAutoEqBalance() {
  return useMutation<AutoEqBalanceResult, Error, AutoEqBalanceRequest>({
    mutationFn: (req) => apiFetch<AutoEqBalanceResult>("/api/plugins/wing/auto-eq-balance", { method: "POST", body: JSON.stringify(req) }),
  });
}

export function useAutoEqUndo() {
  return useMutation<{ restoredWrites: number }, Error, void>({
    mutationFn: () => apiFetch<{ restoredWrites: number }>("/api/plugins/wing/auto-eq-balance/undo", { method: "POST" }),
  });
}

/** 0° = mic pointed at the source, 90° = pointed at the ceiling. */
export type MicOrientation = 0 | 90;
export type MicCurveKey = "deg0" | "deg90";

export interface MicCalibrationCurve {
  sourceFiles: string[];
  points: Array<{ hz: number; db: number }>;
}

export interface MicCalibrationSummary {
  name: string;
  serial: string;
  notes: string;
  createdAt: string;
  updatedAt: string;
  orientations: MicOrientation[];
  ranges: Partial<Record<MicCurveKey, { minHz: number; maxHz: number; pointCount: number }>>;
}

export interface MicCalibrationFile {
  name: string;
  serial: string;
  notes: string;
  createdAt: string;
  updatedAt: string;
  curves: Record<MicCurveKey, MicCalibrationCurve | null>;
}

export interface MicCalibrationCandidate extends MicCalibrationCurve {
  files: string[];
  minHz: number;
  maxHz: number;
  maxAbsDb: number;
}

export interface SaveMicCalibrationRequest {
  name: string;
  serial: string;
  notes: string;
  curves: Record<MicCurveKey, MicCalibrationCurve | null>;
  /** The mic being edited: same name replaces it, a new name renames it. */
  renameFrom?: string;
}

const MIC_CALIBRATIONS_PATH = "/api/plugins/wing/mic-calibrations";

/** Saved measurement mics with their calibration curves — see wing-mic-calibration-store.ts. */
export function useMicCalibrations() {
  return useQuery({
    queryKey: ["wing-mic-calibrations"],
    queryFn: async () => (await apiFetch<{ mics: MicCalibrationSummary[] }>(MIC_CALIBRATIONS_PATH)).mics,
  });
}

export function useMicCalibration(name: string | null) {
  return useQuery({
    queryKey: ["wing-mic-calibration", name],
    queryFn: () => apiFetch<MicCalibrationFile>(`${MIC_CALIBRATIONS_PATH}/${encodeURIComponent(name!)}`),
    enabled: name !== null,
  });
}

/** Reads an uploaded calibration file (txt/cal/frd/csv, rtf, ods, xlsx or zip) without saving anything. */
export function useParseMicCalibration() {
  return useMutation<{ candidates: MicCalibrationCandidate[] }, Error, { fileName: string; contentBase64: string }>({
    mutationFn: (req) => apiFetch(`${MIC_CALIBRATIONS_PATH}/parse`, { method: "POST", body: JSON.stringify(req) }),
  });
}

export function useSaveMicCalibration() {
  const queryClient = useQueryClient();
  return useMutation<MicCalibrationSummary, Error, SaveMicCalibrationRequest>({
    mutationFn: (req) => apiFetch(MIC_CALIBRATIONS_PATH, { method: "POST", body: JSON.stringify(req) }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["wing-mic-calibrations"] });
      void queryClient.invalidateQueries({ queryKey: ["wing-mic-calibration"] });
    },
  });
}

export function useDeleteMicCalibration() {
  const queryClient = useQueryClient();
  return useMutation<unknown, Error, string>({
    mutationFn: (name) => apiFetch(`${MIC_CALIBRATIONS_PATH}/${encodeURIComponent(name)}`, { method: "DELETE" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["wing-mic-calibrations"] });
      void queryClient.invalidateQueries({ queryKey: ["wing-mic-calibration"] });
    },
  });
}

// --- Tool visibility (GET/PUT /api/tools) ---------------------------------------------------

export interface ToolGroupSummary {
  id: string;
  label: string;
  description: string;
  category?: string;
  toolCount: number;
  enabledCount: number;
  bytes: number;
  enabledBytes: number;
}

export interface ToolSummary {
  name: string;
  title?: string;
  summary?: string;
  group: string;
  bytes: number;
  readOnly: boolean;
  enabled: boolean;
}

export interface ToolProfileSummary {
  id: string;
  label: string;
  description: string;
  groups: string[];
}

/** A group id or an exact tool name in either list — the two id spaces never overlap. */
export interface ToolVisibilityRequest {
  profile?: string;
  enable?: string[];
  disable?: string[];
}

export interface ToolCatalogueTotals {
  tools: number;
  enabledTools: number;
  bytes: number;
  enabledBytes: number;
  instructionsBytes: number;
  approxTokens: number;
  approxEnabledTokens: number;
}

export interface ToolCatalogueResponse {
  groups: ToolGroupSummary[];
  tools: ToolSummary[];
  profiles: ToolProfileSummary[];
  totals: ToolCatalogueTotals;
  visibility: ToolVisibilityRequest;
  /** Ids named in the saved configuration that match no known group or tool — never rejected, only reported. */
  unknown: string[];
}

export interface UpdateToolVisibilityResult extends ToolCatalogueResponse {
  liveSessions: number;
}

export function useToolCatalogue() {
  return useQuery({
    queryKey: ["tools"],
    queryFn: () => apiFetch<ToolCatalogueResponse>("/api/tools"),
    staleTime: 15_000,
  });
}

export function useUpdateToolVisibility() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (value: ToolVisibilityRequest) =>
      apiFetch<UpdateToolVisibilityResult>("/api/tools", {
        method: "PUT",
        body: JSON.stringify(value),
      }),
    onSuccess: (result) => {
      // Seed the cache with the response directly rather than only invalidating: the PUT already
      // returns the exact same shape a GET would, so this avoids a visible flash back to the
      // pre-save state while the invalidated query refetches.
      queryClient.setQueryData(["tools"], result);
    },
  });
}
