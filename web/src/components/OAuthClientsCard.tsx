import type { JSX } from "react";
import { useOAuthClients, useRevokeOAuthClient, type OAuthClientSummary } from "../api/queries.js";

function formatDate(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : "—";
}

/**
 * Every OAuth client (claude.ai's connector and the like) that registered with this server. Each
 * holds tokens of its own, valid on /mcp only, so one can be cut off here without rotating the
 * master token every other client shares.
 */
export function OAuthClientsCard(): JSX.Element {
  const clientsQuery = useOAuthClients();
  const revoke = useRevokeOAuthClient();

  function handleRevoke(client: OAuthClientSummary): void {
    const label = client.clientName ?? client.clientId;
    if (!window.confirm(`Revoke "${label}"? It loses access to /mcp at once and has to be approved again.`)) return;
    revoke.mutate(client.clientId);
  }

  return (
    <section className="card">
      <h3>OAuth clients</h3>
      <p className="meters-status">
        Clients that connected through the OAuth flow (claude.ai and other remote connectors). Each one holds its own
        tokens, good for the MCP endpoint only — never the server's auth token — so revoking one here leaves every other
        client connected.
      </p>
      {clientsQuery.isLoading && <p>Loading OAuth clients...</p>}
      {clientsQuery.isError && <p className="error">{(clientsQuery.error as Error).message}</p>}
      {clientsQuery.data && clientsQuery.data.clients.length === 0 && <p>No OAuth client has registered yet.</p>}
      {clientsQuery.data && clientsQuery.data.clients.length > 0 && (
        <table className="plugin-table">
          <thead>
            <tr>
              <th>Client</th>
              <th>Redirects to</th>
              <th>Registered</th>
              <th>Active grants</th>
              <th>Last token</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {clientsQuery.data.clients.map((client) => (
              <tr key={client.clientId}>
                <td>{client.clientName ?? <code>{client.clientId}</code>}</td>
                <td>
                  {client.redirectUris.map((uri) => (
                    <div key={uri}>
                      <code>{uri}</code>
                    </div>
                  ))}
                </td>
                <td>{formatDate(client.registeredAt)}</td>
                <td>{client.activeGrants}</td>
                <td>{formatDate(client.lastTokenIssuedAt)}</td>
                <td>
                  <button
                    type="button"
                    className="copy-button"
                    disabled={revoke.isPending}
                    onClick={() => handleRevoke(client)}
                  >
                    Revoke
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {revoke.isError && <p className="error">{(revoke.error as Error).message}</p>}
    </section>
  );
}
