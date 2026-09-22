// The wing-docs:// MCP resources resolve their files relative to the package root
// (src/plugins/wing/resources.ts), so they only work if those files are actually shipped. They
// were not: package.json "files" listed the two install guides but not docs/wing-protocol/, and
// the Dockerfile's runtime stage copied no docs at all. resources/list advertised all 15
// documents while every resources/read failed with ENOENT on any npm or Docker install — a
// failure invisible from a repo checkout, which is the only place the other docs tests run.
//
// These assertions are about the published artifacts, not the working tree, so they ask npm what
// the tarball would contain rather than looking at the files on disk.
//
// The Docker half of that first fix then failed in CI, and the reason is worth keeping written
// down: this file originally asserted that the Dockerfile's *text* contained a COPY line. That
// checks an instruction is written, not that it works — and it did not, because .dockerignore
// excluded `docs` (and `*.md`) from the build context, so the source path the COPY names is not
// there to copy. Hence the test below evaluates .dockerignore for real.

import { expect } from "chai";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WING_DOC_MANIFEST } from "../../src/plugins/wing/resources.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..", "..");

/**
 * Evaluates `.dockerignore` the way the daemon does when it assembles the build context: patterns
 * are matched against the path and against each of its parent directories (excluding a directory
 * excludes what is under it), `*` does not cross a `/` while `**` does, a leading `!` negates, and
 * **the last pattern that matches wins** — which is why the negations have to sit at the end of
 * the file.
 */
function isExcludedFromBuildContext(filePath: string): boolean {
  const patterns = readFileSync(path.join(REPO_ROOT, ".dockerignore"), "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));

  // "docs/wing-protocol/01-overview.md" -> ["docs", "docs/wing-protocol", "docs/wing-protocol/01-…"]
  const segments = filePath.split("/");
  const candidates = segments.map((_, i) => segments.slice(0, i + 1).join("/"));

  let excluded = false;
  for (const raw of patterns) {
    const negated = raw.startsWith("!");
    const pattern = (negated ? raw.slice(1) : raw).replace(/^\/+/, "");
    const regex = new RegExp(
      "^" +
        pattern
          .replace(/[.+^${}()|[\]\\]/g, "\\$&")
          .replace(/\*\*/g, "\u0000")
          .replace(/\*/g, "[^/]*")
          .replace(/\u0000/g, ".*")
          .replace(/\?/g, "[^/]") +
        "$",
    );
    if (candidates.some((candidate) => regex.test(candidate))) {
      excluded = !negated;
    }
  }
  return excluded;
}

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

  it("leaves every advertised document inside the Docker build context", () => {
    // The assertion above is necessary and not sufficient: a COPY whose source .dockerignore has
    // filtered out fails the build outright with `"/docs/wing-protocol": not found`.
    const ignored = WING_DOC_MANIFEST.map((entry) => entry.path).filter((docPath) =>
      isExcludedFromBuildContext(docPath),
    );
    expect(ignored, `excluded from the Docker build context by .dockerignore: ${ignored.join(", ")}`).to.deep.equal(
      [],
    );
  });
});
