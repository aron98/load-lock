# Operating load-lock

## Install

Requirements: Node 20+, Linux (macOS works with the limitations noted below;
Windows has a named-pipe transport adapter — implemented and unit-tested on
Linux via platform injection, not yet verified on a Windows machine; see the
Windows section at the bottom).

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
load-lock install --harness cursor --project /path/to/repo
load-lock install --harness generic   # prints MCP snippets for other harnesses
```

What each installer does (all merges are non-destructive; uninstall removes
exactly the entries it added):

Hook-bearing installers (claude-code, codex, cursor) recognize their own
hook entries by the JSON-quoted CLI path embedded in the hook command, so
re-running an installer is idempotent and uninstall removes exactly our
entries, leaving user hooks alone. This is contract-tested via temp-HOME
round-trips in `src/test/install.test.ts` for all three (an earlier matcher
never matched its own entries — duplicate installs and hooks that survived
uninstall — see issue #19); not live-verified inside the real CLIs.

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
- **cursor** — project-level (pass `--project`, defaults to cwd): merges
  `mcpServers.load-lock` into `<project>/.cursor/mcp.json`, merges a flat
  hooks-v1 stop entry into `<project>/.cursor/hooks.json` (`version` added
  only if absent; user entries preserved), writes a dedicated Always-apply
  rule `<project>/.cursor/rules/load-lock.mdc`. Hooks tier: the stop hook
  returns `{"followup_message":...}` so Cursor continues the session when an
  offer arrives. Contract-tested against the documented hooks JSON
  (https://cursor.com/docs/hooks); not live-verified.
- **generic** — prints MCP stdio config snippets (harnesses without a
  dedicated installer) plus a suggested
  instructions-file section.

`load-lock uninstall --harness <harness>` reverses any of these.

### `load-lock setup`: what is installed where

`load-lock setup [--project <dir>] [--json]` lists every load-lock
integration it finds, for every harness `install` supports (the project
defaults to the cwd). It is **read-only**: it never writes a file.

For each harness it reports:

- **what** it found: plugins (Claude Code `enabledPlugins` entries named
  `load-lock-plugin@…`, OpenCode `plugin` / `plugins` entries), MCP
  registrations (user and project scope, including ACE's `.mcp.json`
  `servers` patch), loose hooks, policy sections / rule files, skill
  copies, and omac sandbox grants;
- **who** wrote each entry: `installer` (the exact shape `load-lock
  install` writes), `harness` (the harness's own plugin state), `ace`
  (an `.ace.json` stamp sits next to it), or `other` (manual, npx, …);
- **which copy** an entry runs, and whether that copy is gone (stale);
- the **rung**: `plugin`, `loose` (`load-lock install` wiring), `MCP only`,
  `skill only`, or `not installed`;
- **findings**: loose hooks next to an active plugin, the MCP server
  registered more than once (a Claude Code plugin's bundled server counts),
  hooks from more than one copy, duplicate hook entries, several skill
  copies, stale entries, disabled plugins.

It ends with the runtime copies: those on disk (as in `doctor`), the copy
the daemon runs (`daemon.json`), and the copies the daemon has seen.

An ACE-installed Claude plugin (unzipped into `.claude/skills/<name>/`) is
listed but not counted as an active plugin: whether Claude Code loads it
there is not verified yet (#63).

#### Converging: `load-lock setup --yes`

After the inventory, `setup` prints a **plan** that brings every harness
that already has some load-lock wiring to the recommended layout: the
highest rung available, exactly one of each. Without `--yes` it is a dry
run. `--yes` applies it (`--json` adds `plan` and `applied`). Harnesses with
nothing installed are left alone; the plan names them once.

The plan only uses moves the installers can reverse:

| Situation | Step |
|---|---|
| Claude Code plugin enabled **and** loose `install` wiring | `remove-loose`: drop the loose MCP server, hooks and `CLAUDE.md` section (the plugin provides them). The skill stays: the plugin ships none. Undo: `load-lock install --harness claude-code`. |
| Installer wiring incomplete, pointing at a missing copy, or hooks from several copies / duplicated | `install`: remove the installer-shaped hooks of every copy (and a stale codex `[mcp_servers.load-lock]` block), then `load-lock install --harness <h>` from the running copy |
| Only an MCP registration or only the skill | `install` (moves up to the installer's rung) |
| Anything not written by `load-lock install` (plugin state, ACE entries, manual / npx entries, extra skill copies) | `manual`: printed with what to remove or run (`/plugin uninstall …`), never applied |

Guards, each turning an `install` into a `manual` step:

- a foreign entry sits in the slot `install` would overwrite (e.g. a
  hand-written `mcpServers.load-lock`);
- the Claude Code skill directory is managed by ACE (`.ace.json`);
- the running copy lives in the npx or opencode cache, which npm may prune
  (install globally first);
- `cursor` / `roo-code` write into the project, so they are only refreshed
  when the project already has their installer wiring.

`load-lock uninstall --harness <h>` still removes everything load-lock
added, after a converge as before it. The MCP instructions and the
session-start brief end with a one-line pointer to `load-lock setup`.

## The daemon

- State dir: `~/.local/state/load-lock` (Windows: `%LOCALAPPDATA%\load-lock`;
  override `LOAD_LOCK_STATE_DIR`).
- Socket: `<state dir>/daemon.sock` (Windows: named pipe `\\.\pipe\load-lock`;
  override `LOAD_LOCK_SOCKET`).
- **Auto-spawns** on first client connection; no service unit needed. Set
  `LOAD_LOCK_NO_SPAWN` to any non-empty value except `0` to forbid
  spawning (client-only mode for sandboxes — see
  [Sandboxes](#sandboxes)).
- Also honored by the shared client: `LOAD_LOCK_LABEL_PREFIX` (prefix for
  holder labels; see Sandboxes).
- Files: `config.json` (settings + history), `journal.json` (held permits +
  queued requests), `daemon.json` (pid, plus since #52 the daemon's
  `packageRoot` and `version`), `runtimes.json` (known runtime copies, see
  below), `spawn.lock` (bootstrap race guard).
- **Known runtime copies** (since #52): every client envelope carries its
  package root (`clientRoot`); the daemon validates it (a package.json
  naming `@aron98/load-lock`; the version is read from disk, not trusted
  from the client) and records `{path, version, lastSeen}` in
  `runtimes.json`, deduped by real path, pruning copies whose path is gone.
  Small entry points (skill, plugin launchers) can read `daemon.json` /
  `runtimes.json` to find an existing runtime without npx; `doctor` lists
  them as `daemonRuntime` and `knownRuntimes`.

```sh
load-lock service status   # hello + pid + daemon version
load-lock service start    # ensure running (idempotent); refusals name the conflicting pid
load-lock service stop     # SIGTERM → bounded wait → SIGKILL; verifies the socket is free
load-lock service restart  # stop then start; both phases reported; failures name the phase
```

`service stop` is honest, not fire-and-forget: it signals the daemon
(`--timeout <ms>` bounds the wait, default 5s), escalates to SIGKILL if the
socket still answers, and only reports success once the endpoint is
verifiably free (stale `daemon.json`/socket files are cleaned up either way).
`service start` refuses loudly when something else owns the endpoint —
naming the conflicting pid — instead of a bare "did not come up within 10s".
`service restart` (since #38) composes the same two hardened phases and
reports both lines; a failure names the phase and reason
(`restart failed in the STOP phase: ...` / `... in the START phase ...`).
Stopping when nothing runs is not an error: the start phase simply spawns a
fresh daemon.

## Update lifecycle

The daemon is long-lived, so an update (`npm i -g @aron98/load-lock@latest`,
or opencode refreshing its plugin copy) leaves the running daemon on stale
code. The **version handshake** closes that gap (v1.3.0+):

- Every client envelope carries `clientVersion`; `hello`/`status` replies
  carry `daemonVersion` (the package version of the code the daemon runs).
- When a **newer** client contacts an older daemon, the daemon finishes
  answering, then **self-restarts**: it persists state + journal, drains all
  connections, respawns, and exits. Since #53 the respawn runs the **newer
  client's copy** when the envelope's `clientRoot` checks out (a
  `@aron98/load-lock` package.json whose on-disk version equals the
  claimed `clientVersion`, plus a `dist/core/daemon-main.js`), so a daemon
  spawned by an old global CLI moves onto e.g. a newer npx copy. Without a
  valid hint it falls back to the same argv (`process.execPath` + original
  arguments, so it runs whatever is now on disk at the same path). The respawn inherits a `LOAD_LOCK_RESTARTED_FOR` marker so
  repeated contact with the same version cannot cause a restart loop — one
  respawn attempt per version.
- Clients that were connected see a disconnect and simply reconnect to the
  fresh daemon.
- **What survives a restart:** held permits are journaled and reconciled
  conservatively (tracked jobs re-checked for liveness, same permit tokens
  valid; dead jobs released); queued *and offered* requests are journaled and
  re-queued FIFO with the same request ids (idempotent re-acquire keeps
  working). Offered entries restart as queued and are re-offered with fresh
  tokens — pre-restart offer tokens are invalid, exactly as for any restart.
- Skew is visible before it heals: `load-lock status`, `service status`,
  `doctor`, and the dashboards show "daemon vX, installed vY" and note the
  pending self-restart; `doctor` actively waits a few seconds to confirm the
  daemon came back on the new version.

### `load-lock update` (since #38)

The update command checks npm for a newer version, classifies where *this*
copy lives **before touching anything**, and applies the update via the
detected package manager — or refuses honestly rather than guessing:

| this copy is...                       | `load-lock update` does                                            |
| ------------------------------------- | ------------------------------------------------------------------ |
| bun global (`~/.bun/install/global/…`)  | `bun i -g @aron98/load-lock@latest`                                |
| npm global (under `npm root -g`)        | `npm i -g @aron98/load-lock@latest`                                |
| opencode's npm-cache copy               | refuses — opencode manages this copy and refreshes it on its own schedule |
| npx cache copy (`~/.npm/_npx/<hash>/…`, since #57) | refuses — it is whatever version the launching `npx -y @aron98/load-lock@<pin>` pins; bump that pin (MCP/skill config or ACE artifact) |
| a git checkout (nearest `.git`)         | refuses — update it via your git workflow (`git pull` etc.)        |
| anything else                           | refuses — "cannot tell how this copy was installed"                 |

After a successful apply it runs `service restart` explicitly, so the
daemon moves onto the new code immediately (the version handshake remains
the safety net, not the primary means). The package manager's output is
shown live. `--check` is a dry run that touches nothing and uses
script-friendly exit codes:

- exit `0` — up to date (or this copy is ahead of the registry)
- exit `1` — an update is available (including the honest refusals above:
  the update *exists*, this copy just cannot self-apply it)
- exit `70` — failure (registry unreachable, package manager failed, or a
  refusal in apply mode)

Reports are prose for humans and `--json` structured objects for agents
(`state`: `up-to-date` | `update-available` | `refused` | `updated`).

### Adapter-init drift notice

The mirror problem is a *newer adapter copy* with an *older CLI on PATH*
(typically: opencode refreshed its private cache copy, the global install
was never updated). At init, the OpenCode plugin and the MCP server compare
their own version with the PATH-resolved CLI copy's `package.json` and
surface **one clear notice** naming the exact command (`load-lock update`),
on stderr and in the injected context / MCP `instructions`. Notify only —
**nothing is ever auto-installed**. Honest limitation: a harness session
that was already running keeps the *old* adapter code in memory until the
harness itself restarts, so the notice fires from the new copy at its init
— sessions started before a refresh see it on their next restart.
The same check covers **npx-vs-PATH skew** (#57): an MCP server launched
via a pinned `npx -y @aron98/load-lock@<pin>` runs from the npx cache, and
when that copy is newer than the PATH CLI the notice names it as the npx
copy. (The reverse — a pin older than the PATH CLI — is not flagged here;
the daemon's version handshake already keeps the daemon on the newer code.)

Limits, stated honestly: the respawn re-runs the **same argv** — it picks up
an updated copy only if the daemon's launching copy was updated *in place*
(the normal `npm i -g` case). A daemon spawned from a different copy (e.g.
opencode's private cache copy) keeps running that copy's code after a
restart; see the multi-copy notes in
[COMPATIBILITY.md](COMPATIBILITY.md#multiple-copies-of-load-lock-opencode).
Pre-1.3.0 daemons do not answer the handshake and never self-restart —
`service restart` (or `service stop` followed by any load-lock command)
moves them onto current code. The restart behavior itself is live-verified
on Linux by the test suite (`src/test/update.test.ts`); the in-place-update
path beyond same-argv respawn is inspected, not live-tested. The `update`
command's stop→start compositing, its refusals, `--check` exit codes, and
the adapter-init drift notice are live-verified on Linux by
`src/test/update-command.test.ts` — with a **stubbed npm on PATH and a
planted copy**; no test ever contacts the real npm registry or installs
anything, so the genuine `npm i -g` round trip is contract-tested, not
live-tested.

### Plugin in-memory staleness (issue #39)

The daemon heals itself via the handshake, but the **opencode plugin does
not**: opencode loads plugin code **once per process at startup** and never
hot-reloads it. After `npm i -g @aron98/load-lock@latest` (or opencode
refreshing its plugin cache for *new* sessions), an already-running opencode
session keeps executing the **old copy in memory** — even though the panel
and dashboards reconnect to the daemon just fine. A stale in-memory plugin
is not a reconnect failure; restarting opencode is the only way to pick up
the new plugin code.

To make that visible instead of mysterious (v1.4.1+):

- The dashboards (TUI panel and `load-lock dashboard`) periodically compare
  the running copy's version with the PATH-resolved `load-lock` install.
  When the PATH CLI is newer, the panel shows
  `note: plugin updated — restart opencode to pick up vX (this session
  still runs vY; opencode does not hot-reload plugins)`; the CLI surface
  says the running copy is stale instead.
- When the daemon itself restarts onto a **different version** (update
  self-restart, or a manual restart of a newer install), the reconnect note
  names it: `daemon restarted onto v1.5.0 (was v1.4.0; pid N); event
  history re-synced`.
- If a harness pruned the running copy's plugin-cache directory mid-session
  (making the on-disk daemon entry vanish), client auto-spawn falls back to
  the PATH-installed CLI's daemon instead of failing with ENOENT forever.
- Recovery story: the daemon side is automatic (handshake self-restart);
  the plugin side needs exactly one action — **restart opencode**. Until
  then everything keeps working; only the plugin's code (and its notes)
  is one version behind.

The reverse direction — a *newer* adapter copy with an *older* CLI on PATH —
is #38's [adapter-init drift notice](#adapter-init-drift-notice), above.

Verification split (honest): live-verified on Linux by
`src/test/reconnect.test.ts` against real daemons — the daemon-kill
auto-respawn reconnect (the H1 repro), the failed-initial-connect recovery,
and the vanished daemon entry not crashing the host (real ENOENT spawn
through the compiled client). Contract-tested — mock client / planted
fixture PATH layouts, no version is ever really upgraded in a test — the
"restarted onto vX (was vY)" note wording, install-drift detection and its
per-surface hints, and the `resolveDaemonEntry` fallback table. The genuine
`npm i -g` + opencode-cache-refresh round trip is inspected, not
live-tested.

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
turn-wait cap (`maxTurnWaitMs`, bounds `wait_for_turn`, `wait_for_completion`
and `load-lock wait --id/--job`) 10min ·
start deadline 120s · untracked lease 15min. Valid ranges:
offer window 1s–10min, wait 0–10min, turn-wait cap 1s–1h, start deadline 1s–1h, lease 10s–24h.

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

### `load-lock dashboard` (portable, any terminal)

```sh
load-lock dashboard          # full-screen live dashboard (q quit, r resync)
load-lock dashboard --once   # render one frame and exit (pipes, scripts, CI logs)
```

`top` still works as a hidden compatibility alias for `dashboard` (same
command, same flags) — existing scripts keep running; new docs and muscle
memory should use `dashboard`.

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

- `/load-lock` (or the command palette) opens the
  **load-lock.dashboard** session panel **in-window** as a side panel —
  same data as `load-lock dashboard`, themed, live-updating, with the rest
  of the TUI layout still visible beside it.
- Every session screen shows an at-a-glance widget at the bottom of the
  right sidebar: `load-lock 0/3` colored by pool health (green ok, yellow
  full/queued, red daemon down) plus a hint line. Clicking it opens the
  dashboard; `/load-lock` is the fallback for terminals that don't deliver
  mouse events. The home screen keeps its `lock 1/1·Q2` footer indicator —
  the sidebar widget only renders on session screens, so the two never
  double-render.
- `r` resyncs; `x` opens force-release, which requires an explicit
  select + confirm — the panel itself is read-only.
- `Esc` closes the panel (the footer has always advertised this). It is
  deliberately inactive while a dialog — force-release, the command
  palette — is open, so Esc keeps cancelling the dialog instead of
  closing the panel underneath it.

The panel surfaces two kinds of operational notes inline (issue #39): a
`daemon restarted (onto vX)` line after the daemon restarts underneath the
session (event history is re-synced automatically), and — because opencode
never hot-reloads plugins — a `plugin updated — restart opencode to pick
up vX` hint whenever the PATH `load-lock` install is newer than the copy
this session is running. See "Plugin in-memory staleness" under
[Update lifecycle](#update-lifecycle).

The open command deliberately ships with **no global key binding** (issue
#28). Never bind unmodified single letters or letter sequences (the old
`gl`) at global scope: while the keymap engine waits for the next key of a
sequence it swallows the prefix, so plain `g` never reached the composer.
The obvious modifier chord, `ctrl+g`, is already the host's documented
default for `session.first` ("Navigate to first message") in opencode
>= 2.0.32, so binding it would shadow a host feature; per the issue's
fallback the command is unbound instead — the sidebar click, the command
palette, and `/load-lock` are the entry points. (The panel-scoped `r` and
`x` bindings are fine: they are `enabled` only while the dashboard panel
itself is fullscreen, when the composer is suspended and no typing can be
swallowed.)

Verified live against opencode 2.0.32 (real pty session): the sidebar
widget renders with live daemon data, a mouse press on the widget opens
the dashboard in-window with the chat still visible beside it, plain `g`
types into the composer with no keymap interception, `ctrl+g` is not
intercepted by load-lock (the host's documented `session.first` default
is left untouched), and the `/load-lock` command appears in the slash
suggestions and opens the panel.
Earlier live verification (2.0.29): panel render, palette/slash entry
points, and the confirm-gated force-release flow. Click handling itself
is contract-level from opentui (mouse reporting enabled by default,
mouse-down events bubble to slot renderables) — the pty test above
exercises the full path; the `/load-lock` command works regardless.
Plugins configured in `opencode.json` that expose `./tui` are loaded
automatically by the CLI, so the published package needs no extra config.
For local development against a checkout, opencode also auto-discovers
plugins laid out like a package under `<project>/.opencode/plugins/<name>/`
(`index.ts` re-exporting the main plugin, `tui.ts` re-exporting
`./dist/adapters/opencode/tui.js`).

### Notes for other harnesses

`load-lock dashboard` is the dashboard for every harness (it only needs
the daemon, which every integration spawns). Harnesses without an in-app
UI surface get exactly that — no parity claims; see `docs/COMPATIBILITY.md`.

## Diagnostics & recovery

```sh
load-lock help             # one-screen usage of every command
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

## Containers / WSL2

### Docker — verified

Verified 2026-10-16 with Docker Engine 29.1.3 on Linux (amd64) and
`node:24-bookworm-slim`, running load-lock 0.1.2 installed from the packed
tarball (`npm pack`, then `npm install -g --omit=dev <tgz>` inside the
container). Two runs, both in containers started with `--cpus=1.5
--memory=2g`:

- a sanity-check container (`load-lock doctor`, `load-lock inspect`,
  auto-spawn proof, `attach-pid` round trip), and
- the full `demo/demo.sh` (which needs bash + git + node; the slim image
  needs `apt-get install -y git` first).

**Cgroup v2 quota detection.** `load-lock inspect` inside the constrained
container reported the *container* limits, not the host's:

```json
"cpu": { "logicalCores": 2, "cgroupVersion": "v2", "cgroupCpuQuota": 150000,
         "cgroupCpuPeriod": 100000, "effectiveCores": 1 },
"memory": { "totalBytes": 8195100672, "cgroupMemoryLimitBytes": 2147483648,
            "effectiveLimitBytes": 2147483648 }
```

`/sys/fs/cgroup/cpu.max` reads `150000 100000` inside the container; the 2
logical cores are still visible (`os.cpus()`/`nproc` are not namespaced),
but `effectiveCores` is 1 (floor of the 1.5-CPU quota) and
`effectiveLimitBytes` is exactly the 2 GiB `--memory=2g` limit while
`totalBytes` shows the ~8 GiB host view. Pressure and the inspect
suggestion therefore scale to the container, not the host — exactly the
"don't assume the host's cores" behavior the inspect output promises.

**Auto-spawn + default state dir.** With no `LOAD_LOCK_*` environment
variables set, the first CLI call auto-spawned the daemon on the
container-default `~/.local/state/load-lock` (state dir contained
`daemon.json`, `daemon.sock`, `journal.json`; `service status` reported
`pid 35, protocol v1, config version 1`). No special env or volumes
needed.

**Process tracking.** `/proc`-based tracking works unchanged in the
container: `attach-pid` recorded the target with its
`/proc/<pid>/stat` start time (`pidStartTime`), `recover list` reported
`tracked process (pid 3367) is running`, and after the process was killed
the daemon's 5s sweep auto-released the permit (`pool "heavy": 0/1 in
use`). `run_with_permit` and journal reconciliation use the same mechanism.

**demo.sh.** The scripted three-agent demo ran to completion (exit 0)
inside the same plain node:24 container. Its inventory line reflected
container limits — `cpu: 2 logical / 1 effective (v2)`, `memory: 7.6 GiB
total / 2.0 GiB effective limit` — and the full flow played out: A
granted, B and C queued, strict FIFO hand-off, C's offer expired →
`paused` (not recycled), explicit `rejoin` → claim → run → release; 21
durable events.

Limitations observed (all inherent to containers, not load-lock bugs):

- `/proc/loadavg` and CPU inventory are not namespaced: `loadPerEffectiveCore`
  reflects host load, so a quiet container on a busy host can still show
  "high" load pressure, and `nproc` shows the host CPU set. The cgroup quota
  (`effectiveCores`) is the honest number to reason with.
- State dir is per-container: with `docker run --rm` the daemon, config
  history and journal vanish with the container; the next use just
  respawns with defaults (fine for ephemeral CI containers; volume-mount
  `~/.local/state/load-lock` if you want persistence).

The setup above gives the container its *own* daemon. To make a container
a thin client of the **host's** daemon instead (bridged socket +
`LOAD_LOCK_NO_SPAWN`), see the [Sandboxes](#sandboxes) section below.

Reproduce from a checkout (needs `dist/` built; tarball from `npm pack`):

```sh
npm ci && npm run build && npm pack --pack-destination /tmp
docker run --rm --cpus=1.5 --memory=2g \
  -v "$PWD":/src:ro -v /tmp:/pkg:ro \
  node:24 bash -c '
    cp -a /src /work && cd /work
    apt-get update -qq && apt-get install -y -qq git
    npm install -g --omit=dev /pkg/aron98-load-lock-<version>.tgz
    load-lock doctor && load-lock inspect
    bash demo/demo.sh'
```

### WSL2 — procedure (NOT verified here)

**No WSL2 environment was available on the verification machine** (the
Docker results above were produced on a plain Linux VM). Nothing in this
subsection has been executed by us; it is a ready-to-run procedure with
*expected* outcomes, to be verified and recorded by someone with a WSL2
setup.

1. Use a WSL2 distro with Node 20+ (e.g. Ubuntu 24.04). Check the cgroup
   layout inside the distro:

   ```sh
   stat -fc %T /sys/fs/cgroup      # expect cgroup2fs (cgroup v2)
   cat /sys/fs/cgroup/cpu.max /sys/fs/cgroup/memory.max
   ```

2. Run load-lock on the distro itself (not in Docker):

   ```sh
   load-lock doctor && load-lock inspect
   ```

   Expected: WSL2 presents a full VM, so `inspect` reports the *WSL VM's*
   resources, not the Windows host's. `.wslconfig` caps (`memory=`,
   `processors=`) are enforced by the VM itself (vCPU count / VM RAM), not
   via cgroup quotas — so `cgroupVersion` should read `v2` on a
   systemd-enabled distro, `cgroupCpuQuota` typically `null` (`max`), and
   `effectiveCores` = the `.wslconfig` `processors=` value with
   `memory.totalBytes`/`effectiveLimitBytes` ≈ the `memory=` cap. If the
   distro runs without systemd the cgroup controllers may not be mounted;
   expect `cgroupVersion` to degrade to `none` and the raw VM numbers to be
   reported — either way, no host overstating.

3. With Docker inside WSL2 (docker-ce in the distro, or Docker Desktop's
   WSL2 backend), re-run the constrained-container check from the verified
   Docker procedure above. Expected: containers get their own nested
   cgroup, so `inspect` should report the container quota exactly as in the
   verified results above, regardless of the extra nesting level.

4. Run `demo/demo.sh` in the distro (needs bash, git, node) and in a plain
   `node:24` container under WSL2's Docker.

Caveats to watch for (unverified expectations):

- Nested cgroups (Docker Desktop's WSL2 backend adds a level) must not mask
  the container's own `cpu.max`/`memory.max` — that's what `inspect` reads.
- `/proc/loadavg` reflects the WSL VM, not Windows.
- Keep the state dir on the Linux filesystem (`~/.local/state/load-lock`),
  not on `/mnt/c` (drvfs/9p is slow and lock semantics differ).

## Sandboxes

Sandboxed agents (bubblewrap/omac, Docker, macOS seatbelt, WSL2) face one
core problem: the budget belongs on the *host*, but a sandbox that cannot
see the host's daemon will happily auto-spawn its own useless local daemon
and fragment the budget. The recipes below all use the same two mechanisms:

1. **Bridge the host daemon's socket into the sandbox.** The daemon listens
   on an AF_UNIX *path* socket. Path sockets are scoped by the **mount**
   namespace, not the network namespace — so a bind mount of the state dir
   survives `--unshare-net` (bubblewrap), and only needs the right
   filesystem mapping/allow rules elsewhere. Point the sandboxed client at
   the bridged path with `LOAD_LOCK_SOCKET`.
2. **Run the client in client-only mode** so it can never auto-spawn a
   daemon inside the sandbox (see below).

A third mechanism matters once the client is inside a PID namespace:
**lease-mode (untracked) permits**, because the host daemon cannot
`kill(pid, 0)` a sandbox pid it cannot see (lifecycle below).

### Client-only mode: `LOAD_LOCK_NO_SPAWN`

Set `LOAD_LOCK_NO_SPAWN=1` (any non-empty value except `0`) and the shared
client will never spawn a daemon, no matter which adapter asks:
`ensureDaemon` refuses before creating anything, and `connect` fails loudly
instead of falling back to a spawn. The error is actionable and points
here:

```
load-lock: load-lock daemon is not reachable at /run/load-lock/daemon.sock
and auto-spawn is disabled (LOAD_LOCK_NO_SPAWN is set): this client is
client-only and started no daemon. Run the daemon on the host machine
(e.g. load-lock service start) and bridge its socket into this sandbox,
then point LOAD_LOCK_SOCKET at the bridged path — see the "Sandboxes"
section of docs/OPERATIONS.md for per-sandbox recipes (bubblewrap/omac,
Docker, seatbelt, WSL2). To allow spawning a daemon here instead, unset
LOAD_LOCK_NO_SPAWN. (code: unavailable)
```

The CLI exits with code 70 for this failure (unavailable transport). Use
this mode inside every sandbox: it turns "mysteriously isolated budget"
into a loud, documented failure, and it is what the tests in
`src/test/sandbox.test.ts` enforce (no state dir is ever created, and the
error names the docs).

### Label prefixes: identifying sandboxed holders

Sandboxed clients can prefix their holder labels so the dashboard shows
*where* a permit came from, e.g. `omac:issue-42 build`. Three equivalent
entry points, all composing `prefix:label` (or `prefix:<agentId>` when no
label was given) daemon-side:

- `LOAD_LOCK_LABEL_PREFIX` env var — the shared client injects it into
  every `acquire` request (including CLI, MCP, plugin and hook paths)
  unless a request already carries an explicit prefix. This is the natural
  place for a sandbox wrapper (omac profile, Docker `-e`, bwrap
  `--setenv`) to tag everything an agent does inside it.
- CLI: `--label-prefix` on `acquire` and `run`.
- MCP: the `label_prefix` input on the `acquire` tool; the RPC field is
  `labelPrefix` (see `docs/ADAPTERS.md`).

A present-but-empty prefix is rejected (`labelPrefix must be a non-empty
string`); prefixes are trimmed.

### Cross-PID-namespace permits: the lease-mode lifecycle

With `--unshare-pid` (bubblewrap) or default Docker containers, the host
daemon cannot see the sandboxed client's pid — verified live below: inside
the sandbox `kill -0 <host-daemon-pid>` fails with "No such process" while
the daemon is plainly running. That makes **tracked** permits
(`start_job` / `attach_pid`, liveness via `kill(pid, 0)` +
`/proc/<pid>/stat`) meaningless across PID namespaces. Worse, calling
`attach_pid` from *inside* the sandbox passes a pid that is invisible or
reused on the host; the daemon's liveness check fails immediately and the
permit is auto-released. Only use tracked mode when the host sees the same
pid you do (host-run jobs, or containers started with `--pid=host`).

**Lease mode** is the cross-namespace lifecycle:

1. `acquire` → permit granted (holder label visible in the dashboard).
2. `mark_started` → permit moves to `running_untracked` with a lease
   deadline of `now + untrackedLeaseMs` (default 15 minutes,
   configurable — see Configuration). No host-side pid is recorded.
3. **Heartbeats renew the lease.** Heartbeat sources: an MCP server
   process heartbeats every 30s for its own agent (`agent_id` /
   `defaultAgentId`); the OpenCode plugin heartbeats every 30s per known
   session. The CLI has **no** automatic heartbeat — for a CLI-held
   untracked permit the lease is a hard ceiling, so finish within
   `untrackedLeaseMs` or release promptly.
4. `release` → capacity freed immediately, whatever remains on the lease.
5. **Lease expiry:** if no heartbeat arrives before the deadline, the
   daemon reclaims the permit and admits queued waiters, journaling
   `untracked lease expired: no heartbeat from the owning agent`. After a
   daemon restart, `restore` grants surviving untracked permits a *fresh*
   lease window from restore time.

The same trap catches `load-lock run` / `run_with_permit`: those helpers
use *tracked* mode (`start_job` with the spawned job's pid). Run from
inside a PID-namespace sandbox, the pid is invisible to the host daemon,
whose liveness sweep then auto-releases the permit while the job is still
running. Inside sandboxes the recipe is therefore always:
`acquire` → `mark_started` (+ heartbeats where the harness provides them)
→ explicit `release` — never `run`, `attach-pid`, or `start-job` from the
sandboxed side. Save `run` for host-side invocations where the daemon sees
the job's pid.

Tradeoff (deliberate, and the `recover list` output says so): an untracked
permit whose owner is alive but silent is reclaimed after the lease, so
overlap with an unobserved survivor is possible — e.g. two builds may run
concurrently for up to `untrackedLeaseMs` after a sandbox stopped
heartbeating. That is the price of not being able to see pids across
namespaces; keep heartbeating (or release promptly) and size
`untrackedLeaseMs` accordingly.

### bubblewrap — live-verified

Verified 2026-10-20 with bubblewrap 0.6.1 on Linux 6.8.0-138-generic,
Node v22.23.2, load-lock 1.1.0 working tree (issue-29 branch). The daemon
ran on the *host* in an isolated state dir; every client call below ran
inside `bwrap --unshare-net --unshare-pid` and reached the **host** daemon.

1. Start the daemon on the host, in a state dir you will bind into the
   sandbox (here a temp dir; for real use `~/.local/state/load-lock`):

   ```sh
   LOAD_LOCK_STATE_DIR=/tmp/ll-bwrap-29 node dist/cli/main.js service start
   # load-lock: daemon running on pid 2259769 (default socket)
   ```

   The socket appears at `/tmp/ll-bwrap-29/daemon.sock` with mode
   `srwxrwxr-x` (775): connecting needs *write* on the socket inode, so a
   sandbox running as the same user (or group) can talk to it.

2. Run the CLI inside the sandbox, binding the state dir and pointing
   `LOAD_LOCK_SOCKET` at it. Bind the **state dir**, not the socket file —
   the socket inode is replaced when the daemon restarts, so a file-only
   bind goes stale, while the dir bind follows the new socket
   automatically. Binding to an existing path keeps this simple (see
   caveats):

   ```sh
   bwrap --dev-bind / / --unshare-net --unshare-pid --proc /proc \
     --bind /tmp/ll-bwrap-29 /tmp/ll-bwrap-29 \
     --setenv LOAD_LOCK_SOCKET /tmp/ll-bwrap-29/daemon.sock \
     --setenv LOAD_LOCK_NO_SPAWN 1 \
     --setenv LOAD_LOCK_LABEL_PREFIX bwrap \
     node dist/cli/main.js status --json
   ```

   Observed: `status --json` answered by the *host* daemon — same pid as
   the host's `service status` (`2259769`, protocol v1, heavy pool
   capacity 1, `untrackedLeaseMs` 900000). `--unshare-net` does not
   interfere: the path socket is reached through the mount namespace.

3. PID-namespace proof: inside the same sandbox,
   `kill -0 2259769` → `No such process` — the host daemon pid is
   invisible to the sandbox, confirming the client crossed namespaces via
   the filesystem, and that lease mode (not tracked mode) is required for
   long holds (below).

4. Full permit round trip from inside the sandbox:

   ```sh
   # acquire (env LOAD_LOCK_LABEL_PREFIX=bwrap was set by bwrap):
   node dist/cli/main.js acquire --op-key bwrap-check \
     --reason "issue-29 live verification build" --label "issue-29 build"
   # → permit prm_… ; entry.agentLabel = "bwrap:issue-29 build"

   node dist/cli/main.js mark-started --permit prm_…
   # → running_untracked (lease 900s)

   node dist/cli/main.js release --permit prm_…
   # → host pool "heavy": 0/1
   ```

   Host-side `status` while the permit was held:

   ```
   pool "heavy": 1/1 in use
   held: bwrap:issue-29 build — issue-29 live verification build (5s) [untracked, leased]
   ```

   and `recover list` reported `[running_untracked] bwrap:issue-29 build`
   with `heartbeat lease 895s remaining — reclaimed when the owning agent
   stops heartbeating (overlap with an unobserved survivor is possible;
   see docs)`. Five durable events on the host journal: `daemon_started`,
   `daemon_recovered`, `granted bwrap:issue-29 build`, `started`,
   `released`.

Caveats observed (verified):

- `bwrap` creates missing bind destinations by mkdir-ing them, so
  `--bind <state-dir> /run/load-lock` failed here with
  `bwrap: Can't mkdir /run/load-lock: Permission denied` (`/run` is
  root-owned). Either bind at an existing path (as above), pre-create the
  destination, or pick a parent you can write to.
- Client-only mode matters: with `LOAD_LOCK_NO_SPAWN=1` unset, a sandbox
  whose bind/env was misconfigured would silently spawn its own daemon
  inside the sandbox and split the budget. The tests in
  `src/test/sandbox.test.ts` pin the loud failure instead.

### omac — live-verified

Verified 2026-10-20 against **omac 0.11.0** (extracted package binary, no
root needed) on Linux, driving the load-lock CLI from the v1.2.0 worktree
build end-to-end from inside `omac sandbox run`. omac wraps bubblewrap +
Landlock on Linux (seatbelt on macOS with the same env-stripping) and
**strips the harness environment**, allowing through only variables
listed in the user-global sandbox profile —
`~/.config/omac/sandbox-profiles/default.json`. The profile is the whole
recipe, and `load-lock install --harness omac` writes it for you
(merge-only; idempotent; `load-lock uninstall --harness omac` removes
exactly the entries it added):

```json
{
  "filesystem": {
    "allow_unix_dir": ["<load-lock state dir>"],
    "read": ["<installed package tree>"]
  },
  "environment": { "allow_vars": ["LOAD_LOCK_*"] }
}
```

- `filesystem.allow_unix_dir` += the state dir: AF_UNIX connect to the
  host daemon socket plus read/write on the state dir — this is the
  sandbox→host bridge (omac has no separate "bind" step; the grant is the
  bridge).
- `environment.allow_vars` += `"LOAD_LOCK_*"` — one trailing-`*` prefix
  entry (verified: omac 0.11.0 accepts prefix patterns) covering all four
  client vars (`LOAD_LOCK_SOCKET`, `LOAD_LOCK_STATE_DIR`,
  `LOAD_LOCK_NO_SPAWN`, `LOAD_LOCK_LABEL_PREFIX`).
- `filesystem.read` += the installed package tree — **only when
  load-lock lives outside an already-granted workdir** (see gotcha 1).

The exact procedure that was verified (run it with a throwaway `HOME`
unless you want the grants in your real profile):

```sh
# 0. scratch dirs + a current daemon built from the v1.2.0+ tree.
#    GOTCHA 2: the machine's real daemon was still v1.1.0 — a daemon
#    started before v1.2.0 silently strips the unknown labelPrefix field
#    (zod), so prefixed labels disappear without any error. Upgrade and
#    restart: load-lock service stop && load-lock service start (at
#    verification time there was no `service restart` subcommand; it exists
#    since issue #38 and is the shorter spelling today). This verification
#    deliberately used its own daemon on a temp state dir.
LOAD_LOCK_STATE_DIR=/tmp/ll-32-test node dist/cli/main.js service start

# 1. install the grants (merge-only; prints exactly what it merged)
HOME=/tmp/ll-32-home LOAD_LOCK_STATE_DIR=/tmp/ll-32-test \
  node dist/cli/main.js install --harness omac

# 2. omac's strict parser accepts the profile (unknown fields are errors)
HOME=/tmp/ll-32-home omac sandbox run -- true    # exit 0, no ERROR lines

# 3. sandboxed client -> host daemon round-trip.
#    NOTE: standalone `omac sandbox run` starts at cwd "/" and grants NO
#    workdir by default — `--workdir-access read` binds the invocation
#    dir read-only, modeling what a real omac agent session gets for its
#    project workdir (which is why a repo checkout needs no read grant).
#    The env values are set inside the sandboxed command with `env`
#    (`-- env VAR=... node ...`); with the LOAD_LOCK_* allow_vars entry
#    in place they could equally be inherited from the outer shell.
HOME=/tmp/ll-32-home omac sandbox run --workdir-access read -- \
  env LOAD_LOCK_SOCKET=/tmp/ll-32-test/daemon.sock LOAD_LOCK_NO_SPAWN=1 \
      LOAD_LOCK_LABEL_PREFIX=omac \
  node dist/cli/main.js acquire --op-key issue-32-live \
    --reason "issue-32 live verification build" --label "issue-32 build" --json
# -> permit prm_…; host status shows:
#    held: omac:issue-32 build — issue-32 live verification build [claimed, awaiting start]

# 4. host-side release (or any later step from inside the sandbox):
node dist/cli/main.js release --permit prm_…   # -> releasedNow: true
```

Also verified live:

- **`LOAD_LOCK_NO_SPAWN=1` error contract**: with the client pointed at a
  missing socket inside the sandbox, the CLI exits **70** with the loud
  "not reachable and auto-spawn is disabled … bridge its socket into this
  sandbox" error instead of silently spawning a sandbox-local daemon.
- **Lease-mode lifecycle across the PID namespace** (same as the
  bubblewrap case): `acquire` → `mark-started` (held, lease 900s) →
  `release` (`releasedNow: true`), all issued from inside the sandbox;
  long holds need lease mode because the host daemon pid is invisible to
  the sandbox.
- **Install/uninstall round-trips against the real omac**: a populated
  user profile (workdir/network/environment entries) survives install
  byte-faithfully with our grants appended, omac's strict parser accepts
  the merged file, and uninstall leaves the user entries intact; a
  from-scratch profile is removed entirely on uninstall (with the omac
  config tree pruned) and omac keeps running on its defaults.

The two gotchas that shaped the installer:

1. **A global install needs a read grant for the package tree, not just
   the bin dir.** omac's builtin grants cover `~/.bun/bin`, but the
   launcher resolves the dist tree under
   `~/.bun/install/global/node_modules/@aron98/load-lock/dist/…` —
   ungranted, the CLI dies with `Cannot find module …` (exit 1) before
   ever reaching the socket. Proven live both ways: the sandboxed CLI
   from a global-style tree failed with exactly that error before the
   grant, and completed the full acquire→mark-started→release round-trip
   after `filesystem.read` covered the tree. A repo checkout needs no
   read grant (the agent session's workdir already covers it) and the
   installer says so honestly in its output.
2. **Label prefixes need a current daemon on the host.** A daemon
   started before v1.2.0 strips the unknown `labelPrefix` field silently
   (zod); the dashboard shows the bare label with no error anywhere.
   `load-lock service restart` after upgrading.

What was NOT verified: omac's macOS seatbelt path (same profile schema,
per omac's docs, but the verification machine is Linux) and omac's agent
orchestration commands (`omac start`/`continue`/…) driving a real agent —
the round-trip was verified with the documented `omac sandbox run`
primitive those commands build on. The installer's contract tests cover
the merge/uninstall edge cases (`src/test/install.test.ts`).

### Docker — contract-inspected

Docker *was* verified for in-container daemons (see the verified Docker
subsection above). What was **not** verified here is the thin-client shape
below: the verification machine has a `docker` binary but the verifying
user cannot reach `/var/run/docker.sock`, so this recipe is
contract-inspected — ready to run, expected outcomes marked, not executed
by us.

1. Run the daemon on the host (normal install, default state dir).
2. Run the container as a thin client of the *host* daemon:

   ```sh
   docker run --rm -it \
     -v ~/.local/state/load-lock:/run/load-lock \
     -e LOAD_LOCK_SOCKET=/run/load-lock/daemon.sock \
     -e LOAD_LOCK_NO_SPAWN=1 \
     -e LOAD_LOCK_LABEL_PREFIX=docker \
     node:24 bash
   # inside: npm install -g <load-lock tarball> && load-lock status
   ```

   Expected: `load-lock status` reports the *host* daemon's pid and pool
   counts, and holders created inside the container appear on the host
   dashboard as `docker:<label>`.

Notes and caveats (unverified expectations):

- Bind the **state dir**, not the socket file (the socket inode is
  replaced on daemon restart; the dir bind follows it — same reasoning as
  bubblewrap above).
- Connecting to the socket needs *write* on the socket inode (mode `775`,
  user/group). Container root gets this via `CAP_DAC_OVERRIDE` when no user
  namespace remapping is in play; for non-root containers run with
  `--user "$(id -u):$(id -g)"` and rely on the group permission, or relax
  the socket mode/group to match your setup.
- Container pids are not host pids, so — exactly as in the bubblewrap
  case — use `mark_started` + heartbeat lease mode for long holds, never
  `attach_pid`/`start_job` from inside, unless the container runs with
  `--pid=host`.
- The verified caveats from the Docker subsection above still apply from
  the client's point of view (`/proc/loadavg` and `nproc` reflect the
  host; the container's own cgroup quota is what `inspect` reports).

### macOS seatbelt — contract-inspected

**No macOS machine was available** for this verification, so this is
contract-inspected against the `sandbox-exec(5)`/seatbelt documentation,
not executed here.

On macOS the daemon listens on a Unix domain socket at
`~/.local/state/load-lock/daemon.sock`, and connecting to a UDS is
mediated by seatbelt as a *file* operation, not a network one — so a
profile needs read and write access to the socket path, e.g.:

```lisp
(allow file-read-data
  (literal "/Users/you/.local/state/load-lock/daemon.sock"))
(allow file-write*
  (literal "/Users/you/.local/state/load-lock/daemon.sock"))
```

(no `network-outbound` rules required for the path-socket transport;
`allow network*` forms are not the mechanism a UDS connect goes through
under seatbelt). Since the socket inode is recreated when the daemon
restarts, allow the containing directory too if your profile is
path-literal strict, or re-generate the profile. Expected outcome
(unverified): with those file rules plus the env vars
(`LOAD_LOCK_SOCKET`, `LOAD_LOCK_NO_SPAWN=1`,
`LOAD_LOCK_LABEL_PREFIX=…`) passed through to the agent, a seatbelt-sandboxed
client talks to the host daemon exactly as in the verified bubblewrap
case. omac's macOS sandboxing uses seatbelt under the hood with the same
`environment.allow_vars` env-stripping as on Linux, so the omac installer
(`load-lock install --harness omac`, live-verified on Linux against omac
0.11.0 — see above) applies unchanged; only the socket path and the
seatbelt file rules differ.

### WSL2 — honest state

There is no verified cross-boundary story for WSL2, and we won't pretend
otherwise:

- The Windows transport is a named pipe (`\\.\pipe\load-lock`); named
  pipes are not reachable from inside a WSL2 distro. A WSL-side Unix
  socket is likewise not reachable from Windows-native processes.
- There is deliberately no TCP transport (a non-goal), so there is no
  loopback bridge to fake one.

The realistic shape: **the WSL2 Linux VM is the host.** Run the daemon
inside the distro (`~/.local/state/load-lock`, normal install — see the
WSL2 procedure subsection above for the unverified-but-expected resource
reporting), and treat Windows-native agents as out of scope for now.
Cross-distro bridging (two distros sharing one daemon via a `/mnt/wsl`
shared directory bind-mounted as the state dir) is an *unverified
expectation*: `/mnt/wsl` is shared across distros, so the same
bind-the-state-dir recipe should apply, but nobody has run it — verify
and record before relying on it. Keep the state dir on the Linux
filesystem, not `/mnt/c` (drvfs/9p is slow and lock semantics differ, as
in the WSL2 caveats above).

## macOS / Windows notes

- macOS: no cgroup limits; process-liveness checks fall back from
  `/proc/<pid>/stat` start times to `kill(pid, 0)` (weaker PID-reuse
  defense — document and prefer `run_with_permit`). Everything else works.

### Windows — procedure (NOT verified here)

**No Windows environment was available on the verification machine** (all
development and testing happened on Linux). The transport adapter is
implemented in `src/shared/transport.ts` and its logic is covered by
`src/test/platform.test.ts` (endpoint resolution, pipe naming, probe,
stale-cleanup, liveness, and job-tree kill paths, exercised via platform
injection on Linux) — but nothing in this subsection has been executed on
Windows. It is a ready-to-run procedure with *expected* outcomes, to be
verified and recorded by someone with a Windows setup.

What the adapter does:

- Transport: clients and the daemon talk over the named pipe
  `\\.\pipe\load-lock` (Node's `net` module accepts pipe paths in
  `connect`/`createServer` natively). No Unix-domain socket is involved.
- State dir: `%LOCALAPPDATA%\load-lock` (falls back to
  `%USERPROFILE%\AppData\Local\load-lock`); `LOAD_LOCK_STATE_DIR` and
  `LOAD_LOCK_SOCKET` overrides still win, as on POSIX.
- Daemon claim: a second daemon probes the pipe before listening and
  exits with "denied" if a live daemon answers (same semantics as the
  POSIX socket claim). Because a named pipe is a kernel object, there is
  no stale-socket file to clean up.

1. Install Node 20+ on Windows and install the package:

   ```powershell
   npm install -g @aron98/load-lock
   load-lock install --harness <harness>
   load-lock doctor
   ```

   Expected: `doctor` reports the `%LOCALAPPDATA%\load-lock` state dir and
   reaches the daemon over the pipe (it probes by connecting, since a pipe
   is not a filesystem entry).

2. Run two `load-lock acquire` in separate shells, then `load-lock dashboard --once`.

   Expected: the same queue/permit behavior as on Linux — the pipe carries
   the identical NDJSON protocol.

3. Start a permit-tracked job (`run_with_permit` / `load-lock run`), kill
   the job, and confirm the permit auto-releases via the sweep.

4. Run `load-lock service stop`, then any tool call.

   Expected: the daemon exits and the next client auto-spawns a fresh one.

Caveats to watch for (unverified expectations):

- **No PID-reuse defense.** Windows has no `/proc`-style start time, so
  `isProcessAlive` can only use `kill(pid, 0)` semantics. A recycled PID
  could be mistaken for the original job — the same limitation as macOS,
  documented here rather than solved.
- **No process-group scan.** The `/proc`-based process-group scan does not
  exist on Windows. Tracked permits release when the main PID dies even if
  child processes survive; job stop/kill uses `taskkill /PID <pid> /T`
  (`/F` for SIGKILL) to take down the tree.
- **Pipe name is machine-wide.** Unlike POSIX, where each user gets their
  own state dir and socket, a named pipe named `\\.\pipe\load-lock` is
  machine-global — two Windows users on one host share one daemon. Point
  `LOAD_LOCK_SOCKET` at a different pipe name if that is a problem.
- `inspect_machine` cgroup detection reads `/sys/fs/cgroup` and will
  degrade gracefully (`cgroupVersion: "none"`), reporting raw host numbers.

## Releasing (maintainers)

Publishing is automated: publishing a GitHub Release runs
`.github/workflows/publish.yml` (npm Trusted Publishing; read its comments
before changing the flow). The release commit itself is manual:

1. Bump `version` in `package.json` (and `package-lock.json`), e.g.
   `npm version 1.6.0 --no-git-tag-version`.
2. Sync every pinned `@aron98/load-lock@<version>` to it:
   `npm run check-pins -- --write` (alias for
   `node scripts/check-pins.mjs --write`), then `npm run check-pins` must
   print `pins ok`. Commit the bump and the pin updates together.
3. Merge, then publish a GitHub Release tagged `v<version>`.

Pinned files (the skill's npx fallback, ACE `ace/mcp/mcp.json`, the Claude Code
plugin's `plugin.json` and launcher, once they exist) are declared in the
`PINNED` list at the top of `scripts/check-pins.mjs`; add an entry whenever
a new artifact pins a version. CI (`pins` job in `ci.yml`) fails on any
pin that differs from `package.json`, on a declared file that is missing,
and on a declared file that no longer contains a pin.
