import { createContext, useCallback, useContext, useMemo, useState, type JSX, type ReactNode } from "react";
import { setStripSolo, useSoloStates, type SoloStripType } from "../api/queries.js";
import { useLiveTopic } from "../api/useLive.js";

interface SoloApi {
  isSoloed: (type: SoloStripType, index: number) => boolean;
  toggle: (type: SoloStripType, index: number) => void;
  /** How many strips are soloed, across every type. */
  count: number;
  clearAll: () => void;
}

const SoloContext = createContext<SoloApi | null>(null);

const PATH_TYPE: Record<string, SoloStripType> = { ch: "channel", aux: "aux", bus: "bus", main: "main", mtx: "matrix", dca: "dca" };
// A `$solo` push reaches the dashboard canonicalized to ".../solo", except a DCA's, whose `$solo` is
// its only name (wing-osc-client.ts).
const SOLO_PATH_RE = /^\/(ch|aux|bus|main|mtx|dca)\/(\d+)\/\$?solo$/;

const key = (type: SoloStripType, index: number) => `${type}:${index}`;

/**
 * The mixer's solo switches: loaded once from /solo-states, then kept current by the console's own
 * pushes and by this dashboard's writes (shown at once, before the console confirms).
 */
export function SoloProvider({ children }: { children: ReactNode }): JSX.Element {
  const query = useSoloStates();
  const [overrides, setOverrides] = useState<Map<string, boolean>>(new Map());

  const loaded = useMemo(() => {
    const soloed = new Set<string>();
    for (const [type, indices] of Object.entries(query.data ?? {})) for (const n of indices) soloed.add(key(type as SoloStripType, n));
    return soloed;
  }, [query.data]);

  const isSoloed = useCallback(
    (type: SoloStripType, index: number) => overrides.get(key(type, index)) ?? loaded.has(key(type, index)),
    [overrides, loaded],
  );

  const set = useCallback((entries: [SoloStripType, number, boolean][]) => {
    setOverrides((prev) => {
      const next = new Map(prev);
      for (const [type, index, on] of entries) next.set(key(type, index), on);
      return next;
    });
  }, []);

  useLiveTopic<{ path: string; value: number | string }>(
    "wing:param-change",
    (change) => {
      const match = SOLO_PATH_RE.exec(change.path);
      if (match) set([[PATH_TYPE[match[1]], Number(match[2]), Number(change.value) === 1]]);
    },
    () => {
      setOverrides(new Map());
      void query.refetch();
    },
  );

  const soloedKeys = useMemo(() => {
    const all = new Set(loaded);
    for (const [k, on] of overrides) {
      if (on) all.add(k);
      else all.delete(k);
    }
    return [...all];
  }, [loaded, overrides]);

  const api = useMemo<SoloApi>(
    () => ({
      isSoloed,
      toggle: (type, index) => {
        const on = !isSoloed(type, index);
        set([[type, index, on]]);
        void setStripSolo(type, index, on).catch(() => set([[type, index, !on]]));
      },
      count: soloedKeys.length,
      clearAll: () => {
        const entries = soloedKeys.map((k) => {
          const [type, index] = k.split(":");
          return [type as SoloStripType, Number(index), false] as [SoloStripType, number, boolean];
        });
        set(entries);
        for (const [type, index] of entries) void setStripSolo(type, index, false);
      },
    }),
    [isSoloed, set, soloedKeys],
  );

  return <SoloContext.Provider value={api}>{children}</SoloContext.Provider>;
}

/** The mixer's solo state; only inside a SoloProvider. */
export function useSolo(): SoloApi {
  const api = useContext(SoloContext);
  if (!api) throw new Error("useSolo outside SoloProvider");
  return api;
}

/** A strip's Solo button, lit while it is soloed. */
export function SoloButton({ type, index }: { type: SoloStripType; index: number }): JSX.Element {
  const solo = useSolo();
  const on = solo.isSoloed(type, index);
  return (
    <button type="button" className={on ? "mixer-solo mixer-solo--on" : "mixer-solo"} aria-pressed={on} title={on ? "Solo on" : "Solo"} onClick={() => solo.toggle(type, index)}>
      S
    </button>
  );
}

/** "2 soloed · Clear" in the mixer's toolbar, while anything is soloed. */
export function SoloIndicator(): JSX.Element | null {
  const solo = useSolo();
  if (solo.count === 0) return null;
  return (
    <button type="button" className="solo-indicator" onClick={solo.clearAll} title="Switch every solo off" aria-label={`${solo.count} soloed, clear all`}>
      <span className="solo-indicator__dot" />
      {solo.count} <span className="solo-indicator__long">soloed · Clear</span>
      <span className="solo-indicator__short">S ✕</span>
    </button>
  );
}
