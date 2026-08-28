import { expect } from "chai";
import { EventEmitter } from "node:events";
import type { Request, Response } from "express";
import { EventBus } from "../../src/core/event-bus.js";
import { createSseRoute } from "../../src/core/sse.js";

/**
 * `createSseRoute`'s handler never actually needs a real HTTP connection — it only calls
 * `res.setHeader`/`flushHeaders`/`write` and listens for the request's "close" event, so a plain
 * EventEmitter stand-in for `req` and a write-recording stand-in for `res` are enough to exercise
 * the per-plugin filtering this test targets, without spinning up a real server.
 */
function fakeReqRes(): { req: Request & EventEmitter; res: Response; writes: string[] } {
  const writes: string[] = [];
  const req = new EventEmitter() as unknown as Request & EventEmitter;
  const res = {
    setHeader: () => {},
    flushHeaders: () => {},
    write: (chunk: string) => {
      writes.push(chunk);
      return true;
    },
  } as unknown as Response;
  return { req, res, writes };
}

describe("createSseRoute", () => {
  it("delivers every event to a subscriber with no pluginId filter", () => {
    const bus = new EventBus();
    const { req, res, writes } = fakeReqRes();
    createSseRoute(bus)(req, res, () => {});
    try {
      bus.publish({ pluginId: "wing", type: "foo", payload: 1, timestamp: 0 });
      bus.publish({ pluginId: "other", type: "bar", payload: 2, timestamp: 0 });
      const joined = writes.join("");
      expect(joined).to.include("event: foo");
      expect(joined).to.include("event: bar");
    } finally {
      req.emit("close");
    }
  });

  it("only delivers events matching opts.pluginId, filtering out every other plugin's events", () => {
    const bus = new EventBus();
    const { req, res, writes } = fakeReqRes();
    createSseRoute(bus, { pluginId: "wing" })(req, res, () => {});
    try {
      bus.publish({ pluginId: "wing", type: "wing-event", payload: 1, timestamp: 0 });
      bus.publish({ pluginId: "other-plugin", type: "other-event", payload: 2, timestamp: 0 });
      const joined = writes.join("");
      expect(joined).to.include("wing-event");
      expect(joined).to.not.include("other-event");
    } finally {
      req.emit("close");
    }
  });

  it("isolates two concurrent subscribers on different plugins from each other's events", () => {
    const bus = new EventBus();
    const wing = fakeReqRes();
    const other = fakeReqRes();
    createSseRoute(bus, { pluginId: "wing" })(wing.req, wing.res, () => {});
    createSseRoute(bus, { pluginId: "other" })(other.req, other.res, () => {});
    try {
      bus.publish({ pluginId: "wing", type: "wing-only", payload: 1, timestamp: 0 });
      bus.publish({ pluginId: "other", type: "other-only", payload: 2, timestamp: 0 });

      const wingWrites = wing.writes.join("");
      expect(wingWrites).to.include("wing-only");
      expect(wingWrites).to.not.include("other-only");

      const otherWrites = other.writes.join("");
      expect(otherWrites).to.include("other-only");
      expect(otherWrites).to.not.include("wing-only");
    } finally {
      wing.req.emit("close");
      other.req.emit("close");
    }
  });

  it("unsubscribes from the event bus when the request closes, so no listener is leaked and no further writes happen", () => {
    const bus = new EventBus();
    const { req, res, writes } = fakeReqRes();
    createSseRoute(bus)(req, res, () => {});
    expect(bus.listenerCount("event")).to.equal(1);

    req.emit("close");
    expect(bus.listenerCount("event")).to.equal(0);

    bus.publish({ pluginId: "wing", type: "after-close", payload: 1, timestamp: 0 });
    expect(writes.join("")).to.not.include("after-close");
  });
});
