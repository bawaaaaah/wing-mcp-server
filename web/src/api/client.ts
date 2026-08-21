import { clearToken, getToken } from "../auth/token-store.js";

export async function apiFetch<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const headers = new Headers(opts.headers);
  headers.set("Authorization", "Bearer " + (getToken() ?? ""));
  if (opts.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(path, { ...opts, headers });

  if (!response.ok) {
    if (response.status === 401) {
      clearToken();
    }
    let message = response.statusText;
    try {
      const body: unknown = await response.json();
      if (body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string") {
        message = (body as { error: string }).error;
      }
    } catch {
      // response body wasn't JSON — fall back to statusText
    }
    throw new Error(message || `Request failed with status ${response.status}`);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}
