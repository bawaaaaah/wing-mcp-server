import { useSearchParams } from "react-router-dom";

/** A strip family as addressed on the wire (`/ch/12`, `/mtx/3`). */
export type StripKind = "ch" | "aux" | "bus" | "main" | "mtx" | "dca";

export interface StripRef {
  kind: StripKind;
  index: number;
}

const STRIP_PARAM_RE = /^(ch|aux|bus|main|mtx|dca)\.(\d+)$/;

export function stripParam(strip: StripRef): string {
  return `${strip.kind}.${strip.index}`;
}

/**
 * The strip being worked on, kept in the URL (`?strip=ch.12`) like the tabs are: the strip lists,
 * EQ / Gate / Dyn, Routing and Identity all read the same one, so a strip's menu can open any of
 * them on it and a reload keeps it. Null when absent or malformed.
 */
export function useUrlStrip(): [StripRef | null, (next: StripRef | null, extra?: Record<string, string>) => void] {
  const [params, setParams] = useSearchParams();
  const match = STRIP_PARAM_RE.exec(params.get("strip") ?? "");
  const value = match ? { kind: match[1] as StripKind, index: Number(match[2]) } : null;

  /** `extra` sets other parameters in the same history entry (`{ section: "processing" }`). */
  function set(next: StripRef | null, extra: Record<string, string> = {}): void {
    setParams(
      (prev) => {
        const updated = new URLSearchParams(prev);
        if (next) updated.set("strip", stripParam(next));
        else updated.delete("strip");
        for (const [key, v] of Object.entries(extra)) updated.set(key, v);
        return updated;
      },
      { replace: true },
    );
  }

  return [value, set];
}
