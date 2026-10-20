/**
 * `load-lock service start|stop|restart|status` (issue #38): daemon
 * lifecycle, extracted from main.ts so `service restart` and
 * `load-lock update` (which restarts after applying) compose the same
 * hardened stop + honest start paths instead of duplicating them.
 *
 *  - stop (hardened): SIGTERM → bounded wait → SIGKILL → verify the
 *    socket is actually free; crash leftovers cleaned either way.
 *  - start (honest): auto-spawn via connect, hello confirmation;
 *    refusals name the conflicting pid.
 *  - restart: stop then start, reporting both phases; any failure names
 *    the phase and reason.
 *
 * Failures throw ServiceError (message + exit code); callers decide how
 * to exit so composition can annotate ("restart failed in the STOP
 * phase: ...").
 */
import { existsSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { connect } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

import { withClient } from "../shared/client.js";
import { isWindows, probeTransport } from "../shared/transport.js";
import { compareVersions, packageVersion } from "../shared/version.js";
import { stateDir, socketPath } from "../core/persist.js";

/** A service-phase failure with the exit code the CLI should use. */
export class ServiceError extends Error {
  constructor(message: string, readonly exitCode: number = 70) {
    super(message);
  }
}

/** daemon.json contents, or null when missing/unreadable. */
export function readDaemonInfo(dir: string): { pid?: number; startedAt?: number; socket?: string } | null {
  try {
    return JSON.parse(readFileSync(join(dir, "daemon.json"), "utf8"));
  } catch {
    return null;
  }
}

/**
 * Version-less hello over a raw socket connection: deliberately does NOT
 * send clientVersion, so asking a daemon for its identity never orders it
 * to self-restart (used by `service stop` and post-restart confirmation).
 * Best-effort: resolves null on any failure.
 */
export function rawHello(sockPath: string, timeoutMs = 2000): Promise<{ pid?: number; daemonVersion?: string; protocolVersion?: number } | null> {
  return new Promise((resolve) => {
    let settled = false;
    let buf = "";
    const done = (v: unknown) => {
      if (settled) return;
      settled = true;
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
      resolve(v as any);
    };
    const sock = connect(sockPath, () => {
      sock.write(JSON.stringify({ id: 1, method: "hello", params: {} }) + "\n");
    });
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const idx = buf.indexOf("\n");
      if (idx === -1) return;
      try {
        const msg = JSON.parse(buf.slice(0, idx));
        done(msg.ok ? msg.result : null);
      } catch {
        done(null);
      }
    });
    sock.on("error", () => done(null));
    const timer = setTimeout(() => done(null), timeoutMs);
    timer.unref?.();
  });
}

/** Poll the socket until nothing answers there (bounded). */
async function waitSocketFree(sockPath: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  for (;;) {
    if (!(await probeTransport(sockPath))) return true;
    if (Date.now() >= deadline) return false;
    await delay(100);
  }
}

/**
 * After ordering a self-restart, wait for the daemon to come back running
 * at least `installed` (the version of this CLI copy). Resolves its hello
 * result, or null if it did not come back (or an older/pre-handshake
 * daemon answered again — e.g. the daemon's copy is not actually updated).
 */
export async function awaitDaemonUpgraded(
  sockPath: string,
  timeoutMs: number,
  installed: string,
): Promise<{ pid?: number; daemonVersion?: string } | null> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  for (;;) {
    const h = await rawHello(sockPath, 1500);
    if (h && typeof h.daemonVersion === "string" && compareVersions(h.daemonVersion, installed) >= 0) return h;
    if (Date.now() >= deadline) return null;
    await delay(250);
  }
}

/**
 * Hardened stop: signal the daemon, wait bounded for its socket to go
 * silent, escalate to SIGKILL, and only report success once the endpoint
 * is verifiably free. A leftover silent socket file or daemon.json (crash
 * leftovers) is cleaned up either way. Returns the report line; throws
 * ServiceError on failure.
 */
export async function serviceStop(timeoutMs: number): Promise<string> {
  const dir = stateDir();
  const sock = socketPath();
  const info = readDaemonInfo(dir);
  const answering = await probeTransport(sock);
  if (!answering) {
    // Nothing is listening: no daemon to stop. Clean crash leftovers.
    try {
      if (!isWindows() && existsSync(sock)) unlinkSync(sock);
    } catch {
      /* ignore */
    }
    try {
      rmSync(join(dir, "daemon.json"), { force: true });
    } catch {
      /* ignore */
    }
    return "no running daemon found (stale files cleaned)";
  }
  // Identify the daemon: prefer daemon.json, else ask it directly
  // (version-less hello — stopping must not order a self-restart).
  let pid = typeof info?.pid === "number" ? info.pid : undefined;
  if (!pid) {
    const hello = await rawHello(sock, 1500);
    if (hello && typeof hello.pid === "number") pid = hello.pid;
  }
  if (!pid) {
    throw new ServiceError(
      `the socket ${sock} answers but no pid could be identified (daemon did not respond and daemon.json names none) ` +
        `— cannot stop safely; run \`load-lock doctor\``,
    );
  }
  let how = "SIGTERM";
  let stopped = false;
  try {
    process.kill(pid!, "SIGTERM");
  } catch (e: any) {
    if (e?.code === "ESRCH") stopped = true; // already gone
    else throw new ServiceError(`cannot signal daemon pid ${pid}: ${e?.message ?? e}`);
  }
  if (!stopped) stopped = await waitSocketFree(sock, timeoutMs);
  if (!stopped) {
    how = "SIGKILL";
    try {
      process.kill(pid!, "SIGKILL");
    } catch {
      /* already dead */
    }
    stopped = await waitSocketFree(sock, timeoutMs);
  }
  if (!stopped) {
    throw new ServiceError(`daemon pid ${pid} did not stop within ${timeoutMs}ms even after SIGKILL — run \`load-lock doctor\``);
  }
  try {
    if (!isWindows() && existsSync(sock)) unlinkSync(sock);
  } catch {
    /* ignore */
  }
  try {
    rmSync(join(dir, "daemon.json"), { force: true });
  } catch {
    /* ignore */
  }
  return `daemon (pid ${pid}) stopped${how === "SIGKILL" ? " (required SIGKILL after SIGTERM)" : ""}`;
}

/**
 * Honest start: connecting auto-spawns a detached daemon (see
 * shared/client.ts); hello confirms it is up. Refusals name the
 * conflicting pid. Returns the report line; throws ServiceError on
 * failure.
 */
export async function serviceStart(timeoutMs: number): Promise<string> {
  const sock = socketPath();
  const installed = packageVersion();
  try {
    const r = (await withClient((c) => c.request("hello", {}, timeoutMs))) as any;
    const dv = typeof r.daemonVersion === "string" ? r.daemonVersion : undefined;
    if (dv && compareVersions(dv, installed) < 0) {
      // The handshake just ordered this old daemon to self-restart;
      // confirm it comes back on updated code.
      const up = await awaitDaemonUpgraded(sock, 8000, installed);
      if (up) {
        return `daemon self-restarted ${r.pid} -> ${up.pid} (v${dv} -> v${up.daemonVersion}), running on ${sock}`;
      }
      return (
        `daemon running on pid ${r.pid} (${sock}), daemon v${dv} — older than this CLI v${installed}; ` +
        `self-restart ordered but not confirmed (its copy may not be updated in place — see docs/OPERATIONS.md)`
      );
    }
    return `daemon running on pid ${r.pid} (${sock})${dv ? `, daemon v${dv}` : ""}`;
  } catch (e) {
    if (await probeTransport(sock)) {
      // Something owns the endpoint. Name it.
      const hello = await rawHello(sock, 1500);
      if (hello && typeof hello.pid === "number") {
        throw new ServiceError(
          `start refused: socket answered from pid ${hello.pid} — another daemon owns ${sock}; ` +
            `if it is stale, run \`load-lock service stop\` first`,
        );
      }
      const info = readDaemonInfo(stateDir());
      if (info && typeof info.pid === "number") {
        throw new ServiceError(
          `socket ${sock} answers but the daemon did not respond (daemon.json names pid ${info.pid}) — likely hung; ` +
            `run \`load-lock service stop\``,
        );
      }
      throw new ServiceError(`start refused: ${sock} is in use but nothing responsive owns it — run \`load-lock doctor\``);
    }
    throw e;
  }
}

/**
 * `service restart` (issue #38): hardened stop, then honest start — both
 * phases reported; a failure names the phase and reason. Stopping when
 * nothing runs is fine: the start phase simply spawns a fresh daemon.
 */
export async function serviceRestart(stopTimeoutMs = 5000, startTimeoutMs = 10_000): Promise<{ stop: string; start: string }> {
  let stop: string;
  try {
    stop = await serviceStop(stopTimeoutMs);
  } catch (e) {
    const reason = e instanceof ServiceError ? e.message : String((e as Error)?.message ?? e);
    throw new ServiceError(`restart failed in the STOP phase: ${reason}`, e instanceof ServiceError ? e.exitCode : 70);
  }
  let start: string;
  try {
    start = await serviceStart(startTimeoutMs);
  } catch (e) {
    const reason = e instanceof ServiceError ? e.message : String((e as Error)?.message ?? e);
    throw new ServiceError(
      `restart failed in the START phase (stop phase succeeded: ${stop}) — ${reason}`,
      e instanceof ServiceError ? e.exitCode : 70,
    );
  }
  return { stop, start };
}
