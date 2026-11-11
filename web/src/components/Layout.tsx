import { useEffect, useRef, type JSX, type ReactNode } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
import { usePluginConfig, usePlugins } from "../api/queries.js";
import { useLiveControlConnection, useLiveStatus } from "../api/useLive.js";
import { signOut } from "../auth/passkeys.js";
import { ConfirmProvider } from "./ConfirmDialog.js";
import { useReloadWhenConsoleReturns } from "./ConsoleOffline.js";

const PAGE_TITLES: Record<string, string> = {
  "/": "Overview",
  "/wing": "Wing",
  "/tools": "Tools",
  "/connect": "Connect",
};

/**
 * On a page change (not a tab or section change inside one, which only moves the query string):
 * names the page in the browser tab, goes back to the top, and puts focus on the content so a
 * screen reader starts reading the new page rather than staying on the link just used.
 */
function useRouteAnnouncement() {
  const { pathname } = useLocation();
  const mainRef = useRef<HTMLElement>(null);
  const first = useRef(true);
  useEffect(() => {
    const page = PAGE_TITLES[pathname];
    document.title = page ? `${page} · Wing MCP` : "Wing MCP";
    if (first.current) {
      first.current = false;
      return;
    }
    window.scrollTo(0, 0);
    mainRef.current?.focus({ preventScroll: true });
  }, [pathname]);
  return mainRef;
}

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
  // Phones have room for one word next to the dot.
  let short = "…";
  let title = "";
  if (socket !== "open") {
    tone = "warn";
    label = "Reconnecting…";
    short = "Retrying";
    title = "The dashboard's live connection to the server is down; retrying.";
  } else if (wing) {
    const status = wing.health.status;
    tone = status === "HEALTHY" ? "ok" : status === "DEGRADED" ? "warn" : "error";
    label = status === "HEALTHY" ? "WING connected" : status === "DEGRADED" ? "WING degraded" : "WING offline";
    short = status === "HEALTHY" ? "Online" : status === "DEGRADED" ? "Degraded" : "Offline";
    title = wing.health.errorMessage ?? "";
  }

  return (
    <span className={"status-pill status-pill--" + tone} title={title || label} role="status">
      <span className="status-pill__dot" />
      <span className="status-pill__label">{label}</span>
      <span className="status-pill__short" aria-hidden="true">
        {short}
      </span>
    </span>
  );
}

/** Shown while show mode is on: MCP clients' audible writes then need the operator's confirmation. */
function ShowModeBadge(): JSX.Element | null {
  const config = usePluginConfig("wing");
  const on = (config.data?.config as { showMode?: boolean } | undefined)?.showMode === true;
  if (!on) return null;
  return (
    <Link
      to="/wing?tab=config"
      className="status-pill status-pill--show"
      title="Show mode is on: an AI client's audible writes (faders, mutes, scene recall…) need confirmation. The dashboard is not restricted."
    >
      <span className="status-pill__dot" />
      <span className="status-pill__label">Show mode</span>
    </Link>
  );
}

/**
 * Publishes the sticky header's height as `--header-height`, so things that stick below it (the EQ
 * curve on a phone) know where to stop — the header wraps to two lines on narrow screens.
 */
function useHeaderHeightVar() {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const header = ref.current;
    if (!header) return;
    const root = document.documentElement;
    const observer = new ResizeObserver(() => root.style.setProperty("--header-height", `${header.offsetHeight}px`));
    observer.observe(header);
    return () => {
      observer.disconnect();
      root.style.removeProperty("--header-height");
    };
  }, []);
  return ref;
}

export function Layout({ children }: { children: ReactNode }): JSX.Element {
  // Rendered only once signed in (inside TokenGate): from here on, API calls go over the socket.
  useLiveControlConnection();
  useReloadWhenConsoleReturns();
  const headerRef = useHeaderHeightVar();
  const mainRef = useRouteAnnouncement();
  return (
    <ConfirmProvider>
    <div className="layout">
      <a
        className="skip-link"
        href="#main"
        onClick={(event) => {
          event.preventDefault();
          mainRef.current?.focus();
        }}
      >
        Skip to content
      </a>
      <header className="layout__header" ref={headerRef}>
        <div className="layout__header-inner">
          <Link to="/" className="layout__brand">
            <AppLogo />
            <span className="layout__title">Wing MCP</span>
          </Link>
          <nav className="layout__nav" aria-label="Main">
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
            <ShowModeBadge />
            <ConnectionPill />
            <button type="button" className="layout__sign-out" onClick={() => void signOut()}>
              Sign out
            </button>
          </div>
        </div>
      </header>
      <main id="main" className="layout__content" tabIndex={-1} ref={mainRef}>
        {children}
      </main>
    </div>
    </ConfirmProvider>
  );
}
