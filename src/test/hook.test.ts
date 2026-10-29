/**
 * Hook contract tests: `load-lock hook <harness> <event>` invoked exactly the
 * way Claude Code / Codex invoke hooks (harness JSON on stdin), against a real
 * daemon with real offers outstanding.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon, runCli, delay, cliMainPath, type DaemonHandle } from "./testutil.js";

const POLICY_MARK = "# load-lock: machine-wide heavy-work budget";

// Same override as daemon.test.ts / testutil.ts: never touch the user's
// real state dir; LL_TEST_TMP redirects where scratch dirs are created.
const TMP_BASE = process.env.LL_TEST_TMP ?? join(tmpdir(), "opencode");

function runHook(d: DaemonHandle, args: string[], input?: Record<string, unknown>, env?: Record<string, string>) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [cliMainPath, "hook", ...args], {
      env: { ...d.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (b) => (stdout += b));
    child.stderr!.on("data", (b) => (stderr += b));
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
    child.on("error", reject);
    child.stdin.end(input === undefined ? "" : JSON.stringify(input));
  });
}

/** Set up: A holds, B queued with cwd; release A so B has an outstanding offer. */
async function outstandingOffer(d: DaemonHandle, cwd: string) {
  const c = d.client();
  await c.connect();
  await c.request("acquire", { agentId: "hook-holder", opKey: "h1", reason: "holding" });
  await c.request("acquire", { agentId: "hook-waiter", opKey: "w1", reason: "waiting", cwd });
  const rel = (await c.request("release", { permitToken: (await c.request("pending", { agentId: "hook-holder" })).held[0].permitToken })) as any;
  const offers = (await c.request("offers_for_cwd", { cwd })) as any;
  c.close();
  return offers.offers[0];
}

test("hooks: session-start events print the policy brief + machine state", async () => {
  const d = await startDaemon();
  try {
    for (const ev of [
      ["claude-code", "session-start"],
      ["codex", "session-start"],
      ["codex", "subagent-start"],
    ]) {
      const r = await runHook(d, ev, { session_id: "s1", cwd: "/tmp", source: "startup" });
      assert.equal(r.code, 0, `${ev.join("/")} exits 0`);
      assert.ok(r.stdout.startsWith(POLICY_MARK), `${ev.join("/")} emits the policy brief as stdout context`);
      assert.ok(r.stdout.includes("effective core"), "includes machine awareness line");
      assert.equal(r.stderr, "");
    }
  } finally {
    await d.stop();
  }
});

test("hooks: claude-code stop with a matching offer -> decision block carrying the offer token", async () => {
  const d = await startDaemon();
  try {
    const cwd = mkdtempSync(join(TMP_BASE, "ll-hook-wt-"));
    const offer = await outstandingOffer(d, cwd);
    assert.ok(offer?.offerToken, "waiter has an outstanding offer");

    const r = await runHook(d, ["claude-code", "stop"], { session_id: "s1", cwd });
    assert.equal(r.code, 0);
    const out = JSON.parse(r.stdout);
    assert.equal(out.decision, "block", "Stop hook continues the session");
    assert.ok(out.reason.includes(offer.offerToken), "reason tells the agent which offer_token to claim");
    assert.ok(out.reason.includes("claim"), "reason instructs claiming");
    assert.ok(out.reason.includes(offer.opKey));
    // issue #55: tool names differ per wiring (loose MCP vs plugin-bundled)
    assert.ok(out.reason.includes("load-lock claim tool"), "reason names the claim tool neutrally");
    assert.ok(!out.reason.includes("mcp__"), "reason hard-codes no MCP tool prefix");

    // stop_hook_active: never loop
    const quiet = await runHook(d, ["claude-code", "stop"], { session_id: "s1", cwd, stop_hook_active: true });
    assert.equal(quiet.code, 0);
    assert.equal(quiet.stdout, "", "already-continued stops are silent");

    // no matching offers -> silent
    const none = await runHook(d, ["claude-code", "stop"], { session_id: "s1", cwd: "/definitely/not/a/worktree" });
    assert.equal(none.stdout, "");
  } finally {
    await d.stop();
  }
});

test("hooks: codex stop behaves the same (decision block JSON)", async () => {
  const d = await startDaemon();
  try {
    const cwd = mkdtempSync(join(TMP_BASE, "ll-hook-wt-"));
    const offer = await outstandingOffer(d, cwd);
    assert.ok(offer?.offerToken);
    const r = await runHook(d, ["codex", "stop"], { session_id: "s1", cwd, stop_hook_active: false });
    const out = JSON.parse(r.stdout);
    assert.equal(out.decision, "block");
    assert.ok(out.reason.includes(offer.offerToken));
  } finally {
    await d.stop();
  }
});

test("hooks: cursor stop with a matching offer -> followup_message carrying the offer token", async () => {
  const d = await startDaemon();
  try {
    const cwd = mkdtempSync(join(TMP_BASE, "ll-hook-wt-"));
    const offer = await outstandingOffer(d, cwd);
    assert.ok(offer?.offerToken, "waiter has an outstanding offer");

    // Cursor hooks v1 input: workspace_roots (no cwd), loop_count, status.
    const r = await runHook(d, ["cursor", "stop"], {
      conversation_id: "c1",
      hook_event_name: "stop",
      workspace_roots: [cwd],
      loop_count: 0,
      status: "completed",
    });
    assert.equal(r.code, 0);
    const out = JSON.parse(r.stdout);
    assert.equal(typeof out.followup_message, "string", "Cursor Stop continues via followup_message");
    assert.ok(out.followup_message.includes(offer.offerToken), "message tells the agent which offer_token to claim");
    assert.ok(out.followup_message.includes("claim"), "message instructs claiming");
    assert.ok(out.followup_message.includes(offer.opKey));
    assert.ok(!out.followup_message.includes("mcp__"), "message hard-codes no MCP tool prefix");
    assert.equal(out.decision, undefined, "Cursor does not use the Claude/Codex decision shape");

    // loop_count > 0: never chain followups (Cursor's loop guard)
    const quiet = await runHook(d, ["cursor", "stop"], {
      conversation_id: "c1",
      workspace_roots: [cwd],
      loop_count: 1,
      status: "completed",
    });
    assert.equal(quiet.code, 0);
    assert.equal(quiet.stdout, "", "already-continued stops are silent");

    // workspace_roots elsewhere -> silent
    const none = await runHook(d, ["cursor", "stop"], {
      conversation_id: "c1",
      workspace_roots: ["/definitely/not/a/worktree"],
      loop_count: 0,
      status: "completed",
    });
    assert.equal(none.stdout, "");

    // empty stdin (missing/blank payload) must not break the hook
    const blank = await runHook(d, ["cursor", "stop"]);
    assert.equal(blank.code, 0);
    assert.equal(blank.stdout, "");
  } finally {
    await d.stop();
  }
});

test("hooks: claude-code await-offer wakes (exit 2 + stderr, no token leak) on offer", async () => {
  const d = await startDaemon();
  try {
    const cwd = mkdtempSync(join(TMP_BASE, "ll-hook-wt-"));
    const c = d.client();
    await c.connect();
    // holder + waiter, offer NOT yet delivered
    await c.request("acquire", { agentId: "hook-holder2", opKey: "h2", reason: "holding" });
    await c.request("acquire", { agentId: "hook-waiter2", opKey: "w2", reason: "waiting", cwd });

    const awaiting = runHook(d, ["claude-code", "await-offer"], { session_id: "s1", cwd }, { LOAD_LOCK_AWAIT_MS: "8000" });
    await delay(400);
    // release the holder -> offer created for the waiter in `cwd`
    const held = (await c.request("pending", { agentId: "hook-holder2" })) as any;
    await c.request("release", { permitToken: held.held[0].permitToken });
    const r = await awaiting;

    assert.equal(r.code, 2, "asyncRewake contract: exit code 2 wakes Claude");
    assert.ok(r.stderr.includes("claim"), "stderr explains how to claim");
    assert.ok(r.stderr.includes("load-lock claim tool"), "stderr names the claim tool neutrally");
    assert.ok(!r.stderr.includes("mcp__"), "stderr hard-codes no MCP tool prefix");
    assert.ok(!r.stderr.includes("off_"), "the offer token itself is NOT in stderr (session must claim via pending)");
    assert.equal(r.stdout, "");

    // timeout path: no offer in window -> exit 0, silent
    const t = await runHook(d, ["claude-code", "await-offer"], { session_id: "s1", cwd: "/nowhere" }, { LOAD_LOCK_AWAIT_MS: "500" });
    assert.equal(t.code, 0);
    assert.equal(t.stderr, "");
  } finally {
    await d.stop();
  }
});

// ------------------------------------------------------------ dedupe (#54)
// Duplicate wiring (loose hooks + plugin, two plugins) fires every hook
// twice with the same stdin. The daemon's hook_once lets exactly one act.

test("dedupe: duplicate session-start hooks inject the policy once per firing", async () => {
  const d = await startDaemon();
  try {
    for (const ev of [
      ["claude-code", "session-start"],
      ["codex", "session-start"],
      ["codex", "subagent-start"],
    ]) {
      const input = { session_id: `dup-${ev.join("-")}`, cwd: "/tmp", source: "startup" };
      const rs = await Promise.all([runHook(d, ev, input), runHook(d, ev, input)]);
      assert.deepEqual(rs.map((r) => r.code), [0, 0]);
      assert.equal(rs.filter((r) => r.stdout.startsWith(POLICY_MARK)).length, 1, `${ev.join("/")}: exactly one injection`);
      assert.equal(rs.filter((r) => r.stdout === "").length, 1, "the duplicate is silent");

      // a later compaction is a new occurrence -> injected again
      const again = await runHook(d, ev, { ...input, source: "compact" });
      assert.ok(again.stdout.startsWith(POLICY_MARK), "compact re-injects");
      // other sessions are independent
      const other = await runHook(d, ev, { ...input, session_id: `${input.session_id}-other` });
      assert.ok(other.stdout.startsWith(POLICY_MARK));
    }
    // no session id -> no dedupe possible, both act (today's behaviour)
    const rs = await Promise.all([
      runHook(d, ["claude-code", "session-start"], { cwd: "/tmp" }),
      runHook(d, ["claude-code", "session-start"], { cwd: "/tmp" }),
    ]);
    assert.ok(rs.every((r) => r.stdout.startsWith(POLICY_MARK)));
  } finally {
    await d.stop();
  }
});

test("dedupe: duplicate stop hooks deliver one continuation (claude-code, codex, cursor)", async () => {
  for (const [harness, input, field] of [
    ["claude-code", (cwd: string) => ({ session_id: "dup-s", cwd }), "reason"],
    ["codex", (cwd: string) => ({ session_id: "dup-s", cwd, stop_hook_active: false }), "reason"],
    ["cursor", (cwd: string) => ({ conversation_id: "dup-c", workspace_roots: [cwd], loop_count: 0 }), "followup_message"],
  ] as const) {
    const d = await startDaemon();
    try {
      const cwd = mkdtempSync(join(TMP_BASE, "ll-hook-wt-"));
      const offer = await outstandingOffer(d, cwd);
      const rs = await Promise.all([runHook(d, [harness, "stop"], input(cwd)), runHook(d, [harness, "stop"], input(cwd))]);
      assert.deepEqual(rs.map((r) => r.code), [0, 0]);
      const delivered = rs.filter((r) => r.stdout !== "");
      assert.equal(delivered.length, 1, `${harness}: exactly one continuation`);
      assert.ok(JSON.parse(delivered[0].stdout)[field].includes(offer.offerToken));
    } finally {
      await d.stop();
    }
  }
});

test("dedupe: duplicate await-offer watchers -> one live watcher; key freed when it exits", async () => {
  const d = await startDaemon();
  try {
    const cwd = mkdtempSync(join(TMP_BASE, "ll-hook-wt-"));
    const c = d.client();
    await c.connect();
    await c.request("acquire", { agentId: "dup-holder", opKey: "h", reason: "holding" });
    await c.request("acquire", { agentId: "dup-waiter", opKey: "w", reason: "waiting", cwd });

    const env = { LOAD_LOCK_AWAIT_MS: "8000" };
    const a = runHook(d, ["claude-code", "await-offer"], { session_id: "dup-w", cwd }, env);
    const b = runHook(d, ["claude-code", "await-offer"], { session_id: "dup-w", cwd }, env);
    // the loser exits at once, silently, while the winner keeps watching
    const loser = await Promise.race([a, b]);
    assert.equal(loser.code, 0);
    assert.equal(loser.stderr, "");

    const held = (await c.request("pending", { agentId: "dup-holder" })) as any;
    await c.request("release", { permitToken: held.held[0].permitToken });
    const rs = await Promise.all([a, b]);
    assert.deepEqual(rs.map((r) => r.code).sort(), [0, 2], "exactly one watcher woke the session");

    // the winner exited -> its connection closed -> the key is free again
    const next = await runHook(d, ["claude-code", "await-offer"], { session_id: "dup-w", cwd: "/nowhere" }, { LOAD_LOCK_AWAIT_MS: "600" });
    assert.equal(next.code, 0);
    const r = (await c.request("hook_once", { harness: "claude-code", sessionId: "dup-w", event: "await-offer", hold: true })) as any;
    assert.equal(r.first, true, "no stale hold after the watchers are gone");
    c.close();
  } finally {
    await d.stop();
  }
});

test("dedupe: hook_once TTL keys expire; params are validated", async () => {
  const d = await startDaemon();
  try {
    const c = d.client();
    await c.connect();
    const k = { harness: "codex", sessionId: "ttl", event: "stop", occurrence: "o1", ttlMs: 1000 };
    assert.equal(((await c.request("hook_once", k)) as any).first, true);
    assert.equal(((await c.request("hook_once", k)) as any).first, false);
    assert.equal(((await c.request("hook_once", { ...k, occurrence: "o2" })) as any).first, true, "occurrence is part of the key");
    await delay(1100);
    assert.equal(((await c.request("hook_once", k)) as any).first, true, "expired keys can be claimed again");
    await assert.rejects(c.request("hook_once", { harness: "codex", event: "stop" }), /sessionId/);
    c.close();
  } finally {
    await d.stop();
  }
});

/**
 * A daemon predating hook_once: answers `unknown method` for it, serves one
 * cwd-matched offer and pushes one `offered` event to watchers.
 */
async function oldDaemon(cwd: string) {
  const dir = mkdtempSync(join(TMP_BASE, "ll-old-daemon-"));
  const sock = join(dir, "daemon.sock");
  const entry = { requestId: "req_old", pool: "heavy", opKey: "w", reason: "waiting", cwd, offerToken: "off_old", offerExpiresAt: Date.now() + 30_000 };
  const seen: string[] = [];
  const server = createServer((s: Socket) => {
    let buf = "";
    s.on("error", () => s.destroy());
    s.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let idx: number;
      while ((idx = buf.indexOf("\n")) !== -1) {
        const msg = JSON.parse(buf.slice(0, idx));
        buf = buf.slice(idx + 1);
        seen.push(msg.method);
        const reply = (o: unknown) => s.write(JSON.stringify(o) + "\n");
        if (msg.method === "offers_for_cwd") reply({ id: msg.id, ok: true, result: { offers: [entry] } });
        else if (msg.method === "watch") {
          reply({ id: msg.id, ok: true, result: { ok: true } });
          setTimeout(() => reply({ event: true, type: "offered", entry }), 300);
        } else reply({ id: msg.id, ok: false, error: { code: "invalid", message: `unknown method "${msg.method}"` } });
      }
    });
  });
  await new Promise<void>((r) => server.listen(sock, r));
  const env = { ...process.env, LOAD_LOCK_STATE_DIR: dir, LOAD_LOCK_SOCKET: sock, LOAD_LOCK_NO_SPAWN: "1" } as Record<string, string>;
  return {
    handle: { env } as unknown as DaemonHandle,
    seen,
    close: () => {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("dedupe fallback: a daemon without hook_once -> every hook acts as before", async () => {
  const cwd = mkdtempSync(join(TMP_BASE, "ll-hook-wt-"));
  const old = await oldDaemon(cwd);
  try {
    const d = old.handle;
    const two = (args: string[], input: Record<string, unknown>, env?: Record<string, string>) =>
      Promise.all([runHook(d, args, input, env), runHook(d, args, input, env)]);

    for (const r of await two(["claude-code", "session-start"], { session_id: "old", cwd, source: "startup" })) {
      assert.ok(r.stdout.startsWith(POLICY_MARK), "both inject (no dedupe available)");
    }
    for (const h of ["claude-code", "codex"]) {
      for (const r of await two([h, "stop"], { session_id: "old", cwd })) {
        assert.equal(JSON.parse(r.stdout).decision, "block", `${h} stop still delivers`);
      }
    }
    for (const r of await two(["cursor", "stop"], { conversation_id: "old", workspace_roots: [cwd], loop_count: 0 })) {
      assert.ok(JSON.parse(r.stdout).followup_message.includes("off_old"));
    }
    for (const r of await two(["claude-code", "await-offer"], { session_id: "old", cwd }, { LOAD_LOCK_AWAIT_MS: "5000" })) {
      assert.equal(r.code, 2, "both watchers still wake");
    }
    assert.ok(old.seen.includes("hook_once"), "the hooks did try the new method");
  } finally {
    old.close();
  }
});
