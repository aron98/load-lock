/**
 * Session-derived agent identity (issue #49): the shared resolver
 * (override → harness session env → stable harness ancestor → fallback)
 * against planted /proc trees, plus the CLI default identity end to end:
 * same session → one id (op-key dedupe, `pending`), different sessions →
 * distinct ids.
 */
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sessionIdentity, harnessAncestor, readProc } from "../shared/identity.js";
import { startDaemon, runCli, type DaemonHandle } from "./testutil.js";

const TMP_BASE = process.env.LL_TEST_TMP ?? join(tmpdir(), "opencode");
mkdirSync(TMP_BASE, { recursive: true });

/** Plant /proc/<pid>/{stat,cmdline} entries: [pid, ppid, comm, startTime, argv]. */
function plantProc(rows: [number, number, string, number, string[]][]): string {
  const root = mkdtempSync(join(TMP_BASE, "ll-proc-"));
  for (const [pid, ppid, comm, start, argv] of rows) {
    mkdirSync(join(root, String(pid)));
    // Fields after comm: state ppid pgrp session tty tpgid flags minflt
    // cminflt majflt cmajflt utime stime cutime cstime priority nice
    // num_threads itrealvalue starttime ...
    const after = ["S", ppid, pid, pid, 0, -1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 20, 0, 1, 0, start, 1000, 10];
    writeFileSync(join(root, String(pid), "stat"), `${pid} (${comm}) ${after.join(" ")}\n`);
    writeFileSync(join(root, String(pid), "cmdline"), argv.join("\0") + "\0");
  }
  return root;
}

const tree = plantProc([
  [100, 1, "claude", 5000, ["claude"]],
  [110, 100, "bash", 5100, ["/bin/bash", "-c", "load-lock acquire"]],
  [111, 100, "bash", 5200, ["/bin/bash", "-c", "load-lock pending"]],
  // npx launcher between the harness and the CLI: node running npx-cli.js, then sh.
  [120, 110, "node", 5300, ["node", "/usr/lib/node_modules/npm/bin/npx-cli.js", "-y", "@aron98/load-lock"]],
  [121, 120, "sh", 5301, ["sh", "-c", "load-lock acquire"]],
  [200, 1, "codex", 6000, ["codex"]],
  [210, 200, "zsh", 6100, ["zsh", "-c", "load-lock acquire"]],
  // comm with spaces and parens must parse.
  [300, 1, "tmux: (server)", 7000, ["tmux"]],
  [310, 300, "fish", 7100, ["fish"]],
  // a shell chain that ends at init: no harness.
  [400, 1, "bash", 8000, ["bash"]],
]);

after(() => rmSync(tree, { recursive: true, force: true }));

const resolve = (startPid: number, env: NodeJS.ProcessEnv = {}, override?: string) =>
  sessionIdentity({ fallback: "cli:u@h", env, startPid, procRoot: tree, platform: "linux", override });

test("identity: two calls from the same harness session resolve to the same id", () => {
  const a = resolve(110);
  const b = resolve(111);
  assert.equal(a.source, "ancestor");
  assert.equal(a.id, "proc:100:5000");
  assert.equal(b.id, a.id);
  assert.equal(a.label, "claude:100");
  // npx/sh wrappers are walked past too.
  assert.equal(resolve(121).id, a.id);
});

test("identity: different harness sessions resolve to different ids", () => {
  assert.equal(resolve(210).id, "proc:200:6000");
  assert.notEqual(resolve(210).id, resolve(110).id);
  assert.equal(resolve(310).id, "proc:300:7000");
  assert.equal(readProc(300, tree)?.comm, "tmux: (server)");
});

test("identity: a reused pid with a new start time is a different session", () => {
  const reused = plantProc([[100, 1, "claude", 9999, ["claude"]], [110, 100, "bash", 10000, ["bash"]]]);
  try {
    const id = sessionIdentity({ fallback: "f", env: {}, startPid: 110, procRoot: reused, platform: "linux" }).id;
    assert.equal(id, "proc:100:9999");
    assert.notEqual(id, resolve(110).id);
  } finally {
    rmSync(reused, { recursive: true, force: true });
  }
});

test("identity: falls back when the walk reaches init, /proc is missing, or not on Linux", () => {
  assert.equal(harnessAncestor(400, tree), null);
  assert.deepEqual(resolve(400), { id: "cli:u@h", label: "cli:u@h", source: "fallback" });
  assert.equal(resolve(99999).source, "fallback");
  const mac = sessionIdentity({ fallback: "cli:u@h", env: {}, startPid: 110, procRoot: tree, platform: "darwin" });
  assert.equal(mac.source, "fallback");
});

test("identity: harness session env vars beat the ancestor walk", () => {
  const cc = resolve(110, { CLAUDE_CODE_SESSION_ID: "ee690007-78c4-48d0-8f80-77b74e95a7fd" });
  assert.deepEqual(cc, {
    id: "claude-code:ee690007-78c4-48d0-8f80-77b74e95a7fd",
    label: "claude-code:ee690007",
    source: "harness-env",
  });
  // OpenCode: the bare sessionID, i.e. the native plugin's agentId.
  assert.equal(resolve(110, { OPENCODE_SESSION_ID: "ses_abc123" }).id, "ses_abc123");
});

test("identity: overrides still win (explicit > LOAD_LOCK_AGENT > harness env)", () => {
  const env = { LOAD_LOCK_AGENT: "pinned", CLAUDE_CODE_SESSION_ID: "s1" };
  assert.equal(resolve(110, env).id, "pinned");
  assert.equal(resolve(110, env).source, "env");
  assert.equal(resolve(110, env, " explicit ").id, "explicit");
  assert.equal(resolve(110, { LOAD_LOCK_AGENT: "  " }).source, "ancestor", "blank override ignored");
});

// ------------------------------------------------------------ CLI end to end

let d: DaemonHandle;

before(async () => {
  d = await startDaemon();
  // The test runner itself may be running inside a harness session.
  for (const k of ["LOAD_LOCK_AGENT", "CLAUDE_CODE_SESSION_ID", "OPENCODE_SESSION_ID"]) delete d.env[k];
});

after(async () => {
  await d.stop();
});

function cliIn(env: Record<string, string>, args: string[]) {
  return runCli({ ...d, env: { ...d.env, ...env } }, args);
}

async function acquireJson(env: Record<string, string>, opKey: string, extra: string[] = []) {
  const r = await cliIn(env, ["acquire", "--op-key", opKey, "--reason", "identity test", "--json", ...extra]);
  assert.ok(r.code === 0 || r.code === 68, r.stderr); // 68 = queued
  return JSON.parse(r.stdout);
}

test("cli: same session shares one identity; different sessions get distinct ids", async () => {
  const a1 = await acquireJson({ CLAUDE_CODE_SESSION_ID: "aaaaaaaa-1" }, "op/shared");
  const a2 = await acquireJson({ CLAUDE_CODE_SESSION_ID: "aaaaaaaa-1" }, "op/shared");
  const b = await acquireJson({ CLAUDE_CODE_SESSION_ID: "bbbbbbbb-2" }, "op/shared");
  assert.equal(a1.entry.agentId, "claude-code:aaaaaaaa-1");
  assert.equal(a1.entry.agentLabel, "claude-code:aaaaaaaa", "short readable label");
  assert.equal(a2.entry.requestId, a1.entry.requestId, "same session: op-key dedupe returns the existing request");
  assert.equal(b.entry.agentId, "claude-code:bbbbbbbb-2");
  assert.notEqual(b.entry.requestId, a1.entry.requestId, "different sessions are not merged");

  // Fill the pool so the next requests queue, then check `pending` isolation.
  const status = JSON.parse((await cliIn({}, ["status", "--json"])).stdout);
  const cap = status.config.pools.heavy.capacity as number;
  for (let i = 2; i < cap; i++) await acquireJson({ CLAUDE_CODE_SESSION_ID: "filler" }, `op/fill-${i}`);
  const qa = await acquireJson({ CLAUDE_CODE_SESSION_ID: "aaaaaaaa-1" }, "op/queued");
  assert.equal(qa.state, "queued");
  const pa = JSON.parse((await cliIn({ CLAUDE_CODE_SESSION_ID: "aaaaaaaa-1" }, ["pending", "--json"])).stdout);
  const pb = JSON.parse((await cliIn({ CLAUDE_CODE_SESSION_ID: "bbbbbbbb-2" }, ["pending", "--json"])).stdout);
  assert.ok(JSON.stringify(pa).includes(qa.entry.requestId), "own queue entry visible");
  assert.ok(!JSON.stringify(pb).includes(qa.entry.requestId), "other session does not see it");
});

test("cli: without session env, calls from one parent process share an ancestor identity", async () => {
  if (process.platform !== "linux") return;
  const r1 = await acquireJson({}, "op/ancestor");
  const r2 = await acquireJson({}, "op/ancestor");
  // The CLI's parent is this test process (node, not a wrapper).
  const start = readFileSync(`/proc/${process.pid}/stat`, "utf8").split(") ")[1].split(" ")[19];
  assert.equal(r1.entry.agentId, `proc:${process.pid}:${start}`);
  assert.equal(r2.entry.requestId, r1.entry.requestId);
});

test("cli: --agent and LOAD_LOCK_AGENT overrides still win", async () => {
  const env = await acquireJson({ LOAD_LOCK_AGENT: "pinned-agent", CLAUDE_CODE_SESSION_ID: "aaaaaaaa-1" }, "op/override");
  assert.equal(env.entry.agentId, "pinned-agent");
  assert.equal(env.entry.agentLabel, undefined, "explicit ids label themselves");
  const flag = await acquireJson({ CLAUDE_CODE_SESSION_ID: "aaaaaaaa-1" }, "op/override", ["--agent", "flag-agent"]);
  assert.equal(flag.entry.agentId, "flag-agent");
});
