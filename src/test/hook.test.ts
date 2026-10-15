/**
 * Hook contract tests: `load-lock hook <harness> <event>` invoked exactly the
 * way Claude Code / Codex invoke hooks (harness JSON on stdin), against a real
 * daemon with real offers outstanding.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon, runCli, delay, cliMainPath, type DaemonHandle } from "./testutil.js";

const POLICY_MARK = "# load-lock: machine-wide heavy-work budget";

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
    const cwd = mkdtempSync(join(tmpdir(), "opencode", "ll-hook-wt-"));
    const offer = await outstandingOffer(d, cwd);
    assert.ok(offer?.offerToken, "waiter has an outstanding offer");

    const r = await runHook(d, ["claude-code", "stop"], { session_id: "s1", cwd });
    assert.equal(r.code, 0);
    const out = JSON.parse(r.stdout);
    assert.equal(out.decision, "block", "Stop hook continues the session");
    assert.ok(out.reason.includes(offer.offerToken), "reason tells the agent which offer_token to claim");
    assert.ok(out.reason.includes("claim"), "reason instructs claiming");
    assert.ok(out.reason.includes(offer.opKey));

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
    const cwd = mkdtempSync(join(tmpdir(), "opencode", "ll-hook-wt-"));
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

test("hooks: claude-code await-offer wakes (exit 2 + stderr, no token leak) on offer", async () => {
  const d = await startDaemon();
  try {
    const cwd = mkdtempSync(join(tmpdir(), "opencode", "ll-hook-wt-"));
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
