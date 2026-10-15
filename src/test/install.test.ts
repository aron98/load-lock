/**
 * Round-trip tests for `load-lock install/uninstall --harness gemini-cli`,
 * run against a temp HOME so the real ~/.gemini is never read or damaged.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const cliMain = join(HERE, "..", "cli", "main.js");
const mcpMain = resolve(HERE, "..", "mcp", "main.js");
const MARKER_BEGIN = "<!-- load-lock:begin -->";
const MARKER_END = "<!-- load-lock:end -->";

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Run the compiled CLI in a child process with HOME overridden. */
function runCli(home: string, args: string[]): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliMain, ...args], {
      env: { ...process.env, HOME: home },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b) => (stdout += b));
    child.stderr.on("data", (b) => (stderr += b));
    child.stdin.end();
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
    child.once("error", reject);
  });
}

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "ll-gemini-home-"));
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

test("gemini-cli: install/uninstall round-trip on a populated HOME", async () => {
  const home = tempHome();
  const geminiDir = join(home, ".gemini");
  mkdirSync(geminiDir, { recursive: true });
  // pre-existing user config that must survive untouched
  writeFileSync(
    join(geminiDir, "settings.json"),
    JSON.stringify({ theme: "auto", mcpServers: { fetch: { command: "uvx", args: ["mcp-server-fetch"] } } }, null, 2) + "\n",
  );
  writeFileSync(join(geminiDir, "GEMINI.md"), "# My rules\n\nBe terse.\n");

  const settingsFile = join(geminiDir, "settings.json");
  const geminiMd = join(geminiDir, "GEMINI.md");

  // -- install
  let r = await runCli(home, ["install", "--harness", "gemini-cli"]);
  assert.equal(r.code, 0, `install failed: ${r.stderr}`);
  // honest tier statement in the installer output
  assert.match(r.stdout, /MCP fallback/i, "installer output must state the MCP-fallback tier");
  assert.match(r.stdout, /no idle wakeup/i, "installer output must not claim wakeup support");

  const s = JSON.parse(readFileSync(settingsFile, "utf8"));
  assert.equal(s.theme, "auto", "unrelated user settings must be preserved");
  assert.deepEqual(s.mcpServers.fetch, { command: "uvx", args: ["mcp-server-fetch"] }, "unrelated MCP server must be preserved");
  assert.deepEqual(s.mcpServers["load-lock"], { command: process.execPath, args: [mcpMain] }, "load-lock stdio server with absolute paths");

  const md = readFileSync(geminiMd, "utf8");
  assert.ok(md.includes("# My rules"), "existing GEMINI.md content must be preserved");
  assert.equal(count(md, MARKER_BEGIN), 1, "exactly one marked section");
  assert.equal(count(md, MARKER_END), 1, "exactly one section end marker");
  assert.ok(md.includes("wait_ms"), "section teaches the bounded wait");

  // -- idempotent re-install: no duplicate sections, no config damage
  r = await runCli(home, ["install", "--harness", "gemini-cli"]);
  assert.equal(r.code, 0, `re-install failed: ${r.stderr}`);
  assert.equal(count(readFileSync(geminiMd, "utf8"), MARKER_BEGIN), 1, "re-install must not duplicate the section");
  assert.deepEqual(JSON.parse(readFileSync(settingsFile, "utf8")).mcpServers["load-lock"], {
    command: process.execPath,
    args: [mcpMain],
  });

  // -- uninstall mirrors install exactly
  r = await runCli(home, ["uninstall", "--harness", "gemini-cli"]);
  assert.equal(r.code, 0, `uninstall failed: ${r.stderr}`);

  const s2 = JSON.parse(readFileSync(settingsFile, "utf8"));
  assert.equal(s2.theme, "auto", "unrelated user settings must survive uninstall");
  assert.ok(!("load-lock" in s2.mcpServers), "our MCP server key removed");
  assert.deepEqual(s2.mcpServers.fetch, { command: "uvx", args: ["mcp-server-fetch"] }, "other MCP servers untouched");

  const md2 = readFileSync(geminiMd, "utf8");
  assert.ok(!md2.includes(MARKER_BEGIN), "marked section removed");
  assert.ok(md2.includes("# My rules"), "user markdown untouched");
  assert.ok(!existsSync(join(geminiDir, "skills")), "no stray files");

  rmSync(home, { recursive: true, force: true });
});

test("gemini-cli: install on a bare HOME creates both files; uninstall cleans them", async () => {
  const home = tempHome();
  const geminiDir = join(home, ".gemini");
  const settingsFile = join(geminiDir, "settings.json");
  const geminiMd = join(geminiDir, "GEMINI.md");

  let r = await runCli(home, ["install", "--harness", "gemini-cli"]);
  assert.equal(r.code, 0, `install failed: ${r.stderr}`);
  const s = JSON.parse(readFileSync(settingsFile, "utf8"));
  assert.deepEqual(s.mcpServers["load-lock"], { command: process.execPath, args: [mcpMain] });
  const md = readFileSync(geminiMd, "utf8");
  assert.ok(md.includes(MARKER_BEGIN) && md.includes(MARKER_END));

  r = await runCli(home, ["uninstall", "--harness", "gemini-cli"]);
  assert.equal(r.code, 0, `uninstall failed: ${r.stderr}`);
  const s2 = JSON.parse(readFileSync(settingsFile, "utf8"));
  assert.ok(!("load-lock" in (s2.mcpServers ?? {})), "load-lock key gone");
  assert.ok(!readFileSync(geminiMd, "utf8").includes(MARKER_BEGIN), "section gone");

  rmSync(home, { recursive: true, force: true });
});

test("gemini-cli: uninstall with nothing installed is a harmless no-op", async () => {
  const home = tempHome();
  const r = await runCli(home, ["uninstall", "--harness", "gemini-cli"]);
  assert.equal(r.code, 0, `uninstall failed: ${r.stderr}`);
  assert.ok(!existsSync(join(home, ".gemini")), "no files created by uninstall");
  rmSync(home, { recursive: true, force: true });
});

test("gemini-cli: aliases `gemini` map to the same installer", async () => {
  const home = tempHome();
  const r = await runCli(home, ["install", "--harness", "gemini"]);
  assert.equal(r.code, 0, `install failed: ${r.stderr}`);
  assert.ok(existsSync(join(home, ".gemini", "settings.json")));
  rmSync(home, { recursive: true, force: true });
});
