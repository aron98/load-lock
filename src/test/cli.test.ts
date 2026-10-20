/**
 * CLI dispatch tests (issue #22): `dashboard` as the primary name of the
 * live dashboard (with `top` as a hidden compat alias) and the `help`
 * command (bare `load-lock`, `--help`, `-h`, `help`, `help <command>`),
 * plus the unknown-command pointer to `load-lock help`.
 *
 * The help paths never connect to the daemon; the dashboard paths run the
 * real CLI against a real daemon (piped stdout, so `--once` behavior is
 * exercised both explicitly and via the non-TTY auto-once fallback).
 */
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { startDaemon, runCli, type DaemonHandle } from "./testutil.js";

let d: DaemonHandle;

before(async () => {
  d = await startDaemon();
});

after(async () => {
  await d.stop();
});

// ------------------------------------------------------------------ help

test("load-lock help prints a grouped one-screen usage", async () => {
  const r = await runCli(d, ["help"]);
  assert.equal(r.code, 0);
  for (const group of ["permit operations:", "waiting & running:", "read-only:", "service & diagnostics:", "setup & docs:"]) {
    assert.ok(r.stdout.includes(group), `group "${group}" present`);
  }
  // Every command (primary names and aliases) gets a one-liner.
  for (const name of [
    "acquire", "claim", "release", "cancel", "rejoin", "mark-started", "attach-pid",
    "wait", "run", "status", "pending", "events", "inspect", "config", "configure",
    "dashboard", "top", "service", "doctor", "recover", "install", "uninstall",
    "hook", "agent-guide", "help",
  ]) {
    assert.ok(r.stdout.includes(name), `command "${name}" described`);
  }
  assert.ok(r.stdout.includes("exit codes"), "exit codes line present");
});

test("bare load-lock and --help/-h print the same usage as help", async () => {
  const help = await runCli(d, ["help"]);
  const bare = await runCli(d, []);
  const longFlag = await runCli(d, ["--help"]);
  const shortFlag = await runCli(d, ["-h"]);
  for (const r of [help, bare, longFlag, shortFlag]) assert.equal(r.code, 0);
  assert.equal(bare.stdout, help.stdout, "bare load-lock matches help");
  assert.equal(longFlag.stdout, help.stdout, "--help matches help");
  assert.equal(shortFlag.stdout, help.stdout, "-h matches help");
});

test("load-lock help <command> prints one line; unknown topic fails", async () => {
  const r = await runCli(d, ["help", "dashboard"]);
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes("load-lock dashboard"), "primary name shown");
  assert.ok(r.stdout.includes("--once"), "one-liner mentions --once");

  const alias = await runCli(d, ["help", "top"]);
  assert.equal(alias.code, 0);
  assert.equal(alias.stdout, r.stdout, "alias resolves to the same command");

  const bad = await runCli(d, ["help", "frobnicate"]);
  assert.equal(bad.code, 64);
  assert.ok(bad.stderr.includes("load-lock help"), "points back to help");
});

test("unknown command points at load-lock help", async () => {
  const r = await runCli(d, ["frobnicate"]);
  assert.equal(r.code, 64);
  assert.ok(r.stderr.includes('unknown command "frobnicate"'), "names the bad command");
  assert.ok(r.stderr.includes("load-lock help"), "points to help");
});

test("flags without a command still default to status (not help)", async () => {
  // Regression guard: only a *bare* invocation prints usage; `--json` alone
  // keeps the historical status default.
  const r = await runCli(d, ["--json"]);
  assert.equal(r.code, 0);
  const parsed = JSON.parse(r.stdout);
  assert.ok(Array.isArray(parsed.pools), "status JSON");
});

// -------------------------------------------------------------- dashboard

test("load-lock dashboard --once renders one frame and exits clean", async () => {
  const r = await runCli(d, ["dashboard", "--once"]);
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes("load-lock dashboard"), "banner present");
  assert.ok(r.stdout.includes("POOL heavy"), "pool line present");
  assert.ok(r.stdout.includes("never acquires a permit"), "read-only note present");
});

test("load-lock dashboard auto-once when stdout is not a TTY", async () => {
  // Piped stdout must not enter the alt-screen live loop.
  const r = await runCli(d, ["dashboard"]);
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes("load-lock dashboard"), "frame rendered");
  assert.ok(!r.stdout.includes("\x1b[?1049h"), "no alt-screen escape in a pipe");
});

test("top stays a working compat alias for dashboard", async () => {
  const alias = await runCli(d, ["top", "--once"]);
  const primary = await runCli(d, ["dashboard", "--once"]);
  assert.equal(alias.code, 0);
  assert.equal(primary.code, 0);
  // "synced N ago" and daemon uptime tick between runs; normalize before comparing.
  // The MACHINE block is live host telemetry — load averages, available memory
  // and the used-percentage in the pressure note move (and round across
  // boundaries) between the two back-to-back runs — so collapse it wholesale;
  // the alias check is that everything *else* renders identically.
  const norm = (s: string) =>
    s
      .replace(/synced \S+ ago/g, "synced N ago")
      .replace(/uptime \S+/g, "uptime N")
      .replace(/^MACHINE.*\n\s*pressure:.*\n/m, "MACHINE <live telemetry>\n");
  assert.equal(norm(alias.stdout), norm(primary.stdout), "identical rendering");
});
