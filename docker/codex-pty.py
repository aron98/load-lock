#!/usr/bin/env python3
"""Drive an interactive Codex CLI session through a pty (no pip deps).

Used by docker/verify-codex.sh when headless `codex exec` cannot inject MCP
tools into the model's tool set (openai/codex#38689): interactive codex DOES
register MCP tools, so the full acquire->queued->offer->Stop-hook-wakeup->
claim loop is driven through a real TUI session instead.

Usage:
  codex-pty.py LOGFILE DRIVER_SCRIPT [-- codex args ...]

Driver script directives, one per line:
  send <text>      type <text> and press Enter
  raw <text>       write bytes verbatim (no Enter added)
  expect <regex>   wait (expect-timeout) until regex matches NEW output
  sleep <secs>     pause
  mark             consume all output so far; later expects match only new output
  wait-exit        wait for the child to exit (after /quit etc.)

Expectations match against a pty log cleaned of ANSI escapes and control
chars, scanning only output received AFTER the previous matched expectation
(so 'expect' never matches stale text). The full raw transcript is written to
LOGFILE. Exit codes: 0 = all expectations matched and child exited cleanly;
1 = an expectation timed out (tail of log on stderr); 2 = spawn/other error.
"""

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
    # PTY_CWD / PTY_CMD let the driver be exercised outside the container.
    child = subprocess.Popen(
        [os.environ.get("PTY_CMD", "codex"), *rest],
        stdin=slave,
        stdout=slave,
        stderr=slave,
        cwd=os.environ.get("PTY_CWD", "/workspace"),
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
        sys.stderr.write(f"codex-pty: {msg}\n")
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
                # Type the text, give the TUI a moment to process the
                # keystrokes, then submit with a separate Enter. Writing
                # text and \r in a single chunk gets swallowed by the TUI
                # (observed: prompt echoed but never submitted).
                os.write(master, arg.encode())
                read_available(0.4)
                os.write(master, b"\r")
            elif kind == "raw":
                # interpret backslash escapes (\x1b[B = Down, \x04 = Ctrl-D, ...)
                os.write(master, arg.encode().decode("unicode_escape").encode("latin1"))
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
            return fail("driver script finished but codex still running")
        read_available(1.0)
        log.close()
        rc = child.returncode
        if rc not in (0, None):
            sys.stderr.write(f"codex-pty: codex exited rc={rc}\n")
        return 0
    finally:
        try:
            log.close()
        except Exception:
            pass


if __name__ == "__main__":
    sys.exit(main())
