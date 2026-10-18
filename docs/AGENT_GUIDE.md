# load-lock agent guide

load-lock coordinates heavy work across all coding agents on this machine.
Every session — any harness, any repo, any worktree — shares one machine-
wide capacity budget. Before resource-intensive work, acquire a permit. The
whole thing is cooperative: you decide what is heavy; the budget only works
if everyone participates.

This guide is also available as `load-lock agent-guide` and as a skill in
supported harnesses.

## 1. Deciding heavy vs light

Judge by **expected** CPU/memory/IO cost, not by name:

- **Heavy** (acquire first): builds, test suites, `cargo build`/`cargo
  test`, `npm test`, container builds, migration runs, anything you expect
  to saturate cores or memory for more than a few seconds.
- **Light** (no permit): file edits, greps, reads, git status/diff, short
  shell snippets, install/status probes, anything bounded and cheap.

If in doubt about the machine's headroom, call `inspect_machine` — it
reports effective cores and memory *including container/cgroup limits*
(the machine may have 8 logical cores but a 2-core cgroup quota — never
assume "N cores means N jobs") plus current load and memory pressure. Use
`get_config`/`configure` when the budget genuinely needs adjustment.

## 2. Core flow

```
acquire(reason, op_key)
  ├─ granted  → you hold a permit → do the heavy work now
  ├─ queued   → keep doing LIGHT work; offers reach you at your next
  │             load-lock tool call, or via a wakeup message
  │             no light work left? wait_for_turn() = "sleep until it
  │             is my turn" (bounded; auto-claims the offer for you)
  └─ ...
offer arrives (token, expiry) → claim(token) BEFORE the window closes
claim → held → start the heavy work
  best:  run_with_permit(permit_token, command)   # daemon tracks the process
  else:  attach_pid(permit_token, pid)            # you started it yourself
  else:  mark_started(permit_token)               # lease-based, weaker
work finishes → release(permit_token)
no longer needed while queued → cancel(request_id)
offer arrived but you won't make it → decline(offer_token)
```

Rules, in order of importance:

1. **Acquire immediately before** the heavy work — not at the start of a
   long task.
2. **While queued, continue useful light work** — read code, write plans,
   make edits. Do not sleep or spin; offers are delivered to you.
3. **Claim before starting.** Heavy work starts only after `acquire`
   returned granted (or `claim` succeeded). A notification alone never
   authorizes work.
4. **Hold until the process truly finishes** — including background
   execution. If the shell returned but the job still runs, you still hold
   the permit (that is the point).
5. **Release promptly** — success or failure. Release is idempotent; calling
   it twice is safe, calling it after a crash-recovery release is safe.
6. **Cancel** queued requests you no longer need, so someone else can have
   the capacity.

Notes on the details:

- `op_key` makes duplicate acquires idempotent: if your pending request for
  the same op already exists, `acquire` returns it instead of a second one.
  Use a stable key per distinct operation (e.g. `build/auth-module`), and
  different keys for different operations.
- Offers have a **claim window** (default 30s). If it lapses, the request
  becomes **paused** — capacity moves on and your request waits until you
  explicitly `rejoin(request_id)`. If you know you can't start in time,
  `decline` instead of letting it expire.

### Sleeping until your turn (`wait_for_turn`)

Rule 2 says keep doing light work while queued — but sometimes there is
nothing useful left. `wait_for_turn(request_id?, timeout_ms?)` is the honest
way to idle: a **bounded blocking sleep** over one of your queued, offered
or paused requests (default: your most urgent one). When capacity reaches
you mid-sleep, the offer is **auto-claimed inside the claim window** and
you wake holding the permit (`granted`, `permit_token` + `auto_claimed:
true` in the response).

Every resolution is a structured result, never an opaque error:

- `granted` — your turn came; the permit is already claimed for you.
- `still_queued` — the bound expired; you get your queue position, queue
  length and who is holding the capacity. Call it again to keep sleeping.
- `paused` — your offer expired or was declined meanwhile; `next_action`
  has the rejoin instructions.
- `cancelled` — the request was cancelled/declined/reclaimed meanwhile.
- `not_found` — the request ended, or the daemon restarted (queues are
  ephemeral); acquire again.

The sleep is bounded and **safe by construction**: it holds no permit and
no capacity, cancelling the tool call just stops the local sleep (nothing
is orphaned — your request keeps its queue position), and a daemon restart
mid-sleep resolves promptly with `not_found` instead of hanging. `timeout_ms`
defaults to 600000 (10 minutes) and is clamped to the machine's
`maxTurnWaitMs` cap (`get_config` shows it; `configure` can set it, valid
range 1000–3600000 ms). `timeout_ms: 0` means check-only. The CLI form is
`load-lock wait --id <request-id> --timeout <ms>`.

## 3. Running heavy work (lifecycle options)

How you start the work determines how reliably the permit cleans up after
you — pick the best available:

1. **`run_with_permit(permit_token, command)`** — the helper spawns your
   command in its own process group, atomically associates it with the
   permit, and auto-releases when the process group *actually finishes*
   (including background children). Check `job_status(job_id)` for
   completion/exit code/tail of output; `job_stop(job_id)` to kill it.
   Do **not** manually release a permit you handed to `run_with_permit`.
2. **`attach_pid(permit_token, pid)`** — you spawned the process yourself;
   the daemon now tracks that pid (and its process group) and releases when
   it is confirmed dead. Works for `... &` background jobs whose parent
   shell exits.
3. **`mark_started(permit_token)`** — no observable process (e.g. you call
   an external service). The permit is held under a lease (default 15 min)
   that is kept alive by heartbeats from your harness integration. Honest
   limitation: if your agent process dies silently, the lease eventually
   frees the capacity, but during that window nobody can guarantee the
   unseen work has stopped. Prefer 1 or 2 whenever possible.

If you `acquire` and get **granted** but then fail to start the work within
the start deadline (default 120s), the permit is automatically reclaimed —
nobody is stranded by a crashed claimant, and neither are you.

The equivalent CLI forms exist for shell-driven flows:

```sh
load-lock acquire --reason "cargo test" --op-key "test/core"      # prints JSON
load-lock run --permit <permit-token> -- cargo test --quiet       # tracks + releases
# or acquire+run in one go:
load-lock run --reason "nightly build" -- npm run build
load-lock wait --id <request-id> --timeout 120000                # sleep until your turn → auto-claim
```

## 4. Reading state

- `status(pool?)` — snapshot of the whole machine: holders (with phase,
  reason, age), outstanding offers, queue depth, paused requests.
- `pending()` — *your* requests and offers (with claim tokens).
- `inspect_machine()` — cores/memory incl. cgroup limits, pressure.
- `get_config()` / `configure(expected_version, changes, reason)` —
  versioned CAS budget changes; every change is recorded with author and
  rationale. On `version_conflict`, re-read and retry with the fresh
  version.
- Events have durable ids; after reconnects or restarts, consult
  `events(since)` rather than assuming.

## 5. Cleanup and failure etiquette

| Situation | Do this |
| --- | --- |
| Work finished (success or failure) | `release` |
| Queued request no longer needed | `cancel` |
| Claim window will lapse before you can start | `decline` the offer |
| Offer already expired (`offer_expired`) | `rejoin` when actually ready |
| Your harness session is about to end with a live tracked job | Nothing — `run_with_permit`/`attach_pid` jobs release themselves when done |
| You suspect a stuck holder | `status` → `recover list` diagnostics, and discuss with the operator before `force-release` |

Never force-release someone else's permit without checking `recover list`
first — a long hold with a live tracked process is working as intended.

## 6. Suggested internal parallelism

When you hold the permit, you own a share of the machine — bound your own
work too: prefer e.g. `cargo test -j 2` or a bounded test-worker count over
unbounded parallelism, and publish what you did via
`configure(... guidance ...)` notes if it should become convention.
