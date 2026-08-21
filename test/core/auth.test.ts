import { expect } from "chai";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createAuthMiddleware } from "../../src/core/auth.js";
import { errorHandler } from "../../src/core/http-errors.js";

describe("createAuthMiddleware", () => {
  const token = "s3cr3t-test-token";
  let server: Server;
  let baseUrl: string;

  before(async () => {
    const auth = createAuthMiddleware(token);
    const app = express();
    app.get("/protected", auth.requireAuth(), (_req, res) => {
      res.status(200).json({ ok: true });
    });
    app.get("/protected-query", auth.requireAuth({ allowQueryParam: true }), (_req, res) => {
      res.status(200).json({ ok: true });
    });
    app.use(errorHandler());

    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => resolve());
    });
    const { port } = server.address() as AddressInfo;
    baseUrl = "http://127.0.0.1:" + port;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("returns 401 when no Authorization header is present", async () => {
    const res = await fetch(baseUrl + "/protected");
    expect(res.status).to.equal(401);
  });

  it("returns 200 with the correct bearer token", async () => {
    const res = await fetch(baseUrl + "/protected", {
      headers: { Authorization: "Bearer " + token },
    });
    expect(res.status).to.equal(200);
    expect(await res.json()).to.deep.equal({ ok: true });
  });

  it("returns 401 with an incorrect bearer token", async () => {
    const res = await fetch(baseUrl + "/protected", {
      headers: { Authorization: "Bearer wrong-token" },
    });
    expect(res.status).to.equal(401);
  });

  it("accepts a ?token= query param on routes that opt in", async () => {
    const res = await fetch(baseUrl + "/protected-query?token=" + encodeURIComponent(token));
    expect(res.status).to.equal(200);
  });

  it("ignores a ?token= query param on routes that do not opt in", async () => {
    const res = await fetch(baseUrl + "/protected?token=" + encodeURIComponent(token));
    expect(res.status).to.equal(401);
  });
});
