/**
 * Reconnect + update-staleness tests (issue #39): "TUI plugin fails to
 * reconnect after daemon/plugin update without an opencode restart".
 *
 * Diagnosis outcome (see the PR description): the reported incident is the
 * harness loading plugin code ONCE at startup (opencode never hot-reloads
 * plugins) — an update swaps the on-disk copy while the session keeps
 * executing the old code in memory. The feed's reconnect machinery itself
 * works. These tests pin down the surrounding behaviors that make that
 * diagnosis visible and close the real gaps found along the way:
 *
 *  - H3 (genuine bug, FIXED): a failed INITIAL connect wedged the feed in
 *    "connecting" forever — no socket was attached, so no close event could
 *    ever trigger the reconnect loop. Regression test: start a feed with
 *    spawnDaemon:false, fail, then bring a real daemon up late.
 *  - H1 repro: SIGKILL the daemon under a live feed; the client auto-spawns
 *    a replacement (same on-disk code) and the feed goes live again with a
 *    "daemon restarted" note — proving reconnect works when the plugin code
 *    in memory matches what is on disk.
 *  - "restarted onto vX" note: when the v1.3.0 handshake reports a different
 *    daemon version across a restart, the note says which version it
 *    restarted onto (mock FeedClient so we can force exact versions).
 *  - install drift: running copy older than the PATH CLI install is
 *    detected (fixture PATH) and surfaced as a surface-appropriate hint
 *    ("restart opencode to pick up vX" for the plugin).
 *  - H2 hardening: a vanished/unreadable daemon entry must fail the spawn
 *    probe ("did not come up") instead of crashing the host process with an
 *    uncaught ENOENT (subprocess test).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as P from "../shared/protocol.js";
import { DashboardFeed, type FeedClient } from "../dashboard/feed.js";
import { LLClient } from "../shared/client.js";
import { buildDashboardView, type DashboardInputs } from "../dashboard/view.js";
import { renderFrame } from "../dashboard/frame.js";
import {
  detectInstallDrift,
  pathInstall,
  resolveDaemonEntry,
  type InstallDrift,
} from "../shared/installs.js";
import { packageVersion } from "../shared/version.js";
import { daemonMainPath, delay, startDaemon, until, type DaemonHandle } from "./testutil.js";

const TMP_BASE = process.env.LL_TEST_TMP ?? join(tmpdir(), "opencode");

/** Kill whatever daemon currently owns the state dir (respawned daemons are not our child). */
function killDaemonFromJson(dir: string): void {
  try {
    const info = JSON.parse(readFileSync(join(dir, "daemon.json"), "utf8"));
    if (typeof info.pid === "number") {
      try {
        process.kill(info.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  } catch {
    /* no daemon.json — nothing to kill */
  }
}

// ---------------------------------------------------------------- H3 regression

test("feed: failed initial connect recovers once the daemon appears (issue #39 H3)", async () => {
  const dir = mkdtempSync(join(TMP_BASE, "ll-h3-"));
  const sock = join(dir, "daemon.sock");
  // spawnDaemon:false so the FIRST connect fails hard (no daemon, no spawn).
  const client = new LLClient({ socket: sock, stateDir: dir, spawnDaemon: false });
  const feed = new DashboardFeed(client, {
    reconnectBaseMs: 40,
    refreshDebounceMs: 5,
    slowRefreshMs: 60_000,
    inspectEveryMs: 60_000,
    driftCheckMs: 0,
  });
  await assert.rejects(feed.start(), /unavailable|not running/);
  // The reconnect loop re-enters "connecting" on each attempt; wait for the
  // failed attempt to land in "reconnecting" (old code: wedged in
  // "connecting" forever, so this alone catches the regression).
  await until("failed start enters the reconnect loop", () => feed.currentState() === "reconnecting");

  // Daemon shows up LATE. Before the fix, the feed stayed wedged in
  // "connecting" forever (no socket ever attached → no close event →
  // handleDisconnect never fired → no reconnect loop).
  const child = spawn(process.execPath, [daemonMainPath, "--state-dir", dir, "--socket", sock], {
    stdio: "ignore",
  });
  try {
    await until("feed goes live after late daemon spawn", () => feed.currentState() === "live");
    const v = feed.view();
    assert.ok(v.daemon, "daemon card present once live");
    assert.ok(v.daemon!.pid > 0);
  } finally {
    await feed.stop();
    child.kill("SIGKILL");
    await delay(200);
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- H1 repro

test("feed: SIGKILL daemon under live feed → auto-respawn and live again (issue #39 H1 repro)", async () => {
  const d: DaemonHandle = await startDaemon();
  let feed: DashboardFeed | null = null;
  try {
    // spawnDaemon defaults to true: the client auto-spawns a replacement.
    const client = new LLClient({ socket: d.sock, stateDir: d.dir });
    feed = new DashboardFeed(client, {
      reconnectBaseMs: 40,
      refreshDebounceMs: 5,
      slowRefreshMs: 60_000,
      inspectEveryMs: 60_000,
      driftCheckMs: 0,
      eventHistory: 100,
    });
    await feed.start();
    assert.equal(feed.currentState(), "live");
    const oldPid = feed.view().daemon?.pid;
    assert.ok(oldPid, "daemon pid visible before kill");

    d.child.kill("SIGKILL");
    await until("feed notices the daemon died", () => feed!.currentState() !== "live");
    // (State briefly reads "reconnecting" then "connecting" while the client
    // auto-spawns a replacement; the outcome assertion below is what counts.)

    // Reconnect machinery (existing code) + client auto-spawn bring it back.
    await until("feed is live again on the respawned daemon", () => feed!.currentState() === "live");
    const v = feed.view();
    assert.ok(v.daemon, "daemon card present after respawn");
    assert.notEqual(v.daemon!.pid, oldPid, "a NEW daemon process answered");
    assert.match(v.daemonRestartNote ?? "", /daemon restarted/);
    assert.equal(v.daemon!.daemonVersion, packageVersion(), "respawned daemon runs the current code");
  } finally {
    await feed?.stop();
    // The respawned daemon is nobody's child — kill via its state dir.
    killDaemonFromJson(d.dir);
    await d.stop();
  }
});

// ------------------------------------------------- restart-note version change

/** Switchable mock daemon for resync-level tests (no real processes). */
class MockClient implements FeedClient {
  daemon: { pid: number; startedAt: number; protocolVersion: number; daemonVersion?: string };
  events: P.MachineEvent[];
  latestEventId: number;
  private watcher: ((ev: Record<string, unknown>) => void) | null = null;

  constructor(version: string | undefined) {
    this.daemon = { pid: 111, startedAt: 1_000, protocolVersion: 1, daemonVersion: version };
    this.events = [{ id: 1, ts: 1_000, type: "daemon_started" } as P.MachineEvent];
    this.latestEventId = 1;
  }

  async connect(): Promise<void> {}

  async request<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (method === "status") {
      return {
        daemon: this.daemon,
        config: {
          version: 1,
          pools: {},
          offerTimeoutMs: 30_000,
          maxWaitMs: 600_000,
          maxTurnWaitMs: 600_000,
          startTimeoutMs: 600_000,
          untrackedLeaseMs: 600_000,
        },
        pools: [],
        events: { latestEventId: this.latestEventId },
      } as T;
    }
    if (method === "events") {
      const since = (params.sinceEventId as number) ?? 0;
      return {
        events: this.events.filter((e) => e.id > since),
        latestEventId: this.latestEventId,
      } as T;
    }
    if (method === "watch") return {} as T;
    throw new Error(`mock: unsupported method ${method}`);
  }

  async watch(_agentId: string, onEvent: (ev: Record<string, unknown>) => void): Promise<void> {
    this.watcher = onEvent;
  }

  onDisconnect(): () => void {
    return () => {};
  }

  close(): void {}

  /** Simulate a daemon restart, optionally onto a different version. */
  restart(newVersion: string | undefined): void {
    this.daemon = { pid: 222, startedAt: 2_000, protocolVersion: 1, daemonVersion: newVersion };
    this.events = [{ id: 1, ts: 2_000, type: "daemon_recovered" } as P.MachineEvent];
    this.latestEventId = 1;
  }
}

function mockFeed(c: MockClient): DashboardFeed {
  return new DashboardFeed(c, {
    slowRefreshMs: 0,
    driftCheckMs: 0,
    refreshDebounceMs: 60_000,
    inspectEveryMs: 60_000,
  });
}

test("resync: daemon restart onto a DIFFERENT version says 'restarted onto vX (was vY)'", async () => {
  const c = new MockClient("1.4.0");
  const feed = mockFeed(c);
  await feed.start();
  assert.equal(feed.currentState(), "live");
  assert.equal(feed.view().daemonRestartNote, undefined, "no note before any restart");

  c.restart("1.5.0");
  await feed.resync();
  const note = feed.view().daemonRestartNote ?? "";
  assert.match(note, /daemon restarted onto v1\.5\.0/);
  assert.match(note, /was v1\.4\.0/);
  await feed.stop();
});

test("resync: same-version daemon restart keeps the plain pid-only note", async () => {
  const c = new MockClient("1.4.0");
  const feed = mockFeed(c);
  await feed.start();
  c.restart("1.4.0");
  await feed.resync();
  const note = feed.view().daemonRestartNote ?? "";
  assert.match(note, /daemon restarted/);
  assert.doesNotMatch(note, /onto/);
  await feed.stop();
});

test("resync: pre-handshake daemon (no version) never gets an 'onto' note", async () => {
  const c = new MockClient("1.4.0");
  const feed = mockFeed(c);
  await feed.start();
  c.restart(undefined); // old daemon: daemonVersion absent
  await feed.resync();
  const note = feed.view().daemonRestartNote ?? "";
  assert.match(note, /daemon restarted/);
  assert.doesNotMatch(note, /onto/);
  await feed.stop();
});

// ---------------------------------------------------------------- install drift

/** Fixture PATH dir containing a fake `load-lock` install of `version`. */
function pathFixture(version: string | null): string {
  const dir = mkdtempSync(join(TMP_BASE, "ll-pathfix-"));
  if (version === null) return dir; // empty dir: no bin, no package
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@aron98/load-lock", version }));
  const bin = join(dir, "load-lock");
  writeFileSync(bin, "#!/bin/sh\nexit 0\n");
  chmodSync(bin, 0o755);
  return dir;
}

test("detectInstallDrift: PATH CLI newer than this copy ⇒ stale", () => {
  const dir = pathFixture("99.0.0");
  try {
    const drift = detectInstallDrift(process.platform, { PATH: dir });
    assert.equal(drift.pathVersion, "99.0.0");
    assert.ok(drift.stale, "99.0.0 > " + drift.ownVersion);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("detectInstallDrift: same version ⇒ not stale; no PATH install ⇒ null", () => {
  const same = pathFixture(packageVersion());
  const empty = pathFixture(null);
  try {
    const drift = detectInstallDrift(process.platform, { PATH: same });
    assert.equal(drift.pathVersion, packageVersion());
    assert.ok(!drift.stale);

    const none = detectInstallDrift(process.platform, { PATH: empty });
    assert.equal(none.pathVersion, null);
    assert.ok(!none.stale);
  } finally {
    rmSync(same, { recursive: true, force: true });
    rmSync(empty, { recursive: true, force: true });
  }
});

test("pathInstall: resolves through the fixture PATH dir", () => {
  const dir = pathFixture("99.0.0");
  try {
    const inst = pathInstall(process.platform, { PATH: dir });
    assert.ok(inst, "fixture install found");
    assert.equal(inst!.path, dir);
    assert.equal(inst!.version, "99.0.0");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function viewInputs(drift: InstallDrift | null, surface?: "cli" | "opencode"): DashboardInputs {
  return {
    status: null,
    inspect: null,
    events: [],
    latestEventId: 0,
    state: "live",
    lastSyncAt: Date.now(),
    installDrift: drift,
    driftSurface: surface,
    now: 1_760_000_000_000,
  };
}

const STALE_DRIFT: InstallDrift = { ownVersion: "1.4.0", pathVersion: "99.0.0", stale: true };

test("view: drift note for the opencode surface says 'restart opencode to pick up vX'", () => {
  const v = buildDashboardView(viewInputs(STALE_DRIFT, "opencode"));
  assert.match(v.installDriftNote ?? "", /plugin updated — restart opencode to pick up v99\.0\.0/);
  assert.match(v.installDriftNote ?? "", /this session still runs v1\.4\.0/);
});

test("view: default (cli) drift note calls out the stale install", () => {
  const v = buildDashboardView(viewInputs(STALE_DRIFT));
  assert.match(v.installDriftNote ?? "", /PATH CLI v99\.0\.0 is newer than this copy v1\.4\.0/);
  assert.match(v.installDriftNote ?? "", /stale install/);
});

test("view: no drift note when not stale or unknown", () => {
  assert.equal(buildDashboardView(viewInputs({ ownVersion: "1.4.0", pathVersion: "1.4.0", stale: false })).installDriftNote, undefined);
  assert.equal(buildDashboardView(viewInputs({ ownVersion: "1.4.0", pathVersion: null, stale: false })).installDriftNote, undefined);
  assert.equal(buildDashboardView(viewInputs(null)).installDriftNote, undefined);
});

test("frame: drift note renders as a `note:` line", () => {
  const v = buildDashboardView(viewInputs(STALE_DRIFT, "opencode"));
  const lines = renderFrame(v, 160).join("\n");
  assert.match(lines, /note: plugin updated — restart opencode to pick up v99\.0\.0/);
});

// ------------------------------------------------------------ resolveDaemonEntry

test("resolveDaemonEntry: own entry wins when it exists", () => {
  assert.equal(resolveDaemonEntry(daemonMainPath, process.platform, { PATH: "" }), daemonMainPath);
});

test("resolveDaemonEntry: vanished own entry falls back to the PATH install", () => {
  const dir = pathFixture("99.0.0");
  try {
    const nested = join(dir, "dist", "core");
    mkdirSync(nested, { recursive: true });
    const entry = join(nested, "daemon-main.js");
    writeFileSync(entry, "// fixture daemon entry\n");
    const own = join(dir, "does-not-exist", "daemon-main.js");
    assert.ok(!existsSync(own));
    assert.equal(resolveDaemonEntry(own, process.platform, { PATH: dir }), entry);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveDaemonEntry: vanished own entry with no usable PATH install → own unchanged", () => {
  const empty = pathFixture(null);
  try {
    const own = join(empty, "gone", "daemon-main.js");
    assert.equal(resolveDaemonEntry(own, process.platform, { PATH: empty }), own);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

// --------------------------------------------------------------------- H2

test("ensureDaemon: unreadable daemon entry fails the probe, does not crash the host (issue #39 H2)", async () => {
  const dir = mkdtempSync(join(TMP_BASE, "ll-h2-"));
  const sock = join(dir, "daemon.sock");
  // The child imports the COMPILED client and calls ensureDaemon with a
  // daemon entry that cannot spawn (ENOENT). Without the spawn error
  // listener, the 'error' event on the detached child is an uncaught
  // exception and the process dies before it can report anything.
  const script = join(dir, "child.mjs");
  writeFileSync(
    script,
    `import { ensureDaemon } from ${JSON.stringify(
      new URL("../shared/client.js", import.meta.url).href,
    )};\ntry {\n  await ensureDaemon(${JSON.stringify(dir)}, ${JSON.stringify(sock)});\n  console.log("unexpected: spawned");\n} catch (e) {\n  console.log("code=" + (e && e.code) + " msg=" + (e && e.message));\n}\n`,
  );
  const child = spawn(process.execPath, ["--no-warnings", script], {
    env: {
      ...process.env,
      LOAD_LOCK_DAEMON_BIN: "/nonexistent/load-lock-daemon-main.js",
      LOAD_LOCK_STATE_DIR: dir,
      LOAD_LOCK_SOCKET: sock,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout!.on("data", (b) => (out += b));
  let err = "";
  child.stderr!.on("data", (b) => (err += b));
  const code: number | null = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(-1);
    }, 30_000);
    child.once("exit", (c) => {
      clearTimeout(timer);
      resolve(c);
    });
  });
  try {
    assert.equal(code, 0, `child must exit cleanly (stderr: ${err})`);
    assert.match(out, /unavailable/);
    assert.match(out, /did not come up/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
