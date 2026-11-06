"""load-lock plugin for Hermes — machine-wide heavy-work budget.

Adapts the load-lock semaphore (https://github.com/aron98/load-lock) to
Hermes by shelling out to the load-lock CLI (resolved from PATH, a known
runtime copy, or pinned npx — see runtime.py). Provides:

- 19 tools (load_lock_*): the full MCP surface — permits, FIFO queue with
  expiring offers, honest bounded waits (turn + completion), background
  jobs with auto-release, machine inspection, cooperative config tuning;
- hooks: pre_llm_call injects the short policy on the first turn and after
  context compaction (post_compaction re-arms it on 0.23+, a
  history-shrink heuristic covers older builds); on_session_end
  best-effort-cancels queued requests;
- a background heartbeat that keeps mark_started (untracked) permits of
  living sessions alive, so a dead agent never strands a permit;
- the ``/load-lock`` slash command and the ``load-lock:agent-guide`` skill.

Every handler is total: it returns a JSON string on every path and never
raises, so a missing runtime or daemon degrades into a helpful tool result
instead of a broken session.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any, Callable, Dict

from . import runtime, schemas, tools

logger = logging.getLogger(__name__)

_PLUGIN_DIR = Path(__file__).resolve().parent


def _json_handler(handler: Callable[..., Dict[str, Any]]) -> Callable[..., str]:
    """Wrap a handler: JSON string out, exceptions turned into results."""

    def wrapped(args: Dict[str, Any], **kwargs) -> str:
        try:
            return json.dumps(handler(args or {}, **kwargs))
        except Exception as exc:  # never raise out of a tool call
            logger.exception("load-lock tool %s failed", handler.__name__)
            return json.dumps({"ok": False, "error": f"load-lock: {exc}"})

    wrapped.__name__ = getattr(handler, "__name__", "load_lock_tool")
    return wrapped


def register(ctx) -> None:
    """Register the tool surface, hooks, slash command and skill.

    Fine-grained failure isolation: one bad registration (a tool-name
    collision, a missing skill file) logs and skips that item instead of
    taking the whole plugin down.
    """
    registered = 0
    for name, (handler, emoji) in tools.HANDLERS.items():
        schema = schemas.SCHEMAS.get(name)
        if schema is None:
            logger.warning("load-lock: no schema for tool %s", name)
            continue
        try:
            ctx.register_tool(
                name=name,
                toolset=tools.TOOLSET,
                schema=schema,
                handler=_json_handler(handler),
                emoji=emoji,
                description=schema["description"].splitlines()[0],
            )
            registered += 1
        except Exception:
            logger.exception("load-lock: failed to register tool %s", name)

    for event, callback in (
        ("pre_llm_call", tools.pre_llm_call),
        ("post_compaction", tools.post_compaction),
        ("on_session_end", tools.on_session_end),
    ):
        try:
            ctx.register_hook(event, callback)
        except Exception:
            logger.exception("load-lock: failed to register hook %s", event)

    try:
        ctx.register_command(
            "load-lock",
            tools.slash_load_lock,
            description="load-lock snapshot: status, pending, machine, config, or the full guide",
            args_hint="[status|pending|machine|config|guide]",
        )
    except Exception:
        logger.exception("load-lock: failed to register /load-lock command")

    skill_path = _PLUGIN_DIR / "skills" / "load-lock" / "SKILL.md"
    try:
        ctx.register_skill(
            "agent-guide",
            skill_path,
            description=(
                "Full load-lock playbook: heavy-vs-light heuristics, permit "
                "lifecycle, offers, honest waits, background jobs, recovery."
            ),
        )
    except Exception:
        logger.exception("load-lock: failed to register the agent-guide skill")

    # Adapter heartbeat (untracked-permit lease renewal) for living sessions.
    try:
        if runtime.get_settings().get("heartbeat", True):
            tools.HEARTBEAT.start()
    except Exception:
        logger.exception("load-lock: failed to start the heartbeat thread")

    try:
        logger.info(
            "load-lock plugin ready: %d tools, runtime=%s",
            registered,
            runtime.command_source(),
        )
    except Exception:
        logger.info("load-lock plugin ready: %d tools", registered)
