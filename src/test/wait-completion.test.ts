/**
 * Integration tests for wait_for_completion (issue #36): honest sleeping
 * through the EXECUTION phase — the counterpart of wait_for_turn. Covers:
 * - daemon-tracked jobs: the daemon holds the wait server-side and wakes it
 *   from its liveness sweep (real daemons, real processes), with the permit
 *   freed BEFORE the waiter is woken (ordering),
 * - adapter-parented jobs: waitForLocalJob wakes on the child exit event
 *   (pure unit tests with real timers),
 * - the old-daemon polling fallback (client that does not know the method),
 * - daemon restart transparency mid-wait,
 * - all structured paths: finished / still_running / timeout / job_unknown /
 *   stopped_by_request,
 * - the CLI `wait --job` surface.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { LLClient } from "../shared/client.js";
import { ProtocolError } from "../shared/protocol.js";
import {
  waitForLocalJob,
  waitForTrackedJob,
  type WaitableAdapterJob,
} from "../shared/wait-completion.js";
import {
  startDaemon,
  delay,
  until,
  probe,
  runCli,
  daemonMainPath,
} from "./testutil.js";

const ACQ = (agentId: string, opKey: string) => ({
  agentId,
  opKey,
  reason: "integration test",
});

/** A wait expected to stay pending for at least `ms` (race sentinel). */
function expectPending(ms: number): Promise<"pending" | "done"> {
  return delay(ms).then(() => "pending" as const);
}

interface TrackedJob {
  requestId: string;
  permitToken: string;
  child: ChildProcess;
}

/**
 * Acquire a permit and attach a REAL detached process to it (daemon-tracked,
 * exactly what an adapter does on behalf of an agent).
 */
async function startTrackedJob(c: LLClient, agentId: string, opKey: string): Promise<TrackedJob> {
  const acq = (await c.request("acquire", ACQ(agentId, opKey))) as any;
  assert.equal(acq.state, "granted");
  const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
  child.unref();
  const sj = (await c.request("start_job", { permitToken: acq.entry.permitToken, pid: child.pid })) as any;
  assert.ok(sj.entry.requestId, "start_job returns the entry snapshot");
  return { requestId: sj.entry.requestId as string, permitToken: acq.entry.permitToken as string, child };
}

test("wait_for_completion: liveness sweep wakes the sleeper when the tracked process dies (ordering: permit freed first)", async () => {
  const d = await startDaemon();
  const clients: LLClient[] = [];
  try {
    const cA = d.client();
    await cA.connect();
    clients.push(cA);
    const cB = d.client();
    await cB.connect();
    clients.push(cB);
    const job = await startTrackedJob(cA, "holderA", "opA");

    // Two independent waiters on the same job — multiple waiters are fine.
    const waitA = waitForTrackedJob({ client: cA, requestId: job.requestId, timeoutMs: 30_000 });
    const waitB = waitForTrackedJob({ client: cB, requestId: job.requestId, timeoutMs: 30_000 });
    const early = await Promise.race([waitA.then(() => "done"), expectPending(400)]);
    assert.equal(early, "pending", "the wait blocks while the tracked process runs");

    const t0 = Date.now();
    job.child.kill("SIGKILL");
    const [rA, rB] = await Promise.all([waitA, waitB]);
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 7_000, `woke promptly after process death (took ${elapsed}ms; sweep interval is 5s)`);
    assert.equal(rA.state, "finished");
    assert.equal(rB.state, "finished");
    assert.equal(rA.requestId, job.requestId);
    assert.equal(rA.permitReleased, true, "the permit is released by the time we wake");
    assert.ok(rA.durationMs === undefined || rA.durationMs >= 0);
    assert.ok(rA.waitedMs >= 300, `waitedMs reported (got ${rA.waitedMs})`);

    // ORDERING: capacity was freed BEFORE the waiters were woken.
    const st = (await cA.request("status", {})) as any;
    assert.equal(st.pools[0].used, 0, "pool is empty the moment the wait resolves");
  } finally {
    for (const cl of clients) cl.close();
    await d.stop();
  }
});

test("wait_for_completion: budget elapsing is a still_running checkpoint, not an error; timeout_ms 0 is check-only", async () => {
  const d = await startDaemon();
  const clients: LLClient[] = [];
  try {
    const cA = d.client();
    await cA.connect();
    clients.push(cA);
    const job = await startTrackedJob(cA, "holderA", "opA");

    const t0 = Date.now();
    const r = await waitForTrackedJob({ client: cA, requestId: job.requestId, timeoutMs: 800 });
    assert.ok(Date.now() - t0 < 5_000, "checkpoint returns promptly after the budget");
    assert.equal(r.state, "still_running", "timeout is a structured checkpoint result");
    assert.ok(r.waitedMs >= 700, `waited the full budget (waitedMs=${r.waitedMs})`);
    assert.ok(r.startedAt, "startedAt reported so callers can reason about duration");
    assert.match(r.nextAction ?? "", /wait_for_completion|call again/i);

    // Check-only: no budget spent, immediate structured answer.
    const t1 = Date.now();
    const check = await waitForTrackedJob({ client: cA, requestId: job.requestId, timeoutMs: 0 });
    assert.ok(Date.now() - t1 < 1_000, "check-only does not sleep");
    assert.equal(check.state, "still_running");
    assert.ok(check.waitedMs < 1_000, "check-only spends no budget waiting");
    assert.match(check.detail ?? "", /check-only/);

    job.child.kill("SIGKILL");
  } finally {
    for (const cl of clients) cl.close();
    await d.stop();
  }
});

test("wait_for_completion: job_unknown for unknown ids, queued requests and untracked permits", async () => {
  const d = await startDaemon();
  const clients: LLClient[] = [];
  try {
    const cA = d.client();
    await cA.connect();
    clients.push(cA);

    // Unknown id resolves immediately with a structured result.
    const t0 = Date.now();
    const unknown = await waitForTrackedJob({ client: cA, requestId: "no-such-request", timeoutMs: 5_000 });
    assert.ok(Date.now() - t0 < 1_000, "unknown id does not busy-wait");
    assert.equal(unknown.state, "job_unknown");
    assert.match(unknown.detail ?? "", /unknown request id/);

    // An untracked (mark_started) permit has no observable completion.
    const u = (await cA.request("acquire", ACQ("untrackedA", "opU"))) as any;
    assert.equal(u.state, "granted");
    await cA.request("mark_started", { permitToken: u.entry.permitToken });
    const untracked = await waitForTrackedJob({ client: cA, requestId: u.entry.requestId, timeoutMs: 1_000 });
    assert.equal(untracked.state, "job_unknown");
    assert.match(untracked.detail ?? "", /untracked|not observable|phase/);
    await cA.request("release", { permitToken: u.entry.permitToken });

    // A queued request is not a running job either.
    const a = (await cA.request("acquire", ACQ("holderA", "opA"))) as any;
    assert.equal(a.state, "granted");
    const cB = d.client();
    await cB.connect();
    clients.push(cB);
    const b = (await cB.request("acquire", ACQ("waitB", "opB"))) as any;
    assert.equal(b.state, "queued");
    const queued = await waitForTrackedJob({ client: cB, requestId: b.entry.requestId, timeoutMs: 1_000 });
    assert.equal(queued.state, "job_unknown", "a queued request has no completion to wait for");
  } finally {
    for (const cl of clients) cl.close();
    await d.stop();
  }
});

test("wait_for_completion: explicit release mid-wait wakes the sleeper finished", async () => {
  const d = await startDaemon();
  const clients: LLClient[] = [];
  try {
    const cA = d.client();
    await cA.connect();
    clients.push(cA);
    const cB = d.client();
    await cB.connect();
    clients.push(cB);
    const job = await startTrackedJob(cA, "holderA", "opA");

    const wait = waitForTrackedJob({ client: cB, requestId: job.requestId, timeoutMs: 30_000 });
    const early = await Promise.race([wait.then(() => "done"), expectPending(400)]);
    assert.equal(early, "pending");

    // The owner releases explicitly while someone sleeps on the job.
    await cA.request("release", { permitToken: job.permitToken });
    const r = await wait;
    assert.equal(r.state, "finished");
    assert.equal(r.permitReleased, true);
    assert.ok(r.waitedMs >= 300);
    const st = (await cB.request("status", {})) as any;
    assert.equal(st.pools[0].used, 0);
    job.child.kill("SIGKILL");
  } finally {
    for (const cl of clients) cl.close();
    await d.stop();
  }
});

test("wait_for_completion: admin force-release mid-wait wakes the sleeper stopped_by_request", async () => {
  const d = await startDaemon();
  const clients: LLClient[] = [];
  try {
    const cA = d.client();
    await cA.connect();
    clients.push(cA);
    const cB = d.client();
    await cB.connect();
    clients.push(cB);
    const job = await startTrackedJob(cA, "holderA", "opA");

    const wait = waitForTrackedJob({ client: cB, requestId: job.requestId, timeoutMs: 30_000 });
    const early = await Promise.race([wait.then(() => "done"), expectPending(400)]);
    assert.equal(early, "pending");

    await cB.request("admin_release", { requestId: job.requestId });
    const r = await wait;
    assert.equal(r.state, "stopped_by_request", "admin force-release classifies as stopped_by_request");
    assert.match(r.nextAction ?? "", /re-acquire|force-released/i);
    const st = (await cB.request("status", {})) as any;
    assert.equal(st.pools[0].used, 0);
    job.child.kill("SIGKILL");
  } finally {
    for (const cl of clients) cl.close();
    await d.stop();
  }
});

test("wait_for_completion: daemon restart mid-wait is transparent — the wait continues against the recovered state", async () => {
  const d = await startDaemon();
  const clients: LLClient[] = [];
  let child2: ChildProcess | null = null;
  let job: TrackedJob | null = null;
  try {
    const cA = d.client();
    await cA.connect();
    clients.push(cA);
    job = await startTrackedJob(cA, "holderA", "opA");

    const wait = waitForTrackedJob({ client: cA, requestId: job.requestId, timeoutMs: 30_000 });
    const early = await Promise.race([wait.then(() => "done"), expectPending(400)]);
    assert.equal(early, "pending");

    // Restart the daemon mid-wait. Tracked permits survive via journal restore.
    d.child.kill("SIGTERM");
    await new Promise<void>((r) => d.child.once("exit", r));
    child2 = spawn(process.execPath, [daemonMainPath, "--state-dir", d.dir, "--socket", d.sock], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, LOAD_LOCK_STATE_DIR: d.dir, LOAD_LOCK_SOCKET: d.sock },
    });
    await until("restarted daemon listens", async () => await probe(d.sock));

    // The wait survives (re-issued transparently): killing the process now
    // wakes it finished via the restarted daemon's sweep.
    job.child.kill("SIGKILL");
    const r = await wait;
    assert.equal(r.state, "finished", "the wait continued through the restart and woke on completion");
    assert.equal(r.permitReleased, true);
    const st = (await cA.request("status", {})) as any;
    assert.equal(st.pools[0].used, 0);
  } finally {
    if (job && job.child.exitCode === null && !job.child.killed) job.child.kill("SIGKILL");
    if (child2 && child2.exitCode === null && !child2.killed) child2.kill("SIGKILL");
    for (const cl of clients) cl.close();
    d.child.kill("SIGKILL");
    await delay(100);
    await d.stop();
  }
});

test("wait_for_completion: old daemons without the method degrade to a light events-based poll (fallback)", async () => {
  const d = await startDaemon();
  const clients: LLClient[] = [];
  try {
    const real = d.client();
    await real.connect();
    clients.push(real);
    const job = await startTrackedJob(real, "holderA", "opA");

    // A client facing an OLD daemon: wait_for_completion is "unknown method".
    const fake = Object.create(real) as LLClient;
    (fake as any).request = (method: string, params: unknown, timeoutMs?: number) => {
      if (method === "wait_for_completion") {
        return Promise.reject(new ProtocolError("invalid", `unknown method "${method}"`));
      }
      return real.request(method, params as never, timeoutMs);
    };

    const t0 = Date.now();
    const waitP = waitForTrackedJob({ client: fake, requestId: job.requestId, timeoutMs: 30_000 });
    const early = await Promise.race([waitP.then(() => "done"), expectPending(400)]);
    assert.equal(early, "pending", "the fallback polls quietly");

    job.child.kill("SIGKILL");
    const r = await waitP;
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 8_000, `fallback woke on completion (took ${elapsed}ms)`);
    assert.equal(r.state, "finished");
    assert.equal(r.permitReleased, true);

    // Fallback also classifies job_unknown ids without spinning.
    const unknown = await waitForTrackedJob({ client: fake, requestId: "no-such-request", timeoutMs: 2_000 });
    assert.equal(unknown.state, "job_unknown");
    assert.match(unknown.detail ?? "", /absent|unknown/i);
  } finally {
    for (const cl of clients) cl.close();
    await d.stop();
  }
});

test("waitForLocalJob: adapter-parented job wakes on the child exit event with exit code, tail and duration", async () => {
  let resolveExit!: (code: number | null) => void;
  let resolveRelease!: () => void;
  const job: WaitableAdapterJob = {
    id: "job_unit",
    startedAt: Date.now(),
    exited: false,
    output: [],
    // Adapter contract: exitPromise resolves only AFTER releasePromise exists.
    exitPromise: new Promise<number | null>((r) => (resolveExit = r)),
  };
  job.releasePromise = new Promise<void>((r) => (resolveRelease = r));

  const t0 = Date.now();
  const waitP = waitForLocalJob(job, { timeoutMs: 10_000 });
  setTimeout(() => {
    // The child exit handler runs: record exit, then release, then wake.
    job.exited = true;
    job.exitedAt = Date.now();
    job.exitCode = 0;
    job.output.push("building...\n", "done\n");
    resolveRelease();
    job.permitReleased = true;
    resolveExit(0);
  }, 300);

  const r = await waitP;
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 2_000, `woke promptly on the exit event (took ${elapsed}ms)`);
  assert.equal(r.state, "finished");
  assert.equal(r.exitCode, 0);
  assert.ok(r.outputTail!.includes("done"), "output tail included");
  assert.ok(r.durationMs! >= 250, `duration reported (got ${r.durationMs}ms)`);
  assert.equal(r.permitReleased, true);
});

test("waitForLocalJob: already-exited job resolves immediately (waits for the release round-trip)", async () => {
  const job: WaitableAdapterJob = {
    id: "job_done",
    startedAt: Date.now() - 500,
    exited: true,
    exitedAt: Date.now() - 100,
    exitCode: 0,
    output: ["done\n"],
    permitReleased: false,
  };
  const t0 = Date.now();
  const r = await waitForLocalJob(job, { timeoutMs: 5_000 });
  assert.ok(Date.now() - t0 < 1_000, "no busy-wait for an already-exited job");
  assert.equal(r.state, "finished");
  assert.equal(r.exitCode, 0);
  assert.equal(r.permitReleased, false, "honest: release round-trip had not completed");
  assert.match(r.detail ?? "", /verify with status/);
});

test("waitForLocalJob: budget elapsing is a still_running checkpoint; abort resolves timeout with the job untouched", async () => {
  // Budget checkpoint.
  const slow: WaitableAdapterJob = {
    id: "job_slow",
    startedAt: Date.now(),
    exited: false,
    output: [],
    exitPromise: new Promise<number | null>(() => {}),
  };
  const r = await waitForLocalJob(slow, { timeoutMs: 250 });
  assert.equal(r.state, "still_running");
  assert.ok(r.waitedMs >= 200, `waited the budget (waitedMs=${r.waitedMs})`);
  assert.equal(slow.exited, false, "the job keeps running after a checkpoint");

  // AbortSignal (harness tool timeout) — the call resolves, the job untouched.
  const ac = new AbortController();
  const waitP = waitForLocalJob(slow, { timeoutMs: 10_000, signal: ac.signal });
  await delay(200);
  ac.abort();
  const aborted = await waitP;
  assert.equal(aborted.state, "timeout", "an aborted call is a structured timeout, not an error");
  assert.match(aborted.detail ?? "", /aborted by caller/);
  assert.match(aborted.nextAction ?? "", /wait_for_completion|again/);
  assert.equal(slow.exited, false, "aborting the wait never touches the job");
});

test("waitForLocalJob: job_stop before exit classifies stopped_by_request; missing exitPromise is job_unknown", async () => {
  let resolveExit!: (code: number | null) => void;
  const job: WaitableAdapterJob = {
    id: "job_stop",
    startedAt: Date.now(),
    exited: false,
    output: [],
    stopRequested: false,
    exitPromise: new Promise<number | null>((r) => (resolveExit = r)),
  };
  const waitP = waitForLocalJob(job, { timeoutMs: 10_000 });
  await delay(150);
  job.stopRequested = true; // job_stop flags the job before killing the group
  job.exited = true;
  job.exitedAt = Date.now();
  job.exitCode = null;
  resolveExit(null);
  const r = await waitP;
  assert.equal(r.state, "stopped_by_request");
  assert.equal(r.exitCode, null);
  assert.match(r.nextAction ?? "", /job_stop|re-run/i);

  const broken: WaitableAdapterJob = { id: "job_broken", startedAt: Date.now(), exited: false, output: [] };
  const u = await waitForLocalJob(broken, { timeoutMs: 100 });
  assert.equal(u.state, "job_unknown");
  assert.match(u.detail ?? "", /exitPromise/);
});

test("cli: wait --job sleeps through a tracked job, exits 0 on finish and reports structured states otherwise", async () => {
  const d = await startDaemon();
  const clients: LLClient[] = [];
  try {
    const cA = d.client();
    await cA.connect();
    clients.push(cA);
    const job = await startTrackedJob(cA, "holderA", "opA");

    // Checkpoint path: budget elapses -> still_running, exit code 68.
    const ck = await runCli(d, ["wait", "--job", job.requestId, "--timeout", "400"]);
    assert.equal(ck.code, 68);
    assert.equal(JSON.parse(ck.stdout).state, "still_running");

    // Sleep-through path: kill the process mid-wait -> finished, exit 0.
    const cliP = runCli(d, ["wait", "--job", job.requestId, "--timeout", "25000"]);
    await delay(500);
    job.child.kill("SIGKILL");
    const done = await cliP;
    assert.equal(done.code, 0, `stdout=${done.stdout} stderr=${done.stderr}`);
    const out = JSON.parse(done.stdout);
    assert.equal(out.state, "finished");
    assert.equal(out.permit_released, true);
    assert.equal(out.request_id, job.requestId);

    // Unknown id -> job_unknown, exit 69.
    const unknown = await runCli(d, ["wait", "--job", "no-such-request", "--timeout", "1000"]);
    assert.equal(unknown.code, 69);
    assert.equal(JSON.parse(unknown.stdout).state, "job_unknown");
  } finally {
    for (const cl of clients) cl.close();
    await d.stop();
  }
});
