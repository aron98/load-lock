/**
 * load-lock policy text. One source of truth, delivered through each
 * harness's instruction mechanism:
 *
 *  - OpenCode plugin: injected via session "context" hook (every model call,
 *    compaction-proof) + registered skill for detail.
 *  - Claude Code: SessionStart hook stdout (matcher startup|resume|clear|compact|fork).
 *  - Codex CLI: SessionStart/SubagentStart hook stdout (needs /hooks trust).
 *  - MCP server: `instructions` field on every harness that surfaces it.
 *
 * Deliberately SHORT (spec: no noisy reminders). The detailed playbook lives
 * in the skill / docs/AGENT_GUIDE.md.
 */

export const POLICY_BRIEF = `# load-lock: machine-wide heavy-work budget

Multiple coding agents share this machine. Before resource-intensive local work
(builds, test suites, bulky containers, big compiles), get a permit from the
shared, machine-wide counting semaphore. While queued, keep doing useful light
work (reading, editing, searching, planning); you will be offered capacity.

Rules:
1. Heavy vs light: judge by expected CPU/memory/IO cost for the whole machine.
   A quick lint or single-file check is light. Full builds/tests are heavy.
   When unsure, call the status tool — it shows current machine pressure.
2. Immediately before starting heavy work: acquire a permit
   (tool: load-lock acquire, CLI: load-lock acquire). Pass a short reason and
   a stable op_key for the pending operation.
3. If you are queued: keep working on light tasks. When you receive an offer
   (in any load-lock tool result or a wakeup message), claim it promptly —
   offers expire (default 30s) and capacity passes to the next waiter.
   Out of light work? Sleep honestly with wait_for_turn (MCP/plugin) or
   'load-lock wait' (CLI) — a bounded sleep until your turn that
   auto-claims and holds no capacity.
4. Start heavy work ONLY after acquire/claim succeeds. Never start heavy work
   on a "queued" result; never treat a notification as authorization.
5. Hold the permit until the heavy process actually finishes — including when
   it runs in the background beyond this tool call or session. Optionally
   attach its pid (load-lock attach_pid) so a dead process auto-releases.
   Out of light work while it runs? Sleep honestly with wait_for_completion
   (MCP/plugin: run_with_permit job_id or tracked request_id; or run_with_permit
   with wait:true) or 'load-lock wait --job <request-id>' (CLI) — a bounded
   sleep that wakes promptly when the job finishes (exit code + output tail;
   the permit is freed before you are woken). On still_running it is a
   checkpoint: call again. Do NOT guess sleeps or poll job_status in a loop.
6. Release immediately when done (success or failure), and cancel queued
   requests you no longer need.
7. Capacity is a cooperative budget, not an enforced one. If the budget seems
   wrong for this machine, check load-lock inspect_machine (real cores/memory,
   including container limits) and adjust with configure (explain why). Don't
   assume N cores = N parallel heavy jobs.

Detailed guide: the "load-lock" skill or \`load-lock agent-guide\`.`;

/**
 * The one upgrade hint every rung carries (#47 ladder, #59): appended after
 * the brief in the MCP instructions and the session-start hook output.
 */
export const SETUP_HINT =
  "Wiring: `load-lock setup` lists this machine's load-lock integrations per harness; `load-lock setup --yes` converges them to the recommended layout (hooks for idle wakeups, policy that survives compaction).";

export function policyWithContext(statusSummary: string, configSummary?: string): string {
  let s = POLICY_BRIEF + "\n\n";
  s += statusSummary;
  if (configSummary) s += "\n" + configSummary;
  return s;
}

export function statusLine(st: {
  pools: { pool: string; capacity: number; used: number; holders: { agentLabel?: string; reason: string }[]; queue: unknown[] }[];
  cpu?: { effectiveCores?: number };
}): string {
  const parts: string[] = [];
  for (const p of st.pools) {
    const who = p.holders.map((h) => h.agentLabel || h.reason).join(", ");
    parts.push(
      `pool "${p.pool}": ${p.used}/${p.capacity} in use (held+offers)${p.queue.length ? `, ${p.queue.length} queued` : ""}${who ? `, held by: ${who}` : ""}`,
    );
  }
  return `load-lock status: ${parts.join("; ")}`;
}
