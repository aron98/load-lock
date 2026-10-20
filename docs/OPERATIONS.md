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
turn-wait cap (`maxTurnWaitMs`, bounds `wait_for_turn`/`load-lock wait`) 10min ·
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

### omac — contract-inspected

**omac is not installed on the verification machine**, so nothing in this
subsection was executed here; it is assembled from omac's documented
behavior (the facts below are from omac's docs, not invented) and the
bubblewrap recipe above, which omac wraps on Linux. Treat it as a
ready-to-run procedure with expected outcomes, and record what you find.

omac sandboxes agents with bubblewrap on Linux (seatbelt on macOS, WSL2
elsewhere) and **strips the harness environment** before starting the
agent, allowing through only variables listed in the sandbox profile's
`environment.allow_vars` — `~/.config/omac/sandbox-profiles/default.json`
by default. That file is the whole recipe:

1. Make sure the load-lock state dir is visible inside omac's bubblewrap
   sandbox (the `LOAD_LOCK_SOCKET` path must resolve inside it). How
   omac's sandbox mounts map to bwrap `--bind`s is an omac sandbox-config
   question — omac's own facade socket under `~/.local/state/omac/run/`
   is the project's precedent for a sandbox process connecting to a
   host-owned socket through its profile.
2. Add the load-lock variables to the profile's `environment.allow_vars`:

   ```json
   {
     "environment": {
       "allow_vars": [
         "LOAD_LOCK_SOCKET",
         "LOAD_LOCK_STATE_DIR",
         "LOAD_LOCK_NO_SPAWN",
         "LOAD_LOCK_LABEL_PREFIX"
       ]
     }
   }
   ```

   Set the values themselves in your harness env (or the profile's env
   mechanism): `LOAD_LOCK_SOCKET` to the host daemon socket as seen inside
   the sandbox, `LOAD_LOCK_NO_SPAWN=1`, and — recommended —
   `LOAD_LOCK_LABEL_PREFIX=omac` so the dashboard shows holders as
   `omac:<label>`.
3. Watch out: **omac never rewrites a profile it has created**, so if your
   `default.json` already exists, edit it by hand (adding the entries
   above); and **unknown profile fields are errors**, so don't invent
   other keys — `allow_vars` entries are plain variable names.

Expected outcome (unverified here): with those four variables allowed and
the state dir mounted, an agent inside omac behaves exactly like the
verified bubblewrap case above — host daemon answers, labels carry the
`omac:` prefix, and long holds need `mark_started` + heartbeats (lease
mode) because of the PID namespace.

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
`environment.allow_vars` env-stripping as on Linux, so the omac recipe
above (profile `allow_vars` + bridged socket path) applies unchanged.

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
