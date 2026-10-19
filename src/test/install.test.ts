/**
 * Round-trip tests for `load-lock install/uninstall --harness ...`, run
 * against a temp HOME (and temp XDG_CONFIG_HOME / CLINE_MCP_SETTINGS_PATH)
 * so real user config is never read or damaged.
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
