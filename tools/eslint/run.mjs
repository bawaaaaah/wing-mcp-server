#!/usr/bin/env node
// `npm run lint` entry point. The ESLint toolchain is a standalone install in this directory (its
// own package.json and lockfile, deliberately not a workspace — see package.json's description):
// hoisted into the root it would resolve the root's TypeScript 7, which has no JavaScript API for
// typescript-eslint to use. This installs it on first use (and again whenever its lockfile is newer
// than the install), then runs ESLint from the repository root with the arguments given.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const lockfile = path.join(here, "package-lock.json");
// Written by npm at the end of every successful install into this directory.
const installStamp = path.join(here, "node_modules", ".package-lock.json");

const stale = !fs.existsSync(installStamp) || fs.statSync(installStamp).mtimeMs < fs.statSync(lockfile).mtimeMs;
if (stale) {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const install = spawnSync(npm, ["ci", "--prefix", here, "--no-audit", "--no-fund"], {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (install.status !== 0) process.exit(install.status ?? 1);
}

const eslint = path.join(here, "node_modules", "eslint", "bin", "eslint.js");
const result = spawnSync(process.execPath, [eslint, ...process.argv.slice(2)], { stdio: "inherit", cwd: repoRoot });
process.exit(result.status ?? 1);
