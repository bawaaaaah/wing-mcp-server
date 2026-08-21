import { expect } from "chai";
import { buildGroupTags, parseGroupTags, toggleGroupTag } from "../../../src/plugins/wing/wing-group-tags.js";

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
});
