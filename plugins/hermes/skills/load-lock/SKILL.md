---
name: load-lock
description: >-
  Teach parallel AI coding agents sharing one machine to take turns on heavy
  work such as full builds and test suites. Agents acquire a machine-wide
  permit before resource-intensive local work, keep doing light work while
  queued FIFO, sleep honestly with bounded waits instead of polling, and
  release the permit when done. Use when several agents on one machine risk
  overloading it by starting heavy work in the same minute. On Hermes, the
  load-lock plugin provides the load_lock_* tools; the CLI fallback is
  `npx -y @aron98/load-lock@1.7.0` (downloads the pinned npm package), and
  load-lock keeps its shared state in ~/.local/state/load-lock (a small
  per-user daemon started on first use).
---

# load-lock: machine-wide heavy-work coordination

All coding agents on this machine (any harness, any repo/worktree) share one
small budget of heavy-work permits. Before resource-intensive local work, a
polite agent acquires a permit; everyone else keeps doing light work until an
offer arrives.

## How to call load-lock

Use the first of these that works; they all talk to the same daemon:

1. **The load_lock_* Hermes tools** (`load_lock_acquire`,
   `load_lock_wait_for_turn`, `load_lock_run_with_permit`, ...), registered
   by the load-lock plugin. The rest of this skill names them with the
   `load_lock_` prefix.
2. **`load-lock` on PATH**: check with `load-lock version`.
3. **Pinned npx**: `npx -y @aron98/load-lock@1.7.0 <command>` (Node >= 20).
   It downloads that exact npm package once into the npx cache. Below,
   read `load-lock` as this whole prefix. `npm install -g @aron98/load-lock`
   makes it permanent.

The first call starts the daemon on its own (shared state in
`~/.local/state/load-lock`, or `$XDG_STATE_HOME/load-lock`); you never start
it yourself.

### CLI-only use (no Hermes tools)

`load-lock help` lists every command. The safest flow is `load-lock run`,
which acquires a permit, runs the command, and releases it when the command
exits (success or failure):

```sh
load-lock run --reason "full test suite" --op-key test/all -- npm test
```

- Exit code **68** with `queued at position N (request <id>)` means you are
  not allowed to start yet. Keep doing light work. Out of light work? Sleep
  honestly with `load-lock wait --id <request-id> --timeout 600000`: it
  wakes you on your turn, claims the offer, and prints a `permit_token`.
  Then `load-lock run --permit <permit_token> -- npm test`. A `wait` that
  exits 68 again (still queued) is a checkpoint: call it again.
- No longer need a queued request: `load-lock cancel --id <request-id>`.
  Your own offers, queue entries and paused requests: `load-lock pending`.

**Identity.** The daemon routes offers and `pending` per agent. The Hermes
plugin derives your agent id from your session automatically (every call in
one Hermes session counts as one agent; other sessions are other agents), so
you never have to pin an id. From the terminal, set `LOAD_LOCK_AGENT=<unique-name>`
(or pass `--agent <unique-name>`) on every call if `pending` does not show a
request you made.

**Notification honesty on Hermes.** Offers arrive in the `pending` section
of every load_lock_* tool result (tool-boundary delivery) — check results
after each call and claim promptly. Out of light work, sleep honestly with
`load_lock_wait_for_turn` instead of idling. The plugin injects the short
policy on your first turn and again after context compaction, and
automatically heartbeats `load_lock_mark_started` permits while your session
lives.

## When to use it

**Heavy** (acquire first): full builds, `cargo build`/`npm run build`, whole
test suites, codegen over the whole repo, bulk compilation, anything that
pins several cores or gobs of RAM for minutes.

**Light** (no permit): file edits, greps, small targeted tests, single-file
checks, reading, planning, git operations, anything sub-second or trivial.

Judge by *expected* CPU/memory/IO impact, not by command name. When unsure,
`load_lock_inspect_machine` shows real capacity (incl. container limits) and
pressure.

## Core flow

1. `load_lock_acquire(reason, op_key)` — idempotent per `op_key`. Result is
   either `granted` (you hold a permit; start heavy work now) or `queued`
   (keep doing light work; an offer will arrive).
2. While queued: **continue useful light work**. Do not idle-poll.
   Out of light work? `load_lock_wait_for_turn(request_id?, timeout_ms?)` — a
   bounded blocking sleep until your turn that auto-claims the offer and
   wakes you with the permit_token (holds no capacity; cancellation leaves
   nothing behind).
3. When an offer arrives (in any tool result's `pending`): `load_lock_claim
   (offer_token)` inside the claim window (default 30s). Expired offers are
   rejected; your request pauses until you `load_lock_rejoin`.
4. Only after `granted`/`claim` succeeds, start the heavy work. Associate the
   work with the permit:
   - `load_lock_run_with_permit(permit_token, command)` — best: spawns it,
     tracks the process group, auto-releases on exit. Sleep with
     `load_lock_wait_for_completion(job_id)`; do NOT release manually.
   - `load_lock_attach_pid(permit_token, pid)` — for a process you already
     started (e.g. a background shell task). Auto-release when it exits.
   - `load_lock_mark_started(permit_token)` — last resort, no process
     association (heartbeat lease applies instead; this plugin heartbeats).
5. `load_lock_release(permit_token)` when done (idempotent), or
   `load_lock_cancel(request_id)` for queue entries you no longer need.
   Background jobs that outlive your session keep their permit until the
   *process* exits — never release just because a tool call returned a
   background-task id.

## Cleanup rules (why you still see permits released)

- Offers expire (short window) and never auto-recycle: a missed offer pauses
  your request; `load_lock_rejoin(request_id)` puts you back in the FIFO
  queue.
- Claimed-but-never-started permits are reclaimed at the start deadline
  (default 120s) so a forgotten claim can't block the queue.
- Tracked jobs (run_with_permit/attach_pid) hold the permit exactly as long
  as the process (group) lives; completion/failure releases automatically.
- Untracked (mark_started) permits are held under a heartbeat lease — if your
  session (and this plugin) disappears without a trace of the work, the
  lease reclaims the permit. The tradeoff: a still-running but unobserved
  process could overlap with new work. Prefer tracking.
- Never auto-released merely for being held a long time, if the work is
  confirmed running.

## Machine awareness and config

- `load_lock_inspect_machine` — cores, memory, cgroup/container limits,
  current pressure.
- `load_lock_get_config` / `load_lock_configure(expected_version, changes,
  reason)` — compare-and-swap capacity and timing changes; read the version
  first, always explain why.
- `load_lock_status` — machine-wide snapshot: holders, offers, queue.
- Anyone may adjust the budget; changes are persisted with rationale+author.

## Recovery

- `load_lock_pending` — your own offers/queue/holds (check before giving up).
- `load-lock status` / `load-lock recover list` (human CLI) shows orphaned
  permits with process liveness; `load-lock recover force-release --id` is the
  explicit escape hatch (it prints holder/job info first).
- Daemon restart: running tracked permits survive (journaled); queued/offered
  requests do not — re-`acquire`.
