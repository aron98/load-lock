/**
 * Tests for the tarball's npm-shrinkwrap.json (issue #103):
 * scripts/shrinkwrap.mjs derives it from package-lock.json at prepack.
 * Light: no daemon, files only (planted temp roots + this repo's lock).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const SCRIPT = join(REPO_ROOT, "scripts", "shrinkwrap.mjs");

interface ShrinkwrapModule {
  deriveShrinkwrap(root?: string): string;
}
const sw = (await import(pathToFileURL(SCRIPT).href)) as ShrinkwrapModule;

type Json = Record<string, unknown>;

function plant(pkg: Json, lock: Json): string {
  const root = mkdtempSync(join(tmpdir(), "ll-shrinkwrap-"));
  writeFileSync(join(root, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
  writeFileSync(join(root, "package-lock.json"), JSON.stringify(lock, null, 2) + "\n");
  return root;
}

const PKG = {
  name: "demo",
  version: "1.0.0",
  dependencies: { zod: "^3.24.0" },
  devDependencies: { typescript: "^5.9.0" },
};

function lockFor(pkg: Json): Json {
  const { name, version, dependencies, devDependencies } = pkg;
  return {
    name,
    version,
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": { name, version, dependencies, devDependencies },
      "node_modules/zod": { version: "3.24.0" },
      "node_modules/typescript": { version: "5.9.3", devOptional: true },
      "node_modules/only-dev": { version: "1.0.0", dev: true },
      "node_modules/fsevents": { version: "2.3.3", optional: true },
    },
  };
}

test("shrinkwrap: keeps prod/optional entries, drops dev and devOptional", () => {
  const root = plant(PKG, lockFor(PKG));
  try {
    const out = JSON.parse(sw.deriveShrinkwrap(root)) as { packages: Json; version: string };
    assert.deepEqual(Object.keys(out.packages).sort(), ["", "node_modules/fsevents", "node_modules/zod"]);
    assert.equal(out.version, "1.0.0");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("shrinkwrap: a stale lock (dependency range or version) is refused", () => {
  const bumpedDep = plant({ ...PKG, dependencies: { zod: "^3.25.0" } }, lockFor(PKG));
  const bumpedVersion = plant({ ...PKG, version: "1.0.1" }, lockFor(PKG));
  try {
    assert.throws(() => sw.deriveShrinkwrap(bumpedDep), /stale.*dependencies differ/s);
    assert.throws(() => sw.deriveShrinkwrap(bumpedVersion), /stale.*version: package.json has 1.0.1/s);
  } finally {
    rmSync(bumpedDep, { recursive: true, force: true });
    rmSync(bumpedVersion, { recursive: true, force: true });
  }
});

test("shrinkwrap: this repo's lock derives one, without devDependencies", () => {
  const out = JSON.parse(sw.deriveShrinkwrap(REPO_ROOT)) as { packages: Record<string, Json> };
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
    files: string[];
    scripts: Record<string, string>;
    devDependencies: Record<string, string>;
  };
  // devDependencies that are dev-only in the lock (typescript, solid-js,
  // @opentui/*) are dropped; one a runtime dep also needs (@types/node) stays.
  for (const dev of ["typescript", "solid-js", "@opentui/core", "@opentui/solid", "@opencode/theme"]) {
    assert.ok(dev in pkg.devDependencies, `${dev} is a devDependency`);
    assert.equal(out.packages[`node_modules/${dev}`], undefined, `${dev} must not be in the shrinkwrap`);
  }
  assert.ok(out.packages["node_modules/zod"], "runtime dependencies stay locked");
  assert.ok(pkg.files.includes("npm-shrinkwrap.json"), "npm 10/11 pack it only when listed in files");
  assert.equal(pkg.scripts.prepack, "node scripts/shrinkwrap.mjs");
  assert.equal(pkg.scripts.postpack, "node scripts/shrinkwrap.mjs --clean");
});
