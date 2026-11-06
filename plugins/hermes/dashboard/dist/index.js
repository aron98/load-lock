/*
 * load-lock — Hermes dashboard plugin frontend.
 *
 * Plain browser JavaScript: an IIFE registering one tab page, no build
 * step (same pattern as the bundled kanban plugin). React is provided by
 * the dashboard's plugin SDK; JSX is avoided on purpose — everything is
 * built with React.createElement.
 *
 * Data flow: polls this plugin's own backend routes
 *   GET /api/plugins/load-lock/snapshot   every 2s   (pool state)
 *   GET /api/plugins/load-lock/events     every 2s   (incremental, ?since=<id>)
 *   GET /api/plugins/load-lock/machine    every 15s  (cores / memory / pressure)
 * Polling pauses while the tab is hidden (document.hidden) and resumes on
 * visibility. 0.19.0 has no push channel for plugins, so polling is the
 * honest option — same cadence as `load-lock top`.
 */
(function () {
  "use strict";

  var SDK = window.__HERMES_PLUGIN_SDK__;
  var REG = window.__HERMES_PLUGINS__;
  if (!SDK || !REG || !SDK.React || !SDK.fetchJSON) return;

  var React = SDK.React;
  var h = React.createElement;
  var hooks = SDK.hooks || {};
  var useState = hooks.useState;
  var useEffect = hooks.useEffect;
  var useRef = hooks.useRef;
  var useCallback = hooks.useCallback;
  if (!useState || !useEffect || !useRef || !useCallback) return;

  var C = SDK.components || {};
  var Card = C.Card || "div";
  var CardHeader = C.CardHeader || "div";
  var CardTitle = C.CardTitle || "div";
  var CardContent = C.CardContent || "div";
  var useI18n = SDK.useI18n || function () { return { t: null, locale: "en" }; };

  var API = "/api/plugins/load-lock";
  var POLL_MS = 2000;
  var MACHINE_POLL_MS = 15000;
  var MAX_EVENTS = 60;

  /* ------------------------------------------------------------------ *
   * helpers                                                             *
   * ------------------------------------------------------------------ */

  function parseApiError(err) {
    var msg = err && err.message ? String(err.message) : String(err);
    // SDK fetchJSON throws Error("<status>: <raw body>") — pull FastAPI detail out
    var m = msg.match(/^\s*(\d+):\s*(\{[\s\S]*\})\s*$/);
    if (m) {
      try {
        var body = JSON.parse(m[2]);
        if (body && body.detail) return String(body.detail);
      } catch (e) { /* not JSON — fall through */ }
    }
    return msg;
  }

  function fmtAge(ms) {
    if (ms == null || ms < 0 || isNaN(ms)) return "—";
    var s = Math.floor(ms / 1000);
    if (s < 60) return s + "s";
    var m = Math.floor(s / 60); s %= 60;
    if (m < 60) return m + "m " + s + "s";
    var hr = Math.floor(m / 60); m %= 60;
    if (hr < 24) return hr + "h " + m + "m";
    var d = Math.floor(hr / 24); hr %= 24;
    return d + "d " + hr + "h";
  }

  function fmtBytes(bytes) {
    if (bytes == null || isNaN(bytes)) return "—";
    var units = ["B", "KB", "MB", "GB", "TB"];
    var v = bytes, i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return (i === 0 ? Math.round(v) : v.toFixed(1)) + " " + units[i];
  }

  function shortAgent(agentId) {
    if (!agentId) return "unknown";
    var s = String(agentId);
    var idx = s.indexOf(":");
    var origin = idx > 0 ? s.slice(0, idx) : "";
    var rest = idx > 0 ? s.slice(idx + 1) : s;
    if (rest.length > 12) rest = rest.slice(0, 12) + "…";
    return origin ? origin + ":" + rest : rest;
  }

  function shortPath(cwd) {
    if (!cwd) return "";
    var segs = String(cwd).replace(/\/+$/, "").split("/").filter(Boolean);
    if (segs.length <= 2) return "/" + segs.join("/");
    return "…/" + segs.slice(-2).join("/");
  }

  function mergeEvents(prev, incoming) {
    var byId = {};
    prev.forEach(function (e) { if (e && e.id != null) byId[e.id] = e; });
    incoming.forEach(function (e) { if (e && e.id != null) byId[e.id] = e; });
    var merged = Object.keys(byId).map(Number).sort(function (a, b) { return a - b; })
      .map(function (id) { return byId[id]; });
    return merged.slice(-MAX_EVENTS);
  }

  /* ------------------------------------------------------------------ *
   * event feed                                                          *
   * ------------------------------------------------------------------ */

  var EVENT_TONE = {
    granted: "ll-tone-good",
    claimed: "ll-tone-good",
    released: "ll-tone-muted",
    queued: "ll-tone-muted",
    offered: "ll-tone-info",
    paused: "ll-tone-warn",
    reclaimed: "ll-tone-warn",
    cancelled: "ll-tone-warn",
    expired: "ll-tone-warn",
    declined: "ll-tone-warn",
    daemon_started: "ll-tone-info",
    daemon_recovered: "ll-tone-info",
    configured: "ll-tone-info"
  };

  function eventText(ev) {
    if (ev.entry && ev.entry.reason) return ev.entry.reason;
    if (ev.detail) return ev.detail;
    return "";
  }

  function EventRow(props) {
    var ev = props.event;
    var now = props.now;
    var tone = EVENT_TONE[ev.type] || "ll-tone-muted";
    var text = eventText(ev);
    return h("div", { className: "ll-evt", key: ev.id },
      h("span", { className: "ll-evt-time" }, fmtAge(now - ev.ts) + " ago"),
      h("span", { className: "ll-badge " + tone }, String(ev.type || "?").replace(/_/g, " ")),
      h("span", { className: "ll-evt-agent", title: ev.targetAgent || "" }, shortAgent(ev.targetAgent)),
      text
        ? h("span", { className: "ll-evt-text", title: text }, text)
        : null
    );
  }

  /* ------------------------------------------------------------------ *
   * pool card                                                           *
   * ------------------------------------------------------------------ */

  function HolderRow(props) {
    var e = props.entry;
    var now = props.now;
    var running = e.phase === "running_tracked" || e.phase === "running";
    var title = [
      e.agentId || e.agentLabel || "",
      e.cwd || "",
      e.opKey ? "op: " + e.opKey : ""
    ].filter(Boolean).join("\n");
    return h("div", { className: "ll-row", title: title },
      h("span", { className: "ll-dot " + (running ? "ll-dot-run" : "ll-dot-hold") }),
      h("span", { className: "ll-agent" }, e.agentLabel || shortAgent(e.agentId)),
      h("span", { className: "ll-reason" }, e.reason || e.opKey || ""),
      running ? h("span", { className: "ll-badge ll-tone-good" }, "running") : null,
      h("span", { className: "ll-age" }, fmtAge(e.heldFor != null ? e.heldFor : now - (e.since || now)))
    );
  }

  function OfferRow(props) {
    var e = props.entry;
    var now = props.now;
    var expires = e.offerExpiresAt != null ? e.offerExpiresAt : e.startDeadline;
    return h("div", { className: "ll-row", title: e.agentId || "" },
      h("span", { className: "ll-dot ll-dot-info" }),
      h("span", { className: "ll-agent" }, e.agentLabel || shortAgent(e.agentId)),
      h("span", { className: "ll-reason" }, e.reason || "offered — claim it (offers expire)"),
      h("span", { className: "ll-badge ll-tone-info" },
        expires ? "expires in " + fmtAge(expires - now) : "offered")
    );
  }

  function QueueRow(props) {
    var e = props.entry;
    return h("div", { className: "ll-row", title: e.agentId || "" },
      h("span", { className: "ll-badge ll-tone-muted" }, "#" + (e.position != null ? e.position : "?")),
      h("span", { className: "ll-agent" }, e.agentLabel || shortAgent(e.agentId)),
      h("span", { className: "ll-reason" }, e.reason || ""),
      e.paused
        ? h("span", { className: "ll-badge ll-tone-warn" }, "paused")
        : null
    );
  }

  function SectionLabel(props) {
    return h("div", { className: "ll-section" }, props.children);
  }

  function PoolCard(props) {
    var pool = props.pool;
    var now = props.now;
    var used = pool.used || 0;
    var cap = pool.capacity || 0;
    var ratio = cap > 0 ? used / cap : 0;
    var fillClass = ratio >= 1 ? " is-full" : ratio >= 0.67 ? " is-mid" : "";
    var holders = pool.holders || [];
    var offers = pool.offers || [];
    var queue = pool.queue || [];
    var paused = pool.paused || [];
    var idle = !holders.length && !offers.length && !queue.length && !paused.length;

    return h(Card, { className: "ll-pool-card" },
      h(CardHeader, null,
        h(CardTitle, { className: "ll-card-title" },
          pool.pool,
          h("span", { className: "ll-badge " + (used >= cap ? "ll-tone-warn" : used > 0 ? "ll-tone-info" : "ll-tone-good") },
            used + " / " + cap + " in use")
        )
      ),
      h(CardContent, null,
        h("div", { className: "ll-bar", title: used + " of " + cap + " permits in use" },
          h("div", { className: "ll-bar-fill" + fillClass, style: { width: Math.min(100, ratio * 100) + "%" } })
        ),
        idle
          ? h("div", { className: "ll-empty" }, "idle — full capacity available for heavy work")
          : null,
        holders.length ? h(SectionLabel, null, "Holders") : null,
        holders.map(function (e) { return h(HolderRow, { entry: e, now: now, key: e.requestId }); }),
        offers.length ? h(SectionLabel, null, "Offers") : null,
        offers.map(function (e) { return h(OfferRow, { entry: e, now: now, key: e.requestId }); }),
        queue.length ? h(SectionLabel, null, "Queue") : null,
        queue.map(function (e) { return h(QueueRow, { entry: e, key: e.requestId }); }),
        paused.length ? h(SectionLabel, null, "Paused") : null,
        paused.map(function (e) { return h(QueueRow, { entry: e, key: e.requestId }); })
      )
    );
  }

  /* ------------------------------------------------------------------ *
   * page                                                                *
   * ------------------------------------------------------------------ */

  function LoadLockPage() {
    var snapState = useState(null);
    var snap = snapState[0], setSnap = snapState[1];
    var machineState = useState(null);
    var machine = machineState[0], setMachine = machineState[1];
    var eventsState = useState([]);
    var events = eventsState[0], setEvents = eventsState[1];
    var errorState = useState(null);
    var error = errorState[0], setError = errorState[1];
    var updatedState = useState(null);
    var updatedAt = updatedState[0], setUpdatedAt = updatedState[1];
    var autoState = useState(true);
    var auto = autoState[0], setAuto = autoState[1];
    var latestRef = useRef(0);
    var nowState = useState(Date.now());
    var now = nowState[0], setNow = nowState[1];
    useI18n(); // keep locale reactive for future copy

    var refresh = useCallback(function () {
      setNow(Date.now());
      SDK.fetchJSON(API + "/snapshot").then(function (s) {
        if (s && s.ok) {
          setSnap(s);
          setUpdatedAt(Date.now());
          setError(null);
        } else {
          setError((s && s.error) || "snapshot request failed");
        }
      }).catch(function (e) { setError(parseApiError(e)); });
      SDK.fetchJSON(API + "/events?since=" + latestRef.current + "&limit=" + MAX_EVENTS)
        .then(function (r) {
          if (r && r.ok && Array.isArray(r.events)) {
            if (r.events.length) {
              setEvents(function (prev) { return mergeEvents(prev, r.events); });
            }
            if (typeof r.latest_event_id === "number" && r.latest_event_id > latestRef.current) {
              latestRef.current = r.latest_event_id;
            }
          }
        }).catch(function () { /* transient — the snapshot poll reports errors */ });
    }, []);

    // main poll: pause while hidden, resume (with an immediate refresh) on visibility
    useEffect(function () {
      if (!auto) return undefined;
      refresh();
      var timer = window.setInterval(function () {
        if (!document.hidden) refresh();
      }, POLL_MS);
      var onVisible = function () { if (!document.hidden) refresh(); };
      document.addEventListener("visibilitychange", onVisible);
      return function () {
        window.clearInterval(timer);
        document.removeEventListener("visibilitychange", onVisible);
      };
    }, [auto, refresh]);

    // machine info is slower-moving and slightly more expensive: poll gently
    useEffect(function () {
      var load = function () {
        SDK.fetchJSON(API + "/machine").then(function (m) {
          if (m && m.ok) setMachine(m); else setMachine(null);
        }).catch(function () { setMachine(null); });
      };
      load();
      var timer = window.setInterval(load, MACHINE_POLL_MS);
      return function () { window.clearInterval(timer); };
    }, []);

    var pools = (snap && Array.isArray(snap.pools)) ? snap.pools : [];
    var daemon = (snap && snap.daemon) || null;
    var mem = machine && machine.memory ? machine.memory : null;
    var cpu = machine && machine.cpu ? machine.cpu : null;
    var pressure = machine && machine.pressure ? machine.pressure : null;
    var machineLabel = null;
    if (cpu || mem) {
      machineLabel = [
        cpu && cpu.effectiveCores != null ? cpu.effectiveCores + " cores" : null,
        mem && mem.effectiveLimitBytes != null ? fmtBytes(mem.effectiveLimitBytes) : null,
        pressure && pressure.loadPressure ? "load " + pressure.loadPressure : null,
        pressure && pressure.memPressure ? "mem " + pressure.memPressure : null
      ].filter(Boolean).join(" · ");
    }

    return h("div", { className: "ll-page" },
      error
        ? h("div", { className: "ll-error", title: error },
            "load-lock: " + error,
            " — install or enable the load-lock CLI, or check the plugin settings")
        : null,
      h("div", { className: "ll-head" },
        h("div", { className: "ll-head-left" },
          h("span", { className: "ll-title" }, "Load Lock"),
          machineLabel
            ? h("span", { className: "ll-machine", title: (pressure && pressure.note) || "" }, machineLabel)
            : null,
          daemon && daemon.daemonVersion
            ? h("span", { className: "ll-badge ll-tone-muted" },
                "daemon v" + daemon.daemonVersion +
                (snap && snap.runtime_source ? " · via " + snap.runtime_source : ""))
            : null
        ),
        h("div", { className: "ll-head-right" },
          updatedAt
            ? h("span", { className: "ll-updated" }, "updated " + fmtAge(Date.now() - updatedAt) + " ago")
            : null,
          h("button", { className: "ll-btn", onClick: refresh, title: "Refresh now" }, "Refresh"),
          h("button", {
            className: "ll-btn" + (auto ? " is-on" : ""),
            onClick: function () { setAuto(!auto); },
            title: auto ? "Polling every " + (POLL_MS / 1000) + "s — click to pause" : "Click to resume live updates"
          }, auto ? "● live" : "❚❚ paused")
        )
      ),
      !snap && !error
        ? h("div", { className: "ll-empty" }, "connecting to load-lock…")
        : null,
      h("div", { className: "ll-pools" + (pools.length > 1 ? " is-grid" : "") },
        pools.map(function (p) { return h(PoolCard, { pool: p, now: now, key: p.pool }); })),
      h(Card, { className: "ll-events-card" },
        h(CardHeader, null,
          h(CardTitle, { className: "ll-card-title" }, "Recent activity")
        ),
        h(CardContent, null,
          events.length
            ? events.slice().reverse().map(function (ev) {
                return h(EventRow, { event: ev, now: now, key: ev.id });
              })
            : h("div", { className: "ll-empty" }, "no events yet — acquire a permit to see the flow")
        )
      )
    );
  }

  REG.register("load-lock", LoadLockPage);
})();
