/**
 * Unit tests for the cross-platform transport seam (src/shared/transport.ts)
 * and its integration into state-dir/socket-path resolution (persist.ts).
 *
 * These tests run on Linux: the Windows branches are exercised by
 * explicitly injecting platform = "win32" into the pure functions. No
 * Windows machine was available for live verification — see
 * docs/COMPATIBILITY.md (platform matrix).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:net";
import { spawn } from "node:child_process";
import {
  DEFAULT_PIPE_NAME,
  isWindows,
  namedPipePath,
  resolveStateDir,
  resolveSocketPath,
  probeTransport,
  removeStaleEndpoint,
  killProcessGroup,
} from "../shared/transport.js";
import { stateDir, socketPath } from "../core/persist.js";
import { isProcessAlive, jobAlive, aliveBySignalZero, processStartTime, livenessChecker } from "../core/daemon.js";
import type { PsRunner } from "../shared/identity.js";

const TMP_BASE = process.env.LL_TEST_TMP ?? join(tmpdir(), "opencode");
mkdirSync(TMP_BASE, { recursive: true });
const tmp = mkdtempSync(join(TMP_BASE, "ll-platform-"));

test("namedPipePath builds \\\\.\\pipe\\load-lock by default", () => {
  assert.equal(namedPipePath(), "\\\\.\\pipe\\load-lock");
  assert.equal(namedPipePath(), `\\\\.\\pipe\\${DEFAULT_PIPE_NAME}`);
  assert.equal(namedPipePath("other"), "\\\\.\\pipe\\other");
});

test("isWindows only matches win32", () => {
  assert.equal(isWindows("win32" as NodeJS.Platform), true);
  assert.equal(isWindows("linux" as NodeJS.Platform), false);
  assert.equal(isWindows("darwin" as NodeJS.Platform), false);
});

test("resolveStateDir: override wins over env and default", () => {
  const env = { LOAD_LOCK_STATE_DIR: "/from-env", HOME: "/home/u" };
  assert.equal(resolveStateDir("win32", env, "/explicit"), "/explicit");
  assert.equal(resolveStateDir("linux", env, "/explicit"), "/explicit");
  assert.equal(resolveStateDir("win32", env), "/from-env");
});

test("resolveStateDir: win32 uses LOCALAPPDATA, then USERPROFILE fallback", () => {
  const env = { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local", USERPROFILE: "C:\\Users\\u" };
  assert.equal(resolveStateDir("win32", env), "C:\\Users\\u\\AppData\\Local\\load-lock");
  const env2 = { USERPROFILE: "C:\\Users\\u" };
  assert.equal(resolveStateDir("win32", env2), "C:\\Users\\u\\AppData\\Local\\load-lock");
});

test("resolveStateDir: linux uses XDG_STATE_HOME, then HOME fallback", () => {
  const env = { XDG_STATE_HOME: "/xdg/state", HOME: "/home/u" };
  assert.equal(resolveStateDir("linux", env), "/xdg/state/load-lock");
  const env2 = { HOME: "/home/u" };
  assert.equal(resolveStateDir("linux", env2), "/home/u/.local/state/load-lock");
});

test("resolveSocketPath: win32 default is the named pipe", () => {
  const env = { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" };
  assert.equal(resolveSocketPath("win32", env), "\\\\.\\pipe\\load-lock");
});

test("resolveSocketPath: LOAD_LOCK_SOCKET override wins on every platform", () => {
  const env = { LOAD_LOCK_SOCKET: "C:\\somewhere\\other.sock" };
  assert.equal(resolveSocketPath("win32", env), "C:\\somewhere\\other.sock");
  assert.equal(resolveSocketPath("linux", env), "C:\\somewhere\\other.sock");
});

test("resolveSocketPath: linux default is <state dir>/daemon.sock", () => {
  const env = { HOME: "/home/u" };
  assert.equal(resolveSocketPath("linux", env), "/home/u/.local/state/load-lock/daemon.sock");
});

test("resolveSocketPath: explicit override wins over everything", () => {
  const env = { LOAD_LOCK_SOCKET: "/from-env", LOAD_LOCK_STATE_DIR: "/s" };
  assert.equal(resolveSocketPath("linux", env, "/explicit"), "/explicit");
});

test("persist stateDir()/socketPath() delegate with the real platform", () => {
  // On Linux (the only platform these tests run on) the defaults must keep
  // their current shape, and env overrides must flow through.
  const savedState = process.env.LOAD_LOCK_STATE_DIR;
  const savedSock = process.env.LOAD_LOCK_SOCKET;
  try {
    delete process.env.LOAD_LOCK_STATE_DIR;
    delete process.env.LOAD_LOCK_SOCKET;
    assert.equal(socketPath(), resolveSocketPath(process.platform, process.env));
    assert.equal(stateDir(), resolveStateDir(process.platform, process.env));
    process.env.LOAD_LOCK_SOCKET = "/tmp/opencode/ll-platform-override.sock";
    assert.equal(socketPath(), "/tmp/opencode/ll-platform-override.sock");
    assert.equal(socketPath("/cli-flag.sock"), "/cli-flag.sock");
  } finally {
    if (savedState === undefined) delete process.env.LOAD_LOCK_STATE_DIR;
    else process.env.LOAD_LOCK_STATE_DIR = savedState;
    if (savedSock === undefined) delete process.env.LOAD_LOCK_SOCKET;
    else process.env.LOAD_LOCK_SOCKET = savedSock;
  }
});

async function withUdsServer(fn: (sockPath: string, server: Server) => Promise<void>): Promise<void> {
  const sockPath = join(tmp, "probe.sock");
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(sockPath, resolve));
  try {
    await fn(sockPath, server);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(sockPath, { force: true });
  }
}

test("probeTransport: true for a live server, false after close", async () => {
  await withUdsServer(async (sockPath, server) => {
    assert.equal(await probeTransport(sockPath), true);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    assert.equal(await probeTransport(sockPath), false);
  });
});

test("probeTransport: false for a nonexistent endpoint (never throws)", async () => {
  assert.equal(await probeTransport(join(tmp, "no-such.sock")), false);
});

test("removeStaleEndpoint: POSIX unlinks, win32 is a no-op", () => {
  const stale = join(tmp, "stale.sock");
  writeFileSync(stale, "");
  removeStaleEndpoint(stale, "linux");
  assert.equal(existsSync(stale), false);

  const stale2 = join(tmp, "stale2.sock");
  writeFileSync(stale2, "");
  removeStaleEndpoint(stale2, "win32");
  assert.equal(existsSync(stale2), true); // untouched on Windows
  rmSync(stale2, { force: true });

  // Missing file: must not throw.
  removeStaleEndpoint(join(tmp, "never-there.sock"), "linux");
});

test("killProcessGroup: POSIX path kills a detached process group", async () => {
  const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
  child.unref();
  const pid = child.pid!;
  // Give the process a moment to be scheduled.
  await new Promise((r) => setTimeout(r, 100));
  killProcessGroup(pid, "SIGKILL", "linux");
  const exited = await new Promise<boolean>((resolve) => {
    const t = setTimeout(() => resolve(false), 5000);
    child.once("exit", () => {
      clearTimeout(t);
      resolve(true);
    });
  });
  assert.equal(exited, true);
});

test("killProcessGroup: win32 branch on Linux swallows taskkill failure", () => {
  // taskkill does not exist on Linux; the spawn must not throw.
  assert.doesNotThrow(() => killProcessGroup(12345, "SIGKILL", "win32"));
  assert.doesNotThrow(() => killProcessGroup(12345, "SIGTERM", "win32"));
});

test("killProcessGroup: POSIX path tolerates a dead pgid", () => {
  assert.doesNotThrow(() => killProcessGroup(999_999, "SIGKILL", "linux"));
});

// ------------------------------------------------------------- liveness (win32)

test("isProcessAlive: win32 branch uses signal-0 semantics (injected platform)", () => {
  assert.equal(isProcessAlive(process.pid, undefined, "win32"), true);
  // A start time can't be verified without /proc — pid must still count as
  // alive (conservative; the pid-reuse defense is documented as absent).
  assert.equal(isProcessAlive(process.pid, "9999", "win32"), true);
  // 4194303 is the Windows ceiling; a pid that high is never in use here.
  assert.equal(isProcessAlive(4_194_303, undefined, "win32"), false);
});

test("aliveBySignalZero: own pid alive, pid 1 alive (ours or EPERM), huge pid dead", () => {
  assert.equal(aliveBySignalZero(process.pid), true);
  // On Linux init is owned by root: signal 0 yields EPERM, which must count
  // as alive. On a container where we are root, it trivially succeeds.
  assert.equal(aliveBySignalZero(1), true);
  assert.equal(aliveBySignalZero(4_194_303), false);
});

// The start-time check and the process-group scan need /proc (Linux) or the
// ps reader (macOS, issue #116); Windows falls back to signal 0.
const PLATFORM = process.platform;
const NO_PROC_OR_PS = PLATFORM !== "linux" && PLATFORM !== "darwin" && "needs /proc (Linux) or ps (macOS)";

test("isProcessAlive: start time defeats pid reuse (Linux /proc, macOS ps)", { skip: NO_PROC_OR_PS }, () => {
  const st = processStartTime(process.pid, PLATFORM);
  assert.ok(st !== undefined, "start time must be readable");
  assert.equal(isProcessAlive(process.pid, st, PLATFORM), true);
  assert.equal(isProcessAlive(process.pid, "9999", PLATFORM), false); // mismatch = reuse
});

test("jobAlive: win32 skips the process-group scan", () => {
  assert.equal(jobAlive(process.pid, undefined, undefined, "win32"), true);
  // Dead main pid: released even though a group scan would have been
  // possible on Linux — Windows has no process groups.
  assert.equal(jobAlive(4_194_303, process.pid, undefined, "win32"), false);
  // pgid-only on win32: unknown => conservative keep.
  assert.equal(jobAlive(undefined, 12345, undefined, "win32"), null);
});

test("jobAlive: scans process groups (Linux /proc, macOS ps)", { skip: NO_PROC_OR_PS }, () => {
  assert.equal(jobAlive(process.pid, undefined, undefined, PLATFORM), true);
  // pgid 1 (init/launchd) exists: a dead pid + live pgid keeps the job
  // "alive" via the group scan.
  assert.equal(jobAlive(4_194_303, 1, undefined, PLATFORM), true);
  // Both dead => false (group 999999 has no members).
  assert.equal(jobAlive(4_194_303, 999_999, undefined, PLATFORM), false);
});

// ------------------------------------------------- liveness (macOS, fake ps)
// Issue #116: macOS liveness reads one `ps -A -o pid=,pgid=,lstart=` table
// per batch. Pids >= 4_000_000 are never in use, so a row in the fake table
// is the only thing that can make them alive.

const LSTART_A = "Fri Nov 27 17:15:58 2026";
const LSTART_B = "Fri Nov 27 17:16:30 2026";
const secs = (lstart: string) => String(Math.floor(Date.parse(lstart) / 1000));

/** Fake ps: answers the table query and the per-pid stat query from rows [pid, pgid, lstart]. */
function fakePsTable(rows: [number, number, string][], calls?: string[][]): PsRunner {
  return (args) => {
    calls?.push(args);
    if (args.join(" ") === "-A -o pid=,pgid=,lstart=") {
      // real ps right-aligns the numbers and pads the line
      return rows.map(([pid, pgid, ls]) => `${String(pid).padStart(7)} ${String(pgid).padStart(7)} ${ls}    `).join("\n") + "\n";
    }
    const p = args.indexOf("-p");
    const row = p >= 0 ? rows.find((r) => r[0] === Number(args[p + 1])) : undefined;
    if (row && args.includes("ppid=,lstart=,ucomm=")) return `    1 ${row[2]} sleep\n`;
    return null;
  };
}
const failingPs: PsRunner = () => null;

test("macOS liveness (#116): a different lstart for the same pid means reuse", () => {
  const ps = fakePsTable([[4_100_001, 4_100_001, LSTART_A]]);
  const st = processStartTime(4_100_001, "darwin", ps);
  assert.equal(st, secs(LSTART_A), "attach records lstart as epoch seconds");
  assert.equal(isProcessAlive(4_100_001, st, "darwin", ps), true);
  // pid reused by a process started later: dead, even though the pid exists
  const reused = fakePsTable([[4_100_001, 4_100_001, LSTART_B]]);
  assert.equal(isProcessAlive(4_100_001, st, "darwin", reused), false);
  assert.equal(jobAlive(4_100_001, undefined, st, "darwin", reused), false);
  // gone entirely
  assert.equal(isProcessAlive(4_100_001, st, "darwin", fakePsTable([[1, 1, LSTART_A]])), false);
});

test("macOS liveness (#116): known limitation — reuse within the same second is not detected", () => {
  // lstart has 1 s resolution: a pid that exits and is reused by another
  // process started in the same second carries the same start time. Like
  // Linux's clock-tick start time, but coarser (documented in OPERATIONS).
  const st = processStartTime(4_100_002, "darwin", fakePsTable([[4_100_002, 4_100_002, LSTART_A]]));
  const reusedSameSecond = fakePsTable([[4_100_002, 4_200_000, LSTART_A]]);
  assert.equal(isProcessAlive(4_100_002, st, "darwin", reusedSameSecond), true);
});

test("macOS liveness (#116): group members keep a job alive after its leader exits", () => {
  const leader = 4_100_003;
  const st = secs(LSTART_A);
  // leader gone, a child in its process group still runs
  const childOnly = fakePsTable([[1, 1, LSTART_A], [4_100_004, leader, LSTART_B]]);
  assert.equal(jobAlive(leader, leader, st, "darwin", childOnly), true);
  // pgid-only tracking works too
  assert.equal(jobAlive(undefined, leader, undefined, "darwin", childOnly), true);
  // whole group gone => confirmed dead
  const none = fakePsTable([[1, 1, LSTART_A], [4_100_004, 4_100_004, LSTART_B]]);
  assert.equal(jobAlive(leader, leader, st, "darwin", none), false);
  assert.equal(jobAlive(undefined, leader, undefined, "darwin", none), false);
});

test("macOS liveness (#116): one ps call per batch, however many jobs are checked", () => {
  const calls: string[][] = [];
  const ps = fakePsTable([[4_100_005, 4_100_005, LSTART_A], [4_100_006, 4_100_005, LSTART_A]], calls);
  const check = livenessChecker({ platform: "darwin", ps });
  assert.equal(calls.length, 0, "the snapshot is lazy");
  assert.equal(check(4_100_005, 4_100_005, secs(LSTART_A)), true);
  assert.equal(check(4_190_000, 4_100_005, undefined), true);
  assert.equal(check(4_190_001, 4_190_001, secs(LSTART_B)), false);
  assert.equal(check(4_100_006, undefined, secs(LSTART_B)), false);
  assert.equal(calls.length, 1, "all checks share one ps -A snapshot");
});

test("macOS liveness (#116): ps failure falls back to kill(pid, 0)", () => {
  for (const ps of [failingPs, (() => "garbled output\n") as PsRunner]) {
    // signal 0 only: a live pid is alive whatever start time was recorded
    // (no reuse defense without ps), a dead one is dead
    assert.equal(isProcessAlive(process.pid, "9999", "darwin", ps), true);
    assert.equal(isProcessAlive(4_194_303, "9999", "darwin", ps), false);
    // no group scan: dead pid => dead; pgid-only => unknown (kept)
    assert.equal(jobAlive(4_194_303, 4_194_303, undefined, "darwin", ps), false);
    assert.equal(jobAlive(undefined, 4_194_303, undefined, "darwin", ps), null);
    assert.equal(processStartTime(process.pid, "darwin", ps), undefined);
  }
});

test("macOS liveness (#116): permits journaled without a start time (older daemon) are existence-checked", () => {
  // Pre-#116 macOS daemons recorded no pidStartTime. Restoring such a permit
  // must not treat it as reused: a live pid keeps it, a dead one releases.
  const ps = fakePsTable([[4_100_007, 4_100_007, LSTART_B]]);
  assert.equal(jobAlive(4_100_007, undefined, undefined, "darwin", ps), true);
  assert.equal(jobAlive(4_100_008, undefined, undefined, "darwin", ps), false);
  // a live pid missing from the table (e.g. hidden from ps) falls back to signal 0
  assert.equal(jobAlive(process.pid, undefined, undefined, "darwin", ps), true);
});

test("macOS liveness (#116): real processes — reuse check and leader-exited group", { skip: PLATFORM !== "darwin" && "macOS only" }, async () => {
  const parent = spawn("/bin/sh", ["-c", "sleep 30 & exit 0"], { stdio: "ignore", detached: true });
  const pgid = parent.pid!;
  const st = processStartTime(pgid, "darwin");
  assert.ok(st && /^\d+$/.test(st), "start time recorded via ps");
  assert.equal(isProcessAlive(pgid, String(Number(st) - 5), "darwin"), false, "different lstart => reuse");
  await new Promise<void>((r) => (parent.exitCode !== null ? r() : parent.once("exit", () => r())));
  try {
    assert.equal(isProcessAlive(pgid, st, "darwin"), false, "leader exited");
    assert.equal(jobAlive(pgid, pgid, st, "darwin"), true, "orphaned sleep keeps the group alive");
  } finally {
    killProcessGroup(pgid, "SIGKILL");
  }
  const deadline = Date.now() + 5000;
  while (jobAlive(pgid, pgid, st, "darwin") !== false && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  assert.equal(jobAlive(pgid, pgid, st, "darwin"), false, "whole group gone => dead");
});

// Clean up once everything finished.
test("cleanup tmp dir", () => {
  rmSync(tmp, { recursive: true, force: true });
});
