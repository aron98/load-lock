#!/usr/bin/env node
/**
 * load-lock plugin launcher (issue #60).
 *
 * Plugin and ACE bundles are git folders: no dist/, no node_modules. This
 * file is committed as-is (plain ESM, Node built-ins only, no build step)
 * and finds a load-lock runtime to run:
 *
 *   1. `load-lock` on PATH, when its version is >= PIN;
 *   2. else the newest known runtime copy >= PIN recorded in the state dir
 *      (runtimes.json / daemon.json, issue #52);
 *   3. else `npx --yes --package=<PACKAGE_SPEC>`.
 *
 * Branches 1 and 2 run the copy's compiled entry with this node directly
 * (no shell, no .cmd shim, so Windows needs no special casing there). For
 * npx it prefers the npx-cli.js that ships next to this node, falling back
 * to `npx` (POSIX) / `npx.cmd` via a shell (Windows).
 *
 *   node load-lock.mjs [--bin load-lock|load-lock-mcp] <args...>
 *
 * Hook mode (`--bin load-lock hook ...`) must never break or stall a
 * session: npx runs with --offline (cache only, so it fails fast instead of
 * downloading), the run is bounded by LOAD_LOCK_LAUNCHER_TIMEOUT_MS (default
 * 15s; not applied to the long-lived `await-offer` watcher), and any failure
 * exits 0. Exit 2 passes through (await-offer's asyncRewake signal). On
 * SessionStart a failure prints one install hint instead of the policy.
 * Other modes (the MCP server) pass the child's exit code through.
 *
 * PACKAGE_SPEC is kept equal to package.json's version by
 * scripts/check-pins.mjs (issue #48).
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_NAME = "@aron98/load-lock";
const PACKAGE_SPEC = "@aron98/load-lock@1.6.0";
const PIN = PACKAGE_SPEC.slice(PACKAGE_NAME.length + 1);

/** Compiled entry per bin, relative to a package root (package.json "bin"). */
const BINS = { "load-lock": "dist/cli/main.js", "load-lock-mcp": "dist/mcp/main.js" };

const DEFAULT_HOOK_TIMEOUT_MS = 15_000;

/** Same dotted comparison as src/shared/version.ts compareVersions. */
export function compareVersions(a, b) {
  const parse = (v) => String(v).split(".").map((s) => Number(/^(\d+)/.exec(s.trim())?.[1] ?? 0));
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** {root, version} when `root` is a load-lock package root holding `entry`. */
function inspectRoot(root, entry) {
  try {
    const real = realpathSync(root);
    const pkg = JSON.parse(readFileSync(join(real, "package.json"), "utf8"));
    if (pkg?.name !== PACKAGE_NAME || typeof pkg.version !== "string") return null;
    if (!existsSync(join(real, entry))) return null;
    return { root: real, version: pkg.version };
  } catch {
    return null;
  }
}

/** Package root behind the first `load-lock` on PATH, or null. */
export function pathCopy(env, platform, entry) {
  const names = platform === "win32" ? ["load-lock.cmd", "load-lock.ps1", "load-lock"] : ["load-lock"];
  for (const dir of (env.PATH ?? env.Path ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const file = join(dir, name);
      if (!existsSync(file)) continue;
      // POSIX npm: <prefix>/bin/load-lock -> ../lib/node_modules/<pkg>/dist/cli/main.js.
      // Windows npm: <prefix>\load-lock.cmd shim next to <prefix>\node_modules\<pkg>.
      const candidates = [join(dirname(dir), "lib", "node_modules", PACKAGE_NAME), join(dir, "node_modules", PACKAGE_NAME)];
      try {
        const real = realpathSync(file);
        if (real.replace(/\\/g, "/").endsWith("/dist/cli/main.js")) candidates.unshift(join(dirname(real), "..", ".."));
      } catch {
        /* dangling link: try the layout guesses */
      }
      for (const c of candidates) {
        const found = inspectRoot(c, entry);
        if (found) return { ...found, source: "path" };
      }
      return null; // the first load-lock on PATH is the PATH CLI, usable or not
    }
  }
  return null;
}

/** Same precedence as src/shared/transport.ts resolveStateDir. */
export function stateDir(env, platform) {
  if (env.LOAD_LOCK_STATE_DIR) return env.LOAD_LOCK_STATE_DIR;
  if (platform === "win32") {
    return join(env.LOCALAPPDATA || join(env.USERPROFILE ?? "~", "AppData", "Local"), "load-lock");
  }
  return join(env.XDG_STATE_HOME || join(env.HOME ?? "~", ".local", "state"), "load-lock");
}

/** Newest known runtime copy >= PIN from runtimes.json / daemon.json, or null. */
export function stateCopy(env, platform, entry) {
  const dir = stateDir(env, platform);
  const roots = [];
  try {
    const raw = JSON.parse(readFileSync(join(dir, "runtimes.json"), "utf8"));
    for (const c of Array.isArray(raw?.copies) ? raw.copies : []) if (typeof c?.path === "string") roots.push(c.path);
  } catch {
    /* no runtimes.json */
  }
  try {
    const d = JSON.parse(readFileSync(join(dir, "daemon.json"), "utf8"));
    if (typeof d?.packageRoot === "string") roots.push(d.packageRoot);
  } catch {
    /* no daemon.json */
  }
  let best = null;
  for (const r of roots) {
    const found = inspectRoot(r, entry);
    if (found && compareVersions(found.version, PIN) >= 0 && (!best || compareVersions(found.version, best.version) > 0)) {
      best = found;
    }
  }
  return best && { ...best, source: "state" };
}

/** How to run npx: [command, leading args, spawn options]. */
export function npxCommand(env, platform, execPath) {
  const override = env.LOAD_LOCK_LAUNCHER_NPX_CLI;
  const clis = override
    ? [override]
    : [
        join(dirname(execPath), "node_modules", "npm", "bin", "npx-cli.js"),
        join(dirname(execPath), "..", "lib", "node_modules", "npm", "bin", "npx-cli.js"),
      ];
  for (const cli of clis) if (existsSync(cli)) return { command: execPath, args: [cli], shell: false };
  if (override) return null;
  return platform === "win32" ? { command: "npx.cmd", args: [], shell: true } : { command: "npx", args: [], shell: false };
}

/**
 * Pick the runtime for `bin`: { command, args, shell, source } or null.
 * Exported for tests; `opts.offline` adds npm's --offline (hook mode).
 */
export function resolveRuntime(bin, rest, opts = {}) {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const execPath = opts.execPath ?? process.execPath;
  const entry = BINS[bin];
  const fromPath = pathCopy(env, platform, entry);
  const local = fromPath && compareVersions(fromPath.version, PIN) >= 0 ? fromPath : stateCopy(env, platform, entry);
  if (local) {
    return { command: execPath, args: [join(local.root, entry), ...rest], shell: false, source: local.source, version: local.version };
  }
  const npx = npxCommand(env, platform, execPath);
  if (!npx) return null;
  const flags = ["--yes", ...(opts.offline ? ["--offline"] : []), `--package=${PACKAGE_SPEC}`, "--", bin];
  return { ...npx, args: [...npx.args, ...flags, ...rest], source: "npx", version: PIN };
}

function installHint() {
  return (
    `load-lock: the plugin found no runtime (no \`load-lock\` >= ${PIN} on PATH, no known copy, ` +
    `and ${PACKAGE_SPEC} is not in the npx cache yet). Its MCP server fetches it via npx on first start; ` +
    `or install it once with \`npm i -g ${PACKAGE_NAME}\`. load-lock hooks stay inactive until then.\n`
  );
}

function main(argv) {
  let bin = "load-lock";
  if (argv[0] === "--bin") {
    bin = argv[1];
    argv = argv.slice(2);
  }
  if (!Object.hasOwn(BINS, bin)) {
    process.stderr.write(`load-lock launcher: unknown --bin ${JSON.stringify(bin)}\n`);
    process.exit(64);
  }
  const hook = bin === "load-lock" && argv[0] === "hook";
  const sessionStart = hook && argv[2] === "session-start";
  const env = process.env;
  const debug = env.LOAD_LOCK_LAUNCHER_DEBUG === "1";

  // Hook mode: never fail the harness. Exit 2 is await-offer's wakeup.
  // Exit only after stdout drained (pipes can be asynchronous).
  let done = false;
  const finish = (code, ranOutput) => {
    if (done) return;
    done = true;
    let exit = code ?? 1;
    let out = "";
    if (hook && exit !== 0 && exit !== 2) {
      if (sessionStart && !ranOutput) out = installHint();
      exit = 0;
    }
    process.stdout.write(out, () => process.exit(exit));
  };

  let rt;
  try {
    rt = resolveRuntime(bin, argv, { offline: hook });
  } catch {
    rt = null;
  }
  if (!rt) {
    if (!hook) process.stderr.write(`load-lock launcher: no runtime found and npx is unavailable. ${installHint()}`);
    return finish(1, false);
  }
  if (debug) process.stderr.write(`load-lock launcher: ${rt.source} ${rt.version}: ${rt.command} ${rt.args.join(" ")}\n`);

  let wrote = false;
  const child = spawn(rt.command, rt.args, {
    // Hook stdout is relayed so a failed SessionStart can tell whether the
    // policy already went out before printing the hint instead.
    stdio: ["inherit", hook ? "pipe" : "inherit", "inherit"],
    shell: rt.shell,
    windowsHide: true,
    // Own process group (POSIX) so a timeout also kills npx's child.
    detached: hook && process.platform !== "win32",
  });
  const kill = (sig) => {
    try {
      if (hook && process.platform !== "win32") process.kill(-child.pid, sig);
      else child.kill(sig);
    } catch {
      /* already gone */
    }
  };
  if (hook) {
    child.stdout.on("data", (chunk) => {
      wrote = true;
      process.stdout.write(chunk);
    });
  }
  const limit = Number(env.LOAD_LOCK_LAUNCHER_TIMEOUT_MS ?? DEFAULT_HOOK_TIMEOUT_MS);
  const timer =
    hook && argv[2] !== "await-offer" && limit > 0
      ? setTimeout(() => {
          kill("SIGKILL");
          finish(1, wrote);
        }, limit)
      : null;
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(sig, () => kill(sig));
  }
  child.on("error", () => {
    if (timer) clearTimeout(timer);
    if (!hook) process.stderr.write(`load-lock launcher: could not start ${rt.command}. ${installHint()}`);
    finish(1, wrote);
  });
  child.on("close", (code, signal) => {
    if (timer) clearTimeout(timer);
    finish(signal ? 1 : code, wrote);
  });
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2));
}
