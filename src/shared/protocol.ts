/**
 * load-lock shared wire protocol types.
 *
 * Transport: newline-delimited JSON (NDJSON) over a Unix domain socket.
 * Each line is one request or one response; watch connections additionally
 * receive unsolicited event lines.
 *
 * Request:  {"id": <number>, "method": "<name>", "params": {...}}
 * Response: {"id": <number>, "ok": true, "result": {...}}
 *           {"id": <number>, "ok": false, "error": {"code": "...", "message": "..."}}
 * Watch push: {"event": true, ...event fields...}
 */

export const DAEMON_PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------------------
// Errors

export type ErrorCode =
  | "invalid" // malformed params
  | "not_found" // unknown request/token id
  | "stale_token" // token not recognized (e.g. reclaimed, or daemon restarted without a journal entry)
  | "offer_expired" // offer window elapsed; capacity was passed on
  | "wrong_state" // e.g. cancel on a held permit, claim on a non-offer
  | "version_conflict" // configure() expected_version mismatch
  | "denied" // subscribe_if_busy=false and pool is full, or duplicate daemon
  | "unavailable" // daemon not reachable
  | "internal";

export class ProtocolError extends Error {
  code: ErrorCode;
  details?: unknown;
  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

// ---------------------------------------------------------------------------
// Config

export interface PoolConfig {
  /** Maximum total weight admitted concurrently (permits + outstanding offers). */
  capacity: number;
}

export interface MachineConfig {
  /** Monotonically increasing; used for compare-and-swap configure(). */
  version: number;
  pools: Record<string, PoolConfig>;
  /** Claim window for offers, in milliseconds. */
  offerTimeoutMs: number;
  /** Upper bound for bounded blocking waits in acquire (advisory). */
  maxWaitMs: number;
  /**
   * Upper bound for ONE wait_for_turn call ("sleep until it is my turn",
   * issue #11), in milliseconds. Callers' timeout_ms is clamped to this —
   * operators tune how long an agent may block in a single tool call.
   */
  maxTurnWaitMs: number;
  /**
   * Start deadline: after a permit is claimed/granted, execution must begin
   * (run_with_permit / attach_pid / mark_started) within this window, or the
   * permit is reclaimed automatically. Covers "claimed but never started".
   */
  startTimeoutMs: number;
  /**
   * Lease for running permits that have NO process association: renewed by
   * automatic adapter heartbeats; expires when the owning agent is gone.
   * Tracked permits are never leased — they are released on confirmed job
   * death instead. See docs/ARCHITECTURE.md for the explicit tradeoff.
   */
  untrackedLeaseMs: number;
  /**
   * Free-form heavy-vs-light guidance text agents can publish for humans
   * and other agents (e.g. "cargo build+test count as heavy; prefer 2 test threads").
   */
  guidance: {
    heavyWorkHeuristic?: string;
    notes?: string;
    agents?: Record<string, { parallelism?: string; note?: string; updatedBy?: string; updatedAt?: number }>;
  };
}

export interface ConfigChange {
  pools?: Record<string, PoolConfig>;
  offerTimeoutMs?: number;
  maxWaitMs?: number;
  maxTurnWaitMs?: number;
  startTimeoutMs?: number;
  untrackedLeaseMs?: number;
  guidance?: {
    heavyWorkHeuristic?: string;
    notes?: string;
    agent?: { id: string; parallelism?: string; note?: string };
  };
}

export interface ConfigHistoryEntry {
  ts: number;
  author: string;
  reason: string;
  changes: ConfigChange;
  resultingVersion: number;
}

export interface PersistedState {
  config: MachineConfig;
  history: ConfigHistoryEntry[];
}

// ---------------------------------------------------------------------------
// Entries (requests), tokens, permit lifecycle

export type EntryState =
  | "queued" // waiting for capacity (FIFO)
  | "offered" // capacity reserved for us; claim window ticking
  | "held" // permit held; heavy work authorized
  | "paused" // offer expired / declined; rejoins only via rejoin()
  | "released" // terminal (normal release, reclaim, or confirmed job end)
  | "cancelled"; // terminal

/**
 * Lifecycle phase of a held permit.
 *
 *  claimed          -> claimed, execution not yet started; start deadline ticking
 *  running_tracked  -> associated with a real process (pid + start time, and
 *                      usually a process group); released on confirmed death
 *  running_untracked-> agent said "I started work" but no process association;
 *                      heartbeat-renewed lease applies (documented tradeoff)
 */
export type PermitPhase = "claimed" | "running_tracked" | "running_untracked";

export interface EntrySnapshot {
  requestId: string;
  pool: string;
  agentId: string;
  agentLabel?: string;
  cwd?: string;
  opKey: string;
  reason: string;
  weight: number;
  state: EntryState;
  /** Present when state === "held". */
  phase?: PermitPhase;
  since: number; // when the request entered its current state (epoch ms)
  /** 1-based FIFO position, only for queued entries. */
  position?: number;
  pid?: number;
  pgid?: number;
  pidStartTime?: string;
  offerExpiresAt?: number;
  startDeadline?: number;
  leaseDeadline?: number;
  lastSeen?: number;
  heldFor?: number;
}

/** Owner-scoped snapshot: includes tokens. Never returned to non-owners. */
export interface OwnerEntrySnapshot extends EntrySnapshot {
  offerToken?: string;
  permitToken?: string;
}

// ---------------------------------------------------------------------------
// Journal (conservative restart reconciliation for held permits)

export interface JournalEntry {
  requestId: string;
  pool: string;
  agentId: string;
  agentLabel?: string;
  cwd?: string;
  opKey: string;
  reason: string;
  weight: number;
  permitToken: string;
  phase: PermitPhase;
  pid?: number;
  pgid?: number;
  pidStartTime?: string;
  claimedAt: number;
  startedAt?: number;
  leaseDeadline?: number;
}

// ---------------------------------------------------------------------------
// Machine status / inspect

export interface PoolStatus {
  pool: string;
  capacity: number;
  used: number; // weight held + offered
  holders: EntrySnapshot[];
  offers: EntrySnapshot[];
  queue: EntrySnapshot[];
  paused: EntrySnapshot[];
}

export interface StatusResult {
  daemon: { pid: number; startedAt: number; protocolVersion: number };
  config: {
    version: number;
    pools: Record<string, PoolConfig>;
    offerTimeoutMs: number;
    maxWaitMs: number;
    maxTurnWaitMs: number;
    startTimeoutMs: number;
    untrackedLeaseMs: number;
  };
  pools: PoolStatus[];
  events: { latestEventId: number };
}

export interface CpuInfo {
  logicalCores: number;
  model?: string;
  loadavg: [number, number, number];
  cgroupVersion?: string;
  cgroupCpuQuota?: number | null; // e.g. 200 = 2.0 CPUs, null = unlimited
  cgroupCpuPeriod?: number | null;
  effectiveCores: number; // min(logical, quota) — "don't assume 2 cores = 2 jobs"
  loadPerEffectiveCore: number;
}

export interface MemInfo {
  totalBytes: number;
  availableBytes: number;
  freeBytes: number;
  cgroupMemoryLimitBytes?: number | null;
  cgroupMemoryUsageBytes?: number | null;
  effectiveLimitBytes: number; // min(physical, cgroup limit)
}

export interface InspectResult {
  cpu: CpuInfo;
  memory: MemInfo;
  pressure: {
    note: string; // human-readable current pressure summary
    loadPressure: "low" | "moderate" | "high";
    memPressure: "low" | "moderate" | "high";
  };
  loadLock: { pools: Record<string, PoolConfig>; suggestion: string };
}

// ---------------------------------------------------------------------------
// Events (durable identities, pull- or push-delivered)

export type EventType =
  | "daemon_started"
  | "daemon_recovered" // journal reconciliation after restart
  | "granted" // acquire got a permit immediately
  | "queued"
  | "offered" // queue -> offer; capacity reserved; claim window started
  | "claimed" // offer -> permit (phase: claimed; start deadline ticking)
  | "started" // claimed -> running_tracked or running_untracked
  | "released" // normal release (or confirmed job end)
  | "auto_released" // tracked process observed dead -> automatic release
  | "reclaimed" // start deadline exceeded, untracked lease expired, or admin force-release
  | "offer_expired" // claim window elapsed; request paused
  | "declined"
  | "paused"
  | "rejoined"
  | "cancelled"
  | "config_changed";

export interface MachineEvent {
  id: number;
  ts: number;
  type: EventType;
  pool?: string;
  /** Target agent for routing; "*" for broadcasts (config changes). */
  targetAgent?: string;
  entry?: EntrySnapshot;
  /** Present on `offered` events delivered to the owner: the claim token. */
  offerToken?: string;
  detail?: string;
}

// ---------------------------------------------------------------------------
// RPC params/results

export interface AcquireParams {
  pool?: string; // default "heavy"
  agentId: string;
  agentLabel?: string;
  /**
   * Optional prefix prepended to the holder label (composed daemon-side) so
   * sandboxed/thin clients are identifiable in the dashboard, e.g.
   * labelPrefix "omac" + agentLabel "issue-42 build" -> "omac:issue-42
   * build". Falls back to agentId when no agentLabel is given. Adapters may
   * source it from LOAD_LOCK_LABEL_PREFIX (the shared client injects it).
   */
  labelPrefix?: string;
  cwd?: string;
  opKey: string; // idempotency key: identifies the pending operation
  reason: string;
  weight?: number; // default 1
  subscribeIfBusy?: boolean; // default true
  waitMs?: number; // bounded blocking wait, clamped to config.maxWaitMs
  pid?: number; // deprecated shorthand: associate immediately (running_tracked)
  pidStartTime?: string;
}

export type AcquireResult =
  | { state: "granted"; entry: OwnerEntrySnapshot }
  | { state: "offered"; entry: OwnerEntrySnapshot } // queued earlier; an offer is waiting for claim()
  | { state: "queued"; entry: OwnerEntrySnapshot }
  | { state: "paused"; entry: OwnerEntrySnapshot }
  | { state: "denied"; entry: null };

export interface ClaimParams {
  offerToken: string;
}
export interface ClaimResult {
  entry: OwnerEntrySnapshot;
}

export interface ReleaseParams {
  permitToken: string;
  outcome?: "success" | "failure" | "terminated" | "done";
}
export interface ReleaseResult {
  entry: EntrySnapshot;
  /** True if this call actually performed the release (false = already terminal). */
  releasedNow: boolean;
}

export interface CancelParams {
  requestId: string;
  admin?: boolean; // CLI recovery only
}
export interface CancelResult {
  entry: EntrySnapshot;
}

export interface DeclineParams {
  offerToken: string;
}

export interface RejoinParams {
  requestId: string;
}

/** Start job: associate a claimed permit with a real process. Atomic wrt reclamation. */
export interface StartJobParams {
  permitToken: string;
  pid: number;
  pgid?: number; // process group of the job (covers subprocesses/background jobs)
}

/** Mark started without process association: untracked lease applies. */
export interface MarkStartedParams {
  permitToken: string;
}

export interface HeartbeatParams {
  agentId: string;
}

export interface PendingParams {
  agentId: string;
}
export interface PendingResult {
  offers: OwnerEntrySnapshot[]; // offers addressed to this agent
  queue: OwnerEntrySnapshot[]; // this agent's queued entries
  paused: OwnerEntrySnapshot[];
  held: OwnerEntrySnapshot[];
}

export interface StatusParams {
  pool?: string;
}

export interface GetConfigResult {
  config: MachineConfig;
  history: ConfigHistoryEntry[];
}

export interface ConfigureParams {
  expectedVersion: number;
  changes: ConfigChange;
  reason: string;
  author: string;
}
export interface ConfigureResult {
  config: MachineConfig;
  history: ConfigHistoryEntry[];
}

export interface EventsParams {
  agentId?: string; // filter targeted events; omitted = all
  sinceEventId?: number;
  limit?: number;
}
export interface EventsResult {
  events: MachineEvent[];
  latestEventId: number;
}

// ---------------------------------------------------------------------------
// wait_for_turn (issue #11): bounded "sleep until it is my turn" for a
// queued request. One shared client-side implementation serves the CLI
// `wait` command, the MCP `wait_for_turn` tool and the OpenCode plugin's
// `load_lock_wait_for_turn` tool (src/shared/wait-turn.ts). The wait holds
// no permit and no capacity — it is light work — and every resolution path
// returns a structured result, not an error.

export type WaitForTurnState =
  | "granted" // permit held (auto-claimed or already held); permit_token in entry
  | "still_queued" // timed out; request still queued — position + holders included
  | "paused" // offer expired / declined meanwhile; rejoin when ready
  | "cancelled" // request cancelled meanwhile
  | "not_found"; // request unknown (never existed / ended / pruned / daemon restarted)

export interface WaitForTurnResult {
  state: WaitForTurnState;
  requestId?: string;
  /** True when THIS wait claimed the offer on the caller's behalf (explicit auto-claim). */
  autoClaimed?: boolean;
  /** How long the wait actually ran before resolving (ms). */
  waitedMs: number;
  /** The clamped budget actually applied, when it differed from the requested one. */
  effectiveWaitMs?: number;
  /** Owner snapshot of the request at resolution time (carries permit_token when granted). */
  entry?: OwnerEntrySnapshot;
  /** 1-based FIFO position (still_queued). */
  queuePosition?: number;
  /** Queue depth of the request's pool (still_queued). */
  queueLength?: number;
  /** Who holds the pool's capacity (still_queued) — the agents ahead of you. */
  holders?: EntrySnapshot[];
  nextAction: string;
  detail?: string;
}

/** Recovery diagnostics: held permits with holder + job information. */
export interface HolderDiag {
  entry: EntrySnapshot;
  diagnostics: {
    tracked: boolean;
    processAlive?: boolean | null; // null = unknown (macOS fallback)
    phaseAgeMs: number;
    lastSeenAgeMs?: number;
    longHold: boolean; // heldFor exceeds 30 min
    note: string; // human explanation incl. which cleanup applies
  };
}
