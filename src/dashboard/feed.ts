/**
 * DashboardFeed: live, reconnecting state feed for dashboard surfaces.
 *
 * - Subscribes `watch("*")` on the daemon and keeps a rolling window of
 *   recent events (deduplicated by durable event id).
 * - On daemon loss/restart: reconnects with backoff, resubscribes, and
 *   resumes from the durable event cursor (`events since`). A daemon
 *   restart resets event ids; that is detected (`latestEventId` going
 *   backwards), the cursor is reset, history is re-pulled, and the view
 *   gains a "daemon restarted" note.
 * - Pulls `status` after each event burst (debounced) and a slow periodic
 *   refresh keeps heartbeat-driven fields (untracked lease deadlines)
 *   honest. No polling storm: event-driven by design.
 *
 * Read-only: it never acquires a permit; dashboards are light work.
 */
import type * as P from "../shared/protocol.js";
import { buildDashboardView, type DashboardView, type FeedState } from "./view.js";
import { detectInstallDrift, type InstallDrift } from "../shared/installs.js";

/** Structural subset of LLClient the feed needs (LLClient satisfies it). */
export interface FeedClient {
  connect(): Promise<void>;
  request<T = any>(method: string, params?: Record<string, unknown>): Promise<T>;
  watch(agentId: string, onEvent: (ev: Record<string, unknown>) => void): Promise<void>;
  onDisconnect(cb: () => void): unknown;
  close(): void;
}

export interface FeedOptions {
  /** Rolling event history length (default 60). */
  eventHistory?: number;
  /** Slow safety refresh while live (default 15_000 ms; 0 disables). */
  slowRefreshMs?: number;
  /** Debounce window for post-event status pulls (default 40 ms). */
  refreshDebounceMs?: number;
  /** Inspect refresh cadence (default 60_000 ms). */
  inspectEveryMs?: number;
  /** Reconnect backoff base (default 250 ms). */
  reconnectBaseMs?: number;
  /**
   * How often to re-check install drift between this running copy and the
   * PATH-resolved `load-lock` CLI (default 15_000 ms; 0 disables). A harness
   * that loads plugin code once at startup keeps running the OLD copy after
   * an update — this makes that visible on the dashboard (issue #39).
   */
  driftCheckMs?: number;
  /**
   * Wording of the drift hint: "opencode" says "restart opencode to pick up
   * vX" (the plugin cannot hot-reload), "cli" (default) says the running
   * copy is stale relative to the PATH CLI.
   */
  driftSurface?: "cli" | "opencode";
}

const DEFAULTS = {
  eventHistory: 60,
  slowRefreshMs: 15_000,
  refreshDebounceMs: 40,
  inspectEveryMs: 60_000,
  reconnectBaseMs: 250,
  driftCheckMs: 15_000,
  driftSurface: "cli" as const,
};

export class DashboardFeed {
  private client: FeedClient;
  private opts: Required<FeedOptions>;
  private events: P.MachineEvent[] = [];
  private latestEventId = 0;
  private status: P.StatusResult | null = null;
  private inspect: P.InspectResult | null = null;
  private inspectAt = 0;
  private lastSyncAt = 0;
  private state: FeedState = "connecting";
  private restartNote: string | undefined;
  private daemonStartedAt = 0;
  private refreshTimer: NodeJS.Timeout | null = null;
  private slowTimer: NodeJS.Timeout | null = null;
  private driftTimer: NodeJS.Timeout | null = null;
  private drift: InstallDrift | null = null;
  private stopped = false;
  private unsub: (() => void) | null = null;
  private connecting: Promise<void> | null = null;
  private viewSeq = 0;
  /** daemonVersion seen at the previous resync — powers the "restarted onto" note. */
  private lastDaemonVersion: string | undefined;

  /** Fired whenever the rendered view might have changed (state or data). */
  onChange?: () => void;
  /** Fired on connection-state transitions. */
  onState?: (s: FeedState) => void;

  constructor(client: FeedClient, opts: FeedOptions = {}) {
    this.client = client;
    this.opts = { ...DEFAULTS, ...opts };
  }

  currentState(): FeedState {
    return this.state;
  }

  private setState(s: FeedState): void {
    if (this.state === s) return;
    this.state = s;
    try {
      this.onState?.(s);
    } catch {
      /* consumer error */
    }
    this.emitChange();
  }

  private emitChange(): void {
    this.viewSeq++;
    try {
      this.onChange?.();
    } catch {
      /* consumer error */
    }
  }

  /** Connect, subscribe, and pull an initial full snapshot. */
  async start(): Promise<void> {
    this.stopped = false;
    this.unsub =
      typeof this.client.onDisconnect === "function"
        ? ((this.client.onDisconnect(() => void this.handleDisconnect()) as any) ?? undefined)
        : null;
    // Timers are installed BEFORE the first connect: a failed initial
    // connect must not leave the feed without its slow-refresh/drift
    // timers once the reconnect loop eventually recovers (issue #39 H3).
    this.slowTimer =
      this.opts.slowRefreshMs > 0
        ? setInterval(() => {
            if (this.state === "live") void this.refresh().catch(() => {});
          }, this.opts.slowRefreshMs)
        : null;
    this.slowTimer?.unref?.();
    this.driftTimer =
      this.opts.driftCheckMs > 0
        ? setInterval(() => {
            void this.refreshDrift();
          }, this.opts.driftCheckMs)
        : null;
    this.driftTimer?.unref?.();
    void this.refreshDrift();
    try {
      await this.connectAndSync();
    } catch (e) {
      // Issue #39 (hypothesis 3): previously a failed initial connect
      // rejected start() with no socket ever attached, so no close event
      // could ever fire handleDisconnect and the feed wedged in
      // "connecting" forever. Enter the standard reconnect loop instead —
      // the loop owns recovery, and start() still reports the failure.
      this.setState("reconnecting");
      void this.reconnectLoop();
      throw e;
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    if (this.slowTimer) clearInterval(this.slowTimer);
    if (this.driftTimer) clearInterval(this.driftTimer);
    this.refreshTimer = null;
    this.slowTimer = null;
    this.driftTimer = null;
    this.unsub?.();
    this.unsub = null;
    this.client.close();
  }

  private async connectAndSync(): Promise<void> {
    this.setState("connecting");
    await this.client.connect();
    await this.client.watch("*", (ev) => this.handleEvent(ev));
    await this.resync();
    this.setState("live");
  }

  /**
   * Full snapshot: status + events since cursor (+ inspect if stale).
   * Detects daemon restarts two ways — event ids going backwards, or the
   * daemon's own startedAt changing — then resets the cursor and re-pulls
   * history (ids are durable per daemon lifetime, not across restarts).
   */
  async resync(): Promise<void> {
    if (this.stopped) return;
    const [status, evRes] = await Promise.all([
      this.client.request<P.StatusResult>("status", {}),
      this.client.request<P.EventsResult>("events", { sinceEventId: this.latestEventId }),
    ]);
    const daemonStartChanged =
      status.daemon != null && this.daemonStartedAt !== 0 && status.daemon.startedAt !== this.daemonStartedAt;
    this.status = status;
    this.daemonStartedAt = status.daemon?.startedAt ?? 0;
    this.mergeEvents(evRes.events, evRes.latestEventId);
    let restartNote: string | undefined;
    if (daemonStartChanged || evRes.latestEventId < this.latestEventId) {
      // Daemon restarted: ids restarted from scratch. Reset and re-pull.
      const pid = status.daemon?.pid ?? "?";
      const newVersion = status.daemon?.daemonVersion;
      // Issue #39 (deliverable d): when the v1.3.0 handshake reports a
      // DIFFERENT version than the daemon we were talking to, say which
      // version the daemon restarted onto (e.g. after an update).
      if (this.lastDaemonVersion && newVersion && newVersion !== this.lastDaemonVersion) {
        restartNote = `daemon restarted onto v${newVersion} (was v${this.lastDaemonVersion}; pid ${pid}); event history re-synced`;
      } else {
        restartNote = `daemon restarted (pid ${pid}); event history re-synced`;
      }
      this.events = [];
      this.latestEventId = 0;
      const fresh = await this.client.request<P.EventsResult>("events", { sinceEventId: 0 });
      this.mergeEvents(fresh.events, fresh.latestEventId);
    }
    this.lastDaemonVersion = status.daemon?.daemonVersion;
    this.restartNote = restartNote;
    if (this.inspectAt === 0 || Date.now() - this.inspectAt > this.opts.inspectEveryMs) {
      await this.refreshInspect();
    }
    this.lastSyncAt = Date.now();
    this.emitChange();
  }

  /** Status-only pull (used after event bursts; keeps inspect cached). */
  async refresh(): Promise<void> {
    if (this.stopped) return;
    try {
      this.status = await this.client.request<P.StatusResult>("status", {});
    } catch (e) {
      if ((e as P.ProtocolError)?.code === "unavailable") {
        void this.handleDisconnect();
        return;
      }
      throw e;
    }
    if (Date.now() - this.inspectAt > this.opts.inspectEveryMs) await this.refreshInspect();
    this.lastSyncAt = Date.now();
    this.emitChange();
  }

  private async refreshInspect(): Promise<void> {
    try {
      this.inspect = await this.client.request<P.InspectResult>("inspect", {});
      this.inspectAt = Date.now();
    } catch {
      /* inspect is best-effort; status carries the essential state */
    }
  }

  private handleEvent(raw: Record<string, unknown>): void {
    // The daemon confirms a watch subscription with a `watch_started` push
    // (not a MachineEvent): {event:true, type, latestEventId}.
    if (raw.type === "watch_started") {
      // Confirmation push carrying the daemon's current event-id upper
      // bound. Deliberately NOT adopted as our cursor: the cursor only
      // advances when events are actually observed (pushed or pulled),
      // so the initial `events since 0` fetches full history and a
      // reconnect pulls the whole gap since the last seen id. Adopting
      // the bound here would skip everything between cursor and now.
      // Daemon restarts (bound going backwards) are caught in resync()
      // by comparing the pulled latestEventId against our cursor.
      return;
    }
    const ev = raw as unknown as P.MachineEvent;
    if (typeof ev.id === "number" && ev.id > this.latestEventId) {
      this.latestEventId = ev.id;
      this.events.push(ev);
      if (this.events.length > this.opts.eventHistory) {
        this.events.splice(0, this.events.length - this.opts.eventHistory);
      }
    }
    // Coalesce bursts: one status pull per debounce window.
    if (!this.refreshTimer) {
      this.refreshTimer = setTimeout(() => {
        this.refreshTimer = null;
        void this.refresh().catch(() => {
          /* reconnect loop owns recovery */
        });
      }, this.opts.refreshDebounceMs);
      this.refreshTimer.unref?.();
    }
    this.emitChange();
  }

  private mergeEvents(evs: P.MachineEvent[], latestEventId: number): void {
    const seen = new Set(this.events.map((e) => e.id));
    for (const e of evs) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      this.events.push(e);
    }
    this.events.sort((a, b) => a.id - b.id);
    if (this.events.length > this.opts.eventHistory) {
      this.events.splice(0, this.events.length - this.opts.eventHistory);
    }
    if (latestEventId > this.latestEventId) this.latestEventId = latestEventId;
  }

  private handleDisconnect(): void {
    if (this.stopped || this.state === "reconnecting") return;
    this.setState("reconnecting");
    void this.reconnectLoop();
  }

  private async reconnectLoop(): Promise<void> {
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      let attempt = 0;
      while (!this.stopped) {
        const wait = Math.min(this.opts.reconnectBaseMs * 2 ** Math.min(attempt, 5), 8_000);
        if (attempt > 0) await new Promise((r) => setTimeout(r, wait));
        attempt++;
        try {
          await this.connectAndSync();
          this.connecting = null;
          return;
        } catch {
          this.setState("reconnecting");
        }
      }
      this.connecting = null;
    })();
    return this.connecting;
  }

  /**
   * Admin force-release. Callers MUST gate this behind their own explicit
   * confirm step — the feed itself never initiates destructive actions.
   * Returns the reclaimed request's one-line description for toasts.
   */
  async forceRelease(requestId: string): Promise<void> {
    await this.client.request<{ ok: boolean }>("admin_release", { requestId });
    await this.refresh().catch(() => {});
  }

  /**
   * Re-probe install drift (running copy vs PATH-resolved CLI) and surface
   * it on the next view. Public so surfaces can trigger it on demand
   * (e.g. right after a plugin's panel regains focus).
   */
  refreshDrift(): void {
    if (this.stopped || this.opts.driftCheckMs === 0) return;
    try {
      this.drift = detectInstallDrift();
    } catch {
      this.drift = null;
    }
    this.emitChange();
  }

  /** Render-ready snapshot; countdowns are computed at `now`. */
  view(now = Date.now()): DashboardView {
    return buildDashboardView({
      status: this.status,
      inspect: this.inspect,
      events: this.events,
      latestEventId: this.latestEventId,
      state: this.state,
      lastSyncAt: this.lastSyncAt,
      daemonRestartNote: this.restartNote,
      installDrift: this.drift,
      driftSurface: this.opts.driftSurface,
      now,
    });
  }
}
