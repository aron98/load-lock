// wait_for_completion (issue #36): bounded, honest "sleep until the job
// finishes" — the execution-phase counterpart of wait_for_turn.
//
// One shared client-side implementation serves the CLI `wait --job` command,
// the MCP `wait_for_completion` tool and the OpenCode plugin tool. Two
// mechanisms share the same result semantics:
//
//  - waitForLocalJob: adapter-parented jobs (run_with_permit children of the
//    MCP server / OpenCode plugin). The adapter awaits the child's exit
//    event directly — no polling, exact exit code + output tail on wake.
//  - waitForTrackedJob: daemon-tracked jobs (tracked by pid, daemon not the
//    parent). The daemon holds the call server-side (mirroring
//    wait_for_turn's bounded-sleep shape) and wakes it when the liveness
//    sweep observes the pid gone — always after the permit was released, so
//    the woken agent sees the pool freed. Old daemons without the method
//    degrade gracefully to a light client-side poll loop (same wire events,
//    same classification); a daemon restart mid-wait is retried within the
//    budget because tracked permits are reconciled from the journal.
//
// The wait holds no extra capacity, never blocks unbounded (bounded timeout
// + still_running checkpoints), and every resolution path returns a
// STRUCTURED result, not an error.

import {
  EntrySnapshot,
  EventsResult,
  GetConfigResult,
  MachineEvent,
  ProtocolError,
  StatusResult,
  WaitForCompletionResult,
} from "./protocol.js";
import { LLClient } from "./client.js";

/**
 * What adapters expose for a run_with_permit job so it can be waited on.
 * `exitPromise` must resolve when the child exits, and the exit handler must
 * assign `releasePromise` BEFORE resolving it, so a woken waiter can observe
 * the permit-release round-trip.
 */
export interface WaitableAdapterJob {
  id: string;
  /** The permit's request id, when known (for cross-referencing with the daemon). */
  requestId?: string;
  startedAt: number;
  exited: boolean;
  exitedAt?: number;
  exitCode?: number | null;
  output: string[];
  /** Set by job_stop before killing — a later wake reports stopped_by_request. */
  stopRequested?: boolean;
  /** True once the daemon confirmed the release RPC. */
  permitReleased?: boolean;
  /** Resolves with the child's exit code when it exits. */
  exitPromise?: Promise<number | null>;
  /** The permit-release round-trip started by the exit handler. */
  releasePromise?: Promise<unknown>;
}

export interface WaitForTrackedJobOpts {
  client: LLClient;
  /** The request id whose daemon-tracked job to wait for. */
  requestId: string;
  /**
   * Requested bound (ms), clamped to the machine's maxTurnWaitMs config.
   * 0 = check-only (immediate return). Default 600_000.
   */
  timeoutMs?: number;
  /** Poll cadence for the old-daemon fallback loop (default 200ms). */
  pollMs?: number;
  /** Caller cancellation — resolves as { state: "timeout" }; the job is untouched. */
  signal?: AbortSignal;
}

export interface WaitForLocalJobOpts {
  /**
   * Bound for this call (ms). 0 = check-only. Default 600_000. NOT clamped
   * by machine config — the adapter already has the exit event, so the wait
   * is bounded only by the caller's own budget (documented divergence).
   */
  timeoutMs?: number;
  /** Caller cancellation — resolves as { state: "timeout" }; the job is untouched. */
  signal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_POLL_MS = 200;
/** Slack on top of the wait budget for the daemon RPC round-trip itself. */
const RPC_SLACK_MS = 15_000;
/** Retry cadence while the daemon is unreachable mid-wait. */
const RETRY_MS = 500;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new Error("wait aborted by caller"));
    };
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

/** Race an RPC against caller cancellation. Never rejects on abort. */
async function withAbort<T>(p: Promise<T>, signal?: AbortSignal): Promise<{ aborted: true } | { aborted: false; value: T }> {
  if (!signal) return { aborted: false, value: await p };
  if (signal.aborted) return { aborted: true };
  return new Promise((resolve, reject) => {
    const onAbort = () => resolve({ aborted: true });
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve({ aborted: false, value });
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

function isUnknownWaitMethod(err: unknown): boolean {
  return (
    err instanceof ProtocolError &&
    err.code === "invalid" &&
    err.message.includes("unknown method") &&
    err.message.includes("wait_for_completion")
  );
}

function isUnavailable(err: unknown): boolean {
  return err instanceof ProtocolError && (err.code === "unavailable" || err.code === "internal");
}

function abortedResult(job: { id?: string; requestId?: string; startedAt?: number }, waitedMs: number): WaitForCompletionResult {
  return {
    state: "timeout",
    jobId: job.id,
    requestId: job.requestId,
    startedAt: job.startedAt,
    waitedMs,
    nextAction:
      "the wait was cancelled — the job is untouched; call wait_for_completion again to keep sleeping until it finishes",
    detail: "aborted by caller (AbortSignal / harness tool timeout)",
  };
}

// ---------------------------------------------------------------------------
// Daemon-tracked jobs

/**
 * Bounded blocking wait for a daemon-tracked job. Uses the daemon's
 * server-side wait_for_completion hold when available; falls back to a light
 * client-side poll against the SAME wire events on old daemons; retries
 * through transient daemon unavailability (tracked permits survive
 * restarts via the journal). Returns a structured result on every path.
 */
export async function waitForTrackedJob(opts: WaitForTrackedJobOpts): Promise<WaitForCompletionResult> {
  const { client, requestId, signal } = opts;
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const start = Date.now();

  // ---- clamp the wait budget to the machine config (as wait_for_turn does)
  let budget = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
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
  const effective = clamped ? { effectiveWaitMs: budget } : {};

  while (true) {
    const remaining = deadline ? Math.max(0, deadline - Date.now()) : 0;
    let rpc: Promise<unknown>;
    try {
      rpc = client.request("wait_for_completion", { requestId, timeoutMs: remaining }, remaining + RPC_SLACK_MS);
    } catch (err) {
      // Synchronous connect failures surface here too — same retry path.
      if (isUnavailable(err)) {
        if (deadline && Date.now() >= deadline) break;
        try {
          await sleep(RETRY_MS, signal);
        } catch {
          return { ...abortedResult({ requestId }, Date.now() - start), ...effective };
        }
        continue;
      }
      throw err;
    }
    let raced: { aborted: true } | { aborted: false; value: unknown };
    try {
      raced = await withAbort(rpc, signal);
    } catch (err) {
      if (isUnknownWaitMethod(err)) {
        // Old daemon without the server-side hold: degrade to the honest
        // client-side poll loop over the same wire events.
        return await waitForTrackedJobViaPoll(client, requestId, { start, deadline, pollMs, signal, effective });
      }
      if (isUnavailable(err)) {
        if (deadline && Date.now() >= deadline) break;
        try {
          await sleep(RETRY_MS, signal);
        } catch {
          return { ...abortedResult({ requestId }, Date.now() - start), ...effective };
        }
        continue;
      }
      throw err;
    }
    if (raced.aborted) {
      // The daemon-side timer bounds the dangling RPC; the job is untouched.
      return { ...abortedResult({ requestId }, Date.now() - start), ...effective };
    }
    const res = raced.value as WaitForCompletionResult;
    if (res.state === "job_unknown" && /daemon stopping/i.test(res.detail ?? "")) {
      // Transient: the daemon shut down mid-wait and said goodbye. Tracked
      // permits survive restarts via journal restore, so re-issue against
      // the next daemon rather than resolving — restart transparency must
      // not depend on whether the goodbye response gets delivered.
      if (deadline && Date.now() < deadline) {
        try {
          await sleep(RETRY_MS, signal);
        } catch {
          return { ...abortedResult({ requestId }, Date.now() - start), ...effective };
        }
        continue;
      }
      // Check-only or budget exhausted: fall through with the honest goodbye.
    }
    return {
      ...res,
      requestId: res.requestId ?? requestId,
      waitedMs: Date.now() - start, // cumulative across the whole call
      ...effective,
    };
  }

  // Budget exhausted while the daemon was unreachable — we can no longer
  // observe the job, so claim nothing: job_unknown, not still_running.
  return {
    state: "job_unknown",
    requestId,
    waitedMs: Date.now() - start,
    ...effective,
    nextAction: "the daemon stayed unreachable for the whole wait budget — check load-lock status, then wait_for_completion again",
    detail: "daemon unreachable for the entire wait budget",
  };
}

/**
 * Old-daemon fallback: wait-turn-style light poll over the same wire events.
 * status() holders are the per-iteration truth; the events pull classifies
 * how the request ended (no missed wakeups: the cursor is registered before
 * the first status pull).
 */
async function waitForTrackedJobViaPoll(
  client: LLClient,
  requestId: string,
  o: { start: number; deadline: number; pollMs: number; signal?: AbortSignal; effective: { effectiveWaitMs?: number } },
): Promise<WaitForCompletionResult> {
  const { start, deadline, pollMs, signal, effective } = o;

  // ---- no-missed-wakeup registration: cursor BEFORE the first status pull
  let cursor = 0;
  let sawDaemon = false; // any successful observation this call
  try {
    const head = (await client.request("events", { sinceEventId: Number.MAX_SAFE_INTEGER })) as EventsResult;
    sawDaemon = true;
    cursor = head.latestEventId ?? 0;
  } catch {
    /* transient — status() below still gives us truth */
  }

  while (true) {
    if (signal?.aborted) return { ...abortedResult({ requestId }, Date.now() - start), ...effective };

    // 1) Authoritative truth: is the request still a held tracked job?
    let held: EntrySnapshot | undefined;
    let statusOk = false;
    try {
      const st = (await client.request("status", {})) as StatusResult;
      statusOk = true;
      sawDaemon = true;
      for (const pool of st.pools) {
        const h = pool.holders.find((e) => e.requestId === requestId);
        if (h) {
          held = h;
          break;
        }
      }
    } catch {
      /* transient — retry on next iteration */
    }
    if (!statusOk) {
      // Truth unavailable this iteration — do not classify anything.
    } else if (held !== undefined) {
      if (held.phase !== "running_tracked") {
        return {
          state: "job_unknown",
          requestId,
          startedAt: held.startedAt,
          waitedMs: Date.now() - start,
          ...effective,
          nextAction:
            held.phase === "claimed"
              ? "permit is held but no process is attached yet — start the job first (run_with_permit / attach_pid / start_job)"
              : "permit is running untracked (no process association) — completion is not observable; attach a pid or poll your job directly",
          detail: `held permit in phase "${held.phase}"`,
        };
      }
    } else {
      // 2) Absent from holders: classify from events since the cursor.
      let classified: WaitForCompletionResult | undefined;
      let eventsOk = false;
      try {
        const r = (await client.request("events", { sinceEventId: cursor })) as EventsResult;
        eventsOk = true;
        sawDaemon = true;
        // Daemon restart: ids restart at 1. Tracked permits may have
        // survived via the journal — re-register the cursor and continue;
        // if they did not, the next iteration's absence says so.
        if (r.latestEventId < cursor) cursor = r.latestEventId;
        let newest: MachineEvent | undefined;
        for (const ev of r.events) {
          if (ev.id > cursor) cursor = ev.id;
          if (ev.entry?.requestId === requestId) newest = ev; // last wins = newest
        }
        if (newest) {
          const startedAt = newest.entry?.startedAt;
          const base = { requestId, startedAt, waitedMs: Date.now() - start, ...effective };
          if (newest.type === "released" || newest.type === "auto_released") {
            classified = {
              state: "finished",
              ...base,
              durationMs: startedAt !== undefined ? newest.ts - startedAt : undefined,
              permitReleased: true,
              nextAction: "job finished and the permit is released — capacity is free; proceed with the next step",
              detail: newest.detail,
            };
          } else if (newest.type === "reclaimed") {
            classified = (newest.detail ?? "").includes("admin")
              ? {
                  state: "stopped_by_request",
                  ...base,
                  nextAction: "the permit was force-released by an admin while you were waiting — re-acquire before running more heavy work",
                  detail: newest.detail,
                }
              : {
                  state: "job_unknown",
                  ...base,
                  nextAction: "the permit was reclaimed before completion could be observed — re-acquire before running more heavy work",
                  detail: newest.detail,
                };
          } else if (newest.type === "cancelled") {
            classified = {
              state: "job_unknown",
              ...base,
              nextAction: "the request was cancelled — re-acquire before running more heavy work",
              detail: newest.detail,
            };
          } else {
            classified = {
              state: "job_unknown",
              ...base,
              nextAction: "no tracked job is running for this request id — verify the id or acquire + start a job first",
              detail: `request is in state "${newest.entry?.state ?? "unknown"}" (last event: ${newest.type})`,
            };
          }
        }
      } catch {
        /* transient — retry on next iteration */
      }
      if (classified) return classified;
      if (eventsOk && held === undefined) {
        // Absent with no classifying event: nothing observable to wait on.
        return {
          state: "job_unknown",
          requestId,
          waitedMs: Date.now() - start,
          ...effective,
          nextAction: "no tracked job is running for this request id — it ended without a traceable event (or the daemon restarted)",
          detail: "request absent from holders with no classifying event",
        };
      }
    }

    // 3) Still running: bounded sleep, then loop (check-only breaks here).
    if (!deadline) break; // budget 0 = check-only
    const remain = deadline - Date.now();
    if (remain <= 0) break;
    try {
      await sleep(Math.min(pollMs, remain), signal);
    } catch {
      return { ...abortedResult({ requestId }, Date.now() - start), ...effective };
    }
  }

  if (!sawDaemon) {
    // The whole budget passed without one successful observation — we cannot
    // claim the job is still running. Claim nothing.
    return {
      state: "job_unknown",
      requestId,
      waitedMs: Date.now() - start,
      ...effective,
      nextAction: "the daemon stayed unreachable for the whole wait budget — check load-lock status, then wait_for_completion again",
      detail: "daemon unreachable for the entire wait budget",
    };
  }
  return {
    state: "still_running",
    requestId,
    waitedMs: Date.now() - start,
    ...effective,
    nextAction: "job still running — call wait_for_completion again to keep sleeping honestly",
    detail: "wait budget elapsed",
  };
}

// ---------------------------------------------------------------------------
// Adapter-parented jobs

/**
 * Bounded, event-driven wait for a run_with_permit child the adapter owns.
 * No polling: the child's exit event wakes the waiter directly, with the
 * exact exit code and output tail. The permit-release round-trip is awaited
 * before reporting finished, so permitReleased is truthful (the daemon
 * releases the permit before adapter waits wake by construction of the
 * adapters' exit handlers).
 */
export async function waitForLocalJob(job: WaitableAdapterJob, opts: WaitForLocalJobOpts = {}): Promise<WaitForCompletionResult> {
  const budget = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const signal = opts.signal;
  const start = Date.now();

  const summarize = (): WaitForCompletionResult => {
    const exitedAt = job.exitedAt ?? Date.now();
    let permitReleased = job.permitReleased === true;
    let detail = job.exited ? undefined : "job had no exit promise to await";
    if (job.releasePromise) {
      // Awaited by the caller below; reflect what we know now.
    } else if (!permitReleased) {
      detail = "job exited; the permit-release round-trip had not completed when the wait resolved — verify with status if in doubt";
    }
    const stopped = job.stopRequested === true;
    return {
      state: stopped ? "stopped_by_request" : "finished",
      jobId: job.id,
      requestId: job.requestId,
      exitCode: job.exitCode ?? null,
      outputTail: job.output.slice(-20).join(""),
      durationMs: exitedAt - job.startedAt,
      permitReleased,
      waitedMs: Date.now() - start,
      startedAt: job.startedAt,
      nextAction: stopped
        ? "the job was stopped via job_stop — the permit is released; re-run when you actually need the work"
        : "job finished and the permit is released — capacity is free; proceed with the next step",
      detail,
    };
  };

  const checkOnly = budget === 0;
  if (signal?.aborted) return abortedResult(job, 0);
  if (checkOnly) {
    if (job.exited) return summarize();
    return {
      state: "still_running",
      jobId: job.id,
      requestId: job.requestId,
      startedAt: job.startedAt,
      waitedMs: 0,
      nextAction: "job still running — call wait_for_completion again (with a timeout) to sleep until it finishes",
      detail: "check-only",
    };
  }
  if (job.exited) {
    // Already done: still await the release round-trip for truthfulness.
    if (job.releasePromise) {
      try {
        await job.releasePromise;
      } catch {
        /* release failed — summarize reports permitReleased as known */
      }
    }
    return summarize();
  }
  if (!job.exitPromise) {
    return {
      state: "job_unknown",
      jobId: job.id,
      requestId: job.requestId,
      startedAt: job.startedAt,
      waitedMs: Date.now() - start,
      nextAction: "this job has no exit hook to wait on — poll job_status instead, or re-run it via run_with_permit",
      detail: "job object carries no exitPromise",
    };
  }

  // The exit handler assigns releasePromise BEFORE resolving exitPromise, so
  // once exitPromise settles, releasePromise (if any) is visible here.
  const onExit = (async () => {
    try {
      await job.exitPromise!;
    } catch {
      /* treat a rejected exit promise as an exit */
    }
    const rp = job.releasePromise;
    if (rp) {
      try {
        await rp;
      } catch {
        /* release failed — summarize reports what we know */
      }
    }
  })();

  return await new Promise<WaitForCompletionResult>((resolve) => {
    let timer: NodeJS.Timeout | undefined;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      resolve(abortedResult(job, Date.now() - start));
    };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    // Bounded: the budget elapsed -> still_running checkpoint (never hang).
    timer = setTimeout(() => {
      cleanup();
      resolve({
        state: "still_running",
        jobId: job.id,
        requestId: job.requestId,
        startedAt: job.startedAt,
        waitedMs: Date.now() - start,
        nextAction: "job still running — call wait_for_completion again to keep sleeping honestly",
        detail: "wait budget elapsed",
      });
    }, budget);
    onExit.then(
      () => {
        cleanup();
        resolve(summarize());
      },
      () => {
        cleanup();
        resolve(summarize());
      },
    );
  });
}
