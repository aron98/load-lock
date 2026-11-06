"""load-lock runtime resolution and CLI invocation for the Hermes plugin.

Mirrors the resolution ladder of the committed Claude Code launcher
(plugins/claude-code/scripts/load-lock.mjs), so both adapters find the same
runtime in the same order:

  1. the ``load_lock_command`` setting (operator-provided argv prefix);
  2. ``load-lock`` on PATH, when its version is >= PIN;
  3. else the newest known runtime copy >= PIN recorded in the load-lock
     state dir (``runtimes.json`` copies / ``daemon.json`` packageRoot),
     executed via ``node <root>/dist/cli/main.js``;
  4. else ``npx --yes --package=<PACKAGE_SPEC>`` when the ``auto_install``
     setting is on (a network call; off by default — see README).

Everything here is best-effort: a missing runtime must degrade into a
helpful JSON error from the tools, never an exception out of the plugin.
"""

from __future__ import annotations

import json
import os
import shlex
import shutil
import subprocess
import threading
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

PACKAGE_NAME = "@aron98/load-lock"
PACKAGE_SPEC = "@aron98/load-lock@1.7.0"
# Minimum CLI version the adapter needs (decline/heartbeat landed in 1.7.0).
# Derived from PACKAGE_SPEC so check-pins keeps a single source of truth.
PIN = PACKAGE_SPEC.rsplit("@", 1)[1]
BIN = "dist/cli/main.js"

# Exit-code convention shared with every load-lock adapter (src/cli/main.ts):
# 0 ok, 64 usage, 65 protocol, 68 queued / still running, 69 offer/wait fail,
# 70 internal.
EXIT_USAGE = 64
EXIT_PROTOCOL = 65
EXIT_PENDING = 68
EXIT_WAIT_FAIL = 69
EXIT_INTERNAL = 70


class RuntimeNotFound(Exception):
    """No load-lock runtime could be resolved."""


def compare_versions(a: str, b: str) -> int:
    """Same dotted comparison as src/shared/version.ts compareVersions."""

    def parse(v: str) -> List[int]:
        out = []
        for part in str(v).split("."):
            num = ""
            for ch in part.strip():
                if ch.isdigit():
                    num += ch
                else:
                    break
            out.append(int(num) if num else 0)
        return out

    pa, pb = parse(a), parse(b)
    for i in range(max(len(pa), len(pb))):
        x = pa[i] if i < len(pa) else 0
        y = pb[i] if i < len(pb) else 0
        if x != y:
            return -1 if x < y else 1
    return 0


# ---------------------------------------------------------------------------
# settings (plugins.entries.load-lock.settings in Hermes config.yaml)
# ---------------------------------------------------------------------------

DEFAULTS: Dict[str, Any] = {
    "load_lock_command": "",
    "auto_install": False,
    "pool": "heavy",
    "heartbeat": True,
    "inject_policy": True,
}

_settings_lock = threading.Lock()


def get_settings() -> Dict[str, Any]:
    """Read this plugin's settings from Hermes config, with defaults.

    Never raises: config plumbing differs across Hermes versions, and a
    missing config section must simply mean "all defaults".
    """
    with _settings_lock:
        merged = dict(DEFAULTS)
        try:
            from hermes_cli.config import load_config

            cfg = load_config() or {}
            entries = (cfg.get("plugins") or {}).get("entries") or {}
            entry = entries.get("load-lock") or {}
            raw = entry.get("settings")
            if not isinstance(raw, dict):
                raw = entry  # tolerate settings stored at the entry level
            for key in merged:
                if key in raw and raw[key] is not None:
                    merged[key] = raw[key]
        except Exception:
            pass
        return merged


# ---------------------------------------------------------------------------
# resolution ladder
# ---------------------------------------------------------------------------

_resolve_lock = threading.Lock()
_resolved: Optional[Tuple[List[str], str]] = None


def state_dir() -> Path:
    """Same precedence as src/shared/transport.ts resolveStateDir."""
    if os.environ.get("LOAD_LOCK_STATE_DIR"):
        return Path(os.environ["LOAD_LOCK_STATE_DIR"])
    if os.name == "nt":
        base = os.environ.get("LOCALAPPDATA") or os.path.join(
            os.path.expanduser("~"), "AppData", "Local"
        )
        return Path(base) / "load-lock"
    base = os.environ.get("XDG_STATE_HOME") or os.path.join(
        os.path.expanduser("~"), ".local", "state"
    )
    return Path(base) / "load-lock"


def _pkg_version(root: str) -> Optional[str]:
    """Version when ``root`` is a load-lock package root holding the CLI entry."""
    try:
        real = Path(root).resolve()
        pkg = json.loads((real / "package.json").read_text(encoding="utf-8"))
        if pkg.get("name") != PACKAGE_NAME or not isinstance(pkg.get("version"), str):
            return None
        if not (real / BIN).exists():
            return None
        return pkg["version"]
    except Exception:
        return None


def _path_copy() -> Optional[str]:
    """Version of the load-lock on PATH, without spawning it (see .mjs)."""
    exe = shutil.which("load-lock")
    if not exe:
        return None
    exe_path = Path(exe)
    candidates: List[Path] = []
    try:
        real = exe_path.resolve()
        if real.as_posix().endswith("/dist/cli/main.js"):
            candidates.append(real.parent.parent.parent)
    except Exception:
        pass
    bin_dir = exe_path.parent
    candidates.append(bin_dir.parent / "lib" / "node_modules" / PACKAGE_NAME)
    candidates.append(bin_dir / "node_modules" / PACKAGE_NAME)
    for cand in candidates:
        version = _pkg_version(str(cand))
        if version:
            return version
    # A load-lock exists on PATH but is not an npm-style install (e.g. a
    # bun shim): ask it directly; slow path only, cached by the caller.
    try:
        proc = subprocess.run(
            [str(exe), "--version"], capture_output=True, text=True, timeout=10
        )
        if proc.returncode == 0:
            return proc.stdout.strip().splitlines()[-1].strip() or None
    except Exception:
        pass
    return None


def _state_copy() -> Optional[Tuple[str, str]]:
    """Newest known runtime copy >= PIN from runtimes.json / daemon.json."""
    roots: List[str] = []
    sdir = state_dir()
    try:
        raw = json.loads((sdir / "runtimes.json").read_text(encoding="utf-8"))
        for copy in raw.get("copies") or []:
            if isinstance(copy, dict) and isinstance(copy.get("path"), str):
                roots.append(copy["path"])
    except Exception:
        pass
    try:
        d = json.loads((sdir / "daemon.json").read_text(encoding="utf-8"))
        if isinstance(d.get("packageRoot"), str):
            roots.append(d["packageRoot"])
    except Exception:
        pass
    best: Optional[Tuple[str, str]] = None
    for root in roots:
        version = _pkg_version(root)
        if not version or compare_versions(version, PIN) < 0:
            continue
        if best is None or compare_versions(version, best[1]) > 0:
            best = (root, version)
    return best


def resolve_runtime(force: bool = False) -> Tuple[List[str], str]:
    """Return (argv prefix, source) for the load-lock CLI; cached per process.

    The prefix is a list: ["/usr/bin/load-lock"] or
    ["node", "/path/to/copy/dist/cli/main.js"] or
    ["npx", "--yes", "--package=...", "--", "load-lock"].
    """
    global _resolved
    with _resolve_lock:
        if _resolved is not None and not force:
            return _resolved
        settings = get_settings()

        override = str(settings.get("load_lock_command") or "").strip()
        if override:
            prefix = shlex.split(override)
            _resolved = (prefix, "config")
            return _resolved

        path_version = _path_copy()
        if path_version and compare_versions(path_version, PIN) >= 0:
            _resolved = ([str(shutil.which("load-lock"))], "path")
            return _resolved

        node = shutil.which("node")
        if node:
            state = _state_copy()
            if state:
                root, _version = state
                _resolved = ([node, str(Path(root) / BIN)], "state")
                return _resolved

        if settings.get("auto_install"):
            npx = shutil.which("npx")
            if npx:
                _resolved = (
                    [npx, "--yes", f"--package={PACKAGE_SPEC}", "--", "load-lock"],
                    "npx",
                )
                return _resolved

        raise RuntimeNotFound(
            "no load-lock runtime found: no `load-lock` >= %s on PATH, no known "
            "runtime copy in %s, and the npx fallback is disabled (enable the "
            "auto_install setting or run `npm i -g %s`)" % (PIN, state_dir(), PACKAGE_NAME)
        )


# ---------------------------------------------------------------------------
# invocation
# ---------------------------------------------------------------------------


def camel_to_snake(name: str) -> str:
    out = []
    for i, ch in enumerate(name):
        if ch.isupper() and i > 0:
            out.append("_")
        out.append(ch.lower())
    return "".join(out)


def snake_keys(obj: Any) -> Any:
    """Recursively convert dict keys from camelCase to snake_case.

    CLI JSON output is mostly raw protocol objects (requestId, offerToken);
    `wait` already prints snake_case. Normalizing gives the model one shape.
    """
    if isinstance(obj, dict):
        return {camel_to_snake(k): snake_keys(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [snake_keys(v) for v in obj]
    return obj


def run_cli(
    args: Sequence[str],
    json_output: bool = True,
    timeout_s: float = 60.0,
    env: Optional[Dict[str, str]] = None,
) -> Tuple[int, str, str]:
    """Run the resolved load-lock CLI with args; return (exit, stdout, stderr).

    Raises RuntimeNotFound when no runtime can be resolved (callers turn it
    into a helpful JSON tool result) and subprocess.TimeoutExpired never
    (timeout surfaces as a synthetic exit 70 result).
    """
    prefix, _source = resolve_runtime()
    argv = prefix + list(args)
    if json_output:
        argv.append("--json")
    merged_env = dict(os.environ)
    if env:
        merged_env.update(env)
    try:
        proc = subprocess.run(
            argv, capture_output=True, text=True, errors="replace",
            timeout=max(timeout_s, 1.0), env=merged_env,
        )
        return proc.returncode, proc.stdout, proc.stderr
    except subprocess.TimeoutExpired as exc:
        stdout = exc.stdout.decode("utf-8", "replace") if isinstance(exc.stdout, bytes) else (exc.stdout or "")
        return EXIT_INTERNAL, stdout, f"load-lock: timed out after {timeout_s:.0f}s"
    except FileNotFoundError:
        return EXIT_INTERNAL, "", f"load-lock: launcher not found: {argv[0]}"
    except OSError as exc:
        return EXIT_INTERNAL, "", f"load-lock: failed to run launcher: {exc}"


def call_cli(
    args: Sequence[str],
    timeout_s: float = 60.0,
    json_output: bool = True,
) -> Dict[str, Any]:
    """Run the CLI and return a snake_cased envelope: ok/exit_code + merged fields.

    The envelope always carries exit_code (the CLI's queue/offer conventions:
    68 = queued / still running, 69 = offer or wait resolution). 68 counts as
    ok: being queued or still running is a normal outcome, not a failed call
    (Hermes UIs flag any ``ok: false`` result as a failed tool call). When the CLI
    printed a JSON object, its fields are merged into the envelope top level
    (queued results DO print JSON); non-JSON text stays under "result".
    """
    try:
        code, stdout, stderr = run_cli(args, json_output=json_output, timeout_s=timeout_s)
    except RuntimeNotFound as exc:
        return {"ok": False, "exit_code": EXIT_INTERNAL, "error": str(exc), "result": None}
    text = stdout.strip()
    if text:
        try:
            data = snake_keys(json.loads(text))
        except ValueError:
            data = text
    else:
        data = None
    envelope: Dict[str, Any] = {
        "ok": code in (0, EXIT_PENDING),
        "exit_code": code,
    }
    if isinstance(data, dict):
        for key, value in data.items():
            if key not in ("ok", "exit_code", "result", "stderr"):
                envelope[key] = value
    else:
        envelope["result"] = data
    if code != 0 and stderr.strip():
        envelope["stderr"] = stderr.strip().splitlines()[-1]
    return envelope


def command_source() -> str:
    """Which resolution branch is active (for status output)."""
    try:
        _prefix, source = resolve_runtime()
        return source
    except RuntimeNotFound:
        return "missing"
