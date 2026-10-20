/**
 * TUI plugin tests (issue #24): the at-a-glance summary behind the
 * home.footer.status indicator and the new clickable sidebar.footer widget.
 *
 * What is testable here without a TUI host:
 *  - the compiled plugin module loads headless (its runtime imports are
 *    only @opencode/plugin/tui, solid-js, and the shared client/feed —
 *    @opentui/* are type-only) and self-describes as "load-lock.tui"
 *  - the dashboard opens via the in-window PanelPresentation ("panel",
 *    never fullscreen), pinned by the exported PANEL_PRESENTATION constant
 *  - poolGlance(): the pure per-pool summary (bits + health) both
 *    indicator surfaces share
 *
 * What is NOT testable here: actual slot rendering, mouse delivery in a
 * live terminal, and panel.open behavior — those are live-verified in a
 * real OpenCode session and documented in the PR (see docs/ updates).
 * plugin.setup() is deliberately NOT invoked: it starts a DashboardFeed
 * against a real daemon and would spawn/connect outside test isolation.
 */
import test from "node:test";
import assert from "node:assert/strict";
import tui, { PANEL_PRESENTATION, poolGlance } from "../adapters/opencode/tui.js";
import type { DashboardView, FeedState, PoolView } from "../dashboard/view.js";

// ------------------------------------------------------------- fixtures

function poolView(over: Partial<PoolView> = {}): PoolView {
  return {
    pool: "heavy",
    capacity: 3,
    used: 1,
    heldWeight: 1,
    offeredWeight: 0,
    free: 2,
    utilization: 1 / 3,
    holders: [],
    offers: [],
    queue: [],
    paused: [],
    ...over,
  };
}

function view(pools: PoolView[], state: FeedState = "live"): DashboardView {
  return {
    now: 1_760_000_000_000,
    state,
    daemon: null,
    pools,
    events: [],
    latestEventId: 0,
    machine: null,
    lastSyncAt: 1_760_000_000_000,
  };
}

// ------------------------------------------------------ module contract

test("tui plugin module loads headless and self-describes", () => {
  assert.ok(tui, "default export exists");
  // @opencode/plugin's define() is a passthrough, so the raw shape is
  // visible without a TUI host.
  const anyTui = tui as unknown as { id?: string };
  assert.equal(anyTui.id, "load-lock.tui");
});

test("dashboard opens in-window: PANEL_PRESENTATION is \"panel\"", () => {
  // PanelPresentation is exactly "panel" | "fullscreen"; "panel" is the
  // in-window presentation (issue #24 requirement 1).
  assert.equal(PANEL_PRESENTATION, "panel");
});

// ------------------------------------------------------------ poolGlance

test("poolGlance reports bits and health per pool state", () => {
  const healthy = poolGlance(view([poolView({ used: 1, capacity: 3 })]));
  assert.deepEqual(healthy, { bits: ["1/3"], health: "good" });

  const full = poolGlance(view([poolView({ used: 3, capacity: 3, free: 0, utilization: 1 })]));
  assert.deepEqual(full, { bits: ["3/3"], health: "warn" });

  const queued = poolGlance(
    view([poolView({ used: 1, capacity: 3, queue: [{} as never, {} as never] })]),
  );
  assert.deepEqual(queued, { bits: ["1/3", "Q2"], health: "warn" });

  const paused = poolGlance(
    view([poolView({ used: 1, capacity: 3, paused: [{} as never] })]),
  );
  // paused shows in bits but does not degrade health on its own
  assert.deepEqual(paused, { bits: ["1/3", "P1"], health: "good" });

  const down = poolGlance(view([poolView({ used: 1, capacity: 3 })], "reconnecting"));
  assert.deepEqual(down, { bits: ["1/3"], health: "down" });
});

test("poolGlance prefers the heavy pool and tolerates missing pools", () => {
  const heavy = poolGlance(
    view([
      poolView({ pool: "gpu-heavy", used: 1, capacity: 1 }),
      poolView({ pool: "heavy", used: 0, capacity: 3, free: 3, utilization: 0 }),
    ]),
  );
  assert.deepEqual(heavy, { bits: ["0/3"], health: "good" });

  // custom configs: falls back to the first pool when no "heavy" exists
  const fallback = poolGlance(view([poolView({ pool: "build", used: 2, capacity: 2, free: 0, utilization: 1 })]));
  assert.deepEqual(fallback, { bits: ["2/2"], health: "warn" });

  assert.equal(poolGlance(view([])), null);
});
