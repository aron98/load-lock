# Harness compatibility matrix

load-lock separates **core capability** (daemon + protocol + CLI, fully
harness-agnostic) from **per-harness integration** (tools, policy
instruction injection, compaction restore, idle wakeup, lifecycle help).
Status labels mean exactly this:

- **Implemented + live-verified** — deployed on this machine and exercised
  end-to-end against the real harness.
- **Implemented + contract-tested** — adapter shipped; behavior tested
  against the harness's documented hook/tool JSON contracts
  (`src/test/hook.test.ts`, `src/test/mcp.test.ts`), but the harness itself
  was not installed during verification.
- **Implemented + config-tested** — installer shipped; install/uninstall
  round-trip tested against a temp HOME and validated against the harness's
  documented config schemas (`src/test/install.test.ts`), but the harness
  itself was not installed during verification.
- **Proposed / fallback** — research-verified harness capabilities only; no
  adapter shipped beyond the generic MCP path.

## Core (all harnesses)

| Capability | Status |
| --- | --- |
| Machine-wide pool, atomic acquire, FIFO offers, claim tokens, expiry → paused → rejoin | Implemented + tested (`core.test` 14, `daemon.test` 8) |
| Idempotent acquire/release, duplicate suppression, weighted head-block | Implemented + tested |
| Automatic cleanup: start deadline, tracked pgid process death, untracked lease, heartbeats, PID-reuse defense | Implemented + tested with real processes |
| Daemon restart: journal reconciliation, idempotent late release, ephemeral queues | Implemented + tested |
| Config via tools, CAS versions, persisted history with author+reason | Implemented + tested |
| Resource inspection incl. cgroup v2/v1 CPU+memory limits and pressure | Implemented + tested |
| CLI: acquire/claim/release/run/wait/status/configure/doctor/recover/install | Implemented + tested + demoed |

## Per-harness integration

| Harness | MCP tools | Policy injection | Compaction restore | Idle wakeup | Async push into context | Cleanup fidelity | Overall |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **OpenCode** (v2) | Native plugin, `load_lock_*` (better than MCP) | Context hook every model call | Yes (hook re-fires per model call) | Yes — `session.synthetic` at execution boundary (live-verified; never interrupts in-flight shell) | Yes (live-verified) | Full: `run_with_permit` tracked jobs + session heartbeats | **Implemented + live-verified** |
| **Claude Code** | MCP `mcp__load-lock__*` (user scope) — live-verified round-trip | `SessionStart` hook plain-stdout context (live-verified: model quoted the brief verbatim) | Yes (SessionStart matcher `compact`) — live-verified after `/compact` | Yes — `Stop` hook decision-block + async `await-offer` (`asyncRewake`), both live-verified | Yes, via asyncRewake (live-verified; the wake text itself is not rendered by the TTY, but the wake drives the full claim lifecycle) | Full via MCP `run_with_permit` + server heartbeats (live-verified incl. a job outliving the claude process) | **Implemented + live-verified** |
| **Codex CLI** | MCP `mcp__load-lock__*` (config.toml) | `SessionStart` + `SubagentStart` additionalContext; `~/.codex/AGENTS.md` | Yes (SessionStart matcher `compact`) | Yes — `Stop` hook `decision:"block"` continuation | Partial: async background hooks do NOT start a new turn (documented limitation); stop-hook covers turn boundaries | Full via MCP `run_with_permit` + server heartbeats | **Implemented + live-verified** (interactive TUI in Docker; exec-mode MCP blocked upstream — see Tier 2 notes) |
| **Gemini CLI** | Yes (`settings.json` mcpServers, first-class installer) | `GEMINI.md` global (config `context.fileName`) | Via global GEMINI.md (always loaded) | No hooks — `wait_for_turn` bounded sleep is the primary idle mechanism | No | Via MCP `run_with_permit` only | **Implemented (fallback tier, config-tested)** |
| **GitHub Copilot CLI** | Yes (`~/.copilot/mcp-config.json`, merge-only installer; verify with `copilot mcp list`) | `~/.copilot/copilot-instructions.md` (marked section) | Via global instructions file | Hooks reported in ecosystem content but **not verified in official docs** — none installed; `wait_for_turn` bounded sleep is the primary idle mechanism | Unverified | Via MCP `run_with_permit` only | **Implemented (fallback tier, config-tested)** |
| **Cursor** | Yes (project `.cursor/mcp.json`, merge-only installer) | `.cursor/rules/load-lock.mdc` (dedicated Always-apply rule file) | Rules re-apply (Always) | Yes — `stop` hook `{"followup_message":...}` continuation (hooks v1, officially documented) | No async watcher shipped; stop hook covers turn boundaries | Via MCP `run_with_permit` only | **Implemented + contract-tested** (hooks tier; not live-verified) |
| **Cline** | Yes (`cline_mcp_settings.json`, merge-only installer) | `~/.cline/rules/load-lock.md` (dedicated rule file) | Rules always loaded | No hooks — `wait_for_turn` bounded sleep is the primary idle mechanism | No | Via MCP `run_with_permit` only | **Implemented (fallback tier, config-tested)** |
| **Roo Code** | Yes (project `.roo/mcp.json` + existing global `mcp_settings.json`, merge-only installer) | `~/.roo/rules/load-lock.md` (dedicated rule file) | Rules always loaded | No hooks — `wait_for_turn` bounded sleep is the primary idle mechanism | No | Via MCP `run_with_permit` only | **Implemented (fallback tier, config-tested)** |
| **Goose** | Yes (`~/.config/goose/config.yaml` `extensions` block, merge-only installer) | `.goosehints` (global, marked section) | Hints always loaded | No hooks — `wait_for_turn` bounded sleep is the primary idle mechanism | No | Via MCP `run_with_permit` only | **Implemented (fallback tier, config-tested)** |
| **Aider** | **No MCP support** | CONVENTIONS.md / `.aider.conf.yml` | Read each run | N/A | N/A | CLI-only: same-shell `load-lock acquire ... && cmd; load-lock release ...` (manual) | Proposed (manual CLI tier) |

## How each integration tier works

### Tier 1 — OpenCode (native plugin, live-verified)

Global plugin (`load-lock install --harness opencode`) registers:
- `load_lock_*` tools with session-bound agent identity and cwd,
- the policy brief injected into system context on **every** model call
  (survives compaction by construction),
- a `load-lock` skill with the full agent guide,
- daemon event watcher → `ctx.session.synthetic` offer messages with the
  real claim token, delivered at execution boundaries,
- per-session heartbeats,
- the package's `./tui` export: a **live lock-status dashboard panel**
  (issue #10) inside the opencode TUI — `/load-lock` opens the
  `load-lock.dashboard` session panel in-window (issue #24: side panel,
  not full-screen) with pools, holder cards, offer countdowns, queue,
  paused, event feed, `inspect_machine`; a clickable sidebar widget
  (`load-lock 0/3`, health-colored; `/load-lock` as the mouse-free
  fallback) and a home-footer `lock 1/1·Q2` indicator; and an `x` force-release flow
  gated behind an explicit select + confirm (the panel itself is read-only
  and never acquires a permit).

Verified live on opencode v2.0.29: plugin load, policy visible to the model,
tool round-trip (acquire → queued → wakeup → claim → release), execution-
boundary delivery without interrupting a running `sleep`, skill visible,
and graceful handling of a deliberately missed offer (paused → cancel).

### Tier 2 — Claude Code / Codex CLI (hooks + MCP, live-verified)

`load-lock install --harness claude-code|codex` configures the MCP server
(user scope) plus hooks:

- **SessionStart** → policy brief + machine summary as developer context
  (matchers include `compact` so it re-fires after auto-compaction).
- **SubagentStart** (Codex) → same for spawned subagents.
- **Stop** → if the daemon has an offer whose entry cwd matches the session
  cwd, the hook continues the session with a claim instruction (decision
  block). Honors `stop_hook_active` to avoid loops; silent otherwise.
- **await-offer** (Claude Code, `async: true, asyncRewake: true`) → watches
  daemon events; on a matching offer exits 2 with a message that wakes an
  idle Claude. The token is deliberately NOT in that message (stderr may be
  shown); the agent claims via `pending`/`claim`.

Contract tests cover all hook stdin/stdout shapes against the documented
harness contracts. Claude Code is additionally **live-verified** (in Docker,
via `docker/run-claude-verify.sh` against the real `claude` CLI): SessionStart
policy brief in context at startup; the same brief re-injected after
`/compact` (the model quoted the fresh "load-lock now:" line, not a stale
copy); the full MCP round-trip acquire → queued → offer → claim →
`run_with_permit` → auto-release; the `Stop` hook decision-block live (async
watcher disabled so the stop path was exercised directly); the async
`await-offer` (`asyncRewake`) watcher waking an idle interactive session,
which then claimed and released; a `Task`-tool subagent using the MCP tools
and seeing the policy; and a `run_with_permit` background job that
outlived the `claude` process and was auto-released. One nuance: the TUI does
not render the async watcher's stderr wake text — the wake still works (the
session resumes and the claim round-trip succeeds), only the message is not
shown.

Codex CLI (0.163.0) is live-verified end-to-end in Docker
(`docker/verify-codex.sh`, driven through a real pty TUI session via
`docker/codex-pty.py`): SessionStart policy injection visible to the model,
MCP `status`/`acquire`/`claim`/`release` round-trip, FIFO queueing behind a
competing CLI holder, and Stop-hook `decision:"block"` wakeup that continues
the session with the claim instruction. The verification drives the real
interactive hook-trust review (the "Hooks need review" dialog) once —
`--dangerously-bypass-hook-trust` is deliberately NOT used because it forces
codex embedded mode, which never injects MCP tools (real users trust the
hooks once via `/hooks`; the installer prints this). Note: async background
hooks do not wake an idle Codex session — the Stop hook covers turn
boundaries only (verified as such).

Two upstream/provider constraints shaped the harness:

- Headless `codex exec` cannot inject MCP tools at all
  (openai/codex#38689), so live verification drives the interactive TUI
  through a pty.
- codex 0.163.0 declares MCP tools to the Responses API using the
  `namespace` tool type; the trustedtokens/GLM endpoint silently drops
  namespace tools, which made MCP tools invisible to the model even in the
  TUI. The verification container therefore fronts the API with
  `docker/codex-api-shim.js`, which rewrites namespaces to flat
  `mcp__<server>__<tool>` function tools on the wire (request, SSE
  response, and conversation history). This is a verification-harness
  workaround for the provider, not a change to load-lock itself.

### Tier 2 (contract-tested) — Cursor (hooks + MCP)

Cursor 1.7 (Sept 2025) introduced hooks as a beta with an under-documented
JSON contract — the original reason Cursor sat on the MCP-fallback tier
(issue #6: "do not ship against an unstable contract"). As of 2026-10-19 the
official docs at https://cursor.com/docs/hooks fully document the hooks
system with no beta caveats (per-event reference, common input schema, exit
codes, config-source priority, cloud-agent support, third-party hook
compatibility), so the contract is now treated as stable and the adapter
below shipped (issue #6).

`load-lock install --harness cursor --project <dir>` wires (all
project-level, merge-only, reversible by uninstall):

- **MCP server** — `mcpServers.load-lock` (stdio, absolute node path) in
  `<project>/.cursor/mcp.json` (documented project MCP config).
- **Stop hook** — flat hooks-v1 entry
  `{"type":"command","command":"<node> <cli> hook cursor stop"}` in
  `<project>/.cursor/hooks.json` (`{"version":1,"hooks":{"stop":[...]}}`;
  `version` is added only if absent, user entries preserved).
- **Rule** — dedicated `<project>/.cursor/rules/load-lock.mdc` with YAML
  frontmatter `alwaysApply: true` (note: plain `.md` files in
  `.cursor/rules` are ignored by Cursor — the rule must be `.mdc`).

The handler's documented stop contract: stdin carries `workspace_roots`
(no `cwd`) and `loop_count` (number of prior stop-hook followups for the
conversation); stdout JSON `{"followup_message":"..."}` is auto-submitted as
the next user message — Cursor's loop-style idle wakeup, analogous to
Claude/Codex `decision:"block"`. The handler is silent unless the daemon has
an offer matching `workspace_roots[0]`, and silent when `loop_count > 0`
(Cursor's equivalent of `stop_hook_active` — prevents wakeup loops;
Cursor's own `loop_limit` default of 5 per script is a second backstop).

**Verification status: contract-tested, not live-verified.** The stdin
parsing, followup payload, loop guard and silence paths are tested against
the documented contract in `src/test/hook.test.ts`; the install/uninstall
round-trip (user config preserved, idempotent re-install, clean bare-project
uninstall) is tested in `src/test/install.test.ts`. No Cursor install
exists on the verification machine, so end-to-end behavior inside the real
editor is unverified — the installer output says so explicitly. Sources:
official docs (https://cursor.com/docs/hooks, checked 2026-10-19), 1.7
release announcement (forum.cursor.com, Sept 2025), GitButler deep-dive
(Sept 2025), InfoQ coverage (Oct 2025).

### Tier 3 — MCP-only fallback (Gemini CLI, Copilot CLI, Cline, Roo Code, Goose)

The MCP server itself carries the policy in its `instructions`, every tool
result surfaces pending offers (tool-boundary delivery), and
`inspect_machine`/`get_config`/`configure` work unchanged.

**Every tier-3 MCP harness ships a first-class merge-only installer**
(Gemini CLI landed with issue #1; Copilot CLI, Cline, Roo Code
and Goose with issue #2). Cursor moved up to the hooks tier with its own
installer in issue #6 (see the Cursor section above). Each installer merges
into the harness's real config file
and never deletes anything the user wrote; `load-lock uninstall` removes
exactly the entries the installer added:

- **Gemini CLI** — `mcpServers.load-lock` (stdio) into
  `~/.gemini/settings.json` + a marked policy section in
  `~/.gemini/GEMINI.md`.
- **Copilot CLI** — `mcpServers.load-lock` (`type: local`) into
  `~/.copilot/mcp-config.json` (verify with `copilot mcp list`) + a marked
  section in `~/.copilot/copilot-instructions.md`. Hooks are reported in
  ecosystem content but unverified in official docs, so the installer ships
  none — no idle wakeup is claimed.
- **Cline** — `mcpServers.load-lock` into the MCP settings file
  (`~/.cline/data/settings/cline_mcp_settings.json`, or the path in
  `CLINE_MCP_SETTINGS_PATH`) + a dedicated `~/.cline/rules/load-lock.md`
  (our own file, so uninstall is a simple delete).
- **Roo Code** — `mcpServers.load-lock` into `<project>/.roo/mcp.json`
  (pass `--project`) plus every **existing** global `mcp_settings.json`
  (VS Code globalStorage for Roo/Zoo; existing files only — the installer
  never guesses storage paths) + a dedicated `~/.roo/rules/load-lock.md`.
- **Goose** — an `extensions.load-lock` stdio block (marker-tagged
  block-mapping YAML) into `~/.config/goose/config.yaml`
  (XDG_CONFIG_HOME respected) + a marked section in
  `~/.config/goose/.goosehints`.

Install/uninstall round-trips for all five are tested against a temp HOME
and validated against the harnesses' documented config schemas
(`src/test/install.test.ts`), but not live-verified against real
harnesses — hence *config-tested*.

`load-lock install --harness generic` still prints snippets for harnesses
without a dedicated installer.
Idle policy: these harnesses get no push notifications, so the PRIMARY
idle mechanism is the MCP `wait_for_turn` tool — a bounded, honest sleep
until it is the caller's turn. Queued agents call
`mcp__load-lock__wait_for_turn` (optionally with `timeout_ms`, default
600000, capped by the machine's `maxTurnWaitMs` config) and get a
structured result on every path: `granted` (the offer was auto-claimed —
`permit_token` included), `still_queued` (timeout, with queue position
and holders), `paused`/`cancelled`, or `not_found` (e.g. the daemon
restarted). The wait itself holds no permit and consumes no capacity;
harness tool cancellation aborts it cleanly. (Codex CLI note: async
background hooks never wake an idle session there either — the Stop hook
covers turn boundaries only — so the same `wait_for_turn` sleep is the
honest pattern for Codex subagents without hook wiring.)

Still missing on this tier: automatic context re-injection — there is no
push channel, so a woken agent relies on tool results (which carry
pending offers) rather than harness messages. We do not pretend these
harnesses got push notifications.

### Tier 4 — Aider (manual CLI)

No MCP/hooks; nothing to install. Agents (or humans) use the CLI directly in
the shell: `load-lock acquire ... && load-lock run -- <cmd>` handles
acquire→run→release in one command line.

## Live dashboard surfaces (issue #10)

`load-lock dashboard` is portable and harness-agnostic: any integration that
spawns the daemon gets the same live dashboard in any terminal. The table
below is deliberately honest about what each harness gets **inside its own
UI** — where no UI surface exists, we say so rather than claim parity.

| Harness | In-harness dashboard | Also available |
| --- | --- | --- |
| **OpenCode** | Native TUI panel: `/load-lock` opens `load-lock.dashboard` **in-window** as a side panel (also opened by clicking the sidebar widget; deliberately **not** bound to any key — issue #28: the old `gl` sequence swallowed plain `g` typing, and the candidate `ctrl+g` is the host's `session.first` default) with pools, holder cards, offer claim-window countdowns, queue, paused, event feed, `inspect_machine`; home-footer `lock 1/1` indicator on the home screen plus a clickable, health-colored `load-lock 0/3` widget in the session sidebar; `x` force-release behind select + confirm. Implemented as the package's `./tui` companion plugin (main plugin unchanged). Live-verified: opencode 2.0.29 (panel render, palette/slash command, confirm-gated force-release) and opencode 2.0.32 in a real pty (sidebar widget render, click-to-open, in-window presentation, plain `g` reaches the composer, `ctrl+g` not intercepted by load-lock). | `load-lock dashboard` (alias `top`) |
| **Claude Code** | None in-app — Claude Code has no plugin UI surface. The model can report status via the `load_lock_status` MCP tool at tool boundaries, and each `SessionStart` hook injects a one-line machine summary. | `load-lock dashboard` (any terminal) |
| **Codex CLI** | None in-app — same reason. `load_lock_status` MCP tool; `SessionStart`/`SubagentStart` machine summary. | `load-lock dashboard` (alias `top`) |
| **Gemini CLI** | None in-app (no hooks, no UI plugin surface). `load_lock_status` MCP tool at tool boundaries. | `load-lock dashboard` (alias `top`) |
| **Copilot CLI, Cursor, Cline, Roo Code, Goose** | None in-app. MCP `status` tool where the MCP server is configured. | `load-lock dashboard` (alias `top`) |
| **Aider** | None (no MCP either). | `load-lock dashboard` (alias `top`) |

All dashboard surfaces are **read-only viewers that never acquire a
permit**; the single admin action (force-release) is gated behind an
explicit confirm. Data plumbing (event-cursor resume, daemon-restart
reconnect, view-model shaping, frame rendering) is covered by
`src/test/dashboard.test.ts`.

## Session identity per harness

| Harness | Identity | Notes |
| --- | --- | --- |
| OpenCode | plugin context `sessionID` (also MCP `_meta` when used) | automatic |
| Claude Code | hooks get `session_id`; MCP tools take explicit `agent_id` | policy instructs agents to pass it |
| Codex | hooks get `session_id`; MCP tools take explicit `agent_id` | same |
| Cursor | hooks get `conversation_id` (no `cwd` — `workspace_roots[0]` identifies the request); MCP tools take explicit `agent_id` | same |
| Tier 3 | explicit `agent_id` argument | falls back to per-server-process id |

## Platform matrix

| Platform | Status | Notes |
| --- | --- | --- |
| **Linux** | Implemented + live-verified | Primary target; all daemon/protocol/CLI tests and the 3-worktree demo run here. `/proc`-based liveness with start-time PID-reuse defense. |
| **macOS** | Implemented, limitations documented | Works; liveness falls back from `/proc` start times to `kill(pid, 0)` (weaker PID-reuse defense), no cgroup limits. See OPERATIONS.md. |
| **Windows** | Implemented, unit-tested on Linux — **not Windows-verified** | Named-pipe transport (`\\.\pipe\load-lock`), `%LOCALAPPDATA%` state dir, `kill(pid, 0)` liveness, `taskkill /T` job-tree kills. Covered by `src/test/platform.test.ts` via platform injection; no Windows machine was available for end-to-end verification. See the Windows procedure in OPERATIONS.md. |

## Verified vs proposed — summary counts

- Live-verified: OpenCode (full adapter, including wakeup); Claude Code
  (full adapter in Docker: policy injection, compact restore, Stop-hook and
  asyncRewake wakeup paths, subagents, background-job cleanup); Codex CLI
  (Docker, interactive TUI: policy injection, MCP round-trip, FIFO queueing
  behind a CLI holder, Stop-hook decision-block wakeup; exec-mode MCP
  injection blocked upstream — see Tier 2 notes).
- Contract-tested: Cursor (hooks-v1 stop-hook adapter + installer, tested
  against the officially documented hooks JSON contract; no Cursor install
  on the verification machine — see the Cursor section under Tier 2).
- Config-tested: Gemini CLI, Copilot CLI, Cline, Roo Code, Goose (installer
  round-trips, temp HOME; real harnesses not installed on the verification
  machine).
- Core daemon/protocol/CLI: 68 automated tests + scripted 3-worktree demo
  (three independent agent processes, real git worktrees, one pool), including
  9 dashboard tests (view-model shaping, event-cursor resume across a daemon
  restart, reconnect, and a `load-lock dashboard --once` render smoke test) and
  9 bounded-wait tests (multi-process `wait_for_turn`: FIFO wake with
  auto-claim, timeout/pause/cancel/restart/abort paths, `maxTurnWaitMs` cap,
  MCP snake_case round trip).
- Proposed (researched capabilities, generic adapter only):
  Aider.
