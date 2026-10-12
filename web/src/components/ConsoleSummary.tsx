import type { JSX } from "react";
import { Link } from "react-router-dom";
import { useMediaState, usePlayAction, useStepScene, useWingScenes, type WingPlayAction } from "../api/queries.js";

/**
 * What matters during a service, at a glance: the active scene, the USB player and the recorder,
 * each with the one or two actions you'd reach for, and a link to its full tab.
 */
export function ConsoleSummary(): JSX.Element {
  const scenes = useWingScenes();
  const media = useMediaState();
  const stepScene = useStepScene();
  const playAction = usePlayAction();

  const current = scenes.data?.current as { name?: string; show?: string } | undefined;
  const play = media.data?.play;
  const rec = media.data?.rec;
  const playing = play?.state === "PLAY";
  const recording = rec?.state === "REC";

  return (
    <div className="stat-grid console-summary">
      <div className="stat">
        <span className="stat__label">Scene</span>
        <span className="stat__value">{scenes.isError ? "—" : current?.name || (scenes.isLoading ? "…" : "—")}</span>
        <span className="stat__hint">{current?.show ? `Show: ${current.show}` : "No show loaded"}</span>
        <div className="stat__actions">
          <button type="button" disabled={stepScene.isPending || !scenes.data} onClick={() => stepScene.mutate("prev")}>
            ← Prev
          </button>
          <button type="button" disabled={stepScene.isPending || !scenes.data} onClick={() => stepScene.mutate("next")}>
            Next →
          </button>
          <Link to="/wing?tab=scenes" className="stat__link">
            All scenes
          </Link>
        </div>
      </div>

      <div className="stat">
        <span className="stat__label">USB player</span>
        <span className="stat__value">
          {play ? (
            <span className={"state-chip" + (playing ? " state-chip--on" : "")}>{play.state || "—"}</span>
          ) : media.isLoading ? (
            "…"
          ) : (
            "—"
          )}
        </span>
        <span className="stat__hint" title={play?.file}>
          {play?.song || play?.file || "No track"}
        </span>
        <div className="stat__actions">
          <button
            type="button"
            disabled={!play || playAction.isPending}
            onClick={() => playAction.mutate({ action: (playing ? "PAUSE" : "PLAY") as WingPlayAction })}
          >
            {playing ? "Pause" : "Play"}
          </button>
          <button type="button" disabled={!play || playAction.isPending} onClick={() => playAction.mutate({ action: "STOP" as WingPlayAction })}>
            Stop
          </button>
          <Link to="/wing?tab=media" className="stat__link">
            Media
          </Link>
        </div>
      </div>

      <div className="stat">
        <span className="stat__label">Recorder</span>
        <span className="stat__value">
          {rec ? <span className={"state-chip" + (recording ? " state-chip--rec" : "")}>{rec.state || "—"}</span> : media.isLoading ? "…" : "—"}
        </span>
        <span className="stat__hint">{recording ? `${rec?.file || "Recording"} · ${rec?.time.display ?? ""}` : rec?.file || "Not recording"}</span>
        <div className="stat__actions">
          <Link to="/wing?tab=media" className="stat__link">
            Recorder controls
          </Link>
        </div>
      </div>
    </div>
  );
}
