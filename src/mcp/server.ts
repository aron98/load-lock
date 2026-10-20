/**
 * load-lock MCP server (stdio) — the universal adapter for harnesses that
 * speak MCP (Claude Code, Codex CLI, Gemini CLI, Copilot CLI, Cline, Roo,
 * Goose, ...). Each harness session spawns one MCP server process; the
 * process-scoped agent identity routes offers back through tool results and
 * watch pushes.
 *
 * Notification honesty (see docs/COMPATIBILITY.md): MCP transports can
 * surface server-initiated *messages*, but most harnesses do not inject them
 * into the model's context. load-lock therefore relies on:
 *   (a) tool-boundary delivery — every acquire/claim/release/... response
 *       carries the agent's pending offers and queue positions;
 *   (b) bounded blocking wait in acquire (waitMs) and wait_for_turn
 *       (the "sleep until it is my turn" tool);
 *   (c) harness-specific idle wakeup (hooks/plugins) where verified.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { spawn, ChildProcess } from "node:child_process";

import { LLClient } from "../shared/client.js";
import { POLICY_BRIEF } from "../policy/text.js";
import { waitForTurn, WaitAbortedError } from "../shared/wait-turn.js";
import { killProcessGroup } from "../shared/transport.js";

const ACQUIRE_DESC = `Acquire a machine-wide permit before starting resource-intensive local work (full builds, test suites, big compiles/containers).

Pass a short reason and a stable op_key identifying the pending operation (duplicate acquires for the same op_key return the existing request — do not invent a new key while one is live). Set wait_ms (default a few seconds) to block briefly for capacity instead of returning queued immediately; keep doing light work while queued. You will receive an offer to claim when capacity frees. Never start heavy work while merely queued.`;

const CLAIM_DESC = `Claim an offered permit within its claim window (offers expire, default 30s, then capacity passes to the next waiter and your request pauses until you rejoin). Only a successful claim authorizes heavy work. After claiming you MUST begin execution within the start deadline (default 120s) — via run_with_permit (best: full process tracking incl. background jobs), attach_pid, or mark_started — or the permit is reclaimed automatically.`;

const RELEASE_DESC = `Release a held permit immediately after the heavy work finishes — success, failure, or termination (idempotent: releasing twice is fine). A permit survives the tool call and session that acquired it; automatic cleanup releases it when a tracked job exits or, for untracked permits, when your adapter stops heartbeating — but do not rely on that: release as soon as the work is done.`;

export interface McpServerOptions {
  client: LLClient;
  serverName?: string;
  /** Overridden by OpenCode's per-request session metadata when present. */
  agentId?: string;
}

export function buildServer(opts: McpServerOptions): McpServer {
  const client = opts.client;
  const defaultAgent = opts.agentId ?? "agt_" + process.pid.toString(36) + Math.random().toString(36).slice(2, 8);
  const server = new McpServer(
    { name: opts.serverName ?? "load-lock", version: "0.1.0" },
    { instructions: POLICY_BRIEF },
  );

  const json = (v: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(v, null, 2) }],
  });

  const agentIdOf = (input: { agent_id?: string }) => input.agent_id?.trim() || defaultAgent;

  server.registerTool(
    "acquire",
    {
      title: "Acquire heavy-work permit",
      description: ACQUIRE_DESC,
      inputSchema: {
        reason: z.string().describe("Why you need the machine (shown to other agents, e.g. 'cargo test --all in worktree feat-x')"),
        op_key: z.string().describe("Stable key for the pending operation (idempotency; e.g. 'wt-feat-x/cargo-test')"),
        agent_id: z.string().optional().describe("Override agent identity (rarely needed)"),
        label_prefix: z.string().optional().describe("Prefix prepended to your holder label so sandboxed clients are identifiable, e.g. 'omac' -> 'omac:<label>' (or set env LOAD_LOCK_LABEL_PREFIX)"),
        wait_ms: z.number().int().optional().describe("Bounded blocking wait for capacity, clamped by config (default 0)"),
        subscribe_if_busy: z.boolean().optional().describe("false = fail fast instead of queueing (default true)"),
        pool: z.string().optional().describe("Resource pool (default 'heavy')"),
      },
    },
    async (input) => {
      const res = await client.request("acquire", {
        pool: input.pool,
        agentId: agentIdOf(input),
        labelPrefix: input.label_prefix,
        cwd: process.cwd(),
        opKey: input.op_key,
        reason: input.reason,
        waitMs: input.wait_ms,
        subscribeIfBusy: input.subscribe_if_busy,
      });
      const e = res.entry ?? {};
      return json({
        state: res.state,
        request_id: e.requestId,
        pool: e.pool ?? input.pool ?? "heavy",
        queue_position: e.position,
        offer_token: e.offerToken,
        offer_expires_at: e.offerExpiresAt,
        permit_token: e.permitToken,
        start_deadline: e.startDeadline,
        reason: e.reason,
        next_action:
          res.state === "granted"
            ? "You hold the permit. Start the heavy work now via run_with_permit (best), attach_pid, or mark_started; release when done."
            : res.state === "offered"
              ? "You have a reserved offer: call claim(offer_token) NOW — it expires and capacity passes to the next waiter."
              : res.state === "queued"
                ? "Keep doing light work. Capacity will be offered to you in FIFO order; check pending() at tool boundaries or pass wait_ms next time."
                : "Your request was paused (offer expired or declined). Call rejoin(request_id) when ready to queue again.",
        entry: res.entry,
        pending: res.pending,
      });
    },
  );

  server.registerTool(
    "claim",
    {
      title: "Claim offered permit",
      description: CLAIM_DESC,
      inputSchema: { offer_token: z.string().describe("Token from your offer") },
    },
    async (input) => {
      const res = await client.request("claim", { offerToken: input.offer_token });
      const e = res.entry ?? {};
      return json({
        state: "held",
        request_id: e.requestId,
        permit_token: e.permitToken,
        phase: e.phase,
        start_deadline: e.startDeadline,
        next_action:
          "Permit claimed. Begin the heavy work before the start deadline: run_with_permit (best), attach_pid, or mark_started. Release when finished.",
        entry: res.entry,
      });
    },
  );

  server.registerTool(
    "release",
    {
      title: "Release permit",
      description: RELEASE_DESC,
      inputSchema: {
        permit_token: z.string().describe("Token from acquire/claim"),
        reason: z.string().optional().describe("Optional outcome note (e.g. 'tests passed')"),
      },
    },
    async (input) => {
      const res = await client.request("release", { permitToken: input.permit_token });
      return json({
        released_now: res.releasedNow,
        request_id: res.entry?.requestId,
        note: res.releasedNow ? "Permit released; queued agents will be offered capacity." : "Already released (idempotent).",
      });
    },
  );

  server.registerTool(
    "cancel",
    {
      title: "Cancel queued request",
      description: "Cancel a queued/offered/paused request you no longer need. Held permits must be released instead.",
      inputSchema: { request_id: z.string() },
    },
    async (input) => json(await client.request("cancel", { requestId: input.request_id })),
  );

  server.registerTool(
    "decline",
    {
      title: "Decline an offer",
      description: "Explicitly decline an offered permit (e.g. you are mid light-work and will rejoin later). Capacity passes to the next waiter immediately.",
      inputSchema: { offer_token: z.string() },
    },
    async (input) => json(await client.request("decline", { offerToken: input.offer_token })),
  );

  server.registerTool(
    "rejoin",
    {
      title: "Rejoin queue after pause",
      description: "Rejoin the FIFO queue after your offer expired or you declined. Paused requests never auto-recycle — rejoining is your explicit choice.",
      inputSchema: { request_id: z.string() },
    },
    async (input) => {
      const res = await client.request("rejoin", { requestId: input.request_id });
      return json({
        state: res.state,
        request_id: res.entry?.requestId,
        queue_position: res.entry?.position,
        offer_token: res.entry?.offerToken,
        next_action:
          res.state === "offered"
            ? "Capacity was free: you have a new offer — claim(offer_token) now."
            : `Queued at position ${res.entry?.position ?? "?"}; continue light work.`,
        entry: res.entry,
      });
    },
  );

  server.registerTool(
    "wait_for_turn",
    {
      title: "Sleep until it is your turn",
      description: `Bounded blocking sleep for one of your queued/offered/paused requests: "sleep until it is my turn". Returns a STRUCTURED result on every path — never an error for a normal resolution:
- granted: capacity reached you and the offer was AUTO-CLAIMED on your behalf (permit_token in entry, auto_claimed: true) — start the heavy work now;
- still_queued: timed out; you are still queued — queue_position, queue_length and holders (who is ahead of you) included; call wait_for_turn again to keep sleeping;
- paused: the offer expired or was declined meanwhile; next_action has rejoin instructions;
- cancelled: the request was cancelled/declined/reclaimed meanwhile;
- not_found: the request ended or the daemon restarted (queues are ephemeral); acquire again.
Input: request_id (default: your oldest offered, then front-most queued, then oldest paused request), timeout_ms (default 600000, clamped to the machine's maxTurnWaitMs config — get_config shows the cap). timeout_ms 0 = check-only. The wait holds NO permit and NO capacity (it is light work); cancelling this call is safe and never strands anything — you simply stop sleeping and the request keeps its queue position. A daemon restart mid-wait resolves promptly with not_found + re-acquire instructions.`,
      inputSchema: {
        request_id: z.string().optional().describe("Request to watch (default: your oldest offered/front-most queued/oldest paused request)"),
        timeout_ms: z.number().int().optional().describe("Bounded sleep (ms); default 600000, clamped to the machine's maxTurnWaitMs cap. 0 = check-only."),
        agent_id: z.string().optional().describe("Override agent identity (rarely needed)"),
      },
    },
    async (input, extra) => {
      try {
        const r = await waitForTurn({
          client,
          agentId: agentIdOf(input),
          requestId: input.request_id,
          timeoutMs: input.timeout_ms,
          signal: extra?.signal,
        });
        return json({
          state: r.state,
          request_id: r.requestId,
          auto_claimed: r.autoClaimed,
          permit_token: r.state === "granted" ? r.entry?.permitToken : undefined,
          waited_ms: r.waitedMs,
          effective_wait_ms: r.effectiveWaitMs,
          entry: r.entry,
          queue_position: r.queuePosition,
          queue_length: r.queueLength,
          holders: r.holders,
          next_action: r.nextAction,
          detail: r.detail,
        });
      } catch (err) {
        if (err instanceof WaitAbortedError) {
          return json({ state: "aborted", detail: "wait cancelled by the harness/caller; the request keeps its queue position" });
        }
        throw err;
      }
    },
  );

  server.registerTool(
    "pending",
    {
      title: "Your offers/queue/permits",
      description: "List your outstanding offers (claim these NOW — they expire), queue positions, paused and held requests.",
      inputSchema: { agent_id: z.string().optional() },
    },
    async (input) => json(await client.request("pending", { agentId: agentIdOf(input) })),
  );

  server.registerTool(
    "status",
    {
      title: "Semaphore status",
      description: "Machine-wide pool snapshot: capacity, holders, outstanding offers, FIFO queue, paused requests. Check this when deciding whether work is heavy vs light, or to see who is building.",
      inputSchema: { pool: z.string().optional() },
    },
    async (input) => json(await client.request("status", input.pool ? { pool: input.pool } : {})),
  );

  server.registerTool(
    "inspect_machine",
    {
      title: "Inspect machine resources",
      description: "Honest machine resources: effective CPU cores and memory INCLUDING cgroup/container limits, plus current pressure. Do not assume N logical cores = N parallel heavy jobs — quota-limited containers report fewer effective cores.",
      inputSchema: {},
    },
    async () => json(await client.request("inspect", {})),
  );

  server.registerTool(
    "get_config",
    {
      title: "Read config",
      description: "Current config: pools/capacity, offer timeout, heavy-work guidance, and change history with rationale.",
      inputSchema: {},
    },
    async () => json(await client.request("get_config", {})),
  );

  server.registerTool(
    "configure",
    {
      title: "Update config (CAS)",
      description:
        "Compare-and-swap config update so concurrent agents never silently overwrite each other. Read get_config, pass its version as expected_version, describe changes and a reason. Capacity decreases let current holders finish; increases admit queued requests immediately.",
      inputSchema: {
        expected_version: z.number().int(),
        changes: z
          .object({
            pools: z.record(z.string(), z.object({ capacity: z.number().int() })).optional(),
            offer_timeout_ms: z.number().int().optional(),
            max_wait_ms: z.number().int().optional(),
            max_turn_wait_ms: z.number().int().optional(),
            start_timeout_ms: z.number().int().optional(),
            untracked_lease_ms: z.number().int().optional(),
            guidance: z
              .object({
                heavy_work_heuristic: z.string().optional(),
                notes: z.string().optional(),
                agent: z
                  .object({ id: z.string(), parallelism: z.string().optional(), note: z.string().optional() })
                  .optional(),
              })
              .optional(),
          }),
        reason: z.string().describe("Why this change is right for this machine"),
        author: z.string().describe("Who you are, e.g. 'opencode session abc123'"),
      },
    },
    async (input) =>
      json(
        await client.request("configure", {
          expectedVersion: input.expected_version,
          changes: {
            ...input.changes,
            offerTimeoutMs: input.changes.offer_timeout_ms,
            maxWaitMs: input.changes.max_wait_ms,
            maxTurnWaitMs: input.changes.max_turn_wait_ms,
            startTimeoutMs: input.changes.start_timeout_ms,
            untrackedLeaseMs: input.changes.untracked_lease_ms,
            guidance: input.changes.guidance
              ? {
                  ...input.changes.guidance,
                  heavyWorkHeuristic: input.changes.guidance.heavy_work_heuristic,
                }
              : undefined,
          },
          reason: input.reason,
          author: input.author,
        }),
      ),
  );

  server.registerTool(
    "attach_pid",
    {
      title: "Attach pid to permit",
      description:
        "Associate a process you already started (e.g. a harness background task's shell) with your claimed permit. Atomic: fails if the permit was reclaimed. The permit is then released automatically when the process (and its process group) exits — including for background jobs. On Linux this is pid-reuse-safe via /proc start times. Prefer run_with_permit for full lifecycle ownership.",
      inputSchema: { permit_token: z.string(), pid: z.number().int().positive() },
    },
    async (input) => json(await client.request("attach_pid", { permitToken: input.permit_token, pid: input.pid })),
  );

  server.registerTool(
    "mark_started",
    {
      title: "Mark execution started (untracked)",
      description:
        "Tell load-lock you started the heavy work when you cannot associate a process (no run_with_permit, no attach_pid). The permit then runs on a heartbeat lease: this MCP server heartbeats automatically while your session lives; if your agent dies, the lease reclaims the permit. WEAKER GUARANTEE: if your process survives your dead session, another heavy job may overlap it. Prefer run_with_permit whenever possible.",
      inputSchema: { permit_token: z.string() },
    },
    async (input) => json(await client.request("mark_started", { permitToken: input.permit_token })),
  );

  // ---- execution helper: owns the process lifecycle end-to-end ----------

  const jobs = new Map<string, Job>();

  interface Job {
    id: string;
    child: ChildProcess;
    permitToken: string;
    command: string;
    startedAt: number;
    exited: boolean;
    exitCode: number | null;
    output: string[]; // ring buffer tail
  }

  server.registerTool(
    "run_with_permit",
    {
      title: "Run heavy command under permit",
      description:
        "Run the heavy command you hold a permit for, with full lifecycle ownership: spawns the command in its own process group, atomically associates it with your claimed permit, returns a job_id immediately (background execution — do NOT release the permit merely because this returned), and auto-releases the permit when the job exits (success, failure, or kill). Survives this tool call and your session: if this server dies, the daemon still watches the job's process group. Poll job_status for completion and output.",
      inputSchema: {
        permit_token: z.string().describe("Permit token from acquire/claim"),
        command: z.string().describe("Shell command to run (the heavy work you acquired the permit for — do not pass unrelated light commands)"),
        cwd: z.string().optional().describe("Working directory (default: this server's cwd)"),
      },
    },
    async (input) => {
      const child = spawn(input.command, {
        shell: true,
        detached: true, // own process group => pgid === child.pid on Linux
        cwd: input.cwd || process.cwd(),
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const job: Job = {
        id: "job_" + child.pid + "_" + Math.random().toString(36).slice(2, 8),
        child,
        permitToken: input.permit_token,
        command: input.command,
        startedAt: Date.now(),
        exited: false,
        exitCode: null,
        output: [],
      };
      // Watch for exit BEFORE associating (no awaits in between): a job that
      // exits instantly must not lose its exit event while we round-trip to
      // the daemon, or the permit would never be auto-released.
      const push = (buf: Buffer) => {
        job.output.push(buf.toString("utf8"));
        if (job.output.length > 200) job.output.shift();
      };
      child.stdout?.on("data", push);
      child.stderr?.on("data", push);
      child.on("exit", (code) => {
        job.exited = true;
        job.exitCode = code;
        // Auto-release on completion: success, failure, or termination.
        client
          .request("release", { permitToken: job.permitToken, outcome: code === 0 ? "success" : "failure" })
          .catch(() => {
            /* already released/reclaimed — idempotent path */
          });
      });
      // Atomic association; if the permit was reclaimed already, kill the job
      // before it can do meaningful work and report the failure.
      try {
        await client.request("start_job", {
          permitToken: input.permit_token,
          pid: child.pid,
          pgid: child.pid,
        });
      } catch (err) {
        killProcessGroup(child.pid!, "SIGKILL");
        return json({
          error: `permit no longer startable (${(err as Error).message}); job killed before doing work; acquire again`,
        });
      }
      jobs.set(job.id, job);
      return json({
        job_id: job.id,
        pid: child.pid,
        pgid: child.pid,
        state: "running",
        note: `Background job started under permit. Do NOT release the permit manually — it auto-releases when the job exits. Poll job_status(job_id) for completion; job_stop(job_id) to terminate.`,
      });
    },
  );

  server.registerTool(
    "job_status",
    {
      title: "Job status",
      description: "Poll a job started with run_with_permit: running/exited, exit code, recent output. The permit auto-released when the job exited.",
      inputSchema: { job_id: z.string() },
    },
    async (input) => {
      const job = jobs.get(input.job_id);
      if (!job) return json({ error: `unknown job_id (jobs live in this MCP server process; it restarted if missing)` });
      return json({
        job_id: job.id,
        command: job.command,
        running: !job.exited,
        exit_code: job.exitCode,
        output_tail: job.output.slice(-20).join(""),
      });
    },
  );

  server.registerTool(
    "job_stop",
    {
      title: "Stop job",
      description: "Terminate a job started with run_with_permit (SIGTERM to its process group, escalating to SIGKILL). The permit auto-releases once it exits.",
      inputSchema: { job_id: z.string() },
    },
    async (input) => {
      const job = jobs.get(input.job_id);
      if (!job) return json({ error: "unknown job_id" });
      if (!job.exited) {
        killProcessGroup(job.child.pid!, "SIGTERM");
        setTimeout(() => {
          if (!job.exited) {
            killProcessGroup(job.child.pid!, "SIGKILL");
          }
        }, 5_000).unref?.();
      }
      return json({ job_id: job.id, stopping: true });
    },
  );

  // Automatic adapter heartbeat: while this server process lives, untracked
  // permits of this agent keep their lease; if the harness session dies, the
  // lease lapses and the daemon reclaims. The model never has to remember.
  const heartbeat = setInterval(() => {
    void client.request("heartbeat", { agentId: defaultAgent }).catch(() => {
      /* daemon unreachable; next tool call reconnects */
    });
  }, 30_000);
  heartbeat.unref?.();

  return server;
}

export async function runStdioMcp(opts: { agentId?: string } = {}): Promise<void> {
  const client = new LLClient();
  await client.connect();
  // Keep a watch subscription so the connection persists and the daemon sees
  // liveness; offers are surfaced via tool results (tool-boundary delivery).
  const server = buildServer({ client, agentId: opts.agentId });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Keep the process alive on the open stdio transport.
  await new Promise<void>(() => {});
}
