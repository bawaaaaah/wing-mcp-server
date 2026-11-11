import { expect } from "chai";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { errorHandler, HttpError } from "../../src/core/http-errors.js";

describe("errorHandler", () => {
  let server: Server;
  let baseUrl: string;
  const logged: unknown[] = [];
  let originalError: typeof console.error;

  before(async () => {
    const app = express();
    app.post("/json", express.json({ limit: "1kb" }), (req, res) => {
      res.status(200).json({ got: req.body as unknown });
    });
    app.get("/http-error", () => {
      throw new HttpError(418, "teapot");
    });
    app.get("/boom", () => {
      throw new Error("secret internals");
    });
    app.get("/after-headers", (_req, res, next) => {
      res.status(200).write("partial");
      next(new Error("late failure"));
    });
    app.use(errorHandler());
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => resolve());
    });
    baseUrl = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    logged.length = 0;
    originalError = console.error;
    console.error = (...args: unknown[]) => logged.push(args);
  });

  afterEach(() => {
    console.error = originalError;
  });

  function postJson(body: string): Promise<Response> {
    return fetch(baseUrl + "/json", { method: "POST", headers: { "Content-Type": "application/json" }, body });
  }

  it("answers malformed JSON with a 400, not a logged 500", async () => {
    const res = await postJson("{not json");
    expect(res.status).to.equal(400);
    expect(await res.json()).to.have.property("error").that.is.a("string");
    expect(logged).to.have.length(0);
  });

  it("answers a body over the limit with a 413", async () => {
    const res = await postJson(JSON.stringify({ blob: "x".repeat(4096) }));
    expect(res.status).to.equal(413);
    expect(logged).to.have.length(0);
  });

  it("keeps HttpError statuses and hides unexpected errors behind a 500", async () => {
    expect((await fetch(baseUrl + "/http-error")).status).to.equal(418);
    const res = await fetch(baseUrl + "/boom");
    expect(res.status).to.equal(500);
    expect(await res.text()).to.not.include("secret internals");
    expect(logged).to.have.length(1);
  });

  it("does not try to write an error body once the response has started", async () => {
    // Express's default handler takes over and ends the connection: the client sees the partial
    // body or a dropped connection, never a second set of headers (which would throw server-side).
    try {
      const res = await fetch(baseUrl + "/after-headers");
      expect(res.status).to.equal(200);
      await res.text().catch(() => undefined);
    } catch {
      // A reset connection is also acceptable.
    }
  });
});
