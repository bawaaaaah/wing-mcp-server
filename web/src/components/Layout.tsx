import type { JSX, ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { signOut } from "../auth/passkeys.js";

function navClassName({ isActive }: { isActive: boolean }): string {
  return isActive ? "layout__nav-link layout__nav-link--active" : "layout__nav-link";
}

export function Layout({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="layout">
      <header className="layout__header">
        <h1 className="layout__title">Wing MCP Server</h1>
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
          <button type="button" className="layout__nav-link layout__sign-out" onClick={() => void signOut()}>
            Sign out
          </button>
        </nav>
      </header>
      <main className="layout__content">{children}</main>
    </div>
  );
}
