/**
 * Round-trip tests for `load-lock install/uninstall --harness ...`, run
 * against a temp HOME (and temp XDG_CONFIG_HOME / CLINE_MCP_SETTINGS_PATH)
 * so real user config is never read or damaged.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, existsSync, cpSync, symlinkSync, lstatSync } from "node:fs";
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
function runCli(home: string, args: string[], extraEnv: Record<string, string> = {}): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliMain, ...args], {
      env: { ...process.env, HOME: home, ...extraEnv },
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
  return mkdtempSync(join(tmpdir(), "ll-install-home-"));
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

// ------------------------------------------------------------- copilot-cli

test("copilot-cli: install/uninstall round-trip on a populated HOME", async () => {
  const home = tempHome();
  const copilotDir = join(home, ".copilot");
  mkdirSync(copilotDir, { recursive: true });
  // pre-existing user config that must survive untouched
  writeFileSync(
    join(copilotDir, "mcp-config.json"),
    JSON.stringify({ mcpServers: { fetch: { type: "local", command: "uvx", args: ["mcp-server-fetch"] } } }, null, 2) + "\n",
  );
  writeFileSync(join(copilotDir, "copilot-instructions.md"), "# My instructions\n\nBe terse.\n");

  const cfgFile = join(copilotDir, "mcp-config.json");
  const instructions = join(copilotDir, "copilot-instructions.md");

  // -- install
  let r = await runCli(home, ["install", "--harness", "copilot-cli"]);
  assert.equal(r.code, 0, `install failed: ${r.stderr}`);
  assert.match(r.stdout, /MCP fallback/i, "installer output must state the MCP-fallback tier");
  assert.match(r.stdout, /no idle wakeup/i, "installer output must not claim wakeup support");

  const s = JSON.parse(readFileSync(cfgFile, "utf8"));
  assert.deepEqual(s.mcpServers.fetch, { type: "local", command: "uvx", args: ["mcp-server-fetch"] }, "unrelated MCP server must be preserved");
  assert.deepEqual(s.mcpServers["load-lock"], { type: "local", command: process.execPath, args: [mcpMain], env: {}, tools: ["*"] }, "load-lock stdio (type: local) server with absolute paths");

  const md = readFileSync(instructions, "utf8");
  assert.ok(md.includes("# My instructions"), "existing instructions must be preserved");
  assert.equal(count(md, MARKER_BEGIN), 1, "exactly one marked section");
  assert.equal(count(md, MARKER_END), 1, "exactly one section end marker");
  assert.ok(md.includes("wait_ms"), "section teaches the bounded wait");

  // -- idempotent re-install
  r = await runCli(home, ["install", "--harness", "copilot-cli"]);
  assert.equal(r.code, 0, `re-install failed: ${r.stderr}`);
  assert.equal(count(readFileSync(instructions, "utf8"), MARKER_BEGIN), 1, "re-install must not duplicate the section");

  // -- uninstall removes exactly our entries
  r = await runCli(home, ["uninstall", "--harness", "copilot-cli"]);
  assert.equal(r.code, 0, `uninstall failed: ${r.stderr}`);

  const s2 = JSON.parse(readFileSync(cfgFile, "utf8"));
  assert.ok(!("load-lock" in s2.mcpServers), "our MCP server key removed");
  assert.ok(s2.mcpServers.fetch, "other MCP servers untouched");

  const md2 = readFileSync(instructions, "utf8");
  assert.ok(!md2.includes(MARKER_BEGIN), "marked section removed");
  assert.ok(md2.includes("# My instructions"), "user instructions untouched");

  rmSync(home, { recursive: true, force: true });
});

test("copilot-cli: bare HOME install via alias `copilot`; uninstall is clean", async () => {
  const home = tempHome();
  let r = await runCli(home, ["install", "--harness", "copilot"]);
  assert.equal(r.code, 0, `install failed: ${r.stderr}`);
  const cfgFile = join(home, ".copilot", "mcp-config.json");
  const instructions = join(home, ".copilot", "copilot-instructions.md");
  assert.ok(existsSync(cfgFile) && existsSync(instructions), "bare install creates both files");
  assert.ok(JSON.parse(readFileSync(cfgFile, "utf8")).mcpServers["load-lock"], "server entry present");

  r = await runCli(home, ["uninstall", "--harness", "copilot-cli"]);
  assert.equal(r.code, 0, `uninstall failed: ${r.stderr}`);
  assert.ok(!("load-lock" in JSON.parse(readFileSync(cfgFile, "utf8")).mcpServers), "our key removed");
  assert.ok(!readFileSync(instructions, "utf8").includes(MARKER_BEGIN), "section removed");
  rmSync(home, { recursive: true, force: true });
});

test("copilot-cli: uninstall with nothing installed is a harmless no-op", async () => {
  const home = tempHome();
  const r = await runCli(home, ["uninstall", "--harness", "copilot-cli"]);
  assert.equal(r.code, 0, `uninstall failed: ${r.stderr}`);
  assert.ok(!existsSync(join(home, ".copilot")), "no files created by uninstall");
  rmSync(home, { recursive: true, force: true });
});

// -------------------------------------------------------------------- cline

test("cline: round-trip on the default settings path, other rules preserved", async () => {
  const home = tempHome();
  const settingsDir = join(home, ".cline", "data", "settings");
  mkdirSync(settingsDir, { recursive: true });
  writeFileSync(
    join(settingsDir, "cline_mcp_settings.json"),
    JSON.stringify({ mcpServers: { fetch: { command: "uvx", args: ["mcp-server-fetch"], env: {}, disabled: false, autoApprove: [] } } }, null, 2) + "\n",
  );
  mkdirSync(join(home, ".cline", "rules"), { recursive: true });
  writeFileSync(join(home, ".cline", "rules", "user-rule.md"), "# User rule\n");

  const cfgFile = join(settingsDir, "cline_mcp_settings.json");
  const ruleFile = join(home, ".cline", "rules", "load-lock.md");

  // -- install (explicitly clear any host CLINE_MCP_SETTINGS_PATH)
  let r = await runCli(home, ["install", "--harness", "cline"], { CLINE_MCP_SETTINGS_PATH: "" });
  assert.equal(r.code, 0, `install failed: ${r.stderr}`);
  assert.match(r.stdout, /MCP fallback/i);
  assert.match(r.stdout, /no idle wakeup/i);

  const s = JSON.parse(readFileSync(cfgFile, "utf8"));
  assert.deepEqual(s.mcpServers.fetch.command, "uvx", "unrelated MCP server preserved");
  assert.deepEqual(s.mcpServers["load-lock"], { command: process.execPath, args: [mcpMain], env: {}, disabled: false, autoApprove: [] }, "load-lock stdio entry, Cline shape");
  const rule = readFileSync(ruleFile, "utf8");
  assert.ok(rule.includes("load-lock"), "rule file teaches load-lock");
  assert.ok(existsSync(join(home, ".cline", "rules", "user-rule.md")), "user rule untouched");

  // -- uninstall removes exactly our entries
  r = await runCli(home, ["uninstall", "--harness", "cline"], { CLINE_MCP_SETTINGS_PATH: "" });
  assert.equal(r.code, 0, `uninstall failed: ${r.stderr}`);
  const s2 = JSON.parse(readFileSync(cfgFile, "utf8"));
  assert.ok(!("load-lock" in s2.mcpServers), "our MCP server key removed");
  assert.ok(s2.mcpServers.fetch, "other MCP servers untouched");
  assert.ok(!existsSync(ruleFile), "our rule file removed");
  assert.ok(existsSync(join(home, ".cline", "rules", "user-rule.md")), "user rule preserved");
  rmSync(home, { recursive: true, force: true });
});

test("cline: honors CLINE_MCP_SETTINGS_PATH and prunes empty dirs on uninstall", async () => {
  const home = tempHome();
  const custom = join(home, "custom-mcp-settings.json");
  writeFileSync(custom, JSON.stringify({ mcpServers: {} }) + "\n");

  let r = await runCli(home, ["install", "--harness", "cline"], { CLINE_MCP_SETTINGS_PATH: custom });
  assert.equal(r.code, 0, `install failed: ${r.stderr}`);
  assert.ok("load-lock" in JSON.parse(readFileSync(custom, "utf8")).mcpServers, "entry written to the overridden path");
  assert.ok(!existsSync(join(home, ".cline", "data")), "default settings path not created when overridden");
  assert.ok(existsSync(join(home, ".cline", "rules", "load-lock.md")), "rule file installed");

  r = await runCli(home, ["uninstall", "--harness", "cline"], { CLINE_MCP_SETTINGS_PATH: custom });
  assert.equal(r.code, 0, `uninstall failed: ${r.stderr}`);
  assert.ok(!("load-lock" in JSON.parse(readFileSync(custom, "utf8")).mcpServers), "our key removed from the overridden path");
  assert.ok(!existsSync(join(home, ".cline")), "empty ~/.cline tree pruned");
  rmSync(home, { recursive: true, force: true });
});

test("cline: uninstall with nothing installed is a harmless no-op", async () => {
  const home = tempHome();
  const r = await runCli(home, ["uninstall", "--harness", "cline"], { CLINE_MCP_SETTINGS_PATH: "" });
  assert.equal(r.code, 0, `uninstall failed: ${r.stderr}`);
  assert.ok(!existsSync(join(home, ".cline")), "no files created by uninstall");
  rmSync(home, { recursive: true, force: true });
});

// ----------------------------------------------------------------- roo-code

test("roo-code: project .roo/mcp.json round-trip; honest note when no global file exists", async () => {
  const home = tempHome();
  const proj = join(home, "proj");
  mkdirSync(proj, { recursive: true });
  const xdg = join(home, ".config");
  const projMcp = join(proj, ".roo", "mcp.json");

  // -- install with --project
  let r = await runCli(home, ["install", "--harness", "roo-code", "--project", proj], { XDG_CONFIG_HOME: xdg });
  assert.equal(r.code, 0, `install failed: ${r.stderr}`);
  assert.match(r.stdout, /MCP fallback/i);
  assert.match(r.stdout, /no idle wakeup/i);
  assert.match(r.stdout, /no global Roo\/Zoo/, "must honestly note it did not find a global mcp_settings.json");

  const s = JSON.parse(readFileSync(projMcp, "utf8"));
  assert.deepEqual(s.mcpServers["load-lock"], { command: process.execPath, args: [mcpMain], disabled: false }, "project-level stdio entry");
  assert.ok(existsSync(join(home, ".roo", "rules", "load-lock.md")), "global rule file installed");

  // -- idempotent re-install
  r = await runCli(home, ["install", "--harness", "roo-code", "--project", proj], { XDG_CONFIG_HOME: xdg });
  assert.equal(r.code, 0, `re-install failed: ${r.stderr}`);
  assert.equal(Object.keys(JSON.parse(readFileSync(projMcp, "utf8")).mcpServers).length, 1, "still exactly one server");

  // -- uninstall (same --project)
  r = await runCli(home, ["uninstall", "--harness", "roo-code", "--project", proj], { XDG_CONFIG_HOME: xdg });
  assert.equal(r.code, 0, `uninstall failed: ${r.stderr}`);
  const s2 = JSON.parse(readFileSync(projMcp, "utf8"));
  assert.ok(!("load-lock" in s2.mcpServers), "our key removed from the project file");
  assert.ok(!existsSync(join(home, ".roo", "rules", "load-lock.md")), "our rule file removed");
  assert.ok(!existsSync(join(home, ".roo")), "empty ~/.roo tree pruned");
  rmSync(home, { recursive: true, force: true });
});

test("roo-code: merges into an existing global mcp_settings.json (never creates one)", async () => {
  const home = tempHome();
  const proj = join(home, "proj");
  mkdirSync(proj, { recursive: true });
  const xdg = join(home, ".config");
  const globalMcp = join(xdg, "Code", "User", "globalStorage", "RooCodeInc.roo-code", "settings", "mcp_settings.json");
  mkdirSync(dirname(globalMcp), { recursive: true });
  writeFileSync(globalMcp, JSON.stringify({ mcpServers: { fetch: { command: "uvx", args: ["mcp-server-fetch"] } } }, null, 2) + "\n");

  let r = await runCli(home, ["install", "--harness", "roo-code", "--project", proj], { XDG_CONFIG_HOME: xdg });
  assert.equal(r.code, 0, `install failed: ${r.stderr}`);
  const g = JSON.parse(readFileSync(globalMcp, "utf8"));
  assert.ok("load-lock" in g.mcpServers, "global file (found, not created) got our server");
  assert.deepEqual(g.mcpServers.fetch.command, "uvx", "unrelated global server preserved");

  r = await runCli(home, ["uninstall", "--harness", "roo-code", "--project", proj], { XDG_CONFIG_HOME: xdg });
  assert.equal(r.code, 0, `uninstall failed: ${r.stderr}`);
  const g2 = JSON.parse(readFileSync(globalMcp, "utf8"));
  assert.ok(!("load-lock" in g2.mcpServers), "our key removed from the global file");
  assert.ok(g2.mcpServers.fetch, "user's global server untouched");
  rmSync(home, { recursive: true, force: true });
});

test("roo-code: aliases `roo`/`zoo-code`/`zoo` map to the same installer", async () => {
  const home = tempHome();
  const proj = join(home, "proj");
  mkdirSync(proj, { recursive: true });
  for (const alias of ["roo", "zoo-code", "zoo"]) {
    const r = await runCli(home, ["install", "--harness", alias, "--project", proj], { XDG_CONFIG_HOME: join(home, ".config") });
    assert.equal(r.code, 0, `install --harness ${alias} failed: ${r.stderr}`);
  }
  const r = await runCli(home, ["uninstall", "--harness", "roo", "--project", proj], { XDG_CONFIG_HOME: join(home, ".config") });
  assert.equal(r.code, 0, `uninstall failed: ${r.stderr}`);
  assert.ok(!("load-lock" in JSON.parse(readFileSync(join(proj, ".roo", "mcp.json"), "utf8")).mcpServers), "uninstalled via alias");
  rmSync(home, { recursive: true, force: true });
});

// -------------------------------------------------------------------- goose

test("goose: install/uninstall round-trip restores config.yaml and hints exactly", async () => {
  const home = tempHome();
  const xdg = join(home, ".config");
  const gooseDir = join(xdg, "goose");
  mkdirSync(gooseDir, { recursive: true });
  const beforeCfg = "GOOSE_MODE: auto\n\ndefault_cli: true\n";
  const beforeHints = "# My hints\n\nBe terse.\n";
  writeFileSync(join(gooseDir, "config.yaml"), beforeCfg);
  writeFileSync(join(gooseDir, ".goosehints"), beforeHints);

  const cfgFile = join(gooseDir, "config.yaml");
  const hints = join(gooseDir, ".goosehints");

  // -- install
  let r = await runCli(home, ["install", "--harness", "goose"], { XDG_CONFIG_HOME: xdg });
  assert.equal(r.code, 0, `install failed: ${r.stderr}`);
  assert.match(r.stdout, /MCP fallback/i);
  assert.match(r.stdout, /no idle wakeup/i);

  const cfg = readFileSync(cfgFile, "utf8");
  assert.ok(cfg.includes("GOOSE_MODE: auto") && cfg.includes("default_cli: true"), "user keys preserved");
  assert.match(cfg, /extensions:\s*# load-lock-created/, "our tagged extensions key");
  assert.match(cfg, /^\s{2}load-lock:\s*$/m, "load-lock child present");
  assert.match(cfg, /^\s{4}type: stdio\s*$/m, "stdio extension type");
  assert.match(cfg, new RegExp(`^\\s{4}cmd: ${JSON.stringify(process.execPath).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "m"), "absolute node path");
  assert.match(cfg, /# load-lock:begin \(managed by `load-lock install`\)/, "managed-block begin marker");
  assert.ok(readFileSync(hints, "utf8").includes("# My hints"), "user hints preserved");
  assert.equal(count(readFileSync(hints, "utf8"), MARKER_BEGIN), 1, "one marked hints section");

  // -- idempotent re-install: byte-identical
  r = await runCli(home, ["install", "--harness", "goose"], { XDG_CONFIG_HOME: xdg });
  assert.equal(r.code, 0, `re-install failed: ${r.stderr}`);
  assert.equal(readFileSync(cfgFile, "utf8"), cfg, "re-install is byte-identical");
  assert.equal(count(readFileSync(hints, "utf8"), MARKER_BEGIN), 1, "no duplicate hints section");

  // -- uninstall restores the user's bytes exactly
  r = await runCli(home, ["uninstall", "--harness", "goose"], { XDG_CONFIG_HOME: xdg });
  assert.equal(r.code, 0, `uninstall failed: ${r.stderr}`);
  assert.equal(readFileSync(cfgFile, "utf8"), beforeCfg, "config.yaml restored byte-for-byte");
  assert.equal(readFileSync(hints, "utf8"), beforeHints, "hints restored byte-for-byte");

  rmSync(home, { recursive: true, force: true });
});

test("goose: replaces a colliding unmarked load-lock child, preserves siblings", async () => {
  const home = tempHome();
  const xdg = join(home, ".config");
  const gooseDir = join(xdg, "goose");
  mkdirSync(gooseDir, { recursive: true });
  writeFileSync(
    join(gooseDir, "config.yaml"),
    "GOOSE_MODE: auto\n" +
      "\n" +
      "extensions:\n" +
      "  developer:\n" +
      "    type: stdio\n" +
      "    cmd: /usr/local/bin/my-server\n" +
      "  load-lock:\n" +
      "    type: stdio\n" +
      "    cmd: old-load-lock-server\n",
  );

  const cfgFile = join(gooseDir, "config.yaml");
  let r = await runCli(home, ["install", "--harness", "goose"], { XDG_CONFIG_HOME: xdg });
  assert.equal(r.code, 0, `install failed: ${r.stderr}`);
  const cfg = readFileSync(cfgFile, "utf8");
  assert.ok(!cfg.includes("old-load-lock-server"), "colliding unmarked load-lock child replaced, not duplicated");
  assert.ok(cfg.includes("/usr/local/bin/my-server"), "sibling extension preserved");
  assert.equal(count(cfg, "\n  load-lock:"), 1, "exactly one load-lock child key (no YAML duplicate)");

  r = await runCli(home, ["uninstall", "--harness", "goose"], { XDG_CONFIG_HOME: xdg });
  assert.equal(r.code, 0, `uninstall failed: ${r.stderr}`);
  const after = readFileSync(cfgFile, "utf8");
  assert.ok(after.includes("/usr/local/bin/my-server"), "sibling extension still there after uninstall");
  assert.ok(!after.includes("load-lock:begin"), "our managed block gone");
  rmSync(home, { recursive: true, force: true });
});

test("goose: refuses flow-style extensions instead of guessing", async () => {
  const home = tempHome();
  const xdg = join(home, ".config");
  const gooseDir = join(xdg, "goose");
  mkdirSync(gooseDir, { recursive: true });
  const before = "extensions: { developer: 1 }\n";
  writeFileSync(join(gooseDir, "config.yaml"), before);

  const r = await runCli(home, ["install", "--harness", "goose"], { XDG_CONFIG_HOME: xdg });
  assert.notEqual(r.code, 0, "flow-style extensions must fail the install");
  assert.match(r.stderr + r.stdout, /flow|block mapping/i, "error must explain the refusal");
  assert.equal(readFileSync(join(gooseDir, "config.yaml"), "utf8"), before, "file untouched on refusal");
  rmSync(home, { recursive: true, force: true });
});

test("goose: bare HOME install creates files; uninstall cleans them completely", async () => {
  const home = tempHome();
  const xdg = join(home, ".config");
  const gooseDir = join(xdg, "goose");

  let r = await runCli(home, ["install", "--harness", "goose"], { XDG_CONFIG_HOME: xdg });
  assert.equal(r.code, 0, `install failed: ${r.stderr}`);
  assert.ok(existsSync(join(gooseDir, "config.yaml")), "config.yaml created");
  assert.ok(existsSync(join(gooseDir, ".goosehints")), "global hints created");

  r = await runCli(home, ["uninstall", "--harness", "goose"], { XDG_CONFIG_HOME: xdg });
  assert.equal(r.code, 0, `uninstall failed: ${r.stderr}`);
  assert.ok(!existsSync(gooseDir), "everything we created removed");
  rmSync(home, { recursive: true, force: true });
});

test("goose: uninstall with nothing installed is a harmless no-op", async () => {
  const home = tempHome();
  const r = await runCli(home, ["uninstall", "--harness", "goose"], { XDG_CONFIG_HOME: join(home, ".config") });
  assert.equal(r.code, 0, `uninstall failed: ${r.stderr}`);
  assert.ok(!existsSync(join(home, ".config", "goose")), "no files created by uninstall");
  rmSync(home, { recursive: true, force: true });
});

// --------------------------------------------------------------- claude-code

test("claude-code: install/uninstall round-trip on a populated HOME; re-install never duplicates hooks", async () => {
  const home = tempHome();
  const claudeDir = join(home, ".claude");
  mkdirSync(claudeDir, { recursive: true });
  // pre-existing user config that must survive untouched
  writeFileSync(
    join(home, ".claude.json"),
    JSON.stringify({ mcpServers: { fetch: { type: "stdio", command: "uvx", args: ["mcp-server-fetch"] } } }, null, 2) + "\n",
  );
  writeFileSync(
    join(claudeDir, "settings.json"),
    JSON.stringify(
      {
        theme: "dark",
        hooks: {
          PreToolUse: [{ hooks: [{ type: "command", command: "/usr/local/bin/guard" }] }],
          Stop: [{ hooks: [{ type: "command", command: "/usr/local/bin/user-stop" }] }],
        },
      },
      null,
      2,
    ) + "\n",
  );
  writeFileSync(join(claudeDir, "CLAUDE.md"), "# My rules\n\nBe terse.\n");

  const claudeJson = join(home, ".claude.json");
  const settingsFile = join(claudeDir, "settings.json");
  const claudeMd = join(claudeDir, "CLAUDE.md");

  // -- install
  let r = await runCli(home, ["install", "--harness", "claude-code"]);
  assert.equal(r.code, 0, `install failed: ${r.stderr}`);

  const s = JSON.parse(readFileSync(settingsFile, "utf8"));
  assert.equal(s.theme, "dark", "unrelated user settings preserved");
  assert.equal(s.hooks.PreToolUse.length, 1, "unrelated event untouched");
  assert.equal(s.hooks.SessionStart.length, 2, "our policy hook + await-offer watcher");
  assert.ok(s.hooks.SessionStart[0].hooks[0].command.includes(JSON.stringify(cliMain)), "command embeds the JSON-quoted cli path");
  assert.ok(s.hooks.SessionStart[0].hooks[0].command.endsWith("hook claude-code session-start"));
  assert.equal(s.hooks.SessionStart[1].hooks[0].async, true, "await-offer watcher is async");
  assert.ok(s.hooks.SessionStart[1].hooks[0].command.endsWith("hook claude-code await-offer"));
  assert.equal(s.hooks.Stop.length, 2, "user Stop hook preserved, ours appended");
  assert.equal(s.hooks.Stop[0].hooks[0].command, "/usr/local/bin/user-stop", "user's stop hook untouched");
  assert.ok(s.hooks.Stop[1].hooks[0].command.endsWith("hook claude-code stop"));

  const cj = JSON.parse(readFileSync(claudeJson, "utf8"));
  assert.deepEqual(cj.mcpServers.fetch, { type: "stdio", command: "uvx", args: ["mcp-server-fetch"] }, "user MCP server preserved");
  assert.deepEqual(cj.mcpServers["load-lock"], { type: "stdio", command: process.execPath, args: [mcpMain] }, "our MCP server shape");

  const md = readFileSync(claudeMd, "utf8");
  assert.ok(md.includes("# My rules"), "existing CLAUDE.md content preserved");
  assert.equal(count(md, MARKER_BEGIN), 1, "exactly one marked section");
  assert.ok(!md.includes("mcp__"), "section names tools neutrally (plugin tools are namespaced differently)");
  assert.ok(existsSync(join(claudeDir, "skills", "load-lock", "SKILL.md")), "skill installed");

  // -- idempotent re-install: no duplicate hook entries (issue #19)
  r = await runCli(home, ["install", "--harness", "claude-code"]);
  assert.equal(r.code, 0, `re-install failed: ${r.stderr}`);
  const s2 = JSON.parse(readFileSync(settingsFile, "utf8"));
  assert.equal(s2.hooks.SessionStart.length, 2, "re-install must not duplicate SessionStart entries");
  assert.equal(s2.hooks.Stop.length, 2, "re-install must not duplicate Stop entries");
  assert.equal(count(readFileSync(claudeMd, "utf8"), MARKER_BEGIN), 1, "re-install must not duplicate the section");

  // -- uninstall removes exactly our entries
  r = await runCli(home, ["uninstall", "--harness", "claude-code"]);
  assert.equal(r.code, 0, `uninstall failed: ${r.stderr}`);

  const s3 = JSON.parse(readFileSync(settingsFile, "utf8"));
  assert.ok(!("SessionStart" in s3.hooks), "our SessionStart entries removed");
  assert.equal(s3.hooks.Stop.length, 1, "only the user's Stop hook remains");
  assert.equal(s3.hooks.Stop[0].hooks[0].command, "/usr/local/bin/user-stop");
  assert.equal(s3.hooks.PreToolUse.length, 1, "user PreToolUse hook preserved");
  assert.equal(s3.theme, "dark", "unrelated settings survive uninstall");

  const cj2 = JSON.parse(readFileSync(claudeJson, "utf8"));
  assert.ok(!("load-lock" in cj2.mcpServers), "our MCP server key removed");
  assert.ok(cj2.mcpServers.fetch, "user MCP server untouched");

  const md2 = readFileSync(claudeMd, "utf8");
  assert.ok(!md2.includes(MARKER_BEGIN), "marked section removed");
  assert.ok(md2.includes("# My rules"), "user markdown untouched");
  assert.ok(!existsSync(join(claudeDir, "skills")), "our skill removed");

  rmSync(home, { recursive: true, force: true });
});

test("claude-code: bare HOME install then uninstall removes exactly what we added", async () => {
  const home = tempHome();
  let r = await runCli(home, ["install", "--harness", "claude-code"]);
  assert.equal(r.code, 0, `install failed: ${r.stderr}`);
  const settingsFile = join(home, ".claude", "settings.json");
  assert.ok(existsSync(settingsFile), "settings.json created");

  r = await runCli(home, ["uninstall", "--harness", "claude-code"]);
  assert.equal(r.code, 0, `uninstall failed: ${r.stderr}`);
  assert.ok(!existsSync(settingsFile), "settings.json was ours alone — removed");
  assert.ok(!existsSync(join(home, ".claude", "skills")), "our skill removed");
  const cj = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8"));
  assert.ok(!("load-lock" in cj.mcpServers), "our MCP server key removed");
  rmSync(home, { recursive: true, force: true });
});

test("claude-code: an ACE-stamped skill survives install and uninstall byte for byte (#89)", async () => {
  const home = tempHome();
  const skillDir = join(home, ".claude", "skills", "load-lock");
  mkdirSync(skillDir, { recursive: true });
  const aceSkill = "---\nname: load-lock\ndescription: from ACE\n---\nACE copy\n";
  const stamp = JSON.stringify({ artifact: "load-lock", version: "1.4.0" }) + "\n";
  writeFileSync(join(skillDir, "SKILL.md"), aceSkill);
  writeFileSync(join(skillDir, ".ace.json"), stamp);

  let r = await runCli(home, ["install", "--harness", "claude-code"]);
  assert.equal(r.code, 0, `install failed: ${r.stderr}`);
  assert.match(r.stdout, /kept the skill .*managed by ACE/);
  assert.equal(readFileSync(join(skillDir, "SKILL.md"), "utf8"), aceSkill, "install must not overwrite ACE's skill");
  // the rest of the loose wiring is still installed
  const cj = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8"));
  assert.ok(cj.mcpServers["load-lock"], "MCP server installed");

  r = await runCli(home, ["uninstall", "--harness", "claude-code"]);
  assert.equal(r.code, 0, `uninstall failed: ${r.stderr}`);
  assert.match(r.stdout, /kept the skill .*managed by ACE/);
  assert.equal(readFileSync(join(skillDir, "SKILL.md"), "utf8"), aceSkill, "uninstall must not delete ACE's skill");
  assert.equal(readFileSync(join(skillDir, ".ace.json"), "utf8"), stamp, "ACE stamp untouched");
  rmSync(home, { recursive: true, force: true });
});

test("claude-code: a symlinked skill dir is neither written through nor removed (#89)", async () => {
  const home = tempHome();
  const checkout = join(home, "dev", "skill");
  mkdirSync(checkout, { recursive: true });
  writeFileSync(join(checkout, "SKILL.md"), "mine\n");
  mkdirSync(join(home, ".claude", "skills"), { recursive: true });
  symlinkSync(checkout, join(home, ".claude", "skills", "load-lock"));

  let r = await runCli(home, ["install", "--harness", "claude-code"]);
  assert.equal(r.code, 0, `install failed: ${r.stderr}`);
  assert.equal(readFileSync(join(checkout, "SKILL.md"), "utf8"), "mine\n", "install must not write through the symlink");
  r = await runCli(home, ["uninstall", "--harness", "claude-code"]);
  assert.equal(r.code, 0, `uninstall failed: ${r.stderr}`);
  assert.ok(lstatSync(join(home, ".claude", "skills", "load-lock")).isSymbolicLink(), "symlink kept");
  rmSync(home, { recursive: true, force: true });
});

test("claude-code: uninstall with nothing installed is a harmless no-op", async () => {
  const home = tempHome();
  const r = await runCli(home, ["uninstall", "--harness", "claude-code"]);
  assert.equal(r.code, 0, `uninstall failed: ${r.stderr}`);
  assert.ok(!existsSync(join(home, ".claude")), "no files created by uninstall");
  assert.ok(!existsSync(join(home, ".claude.json")), "no files created by uninstall");
  rmSync(home, { recursive: true, force: true });
});

// --------------------------------------------------------------------- codex

test("codex: install/uninstall round-trip on a populated HOME; re-install never duplicates hooks", async () => {
  const home = tempHome();
  const codexDir = join(home, ".codex");
  mkdirSync(codexDir, { recursive: true });
  // pre-existing user config that must survive untouched
  writeFileSync(
    join(codexDir, "hooks.json"),
    JSON.stringify(
      {
        hooks: {
          PreToolUse: [{ hooks: [{ type: "command", command: "/usr/local/bin/guard" }] }],
          Stop: [{ hooks: [{ type: "command", command: "/usr/local/bin/user-stop" }] }],
        },
      },
      null,
      2,
    ) + "\n",
  );
  writeFileSync(join(codexDir, "config.toml"), 'model = "gpt-5.2"\n');
  writeFileSync(join(codexDir, "AGENTS.md"), "# My codex rules\n");

  const hooksFile = join(codexDir, "hooks.json");
  const tomlFile = join(codexDir, "config.toml");
  const agentsMd = join(codexDir, "AGENTS.md");

  // -- install
  let r = await runCli(home, ["install", "--harness", "codex"], { CODEX_HOME: codexDir });
  assert.equal(r.code, 0, `install failed: ${r.stderr}`);

  const h = JSON.parse(readFileSync(hooksFile, "utf8"));
  assert.equal(h.hooks.PreToolUse.length, 1, "unrelated event untouched");
  assert.equal(h.hooks.SessionStart.length, 1, "one SessionStart entry (ours)");
  assert.equal(h.hooks.SessionStart[0].matcher, "startup|resume|clear|compact|fork", "SessionStart matcher preserved");
  assert.ok(h.hooks.SessionStart[0].hooks[0].command.includes(JSON.stringify(cliMain)), "command embeds the JSON-quoted cli path");
  assert.ok(h.hooks.SessionStart[0].hooks[0].command.endsWith("hook codex session-start"));
  assert.equal(h.hooks.SubagentStart.length, 1, "one SubagentStart entry (ours)");
  assert.equal(h.hooks.SubagentStart[0].matcher, "*");
  assert.ok(h.hooks.SubagentStart[0].hooks[0].command.endsWith("hook codex subagent-start"));
  assert.equal(h.hooks.Stop.length, 2, "user Stop hook preserved, ours appended");
  assert.equal(h.hooks.Stop[0].hooks[0].command, "/usr/local/bin/user-stop", "user's stop hook untouched");
  assert.ok(h.hooks.Stop[1].hooks[0].command.endsWith("hook codex stop"));

  const toml = readFileSync(tomlFile, "utf8");
  assert.ok(toml.includes('model = "gpt-5.2"'), "user toml keys preserved");
  assert.equal(count(toml, "[mcp_servers.load-lock]"), 1, "exactly one toml block appended");

  const md = readFileSync(agentsMd, "utf8");
  assert.ok(md.includes("# My codex rules"), "existing AGENTS.md content preserved");
  assert.equal(count(md, MARKER_BEGIN), 1, "exactly one marked section");
  assert.ok(!md.includes("mcp__"), "section names tools neutrally");

  // -- idempotent re-install: no duplicate hook entries (issue #19)
  r = await runCli(home, ["install", "--harness", "codex"], { CODEX_HOME: codexDir });
  assert.equal(r.code, 0, `re-install failed: ${r.stderr}`);
  const h2 = JSON.parse(readFileSync(hooksFile, "utf8"));
  assert.equal(h2.hooks.SessionStart.length, 1, "re-install must not duplicate SessionStart entries");
  assert.equal(h2.hooks.SubagentStart.length, 1, "re-install must not duplicate SubagentStart entries");
  assert.equal(h2.hooks.Stop.length, 2, "re-install must not duplicate Stop entries");
  assert.equal(count(readFileSync(agentsMd, "utf8"), MARKER_BEGIN), 1, "re-install must not duplicate the section");

  // -- uninstall removes exactly our entries
  r = await runCli(home, ["uninstall", "--harness", "codex"], { CODEX_HOME: codexDir });
  assert.equal(r.code, 0, `uninstall failed: ${r.stderr}`);

  const h3 = JSON.parse(readFileSync(hooksFile, "utf8"));
  assert.ok(!("SessionStart" in h3.hooks), "our SessionStart entries removed");
  assert.ok(!("SubagentStart" in h3.hooks), "our SubagentStart entries removed");
  assert.equal(h3.hooks.Stop.length, 1, "only the user's Stop hook remains");
  assert.equal(h3.hooks.Stop[0].hooks[0].command, "/usr/local/bin/user-stop");
  assert.equal(h3.hooks.PreToolUse.length, 1, "user PreToolUse hook preserved");

  const toml2 = readFileSync(tomlFile, "utf8");
  assert.ok(!toml2.includes("[mcp_servers.load-lock]"), "our toml block removed");
  assert.ok(toml2.includes('model = "gpt-5.2"'), "user toml keys survive uninstall");

  const md2 = readFileSync(agentsMd, "utf8");
  assert.ok(!md2.includes(MARKER_BEGIN), "marked section removed");
  assert.ok(md2.includes("# My codex rules"), "user markdown untouched");

  rmSync(home, { recursive: true, force: true });
});

test("codex: bare HOME install then uninstall removes exactly what we added", async () => {
  const home = tempHome();
  const codexDir = join(home, ".codex");
  let r = await runCli(home, ["install", "--harness", "codex"], { CODEX_HOME: codexDir });
  assert.equal(r.code, 0, `install failed: ${r.stderr}`);
  const hooksFile = join(codexDir, "hooks.json");
  assert.ok(existsSync(hooksFile), "hooks.json created");

  r = await runCli(home, ["uninstall", "--harness", "codex"], { CODEX_HOME: codexDir });
  assert.equal(r.code, 0, `uninstall failed: ${r.stderr}`);
  assert.ok(!existsSync(hooksFile), "hooks.json was ours alone — removed");
  assert.ok(!readFileSync(join(codexDir, "config.toml"), "utf8").includes("[mcp_servers.load-lock]"), "toml block removed");
  assert.ok(!readFileSync(join(codexDir, "AGENTS.md"), "utf8").includes(MARKER_BEGIN), "AGENTS.md section removed");
  rmSync(home, { recursive: true, force: true });
});

test("codex: uninstall with nothing installed is a harmless no-op", async () => {
  const home = tempHome();
  const r = await runCli(home, ["uninstall", "--harness", "codex"], { CODEX_HOME: join(home, ".codex") });
  assert.equal(r.code, 0, `uninstall failed: ${r.stderr}`);
  assert.ok(!existsSync(join(home, ".codex")), "no files created by uninstall");
  rmSync(home, { recursive: true, force: true });
});

// ------------------------------------------------------------------ cursor

test("cursor: project install/uninstall round-trip preserves user config", async () => {
  const home = tempHome();
  const proj = join(home, "proj");
  mkdirSync(proj, { recursive: true });
  const cursorDir = join(proj, ".cursor");
  mkdirSync(cursorDir, { recursive: true });
  // pre-existing user config that must survive untouched
  writeFileSync(
    join(cursorDir, "mcp.json"),
    JSON.stringify({ mcpServers: { fetch: { command: "uvx", args: ["mcp-server-fetch"] } } }, null, 2) + "\n",
  );
  writeFileSync(
    join(cursorDir, "hooks.json"),
    JSON.stringify(
      {
        version: 1,
        hooks: {
          stop: [{ type: "command", command: "/usr/local/bin/my-checker --staged" }],
          PreToolUse: [{ type: "command", command: "/usr/local/bin/guard" }],
        },
      },
      null,
      2,
    ) + "\n",
  );
  mkdirSync(join(cursorDir, "rules"), { recursive: true });
  writeFileSync(join(cursorDir, "rules", "user-rule.mdc"), "---\nalwaysApply: true\n---\n# User rule\n");

  const mcpFile = join(cursorDir, "mcp.json");
  const hooksFile = join(cursorDir, "hooks.json");
  const ruleFile = join(cursorDir, "rules", "load-lock.mdc");

  // -- install
  let r = await runCli(home, ["install", "--harness", "cursor", "--project", proj]);
  assert.equal(r.code, 0, `install failed: ${r.stderr}`);
  // honest tier statement: wakeup yes, but contract-tested only
  assert.match(r.stdout, /stop-hook wakeup/i, "installer output must state the wakeup tier");
  assert.match(r.stdout, /not live-verified/i, "installer output must be honest about verification");

  const m = JSON.parse(readFileSync(mcpFile, "utf8"));
  assert.deepEqual(m.mcpServers.fetch, { command: "uvx", args: ["mcp-server-fetch"] }, "unrelated MCP server preserved");
  assert.deepEqual(m.mcpServers["load-lock"], { command: process.execPath, args: [mcpMain] }, "load-lock stdio entry with absolute paths");

  const h = JSON.parse(readFileSync(hooksFile, "utf8"));
  assert.equal(h.version, 1, "hooks v1 version preserved");
  assert.equal(h.hooks.stop.length, 2, "user's stop hook preserved, ours appended");
  assert.equal(h.hooks.stop[0].command, "/usr/local/bin/my-checker --staged", "user's stop hook untouched");
  assert.equal(h.hooks.stop[1].type, "command");
  assert.ok(h.hooks.stop[1].command.includes(JSON.stringify(cliMain)), "our stop hook invokes the load-lock CLI");
  assert.ok(h.hooks.stop[1].command.endsWith("hook cursor stop"), "our stop hook is the cursor stop handler");
  assert.ok(Array.isArray(h.hooks.PreToolUse) && h.hooks.PreToolUse.length === 1, "unrelated event untouched");

  const rule = readFileSync(ruleFile, "utf8");
  assert.ok(rule.startsWith("---\n"), ".mdc YAML frontmatter present");
  assert.ok(rule.includes("alwaysApply: true"), "Always-apply rule (plain .md is ignored by Cursor)");
  assert.ok(rule.includes("load-lock"), "rule teaches load-lock");
  assert.ok(existsSync(join(cursorDir, "rules", "user-rule.mdc")), "user rule untouched");

  // -- idempotent re-install: no duplicate hooks, no config damage
  r = await runCli(home, ["install", "--harness", "cursor", "--project", proj]);
  assert.equal(r.code, 0, `re-install failed: ${r.stderr}`);
  assert.equal(JSON.parse(readFileSync(hooksFile, "utf8")).hooks.stop.length, 2, "re-install must not duplicate our hook");
  assert.deepEqual(JSON.parse(readFileSync(mcpFile, "utf8")).mcpServers["load-lock"], {
    command: process.execPath,
    args: [mcpMain],
  });

  // -- uninstall removes exactly our entries
  r = await runCli(home, ["uninstall", "--harness", "cursor", "--project", proj]);
  assert.equal(r.code, 0, `uninstall failed: ${r.stderr}`);

  const m2 = JSON.parse(readFileSync(mcpFile, "utf8"));
  assert.ok(!("load-lock" in m2.mcpServers), "our MCP key removed");
  assert.deepEqual(m2.mcpServers.fetch, { command: "uvx", args: ["mcp-server-fetch"] }, "user MCP untouched");

  const h2 = JSON.parse(readFileSync(hooksFile, "utf8"));
  assert.equal(h2.version, 1, "user's version key preserved");
  assert.equal(h2.hooks.stop.length, 1, "only the user's stop hook remains");
  assert.equal(h2.hooks.stop[0].command, "/usr/local/bin/my-checker --staged");
  assert.ok(Array.isArray(h2.hooks.PreToolUse) && h2.hooks.PreToolUse.length === 1, "unrelated event preserved");
  assert.ok(!existsSync(ruleFile), "our rule file removed");
  assert.ok(existsSync(join(cursorDir, "rules", "user-rule.mdc")), "user rule preserved");
  assert.ok(existsSync(cursorDir), "non-empty .cursor dir preserved");

  rmSync(home, { recursive: true, force: true });
});

test("cursor: bare project install creates all files; uninstall cleans them completely", async () => {
  const home = tempHome();
  const proj = join(home, "proj");
  mkdirSync(proj, { recursive: true });

  let r = await runCli(home, ["install", "--harness", "cursor", "--project", proj]);
  assert.equal(r.code, 0, `install failed: ${r.stderr}`);
  const cursorDir = join(proj, ".cursor");
  const mcpFile = join(cursorDir, "mcp.json");
  const hooksFile = join(cursorDir, "hooks.json");
  const ruleFile = join(cursorDir, "rules", "load-lock.mdc");
  assert.ok(existsSync(mcpFile) && existsSync(hooksFile) && existsSync(ruleFile), "all three files created");
  const h = JSON.parse(readFileSync(hooksFile, "utf8"));
  assert.equal(h.version, 1, "hooks v1 version written");
  assert.ok(Array.isArray(h.hooks.stop) && h.hooks.stop.length === 1, "exactly one stop hook");
  assert.ok(JSON.parse(readFileSync(mcpFile, "utf8")).mcpServers["load-lock"], "server entry present");

  r = await runCli(home, ["uninstall", "--harness", "cursor", "--project", proj]);
  assert.equal(r.code, 0, `uninstall failed: ${r.stderr}`);
  assert.ok(!existsSync(ruleFile), "rule file removed");
  assert.ok(!existsSync(hooksFile), "hooks.json removed (nothing else was in it)");
  assert.ok(!existsSync(mcpFile), "mcp.json removed (nothing else was in it)");
  assert.ok(!existsSync(cursorDir), "empty .cursor dir pruned");
  assert.ok(existsSync(proj), "the project directory itself is never removed");
  rmSync(home, { recursive: true, force: true });
});

test("cursor: uninstall with nothing installed is a harmless no-op", async () => {
  const home = tempHome();
  const proj = join(home, "proj");
  mkdirSync(proj, { recursive: true });
  const r = await runCli(home, ["uninstall", "--harness", "cursor", "--project", proj]);
  assert.equal(r.code, 0, `uninstall failed: ${r.stderr}`);
  assert.ok(!existsSync(join(proj, ".cursor")), "no files created by uninstall");
  rmSync(home, { recursive: true, force: true });
});

// --------------------------------------------------------------------- omac

// The omac profile the installer must merge into without damaging it:
// entries in every known section plus an unknown field (a newer omac
// would accept it; we must preserve it untouched).
function omacUserProfile(home: string): string {
  return JSON.stringify(
    {
      workdir: { access: "readwrite" },
      network: { allow_domain: ["example.com"], allow_tcp_connect: [22] },
      filesystem: {
        allow: ["/data"],
        read: ["/docs"],
        write: ["/out"],
        allow_unix_dir: ["/tmp/other-socks"],
        deny: [".env"],
      },
      environment: { allow_vars: ["ANTHROPIC_API_KEY", "MY_*"] },
      someFutureField: { nested: true },
    },
    null,
    2,
  ) + "\n";
}

function omacProfilePath(home: string): string {
  return join(home, ".config", "omac", "sandbox-profiles", "default.json");
}

test("omac: install/uninstall round-trip on a populated profile; re-install is byte-identical", async () => {
  const home = tempHome();
  const xdg = join(home, ".config");
  const profileFile = omacProfilePath(home);
  mkdirSync(dirname(profileFile), { recursive: true });
  const before = omacUserProfile(home);
  writeFileSync(profileFile, before);
  const stateDir = join(home, "ll-state");
  const env = { XDG_CONFIG_HOME: xdg, LOAD_LOCK_STATE_DIR: stateDir, XDG_STATE_HOME: join(home, ".local", "state") };

  // -- install
  let r = await runCli(home, ["install", "--harness", "omac"], env);
  assert.equal(r.code, 0, `install failed: ${r.stderr}`);
  // honesty: live-verified claim, the env prefix entry, and the state-dir grant
  assert.match(r.stdout, /live-verified.*omac 0\.11\.0|verified live against omac 0\.11\.0/i, "installer output must state the verification status");
  assert.match(r.stdout, /LOAD_LOCK_\*/, "installer output must mention the LOAD_LOCK_* allow_vars entry");
  assert.match(r.stdout, /allow_unix_dir \+=/, "installer output must mention the state-dir grant");
  assert.match(r.stdout, /skipped filesystem\.read.*repo checkout/, "installer output must honestly note the skipped read grant (CLI runs from a repo checkout)");

  const p = JSON.parse(readFileSync(profileFile, "utf8"));
  // user entries preserved everywhere
  assert.deepEqual(p.workdir, { access: "readwrite" }, "user workdir section preserved");
  assert.deepEqual(p.network, { allow_domain: ["example.com"], allow_tcp_connect: [22] }, "user network section preserved");
  assert.deepEqual(p.filesystem.allow, ["/data"], "user filesystem.allow preserved");
  assert.deepEqual(p.filesystem.write, ["/out"], "user filesystem.write preserved");
  assert.deepEqual(p.filesystem.deny, [".env"], "user filesystem.deny preserved");
  assert.deepEqual(p.filesystem.read, ["/docs"], "read untouched — repo checkout needs no package-tree grant");
  assert.deepEqual(p.someFutureField, { nested: true }, "unknown (newer-omac) field preserved");
  // our grants, exactly once, alongside the user's
  assert.deepEqual(p.filesystem.allow_unix_dir, ["/tmp/other-socks", stateDir], "state dir appended to allow_unix_dir");
  assert.deepEqual(p.environment.allow_vars, ["ANTHROPIC_API_KEY", "MY_*", "LOAD_LOCK_*"], "LOAD_LOCK_* appended to allow_vars");
  assert.equal(p.filesystem.allow_unix_dir.filter((e: string) => e === stateDir).length, 1, "state dir granted exactly once");

  // -- idempotent re-install: the file is not rewritten at all
  const afterInstall = readFileSync(profileFile, "utf8");
  r = await runCli(home, ["install", "--harness", "omac"], env);
  assert.equal(r.code, 0, `re-install failed: ${r.stderr}`);
  assert.equal(readFileSync(profileFile, "utf8"), afterInstall, "re-install must be byte-identical");
  assert.match(r.stdout, /already present.*nothing to do/, "re-install must say nothing was needed");

  // -- uninstall removes exactly our entries
  r = await runCli(home, ["uninstall", "--harness", "omac"], env);
  assert.equal(r.code, 0, `uninstall failed: ${r.stderr}`);
  const u = JSON.parse(readFileSync(profileFile, "utf8"));
  assert.deepEqual(u.filesystem.allow_unix_dir, ["/tmp/other-socks"], "our state dir removed, user entry kept");
  assert.ok(!u.filesystem.read.includes(stateDir), "no stray read grant");
  assert.deepEqual(u.filesystem.read, ["/docs"], "user read entry kept");
  assert.deepEqual(u.environment.allow_vars, ["ANTHROPIC_API_KEY", "MY_*"], "our env entry removed, user entries kept");
  assert.deepEqual(u.workdir, { access: "readwrite" }, "user sections untouched by uninstall");
  assert.deepEqual(u.someFutureField, { nested: true }, "unknown field untouched by uninstall");

  rmSync(home, { recursive: true, force: true });
});

test("omac: install on a missing profile creates a minimal valid one (XDG_STATE_HOME honored); uninstall cleans it", async () => {
  const home = tempHome();
  const xdg = join(home, ".config");
  const profileFile = omacProfilePath(home);
  const xdgState = join(home, ".local", "state");
  // LOAD_LOCK_STATE_DIR: "" clears any inherited override so XDG_STATE_HOME is honored
  const env = { XDG_CONFIG_HOME: xdg, LOAD_LOCK_STATE_DIR: "", XDG_STATE_HOME: xdgState };

  let r = await runCli(home, ["install", "--harness", "omac"], env);
  assert.equal(r.code, 0, `install failed: ${r.stderr}`);
  assert.ok(existsSync(profileFile), "profile created");
  const p = JSON.parse(readFileSync(profileFile, "utf8"));
  // minimal valid profile: only known fields, no empty arrays, no read grant (repo checkout)
  assert.deepEqual(p, {
    environment: { allow_vars: ["LOAD_LOCK_*"] },
    filesystem: { allow_unix_dir: [join(xdgState, "load-lock")] },
  }, "created profile holds exactly our grants");
  // XDG_STATE_HOME honored: default state dir, not ~/.local/state off the real HOME
  assert.ok(p.filesystem.allow_unix_dir[0].startsWith(xdgState), "state dir derived from XDG_STATE_HOME");

  // idempotent re-install: byte-identical
  const bytes = readFileSync(profileFile, "utf8");
  r = await runCli(home, ["install", "--harness", "omac"], env);
  assert.equal(r.code, 0, `re-install failed: ${r.stderr}`);
  assert.equal(readFileSync(profileFile, "utf8"), bytes, "re-install is byte-identical");

  // uninstall removes the file (nothing user-owned was ever in it) and prunes dirs
  r = await runCli(home, ["uninstall", "--harness", "omac"], env);
  assert.equal(r.code, 0, `uninstall failed: ${r.stderr}`);
  assert.ok(!existsSync(profileFile), "our file removed");
  assert.ok(!existsSync(join(xdg, "omac")), "empty omac config tree pruned");

  rmSync(home, { recursive: true, force: true });
});

test("omac: a global-style install (package outside any repo) adds the package-tree read grant; uninstall removes it by shape", async () => {
  const home = tempHome();
  const xdg = join(home, ".config");
  const stateDir = join(home, "ll-state");
  const env = { XDG_CONFIG_HOME: xdg, LOAD_LOCK_STATE_DIR: stateDir, XDG_STATE_HOME: join(home, ".local", "state") };
  // simulate a global install: package tree under node_modules, outside any .git
  const pkgMock = join(home, "bun-mock", "install", "global", "node_modules", "@aron98", "load-lock");
  mkdirSync(dirname(pkgMock), { recursive: true });
  cpSync(join(HERE, ".."), join(pkgMock, "dist"), { recursive: true }); // dist/ from the worktree build
  const mockCli = join(pkgMock, "dist", "cli", "main.js");
  const profileFile = omacProfilePath(home);

  const runMock = (args: string[]) =>
    new Promise<CliResult>((resolveP, reject) => {
      const child = spawn(process.execPath, [mockCli, ...args], { env: { ...process.env, HOME: home, ...env } });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (b) => (stdout += b));
      child.stderr.on("data", (b) => (stderr += b));
      child.stdin.end();
      child.once("exit", (code) => resolveP({ code, stdout, stderr }));
      child.once("error", reject);
    });

  let r = await runMock(["install", "--harness", "omac"]);
  assert.equal(r.code, 0, `install failed: ${r.stderr}`);
  assert.match(r.stdout, /filesystem\.read \+=/, "installer output must mention the package-tree read grant");
  const p = JSON.parse(readFileSync(profileFile, "utf8"));
  const pkgReal = resolve(pkgMock);
  assert.deepEqual(p.filesystem.read, [pkgReal], "read grant is the realpath of the package root");
  assert.ok(p.filesystem.allow_unix_dir.includes(stateDir), "state dir granted too");

  // idempotent re-install from the global copy: byte-identical
  const bytes = readFileSync(profileFile, "utf8");
  r = await runMock(["install", "--harness", "omac"]);
  assert.equal(r.code, 0, `re-install failed: ${r.stderr}`);
  assert.equal(readFileSync(profileFile, "utf8"), bytes, "re-install is byte-identical");

  // uninstall from the WORKTREE CLI (a different location, readTree is null
  // there): the read entry still matches by its node_modules/@aron98/load-lock shape
  r = await runCli(home, ["uninstall", "--harness", "omac"], env);
  assert.equal(r.code, 0, `uninstall failed: ${r.stderr}`);
  assert.ok(!existsSync(profileFile), "profile held only our grants — removed");

  rmSync(home, { recursive: true, force: true });
});

test("omac: uninstall with nothing installed is a harmless no-op", async () => {
  const home = tempHome();
  const r = await runCli(home, ["uninstall", "--harness", "omac"], { XDG_CONFIG_HOME: join(home, ".config"), LOAD_LOCK_STATE_DIR: join(home, "ll-state") });
  assert.equal(r.code, 0, `uninstall failed: ${r.stderr}`);
  assert.ok(!existsSync(join(home, ".config", "omac")), "no files created by uninstall");
  rmSync(home, { recursive: true, force: true });
});

test("omac: install refuses to touch a broken or misshapen profile", async () => {
  const home = tempHome();
  const xdg = join(home, ".config");
  const profileFile = omacProfilePath(home);
  mkdirSync(dirname(profileFile), { recursive: true });
  const env = { XDG_CONFIG_HOME: xdg, LOAD_LOCK_STATE_DIR: join(home, "ll-state") };

  // (a) invalid JSON
  const broken = "{ not json";
  writeFileSync(profileFile, broken);
  let r = await runCli(home, ["install", "--harness", "omac"], env);
  assert.notEqual(r.code, 0, "install must refuse invalid JSON");
  assert.match(r.stderr + r.stdout, /not valid JSON|refus/i, "error must explain the refusal");
  assert.equal(readFileSync(profileFile, "utf8"), broken, "file untouched on refusal");

  // (b) allow_vars present but not an array of strings
  const misshapen = JSON.stringify({ environment: { allow_vars: "PATH" } }, null, 2) + "\n";
  writeFileSync(profileFile, misshapen);
  r = await runCli(home, ["install", "--harness", "omac"], env);
  assert.notEqual(r.code, 0, "install must refuse a non-array allow_vars");
  assert.match(r.stderr + r.stdout, /allow_vars.*not an array/i, "error must name the offending field");
  assert.equal(readFileSync(profileFile, "utf8"), misshapen, "file untouched on refusal");

  // uninstall also refuses (never "fixes" the file by overwriting it) on invalid JSON
  writeFileSync(profileFile, broken);
  r = await runCli(home, ["uninstall", "--harness", "omac"], env);
  assert.notEqual(r.code, 0, "uninstall must refuse invalid JSON too");
  assert.equal(readFileSync(profileFile, "utf8"), broken, "file untouched on refusal");

  // on a merely misshapen value (valid JSON, allow_vars not an array) uninstall
  // is a graceful no-op: it never wrote that value, so it leaves it alone
  writeFileSync(profileFile, misshapen);
  r = await runCli(home, ["uninstall", "--harness", "omac"], env);
  assert.equal(r.code, 0, `uninstall failed: ${r.stderr}`);
  assert.equal(readFileSync(profileFile, "utf8"), misshapen, "file untouched by uninstall");

  rmSync(home, { recursive: true, force: true });
});
