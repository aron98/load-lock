# Writing a harness adapter for load-lock

load-lock ships first-class support for OpenCode, Claude Code, and Codex CLI,
plus a generic MCP fallback that works with any MCP-capable harness. This
guide is for anyone adding support for a *new* harness. Everything you need
is importable from the published package — no private APIs required.

```ts
import { LLClient, withClient } from "@aron98/load-lock/shared/client";
import type * as P from "@aron98/load-lock/shared/protocol";
import { POLICY_BRIEF } from "@aron98/load-lock/policy/text";
import { buildServer } from "@aron98/load-lock/mcp/server";
```

## What a good adapter provides (in priority order)

1. **Tools** — the agent must be able to call acquire / claim / release /
   cancel / pending / status / inspect_machine / get_config / configure, and
   ideally the lifecycle helpers (run_with_permit / job_status / attach_pid /
   mark_started).
2. **Policy at session start** — inject `POLICY_BRIEF` where the harness
   puts per-session instructions, and re-inject after context compaction if
   the harness supports it. This is the part agents actually follow; tools
   without teaching get ignored.
3. **Idle wakeup (if the harness allows it)** — when the daemon emits an
   `offered` event for your session, deliver it to the agent at a safe
   point (execution boundary), including the claim token and expiry. Never
   interrupt an in-flight tool call.
4. **Heartbeats** — every ~30s while the session is alive, so
   `mark_started` (untracked) permits aren't reclaimed while the agent is
   merely quiet.

Pick the tier your harness allows:

## Tier 1 — native plugin (best)

For harnesses with an in-process extension API (this is what the OpenCode
adapter does — see `src/adapters/opencode/plugin.ts` as the worked example):

- One module-level `LLClient` (it auto-spawns the daemon on first use; a
  machine typically runs one client per plugin host).
- Register tools that translate your harness's tool-call format into
  `client.request(...)`. Give the agent a stable identity (harness session
  id) and pass the session's cwd at acquire time.
- Subscribe `client.watch("*")` and route `offered` events to the owning
  session via the harness's wake/synthetic-message API.
- Inject `POLICY_BRIEF` on session start and after every compaction.
- For heavy work, implement a `run_with_permit` helper following the
  lifecycle contract below — or teach agents to use the CLI
  (`load-lock run --permit ... -- <cmd>`), which already implements it.

## Tier 2 — hooks + MCP

For harnesses with lifecycle hooks but no in-process API (Claude Code and
Codex CLI use this): keep the stock MCP server (`load-lock-mcp` binary, or
`node .../dist/mcp/main.js`) for tools, and add hook handlers that shell out
to the CLI:

- `load-lock hook <harness> session-start` → prints `POLICY_BRIEF` +
  machine summary for context injection (register for post-compaction too,
  if the harness has a compact matcher).
- `load-lock hook <harness> stop` → checks cwd-matched offers and, if one
  exists, prints the harness's "continue the session" JSON with the claim
  token. Honors any stop-loop flags the harness provides.
- See `src/cli/hook.ts` for the implementation pattern and
  `src/cli/install.ts` for the config-writing/installer pattern.

## Tier 3 — MCP only

Register the MCP server with the harness and put a short policy section in
whatever global instructions file the harness reads (GEMINI.md / rules /
hints...). Offers are surfaced in every tool result (tool-boundary
delivery), so correctness is preserved; what you lose is idle wakeup —
steer agents to `wait_for_turn` (bounded blocking sleep that auto-claims
and returns a `permit_token`) as the primary idle mechanism, and document
the remaining gap honestly (see docs/COMPATIBILITY.md).

## Protocol quick reference

Wire protocol: NDJSON over a Unix domain socket; `LLClient` handles
framing, timeouts, auto-spawn, and event subscriptions. Methods an adapter
normally touches:

| Method | Purpose |
| --- | --- |
| `acquire {pool?, agentId, agentLabel?, cwd?, opKey, reason, weight?, waitMs?, subscribeIfBusy?}` | grant / queue (idempotent per agent+opKey) |
| `claim {offerToken}` | offer → permit (before starting heavy work) |
| `release {permitToken, outcome?}` | idempotent |
| `cancel {requestId}` / `rejoin {requestId}` / `decline {offerToken}` | queue hygiene |
| `pending {agentId}` | the caller's offers/queue/holds (attach to every tool result) |
| `status {pool?}` / `inspect` / `get_config` / `configure {expectedVersion, changes, reason, author}` | state + versioned CAS config |
| `start_job {permitToken, pid, pgid?}` | atomic permit↔process association (tracked) |
| `mark_started {permitToken}` | untracked lease fallback |
| `heartbeat {agentId}` | keep untracked leases alive |
| `watch {agentId\|*}` / `events {sinceEventId, agentId?}` | push/pull event streams (durable ids) |
| `offers_for_cwd {cwd}` | for hook scripts without session identity |

## Lifecycle contract (the part that must not be improvised)

- Associate a permit with real execution **atomically**: spawn the job in
  its own process group, then `start_job` with pid+pgid; if association
  fails, kill the group immediately. Register exit listeners *before*
  awaiting the association RPC (a fast-exiting job can otherwise lose its
  release event — this was a real bug here).
- Never release because the shell returned a background-task id; release
  (or auto-release) on actual process-group completion.
- Do not auto-release on agent disconnect; that's the whole point of the
  daemon holding ownership.
- Untracked (`mark_started`) permits are only as good as your heartbeats;
  document the tradeoff and steer agents toward tracked paths.

## Testing your adapter

Reuse `src/test/testutil.ts`-style harness spawning (isolated
`LOAD_LOCK_STATE_DIR`/`LOAD_LOCK_SOCKET`, probe the socket, then
`LLClient`), or simply script against the CLI. Concurrency rules to verify:
capacity is never exceeded by held+offered, FIFO order holds, duplicate
acquires are idempotent, and a daemon restart keeps tracked permits
alive. Label your adapter honestly in docs/COMPATIBILITY.md:
implemented / contract-tested / live-verified.
