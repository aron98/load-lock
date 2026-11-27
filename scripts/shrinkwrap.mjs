#!/usr/bin/env node
/**
 * npm-shrinkwrap.json for the published tarball (issue #103).
 *
 * package-lock.json stays the committed source of truth (npm 12 no longer
 * reads npm-shrinkwrap.json at all, so renaming the lockfile would break
 * local installs there). The shrinkwrap is derived from it at pack time:
 *
 *   node scripts/shrinkwrap.mjs                  # write npm-shrinkwrap.json (npm "prepack")
 *   node scripts/shrinkwrap.mjs --clean          # remove it again (npm "postpack")
 *   node scripts/shrinkwrap.mjs --check <tgz>    # CI: tarball ships the shrinkwrap,
 *                                                # identical to one derived from the
 *                                                # current package-lock.json
 *
 * The derived file drops every `dev` / `devOptional` entry, so whatever an
 * installer does with a dependency's shrinkwrap, it cannot pull our
 * devDependencies (typescript, solid-js, @opentui/*) into a user's tree.
 *
 * Plain JS on purpose: runs without a build or `npm ci`.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SHRINKWRAP = "npm-shrinkwrap.json";
const DEP_FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Derive the shrinkwrap text from package.json + package-lock.json; throws if the lock is stale. */
export function deriveShrinkwrap(root = ROOT) {
  const pkg = readJson(join(root, "package.json"));
  const lock = readJson(join(root, "package-lock.json"));
  const lockRoot = lock.packages?.[""];
  if (lock.lockfileVersion < 2 || !lockRoot) {
    throw new Error("package-lock.json has no `packages` section (lockfileVersion >= 2 required)");
  }
  const problems = [];
  for (const key of ["name", "version"]) {
    if (lock[key] !== pkg[key] || lockRoot[key] !== pkg[key]) {
      problems.push(`${key}: package.json has ${pkg[key]}, package-lock.json has ${lock[key]}/${lockRoot[key]}`);
    }
  }
  for (const field of DEP_FIELDS) {
    if (!isDeepStrictEqual(lockRoot[field] ?? {}, pkg[field] ?? {})) {
      problems.push(`${field} differ between package.json and package-lock.json`);
    }
  }
  if (problems.length) {
    throw new Error(`package-lock.json is stale (run \`npm install\`):\n  ${problems.join("\n  ")}`);
  }
  const packages = {};
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (path !== "" && (entry.dev || entry.devOptional)) continue;
    packages[path] = entry;
  }
  return JSON.stringify({ ...lock, packages }, null, 2) + "\n";
}

function check(tarball) {
  const read = (member) => {
    try {
      return execFileSync("tar", ["-xzOf", tarball, `package/${member}`], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: 64 * 1024 * 1024,
      });
    } catch {
      return null;
    }
  };
  const shipped = read(SHRINKWRAP);
  if (shipped === null) {
    throw new Error(`${tarball} does not contain ${SHRINKWRAP} (is it in package.json "files"? packed with npm >= 12?)`);
  }
  if (shipped !== deriveShrinkwrap()) {
    throw new Error(`${SHRINKWRAP} in ${tarball} is stale: it differs from one derived from package-lock.json`);
  }
  const shippedPkg = JSON.parse(read("package.json"));
  const sw = JSON.parse(shipped);
  if (sw.version !== shippedPkg.version) {
    throw new Error(`${SHRINKWRAP} is for version ${sw.version}, tarball package.json is ${shippedPkg.version}`);
  }
  const dev = Object.entries(sw.packages).filter(([p, e]) => p && (e.dev || e.devOptional));
  if (dev.length) throw new Error(`${SHRINKWRAP} lists dev-only packages: ${dev.map(([p]) => p).join(", ")}`);
  console.log(`shrinkwrap ok: ${Object.keys(sw.packages).length - 1} locked packages in ${tarball}`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const [mode, arg] = process.argv.slice(2);
  try {
    if (mode === "--clean") rmSync(join(ROOT, SHRINKWRAP), { force: true });
    else if (mode === "--check" && arg) check(arg);
    else if (mode === undefined) writeFileSync(join(ROOT, SHRINKWRAP), deriveShrinkwrap());
    else throw new Error("usage: shrinkwrap.mjs [--clean | --check <tarball>]");
  } catch (err) {
    console.error(`shrinkwrap: ${err.message}`);
    process.exit(1);
  }
}
