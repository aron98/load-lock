#!/usr/bin/env node
/**
 * Version-pin sync check (issue #48).
 *
 * Several shipped artifacts pin an exact `@aron98/load-lock@<version>`
 * (skill npx fallback, ACE mcp.json, Claude Code plugin.json, launcher).
 * Every pin must equal package.json `version` at release.
 *
 *   node scripts/check-pins.mjs           # check; exit 1 on any mismatch
 *   node scripts/check-pins.mjs --write   # rewrite every pin to package.json's version
 *   node scripts/check-pins.mjs --root <dir>
 *
 * Plain JS on purpose: runs without a build or `npm ci`.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const PACKAGE_NAME = "@aron98/load-lock";

/**
 * Declared pinned files, relative to the repo root. Add an entry when an
 * artifact starts pinning a version. Kinds:
 *  - { path, kind: "spec" }              every `@aron98/load-lock@<semver>`
 *                                        in the file (`@latest` etc. ignored)
 *  - { path, kind: "json", key: "a.b" }  a JSON string field (dotted path),
 *                                        e.g. plugin.json `version`
 * A declared file that is missing, or has no pin, is an error: a declared
 * pin that silently disappears would otherwise pass forever.
 */
export const PINNED = [
  // e.g. { path: "skills/load-lock/SKILL.md", kind: "spec" },
  // e.g. { path: "ace/mcp.json", kind: "spec" },
  // e.g. { path: "plugins/claude-code/.claude-plugin/plugin.json", kind: "json", key: "version" },
  { path: "skills/load-lock/SKILL.md", kind: "spec" },
  { path: "ace/mcp/mcp.json", kind: "spec" },
];

const SEMVER = String.raw`\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?`;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const specRe = () => new RegExp(`${escapeRe(PACKAGE_NAME)}@(${SEMVER})(?![0-9A-Za-z.+-])`, "g");

/** Find every pin; returns { pins: [{path, found, line?, key?}], errors: [string] }. */
export function scanPins(root, pinned = PINNED) {
  const pins = [];
  const errors = [];
  for (const entry of pinned) {
    const file = join(root, entry.path);
    if (!existsSync(file)) {
      errors.push(`${entry.path}: declared pinned file is missing`);
      continue;
    }
    const text = readFileSync(file, "utf8");
    if (entry.kind === "spec") {
      const before = pins.length;
      text.split("\n").forEach((lineText, i) => {
        for (const m of lineText.matchAll(specRe())) pins.push({ path: entry.path, line: i + 1, found: m[1] });
      });
      if (pins.length === before) errors.push(`${entry.path}: no ${PACKAGE_NAME}@<version> pin found`);
    } else if (entry.kind === "json") {
      let value;
      try {
        value = entry.key.split(".").reduce((o, k) => (o == null ? undefined : o[k]), JSON.parse(text));
      } catch (e) {
        errors.push(`${entry.path}: invalid JSON (${e.message})`);
        continue;
      }
      if (typeof value !== "string") errors.push(`${entry.path}: no string field "${entry.key}"`);
      else pins.push({ path: entry.path, key: entry.key, found: value });
    } else {
      errors.push(`${entry.path}: unknown pin kind ${JSON.stringify(entry.kind)}`);
    }
  }
  return { pins, errors };
}

/** Check all pins against `version`; returns a list of problems (empty = in sync). */
export function checkPins(root, version, pinned = PINNED) {
  const { pins, errors } = scanPins(root, pinned);
  const where = (p) => (p.line ? `${p.path}:${p.line}` : `${p.path} (${p.key})`);
  return [
    ...errors,
    ...pins.filter((p) => p.found !== version).map((p) => `${where(p)}: pins ${p.found}, package.json is ${version}`),
  ];
}

/** Rewrite every pin to `version`; returns the paths that changed. */
export function writePins(root, version, pinned = PINNED) {
  const changed = [];
  for (const entry of pinned) {
    const file = join(root, entry.path);
    if (!existsSync(file)) continue;
    const text = readFileSync(file, "utf8");
    let next = text;
    if (entry.kind === "spec") {
      next = text.replace(specRe(), `${PACKAGE_NAME}@${version}`);
    } else if (entry.kind === "json") {
      // Replace the value textually so the file's formatting survives.
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        continue;
      }
      const keys = entry.key.split(".");
      const parent = keys.slice(0, -1).reduce((o, k) => (o == null ? undefined : o[k]), json);
      const last = keys[keys.length - 1];
      if (parent == null || typeof parent[last] !== "string" || parent[last] === version) continue;
      parent[last] = version;
      const indent = text.match(/^[ \t]+(?=")/m)?.[0] ?? "  ";
      next = JSON.stringify(json, null, indent) + (text.endsWith("\n") ? "\n" : "");
    }
    if (next !== text) {
      writeFileSync(file, next);
      changed.push(entry.path);
    }
  }
  return changed;
}

export function readPackageVersion(root) {
  return JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
}

function main(argv) {
  const write = argv.includes("--write");
  const rootIdx = argv.indexOf("--root");
  const root = rootIdx >= 0 ? resolve(argv[rootIdx + 1]) : resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const version = readPackageVersion(root);
  if (write) {
    const changed = writePins(root, version);
    for (const p of changed) console.log(`updated ${p} -> ${version}`);
  }
  const problems = checkPins(root, version);
  if (problems.length) {
    for (const p of problems) console.error(`pin mismatch: ${p}`);
    console.error(`\n${problems.length} problem(s). Fix with: node scripts/check-pins.mjs --write`);
    return 1;
  }
  console.log(`pins ok: ${PINNED.length} declared file(s) in sync with ${PACKAGE_NAME}@${version}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
