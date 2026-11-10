import { useState, type JSX } from "react";
import { getToken } from "../auth/token-store.js";

type Naming = "io" | "channel" | "full";

/** Downloads the stage patch sheet PDF (GET /api/plugins/wing/io/patch.pdf). */
export function PatchSheetButton(): JSX.Element {
  const [naming, setNaming] = useState<Naming>("channel");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  async function download(): Promise<void> {
    setBusy(true);
    setError(undefined);
    try {
      const res = await fetch(`/api/plugins/wing/io/patch.pdf?naming=${naming}`, { headers: { Authorization: "Bearer " + (getToken() ?? "") } });
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? res.statusText);
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = "patch-plateau.pdf";
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <select aria-label="Patch sheet naming" value={naming} onChange={(e) => setNaming(e.target.value as Naming)}>
        <option value="io">Names: input/output</option>
        <option value="channel">Names: channel first</option>
        <option value="full">Names: input + channel + output</option>
      </select>
      <button className="mixer-refresh" onClick={() => void download()} disabled={busy} title={error}>
        {busy ? "Generating..." : error ? "Patch PDF failed" : "Patch PDF"}
      </button>
    </>
  );
}
