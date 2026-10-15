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
| **Codex CLI** | MCP `mcp__load-lock__*` (config.toml) | `SessionStart` + `SubagentStart` additionalContext; `~/.codex/AGENTS.md` | Yes (SessionStart matcher `compact`) | Yes — `Stop` hook `decision:"block"` continuation | Partial: async background hooks do NOT start a new turn (documented limitation); stop-hook covers turn boundaries | Full via MCP `run_with_permit` + server heartbeats | **Implemented + contract-tested** (hooks need `/hooks` trust review) |
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
- per-session heartbeats.

Verified live on opencode v2.0.29: plugin load, policy visible to the model,
tool round-trip (acquire → queued → wakeup → claim → release), execution-
boundary delivery without interrupting a running `sleep`, skill visible,
and graceful handling of a deliberately missed offer (paused → cancel).

### Tier 2 — Claude Code / Codex CLI (hooks + MCP, contract-tested)

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
harness contracts. Live verification pending a machine with the harness
installed. Codex requires the user to trust the hooks once via `/hooks`
(the installer prints this).

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

## Session identity per harness

| Harness | Identity | Notes |
| --- | --- | --- |
| OpenCode | plugin context `sessionID` (also MCP `_meta` when used) | automatic |
| Claude Code | hooks get `session_id`; MCP tools take explicit `agent_id` | policy instructs agents to pass it |
| Codex | hooks get `session_id`; MCP tools take explicit `agent_id` | same |
| Tier 3 | explicit `agent_id` argument | falls back to per-server-process id |

## Verified vs proposed — summary counts

- Live-verified: OpenCode (full adapter, including wakeup).
- Contract-tested: Claude Code, Codex CLI hook/MCP contracts.
- Config-tested: Gemini CLI (installer round-trip, temp HOME; real harness
  not installed on the verification machine).
- Core daemon/protocol/CLI: 36 automated tests + scripted 3-worktree demo
  (three independent agent processes, real git worktrees, one pool).
- Proposed (researched capabilities, generic adapter only):
  Copilot CLI, Cursor, Cline, Roo Code, Goose, Aider.
