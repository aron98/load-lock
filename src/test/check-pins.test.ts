/**
 * Tests for the version-pin sync check (issue #48): scripts/check-pins.mjs
 * over planted files in a temp root, plus the real script on this repo.
 * Light: no daemon, files only.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const SCRIPT = join(REPO_ROOT, "scripts", "check-pins.mjs");

interface PinEntry {
  path: string;
  kind: string;
  key?: string;
}
interface PinsModule {
  PINNED: PinEntry[];
  checkPins(root: string, version: string, pinned?: PinEntry[]): string[];
  writePins(root: string, version: string, pinned?: PinEntry[]): string[];
}
const pins = (await import(pathToFileURL(SCRIPT).href)) as PinsModule;

function plant(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "ll-pins-"));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

const DECLARED: PinEntry[] = [
  { path: "skills/load-lock/SKILL.md", kind: "spec" },
  { path: "ace/mcp.json", kind: "spec" },
  { path: "plugin/.claude-plugin/plugin.json", kind: "json", key: "version" },
];

function plantedRepo(skillPin: string, mcpPin: string, pluginVersion: string): string {
  return plant({
    "skills/load-lock/SKILL.md":
      `Else run \`npx -y @aron98/load-lock@${skillPin} status\`.\n` +
      `Upgrade with \`npm i -g @aron98/load-lock@latest\` (unpinned, ignored).\n`,
    "ace/mcp.json":
      JSON.stringify({ mcpServers: { "load-lock": { command: "npx", args: ["-y", `@aron98/load-lock@${mcpPin}`] } } }, null, 2) + "\n",
    "plugin/.claude-plugin/plugin.json":
      JSON.stringify({ name: "load-lock", version: pluginVersion, description: "x" }, null, 2) + "\n",
  });
}

test("check-pins: in-sync planted files pass", () => {
  const root = plantedRepo("1.6.0", "1.6.0", "1.6.0");
  try {
    assert.deepEqual(pins.checkPins(root, "1.6.0", DECLARED), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("check-pins: mismatches are reported per pin, then --write fixes them all", () => {
  const root = plantedRepo("1.5.0", "1.6.0-rc.1", "1.4.2");
  try {
    const problems = pins.checkPins(root, "1.6.0", DECLARED);
    assert.equal(problems.length, 3, problems.join("\n"));
    assert.ok(problems.some((p) => p.startsWith("skills/load-lock/SKILL.md:1: pins 1.5.0")), problems.join("\n"));
    assert.ok(problems.some((p) => p.includes("ace/mcp.json") && p.includes("1.6.0-rc.1")), problems.join("\n"));
    assert.ok(problems.some((p) => p.includes("plugin.json (version): pins 1.4.2")), problems.join("\n"));

    const changed = pins.writePins(root, "1.6.0", DECLARED);
    assert.deepEqual(changed.sort(), DECLARED.map((d) => d.path).sort());
    assert.deepEqual(pins.checkPins(root, "1.6.0", DECLARED), []);

    const skill = readFileSync(join(root, "skills/load-lock/SKILL.md"), "utf8");
    assert.match(skill, /@aron98\/load-lock@1\.6\.0 status/);
    assert.match(skill, /@aron98\/load-lock@latest/, "non-version tags are left alone");
    const plugin = JSON.parse(readFileSync(join(root, "plugin/.claude-plugin/plugin.json"), "utf8"));
    assert.deepEqual(plugin, { name: "load-lock", version: "1.6.0", description: "x" });

    // idempotent
    assert.deepEqual(pins.writePins(root, "1.6.0", DECLARED), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("check-pins: a declared file that is missing or lost its pin fails", () => {
  const root = plant({ "skills/load-lock/SKILL.md": "use `npx -y @aron98/load-lock@latest`\n" });
  try {
    const problems = pins.checkPins(root, "1.6.0", [
      { path: "skills/load-lock/SKILL.md", kind: "spec" },
      { path: "ace/mcp.json", kind: "spec" },
    ]);
    assert.equal(problems.length, 2, problems.join("\n"));
    assert.match(problems[0], /SKILL\.md: no @aron98\/load-lock@<version> pin found/);
    assert.match(problems[1], /ace\/mcp\.json: declared pinned file is missing/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("check-pins: the script passes on this repo", () => {
  const r = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /pins ok/);
  // every declared path is relative and inside the repo
  for (const e of pins.PINNED) assert.ok(!e.path.startsWith("/") && !e.path.includes(".."), e.path);
});
