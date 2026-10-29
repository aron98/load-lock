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
 *      first real ancestor, identified by pid + /proc start time (pid-reuse
 *      safe). Linux only; elsewhere this step is skipped;
 *   4. the caller's fallback (the CLI's legacy `cli:$USER@$HOSTNAME`).
 *
 * Pure apart from reading /proc; every input is injectable for tests.
 */
import { readFileSync } from "node:fs";
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
  /** /proc root (tests plant a fake tree). */
  procRoot?: string;
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
  if (platform === "linux") {
    const anc = harnessAncestor(opts.startPid ?? process.ppid, opts.procRoot ?? "/proc");
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
  /** /proc/<pid>/stat field 22 (clock ticks since boot). */
  startTime: string;
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

function isWrapper(p: ProcInfo, procRoot: string): boolean {
  if (SHELLS.has(p.comm)) return true;
  let argv: string[] = [];
  try {
    argv = readFileSync(join(procRoot, String(p.pid), "cmdline"), "utf8").split("\0");
  } catch {
    return false;
  }
  return argv.slice(0, 2).some((a) => a && WRAPPER_SCRIPTS.has(basename(a)));
}

/**
 * First ancestor (starting at `startPid`, inclusive) that is not a shell or
 * launcher wrapper. null when the walk reaches init (pid <= 1) or /proc is
 * unreadable — an orphaned caller has no harness to share an identity with.
 */
export function harnessAncestor(startPid: number, procRoot = "/proc"): ProcInfo | null {
  let pid = startPid;
  for (let depth = 0; depth < 32 && pid > 1; depth++) {
    const p = readProc(pid, procRoot);
    if (!p) return null;
    if (!isWrapper(p, procRoot)) return p;
    pid = p.ppid;
  }
  return null;
}
