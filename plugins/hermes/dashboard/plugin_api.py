"""load-lock dashboard plugin — backend API routes (read-only).

Mounted at ``/api/plugins/load-lock/`` by the Hermes dashboard plugin system
(``hermes_cli.web_server._mount_plugin_api_routes`` imports this file
standalone via ``importlib`` — NOT as a package member, so relative imports
would not work here; everything is imported by absolute path or module name).

The layer is intentionally thin: every handler shells out to the local
``load-lock`` CLI with ``--json`` and passes the parsed payload through.
The CLI talks to the machine-wide load-lock daemon (auto-spawning it on
first use, exactly like the agent-half tools do), so the dashboard can
never disagree with what the agents see.

Routes (all read-only — the dashboard never mutates pool state):

* ``GET /snapshot``   — pools, holders, offers, queue, paused, daemon + config
                        (``load-lock status --json``)
* ``GET /machine``    — cores, memory, pressure summary (``load-lock inspect --json``)
* ``GET /events``     — incremental activity feed (``load-lock events --since N``)

Every handler returns HTTP 200 with ``{"ok": false, "error": ...}`` on
failure so the frontend can render a clean error banner instead of a
framework stack trace. Nothing here ever raises.

Security note
-------------
Plugin HTTP routes sit behind the dashboard's session-token auth middleware
(``web_server.auth_middleware``) just like core API routes — the frontend
SDK's ``fetchJSON``/``authedFetch`` attach the session token automatically.
No extra auth handling is needed (and none is bypassed).

Runtime resolution reuses the agent plugin's ``runtime.py`` (same ladder
as ``plugins/claude-code/scripts/load-lock.mjs``: config override →
PATH → state-dir copy → optional pinned-npx fallback), loaded by file path
so this file stays self-contained for the standalone import.
"""

from __future__ import annotations

import importlib.util
import json
import logging
import subprocess
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter

log = logging.getLogger(__name__)

router = APIRouter()

# Reuse the agent-half runtime ladder (plugins/hermes/runtime.py).
_RUNTIME: Any = None


def _runtime() -> Any:
    """Load plugins/hermes/runtime.py by path, once per process.

    Never raises: a missing/unreadable runtime module degrades into
    {"ok": false, "error": ...} responses from the routes below.
    """
    global _RUNTIME
    if _RUNTIME is None:
        path = Path(__file__).resolve().parent.parent / "runtime.py"
        spec = importlib.util.spec_from_file_location(
            "load_lock_hermes_runtime", path
        )
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)  # type: ignore[union-attr]
        _RUNTIME = module
    return _RUNTIME


def _cli_json(args: List[str], timeout_s: float = 15.0) -> Dict[str, Any]:
    """Run the load-lock CLI with --json; return its parsed payload.

    Returns {"ok": true, <payload...>} on exit 0, else {"ok": false,
    "error": <helpful line>}. CLI JSON is kept in its native camelCase —
    this payload goes straight to JavaScript.
    """
    try:
        code, stdout, stderr = _runtime().run_cli(
            args, json_output=True, timeout_s=timeout_s
        )
    except Exception as exc:  # runtime missing, import failed, OSError, ...
        return {"ok": False, "error": f"load-lock runtime unavailable: {exc}"}
    text = (stdout or "").strip()
    data: Optional[Any] = None
    if text:
        try:
            data = json.loads(text)
        except ValueError:
            data = None
    if code != 0 or not isinstance(data, dict):
        err = ""
        if stderr and stderr.strip():
            err = stderr.strip().splitlines()[-1]
        if not err and text:
            err = text.splitlines()[0][:200]
        return {
            "ok": False,
            "error": err or f"load-lock exited with code {code}",
            "exit_code": code,
        }
    data["ok"] = True
    return data


# ---------------------------------------------------------------------------
# push-event accelerator (optional; polling remains the source of truth)
# ---------------------------------------------------------------------------
#
# The dashboard frontend polls /snapshot + /events, so everything works with
# zero extra machinery. On Hermes builds with ``plugin_events`` (0.23+), a
# lazy singleton thread also tails ``load-lock events --follow --json`` and
# broadcasts ``plugin.load-lock.state.changed`` so an attached Desktop can
# invalidate its queries instantly instead of waiting for the next poll.
# ``broadcast_plugin_event`` is fire-and-forget and a no-op when no Desktop
# client is subscribed, so the thread costs one idle CLI process at most,
# and only in the process actually serving this router.

_PUSH_LOCK = threading.Lock()
_PUSH_STARTED = False
_PUSH_STOP = threading.Event()
_PUSH_BACKOFF_MAX = 30.0


def _broadcast(latest_event_id: int, event_type: str) -> None:
    """Fire-and-forget broadcast; a no-op on Hermes without plugin_events."""
    try:
        from hermes_cli.plugin_events import broadcast_plugin_event  # type: ignore
    except Exception:
        return
    try:
        broadcast_plugin_event(
            "load-lock",
            "state.changed",
            {"latestEventId": latest_event_id, "type": event_type},
        )
    except Exception:  # never let a push failure break the feed
        pass


def _push_loop() -> None:
    backoff = 1.0
    while not _PUSH_STOP.is_set():
        try:
            prefix, _source = _runtime().resolve_runtime()
            proc = subprocess.Popen(
                list(prefix)
                + ["events", "--follow", "--json"],
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                text=True,
                bufsize=1,
            )
            assert proc.stdout is not None
            for line in proc.stdout:
                if _PUSH_STOP.is_set():
                    break
                line = line.strip()
                if not line:
                    continue
                try:
                    ev = json.loads(line)
                except ValueError:
                    continue
                if isinstance(ev, dict):
                    _broadcast(
                        int(ev.get("id") or 0), str(ev.get("type") or "event")
                    )
            proc.stdout.close()
            proc.terminate()
        except Exception:
            pass  # runtime missing, daemon gone, import failed — retry later
        if _PUSH_STOP.is_set():
            return
        # Daemon restarts, socket blips: bounded retry so a dead tail can
        # never spin, and a healthy one never thrashes.
        _PUSH_STOP.wait(backoff)
        backoff = min(backoff * 2.0, _PUSH_BACKOFF_MAX)


def _ensure_push() -> None:
    """Start the tail thread once per process (first API hit wins)."""
    global _PUSH_STARTED
    if _PUSH_STARTED:
        return
    with _PUSH_LOCK:
        if _PUSH_STARTED:
            return
        _PUSH_STARTED = True
        threading.Thread(
            target=_push_loop, name="load-lock-push", daemon=True
        ).start()


@router.get("/snapshot")
def snapshot() -> Dict[str, Any]:
    """Full lock-state snapshot (``load-lock status --json``)."""
    try:
        _ensure_push()
        st = _cli_json(["status"])
        if not st.get("ok"):
            return st
        cfg: Dict[str, Any] = st.get("config") or {}
        events_meta = st.get("events") or {}
        source = "missing"
        try:
            source = _runtime().command_source()
        except Exception:
            pass
        return {
            "ok": True,
            "generated_at": int(time.time() * 1000),
            "runtime_source": source,
            "daemon": st.get("daemon"),
            "config": cfg,
            "pools": st.get("pools") or [],
            "latest_event_id": events_meta.get("latestEventId") or 0,
        }
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


@router.get("/machine")
def machine() -> Dict[str, Any]:
    """Machine inspection (``load-lock inspect --json``)."""
    try:
        return _cli_json(["inspect"], timeout_s=20.0)
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


@router.get("/events")
def events(since: int = 0, limit: int = 60) -> Dict[str, Any]:
    """Incremental activity feed (``load-lock events --since <id> --json``).

    ``since`` is the last event id the client has seen (0 = everything);
    the response carries only newer events, capped to the newest ``limit``.
    """
    try:
        _ensure_push()
        try:
            since = max(0, int(since))
        except (TypeError, ValueError):
            since = 0
        try:
            limit = min(max(1, int(limit)), 200)
        except (TypeError, ValueError):
            limit = 60
        payload = _cli_json(["events", "--since", str(since)], timeout_s=10.0)
        if not payload.get("ok"):
            return payload
        evts = payload.get("events")
        if not isinstance(evts, list):
            evts = []
        return {
            "ok": True,
            "events": evts[-limit:],
            "latest_event_id": payload.get("latestEventId") or since,
        }
    except Exception as exc:
        return {"ok": False, "error": str(exc)}
