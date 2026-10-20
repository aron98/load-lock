/**
 * `load-lock update` (issue #38): check the npm registry for a newer
 * version (npm is the only distribution channel), classify where THIS copy
 * lives before touching anything, and apply the update via the detected
 * package manager — or refuse honestly (repo checkouts, opencode-managed
 * cache copies, unknown locations) rather than guessing. After a
 * successful apply, `service restart` moves the daemon onto the new code
 * immediately; the v1.3.0 version handshake stays as the safety net for
 * daemons nobody explicitly restarts.
 *
 * Classification and planning are pure functions of their arguments
 * (planted-layout testable, like shared/transport.ts); the registry and
 * package-manager spawns resolve `npm` through PATH so tests stub them
 * with a fake `npm` on PATH — the real registry is never contacted in
 * tests and nothing is ever installed by them.
 *
 * Exit codes: 0 up-to-date / applied; 1 update available (`--check`,
 * including "an update exists but this copy cannot self-apply" refusals);
 * 70 failure (registry unreachable, package manager failed, refused in
 * apply mode, or restart failed after an applied update).
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { homedir } from "node:os";

import { compareVersions, packageVersion } from "../shared/version.js";
import { opencodeCacheRoot, PKG_NAME } from "../shared/pkginfo.js";
import { thisCopy } from "./copies.js";
import { serviceRestart, ServiceError } from "./service.js";

// ------------------------------------------------------- pure classification

export type SelfLocationKind = "bun-global" | "npm-global" | "opencode-cache" | "repo-checkout" | "unknown";

export interface SelfLocation {
  kind: SelfLocationKind;
  /** Package root of this copy. */
  path: string;
  /** Explanation shown in reports (part of the refusal reason when refusing). */
  detail: string;
}

/** Inputs classifySelf needs; callers resolve them (tests plant values). */
export interface ClassifyCtx {
  home: string;
  /** bun global node_modules root; default <home>/.bun/install/global/node_modules. */
  bunGlobalRoot?: string;
  /** `npm root -g` result; null when npm could not answer. */
  npmGlobalRoot: string | null;
  /** opencode cache root (XDG_CACHE_HOME | platform default); null when unknown. */
  cacheRoot: string | null;
}

/** Path containment with separator awareness ("a" contains "a" and "a/b"). */
function isUnder(dir: string, root: string): boolean {
  if (dir === root) return true;
  return dir.startsWith(root.endsWith(sep) ? root : root + sep);
}

/**
 * Classify where this copy of load-lock lives, BEFORE touching anything:
 *  - bun global (<home>/.bun/install/global/node_modules/...) → update via bun
 *  - npm global (under `npm root -g`) → update via npm
 *  - opencode cache copy (<cache>/opencode/npm/...) → refuse: opencode
 *    manages this copy and refreshes it on its own schedule
 *  - repo checkout (nearest .git found by walking up, like the omac
 *    read-grant logic) → refuse with a pointer to the git workflow
 *  - anything else → unknown → refuse honestly rather than guessing
 */
export function classifySelf(pkgRoot: string, ctx: ClassifyCtx): SelfLocation {
  const bunRoot = ctx.bunGlobalRoot ?? join(ctx.home, ".bun", "install", "global", "node_modules");
  if (isUnder(pkgRoot, bunRoot)) {
    return { kind: "bun-global", path: pkgRoot, detail: `bun global install under ${bunRoot}` };
  }
  if (ctx.npmGlobalRoot && isUnder(pkgRoot, ctx.npmGlobalRoot)) {
    return { kind: "npm-global", path: pkgRoot, detail: `npm global install under ${ctx.npmGlobalRoot}` };
  }
  if (ctx.cacheRoot && isUnder(pkgRoot, join(ctx.cacheRoot, "opencode", "npm"))) {
    return { kind: "opencode-cache", path: pkgRoot, detail: `opencode-managed cache copy under ${ctx.cacheRoot}` };
  }
  for (let dir = pkgRoot; ; ) {
    if (existsSync(join(dir, ".git"))) {
      return { kind: "repo-checkout", path: pkgRoot, detail: `git checkout (.git at ${dir})` };
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { kind: "unknown", path: pkgRoot, detail: "not a recognized bun/npm global, opencode cache, or git checkout location" };
}

export type UpdatePlan =
  | { action: "install"; argv: string[]; detail: string }
  | { action: "refuse"; reason: string };

/** What to run for the detected location — or why we refuse to guess. */
export function planUpdate(loc: SelfLocation): UpdatePlan {
  switch (loc.kind) {
    case "bun-global":
      return { action: "install", argv: ["bun", "i", "-g", `${PKG_NAME}@latest`], detail: loc.detail };
    case "npm-global":
      return { action: "install", argv: ["npm", "i", "-g", `${PKG_NAME}@latest`], detail: loc.detail };
    case "opencode-cache":
      return {
        action: "refuse",
        reason:
          `this copy lives in opencode's npm cache (${loc.path}); opencode manages it and refreshes it on its own schedule — ` +
          `update the PATH-installed CLI instead (npm i -g ${PKG_NAME}@latest)`,
      };
    case "repo-checkout":
      return {
        action: "refuse",
        reason: `this copy is a git checkout (${loc.path}) — update it via your git workflow (e.g. git pull), not a package manager`,
      };
    case "unknown":
      return {
        action: "refuse",
        reason:
          `cannot tell how this copy (${loc.path}) was installed — refusing to guess; ` +
          `if it is a global install, run npm i -g ${PKG_NAME}@latest (or the bun equivalent) by hand`,
      };
  }
}

// ------------------------------------------------------------ CLI wiring

export interface UpdateOptions {
  /** --check: report only, never install or restart. */
  check: boolean;
  /** --json: machine-readable output (house style: humans get prose). */
  json: boolean;
}

/** One npm invocation, bounded; resolves null on timeout/spawn failure. */
function npmOutput(args: string[], timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string } | null> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let child;
    try {
      child = spawn("npm", args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(null);
    }, timeoutMs);
    timer.unref?.();
    child.stdout?.on("data", (b) => (stdout += b));
    child.stderr?.on("data", (b) => (stderr += b));
    child.once("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/** Latest published version from the npm registry, or null on failure. */
async function viewLatest(timeoutMs: number): Promise<string | null> {
  const r = await npmOutput(["view", PKG_NAME, "version"], timeoutMs);
  if (!r || r.code !== 0) return null;
  // `npm view <pkg> version` prints the bare version (possibly quoted).
  const line = r.stdout.trim().split("\n").pop() ?? "";
  const v = line.replace(/^"|"$/g, "").trim();
  return /^\d+(\.\d+)*(-.*)?$/.test(v) ? v : null;
}

/** `npm root -g` (the global node_modules dir), or null on failure. */
async function npmGlobalRoot(timeoutMs: number): Promise<string | null> {
  const r = await npmOutput(["root", "-g"], timeoutMs);
  if (!r || r.code !== 0) return null;
  const line = r.stdout.trim().split("\n").pop() ?? "";
  return line || null;
}

function fail(msg: string, code = 70): never {
  process.stderr.write(`load-lock: ${msg}\n`);
  process.exit(code);
}

/**
 * The `load-lock update` command. Prints a structured report (JSON with
 * --json, prose otherwise) and returns the exit code:
 *   0  up-to-date (check) or applied successfully
 *   1  update available (--check; includes "cannot self-apply" refusals)
 *   70 failure or refusal in apply mode
 */
export async function updateCommand(opts: UpdateOptions): Promise<number> {
  const timeoutMs = 30_000;
  const out = (v: unknown, human: () => string): void => {
    if (opts.json) process.stdout.write(JSON.stringify(v, null, 2) + "\n");
    else process.stdout.write(human() + "\n");
  };
  const locationReport = (loc: SelfLocation) => ({ kind: loc.kind, path: loc.path });

  // 1. Classify self BEFORE touching anything (local only, no registry).
  const self = thisCopy();
  const own = packageVersion();
  if (!self) {
    fail(`cannot resolve this copy's package root — run \`load-lock doctor\``);
  }
  const root = await npmGlobalRoot(timeoutMs);
  const loc = classifySelf(self.path, {
    home: process.env.HOME ?? homedir(),
    npmGlobalRoot: root,
    cacheRoot: opencodeCacheRoot(process.platform, process.env),
  });

  // 2. Check the registry (npm is the only distribution channel).
  const latest = await viewLatest(timeoutMs);
  if (latest === null) {
    fail(
      `could not determine the latest published version of ${PKG_NAME} (npm view failed — is the registry reachable?)`,
    );
  }

  // 3. Up to date (or this copy is ahead of the registry — nothing to do).
  if (compareVersions(latest, own) <= 0) {
    const ahead = compareVersions(latest, own) < 0;
    const report = {
      state: "up-to-date" as const,
      current_version: own,
      latest_version: latest,
      location: locationReport(loc),
      ...(ahead ? { note: `this copy (v${own}) is newer than the registry latest (v${latest}) — nothing to do` } : {}),
    };
    out(report, () =>
      `load-lock: up to date (v${own}; registry latest v${latest}; location: ${loc.kind})` +
      (ahead ? ` — this copy is ahead of the registry` : ""),
    );
    return 0;
  }

  // 4. An update exists: plan the apply for the classified location.
  const plan = planUpdate(loc);
  if (plan.action === "refuse") {
    const report = {
      state: "refused" as const,
      current_version: own,
      latest_version: latest,
      location: locationReport(loc),
      reason: plan.reason,
      next_action: "resolve the location issue, then run `load-lock update` again (see docs/OPERATIONS.md)",
    };
    out(report, () => `load-lock: update to v${latest} available, but refused: ${plan.reason}`);
    if (opts.check) return 1; // an update exists — this copy just cannot self-apply it
    process.stderr.write(`load-lock: update refused — ${plan.reason}\n`);
    return 70;
  }

  // 5. --check: report what WOULD happen; touch nothing.
  if (opts.check) {
    const report = {
      state: "update-available" as const,
      current_version: own,
      latest_version: latest,
      location: locationReport(loc),
      command: plan.argv,
      next_action: "run `load-lock update` to apply it; the service restarts automatically afterwards",
    };
    out(
      report,
      () =>
        `load-lock: update available: v${own} -> v${latest} (location: ${loc.kind}; would run: ${plan.argv.join(" ")})`,
    );
    return 1;
  }

  // 6. Apply: run the detected package manager (output shown live).
  process.stdout.write(
    opts.json
      ? JSON.stringify({ state: "applying", current_version: own, latest_version: latest, command: plan.argv }, null, 2) + "\n"
      : `load-lock: updating v${own} -> v${latest} via ${plan.argv.join(" ")}\n`,
  );
  const code = await new Promise<number | null>((resolve) => {
    let child;
    try {
      child = spawn(plan.argv[0], plan.argv.slice(1), { stdio: "inherit" });
    } catch (e) {
      fail(`cannot run ${plan.argv[0]}: ${(e as Error).message}`);
    }
    child.once("error", (e) => fail(`cannot run ${plan.argv[0]}: ${e.message}`));
    child.once("exit", (c) => resolve(c));
  });
  if (code !== 0) {
    fail(`update not applied: ${plan.argv.join(" ")} exited with code ${code} — the daemon keeps running the current code`);
  }

  // 7. Restart the service so the daemon moves onto the new code now
  // (the version handshake remains the safety net, not the primary means).
  try {
    const r = await serviceRestart();
    const report = {
      state: "updated" as const,
      from: own,
      to: latest,
      location: locationReport(loc),
      command: plan.argv,
      restarted: true,
      restart: { stop: r.stop, start: r.start },
    };
    out(report, () => `load-lock: updated v${own} -> v${latest}; ${r.stop}; ${r.start}`);
    return 0;
  } catch (e) {
    const reason = e instanceof ServiceError ? e.message : String((e as Error)?.message ?? e);
    const report = {
      state: "updated" as const,
      from: own,
      to: latest,
      location: locationReport(loc),
      command: plan.argv,
      restarted: false,
      restart_error: reason,
      next_action:
        "the update IS applied; the daemon still runs old code — the version handshake will self-restart it on the " +
        "next client contact, or run `load-lock service restart` manually (see docs/OPERATIONS.md)",
    };
    out(report, () => `load-lock: updated v${own} -> v${latest}, but the service restart failed: ${reason}`);
    process.stderr.write(`load-lock: ${reason}\n`);
    return 70;
  }
}
