/**
 * load-lock — Hermes desktop half (unified package).
 *
 * Runtime-loaded plain ESM: this file ships as raw text and goes through the
 * desktop's plugin pipeline (import allowlist → SDK/react shim blobs → blob
 * import → register). No build step, no JSX syntax — every element is built
 * with jsx()/jsxs() from react/jsx-runtime, and ONLY '@hermes/plugin-sdk'
 * and 'react*' may be imported.
 *
 * What it contributes:
 *   • a "Load Lock" tiling pane (right edge of the workspace) with live
 *     pool capacity, holders, offers, queue and a recent-activity feed;
 *   • a status-bar chip `LL 2/3` colored by pressure, clicking reveals
 *     the pane;
 *   • a command-palette row "Open Load Lock".
 *
 * Data comes from this package's own dashboard backend
 * (plugins/hermes/dashboard/plugin_api.py) via ctx.rest — the same routes
 * the web dashboard tab uses, so every surface agrees with the daemon.
 * Polling is the source of truth (2s snapshot/events, 15s machine); the
 * backend's plugin-event broadcast is an accelerator that invalidates the
 * queries the instant the daemon logs a state change.
 *
 * The pane and chip render nothing until data resolves, and show a clean
 * error banner instead of a stack trace when the load-lock CLI is missing.
 */
import {
  host,
  icons,
  PALETTE_AREA,
  PANES_AREA,
  queryClient,
  STATUSBAR_AREAS,
  StatusDot,
  Tip,
  useQuery
} from '@hermes/plugin-sdk'
import { useEffect, useRef, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'load-lock'
const PANE_ID = `${ID}:pane`

const SNAPSHOT_POLL_MS = 2000
const MACHINE_POLL_MS = 15000
const MAX_EVENTS = 40

/* Disk plugins are not scanned by the app's Tailwind build, so this file
 * carries its own CSS (radio-plugin pattern): theme hues via --ui-* vars,
 * fixed status hues so pressure reads identically under every theme. */
const CSS = `
.hermes-ll-pane{display:flex;flex-direction:column;gap:10px;height:100%;min-height:0;padding:10px 12px;font-size:12px;color:var(--ui-text-primary)}
.hermes-ll-scroll{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;display:flex;flex-direction:column;gap:10px}
.hermes-ll-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
.hermes-ll-title{font-weight:600;letter-spacing:-.01em}
.hermes-ll-machine{font-size:11px;color:var(--ui-text-tertiary);cursor:help;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.hermes-ll-updated{margin-left:auto;font-size:11px;color:var(--ui-text-tertiary);white-space:nowrap;flex:none}
.hermes-ll-chip{display:inline-flex;height:100%;align-items:center;gap:4px;padding:0 6px;font-size:11px;line-height:1;color:var(--ui-text-tertiary);background:none;border:0;cursor:pointer;font-variant-numeric:tabular-nums}
.hermes-ll-chip:hover{background:var(--chrome-action-hover);color:var(--ui-text-primary)}
.hermes-ll-error{border:1px solid color-mix(in srgb,#ef4444 55%,transparent);background:color-mix(in srgb,#ef4444 12%,transparent);color:#fca5a5;padding:6px 10px;border-radius:8px;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hermes-ll-pool{display:flex;flex-direction:column;gap:2px;border:1px solid var(--ui-border,#8884);border-radius:8px;padding:8px 10px}
.hermes-ll-pool-head{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.hermes-ll-pool-name{font-weight:600;font-size:12px}
.hermes-ll-badge{display:inline-flex;align-items:center;font-size:10px;line-height:1.5;padding:1px 7px;border-radius:9999px;border:1px solid transparent;white-space:nowrap;flex:none}
.hermes-ll-tone-good{color:#4ade80;border-color:color-mix(in srgb,#22c55e 45%,transparent);background:color-mix(in srgb,#22c55e 12%,transparent)}
.hermes-ll-tone-warn{color:#fbbf24;border-color:color-mix(in srgb,#f59e0b 45%,transparent);background:color-mix(in srgb,#f59e0b 12%,transparent)}
.hermes-ll-tone-info{color:#60a5fa;border-color:color-mix(in srgb,#3b82f6 45%,transparent);background:color-mix(in srgb,#3b82f6 12%,transparent)}
.hermes-ll-tone-muted{color:var(--ui-text-tertiary);border-color:var(--ui-border,#8884);background:color-mix(in srgb,currentColor 6%,transparent)}
.hermes-ll-bar{height:6px;border-radius:9999px;background:color-mix(in srgb,currentColor 10%,transparent);overflow:hidden;margin:6px 0 4px}
.hermes-ll-bar-fill{height:100%;border-radius:9999px;background:#22c55e;transition:width .4s ease,background .4s ease}
.hermes-ll-bar-fill[data-mid=true]{background:#f59e0b}
.hermes-ll-bar-fill[data-full=true]{background:#ef4444}
.hermes-ll-section{font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--ui-text-tertiary);margin-top:6px}
.hermes-ll-row{display:flex;align-items:center;gap:6px;font-size:11px;padding:2px 0;min-width:0}
.hermes-ll-dot{width:7px;height:7px;border-radius:9999px;flex:none}
.hermes-ll-dot[data-run=true]{background:#22c55e;animation:hermes-ll-pulse 2s ease-in-out infinite}
.hermes-ll-dot[data-hold=true]{background:#f59e0b}
.hermes-ll-dot[data-info=true]{background:#3b82f6}
@keyframes hermes-ll-pulse{0%,100%{opacity:1}50%{opacity:.45}}
.hermes-ll-agent{font-family:var(--font-mono,ui-monospace,monospace);font-size:10px;font-weight:500;white-space:nowrap;flex:none;max-width:42%;overflow:hidden;text-overflow:ellipsis}
.hermes-ll-reason{flex:1;min-width:0;color:var(--ui-text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hermes-ll-age{color:var(--ui-text-tertiary);font-size:10px;flex:none;min-width:2.75rem;text-align:right;font-variant-numeric:tabular-nums}
.hermes-ll-empty{color:var(--ui-text-tertiary);font-size:11px;padding:2px 0}
.hermes-ll-evt{display:flex;align-items:baseline;gap:6px;font-size:11px;padding:1px 0;min-width:0}
.hermes-ll-evt-time{color:var(--ui-text-tertiary);min-width:3.25rem;flex:none;font-variant-numeric:tabular-nums}
.hermes-ll-evt-agent{font-family:var(--font-mono,ui-monospace,monospace);font-size:10px;color:var(--ui-text-tertiary);flex:none;max-width:30%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hermes-ll-evt-text{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ui-text-secondary)}
.hermes-ll-events{border:1px solid var(--ui-border,#8884);border-radius:8px;padding:8px 10px;display:flex;flex-direction:column;gap:1px}
`

/* ------------------------------------------------------------------ *
 * helpers                                                             *
 * ------------------------------------------------------------------ */

function parseRestError(err) {
  const msg = err && err.message ? String(err.message) : String(err)
  return msg
}

function fmtAge(ms) {
  if (ms == null || ms < 0 || Number.isNaN(ms)) return '—'
  let s = Math.floor(ms / 1000)
  if (s < 60) return s + 's'
  let m = Math.floor(s / 60)
  s %= 60
  if (m < 60) return m + 'm ' + s + 's'
  let hr = Math.floor(m / 60)
  m %= 60
  if (hr < 24) return hr + 'h ' + m + 'm'
  const d = Math.floor(hr / 24)
  hr %= 24
  return d + 'd ' + hr + 'h'
}

function fmtBytes(bytes) {
  if (bytes == null || Number.isNaN(bytes)) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = bytes
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return (i === 0 ? Math.round(v) : v.toFixed(1)) + ' ' + units[i]
}

function shortAgent(agentId) {
  if (!agentId) return 'unknown'
  const s = String(agentId)
  const idx = s.indexOf(':')
  const origin = idx > 0 ? s.slice(0, idx) : ''
  let rest = idx > 0 ? s.slice(idx + 1) : s
  if (rest.length > 12) rest = rest.slice(0, 12) + '…'
  return origin ? origin + ':' + rest : rest
}

function sumTotals(pools) {
  let used = 0
  let cap = 0
  for (const p of pools) {
    used += p.used || 0
    cap += p.capacity || 0
  }
  return { used, cap }
}

function pressureTone(pools) {
  let worst = 'muted'
  for (const p of pools) {
    const cap = p.capacity || 0
    if (cap > 0 && (p.used || 0) >= cap) return 'bad'
    if (cap > 0 && (p.used || 0) / cap >= 0.67) worst = 'warn'
    else if ((p.used || 0) > 0 && worst === 'muted') worst = 'good'
  }
  return worst
}

const EVENT_TONE = {
  granted: 'hermes-ll-tone-good',
  claimed: 'hermes-ll-tone-good',
  released: 'hermes-ll-tone-muted',
  queued: 'hermes-ll-tone-muted',
  offered: 'hermes-ll-tone-info',
  paused: 'hermes-ll-tone-warn',
  reclaimed: 'hermes-ll-tone-warn',
  cancelled: 'hermes-ll-tone-warn',
  expired: 'hermes-ll-tone-warn',
  declined: 'hermes-ll-tone-warn',
  daemon_started: 'hermes-ll-tone-info',
  daemon_recovered: 'hermes-ll-tone-info',
  configured: 'hermes-ll-tone-info'
}

/* ------------------------------------------------------------------ *
 * data (React Query over this plugin's own REST namespace)           *
 * ------------------------------------------------------------------ */

function useSnapshot(ctx) {
  return useQuery({
    queryKey: [ID, 'snapshot'],
    queryFn: () => ctx.rest('/snapshot'),
    refetchInterval: SNAPSHOT_POLL_MS,
    staleTime: SNAPSHOT_POLL_MS - 250,
    retry: 1
  })
}

function useEvents(ctx) {
  return useQuery({
    queryKey: [ID, 'events'],
    // since=0 + limit → the backend returns only the newest `limit` events,
    // so this stays a stateless poll (no cursor to lose on reload).
    queryFn: () => ctx.rest(`/events?since=0&limit=${MAX_EVENTS}`),
    refetchInterval: SNAPSHOT_POLL_MS,
    staleTime: SNAPSHOT_POLL_MS - 250,
    retry: 1
  })
}

function useMachine(ctx) {
  return useQuery({
    queryKey: [ID, 'machine'],
    queryFn: () => ctx.rest('/machine'),
    refetchInterval: MACHINE_POLL_MS,
    staleTime: MACHINE_POLL_MS - 1000,
    retry: 1
  })
}

function useNow() {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])
  return now
}

/* ------------------------------------------------------------------ *
 * rows                                                                *
 * ------------------------------------------------------------------ */

function HolderRow({ entry: e, now }) {
  const running = e.phase === 'running_tracked' || e.phase === 'running'
  const title = [
    e.agentId || e.agentLabel || '',
    e.cwd || '',
    e.opKey ? 'op: ' + e.opKey : ''
  ]
    .filter(Boolean)
    .join('\n')
  return jsxs('div', {
    className: 'hermes-ll-row',
    title,
    children: [
      jsx('span', { className: 'hermes-ll-dot', 'data-run': running, 'data-hold': !running, 'aria-hidden': true }),
      jsx('span', { className: 'hermes-ll-agent' }, e.agentLabel || shortAgent(e.agentId)),
      jsx('span', { className: 'hermes-ll-reason' }, e.reason || e.opKey || ''),
      running ? jsx('span', { className: 'hermes-ll-badge hermes-ll-tone-good' }, 'running') : null,
      jsx('span', { className: 'hermes-ll-age' }, fmtAge(e.heldFor != null ? e.heldFor : now - (e.since || now)))
    ]
  })
}

function OfferRow({ entry: e, now }) {
  const expires = e.offerExpiresAt != null ? e.offerExpiresAt : e.startDeadline
  return jsxs('div', {
    className: 'hermes-ll-row',
    title: e.agentId || '',
    children: [
      jsx('span', { className: 'hermes-ll-dot', 'data-info': true, 'aria-hidden': true }),
      jsx('span', { className: 'hermes-ll-agent' }, e.agentLabel || shortAgent(e.agentId)),
      jsx('span', { className: 'hermes-ll-reason' }, e.reason || 'offered — claim it (offers expire)'),
      jsx('span', { className: 'hermes-ll-badge hermes-ll-tone-info' }, expires ? 'expires in ' + fmtAge(expires - now) : 'offered')
    ]
  })
}

function QueueRow({ entry: e }) {
  return jsxs('div', {
    className: 'hermes-ll-row',
    title: e.agentId || '',
    children: [
      jsx('span', { className: 'hermes-ll-badge hermes-ll-tone-muted' }, '#' + (e.position != null ? e.position : '?')),
      jsx('span', { className: 'hermes-ll-agent' }, e.agentLabel || shortAgent(e.agentId)),
      jsx('span', { className: 'hermes-ll-reason' }, e.reason || ''),
      e.paused ? jsx('span', { className: 'hermes-ll-badge hermes-ll-tone-warn' }, 'paused') : null
    ]
  })
}

function SectionLabel({ children }) {
  return jsx('div', { className: 'hermes-ll-section' }, children)
}

function PoolCard({ pool, now }) {
  const used = pool.used || 0
  const cap = pool.capacity || 0
  const ratio = cap > 0 ? used / cap : 0
  const holders = pool.holders || []
  const offers = pool.offers || []
  const queue = pool.queue || []
  const paused = pool.paused || []
  const idle = !holders.length && !offers.length && !queue.length && !paused.length
  return jsxs('div', {
    className: 'hermes-ll-pool',
    children: [
      jsxs('div', { className: 'hermes-ll-pool-head', children: [
        jsx('span', { className: 'hermes-ll-pool-name' }, pool.pool),
        jsx('span', {
          className:
            'hermes-ll-badge ' +
            (used >= cap ? 'hermes-ll-tone-warn' : used > 0 ? 'hermes-ll-tone-info' : 'hermes-ll-tone-good')
        }, used + ' / ' + cap + ' in use')
      ] }),
      jsx('div', { className: 'hermes-ll-bar', title: used + ' of ' + cap + ' permits in use', children:
        jsx('div', {
          className: 'hermes-ll-bar-fill',
          'data-mid': ratio >= 0.67 && ratio < 1,
          'data-full': ratio >= 1,
          style: { width: Math.min(100, ratio * 100) + '%' }
        }) }),
      idle ? jsx('div', { className: 'hermes-ll-empty' }, 'idle — full capacity available for heavy work') : null,
      holders.length ? jsx(SectionLabel, { children: 'Holders' }) : null,
      ...holders.map(e => jsx(HolderRow, { entry: e, now }, e.requestId)),
      offers.length ? jsx(SectionLabel, { children: 'Offers' }) : null,
      ...offers.map(e => jsx(OfferRow, { entry: e, now }, e.requestId)),
      queue.length ? jsx(SectionLabel, { children: 'Queue' }) : null,
      ...queue.map(e => jsx(QueueRow, { entry: e }, e.requestId)),
      paused.length ? jsx(SectionLabel, { children: 'Paused' }) : null,
      ...paused.map(e => jsx(QueueRow, { entry: e }, e.requestId))
    ]
  })
}

function EventRow({ event: ev, now }) {
  const tone = EVENT_TONE[ev.type] || 'hermes-ll-tone-muted'
  const text = ev.entry && ev.entry.reason ? ev.entry.reason : ev.detail || ''
  return jsxs('div', { className: 'hermes-ll-evt' }, [
    jsx('span', { className: 'hermes-ll-evt-time' }, fmtAge(now - ev.ts) + ' ago'),
    jsx('span', { className: 'hermes-ll-badge ' + tone }, String(ev.type || '?').replace(/_/g, ' ')),
    jsx('span', { className: 'hermes-ll-evt-agent', title: ev.targetAgent || '' }, shortAgent(ev.targetAgent)),
    text ? jsx('span', { className: 'hermes-ll-evt-text', title: text }, text) : null
  ])
}

/* ------------------------------------------------------------------ *
 * status-bar chip                                                     *
 * ------------------------------------------------------------------ */

function LoadLockChip({ ctx }) {
  const query = useSnapshot(ctx)
  const snap = query.data
  if (!snap || !Array.isArray(snap.pools) || !snap.pools.length) return null
  const { used, cap } = sumTotals(snap.pools)
  const tone = pressureTone(snap.pools)
  const tip =
    snap.pools
      .map(p => {
        const q = (p.queue || []).length
        return `${p.pool} ${p.used || 0}/${p.capacity || 0}${q ? ` · ${q} queued` : ''}`
      })
      .join(' · ') + ' — click to open the Load Lock pane'
  return jsx(Tip, {
    label: tip,
    children: jsx('button', {
      type: 'button',
      className: 'hermes-ll-chip',
      'aria-label': `Load Lock: ${used} of ${cap} heavy-work permits in use`,
      onClick: () => {
        if (typeof host.revealPane === 'function') host.revealPane(PANE_ID)
      },
      children: jsxs('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 4 }, children: [
        jsx(StatusDot, { tone }),
        jsx('span', {}, `LL ${used}/${cap}`)
      ] })
    })
  })
}

/* ------------------------------------------------------------------ *
 * pane                                                                *
 * ------------------------------------------------------------------ */

function LoadLockPane({ ctx }) {
  const now = useNow()
  const snapQuery = useSnapshot(ctx)
  const machineQuery = useMachine(ctx)
  const eventsQuery = useEvents(ctx)
  const updatedAtRef = useRef(0)
  const snap = snapQuery.data
  if (snap && snap.generated_at && updatedAtRef.current !== snap.generated_at) {
    updatedAtRef.current = snap.generated_at
  }

  const error = snapQuery.isError
    ? parseRestError(snapQuery.error)
    : snap && snap.ok === false
      ? snap.error || 'load-lock is not available'
      : null
  const pools = snap && Array.isArray(snap.pools) ? snap.pools : []
  const events = eventsQuery.data && Array.isArray(eventsQuery.data.events) ? eventsQuery.data.events : []
  const machine = machineQuery.data && machineQuery.data.ok ? machineQuery.data : null
  const mem = machine && machine.memory ? machine.memory : null
  const cpu = machine && machine.cpu ? machine.cpu : null
  const pressure = machine && machine.pressure ? machine.pressure : null
  let machineLabel = null
  if (cpu || mem) {
    machineLabel = [
      cpu && cpu.effectiveCores != null ? cpu.effectiveCores + ' cores' : null,
      mem && mem.effectiveLimitBytes != null ? fmtBytes(mem.effectiveLimitBytes) : null,
      pressure && pressure.loadPressure ? 'load ' + pressure.loadPressure : null,
      pressure && pressure.memPressure ? 'mem ' + pressure.memPressure : null
    ]
      .filter(Boolean)
      .join(' · ')
  }

  return jsxs('div', { className: 'hermes-ll-pane', children: [
    error
      ? jsx('div', { className: 'hermes-ll-error', title: error }, 'load-lock: ' + error)
      : null,
    jsxs('div', { className: 'hermes-ll-head', children: [
      jsx('span', { className: 'hermes-ll-title' }, 'Load Lock'),
      machineLabel
        ? jsx('span', { className: 'hermes-ll-machine', title: (pressure && pressure.note) || '' }, machineLabel)
        : null,
      jsx('span', { className: 'hermes-ll-updated' },
        snapQuery.isFetching ? '…' : 'updated ' + fmtAge(Date.now() - (updatedAtRef.current || Date.now())) + ' ago')
    ] }),
    !pools.length && !error
      ? jsx('div', { className: 'hermes-ll-empty' }, 'connecting to load-lock…')
      : null,
    jsxs('div', { className: 'hermes-ll-scroll', children: [
      ...pools.map(p => jsx(PoolCard, { pool: p, now }, p.pool)),
      jsxs('div', { className: 'hermes-ll-events', children: [
        jsx(SectionLabel, { children: 'Recent activity' }),
        events.length
          ? events
            .slice()
            .reverse()
            .map(ev => jsx(EventRow, { event: ev, now }, ev.id))
          : jsx('div', { className: 'hermes-ll-empty' }, 'no events yet — acquire a permit to see the flow')
      ] })
    ] })
  ] })
}

/* ------------------------------------------------------------------ *
 * plugin                                                              *
 * ------------------------------------------------------------------ */

export default {
  id: ID,
  name: 'Load Lock',
  description:
    'Live view of the machine-wide heavy-work budget: pool capacity, holders, offers and queue, plus an LL used/total status chip.',
  defaultEnabled: true,
  register(ctx) {
    const style = document.createElement('style')
    style.textContent = CSS
    document.head.append(style)
    ctx.onDispose(() => style.remove())

    // Push accelerator: the dashboard backend broadcasts a plugin event on
    // every daemon state change; invalidate the shared queries instantly.
    // Polling above remains the fallback (and the only path on hosts
    // without plugin events), so nothing breaks when the broadcast is a
    // no-op. Feature-detect: ctx.onEvent exists everywhere this half loads.
    ctx.onEvent?.('plugin.' + ID + '.state.changed', () => {
      queryClient.invalidateQueries({ queryKey: [ID] })
    })

    ctx.registerMany([
      {
        id: 'pane',
        area: PANES_AREA,
        title: 'Load Lock',
        // dock: adopt into the workspace's right edge (the Routines-pane
        // gesture) so the panel is a first-class tiling pane, visible by
        // default and draggable anywhere the user likes.
        data: { placement: 'main', dock: { pane: 'workspace', pos: 'right' }, width: '320px' },
        render: () => jsx(LoadLockPane, { ctx })
      },
      {
        id: 'chip',
        area: STATUSBAR_AREAS.right,
        order: 130,
        render: () => jsx(LoadLockChip, { ctx })
      },
      {
        id: 'open',
        area: PALETTE_AREA,
        data: {
          id: 'load-lock.open',
          label: 'Open Load Lock',
          keywords: ['load-lock', 'permits', 'capacity', 'builds', 'semaphore', 'pressure'],
          icon: icons.Cpu,
          run: () => {
            if (typeof host.revealPane === 'function') host.revealPane(PANE_ID)
          }
        }
      }
    ])
  }
}
