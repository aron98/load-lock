/**
 * Dashboard tests (issue #10): the data plumbing behind `load-lock top`
 * and the OpenCode TUI plugin panel.
 *
 *  - view-model shaping (buildDashboardView) against protocol fixtures,
 *    with "now" pinned so countdowns are deterministic
 *  - formatters (fmtDuration / fmtBytes) and the utilization bar
 *  - event one-liners (eventText)
 *  - frame renderer bounds (width clamp, height slice)
 *  - DashboardFeed against a REAL daemon: live view, queue visibility,
 *    release, resync idempotence, and reconnect + event-cursor resume
 *    across a daemon SIGKILL -> fresh-daemon-on-the-same-socket restart
 *  - `load-lock top --once` smoke test (read-only, never acquires)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";
import type * as P from "../shared/protocol.js";
import { DashboardFeed } from "../dashboard/feed.js";
import { renderFrame, utilizationBar } from "../dashboard/frame.js";
import { buildDashboardView, eventText, fmtBytes, fmtDuration, type DashboardInputs } from "../dashboard/view.js";
import { daemonMainPath, delay, probe, runCli, startDaemon, until } from "./testutil.js";

const NOW = 1_760_000_000_000;

// ----------------------------------------------------------------- fixtures

function holder(): P.EntrySnapshot {
  return {
    requestId: "req_holder_000001",
    pool: "heavy",
    agentId: "agent-a",
    agentLabel: "claude-verify",
    cwd: "/w",
    opKey: "docker-build",
    reason: "docker build of harness images",
    weight: 1,
    state: "held",
    phase: "running_tracked",
    since: NOW - 30_000,
    pid: 111,
    pgid: 111,
    heldFor: 30_000,
  };
}

function statusFixture(): P.StatusResult {
  return {
    daemon: { pid: 4242, startedAt: NOW - 90_000, protocolVersion: 1 },
    config: {
      version: 3,
      pools: {},
      offerTimeoutMs: 30_000,
      maxWaitMs: 60_000,
      startTimeoutMs: 60_000,
      untrackedLeaseMs: 60_000,
    },
    pools: [
      {
        pool: "heavy",
        capacity: 2,
        used: 2,
        holders: [holder()],
        offers: [
          {
            requestId: "req_offer_000001",
            pool: "heavy",
            agentId: "agent-b",
            opKey: "npm-test",
            reason: "npm test",
            weight: 1,
            state: "offered",
            since: NOW - 2_000,
            offerExpiresAt: NOW + 28_000,
          },
        ],
        queue: [
          {
            requestId: "req_queue_000001",
            pool: "heavy",
            agentId: "agent-c",
            opKey: "npm-ci",
            reason: "npm ci",
            weight: 1,
            state: "queued",
            since: NOW - 5_000,
            position: 1,
          },
        ],
        paused: [
          {
            requestId: "req_paused_000001",
            pool: "heavy",
            agentId: "agent-d",
            opKey: "build",
            reason: "docker build images",
            weight: 1,
            state: "paused",
            since: NOW - 45_000,
          },
        ],
      },
    ],
    events: { latestEventId: 7 },
  };
}

function inspectFixture(): P.InspectResult {
  return {
    cpu: {
      logicalCores: 16,
      model: "Test CPU",
      loadavg: [0.4, 0.3, 0.25],
      cgroupVersion: "2",
      cgroupCpuQuota: 200,
      effectiveCores: 2,
      loadPerEffectiveCore: 0.2,
    },
    memory: {
      totalBytes: 34359738368,
      availableBytes: 8000000000,
      freeBytes: 7000000000,
      effectiveLimitBytes: 17179869184,
    },
    pressure: { note: "cgroup limits apply", loadPressure: "low", memPressure: "moderate" },
    loadLock: { pools: {}, suggestion: "1 parallel heavy job fits the quota" },
  };
}

function eventsFixture(): P.MachineEvent[] {
  return [
    {
      id: 5,
      ts: NOW - 1_000,
      type: "claimed",
      pool: "heavy",
      entry: holder(),
    },
    {
      id: 6,
      ts: NOW - 500,
      type: "started",
      pool: "heavy",
      entry: holder(),
      detail: "tracked pid 111",
    },
    {
      id: 7,
      ts: NOW - 100,
      type: "config_changed",
      detail: "by aron98: bump heavy capacity to 2",
    },
  ];
}

function inputs(over: Partial<DashboardInputs> = {}): DashboardInputs {
  return {
    status: statusFixture(),
    inspect: inspectFixture(),
    events: eventsFixture(),
    latestEventId: 7,
    state: "live",
    lastSyncAt: NOW - 250,
    now: NOW,
    ...over,
  };
}

// --------------------------------------------------------------- formatters

test("fmtDuration covers ms..days and negatives", () => {
  assert.equal(fmtDuration(412), "412ms");
  assert.equal(fmtDuration(3_000), "3s");
  assert.equal(fmtDuration(252_000), "4m 12s");
  assert.equal(fmtDuration(7_500_000), "2h 05m");
  assert.equal(fmtDuration((3 * 86_400 + 4 * 3_600) * 1000), "3d 4h");
  assert.equal(fmtDuration(-500), "-500ms");
});

test("fmtBytes is compact and clamps units", () => {
  assert.equal(fmtBytes(512), "512B");
  assert.equal(fmtBytes(512 * 1024), "512Ki");
  assert.equal(fmtBytes(12.4 * 1024 ** 3), "12.4Gi");
  assert.equal(fmtBytes(200 * 1024 ** 2), "200Mi");
});

test("utilizationBar clamps and fills", () => {
  assert.equal(utilizationBar(0.5, 10), "#####-----");
  assert.equal(utilizationBar(1.5, 10), "##########");
  assert.equal(utilizationBar(-1, 10), "----------");
  assert.equal(utilizationBar(0, 0).length, 3); // width floor of 3
});

// ---------------------------------------------------------------- eventText

test("eventText renders one-liners per event type", () => {
  assert.equal(
    eventText({ id: 6, ts: 0, type: "started", entry: holder(), detail: "tracked pid 111" }),
    "started claude-verify: tracked pid 111",
  );
  assert.match(
    eventText({ id: 2, ts: 0, type: "offer_expired", pool: "heavy" }),
    /paused \(rejoin to requeue\)/,
  );
  assert.equal(
    eventText({ id: 7, ts: 0, type: "config_changed", detail: "by aron98: bump capacity" }),
    "config changed: by aron98: bump capacity",
  );
  assert.equal(
    eventText({
      id: 1,
      ts: 0,
      type: "released",
      pool: "heavy",
      entry: {
        requestId: "r",
        pool: "heavy",
        agentId: "agent-x",
        opKey: "k",
        reason: "npm test",
        weight: 1,
        state: "released",
        since: 0,
      },
    }),
    "released heavy agent-x (npm test)",
  );
});

// ------------------------------------------------------------ view shaping

test("buildDashboardView shapes pools, cards, machine and events", () => {
  const v = buildDashboardView(inputs());
  assert.equal(v.state, "live");
  assert.equal(v.latestEventId, 7);
  assert.equal(v.daemon?.pid, 4242);
  assert.equal(v.daemon?.uptimeMs, 90_000);
  assert.equal(v.daemon?.configVersion, 3);

  const pool = v.pools[0]!;
  assert.equal(pool.pool, "heavy");
  assert.equal(pool.capacity, 2);
  assert.equal(pool.used, 2);
  assert.equal(pool.free, 0);
  assert.equal(pool.utilization, 1);
  assert.equal(pool.heldWeight, 1);
  assert.equal(pool.offeredWeight, 1);

  const h = pool.holders[0]!;
  assert.equal(h.agent, "claude-verify");
  assert.equal(h.phase, "running_tracked");
  assert.equal(h.phaseLabel, "running (tracked)");
  assert.equal(h.pid, 111);
  assert.equal(h.heldMs, 30_000);
  assert.equal(h.startDeadlineInMs, undefined); // only for claimed

  const o = pool.offers[0]!;
  assert.equal(o.agentId, "agent-b");
  assert.equal(o.claimInMs, 28_000);

  const q = pool.queue[0]!;
  assert.equal(q.position, 1);
  assert.equal(q.waitMs, 5_000);

  assert.equal(pool.paused[0]!.pausedMs, 45_000);

  assert.equal(v.machine?.effectiveCores, 2);
  assert.equal(v.machine?.cgroupCpuQuota, 200);
  assert.equal(v.machine?.memPressure, "moderate");
  assert.equal(v.machine?.suggestion, "1 parallel heavy job fits the quota");

  // events are newest-first with agoMs relative to now
  assert.deepEqual(
    v.events.map((e) => e.id),
    [7, 6, 5],
  );
  assert.equal(v.events[2]!.agoMs, 1_000);
});

test("buildDashboardView tolerates missing status/inspect and carries the restart note", () => {
  const v = buildDashboardView(inputs({ status: null, inspect: null, state: "reconnecting", daemonRestartNote: "daemon restarted (pid 7); event history re-synced" }));
  assert.equal(v.daemon, null);
  assert.equal(v.machine, null);
  assert.deepEqual(v.pools, []);
  assert.equal(v.state, "reconnecting");
  assert.match(v.daemonRestartNote ?? "", /daemon restarted/);
});

// ------------------------------------------------------------ frame bounds

test("renderFrame clamps width and height", () => {
  const v = buildDashboardView(inputs());
  for (const [w, h] of [
    [60, 20],
    [100, 40],
    [10, 10], // width floors at 48
  ] as const) {
    const maxW = Math.max(48, Math.min(w, 240));
    const lines = renderFrame(v, w, h);
    assert.ok(lines.length <= h, `height respected for ${w}x${h}`);
    for (const line of lines) assert.ok(line.length <= maxW, `width respected for ${w}x${h}`);
  }
  const tall = renderFrame(v, 100, 1000);
  assert.ok(tall.some((l) => l.includes("POOL heavy")));
  assert.ok(tall.some((l) => l.includes("EVENTS (newest first)")));
  assert.ok(tall.some((l) => l.includes("HELD   claude-verify")));
  assert.ok(tall.some((l) => l.includes("OFFER  agent-b")));
  assert.ok(tall.some((l) => l.includes("QUEUE  #1")));
  assert.ok(tall.some((l) => l.includes("PAUSED agent-d")));
});

// -------------------------------------------------- feed against a real daemon

/** Kill the daemon handle's child hard (SIGKILL) and wait for exit. */
async function killDaemon(child: ChildProcess): Promise<void> {
  child.kill("SIGKILL");
  if (child.exitCode === null) {
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  }
}

test("feed: live view, queue, release, cursor resume across a daemon restart", async () => {
  const d = await startDaemon();
  const feed = new DashboardFeed(d.client(), {
    refreshDebounceMs: 5,
    reconnectBaseMs: 40,
    slowRefreshMs: 60_000,
    inspectEveryMs: 10_000,
    eventHistory: 100,
  });
  let child2: ChildProcess | null = null;
  try {
    await feed.start();
    assert.equal(feed.currentState(), "live");

    const ctl = d.client();
    const granted = (await ctl.request<P.AcquireResult>("acquire", {
      agentId: "agent-a",
      agentLabel: "holder-agent",
      opKey: "build-a",
      reason: "integration test heavy build",
    })) as Extract<P.AcquireResult, { state: "granted" }>;
    assert.equal(granted.state, "granted");
    const tokenA = granted.entry.permitToken!;

    // Associate the pid via the documented flow (acquire -> start_job).
    // Note: `AcquireParams.pid` is a deprecated shorthand the daemon does
    // not implement — start_job is the supported association path.
    await ctl.request("start_job", { permitToken: tokenA, pid: process.pid });

    await until("holder card visible (tracked)", () => feed.view().pools[0]?.holders[0]?.phase === "running_tracked");
    const card = feed.view().pools[0]!.holders[0]!;
    assert.equal(card.agent, "holder-agent");
    assert.equal(card.phase, "running_tracked");
    assert.equal(card.pid, process.pid);

    // Regression (watch_started cursor bug): the daemon's watch confirmation
    // reports the full latestEventId, but the feed must NOT adopt it as its
    // cursor — the initial sync still has to pull the whole event history.
    await until("event feed populated from history", () => feed.view().events.length > 0);
    assert.ok(
      feed.view().events.some((e) => e.text.includes("daemon started")),
      "daemon_started from history must be in the feed",
    );
    assert.ok(
      feed.view().events.some((e) => e.text.includes("holder-agent")),
      "the grant/claim events for holder-agent must be in the feed",
    );

    // second acquire queues (capacity 1 by default)
    const queued = (await ctl.request<P.AcquireResult>("acquire", {
      agentId: "agent-b",
      agentLabel: "queued-agent",
      opKey: "test-b",
      reason: "npm test suite",
      waitMs: 200,
    })) as Extract<P.AcquireResult, { state: "queued" }>;
    assert.equal(queued.state, "queued");
    await until("queue card visible", () => feed.view().pools[0]?.queue.length === 1);
    assert.equal(feed.view().pools[0]!.queue[0]!.agent, "queued-agent");

    // resync is idempotent: repeated pulls never duplicate event ids
    await feed.resync();
    await feed.resync();
    const ids = feed.view().events.map((e) => e.id);
    assert.equal(new Set(ids).size, ids.length, "no duplicate event ids after repeated resync");

    // release frees capacity; FIFO immediately reserves it for the queued
    // head (agent-b) as an offer — the feed must surface the offer card live.
    await ctl.request("release", { permitToken: tokenA, outcome: "success" });
    await until("holder released", () => feed.view().pools[0]?.holders.length === 0);
    await until("queued head receives the offer", () => feed.view().pools[0]?.offers.length === 1);
    const offer = feed.view().pools[0]!.offers[0]!;
    assert.equal(offer.agent, "queued-agent");
    assert.ok(offer.claimInMs > 0, "claim-window countdown is live");

    // retire the queued request so capacity frees up for the next acquire
    await ctl.request("cancel", { requestId: queued.entry.requestId });
    await until(
      "offer and queue drained after cancel",
      () =>
        (feed.view().pools[0]?.offers.length ?? 0) + (feed.view().pools[0]?.queue.length ?? 0) === 0,
    );

    // hold again so the journal has a permit to restore across the restart
    const granted2 = (await ctl.request<P.AcquireResult>("acquire", {
      agentId: "agent-a",
      agentLabel: "holder-agent",
      opKey: "build-a2",
      reason: "survives daemon restart",
    })) as Extract<P.AcquireResult, { state: "granted" }>;
    const tokenA2 = granted2.entry.permitToken!;
    await ctl.request("start_job", { permitToken: tokenA2, pid: process.pid });
    await until("second holder visible (tracked)", () => feed.view().pools[0]?.holders[0]?.phase === "running_tracked");

    const oldPid = feed.view().daemon?.pid;
    await killDaemon(d.child); // SIGKILL: no clean shutdown

    await until("feed notices the loss", () => feed.currentState() === "reconnecting");

    // fresh daemon on the SAME state dir + socket (journal recovery path)
    child2 = spawn(process.execPath, [daemonMainPath, "--state-dir", d.dir, "--socket", d.sock], {
      env: d.env,
      stdio: "ignore",
    });
    await until("replacement daemon is up", () => probe(d.sock));
    await until("feed is live again", () => feed.currentState() === "live");

    const v = feed.view();
    assert.notEqual(v.daemon?.pid, oldPid);
    assert.match(v.daemonRestartNote ?? "", /daemon restarted/);
    // event ids restarted from ~1 and the cursor reset with them
    assert.ok(v.latestEventId < 20, `cursor reset across restart (got #${v.latestEventId})`);
    // journal recovered the held permit and the event feed re-synced
    await until("recovered holder visible", () => feed.view().pools[0]?.holders.length === 1);
    const texts = feed.view().events.map((e) => e.text).join("\n");
    assert.match(texts, /daemon recovered/);

    // live updates still flow against the new daemon
    const ctl2 = d.client();
    await ctl2.request("release", { permitToken: tokenA2, outcome: "success" });
    await until("post-restart release reflected", () => feed.view().pools[0]?.holders.length === 0);
    ctl2.close();
    ctl.close();
  } finally {
    await feed.stop();
    if (child2 && child2.exitCode === null) {
      child2.kill("SIGKILL");
      await new Promise<void>((resolve) => child2!.once("exit", () => resolve()));
    }
    rmSync(d.dir, { recursive: true, force: true });
    d.child.kill("SIGKILL");
  }
});

// ------------------------------------------------------------- top smoke

test("load-lock top --once renders one frame and exits clean", async () => {
  const d = await startDaemon();
  try {
    const r = await runCli(d, ["top", "--once"]);
    assert.equal(r.code, 0);
    assert.ok(r.stdout.includes("load-lock top"), "banner present");
    assert.ok(r.stdout.includes("POOL heavy"), "pool line present");
    assert.ok(r.stdout.includes("q quit"), "footer present");
    assert.ok(r.stdout.includes("never acquires a permit"), "read-only note present");
  } finally {
    await d.stop();
  }
});
