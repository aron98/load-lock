/**
 * Claude Code plugin contract tests (issue #61): the manifest, hooks file
 * and root marketplace.json under plugins/claude-code, checked against the
 * documented plugin format and ACE's import rules (#64), plus the hook and
 * MCP commands run exactly the way the plugin runs them (through the
 * launcher, against this checkout's dist/ on an isolated daemon).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { cliMainPath, startDaemon } from "./testutil.js";
import { POLICY_BRIEF } from "../policy/text.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const PLUGIN_ROOT = join(REPO_ROOT, "plugins", "claude-code");
const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));
const manifest = readJson(join(PLUGIN_ROOT, ".claude-plugin", "plugin.json"));
const hooksFile = readJson(join(PLUGIN_ROOT, "hooks", "hooks.json"));
const marketplace = readJson(join(REPO_ROOT, ".claude-plugin", "marketplace.json"));
const PKG_VERSION: string = readJson(join(REPO_ROOT, "package.json")).version;

const ROOT_VAR = "${CLAUDE_PLUGIN_ROOT}";
const LAUNCHER_ARG = `${ROOT_VAR}/scripts/load-lock.mjs`;
/** ACE plugin_hooks_command_safe (#64): no shell metacharacters. */
const ACE_UNSAFE = /[;&|`]|\$\(/;

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? filesUnder(p) : [relative(PLUGIN_ROOT, p).split(sep).join("/")];
  });
}

/** Every hook handler as [event, handler]. */
function handlers(): [string, any][] {
  return Object.entries(hooksFile.hooks as Record<string, any[]>).flatMap(([ev, groups]) =>
    groups.flatMap((g) => (g.hooks as any[]).map((h): [string, any] => [ev, h])),
  );
}

test("plugin.json: name, version pin, MCP server through the launcher, no secrets", () => {
  assert.equal(manifest.name, "load-lock-plugin", "must differ from the skill's name (ACE install-dir clash, #64)");
  assert.match(manifest.name, /^[a-z0-9]+(-[a-z0-9]+)*$/);
  assert.equal(manifest.version, PKG_VERSION);
  assert.equal(manifest.userConfig, undefined);
  assert.equal(manifest.skills, undefined, "no skill in the plugin (#61)");
  assert.deepEqual(Object.keys(manifest.mcpServers), ["load-lock"]);
  const mcp = manifest.mcpServers["load-lock"];
  assert.equal(mcp.command, "node");
  assert.deepEqual(mcp.args, [LAUNCHER_ARG, "--bin", "load-lock-mcp"]);
  assert.equal(mcp.env, undefined);
  assert.equal(mcp.headers, undefined);
});

test("hooks.json: SessionStart policy + async await-offer watcher, Stop wakeup, exec form via the launcher", () => {
  const got = handlers().map(([ev, h]) => [ev, h.args.slice(1).join(" "), Boolean(h.async), Boolean(h.asyncRewake)]);
  assert.deepEqual(got, [
    ["SessionStart", "hook claude-code session-start", false, false],
    ["SessionStart", "hook claude-code await-offer", true, true],
    ["Stop", "hook claude-code stop", false, false],
  ]);
  for (const [, h] of handlers()) {
    assert.equal(h.type, "command");
    assert.equal(h.command, "node");
    assert.equal(h.args[0], LAUNCHER_ARG);
    for (const s of [h.command, ...h.args]) assert.doesNotMatch(s, ACE_UNSAFE);
    assert.ok(Number.isInteger(h.timeout) && h.timeout > 0);
  }
  // asyncRewake hooks keep their timeout: leave room for the watcher's own 10 min bound.
  const watcher = handlers().find(([, h]) => h.asyncRewake)![1];
  assert.ok(watcher.timeout * 1000 > 10 * 60_000);
});

test("plugin folder: paths resolve inside it, ACE layout only, no SKILL.md or package.json", () => {
  const launcher = LAUNCHER_ARG.replace(ROOT_VAR, PLUGIN_ROOT);
  assert.ok(existsSync(launcher));
  assert.ok(resolve(launcher).startsWith(PLUGIN_ROOT + sep));
  const allowedDirs = ["skills", "commands", "agents", "hooks", "monitors", "themes", "output-styles", "bin", "scripts", ".claude-plugin"];
  const allowedRoot = [".mcp.json", ".lsp.json", "settings.json", "README.md", "LICENSE", "CHANGELOG.md"];
  for (const f of filesUnder(PLUGIN_ROOT)) {
    assert.ok(allowedRoot.includes(f) || allowedDirs.includes(f.split("/")[0]), `unexpected file for ACE: ${f}`);
    assert.notEqual(f.split("/").pop(), "SKILL.md");
    assert.notEqual(f.split("/").pop(), "package.json");
  }
  // bin/ would land on the Bash tool's PATH and keeps a plugin off claude.ai; the launcher is not a CLI.
  assert.ok(!existsSync(join(PLUGIN_ROOT, "bin")));
});

test("marketplace.json: the root marketplace lists the plugin subfolder", () => {
  assert.equal(marketplace.name, "load-lock");
  assert.ok(marketplace.owner?.name);
  assert.equal(marketplace.plugins.length, 1);
  const entry = marketplace.plugins[0];
  assert.equal(entry.name, manifest.name);
  assert.equal(entry.source, "./plugins/claude-code");
  assert.equal(resolve(REPO_ROOT, entry.source), PLUGIN_ROOT);
  assert.equal(entry.version, undefined, "plugin.json is the version authority");
  for (const k of ["commands", "agents", "skills", "hooks", "mcpServers", "strict"]) assert.equal(entry[k], undefined, k);
});

test("plugin commands run as the plugin runs them (launcher -> PATH copy of this checkout)", async () => {
  const d = await startDaemon();
  const tmp = mkdtempSync(join(process.env.LL_TEST_TMP ?? tmpdir(), "ll-plug-"));
  try {
    const bin = join(tmp, "bin");
    mkdirSync(bin);
    symlinkSync(cliMainPath, join(bin, "load-lock"));
    const env: Record<string, string> = { ...d.env, PATH: bin, LOAD_LOCK_LAUNCHER_DEBUG: "1" };
    for (const k of ["LOAD_LOCK_AGENT", "CLAUDE_CODE_SESSION_ID", "OPENCODE_SESSION_ID"]) delete env[k];
    const sub = (args: string[]) => args.map((a) => a.replace(ROOT_VAR, PLUGIN_ROOT));
    const hook = (event: string) => handlers().find(([, h]) => h.args.at(-1) === event)![1];

    const start = hook("session-start");
    const s = spawnSync(start.command === "node" ? process.execPath : start.command, sub(start.args), {
      env,
      input: JSON.stringify({ session_id: "plug-1", cwd: tmp, source: "startup", hook_event_name: "SessionStart" }),
      encoding: "utf8",
    });
    assert.equal(s.status, 0, s.stderr);
    assert.ok(s.stdout.startsWith(POLICY_BRIEF), s.stdout);
    assert.match(s.stdout, /load-lock now: pool "heavy"/);
    assert.match(s.stderr, /launcher: path /);

    const stop = hook("stop");
    const t = spawnSync(process.execPath, sub(stop.args), {
      env,
      input: JSON.stringify({ session_id: "plug-1", cwd: tmp, hook_event_name: "Stop" }),
      encoding: "utf8",
    });
    assert.equal(t.status, 0, t.stderr);
    assert.equal(t.stdout, "", "no offer, no continuation");

    const mcp = manifest.mcpServers["load-lock"];
    const transport = new StdioClientTransport({ command: process.execPath, args: sub(mcp.args), env, stderr: "ignore" });
    const client = new Client({ name: "plugin-test", version: "0.0.0" }, { capabilities: {} });
    await client.connect(transport);
    try {
      const names = (await client.listTools()).tools.map((x) => x.name);
      for (const n of ["acquire", "claim", "pending", "agent_guide"]) assert.ok(names.includes(n), n);
    } finally {
      await client.close();
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    await d.stop();
  }
});
