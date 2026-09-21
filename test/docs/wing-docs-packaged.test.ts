// The wing-docs:// MCP resources resolve their files relative to the package root
// (src/plugins/wing/resources.ts), so they only work if those files are actually shipped. They
// were not: package.json "files" listed the two install guides but not docs/wing-protocol/, and
// the Dockerfile's runtime stage copied no docs at all. resources/list advertised all 15
// documents while every resources/read failed with ENOENT on any npm or Docker install — a
// failure invisible from a repo checkout, which is the only place the other docs tests run.
//
// These assertions are about the published artifacts, not the working tree, so they ask npm what
// the tarball would contain rather than looking at the files on disk.

import { expect } from "chai";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WING_DOC_MANIFEST } from "../../src/plugins/wing/resources.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..", "..");

interface PackListing {
  files: Array<{ path: string }>;
}

/**
 * `--ignore-scripts` is required, not cosmetic: prepack runs a full build whose stdout would
 * otherwise be interleaved with the JSON and make it unparseable.
 */
function packedFilePaths(): Set<string> {
  const stdout = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  const [pkg] = JSON.parse(stdout) as PackListing[];
  if (!pkg) throw new Error("npm pack --json returned no package entry");
  return new Set(pkg.files.map((file) => file.path));
}

describe("the wing-docs:// resources are shipped in the published artifacts", () => {
  it("advertises at least one document", () => {
    expect(WING_DOC_MANIFEST.length).to.be.greaterThan(0);
  });

  it("includes every advertised document in the npm tarball", function () {
    // npm pack shells out and walks the tree; slower than the rest of the suite.
    this.timeout(60000);
    const packed = packedFilePaths();
    const missing = WING_DOC_MANIFEST.map((entry) => entry.path).filter((docPath) => !packed.has(docPath));
    expect(missing, `missing from the npm tarball: ${missing.join(", ")}`).to.deep.equal([]);
  });

  it("copies the documents into the Docker runtime stage", () => {
    const dockerfile = readFileSync(path.join(REPO_ROOT, "Dockerfile"), "utf8");
    // Everything from the last FROM onwards is what actually ships in the image; a COPY in an
    // earlier build stage would compile fine and still leave the resources unreadable at runtime.
    const runtimeStage = dockerfile.slice(dockerfile.lastIndexOf("\nFROM "));
    expect(runtimeStage).to.match(/^COPY\s+docs\/wing-protocol\s+\S+/m);
  });
});
