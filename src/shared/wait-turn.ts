// wait_for_turn (issue #11): bounded, honest "sleep until it is my turn".
//
// One shared client-side implementation serves the CLI `wait` command, the
// MCP `wait_for_turn` tool and the OpenCode plugin's
// `load_lock_wait_for_turn` tool. The wait is deliberately CLIENT-side:
//
//   - it holds no permit and consumes no capacity (light work by design);
//   - cancelling the caller (AbortSignal / MCP cancellation / harness tool
//     timeout) just stops the local loop — there is no daemon-side waiter
//     to orphan, so daemon `pending` stays clean by construction;
//   - it survives transient daemon unavailability (each iteration retries)
//     and detects a daemon restart mid-wait, resolving bounded instead of
//     hanging (queued requests do not outlive a daemon restart).
//
// No-missed-wakeup registration: we capture the events cursor BEFORE the
// first `pending` snapshot. Every machine transition emits exactly one
// event, so any state change visible in the snapshot is either already in
// the cursor's past or will be delivered by a subsequent events pull — the
// poll loop can never sleep through its own turn.

import {
  EntrySnapshot,
  EventsResult,
  GetConfigResult,
  MachineEvent,
  OwnerEntrySnapshot,
  PendingResult,
  StatusResult,
  WaitForTurnResult,
} from "./protocol.js";
import { LLClient } from "./client.js";

/** Thrown when the caller aborts the wait (AbortSignal). Benign — never an error surface. */
export class WaitAbortedError extends Error {
  constructor() {
    super("wait aborted by caller");
    this.name = "AbortError";
  }
}

export interface WaitForTurnOpts {
  client: LLClient;
  /** Agent identity whose requests we watch. */
  agentId: string;
  /** Explicit request id; defaults to the caller's oldest offered, then queued, then paused request. */
  requestId?: string;
  /** Requested bound (ms). Clamped to the machine's maxTurnWaitMs config. 0 = check-only. */
  timeoutMs?: number;
  /** Default bound when timeout_ms omitted (before clamping). */
  defaultTimeoutMs?: number;
  /** Poll cadence for the light events/pending pulls (default 200ms). */
  pollMs?: number;
  /** Caller cancellation — resolves the wait as soon as it fires. */
  signal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_POLL_MS = 200;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new WaitAbortedError());
    };
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

/**
 * Bounded blocking wait for a queued request to reach this caller's turn.
 * Resolves with a STRUCTURED result on every path — granted (with the
 * permit auto-claimed), still_queued (timeout: position + holders), paused,
 * cancelled, or not_found (e.g. daemon restarted) — never with an opaque
 * error where a result is expressible.
 */
export async function waitForTurn(opts: WaitForTurnOpts): Promise<WaitForTurnResult> {
  const client = opts.client;
  const agentId = opts.agentId;
  const signal = opts.signal;
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const start = Date.now();

  if (signal?.aborted) throw new WaitAbortedError();

  // ---- resolve the target request (before anything time-consuming) ----
  let requestId = opts.requestId;
  let targetPool: string | undefined;
  if (!requestId) {
    const pending = (await client.request("pending", { agentId })) as PendingResult;
    // Priority: an outstanding offer (claim window is ticking!), then the
    // head-most queued entry, then the oldest paused entry.
    const offered = pending.offers[0];
    const queued = [...pending.queue].sort((a, b) => (a.position ?? 1) - (b.position ?? 1))[0];
    const paused = pending.paused[0];
    const target = offered ?? queued ?? paused;
    if (!target) {
      return {
        state: "not_found",
        waitedMs: 0,
        nextAction: "No queued, offered or paused request found for this agent — acquire one first (load_lock acquire).",
      };
    }
    requestId = target.requestId;
    targetPool = target.pool;
  }

  // ---- clamp the wait budget to the machine config ----
  let budget = opts.timeoutMs ?? opts.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  let clamped = false;
  try {
    const cfg = (await client.request("get_config", {})) as GetConfigResult;
    const cap = cfg.config?.maxTurnWaitMs;
    if (typeof cap === "number" && budget > cap) {
      budget = cap;
      clamped = true;
    }
  } catch {
    /* config unreadable right now — proceed with the caller's budget */
  }
  const deadline = budget > 0 ? start + budget : 0; // budget 0 = check-only
  const checkOnly = budget === 0;

  // ---- atomic registration: cursor BEFORE the first pending snapshot ----
  // MAX_SAFE_INTEGER asks for "just the latest cursor" without events.
  let cursor = 0;
  try {
    const head = (await client.request("events", {
      agentId,
      sinceEventId: Number.MAX_SAFE_INTEGER,
    })) as EventsResult;
    cursor = head.latestEventId ?? 0;
  } catch {
    /* transient — pending() below still gives us truth */
  }

  let queuePosition: number | undefined;
  let queueLength: number | undefined;
  let holders: EntrySnapshot[] | undefined;

  while (true) {
    if (signal?.aborted) throw new WaitAbortedError();
    if (deadline && Date.now() >= deadline) break;

    // 1) Drain events addressed to us since the cursor. Cheap (local UDS).
    try {
      const r = (await client.request("events", { agentId, sinceEventId: cursor })) as EventsResult;
      // New daemon instance: ids restart at 1, so a latestEventId below our
      // cursor (or an explicit daemon_started/daemon_recovered event) means
      // the wait crossed a restart. Queued requests do not survive it.
      if (r.latestEventId < cursor) {
        return {
          state: "not_found",
          requestId,
          waitedMs: Date.now() - start,
          ...(clamped ? { effectiveWaitMs: budget } : {}),
          nextAction: "The load-lock daemon restarted mid-wait and queued requests do not survive restarts. acquire again, then wait_for_turn.",
          detail: `daemon restart detected (event cursor went ${cursor} -> ${r.latestEventId})`,
        };
      }
      for (const ev of r.events as MachineEvent[]) {
        if (ev.id > cursor) cursor = ev.id;
        if (ev.type === "daemon_started" || ev.type === "daemon_recovered") {
          return {
            state: "not_found",
            requestId,
            waitedMs: Date.now() - start,
            ...(clamped ? { effectiveWaitMs: budget } : {}),
            nextAction: "The load-lock daemon restarted mid-wait and queued requests do not survive restarts. acquire again, then wait_for_turn.",
            detail: `daemon restart detected (${ev.type} event)`,
          };
        }
        const evReq = (ev as any).entry?.requestId;
        if (evReq !== requestId) continue;
        if (ev.type === "cancelled" || ev.type === "declined" || ev.type === "reclaimed") {
          return {
            state: "cancelled",
            requestId,
            waitedMs: Date.now() - start,
            ...(clamped ? { effectiveWaitMs: budget } : {}),
            nextAction:
              ev.type === "reclaimed"
                ? "The permit was reclaimed (start deadline or lease exceeded). acquire again with a fresh op_key."
                : "The request was cancelled. acquire again when you are ready.",
            detail: `request ended via ${ev.type} event while waiting`,
          };
        }
      }
    } catch {
      /* transient RPC failure — pending() below is the source of truth */
    }

    // 2) pending() is the authoritative per-iteration truth.
    try {
      const pending = (await client.request("pending", { agentId })) as PendingResult;
      const entry =
        pending.offers.find((e) => e.requestId === requestId) ??
        pending.queue.find((e) => e.requestId === requestId) ??
        pending.paused.find((e) => e.requestId === requestId) ??
        pending.held.find((e) => e.requestId === requestId);

      if (!entry) {
        // Absent from the owner's own pending set — the request ended
        // (released / cancelled / pruned) or the daemon restarted and the
        // ephemeral queue is gone. Either way it will not come back.
        return {
          state: "not_found",
          requestId,
          waitedMs: Date.now() - start,
          ...(clamped ? { effectiveWaitMs: budget } : {}),
          nextAction: "Request not found — it ended, was cancelled, or the daemon restarted (queues are ephemeral). acquire again, then wait_for_turn.",
          detail: "request disappeared from pending while waiting",
        };
      } else {
        targetPool = entry.pool;
        if (entry.state === "offered") {
          // Our turn! Claim inside the offer window, explicitly on the caller's behalf.
          try {
            const claimed = (await client.request("claim", { offerToken: entry.offerToken })) as any;
            return {
              state: "granted",
              requestId,
              autoClaimed: true,
              waitedMs: Date.now() - start,
              ...(clamped ? { effectiveWaitMs: budget } : {}),
              entry: claimed.entry as OwnerEntrySnapshot,
              nextAction: "Permit claimed for you — start the heavy work now (mark_started / attach_pid, release when done).",
            };
          } catch {
            /* claim raced (expiry or another claim) — fall through to truth */
          }
        } else if (entry.state === "held") {
          // Already holding (e.g. granted between our registration and here).
          return {
            state: "granted",
            requestId,
            autoClaimed: false,
            waitedMs: Date.now() - start,
            ...(clamped ? { effectiveWaitMs: budget } : {}),
            entry,
            nextAction: "You already hold the permit — start the heavy work now (mark_started / attach_pid, release when done).",
          };
        } else if (entry.state === "paused") {
          return {
            state: "paused",
            requestId,
            waitedMs: Date.now() - start,
            ...(clamped ? { effectiveWaitMs: budget } : {}),
            entry,
            nextAction: "The offer expired or was declined and the request is paused. rejoin (load_lock rejoin) when you are ready to wait again.",
          };
        } else if (entry.state === "queued") {
          queuePosition = entry.position;
          queueLength = pending.queue.length;
        }
      }
    } catch {
      /* transient — retry on next iteration */
    }

    // 3) Not our turn yet: light sleep, then loop.
    if (checkOnly) break;
    const remain = deadline ? deadline - Date.now() : pollMs;
    if (remain <= 0) break;
    await sleep(Math.min(pollMs, remain), signal);
  }

  // ---- timed out (or check-only): still_queued with position + holders ----
  let entry: OwnerEntrySnapshot | undefined;
  try {
    const pending = (await client.request("pending", { agentId })) as PendingResult;
    const found =
      pending.queue.find((e) => e.requestId === requestId) ??
      pending.paused.find((e) => e.requestId === requestId) ??
      pending.held.find((e) => e.requestId === requestId);
    if (found) {
      entry = found;
      targetPool = found.pool;
      if (found.state === "held") {
        return {
          state: "granted",
          requestId,
          autoClaimed: false,
          waitedMs: Date.now() - start,
          ...(clamped ? { effectiveWaitMs: budget } : {}),
          entry: found,
          nextAction: "You already hold the permit — start the heavy work now (mark_started / attach_pid, release when done).",
        };
      }
      if (found.state === "paused") {
        return {
          state: "paused",
          requestId,
          waitedMs: Date.now() - start,
          ...(clamped ? { effectiveWaitMs: budget } : {}),
          entry: found,
          nextAction: "The offer expired or was declined and the request is paused. rejoin (load_lock rejoin) when you are ready to wait again.",
        };
      }
      if (found.state === "queued") {
        queuePosition = found.position;
        queueLength = pending.queue.length;
      }
    }
    if (targetPool) {
      const st = (await client.request("status", { pool: targetPool })) as StatusResult;
      const pool = st.pools.find((p) => p.pool === targetPool);
      if (pool) {
        holders = pool.holders;
        queueLength = queueLength ?? pool.queue.length;
      }
    }
  } catch {
    /* best-effort enrichment */
  }

  if (!entry) {
    return {
      state: "not_found",
      requestId,
      waitedMs: Date.now() - start,
      ...(clamped ? { effectiveWaitMs: budget } : {}),
      nextAction: "Request not found — it may have ended or been cancelled, or the daemon restarted. acquire again.",
    };
  }

  return {
    state: "still_queued",
    requestId,
    waitedMs: Date.now() - start,
    ...(clamped ? { effectiveWaitMs: budget } : {}),
    entry,
    queuePosition,
    queueLength,
    holders,
    nextAction: `Still queued at position ${queuePosition ?? "?"} of ${queueLength ?? "?"} — call wait_for_turn again to keep sleeping, or cancel to give up. This wait held no capacity.`,
  };
}
