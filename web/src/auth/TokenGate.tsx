import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { ApiError, apiFetch } from "../api/client.js";
import { describePasskeyError, passkeySignInAvailable, signInWithPasskey } from "./passkeys.js";
import { getToken, setToken } from "./token-store.js";

type GateState = "loading" | "authenticated" | "unauthenticated" | "error";

export function TokenGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<GateState>("loading");
  const [inputValue, setInputValue] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [passkeyAvailable, setPasskeyAvailable] = useState(false);
  const [passkeyBusy, setPasskeyBusy] = useState(false);

  useEffect(() => {
    void verify();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (state === "unauthenticated") void passkeySignInAvailable().then(setPasskeyAvailable);
  }, [state]);

  async function handlePasskeySignIn(): Promise<void> {
    setFormError(null);
    setPasskeyBusy(true);
    try {
      setToken(await signInWithPasskey());
      await verify();
    } catch (err) {
      setFormError(describePasskeyError(err));
    } finally {
      setPasskeyBusy(false);
    }
  }

  async function verify(): Promise<void> {
    setState("loading");

    const hashToken = new URLSearchParams(location.hash.slice(1)).get("token");
    if (hashToken) {
      setToken(hashToken);
      history.replaceState(null, "", location.pathname + location.search);
    }

    const token = getToken();
    if (!token) {
      setState("unauthenticated");
      return;
    }

    try {
      await apiFetch("/api/auth/verify");
      setState("authenticated");
    } catch (err) {
      // apiFetch already clears the stored token on a real 401. A network error or a
      // 5xx doesn't mean the token is invalid — don't force the user back through the
      // login form for what might be a transient blip.
      setState(err instanceof ApiError && err.status === 401 ? "unauthenticated" : "error");
    }
  }

  function handleSubmit(event: FormEvent): void {
    event.preventDefault();
    setFormError(null);
    const trimmed = inputValue.trim();
    if (!trimmed) return;
    setToken(trimmed);
    void verify().then(() => {
      if (!getToken()) {
        setFormError("That token was rejected by the server.");
      }
    });
  }

  if (state === "loading") {
    return <div className="token-gate token-gate--loading">Checking authentication...</div>;
  }

  if (state === "error") {
    return (
      <div className="token-gate">
        <div className="token-gate__form">
          <h1>Wing MCP Server</h1>
          <p>Couldn&apos;t reach the server to verify your access token. Check your connection and try again.</p>
          <button type="button" onClick={() => void verify()}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (state === "unauthenticated") {
    return (
      <div className="token-gate">
        <form className="token-gate__form" onSubmit={handleSubmit}>
          <h1>Wing MCP Server</h1>
          {passkeyAvailable && (
            <>
              <button type="button" onClick={() => void handlePasskeySignIn()} disabled={passkeyBusy}>
                {passkeyBusy ? "Waiting for passkey..." : "Sign in with a passkey"}
              </button>
              <p className="token-gate__separator">or</p>
            </>
          )}
          <p>Enter the access token shown in the server startup banner.</p>
          <label className="token-gate__field">
            Access token
            <input
              type="password"
              value={inputValue}
              onChange={(event) => setInputValue(event.target.value)}
              placeholder="Bearer token"
              autoFocus
            />
          </label>
          <button type="submit">Connect</button>
          {formError && <p className="error">{formError}</p>}
        </form>
      </div>
    );
  }

  return <>{children}</>;
}
