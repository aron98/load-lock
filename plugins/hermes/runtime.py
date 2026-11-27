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
import re
import shlex
import shutil
import subprocess
import threading
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

PACKAGE_NAME = "@aron98/load-lock"
PACKAGE_SPEC = "@aron98/load-lock@1.7.2"
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
    "env_passthrough": "",
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
# child environments
# ---------------------------------------------------------------------------
#
# Hermes's own process environment carries every provider API key, which its
# terminal tool strips before running anything. Children of this plugin (the
# load-lock CLI, the daemon it may auto-start, and the job a
# load_lock_run_with_permit call runs) get an environment built from an
# allowlist instead, so they never see those keys.

# What the load-lock CLI (and the npx fallback) needs: locate node and the
# user's dirs, keep the locale, honour load-lock's own overrides and proxies.
_CLI_ENV_KEYS = frozenset({
    "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LANGUAGE", "TZ", "TERM",
    "TMPDIR", "TMP", "TEMP",
    "XDG_STATE_HOME", "XDG_RUNTIME_DIR", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME",
    "LOCALAPPDATA", "APPDATA", "USERPROFILE", "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC", "PATHEXT",
    "NODE_OPTIONS", "NODE_PATH", "NODE_EXTRA_CA_CERTS",
    "npm_config_cache", "npm_config_registry", "npm_config_userconfig", "npm_config_prefix",
    "NPM_CONFIG_CACHE", "NPM_CONFIG_REGISTRY", "NPM_CONFIG_USERCONFIG", "NPM_CONFIG_PREFIX",
    "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
})
_CLI_ENV_PREFIXES = ("LOAD_LOCK_", "LC_")

# A heavy job is a build or a test suite: it also needs to find toolchains.
# These name install locations and build flags, never credentials.
_JOB_ENV_KEYS = frozenset({
    "JAVA_HOME", "ANDROID_HOME", "ANDROID_SDK_ROOT", "GRADLE_USER_HOME", "MAVEN_OPTS",
    "GOPATH", "GOROOT", "GOCACHE", "GOMODCACHE", "GOFLAGS",
    "CARGO_HOME", "RUSTUP_HOME", "RUSTUP_TOOLCHAIN", "RUSTFLAGS", "CARGO_TARGET_DIR",
    "PYENV_ROOT", "PYENV_VERSION", "VIRTUAL_ENV", "CONDA_PREFIX", "CONDA_DEFAULT_ENV",
    "NVM_DIR", "NVM_BIN", "VOLTA_HOME", "BUN_INSTALL", "PNPM_HOME", "DENO_DIR", "NODE_ENV",
    "GEM_HOME", "GEM_PATH", "RBENV_ROOT", "DOTNET_ROOT", "SDKROOT", "DEVELOPER_DIR",
    "CC", "CXX", "CFLAGS", "CXXFLAGS", "CPPFLAGS", "LDFLAGS", "PKG_CONFIG_PATH", "MAKEFLAGS",
    "CMAKE_GENERATOR", "CI", "COLORTERM", "NO_COLOR", "FORCE_COLOR",
})

# Belt and braces: an allowlisted name that still looks like a secret is dropped.
_SECRETISH = re.compile(r"TOKEN|SECRET|PASSW|API_?KEY|ACCESS_?KEY|PRIVATE|CREDENTIAL|AUTH", re.I)


def _passthrough_names() -> List[str]:
    """Extra variable names the user opted in to via the env_passthrough setting."""
    raw = get_settings().get("env_passthrough") or ""
    if isinstance(raw, (list, tuple)):
        raw = " ".join(str(x) for x in raw)
    return [n for n in re.split(r"[\s,]+", str(raw)) if n]


def child_env(job: bool = False) -> Dict[str, str]:
    """Allowlisted environment for a child process (see the section comment).

    ``job=True`` adds toolchain locations for the command a run_with_permit
    job runs, plus the names listed in the env_passthrough setting; those are
    the user's explicit choice and skip the secret-name guard.
    """
    allowed = _CLI_ENV_KEYS | _JOB_ENV_KEYS if job else _CLI_ENV_KEYS
    env = {
        k: v for k, v in os.environ.items()
        if (k in allowed or k.startswith(_CLI_ENV_PREFIXES)) and not _SECRETISH.search(k)
    }
    if job:
        for name in _passthrough_names():
            if name in os.environ:
                env[name] = os.environ[name]
    return env


# ---------------------------------------------------------------------------
# terminal backend
# ---------------------------------------------------------------------------


def terminal_backend() -> str:
    """The terminal backend Hermes uses for this turn, resolved as Hermes does.

    A bound terminal scope (per-turn / per-profile policy) is authoritative and
    raises when the profile's policy is unavailable; otherwise an explicit
    ``terminal.backend`` in the active profile's config wins over the bridged
    ``TERMINAL_ENV``; the default is ``local``. Raises when it cannot tell, so
    callers fail closed.
    """
    try:
        from tools.terminal_scope import get_terminal_scope, terminal_env
    except Exception:  # older or relocated module: fall back to config/env
        get_terminal_scope = None  # type: ignore[assignment]
    if get_terminal_scope is not None and get_terminal_scope() is not None:
        return (terminal_env("TERMINAL_ENV", "local") or "local").strip().lower()
    # The raw file, not load_config(): its defaults would fill in a backend
    # the user never set and mask TERMINAL_ENV (Hermes's own bridge does the same).
    from hermes_cli.config import read_raw_config

    terminal = (read_raw_config() or {}).get("terminal")
    if isinstance(terminal, dict) and terminal.get("backend"):
        return str(terminal["backend"]).strip().lower()
    return (os.environ.get("TERMINAL_ENV") or "local").strip().lower()


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
            [str(exe), "--version"], capture_output=True, text=True, timeout=10,
            env=child_env(),
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
    merged_env = child_env()
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
