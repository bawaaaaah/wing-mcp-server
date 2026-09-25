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

export function OverviewPage() {
  const pluginsQuery = usePlugins();
  const statusQuery = useStatus();

  return (
    <div className="page">
      <h2>Overview</h2>

      <section className="card">
        <h3>Server</h3>
        {statusQuery.isLoading && <p>Loading server status...</p>}
        {statusQuery.isError && <p className="error">{(statusQuery.error as Error).message}</p>}
        {statusQuery.data && (
          <dl className="kv-list">
            <dt>Version</dt>
            <dd>{statusQuery.data.server.version}</dd>
            <dt>Node</dt>
            <dd>{statusQuery.data.server.nodeVersion}</dd>
            <dt>Uptime</dt>
            <dd>{formatUptime(statusQuery.data.server.uptimeSeconds)}</dd>
            <dt>Started at</dt>
            <dd>{new Date(statusQuery.data.server.startedAt).toLocaleString()}</dd>
          </dl>
        )}
      </section>

      <section className="card">
        <h3>Plugins</h3>
        {pluginsQuery.isLoading && <p>Loading plugins...</p>}
        {pluginsQuery.isError && <p className="error">{(pluginsQuery.error as Error).message}</p>}
        {pluginsQuery.data && (
          <table className="plugin-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Name</th>
                <th>Health</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {pluginsQuery.data.map((plugin) => (
                <tr key={plugin.id}>
                  <td>{plugin.id}</td>
                  <td>{plugin.name}</td>
                  <td>
                    <HealthBadge status={plugin.health.status} />
                  </td>
                  <td>{plugin.health.errorMessage ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <PasskeysCard />
      <OAuthClientsCard />
    </div>
  );
}
