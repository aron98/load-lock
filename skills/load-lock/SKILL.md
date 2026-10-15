# load-lock: machine-wide heavy-work coordination

All coding agents on this machine (any harness, any repo/worktree) share one
small budget of heavy-work permits. Before resource-intensive local work, a
polite agent acquires a permit; everyone else keeps doing light work until an
offer arrives.

## When to use it

**Heavy** (acquire first): full builds, `cargo build`/`npm run build`, whole
test suites, codegen over the whole repo, bulk compilation, anything that
pins several cores or gobs of RAM for minutes.

**Light** (no permit): file edits, greps, small targeted tests, single-file
checks, reading, planning, git operations, anything sub-second or trivial.

Judge by *expected* CPU/memory/IO impact, not by command name. When unsure,
`inspect_machine` shows real capacity (incl. container limits) and pressure.

## Core flow

1. `acquire(reason, op_key)` — idempotent per `op_key`. Result is either
   `granted` (you hold a permit; start heavy work now) or `queued`
   (keep doing light work; an offer will arrive).
2. While queued: **continue useful light work**. Do not idle-poll.
3. When an offer arrives (harness wakeup or `pending`): `claim(offer_token)`
   inside the claim window (default 30s). Expired offers are rejected; your
   request pauses until you `rejoin`.
4. Only after `granted`/`claim` succeeds, start the heavy work. Associate the
   work with the permit:
   - `run_with_permit(permit_token, command)` — best: spawns it, tracks the
     process group, auto-releases on exit. Poll `job_status`; do NOT release
     manually.
   - `attach_pid(permit_token, pid)` — for a process you already started
     (e.g. a background shell task). Auto-release when it exits.
   - `mark_started(permit_token)` — last resort, no process association
     (heartbeat lease applies instead).
5. `release(permit_token)` when done (idempotent), or `cancel(request_id)`
   for queue entries you no longer need. Background jobs that outlive your
   session keep their permit until the *process* exits — never release just
   because a tool call returned a background-task id.

## Cleanup rules (why you still see permits released)

- Offers expire (short window) and never auto-recycle: a missed offer pauses
  your request; `rejoin(request_id)` puts you back in the FIFO queue.
- Claimed-but-never-started permits are reclaimed at the start deadline
  (default 120s) so a forgotten claim can't block the queue.
- Tracked jobs (run_with_permit/attach_pid) hold the permit exactly as long
  as the process (group) lives; completion/failure releases automatically.
- Untracked (mark_started) permits are held under a heartbeat lease — if your
  harness adapter disappears without a trace of the work, the lease reclaims
  the permit. The tradeoff: a still-running but unobserved process could
  overlap with new work. Prefer tracking.
- Never auto-released merely for being held a long time, if the work is
  confirmed running.

## Machine awareness and config

- `inspect_machine` — cores, memory, cgroup/container limits, current pressure.
- `get_config` / `configure(expected_version, changes, reason)` — compare-and-swap
  capacity and timing changes; read the version first, always explain why.
- `status` — machine-wide snapshot: holders, offers, queue.
- Anyone may adjust the budget; changes are persisted with rationale+author.

## Recovery

- `pending` — your own offers/queue/holds (check before giving up).
- `load-lock status` / `load-lock recover list` (human CLI) shows orphaned
  permits with process liveness; `load-lock recover force-release --id` is the
  explicit escape hatch (it prints holder/job info first).
- Daemon restart: running tracked permits survive (journaled); queued/offered
  requests do not — re-`acquire`.
