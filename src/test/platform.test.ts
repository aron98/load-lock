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
import { isProcessAlive, jobAlive, aliveBySignalZero, processStartTime } from "../core/daemon.js";

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

test("isProcessAlive: Linux branch still checks /proc start time", () => {
  const st = processStartTime(process.pid);
  assert.ok(st !== undefined, "/proc start time must be readable on Linux");
  assert.equal(isProcessAlive(process.pid, st, "linux"), true);
  assert.equal(isProcessAlive(process.pid, "9999", "linux"), false); // mismatch = reuse
});

test("jobAlive: win32 skips the process-group scan", () => {
  assert.equal(jobAlive(process.pid, undefined, undefined, "win32"), true);
  // Dead main pid: released even though a group scan would have been
  // possible on Linux — Windows has no process groups.
  assert.equal(jobAlive(4_194_303, process.pid, undefined, "win32"), false);
  // pgid-only on win32: unknown => conservative keep.
  assert.equal(jobAlive(undefined, 12345, undefined, "win32"), null);
});

test("jobAlive: Linux still scans process groups", () => {
  assert.equal(jobAlive(process.pid, undefined, undefined, "linux"), true);
  // pgid 1 exists but a dead pid + live foreign pgid keeps the job "alive"
  // via the group scan — semantics unchanged on Linux.
  assert.equal(jobAlive(4_194_303, 1, undefined, "linux"), true);
  // Both dead => false on Linux (group 999999 has no members).
  assert.equal(jobAlive(4_194_303, 999_999, undefined, "linux"), false);
});

// Clean up once everything finished.
test("cleanup tmp dir", () => {
  rmSync(tmp, { recursive: true, force: true });
});
