/**
 * Integration tests for issue #38:
 *  - `load-lock update`: classify-self (pure, planted layouts), registry
 *    check, --check exit codes, refusals (repo checkout, opencode cache),
 *    and a full apply+restart e2e against a planted npm-global copy
 *  - `service restart`: compositing the hardened stop + honest start,
 *    both phases reported, failures naming the phase
 *  - adapter-init drift notice: pure detectCliDrift with planted PATH
 *    copies, plus real MCP-server and OpenCode-plugin init e2e
 *
 * The npm registry is NEVER contacted and nothing is ever installed: npm
 * is stubbed via a fake `npm` first on PATH (reads STUB_* env vars), the
 * same inject/stub seam philosophy as src/shared/transport.ts. Real
 * daemons run in temp state dirs under LL_TEST_TMP — never the user's dir.
 *
 * Modeled after update.test.ts (issue #34).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { classifySelf, planUpdate } from "../cli/update.js";
import { detectCliDrift } from "../shared/drift.js";
import { packageVersion } from "../shared/version.js";
import { cliMainPath, mcpMainPath, startDaemon, probe, delay, type DaemonHandle } from "./testutil.js";

const TMP_BASE = process.env.LL_TEST_TMP ?? join(tmpdir(), "opencode");
mkdirSync(TMP_BASE, { recursive: true });

const DIST_DIR = join(dirname(cliMainPath), "..");
const PLUGIN_DIST = join(DIST_DIR, "adapters", "opencode", "plugin.js");
const REPO_ROOT = join(DIST_DIR, "..");

/** Run the compiled CLI (or a planted copy of it) with an explicit env. */
function runCliEnv(env: Record<string, string>, args: string[], cliPath: string = cliMainPath, timeoutMs = 60_000): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], { env });
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (b) => (stdout += b));
    child.stderr!.on("data", (b) => (stderr += b));
    child.stdin!.end();
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`CLI timed out: load-lock ${args.join(" ")}`));
    }, timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.once("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

/** Kill whatever daemon currently owns the state dir (respawns are not our child). */
function killDaemonFromJson(dir: string): void {
  try {
    const info = JSON.parse(readFileSync(join(dir, "daemon.json"), "utf8"));
    if (typeof info.pid === "number") {
      try {
        process.kill(info.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  } catch {
    /* no daemon.json — nothing to kill */
  }
}

/** Send a raw envelope line; resolve the first response (null on failure). */
function rawRequest(sockPath: string, envelope: Record<string, unknown>, timeoutMs = 3000): Promise<any | null> {
  return new Promise((resolve) => {
    let settled = false;
    let buf = "";
    const done = (v: any) => {
      if (settled) return;
      settled = true;
      try {
        s.destroy();
      } catch {
        /* ignore */
      }
      resolve(v);
    };
    const s = connect(sockPath, () => {
      s.write(JSON.stringify(envelope) + "\n");
    });
    s.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const idx = buf.indexOf("\n");
      if (idx === -1) return;
      try {
        done(JSON.parse(buf.slice(0, idx)));
      } catch {
        done(null);
      }
    });
    s.on("error", () => done(null));
    setTimeout(() => done(null), timeoutMs).unref?.();
  });
}

/** Version-less hello (must never order a self-restart). */
const helloFrom = () => ({ id: 1, method: "hello", params: {} }) as Record<string, unknown>;

/** A fake `npm` first on PATH: view/root serve env vars, `i` writes a marker. */
function makeStubNpm(binDir: string): void {
  mkdirSync(binDir, { recursive: true });
  const script =
    "#!/bin/sh\n" +
    'case "$1" in\n' +
    "  view)\n" +
    '    [ -n "$STUB_FAIL" ] && exit 1\n' +
    '    echo "$STUB_VERSION"\n' +
    "    ;;\n" +
    "  root)\n" +
    '    echo "$STUB_ROOT"\n' +
    "    ;;\n" +
    "  i|install)\n" +
    '    echo "stubbed $*" > "$STUB_MARK" || exit 1\n' +
    '    echo "stub npm: installed $3"\n' +
    "    ;;\n" +
    "  *)\n" +
    "    exit 64\n" +
    "    ;;\n" +
    "esac\n";
  writeFileSync(join(binDir, "npm"), script);
  chmodSync(join(binDir, "npm"), 0o755);
}

/**
 * Plant a load-lock package copy (package.json + dist) at `dest` and return
 * its CLI entry path. The version is rewritten so `latest` can outrank it.
 */
function plantCopy(dest: string, version: string): string {
  mkdirSync(dest, { recursive: true });
  cpSync(DIST_DIR, join(dest, "dist"), { recursive: true });
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
  pkg.version = version;
  writeFileSync(join(dest, "package.json"), JSON.stringify(pkg, null, 2));
  return join(dest, "dist", "cli", "main.js");
}

/** Plant a minimal load-lock package (just package.json + bin) for drift detection. */
function plantBinCopy(dest: string, version: string): string {
  mkdirSync(join(dest, "bin"), { recursive: true });
  writeFileSync(join(dest, "package.json"), JSON.stringify({ name: "@aron98/load-lock", version }));
  writeFileSync(join(dest, "bin", "load-lock"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(dest, "bin", "load-lock"), 0o755);
  return join(dest, "bin");
}

// --------------------------------------------------- classifySelf / planUpdate (pure)

test("classifySelf: bun global / npm global / opencode cache / repo / unknown", (t) => {
  const base = mkdtempSync(join(TMP_BASE, "classify-"));
  try {
    const home = join(base, "home");
    const ctx = { home, npmGlobalRoot: join(base, "npm-root"), cacheRoot: join(base, "cache") };

    // bun global: under <home>/.bun/install/global/node_modules (default root)
    const bunRoot = classifySelf(join(home, ".bun", "install", "global", "node_modules", "@aron98", "load-lock"), ctx);
    assert.equal(bunRoot.kind, "bun-global");

    // npm global: under the given `npm root -g`
    const npmRoot = classifySelf(join(base, "npm-root", "@aron98", "load-lock"), ctx);
    assert.equal(npmRoot.kind, "npm-global");

    // opencode cache copy: under <cacheRoot>/opencode/npm/...
    const cache = classifySelf(
      join(base, "cache", "opencode", "npm", "@aron98/load-lock@latest", "123", "node_modules", "@aron98", "load-lock"),
      ctx,
    );
    assert.equal(cache.kind, "opencode-cache");

    // repo checkout: a .git above the package root (planted, like the real walk)
    mkdirSync(join(base, "repo", "pkg"), { recursive: true });
    mkdirSync(join(base, "repo", ".git"), { recursive: true });
    const repo = classifySelf(join(base, "repo", "pkg"), ctx);
    assert.equal(repo.kind, "repo-checkout");
    assert.ok(repo.detail.includes("git"), "detail names git");

    // unknown: nothing matches and no .git above (temp dirs under TMP_BASE)
    let hasGitAbove = false;
    for (let dir = base; ; ) {
      if (existsSync(join(dir, ".git"))) {
        hasGitAbove = true;
        break;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    if (hasGitAbove) {
      t.skip("an ancestor of the temp dir contains .git — cannot test the unknown location honestly here");
      return;
    }
    const unknown = classifySelf(join(base, "loose"), ctx);
    assert.equal(unknown.kind, "unknown");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("planUpdate: install argvs for bun/npm; honest refusals otherwise", () => {
  const mk = (kind: any, path = "/x") => ({ kind, path, detail: "" }) as any;
  const bun = planUpdate(mk("bun-global"));
  assert.equal(bun.action, "install");
  assert.deepEqual(bun.argv, ["bun", "i", "-g", "@aron98/load-lock@latest"]);

  const npm = planUpdate(mk("npm-global"));
  assert.equal(npm.action, "install");
  assert.deepEqual(npm.argv, ["npm", "i", "-g", "@aron98/load-lock@latest"]);

  const cache = planUpdate(mk("opencode-cache"));
  assert.equal(cache.action, "refuse");
  assert.ok(cache.reason.includes("opencode"), "cache refusal explains opencode manages it");

  const repo = planUpdate(mk("repo-checkout"));
  assert.equal(repo.action, "refuse");
  assert.ok(repo.reason.includes("git"), "repo refusal points at the git workflow");

  const unknown = planUpdate(mk("unknown"));
  assert.equal(unknown.action, "refuse");
  assert.ok(unknown.reason.includes("cannot tell"), "unknown refusal admits it cannot tell");
});

// --------------------------------------------------------- detectCliDrift (pure)

test("detectCliDrift: older PATH copy -> one notice with the exact command", () => {
  const base = mkdtempSync(join(TMP_BASE, "drift-"));
  try {
    const binDir = plantBinCopy(join(base, "copy"), "0.9.0");
    const d = detectCliDrift("9.9.9", { PATH: binDir }, "linux");
    assert.ok(d, "older PATH copy is drift");
    assert.equal(d!.cliVersion, "0.9.0");
    assert.equal(d!.ownVersion, "9.9.9");
    assert.ok(d!.message.includes("load-lock update"), "notice names the exact command");
    assert.ok(d!.message.includes("0.9.0"), "notice names the old version");
    assert.ok(d!.message.includes("auto-install"), "notice states nothing is auto-installed");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("detectCliDrift: same/newer PATH copy, no PATH entry, foreign bin -> no drift", () => {
  const base = mkdtempSync(join(TMP_BASE, "nodrift-"));
  try {
    const same = plantBinCopy(join(base, "same"), "9.9.9");
    assert.equal(detectCliDrift("9.9.9", { PATH: same }, "linux"), null, "same version is not drift");

    const newer = plantBinCopy(join(base, "newer"), "99.0.0");
    assert.equal(detectCliDrift("9.9.9", { PATH: newer }, "linux"), null, "newer PATH CLI is not drift");

    assert.equal(detectCliDrift("9.9.9", { PATH: "" }, "linux"), null, "no PATH entry -> nothing to compare");

    // A load-lock bin with no enclosing @aron98/load-lock package.json
    // cannot be compared honestly -> no drift, no crash.
    mkdirSync(join(base, "bare"), { recursive: true });
    writeFileSync(join(base, "bare", "load-lock"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(base, "bare", "load-lock"), 0o755);
    assert.equal(detectCliDrift("9.9.9", { PATH: join(base, "bare") }, "linux"), null, "foreign bin -> null, never throws");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// ----------------------------------------------------------------- version flag

test("cli: --version flag and `version` command print this copy's version", async () => {
  const r1 = await runCliEnv({ ...process.env } as Record<string, string>, ["--version"]);
  assert.equal(r1.code, 0);
  assert.equal(r1.stdout.trim(), packageVersion());

  const r2 = await runCliEnv({ ...process.env } as Record<string, string>, ["version"]);
  assert.equal(r2.code, 0);
  assert.equal(r2.stdout.trim(), packageVersion());
});

// ------------------------------------------------------------- update (repo copy)

test("update --check: repo checkout refuses honestly (exit 1, reason names git)", async () => {
  const base = mkdtempSync(join(TMP_BASE, "upd-repo-"));
  try {
    makeStubNpm(join(base, "bin"));
    const env = {
      ...(process.env as Record<string, string>),
      PATH: join(base, "bin") + ":" + (process.env.PATH ?? ""),
      STUB_VERSION: "9.9.9",
      STUB_ROOT: join(base, "no-such-npm-root"),
    };
    const r = await runCliEnv(env, ["update", "--check", "--json"]);
    assert.equal(r.code, 1, "an update exists; this copy just cannot self-apply it");
    const report = JSON.parse(r.stdout);
    assert.equal(report.state, "refused");
    assert.equal(report.current_version, packageVersion());
    assert.equal(report.latest_version, "9.9.9");
    assert.ok(report.reason.includes("git"), "refusal points at the git workflow");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("update: registry unreachable -> exit 70 with an honest message", async () => {
  const base = mkdtempSync(join(TMP_BASE, "upd-fail-"));
  try {
    makeStubNpm(join(base, "bin"));
    const env = {
      ...(process.env as Record<string, string>),
      PATH: join(base, "bin") + ":" + (process.env.PATH ?? ""),
      STUB_FAIL: "1",
      STUB_ROOT: join(base, "no-such-npm-root"),
    };
    const r = await runCliEnv(env, ["update", "--check"]);
    assert.equal(r.code, 70);
    assert.ok(r.stderr.includes("npm view"), "failure names the registry check");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("update --check: up to date -> exit 0", async () => {
  const base = mkdtempSync(join(TMP_BASE, "upd-uptodate-"));
  try {
    makeStubNpm(join(base, "bin"));
    const env = {
      ...(process.env as Record<string, string>),
      PATH: join(base, "bin") + ":" + (process.env.PATH ?? ""),
      STUB_VERSION: packageVersion(),
      STUB_ROOT: join(base, "no-such-npm-root"),
    };
    const r = await runCliEnv(env, ["update", "--check", "--json"]);
    assert.equal(r.code, 0);
    const report = JSON.parse(r.stdout);
    assert.equal(report.state, "up-to-date");
    assert.equal(report.latest_version, packageVersion());
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// ------------------------------------------------------- update (planted npm copy)

test("update --check: npm-global copy reports update-available, touches nothing", async () => {
  const base = mkdtempSync(join(TMP_BASE, "upd-check-"));
  let d: DaemonHandle | null = null;
  try {
    const plantedCli = plantCopy(join(base, "nglobal", "node_modules", "@aron98", "load-lock"), packageVersion());
    makeStubNpm(join(base, "bin"));
    const mark = join(base, "marker");
    d = await startDaemon();
    const oldPid = d.child.pid!;
    const env = {
      ...d.env,
      PATH: join(base, "bin") + ":" + (process.env.PATH ?? ""),
      STUB_VERSION: "9.9.9",
      STUB_ROOT: join(base, "nglobal", "node_modules"),
      STUB_MARK: mark,
    };
    const r = await runCliEnv(env, ["update", "--check", "--json"], plantedCli);
    assert.equal(r.code, 1, "--check signals update-available");
    const report = JSON.parse(r.stdout);
    assert.equal(report.state, "update-available");
    assert.equal(report.location.kind, "npm-global");
    assert.deepEqual(report.command, ["npm", "i", "-g", "@aron98/load-lock@latest"]);
    assert.ok(!existsSync(mark), "dry run installs nothing");
    // daemon untouched: same pid, still answering
    const h = await rawRequest(d.sock, helloFrom());
    assert.ok(h && h.ok, "daemon still answering");
    assert.equal(h.result.pid, oldPid, "daemon was not restarted by a dry run");
  } finally {
    if (d) {
      killDaemonFromJson(d.dir);
      rmSync(d.dir, { recursive: true, force: true });
    }
    rmSync(base, { recursive: true, force: true });
  }
});

test("update: npm-global apply installs via the stub and restarts the service", async () => {
  const base = mkdtempSync(join(TMP_BASE, "upd-apply-"));
  let d: DaemonHandle | null = null;
  try {
    const plantedCli = plantCopy(join(base, "nglobal", "node_modules", "@aron98", "load-lock"), packageVersion());
    makeStubNpm(join(base, "bin"));
    const mark = join(base, "marker");
    d = await startDaemon();
    const oldPid = d.child.pid!;
    const env = {
      ...d.env,
      PATH: join(base, "bin") + ":" + (process.env.PATH ?? ""),
      STUB_VERSION: "9.9.9",
      STUB_ROOT: join(base, "nglobal", "node_modules"),
      STUB_MARK: mark,
    };
    const r = await runCliEnv(env, ["update", "--json"], plantedCli);
    assert.equal(r.code, 0, `update should succeed; stderr: ${r.stderr}`);
    assert.ok(existsSync(mark), "the detected package manager ran (stubbed)");
    assert.match(r.stdout, /"state": "updated"/);
    assert.match(r.stdout, /"restarted": true/);
    assert.match(r.stdout, /stopped/, "stop phase reported");
    assert.match(r.stdout, /running on pid/, "start phase reported");
    // the restarted daemon answers on the same socket with a fresh pid
    let newPid = 0;
    const deadline = Date.now() + 15_000;
    for (;;) {
      const h = await rawRequest(d.sock, helloFrom());
      if (h && h.ok && h.result.pid !== oldPid) {
        newPid = h.result.pid;
        break;
      }
      if (Date.now() > deadline) assert.fail("restarted daemon did not answer");
      await delay(200);
    }
    assert.notEqual(newPid, oldPid);
    assert.ok(newPid > 0);
  } finally {
    if (d) {
      killDaemonFromJson(d.dir);
      rmSync(d.dir, { recursive: true, force: true });
    }
    rmSync(base, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------- service restart

test("service restart: running daemon -> stop + start, new daemon answers", async () => {
  const d = await startDaemon();
  try {
    const oldPid = d.child.pid!;
    const r = await runCliEnv(d.env, ["service", "restart"]);
    assert.equal(r.code, 0, `restart should succeed; stderr: ${r.stderr}`);
    assert.match(r.stdout, /stopped/);
    assert.match(r.stdout, /running on pid/);
    let newPid = 0;
    const deadline = Date.now() + 15_000;
    for (;;) {
      const h = await rawRequest(d.sock, helloFrom());
      if (h && h.ok && h.result.pid !== oldPid) {
        newPid = h.result.pid;
        break;
      }
      if (Date.now() > deadline) assert.fail("restarted daemon did not answer");
      await delay(200);
    }
    assert.notEqual(newPid, oldPid);
  } finally {
    killDaemonFromJson(d.dir);
    rmSync(d.dir, { recursive: true, force: true });
  }
});

test("service restart: nothing running -> stop reports honestly, start spawns fresh", async () => {
  const dir = mkdtempSync(join(TMP_BASE, "restart-empty-"));
  const sock = join(dir, "daemon.sock");
  try {
    const env = {
      ...(process.env as Record<string, string>),
      LOAD_LOCK_STATE_DIR: dir,
      LOAD_LOCK_SOCKET: sock,
    };
    const r = await runCliEnv(env, ["service", "restart"]);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /no running daemon found/);
    assert.match(r.stdout, /running on pid/);
    assert.ok(await probe(sock), "fresh daemon is answering");
  } finally {
    killDaemonFromJson(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("service restart: unidentifiable socket owner -> exit 70 naming the STOP phase", async () => {
  const dir = mkdtempSync(join(TMP_BASE, "restart-hung-"));
  const sock = join(dir, "daemon.sock");
  // A fake "hung daemon": accepts connections, never answers, and writes
  // no daemon.json — so stop cannot identify a pid to signal.
  const child = spawn(
    process.execPath,
    [
      "-e",
      `const net = require("node:net"); const s = net.createServer(() => {}); s.listen(${JSON.stringify(sock)}, () => { process.stdout.write("hung\\n"); });`,
    ],
    { stdio: ["ignore", "ignore", "ignore"] },
  );
  try {
    const deadline = Date.now() + 10_000;
    while (!(await probe(sock))) {
      if (Date.now() > deadline) throw new Error("fake hung daemon did not come up");
      await delay(100);
    }
    const env = {
      ...(process.env as Record<string, string>),
      LOAD_LOCK_STATE_DIR: dir,
      LOAD_LOCK_SOCKET: sock,
    };
    const r = await runCliEnv(env, ["service", "restart"], cliMainPath, 30_000);
    assert.equal(r.code, 70);
    assert.match(r.stderr, /STOP phase/, "failure names the failed phase");
  } finally {
    child.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------- adapter-init drift (MCP)

test("mcp init: older PATH CLI -> drift notice in stderr and initialize instructions", async () => {
  const base = mkdtempSync(join(TMP_BASE, "drift-mcp-"));
  let d: DaemonHandle | null = null;
  try {
    const binDir = plantBinCopy(join(base, "copy"), "0.9.0");
    // runStdioMcp connects a real daemon at startup; give it one in a
    // temp state dir (never the user's), with the planted old copy on PATH.
    d = await startDaemon();
    const env = {
      ...d.env,
      PATH: binDir + ":" + (d.env.PATH ?? ""),
    };
    const child = spawn(process.execPath, [mcpMainPath], { env, stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    child.stderr!.on("data", (b) => (stderr += b));
    const resp = await new Promise<any>((resolve, reject) => {
      let buf = "";
      const timer = setTimeout(() => reject(new Error("mcp server did not answer initialize")), 15_000);
      child.stdout!.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        const idx = buf.indexOf("\n");
        if (idx === -1) return;
        clearTimeout(timer);
        try {
          resolve(JSON.parse(buf.slice(0, idx)));
        } catch (e) {
          reject(e);
        }
      });
      child.once("exit", () => reject(new Error("mcp server exited before answering")));
      child.stdin!.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
        }) + "\n",
      );
    });
    child.kill("SIGKILL");
    assert.ok(resp.result, `initialize succeeded: ${JSON.stringify(resp)}`);
    assert.equal(resp.error, undefined, `initialize had no error: ${JSON.stringify(resp)}`);
    const instructions = resp.result?.instructions ?? "";
    assert.ok(instructions.includes("load-lock update"), "instructions carry the drift notice with the exact command");
    await delay(300);
    assert.ok(stderr.includes("load-lock update"), "stderr carries the drift notice at init");
  } finally {
    if (d) {
      killDaemonFromJson(d.dir);
      rmSync(d.dir, { recursive: true, force: true });
    }
    rmSync(base, { recursive: true, force: true });
  }
});

// ---------------------------------------------------- adapter-init drift (plugin)

test("plugin init: older PATH CLI -> drift notice on stderr and in injected context", async () => {
  const base = mkdtempSync(join(TMP_BASE, "drift-plugin-"));
  try {
    const binDir = plantBinCopy(join(base, "copy"), "0.9.0");
    // Child harness: load the real plugin, run setup with a fake ctx that
    // records the context hook, then invoke it and print the injected text.
    const script =
      "const hooks = {};\n" +
      "const ctx = {\n" +
      "  tool: { transform(cb) { cb({ namespace() {}, add() {} }); } },\n" +
      "  skill: { transform(cb) { cb({ add() {} }); } },\n" +
      "  session: { hook(n, cb) { (hooks[n] ??= []).push(cb); }, synthetic() {} },\n" +
      "};\n" +
      `const mod = await import(${JSON.stringify(PLUGIN_DIST)});\n` +
      "const cleanup = await mod.default.setup(ctx);\n" +
      "const cbs = hooks['context'] ?? [];\n" +
      "if (!cbs.length) { process.stderr.write('NO_CONTEXT_HOOK\\n'); process.exit(1); }\n" +
      "const event = { system: [] };\n" +
      "await cbs[0](event);\n" +
      "process.stdout.write(JSON.stringify(event.system));\n" +
      "if (typeof cleanup === 'function') cleanup();\n" +
      "process.exit(0);\n";
    const scriptPath = join(base, "child.mjs");
    writeFileSync(scriptPath, script);
    const env = {
      ...(process.env as Record<string, string>),
      PATH: binDir + ":" + (process.env.PATH ?? ""),
      LOAD_LOCK_STATE_DIR: join(base, "state"),
      LOAD_LOCK_SOCKET: join(base, "state", "daemon.sock"),
      LOAD_LOCK_NO_SPAWN: "1",
    };
    const r = await runScript(scriptPath, env);
    assert.equal(r.code, 0, `plugin child failed; stderr: ${r.stderr}`);
    const system = JSON.parse(r.stdout);
    assert.ok(Array.isArray(system) && system.length > 0, "context hook pushed a system message");
    const text = system.map((m: any) => m.text).join("\n");
    assert.ok(text.includes("load-lock"), "policy brief is present");
    assert.ok(text.includes("load-lock update"), "injected context carries the drift notice");
    assert.ok(r.stderr.includes("load-lock update"), "stderr carries the drift notice at init");
    assert.ok(r.stderr.includes("adapter copy"), "notice identifies which copy is newer");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

/** Run an .mjs child script with an explicit env. */
function runScript(scriptPath: string, env: Record<string, string>, timeoutMs = 60_000): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], { env });
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (b) => (stdout += b));
    child.stderr!.on("data", (b) => (stderr += b));
    child.stdin!.end();
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`child script timed out: ${scriptPath}`));
    }, timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.once("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}
