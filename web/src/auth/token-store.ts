const TOKEN_KEY = "wing-mcp-token";

type TokenListener = (token: string | null) => void;
const listeners = new Set<TokenListener>();
/** Kept in memory too, so a browser that refuses storage (private mode, blocked site data) still signs in for the tab. */
let memoryToken: string | null = null;
/** Set once storage refused a write: from then on the in-memory copy is the token. */
let memoryOnly = false;

function storage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

function notify(token: string | null): void {
  for (const listener of listeners) {
    try {
      listener(token);
    } catch (err) {
      console.error("token-store: a listener failed", err);
    }
  }
}

export function getToken(): string | null {
  const store = memoryOnly ? undefined : storage();
  if (!store) return memoryToken;
  try {
    return store.getItem(TOKEN_KEY);
  } catch {
    return memoryToken;
  }
}

export function setToken(token: string): void {
  const changed = getToken() !== token;
  memoryToken = token;
  try {
    storage()?.setItem(TOKEN_KEY, token);
  } catch {
    // storage refused: the in-memory copy lasts for this tab
    memoryOnly = true;
  }
  if (changed) notify(token);
}

export function clearToken(): void {
  const changed = getToken() !== null;
  memoryToken = null;
  try {
    storage()?.removeItem(TOKEN_KEY);
  } catch {
    // nothing stored to remove
  }
  if (changed) notify(null);
}

/**
 * Called whenever the token is set or cleared — in this tab (a 401 clears it) or in another one
 * (the `storage` event). Returns the unsubscribe function.
 */
export function onTokenChange(listener: TokenListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Typed without the DOM library: the server's tests import this file under Node, which has no window.
const host = globalThis as unknown as {
  addEventListener?: (type: "storage", listener: (event: { key: string | null }) => void) => void;
};
host.addEventListener?.("storage", (event) => {
  // key null: another tab cleared all of storage.
  if (event.key !== TOKEN_KEY && event.key !== null) return;
  notify(getToken());
});
