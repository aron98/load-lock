/**
 * Session-derived agent identity (issue #49, umbrella #47 item 1).
 *
 * The daemon routes offers, `pending` and op-key duplicate suppression by
 * agentId, so the id must be "one per harness session": the same for every
 * call a session makes (whichever wiring — CLI, MCP server, hook — made it),
 * and different between sessions. Resolution order:
 *
 *   1. explicit override: `--agent` / `agent_id` (callers pass it as
 *      `override`) or `LOAD_LOCK_AGENT`;
 *   2. a harness session env var, where the harness exports one to the
 *      processes it spawns (see HARNESS_SESSION_ENV);
 *   3. the stable harness ancestor process: walk up from the caller's
 *      parent past shells and launcher wrappers (npm/npx, env, ...) to the
 *      first real ancestor, identified by pid + start time (pid-reuse
 *      safe). Linux reads /proc; macOS asks `ps` (issue #108); elsewhere
 *      this step is skipped;
 *   4. the caller's fallback (the CLI's legacy `cli:$USER@$HOSTNAME`).
 *
 * Pure apart from reading /proc or running `ps`; every input is injectable
 * for tests.
 */
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, join } from "node:path";

export type IdentitySource = "override" | "env" | "harness-env" | "ancestor" | "fallback";

export interface SessionIdentity {
  /** The agentId sent to the daemon. */
  id: string;
  /** Short human-readable label for holder lists (defaults to the id). */
  label: string;
  source: IdentitySource;
}

/**
 * Harness session env vars exported to child processes (verified only; a
 * harness that is not listed falls through to the ancestor walk).
 *
 * - Claude Code (2.1.x): `CLAUDE_CODE_SESSION_ID` in tool/hook/MCP children;
 *   the same value hooks receive on stdin as `session_id`.
 * - OpenCode (2.x): the bash tool exports `OPENCODE_SESSION_ID` = the
 *   session's `sessionID`, which is exactly the agentId the native plugin
 *   uses — so CLI calls from an OpenCode shell share the plugin's identity
 *   (hence no prefix).
 */
export const HARNESS_SESSION_ENV: { env: string; harness: string; id: (sid: string) => string }[] = [
  { env: "CLAUDE_CODE_SESSION_ID", harness: "claude-code", id: (sid) => "claude-code:" + sid },
  { env: "OPENCODE_SESSION_ID", harness: "opencode", id: (sid) => sid },
];

/** Interpreters/shells that sit between a harness and the CLI per tool call. */
const SHELLS = new Set([
  "sh", "bash", "dash", "zsh", "ksh", "mksh", "fish", "tcsh", "csh", "nu", "pwsh", "busybox",
  "env", "timeout", "nohup", "setsid", "stdbuf", "nice", "xargs",
]);
/** Launcher scripts recognized in argv[0..1] (node/bun running npm/npx, nested load-lock, plugin launcher). */
const WRAPPER_SCRIPTS = new Set([
  "npm", "npx", "npm-cli.js", "npx-cli.js", "pnpm", "pnpx", "yarn", "bunx", "load-lock", "load-lock.mjs",
]);

export interface ResolveOptions {
  /** Explicit id (e.g. `--agent` / `agent_id`); wins over everything. */
  override?: string;
  /** Used when nothing session-scoped is found. */
  fallback: string;
  env?: NodeJS.ProcessEnv;
  /** First process to inspect (default: the caller's parent). */
  startPid?: number;
  /** /proc root (tests plant a fake tree). Linux only. */
  procRoot?: string;
  /** `ps` runner (tests plant a fake process table). macOS only. */
  ps?: PsRunner;
  platform?: NodeJS.Platform;
}

export function sessionIdentity(opts: ResolveOptions): SessionIdentity {
  const env = opts.env ?? process.env;
  const override = opts.override?.trim();
  if (override) return { id: override, label: override, source: "override" };
  const envAgent = env.LOAD_LOCK_AGENT?.trim();
  if (envAgent) return { id: envAgent, label: envAgent, source: "env" };

  for (const h of HARNESS_SESSION_ENV) {
    const sid = env[h.env]?.trim();
    if (sid) return { id: h.id(sid), label: `${h.harness}:${sid.slice(0, 8)}`, source: "harness-env" };
  }

  const platform = opts.platform ?? process.platform;
  const reader =
    platform === "linux" ? procfsReader(opts.procRoot ?? "/proc")
    : platform === "darwin" ? psReader(opts.ps ?? runPs)
    : null;
  if (reader) {
    const anc = harnessAncestor(opts.startPid ?? process.ppid, reader);
    if (anc) {
      return { id: `proc:${anc.pid}:${anc.startTime}`, label: `${anc.comm}:${anc.pid}`, source: "ancestor" };
    }
  }
  return { id: opts.fallback, label: opts.fallback, source: "fallback" };
}

export interface ProcInfo {
  pid: number;
  ppid: number;
  comm: string;
  /**
   * Process start time: /proc/<pid>/stat field 22 (clock ticks since boot)
   * on Linux, epoch seconds from `ps -o lstart` on macOS.
   */
  startTime: string;
}

/** Reads one process's stat line and argv; null/[] when it is gone. */
export interface ProcReader {
  stat(pid: number): ProcInfo | null;
  argv(pid: number): string[];
}

/** Runs `ps` with the given args; stdout, or null when ps failed (no such pid). */
export type PsRunner = (args: string[]) => string | null;

export function runPs(args: string[]): string | null {
  // LC_ALL=C pins the lstart format (it is strftime %c, locale-dependent).
  const r = spawnSync("/bin/ps", args, { encoding: "utf8", env: { ...process.env, LC_ALL: "C" }, timeout: 2000 });
  return r.status === 0 && typeof r.stdout === "string" ? r.stdout : null;
}

function procfsReader(procRoot: string): ProcReader {
  return {
    stat: (pid) => readProc(pid, procRoot),
    argv: (pid) => {
      try {
        return readFileSync(join(procRoot, String(pid), "cmdline"), "utf8").split("\0");
      } catch {
        return [];
      }
    },
  };
}

/**
 * macOS has no /proc: `ps -o ppid=,lstart=,ucomm=` gives the parent, the
 * start time ("Fri Nov 27 17:15:58 2026" under LC_ALL=C, five tokens) and
 * the accounting name (rest of the line; may contain spaces). argv comes from
 * `ps -o args=`, which joins it with spaces — good enough for the basename
 * checks on argv[0..1] the wrapper test needs.
 */
export function psReader(ps: PsRunner): ProcReader {
  return {
    stat(pid) {
      const out = ps(["-o", "ppid=,lstart=,ucomm=", "-p", String(pid)])?.trim();
      if (!out) return null;
      const tok = out.split(/\s+/);
      const ppid = Number(tok[0]);
      const startTime = lstartSeconds(tok.slice(1, 6));
      const comm = tok.slice(6).join(" ").replace(/^-/, ""); // login shells show as "-zsh"
      if (!Number.isInteger(ppid) || !startTime || !comm) return null;
      return { pid, ppid, comm, startTime };
    },
    argv(pid) {
      return ps(["-ww", "-o", "args=", "-p", String(pid)])?.trim().split(/\s+/) ?? [];
    },
  };
}

/**
 * `lstart` tokens ("Fri Nov 27 17:15:58 2026" under LC_ALL=C) as epoch
 * seconds, the macOS start-time format. 1 s resolution: a pid reused within
 * the same second as the original start keeps the same value.
 */
function lstartSeconds(tok: string[]): string | null {
  if (tok.length !== 5) return null;
  const ms = Date.parse(tok.join(" "));
  return Number.isFinite(ms) ? String(Math.floor(ms / 1000)) : null;
}

/** One row of a whole-machine process snapshot. */
export interface ProcRow {
  pgid: number;
  /** Epoch seconds, same format as psReader's ProcInfo.startTime. */
  startTime: string;
}

/**
 * Whole process table in ONE `ps` call (issue #116): pid -> pgid + start
 * time, for the daemon's batched liveness sweep on macOS. null when ps
 * failed or printed nothing parseable — callers fall back to kill(pid, 0).
 * Unparseable lines are skipped.
 */
export function psProcessTable(ps: PsRunner = runPs): Map<number, ProcRow> | null {
  const out = ps(["-A", "-o", "pid=,pgid=,lstart="]);
  if (out == null) return null;
  const table = new Map<number, ProcRow>();
  for (const line of out.split("\n")) {
    const tok = line.trim().split(/\s+/);
    const pid = Number(tok[0]);
    const pgid = Number(tok[1]);
    const startTime = lstartSeconds(tok.slice(2, 7));
    if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(pgid) || !startTime) continue;
    table.set(pid, { pgid, startTime });
  }
  return table.size > 0 ? table : null;
}

export function readProc(pid: number, procRoot = "/proc"): ProcInfo | null {
  try {
    const stat = readFileSync(join(procRoot, String(pid), "stat"), "utf8");
    // comm is parenthesized and may itself contain spaces or parens.
    const open = stat.indexOf("(");
    const close = stat.lastIndexOf(")");
    if (open < 0 || close < open) return null;
    const rest = stat.slice(close + 2).split(" ");
    const ppid = Number(rest[1]);
    const startTime = rest[19];
    if (!Number.isInteger(ppid) || !startTime) return null;
    return { pid, ppid, comm: stat.slice(open + 1, close), startTime };
  } catch {
    return null;
  }
}

function isWrapper(p: ProcInfo, reader: ProcReader): boolean {
  if (SHELLS.has(p.comm)) return true;
  return reader.argv(p.pid).slice(0, 2).some((a) => a && WRAPPER_SCRIPTS.has(basename(a)));
}

/**
 * First ancestor (starting at `startPid`, inclusive) that is not a shell or
 * launcher wrapper. null when the walk reaches init/launchd (pid <= 1) or
 * the process table is unreadable — an orphaned caller has no harness to
 * share an identity with. `source` is a /proc root or a ProcReader.
 */
export function harnessAncestor(startPid: number, source: string | ProcReader = "/proc"): ProcInfo | null {
  const reader = typeof source === "string" ? procfsReader(source) : source;
  let pid = startPid;
  for (let depth = 0; depth < 32 && pid > 1; depth++) {
    const p = reader.stat(pid);
    if (!p) return null;
    if (!isWrapper(p, reader)) return p;
    pid = p.ppid;
  }
  return null;
}
