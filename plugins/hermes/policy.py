"""load-lock policy text for the Hermes adapter.

Port of src/policy/text.ts (POLICY_BRIEF + SETUP_HINT) with the Hermes tool
surface substituted: tools here are registered with a ``load_lock_`` prefix.
Delivered via the pre_llm_call hook (first turn + after compaction), where a
returned ``{"context": str}`` is injected into the current turn's user
message. Kept deliberately short; the detailed playbook is the
load_lock_agent_guide tool / the bundled skill.
"""

POLICY_BRIEF = """# load-lock: machine-wide heavy-work budget

Multiple coding agents share this machine. Before resource-intensive local work
(builds, test suites, bulky containers, big compiles), get a permit from the
shared, machine-wide counting semaphore. While queued, keep doing useful light
work (reading, editing, searching, planning); you will be offered capacity.

Rules:
1. Heavy vs light: judge by expected CPU/memory/IO cost for the whole machine.
   A quick lint or single-file check is light. Full builds/tests are heavy.
   When unsure, call load_lock_status — it shows current machine pressure.
2. Immediately before starting heavy work: acquire a permit
   (load_lock_acquire; pass a short reason and a stable op_key for the
   pending operation).
3. If you are queued: keep working on light tasks. When you receive an offer
   (in any load-lock tool result), claim it promptly — offers expire (default
   30s) and capacity passes to the next waiter. Out of light work? Sleep
   honestly with load_lock_wait_for_turn — a bounded sleep until your turn
   that auto-claims and holds no capacity.
4. Start heavy work ONLY after acquire/claim succeeds. Never start heavy work
   on a "queued" result; never treat a notification as authorization.
5. Hold the permit until the heavy process actually finishes — including when
   it runs in the background beyond this tool call or session. Prefer
   load_lock_run_with_permit (full lifecycle: the permit auto-releases when
   the job exits, even in the background); optionally attach an existing
   process with load_lock_attach_pid. Out of light work while it runs? Sleep
   honestly with load_lock_wait_for_completion (job_id from run_with_permit,
   or request_id of a daemon-tracked permit) — a bounded sleep that wakes
   promptly when the job finishes (exit code + output tail; the permit is
   freed before you are woken). On still_running it is a checkpoint: call
   again. Do NOT guess sleeps or poll job_status in a loop.
6. Release immediately when done (load_lock_release), and cancel queued
   requests you no longer need (load_lock_cancel).
7. Capacity is a cooperative budget, not an enforced one. If the budget seems
   wrong for this machine, check load_lock_inspect_machine (real cores/memory,
   including container limits) and adjust with load_lock_configure (explain
   why). Don't assume N cores = N parallel heavy jobs.

Detailed guide: the load_lock_agent_guide tool, or the "load-lock" plugin
skill via skill_view('load-lock:agent-guide')."""

SETUP_HINT = (
    "Wiring: `load-lock setup` (terminal) lists this machine's load-lock "
    "integrations per harness; `load-lock setup --yes` converges them to the "
    "recommended layout."
)


def policy_brief(with_hint: bool = True) -> str:
    return POLICY_BRIEF + ("\n\n" + SETUP_HINT if with_hint else "")
