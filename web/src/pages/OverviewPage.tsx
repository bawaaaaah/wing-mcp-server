import type { JSX } from "react";
import { usePlugins, useStatus } from "../api/queries.js";
import { HealthBadge } from "../components/HealthBadge.js";
import { OAuthClientsCard } from "../components/OAuthClientsCard.js";
import { PasskeysCard } from "../components/PasskeysCard.js";

function formatUptime(totalSeconds: number): string {
  const hrs = Math.floor(totalSeconds / 3600);
  const mins = Math.floor((totalSeconds % 3600) / 60);
  const secs = Math.floor(totalSeconds % 60);
  return hrs + "h " + mins + "m " + secs + "s";
}

export function OverviewPage(): JSX.Element {
  const pluginsQuery = usePlugins();
  const statusQuery = useStatus();

  return (
    <div className="page">
      <div className="page__header">
        <div>
          <h2>Overview</h2>
          <p className="page__subtitle">Server status, plugins and who can sign in.</p>
        </div>
      </div>

      {statusQuery.isLoading && <p>Loading server status...</p>}
      {statusQuery.isError && <p className="error">{(statusQuery.error as Error).message}</p>}
      {statusQuery.data && (
        <div className="stat-grid">
          <div className="stat">
            <span className="stat__label">Version</span>
            <span className="stat__value">{statusQuery.data.server.version}</span>
            <span className="stat__hint">Node {statusQuery.data.server.nodeVersion}</span>
          </div>
          <div className="stat">
            <span className="stat__label">Uptime</span>
            <span className="stat__value">{formatUptime(statusQuery.data.server.uptimeSeconds)}</span>
            <span className="stat__hint">Since {new Date(statusQuery.data.server.startedAt).toLocaleString()}</span>
          </div>
          {pluginsQuery.data?.map((plugin) => (
            <div className="stat" key={plugin.id}>
              <span className="stat__label">{plugin.name}</span>
              <span className="stat__value">
                <HealthBadge status={plugin.health.status} />
              </span>
              <span className="stat__hint" title={plugin.health.errorMessage ?? undefined}>
                {plugin.health.errorMessage ?? "Running normally"}
              </span>
            </div>
          ))}
        </div>
      )}

      {pluginsQuery.isError && <p className="error">{(pluginsQuery.error as Error).message}</p>}

      <PasskeysCard />
      <OAuthClientsCard />
    </div>
  );
}
