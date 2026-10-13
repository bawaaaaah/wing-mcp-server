import { useEffect, useRef, type JSX } from "react";
import { Link } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { usePluginConfig, usePlugins } from "../api/queries.js";

/** The wing plugin's health, or undefined until the plugin list has loaded. */
function useWingHealth() {
  const plugins = usePlugins();
  return plugins.data?.find((plugin) => plugin.id === "wing")?.health;
}

/**
 * Reloads everything the dashboard read once the console answers again: while it was away every
 * query either failed or timed out, and nothing else would retry them.
 */
export function useReloadWhenConsoleReturns(): void {
  const health = useWingHealth();
  const queryClient = useQueryClient();
  const wasDown = useRef(false);
  useEffect(() => {
    if (!health) return;
    if (health.status !== "HEALTHY") {
      wasDown.current = true;
    } else if (wasDown.current) {
      wasDown.current = false;
      void queryClient.invalidateQueries();
    }
  }, [health, queryClient]);
}

/**
 * One explanation, at the top of the Wing page, for why its tabs are empty or erroring: the console
 * is not answering. Says where the server is looking for it and where to change that.
 */
export function ConsoleOfflineBanner(): JSX.Element | null {
  const health = useWingHealth();
  const config = usePluginConfig("wing");
  const queryClient = useQueryClient();
  if (!health || health.status === "HEALTHY") return null;

  const { host, oscPort } = (config.data?.config ?? {}) as { host?: string; oscPort?: number };
  const degraded = health.status === "DEGRADED";
  return (
    <div className={degraded ? "console-banner console-banner--warn" : "console-banner"} role="alert">
      <div className="console-banner__text">
        <strong>{degraded ? "The console is answering intermittently." : "The console is not answering."}</strong>{" "}
        {host ? (
          <>
            The server is looking for it at <code>{host}{oscPort ? `:${oscPort}` : ""}</code>.{" "}
          </>
        ) : null}
        Check that it is on and on the same network, or change its address in the configuration. Everything reloads once it
        answers again.
        {health.errorMessage && <small className="console-banner__detail">{health.errorMessage}</small>}
      </div>
      <div className="console-banner__actions">
        <button type="button" onClick={() => void queryClient.invalidateQueries()}>
          Retry now
        </button>
        <Link to="/wing?tab=config" className="console-banner__link">
          Configuration
        </Link>
      </div>
    </div>
  );
}
