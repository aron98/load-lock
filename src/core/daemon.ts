/**
 * load-lock daemon: single process owning all semaphore state.
 *
 * Ownership/lifecycle rationale (see docs/ARCHITECTURE.md): MCP tool calls
 * are short-lived; a lock held by a tool call would die with the call. The
 * daemon is the persistent owner: permits live in the daemon, independent of
 * any agent connection, so a background build outliving its tool call or
 * session keeps its authorization until released — or until its associated
 * process is confirmed dead.
 *
 * Automatic cleanup (all sweeps run here, on real process evidence):
 *   - offers expire after offerTimeoutMs (claim window)
 *   - claimed permits are reclaimed after startTimeoutMs if execution never starts
 *   - tracked permits are released when their pid/process-group is confirmed dead
 *   - untracked permits are reclaimed when their heartbeat lease lapses
 * All state mutations run on one event loop => every RPC is atomic wrt all
 * others; start_job is therefore atomic wrt reclamation.
 */
import { createServer, Server, Socket } from "node:net";
import { existsSync, mkdirSync, unlinkSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { readdirSync } from "node:fs";
import { join } from "node:path";

import { Machine } from "./state.js";
import { loadState, saveState, loadJournal, saveJournal, socketPath as defaultSocket, stateDir as defaultStateDir } from "./persist.js";
import { inspectMachine } from "./sysinfo.js";
import { AcquireParams, MachineEvent, OwnerEntrySnapshot, ProtocolError } from "../shared/protocol.js";
import { isWindows, probeTransport } from "../shared/transport.js";

interface Watcher {
  socket: Socket;
  agentId: string; // or "*"
}

interface Waiter {
  requestId: string;
  resolve: (r: { state: "granted"; entry: OwnerEntrySnapshot } | null) => void;
  timer: NodeJS.Timeout;
}

export class Daemon {
  machine: Machine;
  server: Server | null = null;
  private watchers = new Set<Watcher>();
  /** All open client connections — destroyed on stop() so a graceful
   *  shutdown cuts waiting clients loose (they reconnect + detect the
   *  restart via the event cursor) and the process can exit promptly. */
  private conns = new Set<Socket>();
  private waiters = new Map<string, Waiter>();
  private sentEventId: number;
  private stateDirPath: string;
  private socketPath: string;
  private sweepTimer: NodeJS.Timeout | null = null;
  private expiryTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(opts: { stateDir?: string; socket?: string; machine?: Machine; recover?: boolean } = {}) {
    this.stateDirPath = defaultStateDir(opts.stateDir);
    this.socketPath = defaultSocket(opts.socket);
    if (opts.machine) {
      this.machine = opts.machine;
    } else {
      mkdirSync(this.stateDirPath, { recursive: true });
      const st = loadState(this.stateDirPath);
      this.machine = new Machine(Date.now, st.config);
      this.machine.history.push(...st.history);
      // Conservative restart reconciliation: keep permits whose job still
      // runs; release permits whose process is confirmed dead. Same permit
      // tokens remain valid, so a late explicit release after restart works.
      if (opts.recover !== false) {
        this.machine.restore(loadJournal(this.stateDirPath), (e) => jobAlive(e.pid, e.pgid, e.pidStartTime));
      }
    }
    this.sentEventId = this.machine.latestEventId(); // don't replay history to watchers
  }

  // -------------------------------------------------------------------- start

  async start(): Promise<void> {
    await this.claimSocket();
    await new Promise<void>((resolve, reject) => {
      this.server = createServer((sock) => this.onConnection(sock));
      this.server.on("error", reject);
      this.server.listen(this.socketPath, () => resolve());
    });
    writeFileSync(
      join(this.stateDirPath, "daemon.json"),
      JSON.stringify({ pid: process.pid, startedAt: Date.now(), socket: this.socketPath }, null, 2) + "\n",
    );
    process.once("SIGTERM", () => this.stop());
    process.once("SIGINT", () => this.stop());
    this.sweepTimer = setInterval(() => this.sweep(), 5_000);
    this.sweepTimer.unref?.();
    this.sweep(); // catch anything that expired while we were down
  }

  /**
   * Bind the endpoint, replacing it only if it is verifiably stale.
   * Windows: named pipes are kernel objects — no stale file can exist, so
   * just refuse if another daemon owns the pipe.
   */
  private async claimSocket(): Promise<void> {
    if (isWindows()) {
      if (await probeTransport(this.socketPath)) {
        throw new ProtocolError("denied", `another daemon is already listening on ${this.socketPath}`);
      }
      return;
    }
    if (existsSync(this.socketPath)) {
      const live = await probeTransport(this.socketPath);
      if (live) {
        throw new ProtocolError("denied", `another daemon is already listening on ${this.socketPath}`);
      }
      try {
        unlinkSync(this.socketPath);
      } catch {
        /* ignore */
      }
    }
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    for (const w of this.watchers) w.socket.destroy();
    this.watchers.clear();
    // Cut every client loose too: a graceful stop must not leave a zombie
    // serving already-connected clients while the socket path moves on.
    // Clients see the disconnect, reconnect, and detect the restart.
    for (const s of this.conns) s.destroy();
    this.conns.clear();
    this.server?.close();
    if (!isWindows()) {
      // Windows: the named pipe is a kernel object and vanishes on close;
      // touching the pipe path from the filesystem side can block.
      try {
        if (existsSync(this.socketPath)) unlinkSync(this.socketPath);
      } catch {
        /* ignore */
      }
    }
    try {
      rmSync(join(this.stateDirPath, "daemon.json"), { force: true });
    } catch {
      /* ignore */
    }
  }

  // ----------------------------------------------------------------- framing

  private onConnection(sock: Socket): void {
    this.conns.add(sock);
    let buf = "";
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let idx: number;
      while ((idx = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (line.trim()) void this.handleLine(sock, line);
      }
    });
    sock.on("error", () => sock.destroy());
    sock.on("close", () => {
      this.conns.delete(sock);
      for (const w of [...this.watchers]) if (w.socket === sock) this.watchers.delete(w);
    });
  }

  private send(sock: Socket, obj: unknown): void {
    if (!sock.destroyed) sock.write(JSON.stringify(obj) + "\n");
  }

  private async handleLine(sock: Socket, lineText: string): Promise<void> {
    let msg: { id: number; method: string; params?: Record<string, unknown> };
    try {
      msg = JSON.parse(lineText);
    } catch {
      this.send(sock, { id: null, ok: false, error: { code: "invalid", message: "malformed JSON line" } });
      return;
    }
    let result: unknown;
    let agentId: string | undefined;
    try {
      const [res, agent] = await this.dispatch(sock, msg.method, msg.params ?? {});
      result = res;
      agentId = agent;
      this.afterOp();
    } catch (err) {
      this.afterOp();
      if (err instanceof ProtocolError) {
        this.send(sock, { id: msg.id, ok: false, error: { code: err.code, message: err.message, details: err.details } });
      } else {
        this.send(sock, { id: msg.id, ok: false, error: { code: "internal", message: String((err as Error)?.message ?? err) } });
      }
      return;
    }
    // Tool-boundary delivery: surface this agent's outstanding offers/queue
    // on every response so the next tool result always carries them.
    if (agentId) {
      (result as Record<string, unknown>).pending = this.machine.pending(agentId);
    }
    this.send(sock, { id: msg.id, ok: true, result });
  }

  // --------------------------------------------------------------- dispatch

  /** Returns [result, agentIdForPendingAttachment]. */
  private async dispatch(
    sock: Socket,
    method: string,
    p: Record<string, unknown>,
  ): Promise<[unknown, string | undefined]> {
    const m = this.machine;
    switch (method) {
      case "hello":
        return [{ protocolVersion: 1, pid: process.pid, startedAt: m.startedAt, configVersion: m.config.version }, undefined];

      case "acquire": {
        const params = p as unknown as AcquireParams;
        let res = m.acquire(params);
        if (res.state === "offered") {
          // An offer was already waiting for this op (idempotent re-acquire):
          // auto-claim to honor "wait" semantics without a second round trip.
          res = { state: "granted", entry: m.claimByRequestId(res.entry.requestId).entry };
        } else if (res.state === "queued") {
          const waitMs = Math.min(Math.max(0, params.waitMs ?? 0), m.config.maxWaitMs);
          if (waitMs > 0) {
            const waited = await this.waitForAdmission(res.entry.requestId, waitMs);
            if (waited) res = waited;
          }
        }
        return [res, params.agentId];
      }

      case "claim": {
        const res = m.claim(String(p.offerToken));
        return [res, res.entry.agentId];
      }

      case "release": {
        const res = m.release(String(p.permitToken));
        return [res, res.entry.agentId];
      }

      case "decline": {
        m.decline(String(p.offerToken));
        return [{ ok: true }, undefined];
      }

      case "cancel": {
        const res = m.cancel(p as { requestId: string; admin?: boolean });
        return [res, res.entry.agentId];
      }

      case "rejoin": {
        const snap = m.rejoin({ requestId: String(p.requestId) });
        return [{ state: snap.state, entry: snap }, snap.agentId];
      }

      case "start_job": {
        // Atomic execution association. pidStartTime read daemon-side from
        // /proc (pid-reuse-safe on Linux).
        const snap = m.startJob(String(p.permitToken), Number(p.pid), p.pgid !== undefined ? Number(p.pgid) : undefined, processStartTime(Number(p.pid)));
        return [{ entry: snap }, snap.agentId];
      }

      case "mark_started": {
        const snap = m.markStarted(String(p.permitToken));
        return [{ entry: snap }, snap.agentId];
      }

      case "attach_pid": {
        // Convenience alias: associate a manually-started process.
        const pid = Number(p.pid);
        const snap = m.startJob(String(p.permitToken), pid, undefined, processStartTime(pid));
        return [{ entry: snap }, snap.agentId];
      }

      case "heartbeat": {
        m.heartbeat(String(p.agentId));
        return [{ ok: true }, String(p.agentId)];
      }

      case "pending": {
        const res = m.pending(String(p.agentId));
        return [res, String(p.agentId)];
      }

      case "status":
        return [m.status(p.pool ? String(p.pool) : undefined), undefined];

      case "get_config":
        return [m.get_config(), undefined];

      case "configure": {
        const res = m.configure(p as never);
        saveState(this.stateDirPath, m.config, m.history);
        return [res, undefined];
      }

      case "inspect":
        return [inspectMachine(m.config), undefined];

      case "events": {
        const since = Number(p.sinceEventId ?? 0);
        const agentId = p.agentId ? String(p.agentId) : undefined;
        const evs = m.eventsSince(since, agentId);
        if (agentId) {
          // Owner-filtered pulls carry claim tokens (durable identities +
          // tokens survive reconnects); unfiltered pulls never do.
          for (const ev of evs) {
            if (ev.type === "offered" && ev.entry && ev.targetAgent === agentId) {
              const t = m.offerTokenOf(ev.entry.requestId);
              if (t) (ev as MachineEvent & { offerToken?: string }).offerToken = t;
            }
          }
        }
        return [{ events: evs, latestEventId: m.latestEventId() }, undefined];
      }

      case "watch": {
        const agentId = p.agentId ? String(p.agentId) : "*";
        this.watchers.add({ socket: sock, agentId });
        this.send(sock, { event: true, type: "watch_started", targetAgent: agentId, latestEventId: m.latestEventId() });
        return [{ ok: true }, undefined];
      }

      case "offers_for_cwd": {
        // Used by Claude Code / Codex hook scripts, which lack the MCP
        // process's agent identity: match offers by the cwd recorded at
        // acquire time. Claiming still requires the opaque token, so a
        // match can wake a session but can never authorize work by itself.
        const cwd = String(p.cwd);
        return [{ offers: m.allOffers().filter((e) => e.cwd === cwd) }, undefined];
      }

      case "admin_list":
        return [{ holders: m.diagnose((e) => jobAlive(e.pid, e.pgid, e.pidStartTime)), latestEventId: m.latestEventId() }, undefined];

      case "admin_release": {
        // Force-release recovery: reclaims the permit and frees capacity.
        m.adminRelease(String(p.requestId));
        return [{ ok: true }, undefined];
      }

      default:
        throw new ProtocolError("invalid", `unknown method "${method}"`);
    }
  }

  /**
   * Bounded blocking wait for a queued request. Resolves with a granted
   * result if capacity is admitted within waitMs, else null (caller returns
   * the queued state). This is the honest fallback for harnesses without
   * push notifications — no model-authored busy-polling required.
   */
  private waitForAdmission(requestId: string, waitMs: number): Promise<{ state: "granted"; entry: OwnerEntrySnapshot } | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(requestId);
        resolve(null);
      }, waitMs);
      this.waiters.set(requestId, { requestId, resolve, timer });
    });
  }

  // ------------------------------------------------------------- post-op pass

  /** Runs after every dispatch: sweep deadlines, auto-claim for waiters, flush events, journal. */
  private afterOp(): void {
    const m = this.machine;
    m.tick(m.now());
    // Auto-claim on behalf of blocking waiters when their request is offered.
    for (const [requestId, waiter] of [...this.waiters]) {
      const entry = m.entryById(requestId);
      if (!entry) continue;
      if (entry.state === "offered") {
        const granted = m.claimByRequestId(requestId);
        clearTimeout(waiter.timer);
        this.waiters.delete(requestId);
        waiter.resolve({ state: "granted", entry: granted.entry });
      } else if (entry.state === "held") {
        clearTimeout(waiter.timer);
        this.waiters.delete(requestId);
        waiter.resolve({ state: "granted", entry: m.ownerSnapshotById(requestId)! });
      } else if (entry.state === "paused" || entry.state === "cancelled" || entry.state === "released") {
        clearTimeout(waiter.timer);
        this.waiters.delete(requestId);
        waiter.resolve(null);
      }
    }
    // Flush events produced by this op to watchers.
    const fresh = m.eventsSince(this.sentEventId);
    if (fresh.length > 0) {
      this.sentEventId = m.latestEventId();
      for (const ev of fresh) this.broadcast(ev);
    }
    // Persist held permits for restart reconciliation.
    try {
      saveJournal(this.stateDirPath, m.journalEntries());
    } catch {
      /* journal is best-effort; config.json already persisted */
    }
    this.armExpiryTimer();
  }

  private armExpiryTimer(): void {
    const next = this.machine.nextExpiry();
    if (this.expiryTimer) {
      clearTimeout(this.expiryTimer);
      this.expiryTimer = null;
    }
    if (next === null) return;
    const ms = Math.max(5, next - Date.now());
    this.expiryTimer = setTimeout(() => {
      this.machine.tick(this.machine.now());
      const fresh = this.machine.eventsSince(this.sentEventId);
      if (fresh.length > 0) {
        this.sentEventId = this.machine.latestEventId();
        for (const ev of fresh) this.broadcast(ev);
      }
      try {
        saveJournal(this.stateDirPath, this.machine.journalEntries());
      } catch {
        /* ignore */
      }
      this.armExpiryTimer();
    }, ms);
    this.expiryTimer.unref?.();
  }

  private broadcast(ev: MachineEvent): void {
    for (const w of this.watchers) {
      if (w.agentId === "*" || ev.targetAgent === "*" || ev.targetAgent === w.agentId) {
        const out: MachineEvent & { event: true } = { ...ev, event: true };
        if (ev.type === "offered" && ev.entry && (w.agentId === ev.targetAgent || w.agentId === "*")) {
          // Deliver the claim token to the owner, and to trusted "*"
          // multiplexer watchers (e.g. the OpenCode plugin, which routes the
          // event to the right session by targetAgent). Claiming still
          // requires the token; the event itself authorizes nothing.
          const tok = this.machine.offerTokenOf(ev.entry.requestId);
          if (tok) out.offerToken = tok;
        }
        this.send(w.socket, out);
      }
    }
  }

  // ------------------------------------------------------------------ sweeps

  /**
   * Periodic cleanup with positive process evidence:
   *  - tracked permits: release when pid AND process group are confirmed dead
   *  - claimed/untracked deadlines: handled by machine.tick() (start
   *    deadline, heartbeat lease) here as well so timers alone are not load-bearing.
   * Untracked permits are never released on duration alone — only when their
   * lease lapses, which requires the owner's adapter to be gone.
   */
  private sweep(): void {
    const m = this.machine;
    for (const e of m.heldEntries()) {
      if (e.phase === "running_tracked") {
        const alive = jobAlive(e.pid, e.pgid, e.pidStartTime);
        if (alive === false) {
          m.autoRelease(e.requestId, `tracked process ${e.pid}${e.pgid ? ` / pgid ${e.pgid}` : ""} is no longer running`);
        }
      }
    }
    m.tick(m.now());
    try {
      saveJournal(this.stateDirPath, m.journalEntries());
    } catch {
      /* ignore */
    }
    const fresh = m.eventsSince(this.sentEventId);
    if (fresh.length > 0) {
      this.sentEventId = m.latestEventId();
      for (const ev of fresh) this.broadcast(ev);
    }
  }
}

// --------------------------------------------------------------------- helpers

/**
 * Liveness via signal 0 — the /proc-less fallback (macOS, Windows).
 * EPERM counts as alive: the process exists but is not signalable by us.
 */
export function aliveBySignalZero(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

/**
 * Linux: /proc/<pid>/stat field 22 (starttime) defeats pid reuse.
 * Windows: no /proc and no start time — signal-0 fallback only; the
 * pid-reuse defense is unavailable there (documented limitation).
 * macOS: /proc is absent, so the signal-0 fallback applies too.
 */
export function isProcessAlive(pid: number, expectedStartTime?: string, platform: NodeJS.Platform = process.platform): boolean | null {
  if (isWindows(platform)) {
    // Start time is unobtainable without native APIs; pid reuse is possible
    // during this window (documented in docs/OPERATIONS.md).
    return aliveBySignalZero(pid);
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    if (expectedStartTime !== undefined) {
      const close = stat.lastIndexOf(")");
      const fields = stat.slice(close + 2).split(" ");
      const starttime = fields[19]; // field 22 overall (1-based), minus pid + comm
      if (starttime !== expectedStartTime) return false; // pid was reused
    }
    return true;
  } catch {
    // /proc unavailable (macOS): fall back to signal 0. Pid reuse is possible
    // here; documented limitation — that is why adapters should prefer
    // run_with_permit / process-group tracking where available.
    return aliveBySignalZero(pid);
  }
}

/**
 * Job liveness: a tracked job is alive if its pid is alive (start-time
 * matched) OR any process in its process group is alive — covering
 * subprocesses and background jobs that outlive their parent. Returns
 * true/false on Linux; on platforms without /proc the pgid scan is
 * unavailable and the result may be null (unknown => conservative keep).
 * Windows: no process groups — only the main pid is checked, so a permit
 * is released once the main pid dies even if children survive (documented
 * limitation; adapters should kill the tree via taskkill /T).
 */
export function jobAlive(pid?: number, pgid?: number, pidStartTime?: string, platform: NodeJS.Platform = process.platform): boolean | null {
  if (pid !== undefined) {
    const alive = isProcessAlive(pid, pidStartTime, platform);
    if (alive === true) return true;
  }
  if (pgid !== undefined && !isWindows(platform)) {
    const scan = scanProcessGroup(pgid);
    if (scan !== null) return scan;
  }
  if (pid === undefined) return null;
  return false;
}

/** Scan /proc for any live process whose pgrp matches pgid. null = /proc unavailable. */
function scanProcessGroup(pgid: number): boolean | null {
  let names: string[];
  try {
    names = readdirSync("/proc");
  } catch {
    return null;
  }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, "utf8");
      const close = stat.lastIndexOf(")");
      const fields = stat.slice(close + 2).split(" ");
      const pgrp = Number(fields[2]); // field 5 overall, minus pid + comm
      if (pgrp === pgid) return true;
    } catch {
      /* process vanished mid-scan */
    }
  }
  return false;
}

/** Read the Linux start time of a pid (pid-reuse-safe association). */
export function processStartTime(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    const fields = stat.slice(close + 2).split(" ");
    return fields[19];
  } catch {
    return undefined;
  }
}
