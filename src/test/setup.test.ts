/**
 * `load-lock setup` inventory (issue #58), run against a temp HOME / project /
 * state dir so real user config is never read or damaged. Fixtures are
 * planted with the real installers (`load-lock install --harness ...`) plus
 * hand-written plugin / ACE / foreign entries.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const cliMain = join(HERE, "..", "cli", "main.js");
const repoRoot = resolve(HERE, "..", "..");
const TMP_BASE = process.env.LL_TEST_TMP ?? tmpdir();
mkdirSync(TMP_BASE, { recursive: true });

interface Sandbox {
  root: string;
  home: string;
  project: string;
  env: Record<string, string>;
}

function sandbox(): Sandbox {
  const root = mkdtempSync(join(TMP_BASE, "ll-setup-"));
  const home = join(root, "home");
  const project = join(root, "proj");
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !["XDG_CONFIG_HOME", "CODEX_HOME", "CLINE_MCP_SETTINGS_PATH", "LOAD_LOCK_SOCKET"].includes(k)) env[k] = v;
  }
  Object.assign(env, {
    HOME: home,
    LOAD_LOCK_STATE_DIR: join(root, "state"),
    XDG_CACHE_HOME: join(root, "cache"),
    npm_config_cache: join(root, "npm-cache"),
  });
  return { root, home, project, env };
}

function runCli(sb: Sandbox, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((res, rej) => {
    const child = spawn(process.execPath, [cliMain, ...args], { env: sb.env, cwd: sb.project });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b) => (stdout += b));
    child.stderr.on("data", (b) => (stderr += b));
    child.stdin.end();
    child.once("exit", (code) => res({ code, stdout, stderr }));
    child.once("error", rej);
  });
}

/** `setup --json` output: { inventory, plan }. */
async function setupOut(sb: Sandbox): Promise<any> {
  const r = await runCli(sb, ["setup", "--json", "--project", sb.project]);
  assert.equal(r.code, 0, `setup failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

async function setupJson(sb: Sandbox): Promise<any> {
  return (await setupOut(sb)).inventory;
}

async function install(sb: Sandbox, harness: string, ...extra: string[]): Promise<void> {
  const r = await runCli(sb, ["install", "--harness", harness, "--project", sb.project, ...extra]);
  assert.equal(r.code, 0, `install ${harness} failed: ${r.stderr}`);
}

/** Every file under dir with its bytes (to prove setup never writes). */
function snapshot(dir: string, out: Record<string, string> = {}): Record<string, string> {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) snapshot(p, out);
    else out[p] = readFileSync(p, "utf8");
  }
  return out;
}

function harness(inv: any, name: string): any {
  const h = inv.harnesses.find((x: any) => x.harness === name);
  assert.ok(h, `harness ${name} missing from inventory`);
  return h;
}

function writeJsonFile(file: string, data: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}

const ALL = ["claude-code", "opencode", "codex", "cursor", "gemini-cli", "copilot-cli", "cline", "roo-code", "goose", "omac"];

test("setup: bare HOME lists every supported harness as not installed and writes nothing", async () => {
  const sb = sandbox();
  const before = snapshot(sb.root);
  const inv = await setupJson(sb);
  assert.deepEqual(inv.harnesses.map((h: any) => h.harness), ALL);
  for (const h of inv.harnesses) {
    assert.equal(h.rung, "none", `${h.harness} rung`);
    assert.deepEqual(h.integrations, []);
    assert.deepEqual(h.findings, []);
  }
  assert.ok(inv.runtime.copies.some((c: any) => c.source === "cli" && c.path === repoRoot), "lists the running copy");
  const human = await runCli(sb, ["setup", "--project", sb.project]);
  assert.equal(human.code, 0);
  assert.match(human.stdout, /inventory \(read-only\)/);
  assert.match(human.stdout, /goose\s+not installed/);
  assert.deepEqual(snapshot(sb.root), before, "setup must not write anything");
  rmSync(sb.root, { recursive: true, force: true });
});

test("setup: each installer's wiring is inventoried with its rung, owner and copy; setup stays read-only", async () => {
  const sb = sandbox();
  for (const h of ALL) await install(sb, h);
  const before = snapshot(sb.root);
  const inv = await setupJson(sb);

  const expect: Record<string, { rung: string; kinds: string[] }> = {
    "claude-code": { rung: "loose", kinds: ["hooks", "mcp", "policy", "skill"] },
    opencode: { rung: "plugin", kinds: ["plugin"] },
    codex: { rung: "loose", kinds: ["hooks", "mcp", "policy"] },
    cursor: { rung: "loose", kinds: ["hooks", "mcp", "policy"] },
    "gemini-cli": { rung: "loose", kinds: ["mcp", "policy"] },
    "copilot-cli": { rung: "loose", kinds: ["mcp", "policy"] },
    cline: { rung: "loose", kinds: ["mcp", "policy"] },
    "roo-code": { rung: "loose", kinds: ["mcp", "policy"] },
    goose: { rung: "loose", kinds: ["mcp", "policy"] },
    omac: { rung: "loose", kinds: ["grants"] },
  };
  for (const [name, e] of Object.entries(expect)) {
    const h = harness(inv, name);
    assert.equal(h.rung, e.rung, `${name} rung`);
    assert.deepEqual([...new Set(h.integrations.map((i: any) => i.kind))].sort(), e.kinds, `${name} kinds`);
    for (const i of h.integrations) {
      assert.equal(i.owner, "installer", `${name} ${i.kind} owner`);
      if (i.copy !== undefined) {
        assert.equal(i.copy, repoRoot, `${name} ${i.kind} points at this copy`);
        assert.equal(i.stale, false);
      }
    }
    assert.deepEqual(h.findings, [], `${name}: a clean install has no findings`);
  }
  const cc = harness(inv, "claude-code");
  assert.deepEqual(
    cc.integrations.find((i: any) => i.kind === "hooks").detail.split(", ").sort(),
    ["SessionStart:await-offer", "SessionStart:session-start", "Stop:stop"],
  );
  assert.deepEqual(snapshot(sb.root), before, "setup must not write anything");
  rmSync(sb.root, { recursive: true, force: true });
});

test("setup: flags loose + plugin double install and MCP registered more than once (Claude Code)", async () => {
  const sb = sandbox();
  await install(sb, "claude-code");
  const settingsFile = join(sb.home, ".claude", "settings.json");
  const s = JSON.parse(readFileSync(settingsFile, "utf8"));
  s.enabledPlugins = { "load-lock-plugin@load-lock": true, "other@market": true };
  writeJsonFile(settingsFile, s);
  // an ACE-style project MCP patch (`servers` key, pinned npx)
  writeJsonFile(join(sb.project, ".mcp.json"), {
    servers: { "load-lock": { command: "npx", args: ["-y", "@aron98/load-lock@1.5.0", "mcp"] } },
  });

  const cc = harness(await setupJson(sb), "claude-code");
  assert.equal(cc.rung, "plugin");
  const plugin = cc.integrations.find((i: any) => i.kind === "plugin");
  assert.equal(plugin.detail, 'enabledPlugins["load-lock-plugin@load-lock"]');
  assert.equal(plugin.owner, "harness");
  assert.equal(plugin.enabled, true);
  const ace = cc.integrations.find((i: any) => i.kind === "mcp" && i.scope === "project");
  assert.equal(ace.owner, "other");
  assert.equal(ace.detail, "servers.load-lock");
  assert.ok(cc.findings.some((f: string) => f.startsWith("loose + plugin double install")), cc.findings.join("\n"));
  assert.ok(cc.findings.some((f: string) => f.startsWith("MCP registered 3 times")), cc.findings.join("\n"));

  // a disabled plugin does not count as the active rung
  s.enabledPlugins["load-lock-plugin@load-lock"] = false;
  writeJsonFile(settingsFile, s);
  const cc2 = harness(await setupJson(sb), "claude-code");
  assert.equal(cc2.rung, "loose");
  assert.ok(cc2.findings.some((f: string) => /installed but disabled/.test(f)));
  rmSync(sb.root, { recursive: true, force: true });
});

test("setup: hooks from a second (missing) copy are flagged as stale duplicates", async () => {
  const sb = sandbox();
  await install(sb, "codex");
  const hooksFile = join(sb.home, ".codex", "hooks.json");
  const h = JSON.parse(readFileSync(hooksFile, "utf8"));
  const gone = join(sb.root, "gone", "node_modules", "@aron98", "load-lock", "dist", "cli", "main.js");
  h.hooks.Stop.push({ hooks: [{ type: "command", command: `/usr/bin/node ${JSON.stringify(gone)} hook codex stop` }] });
  writeJsonFile(hooksFile, h);

  const cx = harness(await setupJson(sb), "codex");
  const hooks = cx.integrations.filter((i: any) => i.kind === "hooks");
  assert.equal(hooks.length, 2, "one hooks line per copy");
  const staleOne = hooks.find((i: any) => i.stale);
  assert.equal(staleOne.copy, resolve(gone, "..", "..", ".."));
  assert.equal(staleOne.owner, "installer");
  assert.ok(cx.findings.some((f: string) => f.startsWith("hooks from 2 different sources")), cx.findings.join("\n"));
  assert.ok(cx.findings.some((f: string) => f.startsWith("stale hooks entry")), cx.findings.join("\n"));
  rmSync(sb.root, { recursive: true, force: true });
});

test("setup: OpenCode plugin listed twice plus an MCP entry; ACE skill and skills-dir plugin are attributed", async () => {
  const sb = sandbox();
  await install(sb, "opencode");
  const cfgFile = join(sb.home, ".config", "opencode", "opencode.json");
  const cfg = JSON.parse(readFileSync(cfgFile, "utf8"));
  cfg.plugin = ["@aron98/load-lock@1.5.0"];
  cfg.mcp = { "load-lock": { type: "local", command: ["npx", "-y", "@aron98/load-lock@1.5.0", "mcp"] }, other: { type: "local", command: ["x"] } };
  writeJsonFile(cfgFile, cfg);

  // ACE-installed skill and Claude plugin (each with an .ace.json stamp)
  const skills = join(sb.home, ".claude", "skills");
  mkdirSync(join(skills, "load-lock"), { recursive: true });
  writeFileSync(join(skills, "load-lock", "SKILL.md"), "---\nname: load-lock\ndescription: x\n---\n# load-lock\n");
  writeFileSync(join(skills, "load-lock", ".ace.json"), "{}\n");
  writeJsonFile(join(skills, "load-lock-plugin", ".claude-plugin", "plugin.json"), { name: "load-lock-plugin" });
  writeFileSync(join(skills, "load-lock-plugin", ".ace.json"), "{}\n");

  const inv = await setupJson(sb);
  const oc = harness(inv, "opencode");
  assert.equal(oc.rung, "plugin");
  assert.equal(oc.integrations.filter((i: any) => i.kind === "plugin").length, 2);
  assert.equal(oc.integrations.filter((i: any) => i.kind === "mcp").length, 1, "only the load-lock MCP entry");
  assert.ok(oc.findings.some((f: string) => f.startsWith("plugin registered 2 times")), oc.findings.join("\n"));
  assert.ok(oc.findings.some((f: string) => f.startsWith("MCP registered 2 times")), oc.findings.join("\n"));

  const cc = harness(inv, "claude-code");
  assert.equal(cc.rung, "skill", "an ACE skills-dir plugin is not counted as an active plugin (unverified, #63)");
  assert.equal(cc.integrations.find((i: any) => i.kind === "skill").owner, "ace");
  assert.equal(cc.integrations.find((i: any) => i.kind === "plugin").owner, "ace");
  assert.ok(cc.findings.some((f: string) => /ACE skills-dir plugin/.test(f)));
  rmSync(sb.root, { recursive: true, force: true });
});

// ------------------------------------------------------------ converge (#59)

async function setupYes(sb: Sandbox): Promise<any> {
  const r = await runCli(sb, ["setup", "--yes", "--json", "--project", sb.project]);
  assert.equal(r.code, 0, `setup --yes failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

async function uninstall(sb: Sandbox, h: string): Promise<void> {
  const r = await runCli(sb, ["uninstall", "--harness", h, "--project", sb.project]);
  assert.equal(r.code, 0, `uninstall ${h} failed: ${r.stderr}`);
}

const steps = (out: any, h: string) => out.plan.steps.filter((s: any) => s.harness === h).map((s: any) => s.action);

test("setup converge: dry run is the default and writes nothing", async () => {
  const sb = sandbox();
  await install(sb, "codex");
  const hooksFile = join(sb.home, ".codex", "hooks.json");
  const h = JSON.parse(readFileSync(hooksFile, "utf8"));
  h.hooks.Stop.push({ hooks: [{ type: "command", command: `/usr/bin/node ${JSON.stringify(join(sb.root, "gone", "dist", "cli", "main.js"))} hook codex stop` }] });
  writeJsonFile(hooksFile, h);
  const before = snapshot(sb.root);

  const r = await runCli(sb, ["setup", "--project", sb.project]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /plan \(dry run, re-run with --yes to apply\)/);
  assert.match(r.stdout, /codex\s+install\s+load-lock install --harness codex/);
  const j = await setupOut(sb);
  assert.deepEqual(steps(j, "codex"), ["install"]);
  assert.deepEqual(snapshot(sb.root), before, "a dry run must not write anything");
  rmSync(sb.root, { recursive: true, force: true });
});

test("setup converge: Claude Code plugin + loose install -> loose removed (skill kept); install/uninstall reverse it", async () => {
  const sb = sandbox();
  const claudeDir = join(sb.home, ".claude");
  // the user's own config, including the plugin they enabled with /plugin
  writeJsonFile(join(sb.home, ".claude.json"), { mcpServers: { fetch: { type: "stdio", command: "uvx", args: ["mcp-server-fetch"] } } });
  writeJsonFile(join(claudeDir, "settings.json"), {
    theme: "dark",
    enabledPlugins: { "load-lock-plugin@load-lock": true },
    hooks: { Stop: [{ hooks: [{ type: "command", command: "/usr/local/bin/user-stop" }] }] },
  });
  writeFileSync(join(claudeDir, "CLAUDE.md"), "# My rules\n");
  // an ACE MCP patch the user merged into the project
  writeJsonFile(join(sb.project, ".mcp.json"), { servers: { "load-lock": { command: "npx", args: ["-y", "@aron98/load-lock@1.5.0", "mcp"] } } });
  const original = snapshot(sb.root);

  // with the plugin enabled, only --legacy writes the loose wiring (#62)
  await install(sb, "claude-code", "--legacy");
  const out = await setupYes(sb);
  assert.deepEqual(steps(out, "claude-code"), ["remove-loose", "manual"]);
  assert.match(out.plan.steps.find((s: any) => s.action === "manual").detail, /servers\.load-lock/);

  const cc = harness(out.inventory, "claude-code");
  assert.equal(cc.rung, "plugin");
  assert.deepEqual(
    cc.integrations.map((i: any) => `${i.kind}:${i.owner}`).sort(),
    ["mcp:other", "plugin:harness", "skill:installer"],
    "only the plugin, the skill and the foreign project entry remain",
  );
  assert.ok(!cc.findings.some((f: string) => f.startsWith("loose + plugin")));
  const s = JSON.parse(readFileSync(join(claudeDir, "settings.json"), "utf8"));
  assert.deepEqual(s.enabledPlugins, { "load-lock-plugin@load-lock": true }, "harness-owned plugin state untouched");
  assert.equal(readFileSync(join(sb.project, ".mcp.json"), "utf8"), original[join(sb.project, ".mcp.json")], "foreign entry untouched");

  // idempotent: a second run has only the manual step left
  assert.deepEqual(steps(await setupYes(sb), "claude-code"), ["manual"]);

  // reversible: install --legacy brings the loose wiring back ...
  await install(sb, "claude-code", "--legacy");
  assert.equal(harness(await setupJson(sb), "claude-code").integrations.filter((i: any) => i.owner === "installer").length, 4);
  // ... and uninstall restores the user's original bytes
  await uninstall(sb, "claude-code");
  assert.deepEqual(snapshot(sb.root), original);
  rmSync(sb.root, { recursive: true, force: true });
});

test("setup converge: codex with a second copy's hooks and a stale MCP block -> one current set; uninstall restores", async () => {
  const sb = sandbox();
  const codexDir = join(sb.home, ".codex");
  writeJsonFile(join(codexDir, "hooks.json"), { hooks: { Stop: [{ hooks: [{ type: "command", command: "/usr/local/bin/user-stop" }] }] } });
  mkdirSync(codexDir, { recursive: true });
  writeFileSync(join(codexDir, "config.toml"), 'model = "o3"\n');
  writeFileSync(join(codexDir, "AGENTS.md"), "# Mine\n");
  const original = snapshot(sb.root);

  await install(sb, "codex");
  const gone = join(sb.root, "gone", "node_modules", "@aron98", "load-lock");
  const hooksFile = join(codexDir, "hooks.json");
  const h = JSON.parse(readFileSync(hooksFile, "utf8"));
  h.hooks.Stop.push({ hooks: [{ type: "command", command: `/usr/bin/node ${JSON.stringify(join(gone, "dist", "cli", "main.js"))} hook codex stop` }] });
  writeJsonFile(hooksFile, h);
  const toml = join(codexDir, "config.toml");
  const mcpMain = join(repoRoot, "dist", "mcp", "main.js");
  writeFileSync(toml, readFileSync(toml, "utf8").replace(JSON.stringify(mcpMain), JSON.stringify(join(gone, "dist", "mcp", "main.js"))));
  assert.ok(harness(await setupJson(sb), "codex").findings.length >= 2, "messy state is flagged");

  const out = await setupYes(sb);
  assert.deepEqual(steps(out, "codex"), ["install"]);
  const cx = harness(out.inventory, "codex");
  assert.deepEqual(cx.findings, [], cx.findings.join("\n"));
  for (const i of cx.integrations.filter((x: any) => x.copy)) assert.equal(i.copy, repoRoot);
  assert.equal(cx.integrations.filter((i: any) => i.kind === "hooks").length, 1);
  assert.equal(readFileSync(toml, "utf8").split("[mcp_servers.load-lock]").length, 2, "exactly one MCP block");

  await uninstall(sb, "codex");
  assert.deepEqual(snapshot(sb.root), original);
  rmSync(sb.root, { recursive: true, force: true });
});

test("setup converge: MCP-only cline is upgraded to the installer's wiring; the foreign entry is left for the user", async () => {
  const sb = sandbox();
  const file = join(sb.home, ".cline", "data", "settings", "cline_mcp_settings.json");
  writeJsonFile(file, {
    mcpServers: {
      ll: { command: "npx", args: ["-y", "@aron98/load-lock@1.5.0", "mcp"] },
      fetch: { command: "uvx", args: ["mcp-server-fetch"] },
    },
  });
  const original = snapshot(sb.root);
  assert.equal(harness(await setupJson(sb), "cline").rung, "mcp");

  const out = await setupYes(sb);
  assert.deepEqual(steps(out, "cline"), ["install", "manual"]);
  assert.match(out.plan.steps.find((s: any) => s.action === "manual").detail, /remove mcpServers\.ll/);
  const cl = harness(out.inventory, "cline");
  assert.equal(cl.rung, "loose");
  assert.ok(cl.integrations.some((i: any) => i.detail === "mcpServers.ll"), "foreign entry untouched");

  await uninstall(sb, "cline");
  assert.deepEqual(snapshot(sb.root), original);
  rmSync(sb.root, { recursive: true, force: true });
});

test("setup converge: never overwrites a foreign entry in the installer's slot, an ACE skill, or from a cache copy", async () => {
  const sb = sandbox();
  writeJsonFile(join(sb.home, ".gemini", "settings.json"), {
    mcpServers: { "load-lock": { command: "npx", args: ["-y", "@aron98/load-lock@1.5.0", "mcp"] } },
  });
  const skill = join(sb.home, ".claude", "skills", "load-lock");
  mkdirSync(skill, { recursive: true });
  writeFileSync(join(skill, "SKILL.md"), "---\nname: load-lock\ndescription: x\n---\n");
  writeFileSync(join(skill, ".ace.json"), "{}\n");
  const before = snapshot(sb.root);

  const out = await setupYes(sb);
  assert.deepEqual(steps(out, "gemini-cli"), ["manual"]);
  assert.deepEqual(steps(out, "claude-code"), ["manual"]);
  assert.deepEqual(out.applied, []);
  assert.deepEqual(snapshot(sb.root), before);

  // a copy running from the npx cache never wires harnesses to itself
  const { inventory, planConverge } = await import("../cli/setup.js");
  writeJsonFile(join(sb.home, ".copilot", "mcp-config.json"), { mcpServers: { x: { command: "npx", args: ["@aron98/load-lock", "mcp"] } } });
  const inv = inventory({ project: sb.project, home: sb.home, env: sb.env });
  const plan = planConverge(inv, { selfCopy: "/c/_npx/abc/node_modules/@aron98/load-lock", selfEphemeral: true });
  const cp = plan.steps.filter((s) => s.harness === "copilot-cli");
  assert.deepEqual(cp.map((s) => s.action), ["manual"]);
  assert.match(cp[0].detail, /cache copy/);
  rmSync(sb.root, { recursive: true, force: true });
});
