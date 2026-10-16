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
| **Claude Code** | MCP `mcp__load-lock__*` (user scope) | `SessionStart` hook plain-stdout context | Yes (SessionStart matcher `compact`) | Yes — `Stop` hook decision-block + async `await-offer` (`asyncRewake`) | Yes, via asyncRewake (contract-tested) | Full via MCP `run_with_permit` + server heartbeats | **Implemented + contract-tested** |
| **Codex CLI** | MCP `mcp__load-lock__*` (config.toml) | `SessionStart` + `SubagentStart` additionalContext; `~/.codex/AGENTS.md` | Yes (SessionStart matcher `compact`) | Yes — `Stop` hook `decision:"block"` continuation | Partial: async background hooks do NOT start a new turn (documented limitation); stop-hook covers turn boundaries | Full via MCP `run_with_permit` + server heartbeats | **Implemented + live-verified** (interactive TUI in Docker; exec-mode MCP blocked upstream — see Tier 2 notes) |
| **Gemini CLI** | Yes (`settings.json` mcpServers, first-class installer) | `GEMINI.md` global (config `context.fileName`) | Via global GEMINI.md (always loaded) | No hook mechanism exists | No | Via MCP `run_with_permit` only | **Implemented (fallback tier, config-tested)** |
| **GitHub Copilot CLI** | Yes (`copilot mcp add`) | AGENTS.md/GEMINI.md discovery + custom instructions | Via global instructions file | Hooks reported in ecosystem content but **not verified in official docs** — treat as unavailable | Unverified | Via MCP `run_with_permit` only | Proposed (MCP fallback) |
| **Cursor** | Yes (`.cursor/mcp.json` + global) | `.cursor/rules/*.md` Always rules | Rules re-apply (Always) | `stop` hook exists but **beta** with a less-documented JSON contract — not shipped | Beta/unverified | Via MCP `run_with_permit` only | Proposed (MCP fallback; hook tier possible later) |
| **Cline** | Yes (`cline_mcp_settings.json`) | `.clinerules/` + `~/.cline/rules` | Rules always loaded | No hooks | No | Via MCP `run_with_permit` only | Proposed (MCP fallback) |
| **Roo Code** | Yes (Roo MCP settings) | `.roo/` rule dirs | Rules always loaded | No hooks | No | Via MCP `run_with_permit` only | Proposed (MCP fallback) |
| **Goose** | Yes (`~/.config/goose/config.yaml`) | `.goosehints` (global + project) | Hints always loaded | No hooks | No | Via MCP `run_with_permit` only | Proposed (MCP fallback) |
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
  `load-lock.dashboard` session panel (pools, holder cards, offer
  countdowns, queue, paused, event feed, `inspect_machine`), a home-footer
  `lock 1/1·Q2` indicator, and an `x` force-release flow gated behind an
  explicit select + confirm (the panel itself is read-only and never
  acquires a permit).

Verified live on opencode v2.0.29: plugin load, policy visible to the model,
tool round-trip (acquire → queued → wakeup → claim → release), execution-
boundary delivery without interrupting a running `sleep`, skill visible,
and graceful handling of a deliberately missed offer (paused → cancel).

### Tier 2 — Claude Code (contract-tested) / Codex CLI (hooks + MCP, live-verified)

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
harness contracts. Claude Code live verification is pending a machine with
the harness installed.

Codex CLI (0.163.0) is live-verified end-to-end in Docker
(`docker/verify-codex.sh`, driven through a real pty TUI session via
`docker/codex-pty.py`): SessionStart policy injection visible to the model,
MCP `status`/`acquire`/`claim`/`release` round-trip, FIFO queueing behind a
competing CLI holder, and Stop-hook `decision:"block"` wakeup that continues
the session with the claim instruction. The verification drives the real
interactive hook-trust review (the "Hooks need review" dialog) once —
`--dangerously-bypass-hook-trust` is deliberately NOT used because it forces
codex embedded mode, which never injects MCP tools. Note: async background
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

### Tier 3 — MCP-only fallback (Gemini CLI, Copilot CLI, Cursor, Cline, Roo Code, Goose)

The MCP server itself carries the policy in its `instructions`, every tool
result surfaces pending offers (tool-boundary delivery), and
`inspect_machine`/`get_config`/`configure` work unchanged.

**Gemini CLI ships a first-class installer** (`load-lock install --harness
gemini-cli`, see issue #1): it writes `mcpServers.load-lock` (stdio) into
`~/.gemini/settings.json` and a marked policy section into
`~/.gemini/GEMINI.md`, both merged non-destructively; `uninstall` removes
exactly those. Round-trip tested against a temp HOME (`src/test/install.test.ts`),
but not live-verified against a real Gemini CLI — hence *config-tested*.

For the remaining harnesses that support global instruction files (rules /
hints...), `load-lock install --harness generic` prints a snippet to add.
Missing: idle wakeup and automatic context re-injection — queued agents
discover offers at their next tool call or via a bounded `wait`. This is the
honest fallback; we do not pretend these harnesses got push notifications.

### Tier 4 — Aider (manual CLI)

No MCP/hooks; nothing to install. Agents (or humans) use the CLI directly in
the shell: `load-lock acquire ... && load-lock run -- <cmd>` handles
acquire→run→release in one command line.

## Live dashboard surfaces (issue #10)

`load-lock top` is portable and harness-agnostic: any integration that
spawns the daemon gets the same live dashboard in any terminal. The table
below is deliberately honest about what each harness gets **inside its own
UI** — where no UI surface exists, we say so rather than claim parity.

| Harness | In-harness dashboard | Also available |
| --- | --- | --- |
| **OpenCode** | Native TUI panel: `/load-lock` opens `load-lock.dashboard` (session panel, full-screen) with pools, holder cards, offer claim-window countdowns, queue, paused, event feed, `inspect_machine`; home-footer `lock 1/1` indicator; `x` force-release behind select + confirm. Implemented as the package's `./tui` companion plugin (main plugin unchanged). Live-verified against opencode 2.0.29: panel render + palette/slash command + confirm-gated force-release exercised in the real TUI. | `load-lock top` |
| **Claude Code** | None in-app — Claude Code has no plugin UI surface. The model can report status via the `load_lock_status` MCP tool at tool boundaries, and each `SessionStart` hook injects a one-line machine summary. | `load-lock top` (any terminal) |
| **Codex CLI** | None in-app — same reason. `load_lock_status` MCP tool; `SessionStart`/`SubagentStart` machine summary. | `load-lock top` |
| **Gemini CLI** | None in-app (no hooks, no UI plugin surface). `load_lock_status` MCP tool at tool boundaries. | `load-lock top` |
| **Copilot CLI, Cursor, Cline, Roo Code, Goose** | None in-app. MCP `status` tool where the MCP server is configured. | `load-lock top` |
| **Aider** | None (no MCP either). | `load-lock top` |

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
| Tier 3 | explicit `agent_id` argument | falls back to per-server-process id |

## Verified vs proposed — summary counts

- Live-verified: OpenCode (full adapter, including wakeup); Codex CLI
  (Docker, interactive TUI: policy injection, MCP round-trip, FIFO queueing
  behind a CLI holder, Stop-hook decision-block wakeup; exec-mode MCP
  injection blocked upstream — see Tier 2 notes).
- Contract-tested: Claude Code hook/MCP contracts.
- Config-tested: Gemini CLI (installer round-trip, temp HOME; real harness
  not installed on the verification machine).
- Core daemon/protocol/CLI: 45 automated tests + scripted 3-worktree demo
  (three independent agent processes, real git worktrees, one pool), including
  9 dashboard tests (view-model shaping, event-cursor resume across a daemon
  restart, reconnect, and a `load-lock top --once` render smoke test).
- Proposed (researched capabilities, generic adapter only):
  Copilot CLI, Cursor, Cline, Roo Code, Goose, Aider.
