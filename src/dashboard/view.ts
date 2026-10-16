/**
 * Dashboard view-model: pure shaping of daemon data (status / inspect /
 * durable events) into the cards every dashboard surface renders.
 *
 * Shared by `load-lock top` (src/cli/top.ts) and the OpenCode TUI plugin
 * (src/adapters/opencode/tui.tsx) so both show exactly the same state and
 * only differ in rendering. Everything here is pure and synchronous —
 * "now" is always an explicit parameter, which makes countdowns testable.
 */
import type * as P from "../shared/protocol.js";

// ------------------------------------------------------------------ feed state

/** Connection state of the dashboard's daemon feed. */
export type FeedState = "connecting" | "live" | "reconnecting" | "down";

// ---------------------------------------------------------------------- cards

export interface HolderCard {
  requestId: string;
  pool: string;
  agent: string; // agentLabel || agentId
  agentId: string;
  reason: string;
  weight: number;
  phase: P.PermitPhase;
  /** "claimed (must start)", "running (tracked)", "running (untracked)" */
  phaseLabel: string;
  pid?: number;
  pgid?: number;
  /** How long the permit has been held (now - claimedAt proxy). */
  heldMs: number;
  /** Only for phase "claimed": ms until the start deadline reclaims it. */
  startDeadlineInMs?: number;
  /** Only for phase "running_untracked": ms until the lease lapses. */
  leaseDeadlineInMs?: number;
}

export interface OfferCard {
  requestId: string;
  pool: string;
  agent: string;
  agentId: string;
  reason: string;
  weight: number;
  /** ms remaining in the claim window (can be slightly negative pre-event). */
  claimInMs: number;
  expiresAt: number;
}

export interface QueueCard {
  requestId: string;
  pool: string;
  agent: string;
  agentId: string;
  reason: string;
  weight: number;
  position: number;
  /** How long the request has been queued. */
  waitMs: number;
}

export interface PausedCard {
  requestId: string;
  pool: string;
  agent: string;
  agentId: string;
  reason: string;
  weight: number;
  /** How long it has been paused. */
  pausedMs: number;
}

export interface PoolView {
  pool: string;
  capacity: number;
  used: number; // held + offered weight (daemon accounting)
  heldWeight: number;
  offeredWeight: number;
  free: number;
  utilization: number; // used/capacity, 0..1 (1 when capacity 0)
  holders: HolderCard[];
  offers: OfferCard[];
  queue: QueueCard[];
  paused: PausedCard[];
}

export interface EventLine {
  id: number;
  ts: number;
  agoMs: number;
  type: P.EventType;
  pool?: string;
  text: string;
}

export interface MachineView {
  cpuModel?: string;
  logicalCores: number;
  effectiveCores: number;
  cgroupVersion?: string;
  cgroupCpuQuota?: number | null;
  loadavg: [number, number, number];
  loadPerEffectiveCore: number;
  memTotalBytes: number;
  memAvailableBytes: number;
  memEffectiveLimitBytes: number;
  loadPressure: "low" | "moderate" | "high";
  memPressure: "low" | "moderate" | "high";
  note: string;
  suggestion?: string;
}

export interface DaemonView {
  pid: number;
  startedAt: number;
  uptimeMs: number;
  protocolVersion: number;
  configVersion: number;
}

/** The complete render-ready snapshot of the machine-wide budget. */
export interface DashboardView {
  now: number;
  state: FeedState;
  /** False right after a daemon restart was detected (history was reset). */
  daemonRestartNote?: string;
  daemon: DaemonView | null;
  pools: PoolView[];
  events: EventLine[]; // newest first
  latestEventId: number;
  machine: MachineView | null;
  lastSyncAt: number;
}

// ---------------------------------------------------------------- formatters

/** Compact human duration: "412ms", "3s", "4m 12s", "2h 05m", "3d 4h". */
export function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms)) return "–";
  const neg = ms < 0;
  let s = Math.floor(Math.abs(ms) / 1000);
  let out: string;
  if (s < 1) out = `${Math.max(0, Math.round(Math.abs(ms)))}ms`;
  else if (s < 60) out = `${s}s`;
  else if (s < 3600) out = `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
  else if (s < 86400) out = `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
  else out = `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
  return neg ? `-${out}` : out;
}

/** Byte counts: "12.4Gi", "512Mi", "3.4Ki". */
export function fmtBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "–";
  const units = ["B", "Ki", "Mi", "Gi", "Ti"];
  let v = bytes;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v >= 100 || u === 0 ? Math.round(v) : v.toFixed(1)}${units[u]}`;
}

/** Local clock time HH:MM:SS. */
export function fmtClock(ts: number): string {
  const d = new Date(ts);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
}

/** One-line label for a permit phase. */
export function phaseLabel(p: P.PermitPhase): string {
  switch (p) {
    case "claimed":
      return "claimed (must start)";
    case "running_tracked":
      return "running (tracked)";
    case "running_untracked":
      return "running (untracked)";
  }
}

/** Truncate with ellipsis, keeping the head (ids, reasons). */
export function trunc(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(1, max - 1)) + "…";
}

export function agentName(e: { agentLabel?: string; agentId: string }): string {
  return e.agentLabel || e.agentId;
}

// -------------------------------------------------------------- event text

/** One-line human sentence for a daemon event (durable ids are kept). */
export function eventText(ev: P.MachineEvent): string {
  const who = ev.entry ? agentName(ev.entry) : ev.targetAgent && ev.targetAgent !== "*" ? ev.targetAgent : undefined;
  const reason = ev.entry?.reason ? ` (${trunc(ev.entry.reason, 48)})` : "";
  const w = who ? ` ${who}` : "";
  const detail = ev.detail ? ` — ${ev.detail}` : "";
  switch (ev.type) {
    case "daemon_started":
      return `daemon started${detail}`;
    case "daemon_recovered":
      return `daemon recovered after restart${detail}`;
    case "granted":
      return `granted ${ev.pool ?? ""}${w}${reason}`;
    case "queued":
      return `queued${w}${reason}`;
    case "offered":
      return `offered ${ev.pool ?? ""}${w} — awaiting claim${reason}`;
    case "claimed":
      return `claimed${w} — permit held${reason}`;
    case "started":
      return `started${w}: ${ev.detail ?? "execution began"}`;
    case "released":
      return `released ${ev.pool ?? ""}${w}${reason}${detail}`;
    case "auto_released":
      return `auto-released ${ev.pool ?? ""}${w}${detail}${reason}`;
    case "reclaimed":
      return `reclaimed ${ev.pool ?? ""}${w} — ${ev.detail ?? "permit revoked"}${reason}`;
    case "offer_expired":
      return `offer expired ${ev.pool ?? ""}${w} → paused (rejoin to requeue)`;
    case "declined":
      return `declined offer${w}${reason}`;
    case "paused":
      return `paused${w}${reason}`;
    case "rejoined":
      return `rejoined queue${w}${reason}`;
    case "cancelled":
      return `cancelled${w}${reason}`;
    case "config_changed":
      return `config changed: ${ev.detail ?? ""}`.trim();
    default:
      return `${String((ev as P.MachineEvent).type)}${w}${detail}`;
  }
}

// -------------------------------------------------------------- view builder

export interface DashboardInputs {
  status: P.StatusResult | null;
  inspect: P.InspectResult | null;
  /** Chronological (oldest first). The feed keeps the newest N. */
  events: P.MachineEvent[];
  latestEventId: number;
  state: FeedState;
  lastSyncAt: number;
  daemonRestartNote?: string;
  now: number;
}

function holderCard(e: P.EntrySnapshot, now: number): HolderCard {
  const phase = e.phase ?? "claimed";
  return {
    requestId: e.requestId,
    pool: e.pool,
    agent: agentName(e),
    agentId: e.agentId,
    reason: e.reason,
    weight: e.weight,
    phase,
    phaseLabel: phaseLabel(phase),
    pid: e.pid,
    pgid: e.pgid,
    heldMs: now - e.since,
    startDeadlineInMs: e.startDeadline !== undefined ? e.startDeadline - now : undefined,
    leaseDeadlineInMs: e.leaseDeadline !== undefined ? e.leaseDeadline - now : undefined,
  };
}

export function buildDashboardView(inps: DashboardInputs): DashboardView {
  const now = inps.now;
  const pools: PoolView[] = [];
  for (const p of inps.status?.pools ?? []) {
    const heldWeight = p.holders.reduce((a, h) => a + h.weight, 0);
    const offeredWeight = p.offers.reduce((a, o) => a + o.weight, 0);
    pools.push({
      pool: p.pool,
      capacity: p.capacity,
      used: p.used,
      heldWeight,
      offeredWeight,
      free: Math.max(0, p.capacity - p.used),
      utilization: p.capacity > 0 ? Math.min(1, p.used / p.capacity) : 1,
      holders: p.holders.map((h) => holderCard(h, now)),
      offers: p.offers.map((o) => ({
        requestId: o.requestId,
        pool: o.pool,
        agent: agentName(o),
        agentId: o.agentId,
        reason: o.reason,
        weight: o.weight,
        claimInMs: (o.offerExpiresAt ?? 0) - now,
        expiresAt: o.offerExpiresAt ?? 0,
      })),
      queue: p.queue.map((q, i) => ({
        requestId: q.requestId,
        pool: q.pool,
        agent: agentName(q),
        agentId: q.agentId,
        reason: q.reason,
        weight: q.weight,
        position: q.position ?? i + 1,
        waitMs: now - q.since,
      })),
      paused: p.paused.map((q) => ({
        requestId: q.requestId,
        pool: q.pool,
        agent: agentName(q),
        agentId: q.agentId,
        reason: q.reason,
        weight: q.weight,
        pausedMs: now - q.since,
      })),
    });
  }

  const d = inps.status?.daemon;
  const machine: MachineView | null = inps.inspect
    ? {
        cpuModel: inps.inspect.cpu.model,
        logicalCores: inps.inspect.cpu.logicalCores,
        effectiveCores: inps.inspect.cpu.effectiveCores,
        cgroupVersion: inps.inspect.cpu.cgroupVersion,
        cgroupCpuQuota: inps.inspect.cpu.cgroupCpuQuota,
        loadavg: inps.inspect.cpu.loadavg,
        loadPerEffectiveCore: inps.inspect.cpu.loadPerEffectiveCore,
        memTotalBytes: inps.inspect.memory.totalBytes,
        memAvailableBytes: inps.inspect.memory.availableBytes,
        memEffectiveLimitBytes: inps.inspect.memory.effectiveLimitBytes,
        loadPressure: inps.inspect.pressure.loadPressure,
        memPressure: inps.inspect.pressure.memPressure,
        note: inps.inspect.pressure.note,
        suggestion: inps.inspect.loadLock.suggestion,
      }
    : null;

  // Newest first; keep the tail (feed already bounds history length).
  const evs = [...inps.events].reverse();

  return {
    now,
    state: inps.state,
    daemonRestartNote: inps.daemonRestartNote,
    daemon: d
      ? {
          pid: d.pid,
          startedAt: d.startedAt,
          uptimeMs: now - d.startedAt,
          protocolVersion: d.protocolVersion,
          configVersion: inps.status?.config.version ?? 0,
        }
      : null,
    pools,
    events: evs.map((e) => ({
      id: e.id,
      ts: e.ts,
      agoMs: now - e.ts,
      type: e.type,
      pool: e.pool,
      text: eventText(e),
    })),
    latestEventId: inps.latestEventId,
    machine,
    lastSyncAt: inps.lastSyncAt,
  };
}
