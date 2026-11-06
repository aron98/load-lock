"""load-lock tool implementations for the Hermes adapter.

Every tool shells out to the resolved load-lock CLI with ``--json`` (see
runtime.py for the resolution ladder) and normalizes the result into a single
JSON envelope that the model can rely on:

  {"ok": <bool>, "exit_code": <int>, ...<merged CLI JSON fields>...}

The CLI's exit-code convention carries queue semantics through the envelope:
0 ok; 64 usage; 65 protocol; 68 queued / still running (JSON still printed,
and ok stays true — a queue position is not a failure);
69 offer or wait resolution (e.g. paused, cancelled); 70 internal. Handlers
never raise — every failure path is a JSON result.

Identity is session-derived (see agent_id): one load-lock agent per Hermes
session, so offers and queue positions route back to the right conversation
and survive across every load-lock-registered toolset on the machine.

run_with_permit/job_status/job_stop implement a local Job registry over the
CLI's own ``load-lock run`` helper, which already owns the full lifecycle:
detached child in its own process group, atomic permit association, SIGTERM/
SIGINT forwarding, and permit release with outcome right before exit — so by
the time the CLI process is observed exited, the release round-trip has
completed (exact, not eventual).
"""

from __future__ import annotations

import json
import os
import random
import signal
import subprocess
import threading
import time
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

from . import policy, runtime
from .runtime import EXIT_INTERNAL, EXIT_PENDING, RuntimeNotFound

TOOLSET = "load-lock"

# ---------------------------------------------------------------------------
# identity
# ---------------------------------------------------------------------------


def agent_id(kwargs: Dict[str, Any]) -> str:
    """Session-derived agent identity: one load-lock agent per Hermes session.

    ``session_id`` is preferred; ``task_id`` (subagent dispatches) keeps
    parent and child distinguishable, which is exactly what a machine-wide
    budget wants when a session spawns parallel workers.
    """
    for key in ("agent_id", "session_id", "task_id"):
        value = kwargs.get(key)
        if isinstance(value, str) and value.strip():
            return "hermes:" + value.strip()
    return "hermes:pid-" + str(os.getpid())


# ---------------------------------------------------------------------------
# heartbeat: untracked-permit lease renewal (mark_started)
# ---------------------------------------------------------------------------


class Heartbeat:
    """Renew untracked-permit leases for recently active sessions.

    The plugin process is long-lived with the agent, so — unlike one-shot
    CLI calls — it can keep ``mark_started`` permits alive while the session
    lives. Agent ids seen in the last ``window_s`` are renewed every
    ``interval_s`` via ``load-lock heartbeat``. When a session (or this
    plugin/agent process) dies, renewal stops and the daemon reclaims the
    lease: a dead agent never strands a permit. Heartbeats are idempotent
    and harmless for agents that hold nothing.
    """

    def __init__(self, interval_s: float = 15.0, window_s: float = 900.0):
        self.interval_s = interval_s
        self.window_s = window_s
        self._lock = threading.Lock()
        self._seen: Dict[str, float] = {}
        self._stop_evt = threading.Event()
        self._thread: Optional[threading.Thread] = None

    def touch(self, agent: str) -> None:
        with self._lock:
            self._seen[agent] = time.monotonic()
            if len(self._seen) > 512:  # prune dead sessions occasionally
                now = time.monotonic()
                self._seen = {
                    a: t for a, t in self._seen.items() if now - t < self.window_s
                }

    def start(self) -> None:
        if self._thread is not None:
            return
        self._thread = threading.Thread(
            target=self._run, name="load-lock-heartbeat", daemon=True
        )
        self._thread.start()

    def stop(self) -> None:
        self._stop_evt.set()

    def _run(self) -> None:
        while not self._stop_evt.wait(self.interval_s):
            try:
                now = time.monotonic()
                with self._lock:
                    agents = [
                        a for a, t in self._seen.items() if now - t < self.window_s
                    ]
                for agent in agents:
                    runtime.run_cli(
                        ["heartbeat", "--agent", agent], timeout_s=15.0
                    )
            except Exception:
                # daemon unreachable / runtime missing: the next tool call
                # reconnects; a failing heartbeat just means the lease lapses.
                pass


# ---------------------------------------------------------------------------
# local Job registry (run_with_permit / job_status / job_stop)
# ---------------------------------------------------------------------------

_OUTPUT_CHUNKS = 200
_OUTPUT_TAIL_CHARS = 4000


class Job:
    __slots__ = (
        "id", "proc", "command", "permit_token", "agent", "started_at",
        "exited_at", "exit_code", "output", "lock", "done", "stop_requested",
    )

    def __init__(self, proc, command: str, permit_token: str, agent: str):
        self.id = "job_%d_%s" % (proc.pid, "".join(random.choices("abcdefghijklmnopqrstuvwxyz0123456789", k=6)))
        self.proc = proc
        self.command = command
        self.permit_token = permit_token
        self.agent = agent
        self.started_at = time.monotonic()
        self.exited_at: Optional[float] = None
        self.exit_code: Optional[int] = None
        self.output: List[str] = []
        self.lock = threading.Lock()
        self.done = threading.Event()
        self.stop_requested = False

    @property
    def running(self) -> bool:
        return not self.done.is_set()

    def tail(self, limit: int = 20) -> str:
        with self.lock:
            text = "".join(self.output[-limit:])
        return text[-_OUTPUT_TAIL_CHARS:]

    def snapshot(self) -> Dict[str, Any]:
        return {
            "job_id": self.id,
            "command": self.command,
            "running": self.running,
            "exit_code": self.exit_code,
            "output_tail": self.tail(),
        }


class JobManager:
    """Jobs are Popen of ``load-lock run --permit <tok> -- <command>``.

    The CLI run helper blocks until the job exits and owns the whole permit
    lifecycle (detached child, own process group, atomic start_job
    association, release-with-outcome before exit, exit code passthrough),
    so the CLI process's exit IS the job's exit, and the permit is already
    released by then. If this plugin process dies, the CLI keeps running and
    still releases on completion; the daemon additionally watches the job's
    process group.
    """

    def __init__(self):
        self._lock = threading.Lock()
        self._jobs: Dict[str, Job] = {}

    def start(
        self, permit_token: str, command: str, cwd: Optional[str] = None, agent: str = ""
    ) -> Job:
        prefix, _source = runtime.resolve_runtime()
        argv = ["run", "--permit", permit_token]
        if cwd:
            argv += ["--cwd", cwd]
        argv += ["--", command]
        argv = prefix + argv
        proc = subprocess.Popen(
            argv,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            stdin=subprocess.DEVNULL,
            cwd=cwd or None,
            env=dict(os.environ),
        )
        job = Job(proc, command, permit_token, agent)
        with self._lock:
            self._jobs[job.id] = job
            if len(self._jobs) > 256:  # bound memory: forget long-dead jobs
                dead = [j for j in self._jobs.values() if not j.running]
                for j in dead[:-64]:
                    del self._jobs[j.id]
        threading.Thread(
            target=self._pump, args=(proc.stdout, job), daemon=True,
            name=f"load-lock-out-{job.id}",
        ).start()
        threading.Thread(
            target=self._pump, args=(proc.stderr, job), daemon=True,
            name=f"load-lock-err-{job.id}",
        ).start()
        threading.Thread(
            target=self._reap, args=(proc, job), daemon=True,
            name=f"load-lock-reap-{job.id}",
        ).start()
        return job

    @staticmethod
    def _pump(stream, job: Job) -> None:
        try:
            for chunk in iter(lambda: stream.read(4096) or "", ""):
                if not chunk:
                    break
                with job.lock:
                    job.output.append(chunk.decode("utf-8", "replace"))
                    if len(job.output) > _OUTPUT_CHUNKS:
                        del job.output[: len(job.output) - _OUTPUT_CHUNKS]
        except Exception:
            pass
        finally:
            try:
                stream.close()
            except Exception:
                pass

    @staticmethod
    def _reap(proc: subprocess.Popen, job: Job) -> None:
        code = proc.wait()  # the CLI run exits with the job's exit code
        job.exit_code = code
        job.exited_at = time.monotonic()
        job.done.set()
        # The CLI released the permit (with outcome) right before exiting,
        # so observing its exit means the release round-trip has happened.

    def get(self, job_id: str) -> Optional[Job]:
        with self._lock:
            return self._jobs.get(job_id)

    def stop(self, job: Job) -> bool:
        """SIGTERM the CLI run (it forwards to the job's process group),
        escalating to SIGKILL after 5s (then the daemon's process-group
        liveness watch still releases the permit when the job dies)."""
        if job.running and not job.stop_requested:
            job.stop_requested = True
            try:
                job.proc.terminate()  # SIGTERM -> CLI forwards to job pgroup
            except Exception:
                pass

            def _escalate():
                if job.running:
                    try:
                        job.proc.kill()
                    except Exception:
                        pass

            threading.Timer(5.0, _escalate).start()
            return True
        return False


# ---------------------------------------------------------------------------
# shared plumbing
# ---------------------------------------------------------------------------

HEARTBEAT = Heartbeat()
JOBS = JobManager()


def _envelope(args: List[str], kwargs: Dict[str, Any], timeout_s: float) -> Dict[str, Any]:
    """Run the CLI, merge the JSON result, touch the heartbeat for the agent."""
    HEARTBEAT.touch(agent_id(kwargs))
    return runtime.call_cli(args, timeout_s=timeout_s)


def _as_int(value: Any) -> Optional[int]:
    try:
        if value is None or value is True or value is False:
            return None
        return int(value)
    except (TypeError, ValueError):
        return None


def _hoist_entry(envelope: Dict[str, Any], *keys: str) -> Dict[str, Any]:
    """Copy entry fields to the envelope top level (MCP-result parity):
    the model reads permit_token/request_id without digging into entry."""
    entry = envelope.get("entry")
    if isinstance(entry, dict):
        for key in keys:
            if entry.get(key) is not None:
                envelope.setdefault(key, entry[key])
    return envelope


_ACQUIRE_NEXT_ACTION = {
    "granted": "You hold the permit. Start the heavy work now via load_lock_run_with_permit (best), load_lock_attach_pid, or load_lock_mark_started; release when done.",
    "offered": "You have a reserved offer: call load_lock_claim(offer_token) NOW — it expires and capacity passes to the next waiter.",
    "queued": "Keep doing light work. Capacity will be offered to you in FIFO order; check load_lock_pending at tool boundaries or pass wait_ms next time.",
}


def _as_str(value: Any) -> Optional[str]:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


# ---------------------------------------------------------------------------
# handlers (one per tool); each returns a JSON-serializable dict
# ---------------------------------------------------------------------------


def h_acquire(args: Dict[str, Any], **kwargs) -> Dict[str, Any]:
    reason = _as_str(args.get("reason"))
    op_key = _as_str(args.get("op_key"))
    if not reason or not op_key:
        return {"ok": False, "error": "acquire requires 'reason' and 'op_key'"}
    cli = ["acquire", "--reason", reason, "--op-key", op_key,
           "--agent", _as_str(args.get("agent_id")) or agent_id(kwargs)]
    pool = _as_str(args.get("pool"))
    if pool:
        cli += ["--pool", pool]
    prefix = _as_str(args.get("label_prefix"))
    if prefix:
        cli += ["--label-prefix", prefix]
    wait_ms = _as_int(args.get("wait_ms"))
    if wait_ms is not None:
        cli += ["--wait-ms", str(wait_ms)]
    if args.get("subscribe_if_busy") is False:
        cli += ["--no-queue"]
    timeout = 60.0 if wait_ms is None else max(wait_ms / 1000.0 + 30.0, 30.0)
    envelope = _envelope(cli, kwargs, timeout)
    _hoist_entry(envelope, "request_id", "pool", "position", "offer_expires_at",
                 "permit_token", "start_deadline", "reason")
    if envelope.get("offer_token") is None and isinstance(envelope.get("entry"), dict):
        envelope.setdefault("offer_token", envelope["entry"].get("offer_token"))
    if envelope.get("position") is not None:
        envelope.setdefault("queue_position", envelope["position"])
    envelope.setdefault(
        "next_action",
        _ACQUIRE_NEXT_ACTION.get(
            envelope.get("state") or "",
            "Your request was paused (offer expired or declined). Call load_lock_rejoin(request_id) when ready to queue again.",
        ),
    )
    return envelope


def h_claim(args: Dict[str, Any], **kwargs) -> Dict[str, Any]:
    token = _as_str(args.get("offer_token"))
    if not token:
        return {"ok": False, "error": "claim requires 'offer_token'"}
    envelope = _envelope(["claim", "--offer", token], kwargs, 60.0)
    _hoist_entry(envelope, "request_id", "permit_token", "phase", "start_deadline")
    envelope.setdefault(
        "next_action",
        "Permit claimed. Begin the heavy work before the start deadline: "
        "load_lock_run_with_permit (best), load_lock_attach_pid, or "
        "load_lock_mark_started. Release when finished.",
    )
    return envelope


def h_release(args: Dict[str, Any], **kwargs) -> Dict[str, Any]:
    token = _as_str(args.get("permit_token"))
    if not token:
        return {"ok": False, "error": "release requires 'permit_token'"}
    cli = ["release", "--permit", token]
    outcome = _as_str(args.get("outcome"))
    if outcome in ("success", "failure"):
        cli += ["--outcome", outcome]
    return _envelope(cli, kwargs, 60.0)


def h_cancel(args: Dict[str, Any], **kwargs) -> Dict[str, Any]:
    request_id = _as_str(args.get("request_id"))
    if not request_id:
        return {"ok": False, "error": "cancel requires 'request_id'"}
    return _envelope(["cancel", "--id", request_id], kwargs, 60.0)


def h_decline(args: Dict[str, Any], **kwargs) -> Dict[str, Any]:
    token = _as_str(args.get("offer_token"))
    if not token:
        return {"ok": False, "error": "decline requires 'offer_token'"}
    return _envelope(["decline", "--offer", token], kwargs, 60.0)


def h_rejoin(args: Dict[str, Any], **kwargs) -> Dict[str, Any]:
    request_id = _as_str(args.get("request_id"))
    if not request_id:
        return {"ok": False, "error": "rejoin requires 'request_id'"}
    envelope = _envelope(["rejoin", "--id", request_id], kwargs, 60.0)
    _hoist_entry(envelope, "request_id", "position", "offer_token")
    if envelope.get("position") is not None:
        envelope.setdefault("queue_position", envelope["position"])
    envelope.setdefault(
        "next_action",
        "Capacity was free: you have a new offer — load_lock_claim(offer_token) now."
        if envelope.get("state") == "offered"
        else f"Queued at position {envelope.get('queue_position') or envelope.get('position') or '?'}; continue light work.",
    )
    return envelope


def _pick_request(pending: Dict[str, Any]) -> Optional[str]:
    """Default watch target: oldest offered, then front-most queued, then
    oldest paused (same rule as src/shared/wait-turn.ts)."""
    offers = pending.get("offers") or []
    queue = pending.get("queue") or []
    paused = pending.get("paused") or []
    if offers:
        return offers[0].get("request_id")
    if queue:
        best = min(queue, key=lambda e: e.get("position") or 1 << 30)
        return best.get("request_id")
    if paused:
        return paused[0].get("request_id")
    return None


def h_wait_for_turn(args: Dict[str, Any], **kwargs) -> Dict[str, Any]:
    agent = _as_str(args.get("agent_id")) or agent_id(kwargs)
    request_id = _as_str(args.get("request_id"))
    if not request_id:
        probe = runtime.call_cli(["pending", "--agent", agent], timeout_s=30.0)
        request_id = _pick_request(probe if isinstance(probe, dict) else {})
        if not request_id:
            return {
                "state": "not_found",
                "ok": False,
                "next_action": "No queued/offered/paused request. Acquire first.",
            }
    timeout_ms = _as_int(args.get("timeout_ms"))
    timeout_ms = 600_000 if timeout_ms is None else timeout_ms
    envelope = _envelope(
        ["wait", "--id", request_id, "--agent", agent, "--timeout", str(timeout_ms)],
        kwargs,
        timeout_ms / 1000.0 + 60.0,
    )
    envelope.setdefault("state", "still_queued" if envelope.get("exit_code") == EXIT_PENDING else "unknown")
    return envelope


def h_pending(args: Dict[str, Any], **kwargs) -> Dict[str, Any]:
    agent = _as_str(args.get("agent_id")) or agent_id(kwargs)
    return _envelope(["pending", "--agent", agent], kwargs, 60.0)


def h_status(args: Dict[str, Any], **kwargs) -> Dict[str, Any]:
    cli = ["status"]
    pool = _as_str(args.get("pool"))
    if pool:
        cli += ["--pool", pool]
    return _envelope(cli, kwargs, 60.0)


def h_inspect_machine(args: Dict[str, Any], **kwargs) -> Dict[str, Any]:
    return _envelope(["inspect"], kwargs, 60.0)


def h_get_config(args: Dict[str, Any], **kwargs) -> Dict[str, Any]:
    return _envelope(["config"], kwargs, 60.0)


def h_configure(args: Dict[str, Any], **kwargs) -> Dict[str, Any]:
    reason = _as_str(args.get("reason"))
    author = _as_str(args.get("author"))
    if not reason or not author:
        return {"ok": False, "error": "configure requires 'reason' and 'author'"}
    cli = ["configure", "--reason", reason, "--author", author]
    expected = _as_int(args.get("expected_version"))
    if expected is not None:
        cli += ["--expected-version", str(expected)]
    changes = args.get("changes") or {}
    if not isinstance(changes, dict):
        return {"ok": False, "error": "configure 'changes' must be an object"}
    unsupported = []
    pools = changes.get("pools") or {}
    if pools:
        if not isinstance(pools, dict) or len(pools) != 1:
            return {
                "ok": False,
                "error": "this adapter sets one pool per configure call; adjust additional pools in separate calls (read get_config for the new version each time)",
            }
        name, spec = next(iter(pools.items()))
        capacity = _as_int((spec or {}).get("capacity"))
        if capacity is None:
            return {"ok": False, "error": "pool capacity must be an integer"}
        cli += ["--pool", str(name), "--capacity", str(capacity)]
    for key, flag in (
        ("offer_timeout_ms", "--offer-timeout-ms"),
        ("max_wait_ms", "--max-wait-ms"),
        ("max_turn_wait_ms", "--max-turn-wait-ms"),
        ("start_timeout_ms", "--start-timeout-ms"),
        ("untracked_lease_ms", "--untracked-lease-ms"),
    ):
        value = _as_int(changes.get(key))
        if value is not None:
            cli += [flag, str(value)]
    guidance = changes.get("guidance") or {}
    if isinstance(guidance, dict):
        heuristic = _as_str(guidance.get("heavy_work_heuristic"))
        if heuristic:
            cli += ["--heavy-work-heuristic", heuristic]
        if guidance.get("notes") or guidance.get("agent"):
            unsupported.append("guidance.notes/guidance.agent")
    envelope = _envelope(cli, kwargs, 60.0)
    if unsupported:
        envelope["unapplied_changes"] = unsupported
    return envelope


def h_attach_pid(args: Dict[str, Any], **kwargs) -> Dict[str, Any]:
    token = _as_str(args.get("permit_token"))
    pid = _as_int(args.get("pid"))
    if not token or pid is None or pid <= 0:
        return {"ok": False, "error": "attach_pid requires 'permit_token' and a positive integer 'pid'"}
    return _envelope(["attach-pid", "--permit", token, "--pid", str(pid)], kwargs, 60.0)


def h_mark_started(args: Dict[str, Any], **kwargs) -> Dict[str, Any]:
    token = _as_str(args.get("permit_token"))
    if not token:
        return {"ok": False, "error": "mark_started requires 'permit_token'"}
    envelope = _envelope(["mark-started", "--permit", token], kwargs, 60.0)
    if envelope.get("ok"):
        # This adapter heartbeats automatically while the session lives.
        envelope["note"] = (
            "The Hermes plugin renews this permit's lease automatically while "
            "your session lives; if the session dies, the daemon reclaims it. "
            "Prefer run_with_permit for full lifecycle ownership."
        )
    return envelope


def h_run_with_permit(args: Dict[str, Any], **kwargs) -> Dict[str, Any]:
    token = _as_str(args.get("permit_token"))
    command = _as_str(args.get("command"))
    if not token or not command:
        return {"ok": False, "error": "run_with_permit requires 'permit_token' and 'command'"}
    agent = agent_id(kwargs)
    HEARTBEAT.touch(agent)
    try:
        job = JOBS.start(token, command, _as_str(args.get("cwd")) or None, agent)
    except RuntimeNotFound as exc:
        return {"ok": False, "error": str(exc)}
    except Exception as exc:
        return {"ok": False, "error": f"failed to spawn job: {exc}"}
    # Early-exit probe: a permit that was reclaimed mid-flight makes the CLI
    # kill the job and exit 69 almost immediately — surface that instead of
    # reporting a phantom running job.
    if job.done.wait(0.25):
        envelope = job.snapshot()
        envelope.update({
            "state": "failed",
            "ok": False,
            "permit_released": True,
            "next_action": "The permit was no longer startable; the job was killed before doing work. Acquire again.",
        })
        return envelope
    note = (
        "Background job started under permit. Do NOT release the permit "
        "manually — it auto-releases when the job exits. Sleep through the "
        "execution with load_lock_wait_for_completion(job_id); "
        "load_lock_job_status(job_id) for a quick check; load_lock_job_stop "
        "to terminate."
    )
    if not args.get("wait"):
        envelope = job.snapshot()
        envelope.update({"state": "running", "ok": True, "note": note})
        return envelope
    wait_ms = _as_int(args.get("wait_timeout_ms"))
    return wait_local_job(job, wait_ms if wait_ms is not None else 600_000)


def wait_local_job(job: Job, timeout_ms: int) -> Dict[str, Any]:
    """Bounded sleep over a local job; mirrors waitForLocalJob semantics."""
    if job.done.wait(max(timeout_ms, 0) / 1000.0):
        duration_ms = int((job.exited_at - job.started_at) * 1000) if job.exited_at else None
        return {
            "state": "finished",
            "ok": True,
            "job_id": job.id,
            "command": job.command,
            "exit_code": job.exit_code,
            "output_tail": job.tail(),
            "duration_ms": duration_ms,
            "permit_released": True,
            "next_action": (
                "The work is done and the permit has been released."
                if job.exit_code == 0
                else f"The job exited with code {job.exit_code}; the permit has been released."
            ),
        }
    return {
        "state": "still_running",
        "ok": False,
        "job_id": job.id,
        "command": job.command,
        "exit_code": None,
        "waited_ms": timeout_ms,
        "permit_released": False,
        "next_action": "Checkpoint: the job is still running. Call load_lock_wait_for_completion again to keep sleeping.",
    }


def h_job_status(args: Dict[str, Any], **kwargs) -> Dict[str, Any]:
    job_id = _as_str(args.get("job_id"))
    job = JOBS.get(job_id) if job_id else None
    if job is None:
        return {
            "ok": False,
            "error": "unknown job_id (jobs live in this Hermes agent process; it restarted if missing)",
        }
    envelope = job.snapshot()
    envelope["ok"] = True
    return envelope


def h_job_stop(args: Dict[str, Any], **kwargs) -> Dict[str, Any]:
    job_id = _as_str(args.get("job_id"))
    job = JOBS.get(job_id) if job_id else None
    if job is None:
        return {"ok": False, "error": "unknown job_id"}
    stopping = JOBS.stop(job)
    envelope = job.snapshot()
    envelope.update({"ok": True, "stopping": True})
    if not stopping:
        envelope["note"] = "The job had already exited."
    return envelope


def h_wait_for_completion(args: Dict[str, Any], **kwargs) -> Dict[str, Any]:
    job_id = _as_str(args.get("job_id"))
    request_id = _as_str(args.get("request_id"))
    if not job_id and not request_id:
        return {
            "state": "job_unknown",
            "ok": False,
            "next_action": "Pass job_id (a load_lock_run_with_permit job) or request_id (a daemon-tracked permit).",
        }
    timeout_ms = _as_int(args.get("timeout_ms"))
    timeout_ms = 600_000 if timeout_ms is None else timeout_ms
    if job_id:
        job = JOBS.get(job_id)
        if job is not None:
            HEARTBEAT.touch(agent_id(kwargs))
            return wait_local_job(job, timeout_ms)
        # Unknown locally: fall through to daemon-tracked lookup so a job
        # from a previous agent process can still be waited on by id.
        request_id = request_id or job_id
    envelope = _envelope(
        ["wait", "--job", request_id, "--timeout", str(timeout_ms)],
        kwargs,
        timeout_ms / 1000.0 + 60.0,
    )
    if envelope.get("exit_code") == EXIT_PENDING:
        envelope.setdefault("state", "still_running")
    return envelope


def h_agent_guide(args: Dict[str, Any], **kwargs) -> Dict[str, Any]:
    HEARTBEAT.touch(agent_id(kwargs))
    try:
        code, stdout, _stderr = runtime.run_cli(
            ["agent-guide"], json_output=False, timeout_s=30.0
        )
    except RuntimeNotFound as exc:
        return {"ok": False, "error": str(exc)}
    if code == 0 and stdout.strip():
        return {"ok": True, "guide": stdout}
    # Fallback: the CLI copy's docs may be missing (npx layout); the brief
    # still teaches the core flow.
    return {"ok": True, "guide": policy.POLICY_BRIEF}


# ---------------------------------------------------------------------------
# hooks
# ---------------------------------------------------------------------------

_INJECT_STATE: Dict[str, Dict[str, Any]] = {}
_INJECT_LOCK = threading.Lock()

_HERMES_NOTE = (
    "\n\nHermes wiring: the load-lock tools are registered with the "
    "load_lock_ prefix (load_lock_acquire, load_lock_wait_for_turn, "
    "load_lock_run_with_permit, load_lock_wait_for_completion, ...). The "
    "detailed playbook is available via the load_lock_agent_guide tool or "
    "the plugin skill (skill_view('load-lock:agent-guide'))."
)


def _machine_line() -> str:
    """Best-effort one-line status for the injected brief."""
    try:
        code, stdout, _ = runtime.run_cli(["status"], timeout_s=15.0)
        if code != 0 or not stdout.strip():
            return ""
        data = runtime.snake_keys(json.loads(stdout))
        parts = []
        for pool in data.get("pools") or []:
            who = ", ".join(
                (h.get("agent_label") or h.get("reason") or "?")
                for h in (pool.get("holders") or [])
            )
            queue = pool.get("queue") or []
            line = (
                f'pool "{pool.get("pool")}": {pool.get("used")}/{pool.get("capacity")} in use'
                f'{f", {len(queue)} queued" if queue else ""}'
                f'{f", held by: {who}" if who else ""}'
            )
            parts.append(line)
        return ("load-lock now: " + "; ".join(parts) + ".") if parts else ""
    except Exception:
        return ""


def pre_llm_call(**kwargs):
    """Inject the policy brief on the first turn and after compaction.

    Compaction is detected two ways: the post_compaction hook (0.23+)
    clears the session's inject state, and — as a fallback for builds
    without that hook — a conversation_history that shrank since the
    last observed turn.
    """
    try:
        settings = runtime.get_settings()
        if not settings.get("inject_policy", True):
            return None
        session_id = str(kwargs.get("session_id") or "")
        history = kwargs.get("conversation_history")
        length = len(history) if isinstance(history, list) else 0
        with _INJECT_LOCK:
            state = _INJECT_STATE.get(session_id)
            inject = (
                kwargs.get("is_first_turn")
                or state is None
                or length < state.get("len", 0)
            )
            _INJECT_STATE[session_id] = {"len": length}
            if len(_INJECT_STATE) > 1024:
                _INJECT_STATE.clear()
                _INJECT_STATE[session_id] = {"len": length}
        if not inject:
            return None
        text = policy.policy_brief() + _HERMES_NOTE
        line = _machine_line()
        if line:
            text += "\n\n" + line
        return {"context": text}
    except Exception:
        return None  # a broken hook must never disturb the session


def post_compaction(**kwargs):
    """Re-arm policy injection after Hermes compacts the conversation.

    Hermes 0.23+ calls this hook after compaction; clearing the session's
    inject state makes the next pre_llm_call re-inject the brief (the
    length-shrink heuristic in pre_llm_call covers older Hermes builds).
    """
    try:
        session_id = str(
            kwargs.get("session_id") or kwargs.get("old_session_id") or ""
        )
        if session_id:
            with _INJECT_LOCK:
                _INJECT_STATE.pop(session_id, None)
    except Exception:
        pass
    return None


def pre_tool_call(tool_name: str = "", args: Optional[Dict[str, Any]] = None, task_id: str = "", **kwargs):
    """Give load_lock_run_with_permit the terminal tool's dangerous-command gate.

    run_with_permit spawns a model-chosen shell command, so a command
    Hermes's own detector flags as dangerous is escalated to the
    human-approval gate through the public ``approve`` directive (same
    allowlist, prompts, cron mode and fail-closed rules as ``terminal``).
    Ordinary heavy work (``npm test``) is not flagged and never prompts.
    If the detector cannot be loaded, every command is escalated instead.
    """
    if tool_name != "load_lock_run_with_permit":
        return None
    command = _as_str((args or {}).get("command"))
    if not command:
        return None
    try:
        from tools.approval_detection import detect_dangerous_command

        dangerous, pattern_key, description = detect_dangerous_command(command)
    except Exception:
        return {
            "action": "approve",
            "message": f"load-lock run_with_permit wants to run: {command[:200]}",
            "rule_key": "load-lock:run_with_permit",
        }
    if not dangerous:
        return None
    return {
        "action": "approve",
        "message": f"load-lock run_with_permit: {description}",
        "rule_key": f"load-lock:{pattern_key}",
    }


def on_session_end(**kwargs):
    """Best-effort cleanup: cancel this session's queued/offered/paused
    requests so a finished conversation does not hold queue slots. Held
    permits are left to their normal lifecycle (tracked jobs release on
    exit; untracked permits lapse when the heartbeat window passes)."""
    try:
        agent = agent_id(kwargs)
        probe = runtime.call_cli(["pending", "--agent", agent], timeout_s=20.0)
        pending = {}
        for key in ("offers", "queue", "paused"):
            value = probe.get(key)
            if isinstance(value, list):
                pending[key] = value
        cancelled = []
        for entries in pending.values():
            for entry in entries:
                request_id = entry.get("request_id") if isinstance(entry, dict) else None
                if request_id:
                    runtime.call_cli(["cancel", "--id", request_id], timeout_s=20.0)
                    cancelled.append(request_id)
        with _INJECT_LOCK:
            _INJECT_STATE.pop(str(kwargs.get("session_id") or ""), None)
        return {"cancelled": cancelled} if cancelled else None
    except Exception:
        return None


# ---------------------------------------------------------------------------
# slash command
# ---------------------------------------------------------------------------

_SLASH_SUBCOMMANDS = {
    "status": ["status"],
    "pending": ["pending"],
    "queue": ["status"],
    "machine": ["inspect"],
    "inspect": ["inspect"],
    "config": ["config"],
    "guide": ["agent-guide"],
}


def slash_load_lock(raw_args: str):
    """``/load-lock [status|pending|machine|config|guide]``."""
    sub = (raw_args or "").strip().lower() or "status"
    cli = _SLASH_SUBCOMMANDS.get(sub)
    if cli is None:
        return json.dumps(
            {
                "ok": False,
                "error": f"unknown subcommand '{sub}'",
                "available": sorted(_SLASH_SUBCOMMANDS),
            }
        )
    if cli[0] == "agent-guide":
        code, stdout, _ = runtime.run_cli(cli, json_output=False, timeout_s=30.0)
        return stdout if code == 0 and stdout.strip() else policy.POLICY_BRIEF
    return json.dumps(runtime.call_cli(cli, timeout_s=30.0), indent=2)


# ---------------------------------------------------------------------------
# registration
# ---------------------------------------------------------------------------

HANDLERS: Dict[str, Tuple[Callable[..., Dict[str, Any]], str]] = {
    "load_lock_acquire": (h_acquire, "🔐"),
    "load_lock_claim": (h_claim, "🎫"),
    "load_lock_release": (h_release, "🔓"),
    "load_lock_cancel": (h_cancel, "✖️"),
    "load_lock_decline": (h_decline, "🙅"),
    "load_lock_rejoin": (h_rejoin, "↩️"),
    "load_lock_wait_for_turn": (h_wait_for_turn, "😴"),
    "load_lock_pending": (h_pending, "📋"),
    "load_lock_status": (h_status, "📊"),
    "load_lock_inspect_machine": (h_inspect_machine, "🖥️"),
    "load_lock_get_config": (h_get_config, "⚙️"),
    "load_lock_configure": (h_configure, "🛠️"),
    "load_lock_attach_pid": (h_attach_pid, "🧷"),
    "load_lock_mark_started": (h_mark_started, "🚦"),
    "load_lock_run_with_permit": (h_run_with_permit, "🏗️"),
    "load_lock_job_status": (h_job_status, "📡"),
    "load_lock_job_stop": (h_job_stop, "🛑"),
    "load_lock_wait_for_completion": (h_wait_for_completion, "⏳"),
    "load_lock_agent_guide": (h_agent_guide, "📖"),
}
