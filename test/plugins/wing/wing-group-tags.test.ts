import { expect } from "chai";
import { buildGroupTags, parseGroupTags, setGroupMembership, toggleGroupTag } from "../../../src/plugins/wing/wing-group-tags.js";
import type { WingPluginContext } from "../../../src/plugins/wing/wing-plugin.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Simulates a real console's single `tags` leaf, with enough latency on get/set to open the same race window observed live. */
function fakeTagsCtx(initialTags: string): { ctx: WingPluginContext; getTags: () => string } {
  let tags = initialTags;
  const ctx = {
    client: {
      async get(_path: string) {
        await delay(5);
        return { kind: "leaf", value: tags };
      },
      async set(_path: string, value: number | string) {
        await delay(5);
        tags = String(value);
      },
    },
  } as unknown as WingPluginContext;
  return { ctx, getTags: () => tags };
}

describe("wing-group-tags", () => {
  describe("parseGroupTags", () => {
    it("extracts DCA and mutegroup tokens observed on real hardware", () => {
      expect(parseGroupTags("#D7,#D9")).to.deep.equal({ dca: [7, 9], mutegroups: [], other: [] });
    });

    it("keeps free-form tags (including console-reserved talkback tags) untouched", () => {
      expect(parseGroupTags("TALKA.ON,TALKB.ON")).to.deep.equal({ dca: [], mutegroups: [], other: ["TALKA.ON", "TALKB.ON"] });
    });

    it("parses a mix of DCA, mutegroup, and free-form tags", () => {
      expect(parseGroupTags("*,#D1,#M3,#D14")).to.deep.equal({ dca: [1, 14], mutegroups: [3], other: ["*"] });
    });

    it("ignores empty segments and trims whitespace", () => {
      expect(parseGroupTags(" #D2 ,,#M1")).to.deep.equal({ dca: [2], mutegroups: [1], other: [] });
    });

    it("returns empty arrays for an empty string", () => {
      expect(parseGroupTags("")).to.deep.equal({ dca: [], mutegroups: [], other: [] });
    });
  });

  describe("buildGroupTags", () => {
    it("renders other tags first, then DCA tags, then mutegroup tags, sorted", () => {
      expect(buildGroupTags({ dca: [9, 7], mutegroups: [3], other: ["*"] })).to.equal("*,#D7,#D9,#M3");
    });
  });

  describe("toggleGroupTag", () => {
    it("adds a DCA tag to an empty tags string", () => {
      expect(toggleGroupTag("", "dca", 3, true)).to.equal("#D3");
    });

    it("adds a mutegroup tag alongside existing DCA tags", () => {
      expect(toggleGroupTag("#D7,#D9", "mutegroup", 1, true)).to.equal("#D7,#D9,#M1");
    });

    it("removes a DCA tag while preserving everything else", () => {
      expect(toggleGroupTag("TALKA.ON,#D7,#D9,#M1", "dca", 7, false)).to.equal("TALKA.ON,#D9,#M1");
    });

    it("is a no-op when removing a tag that isn't present", () => {
      expect(toggleGroupTag("#D7", "dca", 3, false)).to.equal("#D7");
    });

    it("is idempotent when adding a tag that's already present", () => {
      expect(toggleGroupTag("#D7", "dca", 7, true)).to.equal("#D7");
    });

    it("returns null instead of exceeding the console's 80-character tags field", () => {
      const other = "x".repeat(80);
      expect(toggleGroupTag(other, "dca", 1, true)).to.equal(null);
    });
  });

  describe("setGroupMembership: same-strip concurrency", () => {
    it("serializes two concurrent toggles on the same strip so neither write is lost (regression for a race observed live)", async () => {
      const { ctx, getTags } = fakeTagsCtx("");
      const [dcaResult, mgResult] = await Promise.all([
        setGroupMembership(ctx, "/ch/1", "dca", 3, true),
        setGroupMembership(ctx, "/ch/1", "mutegroup", 1, true),
      ]);
      expect(getTags()).to.equal("#D3,#M1");
      expect(dcaResult.dca).to.deep.equal([3]);
      expect(mgResult.mutegroups).to.deep.equal([1]);
    });

    it("does not serialize toggles on two different strips against each other", async () => {
      const ch1 = fakeTagsCtx("");
      const ch2 = fakeTagsCtx("");
      const results = await Promise.all([
        setGroupMembership(ch1.ctx, "/ch/1", "dca", 3, true),
        setGroupMembership(ch2.ctx, "/ch/2", "dca", 5, true),
      ]);
      expect(ch1.getTags()).to.equal("#D3");
      expect(ch2.getTags()).to.equal("#D5");
      expect(results[0].dca).to.deep.equal([3]);
      expect(results[1].dca).to.deep.equal([5]);
    });
  });
});
