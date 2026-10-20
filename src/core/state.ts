/**
 * load-lock core: a pure, synchronous state machine for the machine-wide
 * counting semaphore. No I/O here — the daemon drives timers, process
 * liveness checks, journaling and persistence. All mutations are serialized
 * by construction (single-threaded event loop of the daemon), so every
 * handle() call is atomic with respect to every other call. Notably,
 * execution association (start_job) is atomic with respect to reclamation:
 * a start either observes a live claimed permit and transitions it, or fails.
 *
 * Permit lifecycle (see docs/ARCHITECTURE.md):
 *   acquire --grant--> held(phase=claimed, start deadline)
 *   offer --claim----> held(phase=claimed, start deadline)
 *   claimed --start_job-------> held(phase=running_tracked, pid+pgid tracked)
 *   claimed --mark_started----> held(phase=running_untracked, heartbeat lease)
 *   running_* --job end-------> released (automatic or explicit, idempotent)
 *   claimed past deadline ----> released (reclaimed)
 *   untracked lease expired --> released (reclaimed)
 *
 * Invariants (covered by tests):
 *  - used(pool) = sum(weights of held) + sum(weights of offered) <= capacity,
 *    except temporarily after a capacity decrease (holders always finish).
 *  - Queue admission is strict FIFO per pool.
 *  - Offers reserve capacity; an expired/declined offer passes capacity to
 *    the next waiter and the request becomes `paused` (never auto-recycled).
 *  - Tokens (offer/permit) are opaque and single-use; only owners ever see
 *    them; terminal states invalidate them (kept briefly for idempotency).
 *  - acquire() is idempotent per (agentId, opKey) while a request is live.
 *  - A forgotten release cannot permanently block the queue: every held
 *    permit has an automatic exit (start deadline, tracked process death, or
 *    untracked lease). A known-running tracked job is never revoked on
 *    duration alone.
 */
import {
  AcquireParams,
  AcquireResult,
  CancelParams,
  CancelResult,
  ClaimResult,
  ConfigChange,
  ConfigHistoryEntry,
  ConfigureParams,
  ConfigureResult,
  EntrySnapshot,
  EntryState,
  EventType,
  GetConfigResult,
  HolderDiag,
  JournalEntry,
  MachineConfig,
  MachineEvent,
  OwnerEntrySnapshot,
  PermitPhase,
  PoolStatus,
  ProtocolError,
  RejoinParams,
  ReleaseResult,
  StatusResult,
} from "../shared/protocol.js";

import { randomBytes } from "node:crypto";

const MAX_EVENTS = 2000;
const MAX_HISTORY = 50;
export const LONG_HOLD_MS = 30 * 60_000; // diagnostics threshold, never a revocation
const PRUNE_AFTER_MS = 60 * 60_000; // terminal entries kept this long for idempotent retries

export function defaultConfig(): MachineConfig {
  return {
    version: 1,
    pools: { heavy: { capacity: 1 } },
    offerTimeoutMs: 30_000,
    maxWaitMs: 5_000,
    maxTurnWaitMs: 600_000,
    startTimeoutMs: 120_000,
    untrackedLeaseMs: 15 * 60_000,
    guidance: {},
  };
}

interface Entry {
  id: string;
  pool: string;
  agentId: string;
  agentLabel?: string;
  cwd?: string;
  opKey: string;
  reason: string;
  weight: number;
  state: EntryState;
  since: number; // ms, when entered current state
  offerToken?: string;
  offerExpiresAt?: number;
  permitToken?: string;
  phase?: PermitPhase;
  startDeadline?: number;
  pid?: number;
  pgid?: number;
  pidStartTime?: string;
  startedAt?: number;
  leaseDeadline?: number;
  lastSeen?: number;
  enqueuedAt?: number;
}

const rid = () => "req_" + randomBytes(12).toString("hex");
const tok = (p: string) => p + "_" + randomBytes(16).toString("hex");

export class Machine {
  config: MachineConfig;
  private entries = new Map<string, Entry>();
  private byKey = new Map<string, string>(); // `${agentId}\u0000${opKey}` -> entryId (live requests only)
  private offerTokens = new Map<string, string>(); // offerToken -> entryId
  private permitTokens = new Map<string, string>(); // permitToken -> entryId (survives release for idempotency until prune)
  private queues = new Map<string, string[]>(); // pool -> FIFO of entryIds
  private expiredOffers = new Map<string, number>(); // recently-expired offer token -> ts (for precise claim errors)
  private events: MachineEvent[] = [];
  private nextEventId = 1;
  private clock: () => number;
  startedAt: number;

  constructor(clock: () => number = Date.now, config?: MachineConfig) {
    this.clock = clock;
    this.startedAt = clock();
    this.config = config ?? defaultConfig();
    this.pushEvent({ type: "daemon_started", targetAgent: "*" });
  }

  now(): number {
    return this.clock();
  }

  // ------------------------------------------------------------------ events

  private pushEvent(e: Omit<MachineEvent, "id" | "ts">): MachineEvent {
    const ev: MachineEvent = { id: this.nextEventId++, ts: this.now(), ...e };
    this.events.push(ev);
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    return ev;
  }

  /** Events with id > since, newest last. */
  eventsSince(since: number, agentId?: string, limit = 500): MachineEvent[] {
    const out = this.events.filter(
      (e) => e.id > since && (!agentId || e.targetAgent === agentId || e.targetAgent === "*"),
    );
    return out.slice(-limit);
  }

  latestEventId(): number {
    return this.nextEventId - 1;
  }

  /**
   * Newest event with id > `since` whose entry is the given request, or null.
   * Scans backwards, so the first match is the most recent one.
   */
  lastEventForRequest(requestId: string, since: number): MachineEvent | null {
    for (let i = this.events.length - 1; i >= 0; i--) {
      const ev = this.events[i];
      if (ev.id <= since) break;
      if (ev.entry?.requestId === requestId) return ev;
    }
    return null;
  }

  private emit(type: EventType, entry: Entry | null, extra?: Partial<MachineEvent>): void {
    const targetAgent = entry ? entry.agentId : "*";
    const ev: Omit<MachineEvent, "id" | "ts"> = {
      type,
      targetAgent,
      pool: entry?.pool ?? extra?.pool,
      entry: entry ? this.snapshot(entry) : undefined,
      ...extra,
    };
    if (ev.entry) delete (ev.entry as OwnerEntrySnapshot).offerToken;
    this.pushEvent(ev);
  }

  // ---------------------------------------------------------------- snapshots

  snapshot(e: Entry): EntrySnapshot {
    const s: EntrySnapshot = {
      requestId: e.id,
      pool: e.pool,
      agentId: e.agentId,
      agentLabel: e.agentLabel,
      cwd: e.cwd,
      opKey: e.opKey,
      reason: e.reason,
      weight: e.weight,
      state: e.state,
      since: e.since,
    };
    if (e.state === "queued") s.position = this.position(e) ?? undefined;
    if (e.pid !== undefined) s.pid = e.pid;
    if (e.pgid !== undefined) s.pgid = e.pgid;
    if (e.pidStartTime) s.pidStartTime = e.pidStartTime;
    if (e.state === "offered") s.offerExpiresAt = e.offerExpiresAt;
    if (e.state === "held") {
      s.phase = e.phase;
      s.heldFor = this.now() - e.since;
    }
    if (e.startDeadline) s.startDeadline = e.startDeadline;
    if (e.leaseDeadline) s.leaseDeadline = e.leaseDeadline;
    if (e.lastSeen) s.lastSeen = e.lastSeen;
    if (e.startedAt !== undefined) s.startedAt = e.startedAt;
    return s;
  }

  private ownerSnapshot(e: Entry): OwnerEntrySnapshot {
    const s = this.snapshot(e) as OwnerEntrySnapshot;
    if (e.state === "offered" && e.offerToken) s.offerToken = e.offerToken;
    if (e.state === "held" && e.permitToken) s.permitToken = e.permitToken;
    return s;
  }

  private position(e: Entry): number | null {
    const q = this.queues.get(e.pool);
    if (!q) return null;
    const idx = q.indexOf(e.id);
    return idx === -1 ? null : idx + 1;
  }

  // ------------------------------------------------------------- pool maths

  private poolNames(): string[] {
    return Object.keys(this.config.pools);
  }

  private capacity(pool: string): number {
    return this.config.pools[pool]?.capacity ?? 0;
  }

  /** Weight currently consuming capacity (held + offered). */
  used(pool: string): number {
    let n = 0;
    for (const e of this.entries.values()) {
      if (e.pool === pool && (e.state === "held" || e.state === "offered")) n += e.weight;
    }
    return n;
  }

  private liveEntryByOpKey(agentId: string, opKey: string): Entry | undefined {
    const id = this.byKey.get(`${agentId}\u0000${opKey}`);
    if (!id) return undefined;
    return this.entries.get(id);
  }

  /**
   * Fill capacity from the FIFO queue. Strict FIFO: the head of the queue is
   * admitted only if it fits; otherwise we stop (no bypassing heavier
   * requests by lighter ones behind them).
   */
  private admit(pool: string): void {
    const q = this.queues.get(pool);
    if (!q) return;
    while (q.length > 0) {
      const headId = q[0];
      const e = this.entries.get(headId);
      if (!e || e.state !== "queued") {
        q.shift();
        continue;
      }
      if (this.used(pool) + e.weight > this.capacity(pool)) return; // FIFO head blocks
      q.shift();
      e.state = "offered";
      e.since = this.now();
      e.offerToken = tok("off");
      e.offerExpiresAt = this.now() + this.config.offerTimeoutMs;
      this.offerTokens.set(e.offerToken, e.id);
      this.emit("offered", e);
    }
  }

  /** Remove an entry from its pool queue if present. */
  private dequeue(e: Entry): void {
    const q = this.queues.get(e.pool);
    if (!q) return;
    const i = q.indexOf(e.id);
    if (i !== -1) q.splice(i, 1);
  }

  /** Remove op-key association and invalidate live tokens (terminal-ish). */
  private retire(e: Entry): void {
    this.byKey.delete(`${e.agentId}\u0000${e.opKey}`);
    if (e.offerToken) this.offerTokens.delete(e.offerToken);
    // permitToken mapping is intentionally KEPT so that a duplicate/retried
    // release() is answered idempotently; pruned later by sweep().
  }

  // ----------------------------------------------------------------- acquire

  private newPermit(e: Entry): void {
    e.state = "held";
    e.since = this.now();
    e.phase = "claimed";
    e.permitToken = tok("prm");
    e.startDeadline = this.now() + this.config.startTimeoutMs;
    this.permitTokens.set(e.permitToken, e.id);
  }

  acquire(p: AcquireParams): AcquireResult {
    const pool = p.pool ?? "heavy";
    if (!this.config.pools[pool]) throw new ProtocolError("invalid", `unknown pool "${pool}"`);
    if (!p.agentId) throw new ProtocolError("invalid", "agentId is required");
    if (!p.opKey) throw new ProtocolError("invalid", "opKey is required");
    if (!p.reason) throw new ProtocolError("invalid", "reason is required");
    const weight = p.weight ?? 1;
    if (!Number.isInteger(weight) || weight < 1) throw new ProtocolError("invalid", "weight must be a positive integer");
    // Holder-label prefix (sandbox tagging): composed here so every adapter
    // gets identical behavior; falls back to agentId when no label is given.
    let agentLabel = p.agentLabel;
    if (p.labelPrefix !== undefined) {
      const prefix = p.labelPrefix.trim();
      if (!prefix) throw new ProtocolError("invalid", "labelPrefix must be a non-empty string");
      agentLabel = `${prefix}:${p.agentLabel ?? p.agentId}`;
    }

    // Idempotency: a live request for the same (agent, op) returns its state
    // (including its offer/permit token for the owner).
    const existing = this.liveEntryByOpKey(p.agentId, p.opKey);
    if (existing) {
      const s =
        existing.state === "held"
          ? "granted"
          : existing.state === "offered"
            ? "offered"
            : existing.state === "paused"
              ? "paused"
              : "queued";
      return { state: s, entry: this.ownerSnapshot(existing) } as AcquireResult;
    }

    if (this.used(pool) + weight <= this.capacity(pool)) {
      // Immediate grant: capacity is free. A permit token is issued directly;
      // the start deadline still applies (execution must begin, then track).
      const e: Entry = {
        id: rid(),
        pool,
        agentId: p.agentId,
        agentLabel,
        cwd: p.cwd,
        opKey: p.opKey,
        reason: p.reason,
        weight,
        state: "held",
        since: this.now(),
        startedAt: undefined,
      };
      this.entries.set(e.id, e);
      this.newPermit(e);
      this.byKey.set(`${e.agentId}\u0000${e.opKey}`, e.id);
      this.emit("granted", e);
      return { state: "granted", entry: this.ownerSnapshot(e) };
    }

    if (p.subscribeIfBusy === false) {
      return { state: "denied", entry: null };
    }

    const e: Entry = {
      id: rid(),
      pool,
      agentId: p.agentId,
      agentLabel,
      cwd: p.cwd,
      opKey: p.opKey,
      reason: p.reason,
      weight,
      state: "queued",
      since: this.now(),
      enqueuedAt: this.now(),
    };
    this.entries.set(e.id, e);
    this.byKey.set(`${e.agentId}\u0000${e.opKey}`, e.id);
    if (!this.queues.has(pool)) this.queues.set(pool, []);
    this.queues.get(pool)!.push(e.id);
    this.emit("queued", e);
    return { state: "queued", entry: this.ownerSnapshot(e) };
  }

  // ------------------------------------------------------------------- claim

  claim(offerToken: string): ClaimResult {
    const id = this.offerTokens.get(offerToken);
    if (!id) {
      // A recently expired/declined offer gives the precise error instead of
      // a generic stale-token one (bounded; pruned with terminal entries).
      if (this.expiredOffers.has(offerToken)) {
        throw new ProtocolError("offer_expired", "claim window elapsed; the request is now paused — rejoin when ready");
      }
      throw new ProtocolError("stale_token", "unknown offer token (it may have expired, been claimed, or the daemon restarted)");
    }
    const e = this.entries.get(id)!;
    if (e.state !== "offered") throw new ProtocolError("wrong_state", `request is ${e.state}, not offered`);
    if (this.now() >= e.offerExpiresAt!) {
      // Deterministic even if the expiry timer has not fired yet.
      this.expireOffer(e);
      throw new ProtocolError("offer_expired", "claim window elapsed; the request is now paused — rejoin when ready");
    }
    e.state = "held";
    e.since = this.now();
    e.offerToken = undefined;
    this.offerTokens.delete(offerToken);
    this.newPermit(e);
    this.emit("claimed", e);
    return { entry: this.ownerSnapshot(e) };
  }

  /** Daemon-side claim by request id (used for bounded waits). */
  claimByRequestId(requestId: string): { entry: OwnerEntrySnapshot } {
    const e = this.entries.get(requestId);
    if (!e) throw new ProtocolError("not_found", "unknown request id");
    if (e.state !== "offered") throw new ProtocolError("wrong_state", `request is ${e.state}, not offered`);
    return this.claim(e.offerToken!);
  }

  // -------------------------------------------------------------- start / run

  /**
   * Associate a claimed permit with a real process. Atomic with respect to
   * reclamation: succeeds only if the permit is held and still in a startable
   * phase; afterwards the permit is protected by process tracking instead of
   * the start deadline. Callers that spawn the job first must kill it if this
   * call fails (see `load-lock run` / run_with_permit helpers).
   */
  startJob(permitToken: string, pid: number, pgid?: number, pidStartTime?: string): OwnerEntrySnapshot {
    const e = this.heldByPermit(permitToken);
    if (!e) throw new ProtocolError("stale_token", "unknown permit token (already released or the daemon restarted without a journal entry)");
    if (e.phase !== "claimed") {
      throw new ProtocolError("wrong_state", `permit is ${e.phase ?? e.state}; cannot start`);
    }
    if (!Number.isInteger(pid) || pid <= 0) throw new ProtocolError("invalid", "pid must be a positive integer");
    e.phase = "running_tracked";
    e.startDeadline = undefined;
    e.pid = pid;
    e.pgid = pgid;
    e.pidStartTime = pidStartTime;
    e.startedAt = this.now();
    this.emit("started", e, { detail: `tracked pid ${pid}` });
    return this.ownerSnapshot(e);
  }

  /**
   * Explicit "I started the work, but I cannot associate a process".
   * The untracked lease applies: renewed by automatic adapter heartbeats,
   * reclaimed when the owning agent is gone. Documented weaker guarantee.
   */
  markStarted(permitToken: string): OwnerEntrySnapshot {
    const e = this.heldByPermit(permitToken);
    if (!e) throw new ProtocolError("stale_token", "unknown permit token (already released or the daemon restarted without a journal entry)");
    if (e.phase !== "claimed") throw new ProtocolError("wrong_state", `permit is ${e.phase ?? e.state}; cannot start`);
    e.phase = "running_untracked";
    e.startDeadline = undefined;
    e.startedAt = this.now();
    e.lastSeen = this.now();
    e.leaseDeadline = this.now() + this.config.untrackedLeaseMs;
    this.emit("started", e, { detail: "untracked (lease applies)" });
    return this.ownerSnapshot(e);
  }

  /** Adapter heartbeat: extends untracked leases and records agent liveness. */
  heartbeat(agentId: string): void {
    const now = this.now();
    for (const e of this.entries.values()) {
      if (e.agentId !== agentId) continue;
      if (e.state === "held") {
        e.lastSeen = now;
        if (e.phase === "running_untracked") e.leaseDeadline = now + this.config.untrackedLeaseMs;
      }
    }
  }

  // ------------------------------------------------------------------ release

  /** Idempotent release: a second release returns the terminal state. */
  release(permitToken: string): ReleaseResult {
    const id = this.permitTokens.get(permitToken);
    if (!id) throw new ProtocolError("stale_token", "unknown permit token (already released or the daemon restarted without a journal entry)");
    const e = this.entries.get(id)!;
    if (e.state === "released") {
      return { entry: this.snapshot(e), releasedNow: false }; // idempotent
    }
    if (e.state !== "held") throw new ProtocolError("wrong_state", `request is ${e.state}, not held`);
    this.finish(e, "released");
    return { entry: this.snapshot(e), releasedNow: true };
  }

  /**
   * Daemon-internal release with positive evidence of job death (tracked).
   * Never expires a permit whose process is merely unknown — callers must
   * only invoke this with confirmed death of pid/pgid.
   */
  autoRelease(entryId: string, cause: string): void {
    const e = this.entries.get(entryId);
    if (!e || e.state !== "held") return;
    this.finish(e, "auto_released", cause);
  }

  /**
   * Reclaim: start deadline exceeded, untracked lease expired, or admin
   * force-release. Frees capacity for the queue.
   */
  private reclaim(e: Entry, cause: string): void {
    this.finish(e, "reclaimed", cause);
  }

  private finish(e: Entry, eventType: EventType, detail?: string): void {
    const pool = e.pool;
    e.state = "released";
    e.since = this.now();
    this.retire(e);
    this.emit(eventType, e, detail ? { detail } : undefined);
    this.admit(pool);
  }

  // ------------------------------------------------------------------ expiry

  /** Expire one offered entry (timer-driven or claim-time). */
  private expireOffer(e: Entry): void {
    e.state = "paused";
    e.since = this.now();
    if (e.offerToken) {
      this.offerTokens.delete(e.offerToken);
      this.rememberExpired(e.offerToken);
    }
    e.offerToken = undefined;
    e.offerExpiresAt = undefined;
    this.emit("offer_expired", e);
    this.emit("paused", e);
    this.admit(e.pool);
  }

  /** Nearest future deadline of any kind, or null. The daemon arms timers with this. */
  nextExpiry(): number | null {
    let best: number | null = null;
    const consider = (t: number | undefined) => {
      if (t !== undefined && (best === null || t < best)) best = t;
    };
    for (const e of this.entries.values()) {
      if (e.state === "offered") consider(e.offerExpiresAt);
      if (e.state === "held") {
        if (e.phase === "claimed") consider(e.startDeadline);
        if (e.phase === "running_untracked") consider(e.leaseDeadline);
      }
    }
    return best;
  }

  /** Called by the daemon at each tick: expire offers, reclaim stale permits, prune. */
  tick(now: number): void {
    for (const e of [...this.entries.values()]) {
      if (e.state === "offered" && e.offerExpiresAt !== undefined && now >= e.offerExpiresAt) {
        this.expireOffer(e);
      } else if (e.state === "held" && e.phase === "claimed" && e.startDeadline !== undefined && now >= e.startDeadline) {
        this.reclaim(e, "start deadline exceeded: permit was claimed but execution never started");
      } else if (
        e.state === "held" &&
        e.phase === "running_untracked" &&
        e.leaseDeadline !== undefined &&
        now >= e.leaseDeadline
      ) {
        this.reclaim(e, "untracked lease expired: no heartbeat from the owning agent");
      }
    }
    this.prune(now);
  }

  /** Drop terminal entries (and their idempotency token mappings) after 1h. */
  private prune(now: number): void {
    for (const e of [...this.entries.values()]) {
      if ((e.state === "released" || e.state === "cancelled") && now - e.since > PRUNE_AFTER_MS) {
        if (e.permitToken) this.permitTokens.delete(e.permitToken);
        if (e.offerToken) this.offerTokens.delete(e.offerToken);
        this.entries.delete(e.id);
      }
    }
    if (this.expiredOffers.size > 500) {
      for (const [tok, ts] of [...this.expiredOffers]) {
        if (now - ts > 10 * 60_000) this.expiredOffers.delete(tok);
      }
    }
  }

  private rememberExpired(offerToken: string): void {
    this.expiredOffers.set(offerToken, this.now());
  }

  // ------------------------------------------------------------ decline/rejoin

  decline(offerToken: string): void {
    const id = this.offerTokens.get(offerToken);
    if (!id) throw new ProtocolError("stale_token", "unknown offer token");
    const e = this.entries.get(id)!;
    if (e.state !== "offered") throw new ProtocolError("wrong_state", `request is ${e.state}, not offered`);
    e.state = "paused";
    e.since = this.now();
    if (e.offerToken) {
      this.offerTokens.delete(e.offerToken);
      this.rememberExpired(e.offerToken);
    }
    e.offerToken = undefined;
    e.offerExpiresAt = undefined;
    this.emit("declined", e);
    this.emit("paused", e);
    this.admit(e.pool);
  }

  rejoin(p: RejoinParams): OwnerEntrySnapshot {
    const e = this.entries.get(p.requestId);
    if (!e) throw new ProtocolError("not_found", "unknown request id");
    if (e.state !== "paused") throw new ProtocolError("wrong_state", `request is ${e.state}; only paused requests can rejoin`);
    e.state = "queued";
    e.since = this.now();
    if (!this.queues.has(e.pool)) this.queues.set(e.pool, []);
    this.queues.get(e.pool)!.push(e.id);
    this.emit("rejoined", e);
    this.emit("queued", e);
    this.admit(e.pool);
    return this.ownerSnapshot(e);
  }

  // ------------------------------------------------------------------ cancel

  cancel(p: CancelParams): CancelResult {
    const e = this.entries.get(p.requestId);
    if (!e) throw new ProtocolError("not_found", "unknown request id");
    if (e.state === "held") {
      if (p.admin) {
        this.finish(e, "reclaimed", "admin force-release");
        return { entry: this.snapshot(e) };
      }
      throw new ProtocolError("wrong_state", "request holds a permit; release it (or admin_release via CLI) instead of cancelling");
    }
    if (e.state === "released" || e.state === "cancelled") {
      return { entry: this.snapshot(e) }; // idempotent
    }
    e.state = "cancelled";
    e.since = this.now();
    if (e.offerToken) {
      this.offerTokens.delete(e.offerToken);
      this.rememberExpired(e.offerToken);
      e.offerToken = undefined;
      e.offerExpiresAt = undefined;
    }
    this.dequeue(e);
    this.retire(e);
    this.emit("cancelled", e);
    this.admit(e.pool);
    return { entry: this.snapshot(e) };
  }

  // ------------------------------------------------------------------ pending

  pending(agentId: string): {
    offers: OwnerEntrySnapshot[];
    queue: OwnerEntrySnapshot[];
    paused: OwnerEntrySnapshot[];
    held: OwnerEntrySnapshot[];
  } {
    const offers: OwnerEntrySnapshot[] = [];
    const queue: OwnerEntrySnapshot[] = [];
    const paused: OwnerEntrySnapshot[] = [];
    const held: OwnerEntrySnapshot[] = [];
    for (const e of this.entries.values()) {
      if (e.agentId !== agentId) continue;
      if (e.state === "offered") offers.push(this.ownerSnapshot(e));
      else if (e.state === "queued") queue.push(this.ownerSnapshot(e));
      else if (e.state === "paused") paused.push(this.ownerSnapshot(e));
      else if (e.state === "held") held.push(this.ownerSnapshot(e));
    }
    offers.sort((a, b) => a.since - b.since);
    return { offers, queue, paused, held };
  }

  /** All outstanding offers (owner-scoped snapshots) — for cwd-matched wakeup. */
  allOffers(): OwnerEntrySnapshot[] {
    const out: OwnerEntrySnapshot[] = [];
    for (const e of this.entries.values()) if (e.state === "offered") out.push(this.ownerSnapshot(e));
    return out.sort((a, b) => a.since - b.since);
  }

  // ------------------------------------------------------------------- status

  status(pool?: string): StatusResult {
    const pools: PoolStatus[] = [];
    for (const name of pool ? [pool] : this.poolNames()) {
      if (!this.config.pools[name]) throw new ProtocolError("invalid", `unknown pool "${name}"`);
      const holders: EntrySnapshot[] = [];
      const offers: EntrySnapshot[] = [];
      const queue: EntrySnapshot[] = [];
      const paused: EntrySnapshot[] = [];
      const q = this.queues.get(name) ?? [];
      const qIds = new Set(q);
      for (const e of this.entries.values()) {
        if (e.pool !== name) continue;
        if (e.state === "held") holders.push(this.snapshot(e));
        else if (e.state === "offered") offers.push(this.snapshot(e));
        else if (e.state === "queued" && qIds.has(e.id)) queue.push(this.snapshot(e));
        else if (e.state === "paused") paused.push(this.snapshot(e));
      }
      holders.sort((a, b) => a.since - b.since);
      offers.sort((a, b) => a.since - b.since);
      paused.sort((a, b) => a.since - b.since);
      pools.push({ pool: name, capacity: this.capacity(name), used: this.used(name), holders, offers, queue, paused });
    }
    return {
      daemon: { pid: process.pid, startedAt: this.startedAt, protocolVersion: 1 },
      config: {
        version: this.config.version,
        pools: this.config.pools,
        offerTimeoutMs: this.config.offerTimeoutMs,
        maxWaitMs: this.config.maxWaitMs,
        maxTurnWaitMs: this.config.maxTurnWaitMs,
        startTimeoutMs: this.config.startTimeoutMs,
        untrackedLeaseMs: this.config.untrackedLeaseMs,
      },
      pools,
      events: { latestEventId: this.latestEventId() },
    };
  }

  /** Held permits — input for daemon liveness sweeps and CLI recovery. */
  heldEntries(): (EntrySnapshot & { pgid?: number })[] {
    const out: (EntrySnapshot & { pgid?: number })[] = [];
    for (const e of this.entries.values()) if (e.state === "held") out.push(this.snapshot(e) as EntrySnapshot & { pgid?: number });
    return out;
  }

  entryByPermit(permitToken: string): Entry | undefined {
    const id = this.permitTokens.get(permitToken);
    return id ? this.entries.get(id) : undefined;
  }

  private heldByPermit(permitToken: string): Entry | undefined {
    const e = this.entryByPermit(permitToken);
    if (e && e.state === "held") return e;
    return undefined;
  }

  entryById(requestId: string): { state: EntryState; phase?: PermitPhase } & EntrySnapshot {
    const e = this.entries.get(requestId);
    if (!e) throw new ProtocolError("not_found", "unknown request id");
    return e as unknown as { state: EntryState; phase?: PermitPhase } & EntrySnapshot;
  }

  ownerSnapshotById(requestId: string): OwnerEntrySnapshot | undefined {
    const e = this.entries.get(requestId);
    return e ? this.ownerSnapshot(e) : undefined;
  }

  offerTokenOf(requestId: string): string | undefined {
    const e = this.entries.get(requestId);
    return e?.offerToken;
  }

  /** Admin (CLI recovery) force-release of a held permit — reclaims capacity. */
  adminRelease(requestId: string): void {
    const e = this.entries.get(requestId);
    if (!e) throw new ProtocolError("not_found", "unknown request id");
    if (e.state !== "held") throw new ProtocolError("wrong_state", `request is ${e.state}; only held permits can be force-released`);
    this.finish(e, "reclaimed", "admin force-release");
  }

  // ------------------------------------------------------------- diagnostics

  /**
   * Recovery diagnostics for held permits. `liveness(pid, pgid, pidStartTime)`
   * is supplied by the daemon (reads /proc). Returns holder + job info and
   * which automatic cleanup applies. Long holds are flagged, never revoked
   * here.
   */
  diagnose(liveness: (e: { pid?: number; pgid?: number; pidStartTime?: string }) => boolean | null): HolderDiag[] {
    const now = this.now();
    const out: HolderDiag[] = [];
    for (const e of this.entries.values()) {
      if (e.state !== "held") continue;
      const snap = this.snapshot(e);
      const tracked = e.phase === "running_tracked";
      let processAlive: boolean | null = null;
      let note: string;
      if (e.phase === "claimed") {
        note = `claimed ${Math.round((now - e.since) / 1000)}s ago; execution must start within ${Math.round((this.config.startTimeoutMs - (now - e.since)) / 1000)}s or the permit is reclaimed`;
      } else if (tracked) {
        processAlive = liveness(e);
        note =
          processAlive === true
            ? `tracked process (pid ${e.pid}${e.pgid ? `, pgid ${e.pgid}` : ""}) is running; released automatically when it exits; never revoked on duration alone`
            : processAlive === false
              ? `tracked process appears dead; daemon will release on next sweep`
              : `tracked liveness unknown on this platform; permit surfaces here until force-released`;
      } else {
        const leaseLeft = e.leaseDeadline ? Math.round((e.leaseDeadline - now) / 1000) : 0;
        note = `untracked; heartbeat lease ${leaseLeft}s remaining — reclaimed when the owning agent stops heartbeating (overlap with an unobserved survivor is possible; see docs)`;
      }
      out.push({
        entry: snap,
        diagnostics: {
          tracked,
          processAlive,
          phaseAgeMs: now - e.since,
          lastSeenAgeMs: e.lastSeen ? now - e.lastSeen : undefined,
          longHold: now - e.since > LONG_HOLD_MS,
          note,
        },
      });
    }
    return out;
  }

  // ------------------------------------------------------------------- config

  get_config(): GetConfigResult {
    return {
      config: JSON.parse(JSON.stringify(this.config)) as MachineConfig,
      history: [...this.history],
    };
  }

  configure(p: ConfigureParams): ConfigureResult {
    if (p.expectedVersion !== this.config.version) {
      throw new ProtocolError(
        "version_conflict",
        `config version is ${this.config.version}, not ${p.expectedVersion}; re-read and retry`,
        { currentVersion: this.config.version },
      );
    }
    const c = p.changes;
    if (c.pools) {
      for (const [name, pc] of Object.entries(c.pools)) {
        if (!Number.isInteger(pc.capacity) || pc.capacity < 0) {
          throw new ProtocolError("invalid", `pool "${name}": capacity must be a non-negative integer`);
        }
      }
    }
    if (c.offerTimeoutMs !== undefined && (c.offerTimeoutMs < 1000 || c.offerTimeoutMs > 600_000)) {
      throw new ProtocolError("invalid", "offerTimeoutMs must be within [1000, 600000]");
    }
    if (c.maxWaitMs !== undefined && (c.maxWaitMs < 0 || c.maxWaitMs > 600_000)) {
      throw new ProtocolError("invalid", "maxWaitMs must be within [0, 600000]");
    }
    if (c.maxTurnWaitMs !== undefined && (c.maxTurnWaitMs < 1000 || c.maxTurnWaitMs > 3_600_000)) {
      throw new ProtocolError("invalid", "maxTurnWaitMs must be within [1000, 3600000]");
    }
    if (c.startTimeoutMs !== undefined && (c.startTimeoutMs < 1000 || c.startTimeoutMs > 3_600_000)) {
      throw new ProtocolError("invalid", "startTimeoutMs must be within [1000, 3600000]");
    }
    if (c.untrackedLeaseMs !== undefined && (c.untrackedLeaseMs < 10_000 || c.untrackedLeaseMs > 24 * 3_600_000)) {
      throw new ProtocolError("invalid", "untrackedLeaseMs must be within [10000, 86400000]");
    }

    this.config.version += 1;
    if (c.pools) {
      for (const [name, pc] of Object.entries(c.pools)) this.config.pools[name] = { capacity: pc.capacity };
    }
    if (c.offerTimeoutMs !== undefined) this.config.offerTimeoutMs = c.offerTimeoutMs;
    if (c.maxWaitMs !== undefined) this.config.maxWaitMs = c.maxWaitMs;
    if (c.maxTurnWaitMs !== undefined) this.config.maxTurnWaitMs = c.maxTurnWaitMs;
    if (c.startTimeoutMs !== undefined) this.config.startTimeoutMs = c.startTimeoutMs;
    if (c.untrackedLeaseMs !== undefined) this.config.untrackedLeaseMs = c.untrackedLeaseMs;
    this.config.guidance = this.config.guidance ?? {};
    if (c.guidance) {
      if (c.guidance.heavyWorkHeuristic !== undefined) this.config.guidance.heavyWorkHeuristic = c.guidance.heavyWorkHeuristic;
      if (c.guidance.notes !== undefined) this.config.guidance.notes = c.guidance.notes;
      if (c.guidance.agent) {
        const a = c.guidance.agent;
        this.config.guidance.agents = this.config.guidance.agents ?? {};
        const prev = this.config.guidance.agents[a.id] ?? {};
        this.config.guidance.agents[a.id] = {
          parallelism: a.parallelism ?? prev.parallelism,
          note: a.note ?? prev.note,
          updatedBy: p.author,
          updatedAt: this.now(),
        };
      }
    }

    this.history.push({
      ts: this.now(),
      author: p.author,
      reason: p.reason,
      changes: JSON.parse(JSON.stringify(c)) as ConfigChange,
      resultingVersion: this.config.version,
    });
    if (this.history.length > MAX_HISTORY) this.history.splice(0, this.history.length - MAX_HISTORY);

    this.pushEvent({
      type: "config_changed",
      targetAgent: "*",
      detail: `by ${p.author}: ${p.reason}`,
    });

    // Capacity increase: admit queued immediately. Decrease: holders keep
    // running; admissions wait until usage drops below the new capacity.
    for (const name of this.poolNames()) this.admit(name);

    return this.get_config();
  }

  history: ConfigHistoryEntry[] = [];

  // ----------------------------------------------------------------- journal

  /** Held permits (first) and queued/offered requests to persist across restarts. */
  journalEntries(): JournalEntry[] {
    const out: JournalEntry[] = [];
    for (const e of this.entries.values()) {
      if (e.state !== "held") continue;
      out.push({
        requestId: e.id,
        pool: e.pool,
        agentId: e.agentId,
        agentLabel: e.agentLabel,
        cwd: e.cwd,
        opKey: e.opKey,
        reason: e.reason,
        weight: e.weight,
        state: "held",
        permitToken: e.permitToken,
        phase: e.phase ?? "claimed",
        pid: e.pid,
        pgid: e.pgid,
        pidStartTime: e.pidStartTime,
        claimedAt: e.since,
        startedAt: e.startedAt,
        leaseDeadline: e.leaseDeadline,
      });
    }
    for (const e of this.entries.values()) {
      if (e.state !== "queued" && e.state !== "offered") continue;
      out.push({
        requestId: e.id,
        pool: e.pool,
        agentId: e.agentId,
        agentLabel: e.agentLabel,
        cwd: e.cwd,
        opKey: e.opKey,
        reason: e.reason,
        weight: e.weight,
        state: "queued",
        enqueuedAt: e.enqueuedAt ?? e.since,
        claimedAt: e.since,
      });
    }
    return out;
  }

  /**
   * Restore state after a daemon restart (conservative reconciliation):
   *  - queued (incl. previously offered): re-queued FIFO by original enqueue
   *    time, same requestIds so idempotent re-acquire still works; pools no
   *    longer in the config are dropped. Offered entries restart as queued
   *    and get a fresh offer (old offer tokens are invalid after restart).
   *  - tracked: re-check liveness via the supplied probe; dead => release,
   *    alive => keep (same token, so a late explicit release still works).
   *  - claimed: keep the start deadline (reclaimed by tick if already past).
   *  - untracked: keep, with a FRESH lease window from restore time.
   */
  restore(journal: JournalEntry[], liveness: (e: { pid?: number; pgid?: number; pidStartTime?: string }) => boolean | null): {
    kept: number;
    releasedDead: number;
    queued: number;
  } {
    let kept = 0;
    let releasedDead = 0;
    const queuedEntries: Array<{ j: JournalEntry; at: number }> = [];
    for (const j of journal) {
      if (j.state === "queued") {
        queuedEntries.push({ j, at: j.enqueuedAt ?? j.claimedAt });
        continue;
      }
      const e: Entry = {
        id: j.requestId,
        pool: j.pool,
        agentId: j.agentId,
        agentLabel: j.agentLabel,
        cwd: j.cwd,
        opKey: j.opKey,
        reason: j.reason,
        weight: j.weight,
        state: "held",
        since: j.claimedAt,
        permitToken: j.permitToken,
        phase: j.phase ?? "claimed",
        pid: j.pid,
        pgid: j.pgid,
        pidStartTime: j.pidStartTime,
        startedAt: j.startedAt,
        lastSeen: this.now(),
      };
      if (e.phase === "claimed") {
        e.startDeadline = j.claimedAt + this.config.startTimeoutMs;
      } else if (e.phase === "running_untracked") {
        e.leaseDeadline = this.now() + this.config.untrackedLeaseMs; // fresh window
      } else if (e.phase === "running_tracked") {
        const alive = liveness(e);
        if (alive === false) {
          // Confirmed dead while we were down: release, but keep a terminal
          // entry + token mapping so a late/duplicate release is idempotent.
          e.state = "released";
          e.since = this.now();
          this.entries.set(e.id, e);
          if (e.permitToken) this.permitTokens.set(e.permitToken, e.id);
          releasedDead++;
          continue;
        }
      }
      this.entries.set(e.id, e);
      if (e.permitToken) this.permitTokens.set(e.permitToken, e.id);
      this.byKey.set(`${e.agentId}\u0000${e.opKey}`, e.id);
      kept++;
    }
    // Re-queue queued requests, oldest first, preserving FIFO fairness.
    queuedEntries.sort((a, b) => a.at - b.at);
    let queued = 0;
    for (const { j } of queuedEntries) {
      if (!this.config.pools[j.pool]) continue; // pool removed while down
      const e: Entry = {
        id: j.requestId,
        pool: j.pool,
        agentId: j.agentId,
        agentLabel: j.agentLabel,
        cwd: j.cwd,
        opKey: j.opKey,
        reason: j.reason,
        weight: j.weight,
        state: "queued",
        since: this.now(),
        enqueuedAt: j.enqueuedAt ?? j.claimedAt,
      };
      this.entries.set(e.id, e);
      this.byKey.set(`${e.agentId}\u0000${e.opKey}`, e.id);
      if (!this.queues.has(e.pool)) this.queues.set(e.pool, []);
      this.queues.get(e.pool)!.push(e.id);
      queued++;
    }
    // Admit newly-eligible waiters (capacity freed while we were down).
    for (const name of this.poolNames()) this.admit(name);
    this.pushEvent({
      type: "daemon_recovered",
      targetAgent: "*",
      detail: `restored ${kept} held permit(s) from journal (${releasedDead} confirmed dead and released); re-queued ${queued} waiting request(s)`,
    });
    return { kept, releasedDead, queued };
  }
}
