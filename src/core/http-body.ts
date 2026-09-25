/**
 * Express types `req.body` as `any`. These read one field of it without trusting its shape — the
 * body is whatever the client sent, so every field is checked before it is used.
 */
export function bodyField(body: unknown, key: string): unknown {
  return body !== null && typeof body === "object" ? (body as Record<string, unknown>)[key] : undefined;
}

export function bodyString(body: unknown, key: string): string | undefined {
  const value = bodyField(body, key);
  return typeof value === "string" ? value : undefined;
}
