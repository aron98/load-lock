/**
 * Integration tests for wait_for_turn (issue #11): a REAL daemon process over
 * a real Unix socket with multiple independent client connections. Exercises
 * the shared client-side bounded wait (src/shared/wait-turn.ts) that serves
 * the CLI `wait` command, the MCP wait_for_turn tool and the OpenCode plugin
 * tool: FIFO wakeup with auto-claim, structured timeout, paused/rejoin,
 * mid-wait cancellation, bounded resolution across a daemon restart, and
 * clean AbortSignal cancellation with no orphaned waiter.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { LLClient } from "../shared/client.js";
import { waitForTurn, WaitAbortedError } from "../shared/wait-turn.js";
import { startDaemon, delay, until, probe, daemonMainPath, type DaemonHandle } from "./testutil.js";

const ACQ = (agentId: string, opKey: string, extra: Record<string, unknown> = {}) => ({
  agentId,
  opKey,
  reason: "integration test",
  ...extra,
});

/** Start a wait that is expected to stay pending for at least `ms`. */
function expectPending(ms: number): Promise<"pending" | "done"> {
  return delay(ms).then(() => "pending" as const);
}

test("wait_for_turn: sleeper wakes granted with an auto-claimed permit after the holder releases (FIFO preserved)", async () => {
  const d = await startDaemon();
  const clients: LLClient[] = [];
  try {
    const cA = d.client();
    await cA.connect();
    clients.push(cA);
    await cA.request("configure", {
      expectedVersion: 1,
      changes: { offerTimeoutMs: 60_000, maxWaitMs: 0 },
      reason: "test timings",
      author: "test",
    });

    const a = (await cA.request("acquire", ACQ("agentA", "opA"))) as any;
    assert.equal(a.state, "granted");
    const cB = d.client();
    const cC = d.client();
    await cB.connect();
    await cC.connect();
    clients.push(cB, cC);
    const b = (await cB.request("acquire", ACQ("agentB", "opB"))) as any;
    assert.equal(b.state, "queued");
    assert.equal(b.entry.position, 1);
    const c = (await cC.request("acquire", ACQ("agentC", "opC"))) as any;
    assert.equal(c.state, "queued");
    assert.equal(c.entry.position, 2);

    // B sleeps (no request_id: default target resolution must pick the queued one).
    const waitB = waitForTurn({ client: cB, agentId: "agentB", timeoutMs: 15_000 });
    const early = await Promise.race([waitB.then(() => "done"), expectPending(400)]);
    assert.equal(early, "pending", "the wait blocks while the holder keeps the permit");

    const st = (await cA.request("status", {})) as any;
    assert.equal(st.pools[0].used, 1, "the sleeping wait holds no capacity");

    // The holder finishes; B must wake already holding a claimed permit.
    await cA.request("release", { permitToken: a.entry.permitToken });
    const rB = await waitB;
    assert.equal(rB.state, "granted");
    assert.equal(rB.autoClaimed, true, "the offer was auto-claimed inside the claim window");
    assert.ok(rB.entry?.permitToken, "granted result carries the permit token");
    assert.ok((rB.entry as any).offerToken === undefined || !(rB.entry as any).offerToken, "claimed permit has no lingering offer token");
    assert.ok(rB.waitedMs >= 300);

    // FIFO: C is still queued behind B's claimed permit, and goes next.
    const pendC = (await cC.request("pending", { agentId: "agentC" })) as any;
    assert.equal(pendC.queue.length, 1);
    assert.equal(pendC.queue[0].position, 1);

    await cB.request("release", { permitToken: rB.entry!.permitToken });
    const rC = await waitForTurn({ client: cC, agentId: "agentC", timeoutMs: 15_000 });
    assert.equal(rC.state, "granted");
    assert.equal(rC.autoClaimed, true);
    assert.ok(rC.entry?.permitToken);
    await cC.request("release", { permitToken: rC.entry!.permitToken });
  } finally {
    for (const cl of clients) cl.close();
    await d.stop();
  }
});

test("wait_for_turn: timeout returns still_queued with position and holders, not an error", async () => {
  const d = await startDaemon();
  const clients: LLClient[] = [];
  try {
    const cA = d.client();
    await cA.connect();
    clients.push(cA);
    await cA.request("configure", {
      expectedVersion: 1,
      changes: { offerTimeoutMs: 60_000, maxWaitMs: 0 },
      reason: "test timings",
      author: "test",
    });
    const a = (await cA.request("acquire", ACQ("holderA", "opA"))) as any;
    assert.equal(a.state, "granted");
    const cB = d.client();
    await cB.connect();
    clients.push(cB);
    const b = (await cB.request("acquire", ACQ("waiterB", "opB"))) as any;
    assert.equal(b.state, "queued");
    const requestId = b.entry.requestId as string;

    const r = await waitForTurn({ client: cB, agentId: "waiterB", requestId, timeoutMs: 900 });
    assert.equal(r.state, "still_queued", "timeout is a structured result, not an error");
    assert.equal(r.requestId, requestId);
    assert.equal(r.queuePosition, 1);
    assert.equal(r.queueLength, 1);
    assert.ok(Array.isArray(r.holders) && r.holders.length >= 1, "holder info included");
    assert.equal(r.holders![0].agentId, "holderA");
    assert.ok(r.waitedMs >= 800, `waited the full bound (waitedMs=${r.waitedMs})`);
    assert.match(r.nextAction ?? "", /wait_for_turn|wait again/i);

    // The queued request is untouched by the timed-out wait.
    const pend = (await cB.request("pending", { agentId: "waiterB" })) as any;
    assert.equal(pend.queue.length, 1);
    assert.equal(pend.queue[0].position, 1);
  } finally {
    for (const cl of clients) cl.close();
    await d.stop();
  }
});

test("wait_for_turn: paused request returns rejoin instructions, and rejoin then wait succeeds", async () => {
  const d = await startDaemon();
  const clients: LLClient[] = [];
  try {
    const cA = d.client();
    await cA.connect();
    clients.push(cA);
    const cfg = (await cA.request("get_config", {})) as any;
    await cA.request("configure", {
      expectedVersion: cfg.config.version,
      changes: { offerTimeoutMs: 1_000, maxWaitMs: 0 },
      reason: "fast offer expiry for the paused path",
      author: "test",
    });
    const a = (await cA.request("acquire", ACQ("holdA", "opA"))) as any;
    assert.equal(a.state, "granted");
    const cB = d.client();
    await cB.connect();
    clients.push(cB);
    const b = (await cB.request("acquire", ACQ("pauseB", "opB"))) as any;
    assert.equal(b.state, "queued");
    const requestId = b.entry.requestId as string;

    // Let the offer expire so the request lands in paused.
    await cA.request("release", { permitToken: a.entry.permitToken });
    await until(
      "offer expires and B lands in paused",
      async () => {
        const p = (await cB.request("pending", { agentId: "pauseB" })) as any;
        return p.paused.length === 1;
      },
      15_000,
    );

    const r = await waitForTurn({ client: cB, agentId: "pauseB", requestId, timeoutMs: 5_000 });
    assert.equal(r.state, "paused", "paused resolves immediately with a structured result");
    assert.match(r.nextAction ?? "", /rejoin/i, "rejoin instructions included");
    assert.equal((r.entry as any)?.state, "paused");

    // Rejoin, then sleep again: the freed capacity must reach B and auto-claim.
    await cB.request("rejoin", { requestId });
    const r2 = await waitForTurn({ client: cB, agentId: "pauseB", timeoutMs: 10_000 });
    assert.equal(r2.state, "granted");
    assert.equal(r2.autoClaimed, true);
    assert.ok(r2.entry?.permitToken);
    await cB.request("release", { permitToken: r2.entry!.permitToken });
  } finally {
    for (const cl of clients) cl.close();
    await d.stop();
  }
});

test("wait_for_turn: request cancelled mid-wait resolves cancelled with re-acquire instructions", async () => {
  const d = await startDaemon();
  const clients: LLClient[] = [];
  try {
    const cA = d.client();
    await cA.connect();
    clients.push(cA);
    await cA.request("configure", {
      expectedVersion: 1,
      changes: { offerTimeoutMs: 60_000, maxWaitMs: 0 },
      reason: "test timings",
      author: "test",
    });
    const a = (await cA.request("acquire", ACQ("holdA", "opA"))) as any;
    assert.equal(a.state, "granted");
    const cB = d.client();
    await cB.connect();
    clients.push(cB);
    const b = (await cB.request("acquire", ACQ("waitB", "opB"))) as any;
    assert.equal(b.state, "queued");
    const requestId = b.entry.requestId as string;

    const wait = waitForTurn({ client: cB, agentId: "waitB", requestId, timeoutMs: 15_000 });
    const early = await Promise.race([wait.then(() => "done"), expectPending(400)]);
    assert.equal(early, "pending");

    // Someone else cancels the request while we sleep.
    await cA.request("cancel", { requestId });
    const r = await wait;
    assert.equal(r.state, "cancelled", "cancellation resolves the wait with the request's state");
    assert.match(r.nextAction ?? "", /acquire/i, "re-acquire instructions included");

    const pend = (await cB.request("pending", { agentId: "waitB" })) as any;
    assert.equal(pend.queue.length + pend.paused.length + pend.offers.length, 0, "nothing orphaned in pending");
  } finally {
    for (const cl of clients) cl.close();
    await d.stop();
  }
});

test("wait_for_turn: daemon restart mid-wait resolves bounded with not_found + re-acquire guidance", async () => {
  const d = await startDaemon();
  const clients: LLClient[] = [];
  let child2: ChildProcess | null = null;
  try {
    const cA = d.client();
    await cA.connect();
    clients.push(cA);
    await cA.request("configure", {
      expectedVersion: 1,
      changes: { offerTimeoutMs: 60_000, maxWaitMs: 0 },
      reason: "test timings",
      author: "test",
    });
    const a = (await cA.request("acquire", ACQ("holdA", "opA"))) as any;
    assert.equal(a.state, "granted");
    const cB = d.client();
    await cB.connect();
    clients.push(cB);
    const b = (await cB.request("acquire", ACQ("waitB", "opB"))) as any;
    assert.equal(b.state, "queued");
    const requestId = b.entry.requestId as string;

    const wait = waitForTurn({ client: cB, agentId: "waitB", requestId, timeoutMs: 60_000 });
    const early = await Promise.race([wait.then(() => "done"), expectPending(400)]);
    assert.equal(early, "pending");

    // Restart the daemon mid-wait.
    const t0 = Date.now();
    d.child.kill("SIGTERM");
    await new Promise<void>((r) => d.child.once("exit", r));
    child2 = spawn(process.execPath, [daemonMainPath, "--state-dir", d.dir, "--socket", d.sock], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, LOAD_LOCK_STATE_DIR: d.dir, LOAD_LOCK_SOCKET: d.sock },
    });
    await until("restarted daemon listens", async () => await probe(d.sock));

    const r = await wait;
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 5_000, `restart resolution is bounded (took ${elapsed}ms)`);
    assert.equal(r.state, "not_found", "queued requests do not survive a restart");
    assert.match(r.nextAction ?? "", /acquire/i, "re-acquire guidance included");
    assert.ok(r.waitedMs >= 300);
  } finally {
    if (child2 && child2.exitCode === null && !child2.killed) child2.kill("SIGKILL");
    for (const cl of clients) cl.close();
    // stop() would kill the already-dead child again + rm the dir; safe either way.
    d.child.kill("SIGKILL");
    await delay(100);
    await d.stop();
  }
});

test("wait_for_turn: caller abort leaves no orphan — the request stays healthy and FIFO", async () => {
  const d = await startDaemon();
  const clients: LLClient[] = [];
  try {
    const cA = d.client();
    await cA.connect();
    clients.push(cA);
    await cA.request("configure", {
      expectedVersion: 1,
      changes: { offerTimeoutMs: 60_000, maxWaitMs: 0 },
      reason: "test timings",
      author: "test",
    });
    const a = (await cA.request("acquire", ACQ("holdA", "opA"))) as any;
    assert.equal(a.state, "granted");
    const cB = d.client();
    await cB.connect();
    clients.push(cB);
    const b = (await cB.request("acquire", ACQ("waitB", "opB"))) as any;
    assert.equal(b.state, "queued");
    const requestId = b.entry.requestId as string;

    const ac = new AbortController();
    const wait = waitForTurn({ client: cB, agentId: "waitB", requestId, timeoutMs: 60_000, signal: ac.signal });
    const early = await Promise.race([wait.then(() => "done"), expectPending(400)]);
    assert.equal(early, "pending");

    // The harness cancels the tool call mid-sleep.
    ac.abort();
    await assert.rejects(wait, (e) => e instanceof WaitAbortedError && e.name === "AbortError");

    // Nothing orphaned: the request is still queued, capacity untouched, no claim consumed.
    const pend = (await cB.request("pending", { agentId: "waitB" })) as any;
    assert.equal(pend.queue.length, 1, "the request keeps its queue slot after the abort");
    assert.equal(pend.queue[0].position, 1);
    assert.equal(pend.offers.length, 0);
    const st = (await cA.request("status", {})) as any;
    assert.equal(st.pools[0].used, 1, "no capacity was consumed by the wait or the abort");

    // The request is still perfectly usable: release, sleep again, get the turn.
    await cA.request("release", { permitToken: a.entry.permitToken });
    const r = await waitForTurn({ client: cB, agentId: "waitB", requestId, timeoutMs: 15_000 });
    assert.equal(r.state, "granted");
    assert.equal(r.autoClaimed, true);
    assert.ok(r.entry?.permitToken);
    await cB.request("release", { permitToken: r.entry!.permitToken });
  } finally {
    for (const cl of clients) cl.close();
    await d.stop();
  }
});

test("wait_for_turn: the maxTurnWaitMs config caps the bound (validated, persisted)", async () => {
  const d = await startDaemon();
  const clients: LLClient[] = [];
  try {
    const cA = d.client();
    await cA.connect();
    clients.push(cA);
    await cA.request("configure", {
      expectedVersion: 1,
      changes: { offerTimeoutMs: 60_000, maxWaitMs: 0 },
      reason: "test timings",
      author: "test",
    });
    const a = (await cA.request("acquire", ACQ("holdA", "opA"))) as any;
    assert.equal(a.state, "granted");
    const cB = d.client();
    await cB.connect();
    clients.push(cB);
    const b = (await cB.request("acquire", ACQ("waitB", "opB"))) as any;
    assert.equal(b.state, "queued");

    // Out-of-range values are rejected by the configure validation.
    await assert.rejects(
      cA.request("configure", {
        expectedVersion: 2,
        changes: { maxTurnWaitMs: 500 },
        reason: "below the floor",
        author: "test",
      }),
      /maxTurnWaitMs/,
    );

    const cfg = (await cA.request("get_config", {})) as any;
    assert.equal(cfg.config.maxTurnWaitMs, 600_000, "default cap is 10 minutes");
    const conf = (await cA.request("configure", {
      expectedVersion: cfg.config.version,
      changes: { maxTurnWaitMs: 1_000 },
      reason: "short cap for the test",
      author: "test",
    })) as any;
    assert.equal(conf.config.maxTurnWaitMs, 1_000, "cap persisted via CAS configure");

    // A 10-minute ask is clamped to the 1-second machine cap and reported.
    const t0 = Date.now();
    const r = await waitForTurn({ client: cB, agentId: "waitB", timeoutMs: 600_000 });
    const elapsed = Date.now() - t0;
    assert.equal(r.state, "still_queued");
    assert.equal(r.effectiveWaitMs, 1_000, "the effective (clamped) bound is reported");
    assert.ok(elapsed < 2_500, `the wait respected the clamp (took ${elapsed}ms)`);
  } finally {
    for (const cl of clients) cl.close();
    await d.stop();
  }
});

test("wait_for_turn: nothing to watch resolves not_found immediately", async () => {
  const d = await startDaemon();
  const clients: LLClient[] = [];
  try {
    const c = d.client();
    await c.connect();
    clients.push(c);
    const t0 = Date.now();
    const r = await waitForTurn({ client: c, agentId: "nobody", timeoutMs: 5_000 });
    assert.ok(Date.now() - t0 < 1_000, "no busy-wait when there is nothing to watch");
    assert.equal(r.state, "not_found");
    assert.match(r.nextAction ?? "", /acquire/i);
  } finally {
    for (const cl of clients) cl.close();
    await d.stop();
  }
});
