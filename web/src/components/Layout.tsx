import type { JSX, ReactNode } from "react";
import { Link, NavLink } from "react-router-dom";
import { usePlugins } from "../api/queries.js";
import { useLiveControlConnection, useLiveStatus } from "../api/useLive.js";
import { signOut } from "../auth/passkeys.js";

function navClassName({ isActive }: { isActive: boolean }): string {
  return isActive ? "layout__nav-link layout__nav-link--active" : "layout__nav-link";
}

/** Three faders — the app's mark, in the header and on the sign-in card. */
export function AppLogo(): JSX.Element {
  return (
    <span className="layout__logo" aria-hidden="true">
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
        <path d="M4 2v14M9 2v14M14 2v14" opacity="0.45" />
        <rect x="2" y="9" width="4" height="3" rx="1" fill="currentColor" stroke="none" />
        <rect x="7" y="4" width="4" height="3" rx="1" fill="currentColor" stroke="none" />
        <rect x="12" y="11" width="4" height="3" rx="1" fill="currentColor" stroke="none" />
      </svg>
    </span>
  );
}

/** The console's link, as the wing plugin reports it, with the dashboard's own socket folded in. */
function ConnectionPill(): JSX.Element {
  const socket = useLiveStatus("control");
  const plugins = usePlugins();
  const wing = plugins.data?.find((plugin) => plugin.id === "wing");

  let tone: "ok" | "warn" | "error" | "idle" = "idle";
  let label = "Checking…";
  let title = "";
  if (socket !== "open") {
    tone = "warn";
    label = "Reconnecting…";
    title = "The dashboard's live connection to the server is down; retrying.";
  } else if (wing) {
    const status = wing.health.status;
    tone = status === "HEALTHY" ? "ok" : status === "DEGRADED" ? "warn" : "error";
    label = status === "HEALTHY" ? "WING connected" : status === "DEGRADED" ? "WING degraded" : "WING offline";
    title = wing.health.errorMessage ?? "";
  }

  return (
    <span className={"status-pill status-pill--" + tone} title={title || label} role="status">
      <span className="status-pill__dot" />
      <span className="status-pill__label">{label}</span>
    </span>
  );
}

export function Layout({ children }: { children: ReactNode }): JSX.Element {
  // Rendered only once signed in (inside TokenGate): from here on, API calls go over the socket.
  useLiveControlConnection();
  return (
    <div className="layout">
      <header className="layout__header">
        <div className="layout__header-inner">
          <Link to="/" className="layout__brand">
            <AppLogo />
            <h1 className="layout__title">Wing MCP</h1>
          </Link>
          <nav className="layout__nav">
            <NavLink to="/" end className={navClassName}>
              Overview
            </NavLink>
            <NavLink to="/wing" className={navClassName}>
              Wing
            </NavLink>
            <NavLink to="/tools" className={navClassName}>
              Tools
            </NavLink>
            <NavLink to="/connect" className={navClassName}>
              Connect
            </NavLink>
          </nav>
          <div className="layout__status">
            <ConnectionPill />
            <button type="button" className="layout__sign-out" onClick={() => void signOut()}>
              Sign out
            </button>
          </div>
        </div>
      </header>
      <main className="layout__content">{children}</main>
    </div>
  );
}
