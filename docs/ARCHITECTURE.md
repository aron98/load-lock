# load-lock architecture

load-lock is a cross-harness coordination plugin for parallel coding agents. It
provides a machine-wide counting semaphore: before doing resource-intensive
work (builds, test suites, long compiles), an agent acquires a permit; while
queued it keeps doing light work; when capacity frees up it receives a FIFO
offer, claims it, runs the heavy work, and releases. Coordination is
cooperative and advisory — nothing wraps or rewrites shell commands, and agents
decide for themselves what counts as "heavy".

## Why a small dedicated service (vs extending something existing)

We evaluated the existing landscape before building:

- **WorkOS Airlock** (the closest name match) is a commercial, cloud-hosted
  *authorization* gateway for agents: it approves or denies tool calls
  (agent identity, intent, egress policies) via WorkOS Pipes. It answers "is
  this agent allowed to do this?", not "does this machine have spare capacity
  right now?". It has no machine-local state, no queue, no offers, and no
  process-lifecycle tracking. Smaller GitHub projects named "airlock"
  (an agent type-checker gate, an MCP egress allow-list) are similarly
  unrelated.
- **mic-lock** (npm) provides local sticky locks for shared test resources,
  but it is a single lock with no counting semaphore, no FIFO queue, no
  offer/claim protocol, no harness integration, and no automatic cleanup.
- **flock-wrapper scripts** (advisory lock around a command) cannot work
  across harness tool calls: the acquire step is a short-lived process that
  must exit before the agent does its real work, releasing the lock with it.
  A `flock` held by a process that has already exited protects nothing. (We
  do use an flock-style spawn lock internally — for daemon bootstrapping —
  but never for permits.)

No existing project combines a counting semaphore, FIFO offers with claim
tokens, per-agent identity, automatic permit cleanup tied to real process
lifetimes, and harness instruction/notification adapters. The coordination
state is small and its lifetime is the machine, not a repo — so a small
dedicated daemon plus thin per-harness adapters is the right shape. Extending
a larger system (e.g. a build tool) would couple the budget to one harness
and inherit unrelated constraints.

## Core design

**One daemon, one budget.** A single `load-lock` daemon process per machine
owns all state. Every client — any harness, any repo, any worktree — talks to
the same Unix-domain socket, so all sessions share one capacity budget
regardless of working directory. The default configuration is one pool
`heavy` with capacity 1; pools, capacity, and timings are changed at runtime
through `configure` (versioned compare-and-swap, persisted with author +
reason). The state directory lives outside any checkout
(`$XDG_STATE_HOME/load-lock`, default `~/.local/state/load-lock`, overridable
via `LOAD_LOCK_STATE_DIR`).

**Single-threaded atomicity.** The daemon is one Node process; every state
mutation happens on one event loop turn. There is no interleaving between
"check capacity" and "grant" — acquisition is atomic by construction, and
there is no window in which a release can be missed between a failed check
and queue registration. `acquire` either grants or registers in the queue in
one operation; there is no separate failed-acquire/subscribe sequence that
could miss a wakeup.

**FIFO offers with claim tokens.** When capacity frees, the daemon reserves
it and creates an offer for the head of the queue: an opaque claim token with
an expiry (default 30s). The offer is delivered to the agent (see
notifications below); heavy work starts only after a successful `claim`,
which atomically converts the offer into a permit. Outstanding offers consume
capacity, so an unclaimed offer cannot admit a second agent over budget. If
the offer expires, capacity passes to the next waiter and the expired request
becomes **paused** — it will not be re-offered until the agent explicitly
`rejoin`s. This prevents endless recycling of offers to absent agents.

**Permit lifecycle (automatic cleanup).** A permit moves through phases:

1. **Claimed, awaiting execution** — has a configurable start deadline
   (default 120s). If execution never starts, the permit is reclaimed.
2. **Running, tracked** — associated with a real OS process via
   `attach_pid`/`run_with_permit` (pid + process-group id + `/proc` start
   time). The permit lives as long as the associated job: parent shells may
   exit, background children keep the group alive, and the daemon
   auto-releases only on confirmed termination. It is never auto-expired
   merely because time passed. PID reuse is defended by comparing
   `/proc/<pid>/stat` start times.
3. **Running, untracked** — `mark_started` for jobs the daemon cannot
   observe. Held under a lease (default 15 min) kept alive by heartbeats
   (the MCP server and OpenCode plugin heartbeat automatically every 30s).
   This is an explicit tradeoff: a lease cannot simultaneously guarantee
   prompt reclamation and never overlap an unobserved surviving process.
   We reclaim when the owner stops heartbeating, and we document the
   residual risk instead of claiming a guarantee we can't make.

Explicit `release` always remains available and is idempotent (a duplicate or
late release is a no-op, not an error). `admin release` / `recover
force-release` exists for humans with holder/job diagnostics.

**Association is atomic.** `run_with_permit` spawns the job (its own process
group) and only then associates pid+pgid with the permit in a single daemon
operation; a reclamation racing the start loses cleanly (stale token /
wrong-state error), and a failed start kills the process group immediately.
Background execution is handled honestly: the helper returns after *the whole
process group* finishes, never merely when a shell returns a task id.

**Identity.** Per-agent identity comes from the harness (OpenCode session ID)
or an explicit `agent_id` argument; every entry also records an agent label,
cwd, op key (for idempotent duplicate suppression), and reason. Idempotency:
a duplicate `acquire` from the same agent for the same pending op key returns
the existing request rather than a second one; multiple distinct ops per
agent are supported. All tokens (permits, offers) are opaque; releasing or
claiming with someone else's token fails.

**Restart behavior.** Config is persisted (atomic write + rename). Held
permits are journaled: on daemon restart, tracked permits are reconciled
against real process liveness (dead ⇒ released, alive ⇒ kept, same tokens
still valid), claimed permits keep their original start deadline, untracked
permits get a fresh lease window, and a release arriving late for an entry
that was reconciled is idempotent. Queues and offers are *not* journaled:
they are ephemeral by design — queued agents are still running, notice the
missed offer via their next tool call, and re-acquire; the daemon
auto-spawns on the next client connection, so an agent never needs to know
the daemon restarted. This is documented, deliberate behavior, not a bug.

## Notification honesty

A critical constraint discovered by research: **no harness reliably pushes
MCP-server-initiated notifications into model context.** MCP transports
having a notification mechanism says nothing about whether the harness wakes
an idle agent or injects into context. load-lock therefore uses four
mechanisms, and labels exactly which apply per harness:

1. **Tool-boundary delivery (always available).** Every load-lock tool
   result and every `status`/`pending` call carries the caller's current
   offers (with claim tokens) — an agent performing light work discovers its
   offer at its next tool call, without polling.
2. **Bounded blocking wait.** `acquire(wait_ms)` blocks briefly (default
   5s) inside the tool call and auto-claims if capacity frees during the
   wait. The CLI `wait` command and MCP `wait` pattern provide longer
   bounded waits. No model-authored busy-polling required.
3. **Idle wakeup where the harness genuinely supports it.**
   - OpenCode (live-verified): the native plugin watches daemon events and
     calls `ctx.session.synthetic(...)`, delivering the offer (with token)
     to an idle session at its next execution boundary — it never
     interrupts an in-flight shell command.
   - Claude Code (contract-tested): a `Stop` hook checks for cwd-matching
     offers and continues the session with a claim instruction; an async
     `await-offer` watcher with `asyncRewake: true` wakes idle sessions.
   - Codex CLI (contract-tested): `Stop` hook with `decision: "block"`
     continuation. Note: Codex async background hooks do **not** start a new
     turn — documented as a limitation.
4. **Durable event identities.** All events have monotonic IDs; agents can
   pull owner-filtered events since a cursor and deduplicate after reconnect
   or daemon restart. A notification NEVER grants permission — only
   `claim(offer_token)` does; expired offers are rejected and stale
   notifications authorize nothing.

## Instruction delivery (policy teaching)

The behavioral policy (acquire before heavy work, keep doing light work
while queued, claim before starting, hold until the process truly finishes,
release promptly, cancel unneeded work, use inspect/configure when the
budget needs adjustment) is delivered per harness using its real mechanism,
and restored after context compaction:

- **OpenCode**: plugin `context` hook injects the brief on every model call
  (compaction-proof, live-verified), plus a registered skill with the full
  guide.
- **Claude Code**: `SessionStart` hook (matchers include `compact`) +
  `~/.claude/CLAUDE.md` section + skill.
- **Codex CLI**: `SessionStart` hook (matcher `compact`) + `SubagentStart`
  hook + `~/.codex/AGENTS.md` section (hooks require `/hooks` trust review).
- Other harnesses: MCP server `instructions` + a global instructions file
  snippet where the harness supports one (see COMPATIBILITY.md).

Policy is short (one brief, no repeated reminders), reinforced by tool
names/descriptions, and never interrupts ordinary work with approval
prompts.

## Failure modes covered

| Failure | Behavior |
| --- | --- |
| Agent disconnects mid-heavy-work | Permit retained; tracked job keeps capacity until the real process finishes; untracked job's lease survives until heartbeats stop |
| Agent process crashes | Tracked permit auto-releases on confirmed process death; untracked reclaims after lease expiry |
| Background job outlives the tool call | pgid tracking retains the permit until the whole group exits |
| Daemon crash/restart | Auto-respawn on next connect; journal reconciliation of held permits (conservative: dead ⇒ released, alive ⇒ kept); queues/offers ephemeral by design |
| Stale/forged token | Opaque tokens; wrong-owner claim/release rejected; expired offers rejected with a precise error |
| Forgotten release | start deadline (claimed), process death (tracked), lease expiry (untracked), plus human `recover force-release` |
| PID reuse | `/proc` start-time comparison |
| Config change while offers outstanding | Capacity increase admits queued agents immediately; capacity decrease lets holders finish and delays new admissions; outstanding offers keep their reservations |
| Duplicate claims/releases | Idempotent or precise `stale_token`/`offer_expired` errors, never double effects |

## Extension points

The protocol already carries weights (a request may ask for >1 units of
capacity; admission is FIFO with head-of-line blocking) and multiple pools;
the machine currently uses one pool by default but accepts arbitrary pool
names through the same code paths. Adding a second budget (e.g. `network`)
is configuration, not code.
