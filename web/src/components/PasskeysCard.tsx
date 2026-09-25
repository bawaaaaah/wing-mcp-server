import { useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent, type JSX } from "react";
import { ApiError, apiFetch } from "../api/client.js";
import { usePasskeys, type PasskeySummary } from "../api/queries.js";
import { describePasskeyError, passkeysUsableHere, registerPasskey } from "../auth/passkeys.js";

function formatDate(iso: string | undefined): string {
  return iso ? new Date(iso).toLocaleString() : "Never";
}

export function PasskeysCard(): JSX.Element {
  const queryClient = useQueryClient();
  const passkeysQuery = usePasskeys();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const usable = passkeysUsableHere();

  async function handleAdd(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await registerPasskey(name);
      setName("");
      await queryClient.invalidateQueries({ queryKey: ["passkeys"] });
    } catch (err) {
      setError(describePasskeyError(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleRemove(passkey: PasskeySummary): Promise<void> {
    if (!window.confirm(`Remove the passkey "${passkey.name}"? Browsers signed in with it will be signed out.`)) return;
    setError(null);
    try {
      await apiFetch("/api/auth/passkeys/" + encodeURIComponent(passkey.id), { method: "DELETE" });
    } catch (err) {
      setError(describePasskeyError(err));
      return;
    }
    // Removing the passkey this very browser signed in with also closed this session.
    try {
      await apiFetch("/api/auth/verify");
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        window.location.assign("/");
        return;
      }
    }
    await queryClient.invalidateQueries({ queryKey: ["passkeys"] });
  }

  return (
    <section className="card">
      <h3>Passkeys</h3>
      <p className="meters-status">
        Sign in to this dashboard — and approve OAuth clients like claude.ai — with Touch ID, Face ID, Windows Hello or
        a security key instead of the access token. A passkey is tied to the address it was created on: create it
        from the address you'll sign in from. The access token keeps working everywhere as a fallback.
      </p>

      {passkeysQuery.isLoading && <p>Loading passkeys...</p>}
      {passkeysQuery.isError && <p className="error">{(passkeysQuery.error as Error).message}</p>}
      {passkeysQuery.data && passkeysQuery.data.passkeys.length === 0 && <p>No passkey registered yet.</p>}
      {passkeysQuery.data && passkeysQuery.data.passkeys.length > 0 && (
        <table className="plugin-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Address</th>
              <th>Created</th>
              <th>Last used</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {passkeysQuery.data.passkeys.map((passkey) => (
              <tr key={passkey.id}>
                <td>{passkey.name}</td>
                <td>
                  <code>{passkey.rpId}</code>
                </td>
                <td>{formatDate(passkey.createdAt)}</td>
                <td>{formatDate(passkey.lastUsedAt)}</td>
                <td>
                  <button type="button" className="copy-button" onClick={() => void handleRemove(passkey)}>
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {usable ? (
        <form className="passkey-add" onSubmit={(event) => void handleAdd(event)}>
          <input
            type="text"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Name (e.g. MacBook Touch ID)"
            maxLength={64}
          />
          <button type="submit" className="copy-button" disabled={busy}>
            {busy ? "Waiting for passkey..." : "Add a passkey"}
          </button>
        </form>
      ) : (
        <p className="meters-status">
          Passkeys can't be used from this address — they need HTTPS (the server's public URL) or localhost.
        </p>
      )}
      {error && <p className="error">{error}</p>}
    </section>
  );
}
