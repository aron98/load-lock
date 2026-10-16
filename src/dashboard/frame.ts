/**
 * Plain-text frame renderer for `load-lock top` — and for any other
 * terminal surface that wants the same dashboard without a TUI toolkit.
 * Pure function: view-model in, string[] out (one line per row).
 *
 * Deliberately zero-dependency (ANSI handled by the caller): this keeps
 * the published package lightweight and makes the layout unit-testable.
 */
import {
  type DashboardView,
  type PoolView,
  fmtBytes,
  fmtClock,
  fmtDuration,
  trunc,
} from "./view.js";

const STATE_LABEL: Record<string, string> = {
  live: "LIVE",
  connecting: "CONNECTING",
  reconnecting: "RECONNECTING",
  down: "DAEMON DOWN",
};

export function utilizationBar(frac: number, width = 10): string {
  const w = Math.max(3, width);
  const filled = Math.round(Math.min(1, Math.max(0, frac)) * w);
  return `${"#".repeat(filled)}${"-".repeat(w - filled)}`;
}

function holderLines(pool: PoolView, out: (s: string) => void): void {
  for (const h of pool.holders) {
    const id = h.requestId.slice(0, 14);
    let meta = h.phaseLabel;
    if (h.phase === "claimed" && h.startDeadlineInMs !== undefined) meta += ` · must start in ${fmtDuration(h.startDeadlineInMs)}`;
    if (h.phase === "running_tracked" && h.pid !== undefined) meta += ` · pid ${h.pid}` + (h.pgid !== undefined && h.pgid !== h.pid ? ` · pgid ${h.pgid}` : "");
    if (h.phase === "running_untracked" && h.leaseDeadlineInMs !== undefined) meta += ` · lease ends in ${fmtDuration(h.leaseDeadlineInMs)}`;
    out(`  HELD   ${h.agent} (${id}) · ${meta} · age ${fmtDuration(h.heldMs)}`);
    out(`         reason: ${h.reason}`);
  }
  for (const o of pool.offers) {
    const id = o.requestId.slice(0, 14);
    const window = o.claimInMs >= 0 ? `claim within ${fmtDuration(o.claimInMs)}` : "claim window elapsed (pause pending)";
    out(`  OFFER  ${o.agent} (${id}) · ${window} · expires ${fmtClock(o.expiresAt)}`);
    out(`         reason: ${o.reason}`);
  }
  for (const q of pool.queue) {
    out(`  QUEUE  #${q.position}  ${q.agent} — ${q.reason} (waiting ${fmtDuration(q.waitMs)})`);
  }
  for (const p of pool.paused) {
    out(`  PAUSED ${p.agent} — ${p.reason} (paused ${fmtDuration(p.pausedMs)} · rejoin required)`);
  }
}

/** Render one full frame; `width`/`height` bound the output (rows last). */
export function renderFrame(view: DashboardView, width = 100, height = 40): string[] {
  const W = Math.max(48, Math.min(width, 240));
  const lines: string[] = [];
  const push = (s: string) => {
    if (s.length > W) lines.push(s.slice(0, W - 1) + "…");
    else lines.push(s);
  };

  const state = STATE_LABEL[view.state] ?? String(view.state);
  const syncAge = view.lastSyncAt ? fmtDuration(Math.max(0, view.now - view.lastSyncAt)) : "never";
  push(`load-lock top — machine-wide heavy-work budget   ${state}   synced ${syncAge} ago`);

  if (view.daemon) {
    push(
      `daemon pid ${view.daemon.pid} · uptime ${fmtDuration(view.daemon.uptimeMs)} · config v${view.daemon.configVersion} · protocol v${view.daemon.protocolVersion} · events through #${view.latestEventId}`,
    );
  } else {
    push(`daemon: unreachable — it auto-spawns on the next load-lock command`);
  }
  if (view.daemonRestartNote) push(`note: ${view.daemonRestartNote}`);

  if (view.machine) {
    const m = view.machine;
    const cg =
      m.cgroupCpuQuota != null ? ` · cgroup ${m.cgroupVersion ?? ""} quota ${m.cgroupCpuQuota / 100} CPU` : "";
    push(
      `MACHINE  ${m.logicalCores} cores (effective ${m.effectiveCores}${cg}) · load ${m.loadavg.map((n) => n.toFixed(2)).join(" ")} = ${m.loadPerEffectiveCore.toFixed(2)}/core · mem ${fmtBytes(m.memTotalBytes)} total, ${fmtBytes(m.memAvailableBytes)} avail (limit ${fmtBytes(m.memEffectiveLimitBytes)})`,
    );
    push(`         pressure: cpu ${m.loadPressure}, mem ${m.memPressure} — ${m.note}`);
  }

  push("");
  if (!view.pools.length) push(`no pools configured`);
  for (const p of view.pools) {
    push(
      `POOL ${p.pool}  [${utilizationBar(p.utilization)}]  ${p.used}/${p.capacity} used (held ${p.heldWeight}, offered ${p.offeredWeight}, free ${p.free}) · queue ${p.queue.length} · paused ${p.paused.length}`,
    );
    holderLines(p, push);
  }

  push("");
  push(`EVENTS (newest first)`);
  if (!view.events.length) push(`  (no events yet)`);
  for (const e of view.events.slice(0, 12)) {
    push(`  #${e.id} ${fmtClock(e.ts)}  ${e.text}`);
  }

  push("");
  push(`q quit · r resync · read-only viewer — light work, never acquires a permit`);
  push(`force-release is an admin action gated behind an explicit confirm (not available here; use the OpenCode panel or load-lock recover force-release)`);

  if (lines.length > Math.max(1, height)) return lines.slice(0, Math.max(1, height));
  return lines;
}
