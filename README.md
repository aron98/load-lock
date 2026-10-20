# load-lock

[![CI](https://github.com/aron98/load-lock/actions/workflows/ci.yml/badge.svg)](https://github.com/aron98/load-lock/actions/workflows/ci.yml)

**A machine-wide heavy-work budget for parallel coding agents.**

When several agents work side by side on one machine — separate sessions,
repos, git worktrees, or harnesses (OpenCode, Codex CLI, Claude Code, ...) —
their builds and test suites stomp on each other, thrash the caches, and
starve each other's cores. load-lock gives them one shared counting
semaphore: acquire a permit before heavy work, keep doing light work while
queued, receive a FIFO offer when capacity frees, claim it, run, release.
It is cooperative and advisory — no command wrapping, no automatic shell
classification, no approval interruptions.

```
agent A (OpenCode)        agent B (Codex)         agent C (Claude Code)
  acquire "cargo test"      acquire "npm test"      acquire "build docs"
  granted ✓ runs            queued → keeps coding   queued → keeps coding
  ...                       offer → claim ✓ runs    (misses window → paused)
  release ✓                 release ✓               rejoin → offer → claim ✓
```

## Features

- **One budget for the whole machine** — every client of any harness shares
  one capacity pool regardless of repo/worktree/cwd. Default: pool `heavy`,
  capacity 1; fully runtime-configurable by any agent via versioned CAS
  updates (persisted with author + rationale).
- **Atomic acquire-or-queue** — single daemon event loop; a release can
  never slip between a failed check and queue registration.
- **FIFO offers with opaque claim tokens** — outstanding offers reserve
  capacity; expired offers pass capacity to the next waiter and pause the
  absent request until it explicitly rejoins (no endless recycling).
- **Real process-lifecycle cleanup** — permits attach to actual processes
  (pid + process group + `/proc` start time, PID-reuse-safe). Background
  jobs outliving the shell keep their permit until the whole group exits.
  Never auto-expired merely for being old. Untracked work uses an honest,
  documented heartbeat-lease tradeoff. Explicit release is always
  available and idempotent.
- **Crash-safe** — agent crashes release tracked permits on confirmed
  process death; daemon restarts reconcile a journal against real liveness
  and auto-respawn transparently.
- **Honest notifications** — tool-boundary offer delivery everywhere; real
  idle wakeup where the harness supports it (live-verified on OpenCode;
  hook-based on Claude Code and Codex CLI); a bounded blocking
  `wait_for_turn` (`load-lock wait` on the CLI) that sleeps until your
  turn and auto-claims for harnesses without idle wakeup; durable event
  ids for reconnects. A notification never authorizes work — only
  `claim` does.
- **Policy that actually reaches the model** — installed per harness via
  its real mechanism (plugin context hook, SessionStart hooks incl.
  compact matchers, global instruction files), plus a detailed skill/guide.
- **Resource-aware** — `inspect_machine` reports cgroup/container CPU and
  memory limits and current pressure; never assumes cores = capacity.

## Quickstart

```sh
npm install -g @aron98/load-lock
load-lock install --harness opencode     # or claude-code | codex | gemini-cli |
                                         # copilot-cli | cline | roo-code | goose | generic
load-lock doctor
```

From then on, agents see the policy and tools automatically:
OpenCode plugin (`load_lock_*` tools), Claude Code / Codex MCP tools
(`mcp__load-lock__*`) plus session hooks. Any other MCP-capable harness can
use the generic stdio server; plain shells use the CLI:

```sh
load-lock run --reason "nightly build" -- npm run build   # acquire→run→release
load-lock status                                          # machine-wide view
load-lock dashboard                                       # live read-only dashboard (q quits)
load-lock help                                            # one-screen usage of every command
load-lock configure --capacity 2 --reason "16-core host" --author me
```

OpenCode users also get a live dashboard inside the TUI: `/load-lock`
opens it in-window, every session screen shows a clickable at-a-glance
widget in the right sidebar, and the home screen has a footer indicator —
same data, themed. See docs/OPERATIONS.md → "Dashboard".

## Layout

```
src/core/       daemon + state machine + persistence + machine inspection
src/mcp/        MCP stdio server (universal adapter)
src/adapters/   OpenCode native plugin
src/cli/        CLI incl. installer, hook handlers, run/wait helpers
src/test/       32 tests: state machine, real multi-process daemon tests,
                MCP integration, hook contracts, run helper
demo/           reproducible 3-worktree demo (three agents, one pool)
docs/           ARCHITECTURE / COMPATIBILITY / OPERATIONS / AGENT_GUIDE
skills/         packaged skill
```

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — design, why a dedicated
  service (vs WorkOS Airlock / mic-lock / flock wrappers), atomicity,
  restart semantics, notification honesty, lifecycle tradeoffs.
- [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md) — per-harness capability
  matrix with implemented / contract-tested / proposed labels.
- [docs/OPERATIONS.md](docs/OPERATIONS.md) — install, config,
  troubleshooting, recovery, daemon lifecycle.
- [docs/AGENT_GUIDE.md](docs/AGENT_GUIDE.md) — the playbook for agents.
- [docs/ADAPTERS.md](docs/ADAPTERS.md) — how to write an adapter for a new
  harness, using the published library surface.

## Status

- Core daemon/protocol/CLI: implemented, 68 automated tests passing
  (multi-process daemons, real processes, restarts, races, expiry,
  PID-reuse, subprocess survival; plus 9 dashboard tests — view-model
  shaping, event-cursor resume across a daemon restart, reconnect, and a
  `load-lock dashboard --once` render smoke test).
- OpenCode adapter: implemented and **live-verified** (tools, policy
  injection, compaction-proof context hook, execution-boundary wakeup
  with tokens, skill).
- Claude Code adapter: implemented, contract-tested against documented
  hook JSON; not yet live-verified (harness not installed on the
  verification machine).
- Codex CLI adapter: implemented and **live-verified** end-to-end in
  Docker (interactive TUI via pty: policy injection, MCP round-trip,
  FIFO queueing behind a competing holder, Stop-hook decision-block
  wakeup; see COMPATIBILITY.md for the two upstream/provider constraints
  the verification harness works around).
- Tier-3 fallback installers (Gemini CLI, Copilot CLI, Cline, Roo Code,
  Goose): implemented merge-only installers (MCP stdio server entry into
  the harness's real config + a global instructions-file section/policy
  rule file), config-tested via temp-HOME round-trips; fallback tier (no
  hooks, no async push — no idle wakeup).
- Cursor adapter: implemented (issue #6) — merge-only project-level installer
  (`.cursor/mcp.json` MCP entry, `.cursor/hooks.json` stop hook per the now-
  officially-documented hooks v1 contract, `.cursor/rules/load-lock.mdc`
  Always-apply rule) + `hook cursor stop` handler emitting
  `{"followup_message":...}` idle wakeup. **Contract-tested**, not
  live-verified (no Cursor on the verification machine).
- Aider: researched; manual CLI tier. See COMPATIBILITY.md for the matrix.

Linux-first; macOS works with documented liveness-check limitations;
Windows has a named-pipe transport adapter (implemented and unit-tested on
Linux via platform injection; not yet verified on a Windows machine).
