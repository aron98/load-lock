/**
 * Cross-platform transport seam: endpoint paths, liveness probing, stale
 * endpoint cleanup, and process-group termination.
 *
 * POSIX (Linux/macOS): Unix-domain socket at `<state dir>/daemon.sock`,
 * stale-socket cleanup by unlink, process groups via kill(-pgid, sig).
 *
 * Windows: named pipe `\\.\pipe\load-lock` (Node's `net` module accepts
 * `\\.\pipe\...` paths in connect/listen transparently, so client and
 * daemon need no other changes). Named pipes are kernel objects, not
 * filesystem entries: there is no stale file to clean (a lost pipe simply
 * stops existing), and existsSync() on a pipe path can block — callers
 * must use probeTransport() instead. There are no POSIX process groups;
 * job termination uses `taskkill /PID <pid> /T` to kill the tree.
 */
import { connect } from "node:net";
import { unlinkSync } from "node:fs";
import { win32 as winPath, posix as posixPath } from "node:path";
import { spawn } from "node:child_process";

export const DEFAULT_PIPE_NAME = "load-lock";

export function isWindows(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32";
}

/** Path join that follows the *target* platform, not the host running the code. */
function pathJoin(platform: NodeJS.Platform, ...segments: string[]): string {
  return (isWindows(platform) ? winPath : posixPath).join(...segments);
}

/** Windows named-pipe endpoint for the given pipe name. */
export function namedPipePath(name: string = DEFAULT_PIPE_NAME): string {
  return `\\\\.\\pipe\\${name}`;
}

/**
 * Resolve the state directory. Precedence: explicit override >
 * LOAD_LOCK_STATE_DIR > platform default (POSIX: XDG_STATE_HOME or
 * ~/.local/state; Windows: %LOCALAPPDATA% or %USERPROFILE%\AppData\Local),
 * each + "/load-lock". Pure function of its arguments so tests can
 * exercise the Windows branches on Linux.
 */
export function resolveStateDir(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  override?: string,
): string {
  if (override) return override;
  if (env.LOAD_LOCK_STATE_DIR) return env.LOAD_LOCK_STATE_DIR;
  if (isWindows(platform)) {
    const base = env.LOCALAPPDATA || pathJoin(platform, env.USERPROFILE ?? "~", "AppData", "Local");
    return pathJoin(platform, base, "load-lock");
  }
  const xdg = env.XDG_STATE_HOME || pathJoin(platform, env.HOME ?? "~", ".local", "state");
  return pathJoin(platform, xdg, "load-lock");
}

/**
 * Resolve the transport endpoint. Precedence: explicit override >
 * LOAD_LOCK_SOCKET > platform default (Windows: named pipe; POSIX:
 * <state dir>/daemon.sock). The same precedence rules are used by every
 * caller, so the CLI, MCP server, hooks, and the daemon all agree on the
 * endpoint without further coordination.
 */
export function resolveSocketPath(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  override?: string,
): string {
  if (override) return override;
  if (env.LOAD_LOCK_SOCKET) return env.LOAD_LOCK_SOCKET;
  if (isWindows(platform)) return namedPipePath();
  return pathJoin(platform, resolveStateDir(platform, env), "daemon.sock");
}

/**
 * Probe whether a daemon is listening on the endpoint (UDS or named
 * pipe — Node's connect handles both). Never throws.
 */
export function probeTransport(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect(path);
    let settled = false;
    const done = (v: boolean) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    s.once("connect", () => {
      s.end();
      done(true);
    });
    s.once("error", () => {
      s.destroy();
      done(false);
    });
  });
}

/**
 * Remove a stale endpoint left behind by a crashed daemon.
 * POSIX: unlink the socket file (a crashed daemon leaves it behind).
 * Windows: no-op — named pipes are kernel objects and vanish when the
 * last handle closes, so there is nothing to clean up.
 */
export function removeStaleEndpoint(path: string, platform: NodeJS.Platform = process.platform): void {
  if (isWindows(platform)) return;
  try {
    unlinkSync(path);
  } catch {
    /* already gone — fine */
  }
}

/**
 * Terminate a job process tree. POSIX: negative-pid group kill (callers
 * spawn jobs detached, so pgid === child pid). Windows: `taskkill /PID
 * <pid> /T` (tree kill; add /F for the uncatchable SIGKILL equivalent —
 * plain taskkill posts WM_CLOSE, which console processes don't handle).
 * Fire-and-forget; never throws.
 */
export function killProcessGroup(
  pid: number,
  signal: "SIGTERM" | "SIGKILL",
  platform: NodeJS.Platform = process.platform,
): void {
  if (isWindows(platform)) {
    const args = ["/PID", String(pid), "/T"];
    if (signal === "SIGKILL") args.push("/F");
    try {
      const child = spawn("taskkill", args, { stdio: "ignore", windowsHide: true });
      child.once("error", () => {
        /* taskkill missing — nothing we can do; swallow */
      });
    } catch {
      /* never fatal */
    }
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    /* group already gone */
  }
}
