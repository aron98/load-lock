/**
 * Integration tests: a REAL daemon process over a real Unix socket, with
 * multiple independent client connections (and separate CLI processes via
 * run-helper/mcp tests). State dirs live in /tmp/opencode, never the user's.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { connect } from "node:net";
import { fileURLToPath } from "node:url";
import { LLClient } from "../shared/client.js";
import { isProcessAlive, processStartTime } from "../core/daemon.js";

const TMP_BASE = process.env.LL_TEST_TMP ?? join(tmpdir(), "opencode");
mkdirSync(TMP_BASE, { recursive: true });
const daemonMain = join(dirname(fileURLToPath(import.meta.url)), "..", "core", "daemon-main.js");

interface DaemonHandle {
  child: ChildProcess;
  dir: string;
  sock: string;
  client(): LLClient;
  stop(): Promise<void>;
}

async function startDaemon(): Promise<DaemonHandle> {
  const dir = mkdtempSync(join(TMP_BASE, "ll-daemon-"));
  const sock = join(dir, "daemon.sock");
  const child = spawn(process.execPath, [daemonMain, "--state-dir", dir, "--socket", sock], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, LOAD_LOCK_STATE_DIR: dir, LOAD_LOCK_SOCKET: sock },
  });
  const deadline = Date.now() + 10_000;
  for (;;) {
    if (await probe(sock)) break;
    if (Date.now() > deadline) {
      child.kill("SIGKILL");
      throw new Error("daemon did not come up");
    }
    await delay(100);
  }
  const handle: DaemonHandle = {
    child,
    dir,
    sock,
    client: () => new LLClient({ socket: sock, stateDir: dir, spawnDaemon: false }),
    stop: async () => {
      if (child.exitCode === null && !child.killed) {
        child.kill("SIGTERM");
        await new Promise<void>((resolve) => {
          const t = setTimeout(() => {
            child.kill("SIGKILL");
            resolve();
          }, 3000);
          child.once("exit", () => {
            clearTimeout(t);
            resolve();
          });
        });
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return handle;
}

function probe(sock: string): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect(sock);
    s.once("connect", () => {
      s.destroy();
      resolve(true);
    });
    s.once("error", () => resolve(false));
  });
}

function delay(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

async function until(desc: string, fn: () => boolean | Promise<boolean>, timeoutMs = 15_000, step = 200): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > deadline) throw new Error(`timeout waiting for: ${desc}`);
    await delay(step);
  }
}

const ACQ = (agentId: string, opKey: string, extra: Record<string, unknown> = {}) => ({
  agentId,
  opKey,
  reason: "integration test",
  ...extra,
});

test("concurrent burst: exactly one grant, FIFO queue, no missed wakeup", async () => {
  const d = await startDaemon();
  try {
    const c = d.client();
    await c.connect();
    // tight timings for the test
    await c.request("configure", {
      expectedVersion: 1,
      changes: { offerTimeoutMs: 60_000, maxWaitMs: 0 },
      reason: "test timings",
      author: "test",
    });

    const clients: LLClient[] = [];
    for (let i = 0; i < 5; i++) {
      const cl = d.client();
      await cl.connect();
      clients.push(cl);
    }
    const results = await Promise.all(
      clients.map((cl, i) => cl.request("acquire", ACQ(`agent${i}`, `op${i}`))),
    );
    const granted = results.filter((r: any) => r.state === "granted");
    const queued = results.filter((r: any) => r.state === "queued");
    assert.equal(granted.length, 1, "exactly one concurrent grant");
    assert.equal(queued.length, 4);
    assert.deepEqual(
      queued.map((r: any) => r.entry.position).sort(),
      [1, 2, 3, 4],
      "queue positions assigned exactly once",
    );

    // capacity invariant
    const st = await c.request("status", {});
    assert.ok((st as any).pools[0].used <= (st as any).pools[0].capacity);

    // release: the FIFO head must see an offer; nobody else
    const winner = granted[0] as any;
    const headIdx = results.findIndex((r: any) => r.entry?.position === 1);
    const headAgent = `agent${headIdx}`;
    assert.ok(headIdx >= 0);
    const events: Record<string, unknown>[] = [];
    const watcher = d.client();
    await watcher.connect();
    await watcher.watch(headAgent, (ev) => events.push(ev));
    // Regression (live opencode verification found this): a "*" multiplexer
    // watcher (e.g. the OpenCode plugin serving all sessions) must also
    // receive the claim token on offered events.
    const starEvents: Record<string, unknown>[] = [];
    const starWatcher = d.client();
    await starWatcher.connect();
    await starWatcher.watch("*", (ev) => starEvents.push(ev));
    await c.request("release", { permitToken: winner.entry.permitToken });

    const p = (await clients[headIdx].request("pending", { agentId: headAgent })) as any;
    assert.equal(p.offers.length, 1, "queued head receives the offer");
    assert.ok(p.offers[0].offerToken);
    await until("watcher got offered event", () => events.some((e) => e.type === "offered"));
    const offeredEv = events.find((e) => e.type === "offered")!;
    assert.ok(offeredEv.offerToken, "watch push for the owner carries the claim token");
    await until("star watcher got offered event", () => starEvents.some((e) => e.type === "offered"));
    const starEv = starEvents.find((e) => e.type === "offered")!;
    assert.ok(starEv.offerToken, 'watch push for a "*" multiplexer carries the claim token');

    const claimed = await clients[headIdx].request("claim", { offerToken: p.offers[0].offerToken });
    assert.equal((claimed as any).entry.state, "held");

    // capacity again: claim consumed the offer, no double admission
    const st2 = (await c.request("status", {})) as any;
    assert.equal(st2.pools[0].used, 1);
    assert.equal(st2.pools[0].capacity, 1);
    for (const cl of clients) cl.close();
    watcher.close();
    starWatcher.close();
    c.close();
  } finally {
    await d.stop();
  }
});

test("bounded blocking wait auto-claims when capacity frees in time", async () => {
  const d = await startDaemon();
  try {
    const a = d.client();
    const b = d.client();
    await a.connect();
    await b.connect();
    const g = (await a.request("acquire", ACQ("A", "op1"))) as any;
    assert.equal(g.state, "granted");
    const t0 = Date.now();
    const bPromise = b.request("acquire", ACQ("B", "op1", { waitMs: 8000 }));
    await delay(500);
    await a.request("release", { permitToken: g.entry.permitToken });
    const r = (await bPromise) as any;
    assert.equal(r.state, "granted", "waiter is auto-claimed on admission");
    assert.ok(r.entry.permitToken, "waiter receives the permit token");
    assert.ok(Date.now() - t0 < 5000, "woke promptly after the release");
    a.close();
    b.close();
  } finally {
    await d.stop();
  }
});

test("offer expiry pauses and hands capacity to the next waiter; rejoin works", async () => {
  const d = await startDaemon();
  try {
    const c = d.client();
    await c.connect();
    await c.request("configure", {
      expectedVersion: 1,
      changes: { offerTimeoutMs: 1000, maxWaitMs: 0 },
      reason: "fast expiry",
      author: "test",
    });
    const a = d.client();
    const b = d.client();
    await a.connect();
    await b.connect();
    const g = (await a.request("acquire", ACQ("A", "op1"))) as any;
    const q = (await b.request("acquire", ACQ("B", "op1"))) as any;
    assert.equal(q.state, "queued");
    await a.request("release", { permitToken: g.entry.permitToken });
    const pb = (await b.request("pending", { agentId: "B" })) as any;
    assert.equal(pb.offers.length, 1);
    // do NOT claim; let it expire
    await until("offer expired", async () => {
      const st = (await c.request("status", {})) as any;
      return st.pools[0].paused.length === 1;
    });
    const st = (await c.request("status", {})) as any;
    assert.equal(st.pools[0].offers.length, 0, "expired offer does not keep consuming capacity");
    // claim after expiry is rejected; rejoin re-queues
    await assert.rejects(
      b.request("claim", { offerToken: pb.offers[0].offerToken }),
      (e: any) => e.code === "offer_expired",
    );
    const rj = (await b.request("rejoin", { requestId: q.entry.requestId })) as any;
    assert.equal(rj.state, "offered", "rejoined request is admitted into the free capacity");
    a.close();
    b.close();
    c.close();
  } finally {
    await d.stop();
  }
});

test("tracked process: auto-release on death; PID identity checked via /proc start time", async () => {
  const d = await startDaemon();
  try {
    const c = d.client();
    await c.connect();
    const g = (await c.request("acquire", ACQ("A", "op1"))) as any;
    const sleeper = spawn("sleep", ["60"], { stdio: "ignore" });
    const st0 = processStartTime(sleeper.pid!);
    assert.ok(st0, "reads /proc start time on Linux");

    // PID-reuse defense: wrong start time => treated as a different (dead) process
    assert.equal(isProcessAlive(sleeper.pid!, "9999"), false);
    assert.equal(isProcessAlive(sleeper.pid!, st0), true);

    const att = (await c.request("attach_pid", { permitToken: g.entry.permitToken, pid: sleeper.pid })) as any;
    assert.equal(att.entry.phase, "running_tracked");

    // kill the tracked process; the daemon sweep must auto-release
    sleeper.kill("SIGKILL");
    await until("auto-release after tracked process death", async () => {
      const st = (await c.request("status", {})) as any;
      return st.pools[0].holders.length === 0;
    });
    const st = (await c.request("status", {})) as any;
    assert.equal(st.pools[0].used, 0, "capacity is freed, not leaked");
    c.close();
  } finally {
    await d.stop();
  }
});

test("subprocess survival: parent exits, child keeps the permit until it really ends", async () => {
  const d = await startDaemon();
  try {
    const c = d.client();
    await c.connect();
    const g = (await c.request("acquire", ACQ("A", "op1"))) as any;
    // parent exits immediately; a child (sleep 4) keeps the process group alive
    const parent = spawn("bash", ["-c", "sleep 4 & exit 0"], { stdio: "ignore", detached: true });
    const pgid = parent.pid!;
    await delay(300); // let bash exit, leave the orphan sleep in the pgid
    const att = (await c.request("start_job", { permitToken: g.entry.permitToken, pid: parent.pid, pgid })) as any;
    assert.equal(att.entry.phase, "running_tracked");

    // parent is gone but the process group still runs: permit must be retained
    await delay(1200);
    let st = (await c.request("status", {})) as any;
    assert.equal(st.pools[0].holders.length, 1, "permit retained while a subprocess of the job lives");

    // once the whole group is gone, the daemon releases
    await until("auto-release when the process group fully exits", async () => {
      st = (await c.request("status", {})) as any;
      return st.pools[0].holders.length === 0;
    }, 15_000);
    assert.equal(st.pools[0].used, 0);
    c.close();
  } finally {
    await d.stop();
  }
});

test("daemon restart: journal restores a running tracked permit; token still releases", async () => {
  const d = await startDaemon();
  try {
    const c = d.client();
    await c.connect();
    const g = (await c.request("acquire", ACQ("A", "op1"))) as any;
    const permitToken = g.entry.permitToken as string;
    const sleeper = spawn("sleep", ["60"], { stdio: "ignore" });
    await c.request("attach_pid", { permitToken: permitToken, pid: sleeper.pid });
    c.close();

    // ---- restart
    d.child.kill("SIGTERM");
    await new Promise<void>((r) => d.child.once("exit", r));
    const child2 = spawn(process.execPath, [daemonMain, "--state-dir", d.dir, "--socket", d.sock], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, LOAD_LOCK_STATE_DIR: d.dir, LOAD_LOCK_SOCKET: d.sock },
    });
    await until("restarted daemon listens", async () => await probe(d.sock));

    const c2 = new LLClient({ socket: d.sock, stateDir: d.dir, spawnDaemon: false });
    await c2.connect();
    const st = (await c2.request("status", {})) as any;
    assert.equal(st.pools[0].holders.length, 1, "running permit survives the restart");
    assert.equal(st.pools[0].holders[0].phase, "running_tracked");
    assert.equal(st.pools[0].holders[0].pid, sleeper.pid);

    // the SAME permit token still releases (idempotency across restart)
    const rel = (await c2.request("release", { permitToken: permitToken })) as any;
    assert.equal(rel.releasedNow, true);

    // ---- restart with a job that died while we were down
    const g2 = (await c2.request("acquire", ACQ("B", "op1"))) as any;
    const short = spawn("sleep", ["30"], { stdio: "ignore" });
    await c2.request("attach_pid", { permitToken: g2.entry.permitToken, pid: short.pid });
    short.kill("SIGKILL");
    await delay(300); // dies before the restart
    c2.close();
    child2.kill("SIGTERM");
    await new Promise<void>((r) => child2.once("exit", r));
    const child3 = spawn(process.execPath, [daemonMain, "--state-dir", d.dir, "--socket", d.sock], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, LOAD_LOCK_STATE_DIR: d.dir, LOAD_LOCK_SOCKET: d.sock },
    });
    await until("third daemon listens", async () => await probe(d.sock));
    const c3 = new LLClient({ socket: d.sock, stateDir: d.dir, spawnDaemon: false });
    await c3.connect();
    const st3 = (await c3.request("status", {})) as any;
    assert.equal(st3.pools[0].holders.length, 0, "confirmed-dead job is released at restore, capacity free");
    // duplicate release of the already-released permit is a clean idempotent no-op
    const rel2 = (await c3.request("release", { permitToken: g2.entry.permitToken })) as any;
    assert.equal(rel2.releasedNow, false);
    c3.close();
    child3.kill("SIGTERM");
    await new Promise<void>((r) => child3.once("exit", r));
    sleeper.kill("SIGKILL");
  } finally {
    await d.stop();
  }
});

test("forgotten untracked permit: lease reclaims it (heartbeat would renew)", async () => {
  const d = await startDaemon();
  try {
    const c = d.client();
    await c.connect();
    await c.request("configure", {
      expectedVersion: 1,
      changes: { untrackedLeaseMs: 10_000 },
      reason: "short lease",
      author: "test",
    });
    const g = (await c.request("acquire", ACQ("A", "op1"))) as any;
    await c.request("mark_started", { permitToken: g.entry.permitToken });
    // no heartbeats: the lease must reclaim the permit
    await until("untracked lease reclaims the permit", async () => {
      const st = (await c.request("status", {})) as any;
      return st.pools[0].holders.length === 0;
    }, 25_000);
    const st = (await c.request("status", {})) as any;
    assert.equal(st.pools[0].used, 0);
    c.close();
  } finally {
    await d.stop();
  }
});

test("offers_for_cwd returns cwd-matched offers with tokens (hook support)", async () => {
  const d = await startDaemon();
  try {
    const a = d.client();
    const b = d.client();
    await a.connect();
    await b.connect();
    const cwd = mkdtempSync(join(TMP_BASE, "ll-cwd-"));
    const g = (await a.request("acquire", ACQ("A", "op1", { cwd }))) as any;
    await b.request("acquire", ACQ("B", "op1", { cwd }));
    await a.request("release", { permitToken: g.entry.permitToken });
    const r = (await b.request("offers_for_cwd", { cwd })) as any;
    assert.equal(r.offers.length, 1);
    assert.ok(r.offers[0].offerToken);
    const r2 = (await b.request("offers_for_cwd", { cwd: "/nonexistent" })) as any;
    assert.equal(r2.offers.length, 0);
    a.close();
    b.close();
    rmSync(cwd, { recursive: true, force: true });
  } finally {
    await d.stop();
  }
});
