"""OpenAI-style JSON schemas for the load-lock Hermes tools.

Ported from the MCP server (src/mcp/server.ts) so every adapter presents the
same surface; parameter names, semantics and result conventions match the
load-lock playbook. Descriptions mention the envelope: results are JSON
strings with ``ok``/``exit_code`` plus the command's fields (exit_code 68 =
queued / still running — JSON still returned; 69 = offer/wait resolution).
"""

from __future__ import annotations

from typing import Any, Dict

ACQUIRE_DESC = """Acquire a machine-wide permit before starting resource-intensive local work (full builds, test suites, big compiles/containers).
Pass a short reason and a stable op_key identifying the pending operation (duplicate acquires for the same op_key return the existing request — do not invent a new key while one is live). Set wait_ms (default a few seconds) to block briefly for capacity instead of returning queued immediately; keep doing light work while queued. You will receive an offer to claim when capacity frees. Never start heavy work while merely queued.
On queued results (exit_code 68) keep working on light tasks; offers arrive in any load-lock tool result's "pending" section — claim promptly, they expire."""

CLAIM_DESC = """Claim an offered permit within its claim window (offers expire, default 30s, then capacity passes to the next waiter and your request pauses until you rejoin). Only a successful claim authorizes heavy work. After claiming you MUST begin execution within the start deadline (default 120s) — via load_lock_run_with_permit (best: full process tracking incl. background jobs), load_lock_attach_pid, or load_lock_mark_started — or the permit is reclaimed automatically."""

RELEASE_DESC = """Release a held permit immediately after the heavy work finishes — success, failure, or termination (idempotent: releasing twice is fine). A permit survives the tool call and session that acquired it; automatic cleanup releases it when a tracked job exits or, for untracked permits, when your session stops heartbeating (the plugin heartbeats while your session lives) — but do not rely on that: release as soon as the work is done."""

CANCEL_DESC = "Cancel a queued/offered/paused request you no longer need. Held permits must be released instead."

DECLINE_DESC = "Explicitly decline an offered permit (e.g. you are mid light-work and will rejoin later). Capacity passes to the next waiter immediately."

REJOIN_DESC = "Rejoin the FIFO queue after your offer expired or you declined. Paused requests never auto-recycle — rejoining is your explicit choice."

WAIT_FOR_TURN_DESC = """Bounded blocking sleep for one of your queued/offered/paused requests: "sleep until it is my turn". Returns a STRUCTURED result on every path — never an error for a normal resolution:
- granted: capacity reached you and the offer was AUTO-CLAIMED on your behalf (permit_token included, auto_claimed: true) — start the heavy work now;
- still_queued: timed out; you are still queued — queue_position, queue_length and holders (who is ahead of you) included; call again to keep sleeping;
- paused: the offer expired or was declined meanwhile; next_action has rejoin instructions;
- cancelled: the request was cancelled/declined/reclaimed meanwhile;
- not_found: the request ended or the daemon restarted (queues are ephemeral); acquire again.
Input: request_id (default: your oldest offered, then front-most queued, then oldest paused request), timeout_ms (default 600000, clamped to the machine's maxTurnWaitMs config — load_lock_get_config shows the cap). timeout_ms 0 = check-only. The wait holds NO permit and NO capacity (it is light work); a daemon restart mid-wait resolves promptly with not_found + re-acquire instructions."""

PENDING_DESC = "List your outstanding offers (claim these NOW — they expire), queue positions, paused and held requests."

STATUS_DESC = "Machine-wide pool snapshot: capacity, holders, outstanding offers, FIFO queue, paused requests. Check this when deciding whether work is heavy vs light, or to see who is building."

INSPECT_DESC = "Honest machine resources: effective CPU cores and memory INCLUDING cgroup/container limits, plus current pressure. Do not assume N logical cores = N parallel heavy jobs — quota-limited containers report fewer effective cores."

GET_CONFIG_DESC = "Current config: pools/capacity, offer timeout, heavy-work guidance, and change history with rationale."

CONFIGURE_DESC = """Compare-and-swap config update so concurrent agents never silently overwrite each other. Read load_lock_get_config, pass its version as expected_version, describe changes and a reason. Capacity decreases let current holders finish; increases admit queued requests immediately. This adapter applies at most one pool per call (adjust additional pools in separate calls, re-reading the version each time)."""

ATTACH_PID_DESC = "Associate a process you already started (e.g. a harness background task's shell) with your claimed permit. Atomic: fails if the permit was reclaimed. The permit is then released automatically when the process (and its process group) exits — including for background jobs. On Linux this is pid-reuse-safe via /proc start times. Prefer load_lock_run_with_permit for full lifecycle ownership."

MARK_STARTED_DESC = "Tell load-lock you started the heavy work when you cannot associate a process (no run_with_permit, no attach_pid). The permit then runs on a heartbeat lease: this plugin heartbeats automatically while your session lives; if your agent dies, the lease reclaims the permit. WEAKER GUARANTEE: if your process survives your dead session, another heavy job may overlap it. Prefer run_with_permit whenever possible."

RUN_WITH_PERMIT_DESC = """Run the heavy command you hold a permit for, with full lifecycle ownership: returns a job_id immediately (background execution — do NOT release the permit merely because this returned), and auto-releases the permit when the job exits (success, failure, or kill). The job runs in its own process group and survives this tool call and your session: if this agent process dies, the daemon still watches the job.
Set wait to true to sleep through execution in this one call (bounded by wait_timeout_ms; returns still_running on timeout — re-call), otherwise sleep via load_lock_wait_for_completion(job_id) and quick-check via load_lock_job_status."""

JOB_STATUS_DESC = "Poll a job started with load_lock_run_with_permit: running/exited, exit code, recent output. The permit auto-released when the job exited."

JOB_STOP_DESC = "Terminate a job started with load_lock_run_with_permit (SIGTERM to its process group, escalating to SIGKILL). The permit auto-releases once it exits."

WAIT_FOR_COMPLETION_DESC = """Bounded blocking sleep for the EXECUTION phase — "sleep honestly until my heavy job finishes", replacing sleep-and-poll cycles. Two mechanisms, selected by identifier:
- job_id of a load_lock_run_with_permit job: resolves on the job's exact exit event — prompt wake, exact exit code + output tail;
- request_id of any daemon-tracked permit (attach_pid etc.): the daemon holds the wait and wakes it when its liveness sweep observes the process gone (worst-case promptness: one sweep interval, default 5s; the permit is released BEFORE you are woken).
Returns a STRUCTURED result on every path — never an error for a normal resolution:
- finished: exit_code, output_tail, duration_ms, permit_released — the work is done, the permit is (being) freed;
- still_running: timed out mid-execution — a checkpoint; call again (long jobs = a handful of long sleeps, not a poll loop);
- job_unknown: no such job/request, or the permit was reclaimed/expired meanwhile;
- stopped_by_request: the job/permit was stopped by an explicit admin action.
Input: job_id OR request_id (one of them), timeout_ms (default 600000; 0 = check-only). The wait itself holds NO permit and NO capacity. A daemon restart mid-wait is handled transparently; worst case it resolves with job_unknown + re-check instructions."""

AGENT_GUIDE_DESC = "The detailed load-lock playbook (same text as `load-lock agent-guide`): heavy-vs-light heuristics, offer claiming, background jobs, configuration and recovery. Read it when the short policy is not enough. No daemon call."


def _str_param(description: str) -> Dict[str, Any]:
    return {"type": "string", "description": description}


def _int_param(description: str) -> Dict[str, Any]:
    return {"type": "integer", "description": description}


def _bool_param(description: str) -> Dict[str, Any]:
    return {"type": "boolean", "description": description}


SCHEMAS: Dict[str, Dict[str, Any]] = {
    "load_lock_acquire": {
        "name": "load_lock_acquire",
        "description": ACQUIRE_DESC,
        "parameters": {
            "type": "object",
            "properties": {
                "reason": _str_param("Why you need the machine (shown to other agents, e.g. 'cargo test --all in worktree feat-x')"),
                "op_key": _str_param("Stable key for the pending operation (idempotency; e.g. 'wt-feat-x/cargo-test')"),
                "agent_id": _str_param("Override agent identity (rarely needed)"),
                "label_prefix": _str_param("Prefix prepended to your holder label so sandboxed clients are identifiable"),
                "wait_ms": _int_param("Bounded blocking wait for capacity, clamped by config (default 0)"),
                "subscribe_if_busy": _bool_param("false = fail fast instead of queueing (default true)"),
                "pool": _str_param("Resource pool (default 'heavy')"),
            },
            "required": ["reason", "op_key"],
        },
    },
    "load_lock_claim": {
        "name": "load_lock_claim",
        "description": CLAIM_DESC,
        "parameters": {
            "type": "object",
            "properties": {"offer_token": _str_param("Token from your offer")},
            "required": ["offer_token"],
        },
    },
    "load_lock_release": {
        "name": "load_lock_release",
        "description": RELEASE_DESC,
        "parameters": {
            "type": "object",
            "properties": {
                "permit_token": _str_param("Token from acquire/claim"),
                "outcome": _str_param("Optional outcome note: 'success' or 'failure'"),
                "reason": _str_param("Optional outcome note (e.g. 'tests passed')"),
            },
            "required": ["permit_token"],
        },
    },
    "load_lock_cancel": {
        "name": "load_lock_cancel",
        "description": CANCEL_DESC,
        "parameters": {
            "type": "object",
            "properties": {"request_id": _str_param("Request to cancel")},
            "required": ["request_id"],
        },
    },
    "load_lock_decline": {
        "name": "load_lock_decline",
        "description": DECLINE_DESC,
        "parameters": {
            "type": "object",
            "properties": {"offer_token": _str_param("Token from the offer you are declining")},
            "required": ["offer_token"],
        },
    },
    "load_lock_rejoin": {
        "name": "load_lock_rejoin",
        "description": REJOIN_DESC,
        "parameters": {
            "type": "object",
            "properties": {"request_id": _str_param("Paused request to requeue")},
            "required": ["request_id"],
        },
    },
    "load_lock_wait_for_turn": {
        "name": "load_lock_wait_for_turn",
        "description": WAIT_FOR_TURN_DESC,
        "parameters": {
            "type": "object",
            "properties": {
                "request_id": _str_param("Request to watch (default: your oldest offered/front-most queued/oldest paused request)"),
                "timeout_ms": _int_param("Bounded sleep (ms); default 600000, clamped to the machine's maxTurnWaitMs cap. 0 = check-only."),
                "agent_id": _str_param("Override agent identity (rarely needed)"),
            },
            "required": [],
        },
    },
    "load_lock_pending": {
        "name": "load_lock_pending",
        "description": PENDING_DESC,
        "parameters": {
            "type": "object",
            "properties": {"agent_id": _str_param("Override agent identity (rarely needed)")},
            "required": [],
        },
    },
    "load_lock_status": {
        "name": "load_lock_status",
        "description": STATUS_DESC,
        "parameters": {
            "type": "object",
            "properties": {"pool": _str_param("Limit the snapshot to one pool (default: all)")},
            "required": [],
        },
    },
    "load_lock_inspect_machine": {
        "name": "load_lock_inspect_machine",
        "description": INSPECT_DESC,
        "parameters": {"type": "object", "properties": {}, "required": []},
    },
    "load_lock_get_config": {
        "name": "load_lock_get_config",
        "description": GET_CONFIG_DESC,
        "parameters": {"type": "object", "properties": {}, "required": []},
    },
    "load_lock_configure": {
        "name": "load_lock_configure",
        "description": CONFIGURE_DESC,
        "parameters": {
            "type": "object",
            "properties": {
                "expected_version": _int_param("Version from load_lock_get_config (compare-and-swap)"),
                "changes": {
                    "type": "object",
                    "description": "What to change; omitted keys stay unchanged",
                    "properties": {
                        "pools": {
                            "type": "object",
                            "description": "At most one entry: {\"<pool>\": {\"capacity\": <int>}}",
                            "additionalProperties": {
                                "type": "object",
                                "properties": {"capacity": _int_param("New capacity (maximum concurrent weight)")},
                                "required": ["capacity"],
                            },
                        },
                        "offer_timeout_ms": _int_param("Claim window for offers"),
                        "max_wait_ms": _int_param("Cap for acquire wait_ms"),
                        "max_turn_wait_ms": _int_param("Cap for wait sleeps (wait_for_turn / wait_for_completion)"),
                        "start_timeout_ms": _int_param("Start deadline after claim"),
                        "untracked_lease_ms": _int_param("Heartbeat lease for mark_started permits"),
                        "guidance": {
                            "type": "object",
                            "description": "Heavy-work guidance shown to agents",
                            "properties": {
                                "heavy_work_heuristic": _str_param("One-line heuristic: what counts as heavy on this machine"),
                                "notes": _str_param("Free-form notes (not applied by this adapter)"),
                                "agent": {
                                    "type": "object",
                                    "description": "Per-agent guidance (not applied by this adapter)",
                                    "properties": {
                                        "id": _str_param("Agent id"),
                                        "parallelism": _str_param("Recommended parallelism"),
                                        "note": _str_param("Note"),
                                    },
                                    "required": ["id"],
                                },
                            },
                        },
                    },
                },
                "reason": _str_param("Why this change is right for this machine"),
                "author": _str_param("Who you are, e.g. 'hermes session abc123'"),
            },
            "required": ["reason", "author"],
        },
    },
    "load_lock_attach_pid": {
        "name": "load_lock_attach_pid",
        "description": ATTACH_PID_DESC,
        "parameters": {
            "type": "object",
            "properties": {
                "permit_token": _str_param("Token from acquire/claim"),
                "pid": _int_param("Process id to attach (must be positive)"),
            },
            "required": ["permit_token", "pid"],
        },
    },
    "load_lock_mark_started": {
        "name": "load_lock_mark_started",
        "description": MARK_STARTED_DESC,
        "parameters": {
            "type": "object",
            "properties": {"permit_token": _str_param("Token from acquire/claim")},
            "required": ["permit_token"],
        },
    },
    "load_lock_run_with_permit": {
        "name": "load_lock_run_with_permit",
        "description": RUN_WITH_PERMIT_DESC,
        "parameters": {
            "type": "object",
            "properties": {
                "permit_token": _str_param("Permit token from acquire/claim"),
                "command": _str_param("Shell command to run (the heavy work you acquired the permit for — do not pass unrelated light commands)"),
                "cwd": _str_param("Working directory (default: the agent process's cwd)"),
                "wait": _bool_param("true = sleep through execution in this one call (bounded by wait_timeout_ms), returning exit code + output tail; false = background job_id"),
                "wait_timeout_ms": _int_param("Bounded sleep for wait:true (ms); default 600000. still_running on timeout — call load_lock_wait_for_completion again."),
            },
            "required": ["permit_token", "command"],
        },
    },
    "load_lock_job_status": {
        "name": "load_lock_job_status",
        "description": JOB_STATUS_DESC,
        "parameters": {
            "type": "object",
            "properties": {"job_id": _str_param("Job id from load_lock_run_with_permit")},
            "required": ["job_id"],
        },
    },
    "load_lock_job_stop": {
        "name": "load_lock_job_stop",
        "description": JOB_STOP_DESC,
        "parameters": {
            "type": "object",
            "properties": {"job_id": _str_param("Job id from load_lock_run_with_permit")},
            "required": ["job_id"],
        },
    },
    "load_lock_wait_for_completion": {
        "name": "load_lock_wait_for_completion",
        "description": WAIT_FOR_COMPLETION_DESC,
        "parameters": {
            "type": "object",
            "properties": {
                "job_id": _str_param("A load_lock_run_with_permit job_id (exact exit wake)"),
                "request_id": _str_param("A daemon-tracked permit's request_id (attach_pid etc.; liveness-sweep wake)"),
                "timeout_ms": _int_param("Bounded sleep (ms); default 600000. 0 = check-only. still_running on timeout — re-call."),
                "agent_id": _str_param("Override agent identity (rarely needed)"),
            },
            "required": [],
        },
    },
    "load_lock_agent_guide": {
        "name": "load_lock_agent_guide",
        "description": AGENT_GUIDE_DESC,
        "parameters": {"type": "object", "properties": {}, "required": []},
    },
}
