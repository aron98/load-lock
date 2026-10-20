/**
 * load-lock TUI plugin for OpenCode V2 — live lock-status dashboard (issue #10).
 *
 * Companion to the main SDK plugin (src/adapters/opencode/plugin.ts, which
 * owns tools/policy/wakeups and stays unchanged). Exposed through the
 * package's "./tui" export; the OpenCode TUI loads it automatically beside
 * the main plugin (see the plugin guide's "Publish and load" section).
 *
 * Surfaces:
 *  - "load-lock.dashboard" session panel: pools with capacity vs in-use,
 *    holder cards (label, reason, phase, pid/pgid, age, lease deadline),
 *    offer cards with claim-window countdown, FIFO queue positions,
 *    paused requests, the recent event feed, and the inspect_machine panel
 *  - a home.footer.status indicator summarizing the heavy pool (home screen)
 *  - a clickable sidebar.footer widget with the same summary (session
 *    screens) — onMouseDown opens the dashboard; the two slots render on
 *    disjoint surfaces, so this is not a double-render
 *  - /load-lock (palette + slash command) opens the panel IN-WINDOW via
 *    presentation: "panel" instead of fullscreen (deliberately NOT bound to
 *    any key — see the "no global key binding" comment in the keymap layer)
 *  - 'r' resync, 'x' force-release, and 'Esc' close while the panel is open;
 *    force-release is an admin action gated behind an explicit select +
 *    confirm dialog
 *
 * The viewer is read-only and light: it only ever READS daemon state
 * (status / events / inspect / watch) and never acquires a permit itself.
 *
 * Reactivity note: this file is compiled by plain tsc (no Solid babel
 * preset), so JSX expressions evaluate eagerly instead of becoming reactive
 * getters. All liveness therefore flows through ONE keyed <Show> boundary
 * (created with explicit property getters) that is recreated whenever the
 * feed emits a new view snapshot or the 1s countdown tick fires; below
 * that boundary, eager evaluation is exactly the semantics we want.
 */
import { Plugin } from "@opencode/plugin/tui";
import type { Context, PanelInput, PanelPresentation } from "@opencode/plugin/tui/context";
import { createComponent, createSignal, Show } from "solid-js";
import type { MouseEvent, RGBA } from "@opentui/core";
import type { JSX } from "@opentui/solid";
import { LLClient } from "../../shared/client.js";
import { DashboardFeed } from "../../dashboard/feed.js";
import {
  fmtBytes,
  fmtClock,
  fmtDuration,
  type DashboardView,
  type FeedState,
  type HolderCard,
} from "../../dashboard/view.js";

const PANEL_NAME = "load-lock.dashboard";

/**
 * The dashboard opens as an in-window panel ("panel" is the SDK's in-window
 * PanelPresentation; "fullscreen" takes over the whole TUI). Exported so
 * tests can pin the choice (issue #24).
 */
export const PANEL_PRESENTATION: PanelPresentation = "panel";

// ---------------------------------------------------------------- theme

/**
 * Semantic colors from the resolved TUI theme (RGBA tokens; @opentui
 * renderables accept both RGBA and CSS color strings).
 */
interface ThemeFg {
  base: RGBA;
  dim: RGBA;
  accent: RGBA;
  good: RGBA;
  warn: RGBA;
  bad: RGBA;
}

function themeFg(t: Context["theme"]): ThemeFg {
  return {
    base: t.text.base,
    dim: t.text.muted,
    accent: t.text.feedback.info.base,
    good: t.text.feedback.success.base,
    warn: t.text.feedback.warning.base,
    bad: t.text.feedback.error.base,
  };
}

function stateColor(s: FeedState, f: ThemeFg): RGBA {
  if (s === "live") return f.good;
  if (s === "connecting") return f.dim;
  return f.bad;
}

// ---------------------------------------------------------------- body

interface StyledLine {
  text: string;
  fg?: RGBA;
}

const STATE_LABEL: Record<string, string> = {
  live: "LIVE",
  connecting: "CONNECTING",
  reconnecting: "RECONNECTING",
  down: "DAEMON DOWN",
};

function holderLines(h: HolderCard, out: StyledLine[], fg: ThemeFg): void {
  const id = h.requestId.slice(0, 14);
  let meta = h.phaseLabel;
  if (h.phase === "claimed" && h.startDeadlineInMs !== undefined)
    meta += ` · must start in ${fmtDuration(h.startDeadlineInMs)}`;
  if (h.phase === "running_tracked" && h.pid !== undefined)
    meta += ` · pid ${h.pid}` + (h.pgid !== undefined && h.pgid !== h.pid ? ` · pgid ${h.pgid}` : "");
  if (h.phase === "running_untracked" && h.leaseDeadlineInMs !== undefined)
    meta += ` · lease ends in ${fmtDuration(h.leaseDeadlineInMs)}`;
  out.push({ text: `  HELD   ${h.agent} (${id}) · ${meta} · age ${fmtDuration(h.heldMs)}`, fg: fg.good });
  out.push({ text: `         reason: ${h.reason}`, fg: fg.dim });
}

function dashboardLines(v: DashboardView, width: number, f: ThemeFg): StyledLine[] {
  const W = Math.max(40, width - 2);
  const out: StyledLine[] = [];
  const push = (text: string, fg?: RGBA) => {
    out.push({ text: text.length > W ? text.slice(0, W - 1) + "…" : text, fg });
  };

  const syncAge = v.lastSyncAt ? fmtDuration(Math.max(0, v.now - v.lastSyncAt)) : "never";
  push(
    `load-lock dashboard   ${STATE_LABEL[v.state] ?? v.state}   synced ${syncAge} ago`,
    stateColor(v.state, f),
  );

  if (v.daemon) {
    push(
      `daemon pid ${v.daemon.pid} · uptime ${fmtDuration(v.daemon.uptimeMs)} · config v${v.daemon.configVersion} · protocol v${v.daemon.protocolVersion}` +
        (v.daemon.daemonVersion ? ` · daemon v${v.daemon.daemonVersion}` : "") +
        ` · events through #${v.latestEventId}`,
      f.dim,
    );
  } else {
    push(`daemon unreachable — it auto-spawns on the next load-lock command`, f.dim);
  }
  if (v.daemonRestartNote) push(`note: ${v.daemonRestartNote}`, f.warn);
  if (v.versionSkewNote) push(`note: ${v.versionSkewNote}`, f.warn);
  if (v.installDriftNote) push(`note: ${v.installDriftNote}`, f.warn);

  if (v.machine) {
    const m = v.machine;
    const cg = m.cgroupCpuQuota != null ? ` · cgroup quota ${m.cgroupCpuQuota / 100} CPU` : "";
    push(
      `MACHINE  ${m.logicalCores} cores (effective ${m.effectiveCores}${cg}) · load ${m.loadavg.map((n) => n.toFixed(2)).join(" ")} = ${m.loadPerEffectiveCore.toFixed(2)}/core · mem ${fmtBytes(m.memTotalBytes)} total, ${fmtBytes(m.memAvailableBytes)} avail (limit ${fmtBytes(m.memEffectiveLimitBytes)})`,
      f.accent,
    );
    push(`         pressure: cpu ${m.loadPressure}, mem ${m.memPressure} — ${m.note}`, f.dim);
    if (m.suggestion) push(`         suggestion: ${m.suggestion}`, f.dim);
  }

  push("");
  if (!v.pools.length) push(`no pools configured`, f.dim);
  for (const p of v.pools) {
    const full = p.capacity > 0 && p.used >= p.capacity;
    push(
      `POOL ${p.pool}  ${p.used}/${p.capacity} used (held ${p.heldWeight}, offered ${p.offeredWeight}, free ${p.free}) · queue ${p.queue.length} · paused ${p.paused.length}`,
      full ? f.warn : f.accent,
    );
    for (const h of p.holders) holderLines(h, out, f);
    for (const o of p.offers) {
      const id = o.requestId.slice(0, 14);
      const window = o.claimInMs >= 0 ? `claim within ${fmtDuration(o.claimInMs)}` : "claim window elapsed";
      out.push({ text: `  OFFER  ${o.agent} (${id}) · ${window} · expires ${fmtClock(o.expiresAt)}`, fg: f.warn });
      out.push({ text: `         reason: ${o.reason}`, fg: f.dim });
    }
    for (const q of p.queue) {
      push(`  QUEUE  #${q.position}  ${q.agent} — ${q.reason} (waiting ${fmtDuration(q.waitMs)})`, f.base);
    }
    for (const q of p.paused) {
      push(`  PAUSED ${q.agent} — ${q.reason} (paused ${fmtDuration(q.pausedMs)} · rejoin required)`, f.bad);
    }
  }

  push("");
  push(`EVENTS (newest first)`, f.accent);
  if (!v.events.length) push(`  (no events yet)`, f.dim);
  for (const e of v.events.slice(0, 12)) {
    push(`  #${e.id} ${fmtClock(e.ts)}  ${e.text}`);
  }

  push("");
  push(`r resync · x force-release (admin, confirm required) · Esc closes · read-only viewer — never acquires a permit`, f.dim);
  return out;
}

function PanelBody(v: DashboardView, panel: PanelInput, ctx: Context): JSX.Element {
  const f = themeFg(ctx.theme);
  const lines = dashboardLines(v, panel.width || 100, f);
  return (
    <box>
      <>
        {lines.map((l) => (
          <text fg={l.fg}>{l.text}</text>
        ))}
      </>
    </box>
  );
}

// ---------------------------------------------------------------- glance

/**
 * Health of the at-a-glance summary. "down" means the daemon feed is not
 * live (daemon down / connecting); the others describe the pool itself.
 */
export type GlanceHealth = "good" | "warn" | "bad" | "down";

/** Render-ready at-a-glance summary of one pool (pure; unit-tested). */
export interface PoolGlance {
  /** e.g. ["2/3", "Q1", "P2"] — used/capacity, then queue/paused counts. */
  bits: string[];
  health: GlanceHealth;
}

/**
 * One-line heavy-pool summary shared by the home footer indicator and the
 * sidebar widget, so both surfaces always agree. Prefers the "heavy" pool
 * and falls back to the first pool for custom configurations.
 */
export function poolGlance(v: DashboardView): PoolGlance | null {
  const pool = v.pools.find((p) => p.pool === "heavy") ?? v.pools[0];
  if (!pool) return null;
  const bits = [`${pool.used}/${pool.capacity}`];
  if (pool.queue.length) bits.push(`Q${pool.queue.length}`);
  if (pool.paused.length) bits.push(`P${pool.paused.length}`);
  let health: GlanceHealth;
  if (v.state !== "live") health = "down";
  else if ((pool.capacity > 0 && pool.used >= pool.capacity) || pool.queue.length > 0) health = "warn";
  else health = "good";
  return { bits, health };
}

function healthColor(h: GlanceHealth, f: ThemeFg): RGBA {
  if (h === "good") return f.good;
  if (h === "warn") return f.warn;
  return f.bad; // "bad" and "down" both read as the error color
}

function MiniIndicator(v: DashboardView, ctx: Context): JSX.Element {
  const f = themeFg(ctx.theme);
  const g = poolGlance(v);
  if (!g) return <text fg={f.dim}>lock: no pools</text>;
  return <text fg={healthColor(g.health, f)}>{`lock ${g.bits.join("·")}`}</text>;
}

/**
 * Right-sidebar widget: the same glance summary plus a "click to open"
 * affordance. Click support is contract-level (opentui enables mouse and
 * bubbles mouse-down events to slot renderables); terminals that don't
 * deliver mouse events can still open the dashboard via the /load-lock
 * slash command (or the command palette) named on the hint line.
 */
function SidebarWidget(v: DashboardView, ctx: Context): JSX.Element {
  const f = themeFg(ctx.theme);
  const openDashboard = (e: MouseEvent) => {
    if (e.button !== 0) return; // 0 = MouseButton.LEFT; ignore other buttons
    ctx.ui.panel.open(PANEL_NAME, { presentation: PANEL_PRESENTATION });
  };
  const g = poolGlance(v);
  if (!g) {
    return (
      <box onMouseDown={openDashboard}>
        <text fg={f.dim}>load-lock: no pools configured</text>
      </box>
    );
  }
  const shortcut = ctx.keymap.shortcuts("load-lock.dashboard.open")[0];
  const hint = shortcut ? `${shortcut} / click opens dashboard` : "/load-lock or click opens dashboard";
  return (
    <box onMouseDown={openDashboard}>
      <text fg={healthColor(g.health, f)}>{`load-lock ${g.bits.join("·")}`}</text>
      <text fg={f.dim}>{hint}</text>
    </box>
  );
}

// ---------------------------------------------------------------- plugin

export default Plugin.define({
  id: "load-lock.tui",
  setup(ctx: Context) {
    const [view, setView] = createSignal<DashboardView | null>(null);
    // driftSurface "opencode": when this session's copy is older than the
    // PATH CLI, the hint says to restart opencode (plugins never hot-reload).
    const feed = new DashboardFeed(new LLClient(), { driftSurface: "opencode" });
    feed.onChange = () => setView(feed.view());
    feed.onState = () => setView(feed.view());
    void feed.start().catch(() => {
      /* daemon down or spawning; the reconnect loop keeps retrying and
         will go live — start() only reports the FIRST connect failure */
    });

    // Local countdown tick: produces a fresh snapshot once per second so
    // ages/deadlines advance even between daemon events.
    const tick = setInterval(() => setView(feed.view()), 1000);
    tick.unref?.();

    const panelOpen = () => ctx.ui.panel.current()?.name === PANEL_NAME;

    // Esc-close gate: only when OUR panel is the current one and no dialog is
    // on top. Dialogs (select/confirm/command palette) push the host's "modal"
    // keymap mode; in any mode other than the documented default "base"
    // (KeymapLayer.mode), this command stays unreachable so Esc keeps its
    // native meaning there — cancelling the dialog — instead of closing the
    // panel underneath it. With the dashboard open and no dialog, the mode is
    // exactly "base": the panel opens fullscreen, which the host treats as
    // non-interactive for the session pane, so session-scoped modes (composer,
    // autocomplete, menu) are all suspended. ctx.ui.panel.close() closes only
    // this plugin's panel.
    const escClosesPanel = () => panelOpen() && ctx.keymap.mode.current() === "base";

    // ------------------------------------------------------ force-release
    async function forceReleaseFlow(): Promise<void> {
      const holders = (feed.view().pools ?? []).flatMap((p) => p.holders);
      if (!holders.length) {
        ctx.ui.toast.show({ message: "load-lock: no held permits to release", variant: "info" });
        return;
      }
      const pick = await ctx.ui.dialog.select({
        title: "Force-release a permit (admin)",
        placeholder: "Select holder",
        options: holders.map((h) => ({
          title: `${h.agent} (${h.requestId.slice(0, 14)})`,
          description: `${h.phaseLabel}${h.pid !== undefined ? ` · pid ${h.pid}` : ""} · held ${fmtDuration(h.heldMs)} · ${h.reason}`,
          value: h.requestId,
        })),
      });
      if (!pick) return;
      const confirmed = await ctx.ui.dialog.confirm({
        title: "Force-release permit",
        message: `Reclaim ${pick}? Its owner may still be mid-build; this is a last-resort recovery action.`,
        label: { confirm: "Force-release", cancel: "Cancel" },
      });
      if (confirmed !== true) return;
      try {
        await feed.forceRelease(pick);
        ctx.ui.toast.show({ message: `load-lock: force-released ${pick.slice(0, 14)}`, variant: "warning" });
      } catch (e) {
        ctx.ui.toast.show({ message: `load-lock: force-release failed: ${String(e)}`, variant: "error" });
      }
    }

    // ----------------------------------------------------------- keymap
    ctx.keymap.layer(() => ({
      mode: "global",
      priority: 5,
      commands: [
        {
          id: "load-lock.dashboard.open",
          title: "load-lock: open the lock-status dashboard",
          group: "load-lock",
          // NO global key binding, on purpose (issue #28):
          //
          // 1. Never bind unmodified single letters or letter sequences
          //    (the old "gl") at global scope: while the keymap engine waits
          //    for the next key of a sequence it swallows the prefix, so
          //    plain "g" never reached the composer. Modifier chords don't
          //    have this problem.
          // 2. The obvious chord, ctrl+g, is already the host's documented
          //    default binding for session.first ("Navigate to first
          //    message", bound to ctrl+g,home,alt+home in opencode >=
          //    2.0.32); our layer is mode "global" + priority 5 and would
          //    shadow it. Rather than shadow the host or pick another
          //    unmodified key, the command ships unbound: the sidebar
          //    widget (click), the command palette, and the /load-lock
          //    slash command remain as entry points.
          palette: true,
          slash: { name: "load-lock", aliases: ["lock", "ll"] },
          run: () => {
            ctx.ui.panel.open(PANEL_NAME, { presentation: PANEL_PRESENTATION });
          },
        },
        {
          id: "load-lock.dashboard.close",
          title: "load-lock: close the lock-status dashboard",
          group: "load-lock",
          bind: "escape",
          enabled: escClosesPanel,
          run: () => {
            ctx.ui.panel.close();
          },
        },
        {
          id: "load-lock.dashboard.resync",
          title: "load-lock: resync the dashboard",
          group: "load-lock",
          // Unmodified letters are fine here (unlike the global-scope rule
          // above): `enabled` gates these to moments when OUR panel is the
          // fullscreen current one and the composer is suspended, so there is
          // no typing to swallow.
          bind: "r",
          enabled: panelOpen,
          run: () => {
            void feed.resync().catch(() => {});
          },
        },
        {
          id: "load-lock.dashboard.force-release",
          title: "load-lock: force-release a permit (admin)",
          group: "load-lock",
          bind: "x",
          enabled: panelOpen,
          run: () => {
            void forceReleaseFlow();
          },
        },
      ],
    }));

    // ------------------------------------------------------------ slots
    // Session panel contribution: renders only when our name is selected.
    const offPanel = ctx.ui.slot({
      append: "session.panel",
      render: (panel: PanelInput) =>
        createComponent(Show, {
          get when() {
            return panel.name === PANEL_NAME ? (view() ?? false) : false;
          },
          keyed: true,
          children: (v: DashboardView) => PanelBody(v, panel, ctx),
        } as never) as unknown as JSX.Element,
    });

    // Home footer mini indicator (heavy pool summary).
    const offFooter = ctx.ui.slot({
      append: "home.footer.status",
      render: () =>
        createComponent(Show, {
          get when() {
            return view() ?? false;
          },
          keyed: true,
          children: (v: DashboardView) => MiniIndicator(v, ctx),
        } as never) as unknown as JSX.Element,
    });

    // Right-sidebar at-a-glance widget (session screens). The sidebar.footer
    // slot pins it at the bottom of the sidebar so it stays visible even
    // when the session list is long. Disjoint from the home footer above,
    // so the two indicators never render on the same screen.
    const offSidebar = ctx.ui.slot({
      append: "sidebar.footer",
      render: () =>
        createComponent(Show, {
          get when() {
            return view() ?? false;
          },
          keyed: true,
          children: (v: DashboardView) => SidebarWidget(v, ctx),
        } as never) as unknown as JSX.Element,
    });

    return () => {
      if (tick) clearInterval(tick);
      offPanel();
      offFooter();
      offSidebar();
      void feed.stop();
    };
  },
});
