import { useEffect, useState } from "react";
import { useEventSource } from "../api/useEventSource.js";
import {
  useMixerState,
  type WingChannelStrip,
  type WingMixerState,
  type WingMutegroupStrip,
  type WingStageStrip,
} from "../api/queries.js";

interface WingParamChange {
  path: string;
  shadow: boolean;
  value: number | string;
}

// No "$"-prefixed shadow variant needed here: real hardware only ever pushes subscription changes
// on the shadow address (e.g. "/ch/1/$fdr"), but the backend (wing-osc-client's
// canonicalizeShadowAddress) normalizes `change.path` back to the plain form before it reaches
// this SSE stream, so these patterns only ever need to match the plain path.
const CHANNEL_FIELD_RE = /^\/ch\/(\d+)\/(fdr|mute|pan|name|col|icon)$/;
const AUX_FIELD_RE = /^\/aux\/(\d+)\/(fdr|mute|pan|name|col|icon)$/;
const BUS_FIELD_RE = /^\/bus\/(\d+)\/(fdr|mute|name|col|icon)$/;
const MAIN_FIELD_RE = /^\/main\/(\d+)\/(fdr|mute|name|col|icon)$/;
const MTX_FIELD_RE = /^\/mtx\/(\d+)\/(fdr|mute|name|col|icon)$/;
const DCA_FIELD_RE = /^\/dca\/(\d+)\/(fdr|mute|name)$/;
const MGRP_FIELD_RE = /^\/mgrp\/(\d+)\/(mute|name)$/;
// The console's real OSC node for the "link customization to source" toggle is `clink` (a top-level
// leaf, sibling to name/col/icon) — corrected 2026-08-28 from a live packet capture; an earlier pass
// wrongly assumed `in/set/srcauto` (see wing-input-patch.ts).
const CHANNEL_SRCAUTO_RE = /^\/ch\/(\d+)\/clink$/;
const AUX_SRCAUTO_RE = /^\/aux\/(\d+)\/clink$/;

function patchByIndex<T extends { index: number }>(items: T[], index: number, patch: Partial<T>): T[] {
  let changed = false;
  const next = items.map((item) => {
    if (item.index !== index) return item;
    changed = true;
    return { ...item, ...patch };
  });
  return changed ? next : items;
}

function applyChannelField(strip: WingChannelStrip, field: string, value: number | string): Partial<WingChannelStrip> {
  switch (field) {
    case "fdr":
      return { fader: Number(value) };
    case "mute":
      return { muted: Number(value) === 1 };
    case "pan":
      return { pan: Number(value) };
    case "name":
      return { name: String(value) };
    case "col":
      return { col: Number(value) };
    case "icon":
      return { icon: Number(value) };
    default:
      return {};
  }
}

function applyStageField(strip: WingStageStrip, field: string, value: number | string): Partial<WingStageStrip> {
  switch (field) {
    case "fdr":
      return { fader: Number(value) };
    case "mute":
      return { muted: Number(value) === 1 };
    case "name":
      return { name: String(value) };
    case "col":
      return { col: Number(value) };
    case "icon":
      return { icon: Number(value) };
    default:
      return {};
  }
}

export interface UseWingMixerResult {
  state: WingMixerState | undefined;
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  refresh: () => void;
  setChannelLocal: (index: number, patch: Partial<WingChannelStrip>) => void;
  setAuxLocal: (index: number, patch: Partial<WingChannelStrip>) => void;
  setStageLocal: (kind: "buses" | "mains" | "matrices" | "dcas", index: number, patch: Partial<WingStageStrip>) => void;
  setMutegroupLocal: (index: number, patch: Partial<WingMutegroupStrip>) => void;
}

/**
 * Loads the full mixer snapshot once (~92 dumps server-side, see /mixer-state) and keeps it live
 * afterward by merging the "param-change" SSE stream — the same OSC subscription that feeds the
 * server's own state cache. Also exposes setLocal* updaters so controls can apply an optimistic
 * update immediately on interaction, rather than waiting for the SSE echo to round-trip back.
 */
export function useWingMixer(): UseWingMixerResult {
  const query = useMixerState();
  const [state, setState] = useState<WingMixerState | undefined>(undefined);

  useEffect(() => {
    if (query.data) {
      setState(query.data);
    }
  }, [query.data]);

  useEventSource("/api/plugins/wing/events", (type, data) => {
    if (type !== "param-change") return;
    const change = (data as { payload?: WingParamChange } | undefined)?.payload;
    if (!change) return;

    setState((prev) => {
      if (!prev) return prev;

      const chMatch = CHANNEL_FIELD_RE.exec(change.path);
      if (chMatch) {
        const index = Number(chMatch[1]);
        return {
          ...prev,
          channels: patchByIndex(prev.channels, index, applyChannelFieldFor(prev.channels, index, chMatch[2], change.value)),
        };
      }
      const auxMatch = AUX_FIELD_RE.exec(change.path);
      if (auxMatch) {
        const index = Number(auxMatch[1]);
        return { ...prev, auxes: patchByIndex(prev.auxes, index, applyChannelFieldFor(prev.auxes, index, auxMatch[2], change.value)) };
      }
      const chSrcAutoMatch = CHANNEL_SRCAUTO_RE.exec(change.path);
      if (chSrcAutoMatch) {
        const index = Number(chSrcAutoMatch[1]);
        return { ...prev, channels: patchByIndex(prev.channels, index, { srcAuto: Number(change.value) === 1 }) };
      }
      const auxSrcAutoMatch = AUX_SRCAUTO_RE.exec(change.path);
      if (auxSrcAutoMatch) {
        const index = Number(auxSrcAutoMatch[1]);
        return { ...prev, auxes: patchByIndex(prev.auxes, index, { srcAuto: Number(change.value) === 1 }) };
      }
      const busMatch = BUS_FIELD_RE.exec(change.path);
      if (busMatch) {
        const index = Number(busMatch[1]);
        return { ...prev, buses: patchByIndex(prev.buses, index, applyStageFieldFor(prev.buses, index, busMatch[2], change.value)) };
      }
      const mainMatch = MAIN_FIELD_RE.exec(change.path);
      if (mainMatch) {
        const index = Number(mainMatch[1]);
        return { ...prev, mains: patchByIndex(prev.mains, index, applyStageFieldFor(prev.mains, index, mainMatch[2], change.value)) };
      }
      const mtxMatch = MTX_FIELD_RE.exec(change.path);
      if (mtxMatch) {
        const index = Number(mtxMatch[1]);
        return { ...prev, matrices: patchByIndex(prev.matrices, index, applyStageFieldFor(prev.matrices, index, mtxMatch[2], change.value)) };
      }
      const dcaMatch = DCA_FIELD_RE.exec(change.path);
      if (dcaMatch) {
        const index = Number(dcaMatch[1]);
        return { ...prev, dcas: patchByIndex(prev.dcas, index, applyStageFieldFor(prev.dcas, index, dcaMatch[2], change.value)) };
      }
      const mgrpMatch = MGRP_FIELD_RE.exec(change.path);
      if (mgrpMatch) {
        const index = Number(mgrpMatch[1]);
        const field = mgrpMatch[2];
        const patch: Partial<WingMutegroupStrip> = field === "mute" ? { muted: Number(change.value) === 1 } : { name: String(change.value) };
        return { ...prev, mutegroups: patchByIndex(prev.mutegroups, index, patch) };
      }
      return prev;
    });
  });

  function applyChannelFieldFor(items: WingChannelStrip[], index: number, field: string, value: number | string): Partial<WingChannelStrip> {
    const existing = items.find((c) => c.index === index);
    return existing ? applyChannelField(existing, field, value) : {};
  }

  function applyStageFieldFor(items: WingStageStrip[], index: number, field: string, value: number | string): Partial<WingStageStrip> {
    const existing = items.find((c) => c.index === index);
    return existing ? applyStageField(existing, field, value) : {};
  }

  function setChannelLocal(index: number, patch: Partial<WingChannelStrip>) {
    setState((prev) => (prev ? { ...prev, channels: patchByIndex(prev.channels, index, patch) } : prev));
  }

  function setAuxLocal(index: number, patch: Partial<WingChannelStrip>) {
    setState((prev) => (prev ? { ...prev, auxes: patchByIndex(prev.auxes, index, patch) } : prev));
  }

  function setStageLocal(kind: "buses" | "mains" | "matrices" | "dcas", index: number, patch: Partial<WingStageStrip>) {
    setState((prev) => (prev ? { ...prev, [kind]: patchByIndex(prev[kind], index, patch) } : prev));
  }

  function setMutegroupLocal(index: number, patch: Partial<WingMutegroupStrip>) {
    setState((prev) => (prev ? { ...prev, mutegroups: patchByIndex(prev.mutegroups, index, patch) } : prev));
  }

  return {
    state,
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error,
    refresh: () => void query.refetch(),
    setChannelLocal,
    setAuxLocal,
    setStageLocal,
    setMutegroupLocal,
  };
}
