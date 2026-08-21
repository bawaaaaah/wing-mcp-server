import type { ReactNode } from "react";
import { NavLink } from "react-router-dom";

function navClassName({ isActive }: { isActive: boolean }): string {
  return isActive ? "layout__nav-link layout__nav-link--active" : "layout__nav-link";
}

export function Layout({ children }: { children: ReactNode }) {
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
          <NavLink to="/connect" className={navClassName}>
            Connect
          </NavLink>
        </nav>
      </header>
      <main className="layout__content">{children}</main>
    </div>
  );
}
