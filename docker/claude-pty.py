#!/usr/bin/env python3
"""Drive an interactive Claude Code session through a pty (no pip deps).

Used by docker/verify-claude-code.sh for the parts of live verification that
need an *idle* interactive session (async await-offer wakeup) or a slash
command (/compact) — neither is reachable from headless `claude -p`.

Usage:
  claude-pty.py LOGFILE DRIVER_SCRIPT [-- claude args ...]

Driver script directives, one per line:
  send <text>      type <text> and press Enter
  raw <text>       write bytes (no Enter added); \\x1b \\r \\e \\n are unescaped
  expect <regex>   wait (expect-timeout) until regex matches NEW output
  try-expect <regex> <secs>
                   bounded wait: consume-and-continue if it matches, just
                   continue after <secs> if it never does (optional dialogs)
  sleep <secs>     pause
  mark             consume all output so far; later expects match only new output
  wait-exit        wait for the child to exit (after /exit etc.)

Expectations match against a pty log cleaned of ANSI escapes and control
chars, scanning only output received AFTER the previous matched expectation
(so 'expect' never matches stale text). The full raw transcript is written to
LOGFILE. Exit codes: 0 = all expectations matched and child exited cleanly;
1 = an expectation timed out (tail of log on stderr); 2 = spawn/other error.
"""

import codecs
import os
import fcntl
import re
import selectors
import signal
import struct
import subprocess
import sys
import termios
import time

ANSI = re.compile(rb"\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|[\x00-\x08\x0b-\x1f]")

EXPECT_TIMEOUT = float(os.environ.get("PTY_EXPECT_TIMEOUT", "240"))
OVERALL_TIMEOUT = float(os.environ.get("PTY_OVERALL_TIMEOUT", "1200"))


def main() -> int:
    if len(sys.argv) < 3:
        sys.stderr.write(__doc__)
        return 2
    log_path, script_path = sys.argv[1], sys.argv[2]
    rest = sys.argv[3:]
    if rest and rest[0] == "--":
        rest = rest[1:]

    with open(script_path) as fh:
        steps = [line.rstrip("\n") for line in fh if line.strip() and not line.startswith("#")]

    master, slave = os.openpty()
    # A TUI needs a real window size (default pty winsize is 0x0 and renders
    # degenerate) and a sane TERM.
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 50, 200, 0, 0))
    env = dict(os.environ, TERM=os.environ.get("TERM", "xterm-256color"))
    child = subprocess.Popen(
        ["claude", *rest],
        stdin=slave,
        stdout=slave,
        stderr=slave,
        cwd="/workspace",
        env=env,
        start_new_session=True,
    )
    os.close(slave)

    sel = selectors.DefaultSelector()
    sel.register(master, selectors.EVENT_READ)

    log = open(log_path, "wb")
    cleaned = []  # list of cleaned chunks; expectations scan chunk-aligned
    pos = 0  # chunk index: expectations must match at or after this

    def read_available(timeout: float) -> bool:
        """Drain pty for up to `timeout` seconds. Returns True if any data."""
        saw = False
        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return saw
            for key, _ in sel.select(min(remaining, 0.25)):
                try:
                    data = os.read(master, 65536)
                except OSError:
                    return saw
                if not data:
                    return saw
                log.write(data)
                log.flush()
                cleaned.append(ANSI.sub(b"", data).decode("utf-8", "replace"))
                saw = True

    def matched_since(marker: int, regex: re.Pattern) -> int:
        """Search cleaned chunks >= marker; return next marker or -1."""
        buf = "".join(cleaned[marker:])
        m = regex.search(buf)
        if not m:
            return -1
        # conservative: consume everything seen so far (never rematch old text)
        return len(cleaned)

    def fail(msg: str) -> int:
        sys.stderr.write(f"claude-pty: {msg}\n")
        tail = "".join(cleaned[-60:])
        sys.stderr.write("--- cleaned pty tail ---\n" + tail[-4000:] + "\n")
        try:
            os.killpg(child.pid, signal.SIGTERM)
        except OSError:
            pass
        time.sleep(3)
        if child.poll() is None:
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except OSError:
                pass
        child.wait()
        log.close()
        return 1

    try:
        step_start = time.monotonic()
        for step in steps:
            kind, _, arg = step.partition(" ")
            arg = arg.lstrip()
            if kind == "send":
                os.write(master, arg.encode() + b"\r")
            elif kind == "raw":
                # ASCII driver scripts only: \x1b \r \e etc. become real bytes.
                os.write(master, codecs.decode(arg, "unicode_escape").encode("latin-1"))
            elif kind == "sleep":
                read_available(float(arg))
            elif kind == "mark":
                # consume everything seen so far: subsequent expectations
                # match only NEW output (skips echoed prompt text)
                read_available(0.2)
                pos = len(cleaned)
            elif kind == "expect":
                pat = re.compile(arg)
                deadline = time.monotonic() + EXPECT_TIMEOUT
                while True:
                    nxt = matched_since(pos, pat)
                    if nxt >= 0:
                        pos = nxt
                        break
                    if time.monotonic() > deadline:
                        return fail(f"expect timeout (no match for /{arg}/)")
                    read_available(2.0)
            elif kind == "try-expect":
                # try-expect <regex> <secs>: bounded wait, continue either way
                # (for dialogs that may or may not appear).
                pat_arg, _, secs_arg = arg.partition(" ")
                pat = re.compile(pat_arg)
                deadline = time.monotonic() + float(secs_arg or "30")
                while True:
                    nxt = matched_since(pos, pat)
                    if nxt >= 0:
                        pos = nxt
                        break
                    if time.monotonic() > deadline:
                        break
                    read_available(2.0)
            elif kind == "wait-exit":
                deadline = time.monotonic() + 120
                while child.poll() is None:
                    read_available(1.0)
                    if time.monotonic() > deadline:
                        return fail("child did not exit within 120s")
                read_available(1.0)
            else:
                return fail(f"unknown directive: {step!r}")
            if time.monotonic() - step_start > OVERALL_TIMEOUT:
                return fail("overall timeout exceeded")
        if child.poll() is None:
            return fail("driver script finished but claude still running")
        read_available(1.0)
        log.close()
        rc = child.returncode
        if rc not in (0, None):
            sys.stderr.write(f"claude-pty: claude exited rc={rc}\n")
        return 0
    finally:
        try:
            log.close()
        except Exception:
            pass


if __name__ == "__main__":
    sys.exit(main())
