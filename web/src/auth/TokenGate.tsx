import { useEffect, useState, type FormEvent, type ReactNode, type JSX } from "react";
import { ApiError, apiFetch } from "../api/client.js";
import { describePasskeyError, passkeySignInAvailable, signInWithPasskey } from "./passkeys.js";
import { getToken, setToken } from "./token-store.js";
import { AppLogo } from "../components/Layout.js";

function GateBrand({ subtitle }: { subtitle: string }): JSX.Element {
  return (
    <div className="token-gate__brand">
      <AppLogo />
      <h1>Wing MCP Server</h1>
      <p>{subtitle}</p>
    </div>
  );
}

type GateState = "loading" | "authenticated" | "unauthenticated" | "error";

export function TokenGate({ children }: { children: ReactNode }): JSX.Element {
  const [state, setState] = useState<GateState>("loading");
  const [inputValue, setInputValue] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [passkeyAvailable, setPasskeyAvailable] = useState(false);
  const [passkeyBusy, setPasskeyBusy] = useState(false);

  useEffect(() => {
    void verify();
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
          <GateBrand subtitle="Couldn't reach the server to verify your access token. Check your connection and try again." />
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
          <GateBrand subtitle="Sign in to control your Behringer WING." />
          {passkeyAvailable && (
            <>
              <button type="button" onClick={() => void handlePasskeySignIn()} disabled={passkeyBusy}>
                {passkeyBusy ? "Waiting for passkey..." : "Sign in with a passkey"}
              </button>
              <p className="token-gate__separator">or</p>
            </>
          )}
          <label className="token-gate__field">
            Access token
            <span className="token-gate__hint">
              Shown in the server startup banner, or printed by <code>wing-mcp-server --print-token</code>.
            </span>
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
