# Operating load-lock

## Install

Requirements: Node 20+, Linux (macOS works with the limitations noted below;
Windows would need a named-pipe adapter — not implemented).

```sh
npm install -g @aron98/load-lock    # or: npm install -g ./aron98-load-lock-<ver>.tgz
load-lock install --harness opencode
load-lock install --harness claude-code
load-lock install --harness codex
load-lock install --harness gemini-cli
load-lock install --harness copilot-cli
load-lock install --harness cline
load-lock install --harness roo-code
load-lock install --harness goose
load-lock install --harness generic   # prints MCP snippets for other harnesses (Cursor)
```

What each installer does (all merges are non-destructive; uninstall removes
exactly the entries it added):

- **opencode** — writes a plugin stub to
  `~/.config/opencode/plugins/load-lock/` (npm-installed against the global
  package), registers it in `~/.config/opencode/opencode.json`.
- **claude-code** — adds `mcpServers.load-lock` to `~/.claude.json`; hooks
  (`SessionStart`, `Stop`, async `await-offer`) to `~/.claude/settings.json`;
  a marked section to `~/.claude/CLAUDE.md`; copies the skill to
  `~/.claude/skills/load-lock/`.
- **codex** — writes `~/.codex/hooks.json` (`SessionStart`, `SubagentStart`,
  `Stop`), appends `[mcp_servers.load-lock]` to `~/.codex/config.toml` if
  absent, adds a marked section to `~/.codex/AGENTS.md`. **Then run `/hooks`
  inside Codex once to trust the hooks.**
- **gemini-cli** — writes `mcpServers.load-lock` (stdio: `node` + absolute
  path to `dist/mcp/main.js`) into `~/.gemini/settings.json`, adds a marked
  section to `~/.gemini/GEMINI.md`. MCP-fallback tier: Gemini CLI has no
  hooks and no async push, so there is no idle wakeup — offers surface at
  tool boundaries.
- **copilot-cli** — merges `mcpServers.load-lock` (`type: local`) into
  `~/.copilot/mcp-config.json` (verify with `copilot mcp list`) and adds a
  marked section to `~/.copilot/copilot-instructions.md`. MCP-fallback
  tier: hooks are reported in ecosystem content but not verified in
  official docs, so none are installed — no idle wakeup is claimed; offers
  surface at tool boundaries.
- **cline** — merges `mcpServers.load-lock` into
  `~/.cline/data/settings/cline_mcp_settings.json` (or the path in
  `CLINE_MCP_SETTINGS_PATH`) and writes a dedicated
  `~/.cline/rules/load-lock.md`. MCP-fallback tier: no hooks, no async
  push — no idle wakeup.
- **roo-code** — merges `mcpServers.load-lock` into `<project>/.roo/mcp.json`
  (the CLI's cwd unless `--project` is passed) and into every **existing**
  global `mcp_settings.json` (VS Code globalStorage; existing files only —
  never created), plus a dedicated `~/.roo/rules/load-lock.md`. MCP-fallback
  tier: no hooks, no async push — no idle wakeup.
- **goose** — merges an `extensions.load-lock` stdio block (marker-tagged
  block-mapping YAML; refuses flow-style `extensions:`) into
  `~/.config/goose/config.yaml` (XDG_CONFIG_HOME respected) and adds a
  marked section to `~/.config/goose/.goosehints`. MCP-fallback tier: no
  hooks, no async push — no idle wakeup.
- **generic** — prints MCP stdio config snippets (Cursor and other
  harnesses without a dedicated installer) plus a suggested
  instructions-file section.

`load-lock uninstall --harness <harness>` reverses any of these.

## The daemon

- State dir: `~/.local/state/load-lock` (override `LOAD_LOCK_STATE_DIR`).
- Socket: `<state dir>/daemon.sock` (override `LOAD_LOCK_SOCKET`).
- **Auto-spawns** on first client connection; no service unit needed.
- Files: `config.json` (settings + history), `journal.json` (held permits),
  `daemon.json` (pid), `spawn.lock` (bootstrap race guard).

```sh
load-lock service status   # hello + pid
load-lock service start    # ensure running (idempotent)
load-lock service stop     # SIGTERM; next tool call respawns
```

## Configuration

All configuration is agent-editable through tools (no file editing for
ordinary use) — MCP `configure` / plugin `load_lock_configure` /
`load-lock configure`. Updates are compare-and-swap on a version number
(`expected_version` prevents silent overwrites), validated, persisted with
author + reason, and appended to a visible history (last 50 changes).

```sh
load-lock configure --capacity 2 --reason "host has 16 cores" --author ops
load-lock configure --offer-timeout-ms 60000 --reason "model turns can be slow" --author agent
load-lock get-config
```

Defaults: one pool `heavy` capacity 1 · offer window 30s · blocking wait 5s ·
start deadline 120s · untracked lease 15min. Valid ranges:
offer window 1s–10min, wait 0–10min, start deadline 1s–1h, lease 10s–24h.

Semantics of changes:

- **Capacity increase** — queued requests are admitted immediately (FIFO
  offers); outstanding offers keep their reservations.
- **Capacity decrease** — current holders finish untouched; new admissions
  are delayed until usage fits.

`inspect_machine` reports logical cores, cgroup v2/v1 CPU quota and memory
limits (containers respected — we never assume 2 cores means 2 jobs),
available memory, and current load/memory pressure with an advisory
suggestion. Agents are expected to consult it before proposing capacity.

## Dashboard: watching the budget live

Two read-only viewers surface the machine-wide state in real time. Both use
the library's own client + protocol (`./shared/client`, `./shared/protocol`)
over the daemon's watch event stream — neither scrapes CLI output — and
both resume cleanly across daemon restarts (event-cursor `events since` +
journal recovery).

**The viewers never acquire a permit.** Watching the lock is light work by
construction: they only ever call `status` / `events` / `inspect` / `watch`.
The one admin action they expose — force-release — sits behind an explicit
select + confirm step and never runs automatically.

### `load-lock top` (portable, any terminal)

```sh
load-lock top          # full-screen live dashboard (q quit, r resync)
load-lock top --once   # render one frame and exit (pipes, scripts, CI logs)
```

Shows pools with capacity vs in-use, holder cards (label, reason, phase,
pid/pgid, age, start-deadline or lease countdown), offer cards with the
claim-window countdown, FIFO queue positions, paused requests, the recent
event feed, and the `inspect_machine` panel. It reconnects with backoff if
the daemon dies, and a daemon restart is announced and re-synced (durable
event ids are per daemon lifetime; the cursor resets on restart).

Zero extra dependencies: it renders plain text lines over the standard
alternate screen, so it works anywhere the CLI works.

### OpenCode TUI panel

The OpenCode installer also ships the package's `./tui` plugin export (a
companion to the main plugin, which is unchanged). Inside the opencode TUI:

- `/load-lock` (or the command palette) opens the **load-lock.dashboard**
  session panel full-screen: same data as `load-lock top`, themed,
  live-updating.
- The home footer gains a small `lock 1/1·Q2` indicator.
- `r` resyncs; `x` opens force-release, which requires an explicit
  select + confirm — the panel itself is read-only.

Verified live against opencode 2.0.29: the panel renders pools, holder
cards, queue positions and the event feed against the real daemon, and the
`x` flow refuses to release anything until the confirm dialog accepts.
Plugins configured in `opencode.json` that expose `./tui` are loaded
automatically by the CLI, so the published package needs no extra config.
For local development against a checkout, opencode also auto-discovers
plugins laid out like a package under `<project>/.opencode/plugins/<name>/`
(`index.ts` re-exporting the main plugin, `tui.ts` re-exporting
`./dist/adapters/opencode/tui.js`).

### Notes for other harnesses

`load-lock top` is the dashboard for every harness (it only needs the
daemon, which every integration spawns). Harnesses without an in-app UI
surface get exactly that — no parity claims; see `docs/COMPATIBILITY.md`.

## Diagnostics & recovery

```sh
load-lock doctor            # state dir, socket, daemon reachability, effective cores, pressure
load-lock status            # human view: usage, holders w/ phase+pid, offers, queue, paused
load-lock pending           # your own offers/queue entries (JSON)
load-lock events --follow   # durable event log (grants, offers, releases, reclaims...)
load-lock recover list      # holder diagnostics: tracked? alive? age, long-hold flags
load-lock recover force-release --id <request-id>   # admin release (prints holder/job info)
```

Recovery policy summary:

- Held permits with a tracked live process are **never** revoked for being
  old — long holds are flagged in diagnostics, nothing more.
- A tracked permit auto-releases when its process (or process group) is
  confirmed dead — including background children that outlived the shell.
- A claimed-but-never-started permit is reclaimed after the start deadline.
- An untracked (`mark_started`) permit lives under a heartbeat lease; if the
  owning agent (MCP server / plugin / CLI heartbeat) disappears, it is
  reclaimed after the lease. Residual risk of overlap with an unobserved
  surviving process is documented — use `attach_pid`/`run_with_permit`
  whenever possible for real guarantees.
- After a daemon restart, `journal.json` reconciles held permits against
  actual process liveness (dead ⇒ released, alive ⇒ kept with same tokens).
  Queued/offered requests are not journaled — agents re-acquire; this is
  intentional and safe.

## Troubleshooting

| Symptom | Check / fix |
| --- | --- |
| Tools hang | `load-lock doctor`. Daemon down? It auto-spawns; if the socket file is stale it is detected and replaced automatically. |
| `offer_expired` on claim | Claim window elapsed (default 30s) — the request is paused; `rejoin` it and claim promptly. Consider a longer `--offer-timeout-ms`. |
| Agent got "undefined" wakeup / no offer | Offers match the cwd recorded at acquire time; verify with `load-lock pending`. Claude Code/Codex wakeups require cwd match between hook session and acquire call. |
| Capacity seems stuck | `status` + `recover list`: look for untracked leases (`[untracked, leased]`), long holds, or dead holders awaiting sweep (runs every 5s). Use `force-release` with the printed request id. |
| Codex hooks never fire | Run `/hooks` in Codex and trust the load-lock entries; check `[features] hooks` is not disabled. |
| Claude Code doesn't wake when idle | The async `await-offer` hook must be in `~/.claude/settings.json` with `async: true, asyncRewake: true` — verify with `load-lock doctor` / inspect the file. |
| Config change lost | Configuration is CAS-versioned: fetch `get_config`, retry with the fresh `version` on `version_conflict`. |
| After OS reboot | Nothing to do: state dir persists config; daemon respawns on first use; journal reconciliation releases permits whose processes died. |

## macOS / Windows notes

- macOS: no cgroup limits; process-liveness checks fall back from
  `/proc/<pid>/stat` start times to `kill(pid, 0)` (weaker PID-reuse
  defense — document and prefer `run_with_permit`). Everything else works.
- Windows: Unix-domain sockets are not used; a named-pipe transport adapter
  would be required (planned, not implemented).
