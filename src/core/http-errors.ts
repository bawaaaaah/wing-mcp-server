import type { ErrorRequestHandler } from "express";

export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

/**
 * The client-error status an error from express's own middleware carries, if any. `express.json()`
 * (body-parser) throws http-errors-style objects — `status` 400 for malformed JSON, 413 for a body
 * over the limit, 415 for an unsupported charset — which are the caller's fault and must not be
 * reported (and logged) as a 500.
 */
function clientErrorStatus(err: unknown): number | undefined {
  if (err === null || typeof err !== "object") return undefined;
  const { status, statusCode } = err as { status?: unknown; statusCode?: unknown };
  const candidate = typeof status === "number" ? status : statusCode;
  return typeof candidate === "number" && Number.isInteger(candidate) && candidate >= 400 && candidate <= 499
    ? candidate
    : undefined;
}

export function errorHandler(): ErrorRequestHandler {
  return (err, _req, res, next) => {
    // A handler that already started its response can't have it replaced by an error body; express's
    // default handler then closes the connection, which is the only honest thing left to do.
    if (res.headersSent) {
      next(err);
      return;
    }
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    const clientStatus = clientErrorStatus(err);
    if (clientStatus !== undefined) {
      // body-parser marks the messages that are safe to show (`expose`); anything else stays generic.
      const expose = (err as { expose?: unknown }).expose === true && err instanceof Error;
      res.status(clientStatus).json({ error: expose ? err.message : "Bad Request" });
      return;
    }
    console.error(err);
    res.status(500).json({ error: "Internal Server Error" });
  };
}
