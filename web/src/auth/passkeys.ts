import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";
import { ApiError, apiFetch } from "../api/client.js";
import type { PasskeySummary } from "../api/queries.js";
import { clearToken } from "./token-store.js";

/** WebAuthn only runs in a secure context (HTTPS, or localhost), and never on a bare IP address —
 * which can't be a WebAuthn RP ID even where the browser deems it secure (127.0.0.1). */
export function passkeysUsableHere(): boolean {
  const isIpAddress = /^[\d.]+$/.test(window.location.hostname) || window.location.hostname.startsWith("[");
  return window.isSecureContext && !isIpAddress && browserSupportsWebAuthn();
}

/** Public, so it's a bare fetch: apiFetch would send (and on failure clear) whatever token is stored. */
export async function passkeySignInAvailable(): Promise<boolean> {
  if (!passkeysUsableHere()) return false;
  try {
    const res = await fetch("/api/auth/passkeys/status");
    return res.ok && ((await res.json()) as { available: boolean }).available;
  } catch {
    return false;
  }
}

/** Runs the login ceremony and returns the web session token it opens. */
export async function signInWithPasskey(): Promise<string> {
  const optionsJSON = await apiFetch<PublicKeyCredentialRequestOptionsJSON>("/api/auth/passkeys/login/options", {
    method: "POST",
  });
  const response = await startAuthentication({ optionsJSON });
  const { token } = await apiFetch<{ token: string }>("/api/auth/passkeys/login/verify", {
    method: "POST",
    body: JSON.stringify({ response }),
  });
  return token;
}

export async function registerPasskey(name: string): Promise<PasskeySummary> {
  const optionsJSON = await apiFetch<PublicKeyCredentialCreationOptionsJSON>("/api/auth/passkeys/register/options", {
    method: "POST",
  });
  const response = await startRegistration({ optionsJSON });
  return apiFetch<PasskeySummary>("/api/auth/passkeys/register/verify", {
    method: "POST",
    body: JSON.stringify({ name, response }),
  });
}

export async function signOut(): Promise<void> {
  try {
    await apiFetch("/api/auth/logout", { method: "POST" });
  } catch {
    // Already invalid or unreachable — dropping the local copy is all that's left to do anyway.
  }
  clearToken();
  window.location.assign("/");
}

export function describePasskeyError(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) {
    if (err.name === "NotAllowedError") return "Passkey prompt was cancelled or timed out.";
    if (err.name === "InvalidStateError") return "This device already holds a passkey for this server.";
    return err.message;
  }
  return String(err);
}
