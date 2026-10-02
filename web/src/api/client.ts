import { clearToken, getToken } from "../auth/token-store.js";
import { liveConnection, LiveRequestError, type LiveResponse } from "./liveSocket.js";

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/**
 * Every dashboard API call goes through here. While the live control connection is open, a JSON
 * call travels over it (REST over WebSocket, docs/websocket-protocol.md) and runs through the very
 * same server route; otherwise — or for anything that is not plain JSON — it is a normal fetch.
 * Callers cannot tell the two apart: same result, same ApiError, same 401 handling.
 */
export async function apiFetch<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const live = await tryOverLiveConnection(path, opts);
  if (live) return handleResponse<T>(live.status, live.body);
  return httpFetch<T>(path, opts);
}

/** Auth routes stay on HTTP: they mint the very tickets the socket is opened with. */
function liveEligible(path: string, opts: RequestInit): boolean {
  if (!path.startsWith("/api/") || path.startsWith("/api/auth/")) return false;
  if (opts.body !== undefined && opts.body !== null && typeof opts.body !== "string") return false;
  const headers = new Headers(opts.headers);
  const type = headers.get("Content-Type");
  if (type !== null && !type.includes("json")) return false;
  if (opts.signal) return false;
  return liveConnection("control").getStatus() === "open";
}

async function tryOverLiveConnection(path: string, opts: RequestInit): Promise<LiveResponse | undefined> {
  if (!liveEligible(path, opts)) return undefined;
  const url = new URL(path, location.origin);
  const query = url.search ? Object.fromEntries(url.searchParams) : undefined;
  let body: unknown;
  if (typeof opts.body === "string" && opts.body.length > 0) {
    try {
      body = JSON.parse(opts.body) as unknown;
    } catch {
      return undefined;
    }
  }
  const method = (opts.method ?? "GET").toUpperCase();
  try {
    return await liveConnection("control").request(method, url.pathname, query, body);
  } catch (err) {
    // Refused before it ran, or a read that can simply be asked again: fall back to HTTP. A write
    // whose fate is unknown must not be sent twice.
    if (err instanceof LiveRequestError && (err.notSent || method === "GET")) return undefined;
    throw new ApiError(err instanceof Error ? err.message : String(err), 0);
  }
}

function handleResponse<T>(status: number, body: unknown): T {
  if (status < 200 || status >= 300) {
    if (status === 401) {
      clearToken();
    }
    const message =
      body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string" ? (body as { error: string }).error : "";
    throw new ApiError(message || `Request failed with status ${status}`, status);
  }
  return (status === 204 ? undefined : body) as T;
}

async function httpFetch<T>(path: string, opts: RequestInit): Promise<T> {
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
    throw new ApiError(message || `Request failed with status ${response.status}`, response.status);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}
