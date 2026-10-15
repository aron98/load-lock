/**
 * load-lock native plugin for OpenCode V2.
 *
 * Installed to ~/.config/opencode/plugins/load-lock/ (see cli/install.ts).
 * Provides:
 *  - native tools in the `load_lock` namespace (acquire/claim/release/...)
 *  - run_with_permit / job_status / job_stop: full execution lifecycle
 *  - automatic policy injection on every model call via the session
 *    "context" hook (compaction-proof by construction)
 *  - idle wakeup: daemon watch -> ctx.session.synthetic when an offer
 *    targets an OpenCode session
 *  - automatic per-session heartbeats (untracked leases never lapse while
 *    the OpenCode service lives; the model never has to remember)
 *  - a registered skill with the detailed agent guide
 */
import { Plugin } from "@opencode/plugin";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LLClient } from "../../shared/client.js";
import { POLICY_BRIEF } from "../../policy/text.js";

const client = new LLClient();
const knownSessions = new Set<string>();
const jobs = new Map<string, Job>();

interface Job {
  id: string;
  child: ChildProcess;
  permitToken: string;
  command: string;
  sessionID: string;
  exited: boolean;
  exitCode: number | null;
  output: string[];
}

async function statusBrief(): Promise<string> {
  try {
    const st = (await client.request("status", {})) as any;
    const parts = st.pools.map(
      (p: any) => `pool "${p.pool}": ${p.used}/${p.capacity} in use${p.queue.length ? `, ${p.queue.length} queued` : ""}`,
    );
    return `load-lock now: ${parts.join("; ")}.`;
  } catch {
    return `load-lock daemon unreachable; it auto-starts on the next load_lock tool call.`;
  }
}

const j = (v: unknown) => JSON.stringify(v, null, 2);

function toolContent(v: unknown) {
  return { content: [{ type: "text" as const, text: j(v) }] };
}

export default Plugin.define({
  id: "load-lock",
  setup(ctx) {
    // ------------------------------------------------------------- tools
    ctx.tool.transform((editor) => {
      editor.namespace({
        name: "load_lock",
        description:
          "Machine-wide heavy-work budget shared by all agents on this machine. Acquire before heavy work; claim offers promptly; release when done.",
      });

      const add = (
        name: string,
        description: string,
        input: Record<string, unknown>,
        execute: (input: any, context: any) => unknown,
      ) =>
        editor.add({
          name,
          description,
          input: { type: "object", properties: input, ...inputSchemaBase(input) },
          options: { namespace: "load_lock" },
          execute: async (input: any, context: any) => {
            knownSessions.add(context.sessionID);
            const r = await execute(input, context);
            return toolContent(r);
          },
        });

      add(
        "acquire",
        "Acquire a machine-wide permit before resource-intensive local work (full builds, test suites). Returns granted (start heavy work now), or queued (do light work meanwhile; you'll get an offer). Idempotent per op_key. After a grant you MUST start execution within the start deadline via run_with_permit / attach_pid / mark_started.",
        {
          reason: { type: "string", description: "Why you need the machine (shown to other agents)" },
          op_key: { type: "string", description: "Stable key for the pending operation (idempotency)" },
          wait_ms: { type: "number", description: "Bounded blocking wait for capacity (optional)" },
          pool: { type: "string", description: "Resource pool (default 'heavy')" },
        },
        (input, context) =>
          client
            .request("acquire", {
              pool: input.pool,
              agentId: context.sessionID,
              agentLabel: "opencode:" + (context.agent?.name ?? "agent"),
              cwd: ctx.location.directory,
              opKey: input.op_key,
              reason: input.reason,
              waitMs: input.wait_ms,
            })
            .then((res: any) => ({
              state: res.state,
              request_id: res.entry?.requestId,
              queue_position: res.entry?.position,
              offer_token: res.entry?.offerToken,
              offer_expires_at: res.entry?.offerExpiresAt,
              permit_token: res.entry?.permitToken,
              start_deadline: res.entry?.startDeadline,
              next_action:
                res.state === "granted"
                  ? "You hold the permit. Start heavy work now via run_with_permit (best), attach_pid, or mark_started."
                  : res.state === "offered"
                    ? "You have a reserved offer: call claim(offer_token) NOW before it expires."
                    : res.state === "queued"
                      ? "Continue light work; you'll be offered capacity in FIFO order."
                      : "Paused; call rejoin(request_id) when ready.",
              entry: res.entry,
              pending: res.pending,
            })),
      );

      add(
        "claim",
        "Claim an offered permit within its claim window (offers expire, default 30s). Only a successful claim authorizes heavy work. Then start execution (run_with_permit / attach_pid / mark_started) before the start deadline.",
        { offer_token: { type: "string" } },
        (input) =>
          client.request("claim", { offerToken: input.offer_token }).then((res: any) => ({
            state: "held",
            request_id: res.entry?.requestId,
            permit_token: res.entry?.permitToken,
            phase: res.entry?.phase,
            start_deadline: res.entry?.startDeadline,
            next_action: "Permit claimed. Start the heavy work before the start deadline (run_with_permit / attach_pid / mark_started).",
            entry: res.entry,
          })),
      );

      add(
        "release",
        "Release a held permit when the heavy work finishes (idempotent). Auto-release also happens when a tracked job exits — but release promptly yourself.",
        { permit_token: { type: "string" } },
        (input) =>
          client.request("release", { permitToken: input.permit_token }).then((res: any) => ({
            released_now: res.releasedNow,
            request_id: res.entry?.requestId,
            note: res.releasedNow ? "Permit released; queued agents will be offered capacity." : "Already released (idempotent).",
          })),
      );

      add(
        "cancel",
        "Cancel a queued/offered/paused request you no longer need.",
        { request_id: { type: "string" } },
        (input) => client.request("cancel", { requestId: input.request_id }),
      );

      add(
        "rejoin",
        "Rejoin the FIFO queue after your offer expired or you declined (paused requests never auto-recycle).",
        { request_id: { type: "string" } },
        (input) => client.request("rejoin", { requestId: input.request_id }),
      );

      add(
        "pending",
        "Your outstanding offers (claim NOW — they expire), queue positions, paused and held requests.",
        {},
        (_input, context) => client.request("pending", { agentId: context.sessionID }),
      );

      add("status", "Machine-wide pool snapshot: capacity, holders, offers, queue.", { pool: { type: "string" } }, (input) =>
        client.request("status", input.pool ? { pool: input.pool } : {}),
      );

      add("inspect_machine", "Honest machine resources incl. cgroup/container limits and current pressure.", {}, () =>
        client.request("inspect", {}),
      );

      add("get_config", "Current config and change history.", {}, () => client.request("get_config", {}));

      add(
        "configure",
        "Compare-and-swap config update (capacity, offer timeout, start deadline, lease, guidance). Read get_config first; pass its version as expected_version; explain your reason.",
        {
          expected_version: { type: "number" },
          changes: { type: "object" },
          reason: { type: "string" },
        },
        (input, context) =>
          client.request("configure", {
            expectedVersion: input.expected_version,
            changes: input.changes,
            reason: input.reason,
            author: "opencode:" + context.sessionID,
          }),
      );

      add(
        "run_with_permit",
        "Run the heavy command you hold a permit for, with full lifecycle ownership: spawns it in its own process group, atomically associates it with the permit, returns a job_id immediately (background), and auto-releases the permit when the job exits. Do NOT release manually for these jobs. Poll job_status.",
        {
          permit_token: { type: "string" },
          command: { type: "string", description: "The heavy shell command (not unrelated light commands)" },
          cwd: { type: "string" },
        },
        async (input, context) => {
          const child = spawn(input.command, {
            shell: true,
            detached: true,
            cwd: input.cwd || ctx.location.directory,
            env: process.env,
            stdio: ["ignore", "pipe", "pipe"],
          });
          const job: Job = {
            id: "job_" + child.pid + "_" + Math.random().toString(36).slice(2, 8),
            child,
            permitToken: input.permit_token,
            command: input.command,
            sessionID: context.sessionID,
            exited: false,
            exitCode: null,
            output: [],
          };
          const push = (b: Buffer) => {
            job.output.push(b.toString("utf8"));
            if (job.output.length > 200) job.output.shift();
          };
          child.stdout?.on("data", push);
          child.stderr?.on("data", push);
          // Watch for exit BEFORE associating (no awaits in between): a job
          // that exits instantly must not lose its exit event while we
          // round-trip to the daemon, or the permit would never auto-release.
          child.on("exit", (code) => {
            job.exited = true;
            job.exitCode = code;
            void client.request("release", { permitToken: job.permitToken, outcome: code === 0 ? "success" : "failure" }).catch(() => {});
          });
          try {
            await client.request("start_job", { permitToken: input.permit_token, pid: child.pid, pgid: child.pid });
          } catch (err) {
            try {
              process.kill(-child.pid!, "SIGKILL");
            } catch {
              /* already gone */
            }
            return { error: `permit no longer startable (${(err as Error).message}); job killed before doing work; acquire again` };
          }
          jobs.set(job.id, job);
          return { job_id: job.id, pid: child.pid, state: "running", note: "auto-releases when the job exits; poll job_status" };
        },
      );

      add("job_status", "Poll a run_with_permit job: running/exited, exit code, output tail.", { job_id: { type: "string" } }, (input) => {
        const job = jobs.get(input.job_id);
        if (!job) return { error: "unknown job_id" };
        return {
          job_id: job.id,
          command: job.command,
          running: !job.exited,
          exit_code: job.exitCode,
          output_tail: job.output.slice(-20).join(""),
        };
      });

      add("job_stop", "Terminate a run_with_permit job (SIGTERM then SIGKILL to its process group).", { job_id: { type: "string" } }, (input) => {
        const job = jobs.get(input.job_id);
        if (!job) return { error: "unknown job_id" };
        if (!job.exited) {
          try {
            process.kill(-job.child.pid!, "SIGTERM");
          } catch {
            /* already gone */
          }
          setTimeout(() => {
            if (!job.exited) {
              try {
                process.kill(-job.child.pid!, "SIGKILL");
              } catch {
                /* already gone */
              }
            }
          }, 5000).unref?.();
        }
        return { job_id: job.id, stopping: true };
      });

      add(
        "attach_pid",
        "Associate a process you already started (e.g. a background shell task) with your claimed permit. Atomic; auto-releases when the process group exits.",
        { permit_token: { type: "string" }, pid: { type: "number" } },
        (input) => client.request("attach_pid", { permitToken: input.permit_token, pid: input.pid }),
      );

      add(
        "mark_started",
        "Tell load-lock you started the work when no process can be associated. Weaker guarantee: heartbeat lease applies (see docs). Prefer run_with_permit.",
        { permit_token: { type: "string" } },
        (input) => client.request("mark_started", { permitToken: input.permit_token }),
      );
    });

    // ------------------------------------------- policy on every model call
    void ctx.session.hook("context", async (event) => {
      event.system.push({ type: "text", text: POLICY_BRIEF + "\n\n" + (await statusBrief()) });
    });

    // -------------------------------------------------- idle wakeup via watch
    void (async () => {
      try {
        await client.connect();
      } catch {
        return; // next tool call will retry
      }
      await client.watch("*", async (ev: any) => {
        if (ev.type !== "offered" || !ev.targetAgent) return;
        if (!knownSessions.has(ev.targetAgent)) return; // not an OpenCode session we serve
        const token = ev.offerToken;
        const seconds = Math.max(0, Math.round(((ev.entry?.offerExpiresAt ?? Date.now()) - Date.now()) / 1000));
        try {
          await ctx.session.synthetic({
            sessionID: ev.targetAgent,
            text:
              `load-lock: capacity for "${ev.entry?.pool}" was reserved for your request (op "${ev.entry?.opKey}"). ` +
              `It expires in ~${seconds}s. Call load_lock_claim with offer_token "${token}" now, then start your heavy work.`,
            description: "load-lock permit offer",
          });
        } catch {
          /* session may be gone */
        }
      });
    })();

    // -------------------------------------------- automatic heartbeats
    const hb = setInterval(() => {
      for (const s of knownSessions) {
        void client.request("heartbeat", { agentId: s }).catch(() => {});
      }
    }, 30_000);
    hb.unref?.();

    // ------------------------------------------------------------ skill
    try {
      const skillContent = SKILL_CONTENT();
      const skillFile = path.join(os.tmpdir(), "load-lock-skill.md");
      try {
        if (fs.readFileSync(skillFile, "utf8") !== skillContent) {
          fs.writeFileSync(skillFile, skillContent);
        }
      } catch {
        fs.writeFileSync(skillFile, skillContent);
      }
      ctx.skill.transform((editor) => {
        editor.add({
          id: "load-lock" as any,
          name: "load-lock coordination" as any,
          description:
            "Detailed guide for the machine-wide heavy-work semaphore: heavy-vs-light heuristics, offer claiming, background jobs, configuration and recovery.",
          path: skillFile as any,
          content: skillContent,
        });
      });
    } catch {
      /* skill API optional */
    }

    return () => {
      clearInterval(hb);
      client.close();
    };
  },
});

function inputSchemaBase(input: Record<string, unknown>): Record<string, unknown> {
  const required = Object.entries(input)
    .filter(([, v]) => (v as any)?.required === true)
    .map(([k]) => k);
  return required.length ? { required } : {};
}

function SKILL_CONTENT(): string {
  // The full guide ships in docs/AGENT_GUIDE.md next to the package dist.
  try {
    const p = path.join(import.meta.dirname ?? ".", "..", "..", "docs", "AGENT_GUIDE.md");
    if (fs.existsSync(p)) return fs.readFileSync(p, "utf8");
  } catch {
    /* fall through */
  }
  return POLICY_BRIEF;
}
