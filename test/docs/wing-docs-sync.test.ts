// Guards against the generated docs under docs/wing-protocol/05-node-tree/ drifting out of sync
// with src/plugins/wing/wing-param-catalog.ts. It regenerates the per-category markdown files in
// memory using the exact same pure function the doc-generation script uses
// (scripts/generate-wing-docs.ts's `renderNodeTreeDocs`), then compares that output byte-for-byte
// against what's actually committed on disk. If someone edits the catalog and forgets to run
// `npm run docs:gen:wing`, this test fails.
//
// Note: this intentionally imports src/plugins/wing/wing-param-catalog.ts, which is owned by
// another part of this codebase. Until that file exists, this spec cannot even compile/run — that
// is expected during incremental integration, not a bug in this spec.

import { expect } from "chai";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WING_PARAM_CATALOG } from "../../src/plugins/wing/wing-param-catalog.js";
import { renderNodeTreeDocs } from "../../scripts/generate-wing-docs.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NODE_TREE_DIR = path.join(__dirname, "..", "..", "docs", "wing-protocol", "05-node-tree");

const GENERATED_BANNER =
  "<!-- GÉNÉRÉ — ne pas éditer à la main. Source : src/plugins/wing/wing-param-catalog.ts -->";

describe("docs/wing-protocol/05-node-tree generated docs stay in sync with the catalog", () => {
  const expectedFiles = renderNodeTreeDocs(WING_PARAM_CATALOG);
  const expectedFilenames = Object.keys(expectedFiles);

  it("produces at least one category file from the catalog", () => {
    expect(expectedFilenames.length).to.be.greaterThan(0);
  });

  it("never emits a category file without the generated-file banner", () => {
    for (const content of Object.values(expectedFiles)) {
      expect(content.startsWith(GENERATED_BANNER)).to.equal(true);
    }
  });

  for (const filename of expectedFilenames) {
    it(`docs/wing-protocol/05-node-tree/${filename} matches what the catalog generates`, () => {
      const onDiskPath = path.join(NODE_TREE_DIR, filename);
      expect(
        existsSync(onDiskPath),
        `${filename} does not exist on disk — run "npm run docs:gen:wing" and commit the result`,
      ).to.equal(true);

      const onDisk = readFileSync(onDiskPath, "utf8");
      const regenerated = expectedFiles[filename];
      expect(
        onDisk,
        `docs/wing-protocol/05-node-tree/${filename} is out of date — run "npm run docs:gen:wing" and commit the result`,
      ).to.equal(regenerated);
    });
  }
});
