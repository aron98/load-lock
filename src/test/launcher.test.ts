/**
 * Tests for the dependency-free plugin launcher (issue #60):
 * plugins/claude-code/scripts/load-lock.mjs over planted fake runtime
 * copies (PATH, state dir) and a fake npx-cli.js. Light: no daemon, no
 * network; every case runs in its own temp HOME/state dir.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const LAUNCHER = join(REPO_ROOT, "plugins", "claude-code", "scripts", "load-lock.mjs");
const PKG_VERSION: string = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")).version;

const L: any = await import(pathToFileURL(LAUNCHER).href);

const TMP_BASE = process.env.LL_TEST_TMP ?? tmpdir();
mkdirSync(TMP_BASE, { recursive: true });

/** A fake entry that reports what it was run with, then exits per FAKE_EXIT / FAKE_HANG. */
const FAKE_ENTRY = (tag: string) => `
let s = "";
process.stdin.on("data", (d) => (s += d));
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({ entry: ${JSON.stringify(tag)}, argv: process.argv.slice(2), stdin: s }) + "\\n");
  if (process.env.FAKE_HANG === "1") setInterval(() => {}, 1000);
  else process.exitCode = Number(process.env.FAKE_EXIT ?? 0);
});
`;

/** Plant a fake @aron98/load-lock package root with both bins. */
function plantPkg(root: string, version: string, name = "@aron98/load-lock"): string {
  mkdirSync(join(root, "dist", "cli"), { recursive: true });
  mkdirSync(join(root, "dist", "mcp"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name, version }));
  writeFileSync(join(root, "dist", "cli", "main.js"), FAKE_ENTRY(`cli@${version}`));
  writeFileSync(join(root, "dist", "mcp", "main.js"), FAKE_ENTRY(`mcp@${version}`));
  return root;
}

interface Sandbox {
  dir: string;
  bin: string;
  state: string;
  env: Record<string, string>;
}

function sandbox(): Sandbox {
  const dir = mkdtempSync(join(TMP_BASE, "ll-launch-"));
  const bin = join(dir, "bin");
  const state = join(dir, "state");
  mkdirSync(bin, { recursive: true });
  mkdirSync(state, { recursive: true });
  const env: Record<string, string> = {
    HOME: dir,
    PATH: bin, // only planted copies; the launcher runs node via process.execPath
    LOAD_LOCK_STATE_DIR: state,
    LOAD_LOCK_LAUNCHER_DEBUG: "1",
    // No npx unless a test plants one: a missing override never falls back.
    LOAD_LOCK_LAUNCHER_NPX_CLI: join(dir, "no-npx-cli.js"),
  };
  return { dir, bin, state, env };
}

/** Put a POSIX-npm-style `load-lock` link for `root` on the sandbox PATH. */
function linkOnPath(sb: Sandbox, root: string) {
  symlinkSync(join(root, "dist", "cli", "main.js"), join(sb.bin, "load-lock"));
}

function run(sb: Sandbox, args: string[], extraEnv: Record<string, string> = {}, input = '{"session_id":"s1"}') {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [LAUNCHER, ...args], {
    env: { ...sb.env, ...extraEnv },
    input,
    encoding: "utf8",
    timeout: 20_000,
  });
  return { ...r, ms: Date.now() - t0 };
}

const posix = process.platform !== "win32";

test("launcher pin equals package.json version", () => {
  const text = readFileSync(LAUNCHER, "utf8");
  assert.match(text, new RegExp(`"@aron98/load-lock@${PKG_VERSION.replace(/\./g, "\\.")}"`));
});

test("PATH branch: a new-enough load-lock on PATH runs its compiled entry with stdin and args", { skip: !posix }, () => {
  const sb = sandbox();
  try {
    linkOnPath(sb, plantPkg(join(sb.dir, "global", "lib", "node_modules", "@aron98", "load-lock"), "99.0.0"));
    const r = run(sb, ["hook", "claude-code", "stop"]);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.entry, "cli@99.0.0");
    assert.deepEqual(out.argv, ["hook", "claude-code", "stop"]);
    assert.equal(out.stdin, '{"session_id":"s1"}');
    assert.match(r.stderr, /launcher: path 99\.0\.0/);

    const m = run(sb, ["--bin", "load-lock-mcp"], {}, "");
    assert.equal(m.status, 0, m.stderr);
    assert.equal(JSON.parse(m.stdout).entry, "mcp@99.0.0");
  } finally {
    rmSync(sb.dir, { recursive: true, force: true });
  }
});

test("state branch: a too-old PATH copy is skipped for the newest known copy >= pin", { skip: !posix }, () => {
  const sb = sandbox();
  try {
    linkOnPath(sb, plantPkg(join(sb.dir, "old"), "0.1.0"));
    const a = plantPkg(join(sb.dir, "copy-a"), "98.0.0");
    const b = plantPkg(join(sb.dir, "copy-b"), "98.1.0");
    const tooOld = plantPkg(join(sb.dir, "copy-old"), "0.0.1");
    const notOurs = plantPkg(join(sb.dir, "copy-other"), "999.0.0", "something-else");
    writeFileSync(
      join(sb.state, "runtimes.json"),
      JSON.stringify({
        copies: [a, tooOld, notOurs, join(sb.dir, "gone")].map((path) => ({ path, version: "x", lastSeen: 1 })),
      }),
    );
    writeFileSync(join(sb.state, "daemon.json"), JSON.stringify({ pid: 1, startedAt: 1, socket: "s", packageRoot: b }));
    const r = run(sb, ["hook", "claude-code", "stop"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).entry, "cli@98.1.0");
    assert.match(r.stderr, /launcher: state 98\.1\.0/);
  } finally {
    rmSync(sb.dir, { recursive: true, force: true });
  }
});

test("npx branch: pinned --package, --offline only in hook mode, bin after --", () => {
  const sb = sandbox();
  try {
    const npxCli = join(sb.dir, "npx-cli.js");
    writeFileSync(npxCli, `process.stdout.write(JSON.stringify(process.argv.slice(2)) + "\\n");`);
    const env = { LOAD_LOCK_LAUNCHER_NPX_CLI: npxCli };
    const h = run(sb, ["hook", "claude-code", "session-start"], env);
    assert.equal(h.status, 0, h.stderr);
    assert.deepEqual(JSON.parse(h.stdout), [
      "--yes", "--offline", `--package=@aron98/load-lock@${PKG_VERSION}`, "--", "load-lock", "hook", "claude-code", "session-start",
    ]);
    const m = run(sb, ["--bin", "load-lock-mcp"], env, "");
    assert.equal(m.status, 0, m.stderr);
    assert.deepEqual(JSON.parse(m.stdout), ["--yes", `--package=@aron98/load-lock@${PKG_VERSION}`, "--", "load-lock-mcp"]);
  } finally {
    rmSync(sb.dir, { recursive: true, force: true });
  }
});

test("no runtime at all: hooks exit 0, SessionStart prints one install hint, the MCP server fails loudly", () => {
  const sb = sandbox();
  try {
    const s = run(sb, ["hook", "claude-code", "session-start"]);
    assert.equal(s.status, 0);
    assert.equal(s.stdout.trim().split("\n").length, 1);
    assert.match(s.stdout, /npm i -g @aron98\/load-lock/);
    for (const ev of ["stop", "await-offer"]) {
      const r = run(sb, ["hook", "claude-code", ev]);
      assert.equal(r.status, 0);
      assert.equal(r.stdout, "");
    }
    const m = run(sb, ["--bin", "load-lock-mcp"], {}, "");
    assert.equal(m.status, 1);
    assert.match(m.stderr, /no runtime found/);
    assert.equal(run(sb, ["--bin", "nope"]).status, 64);
  } finally {
    rmSync(sb.dir, { recursive: true, force: true });
  }
});

test("exit codes: hooks pass 0/2 through and swallow the rest; the MCP server passes everything through", { skip: !posix }, () => {
  const sb = sandbox();
  try {
    linkOnPath(sb, plantPkg(join(sb.dir, "pkg"), "99.0.0"));
    assert.equal(run(sb, ["hook", "claude-code", "await-offer"], { FAKE_EXIT: "2" }).status, 2);
    assert.equal(run(sb, ["hook", "claude-code", "stop"], { FAKE_EXIT: "1" }).status, 0);
    // SessionStart that already printed output gets no extra hint.
    const s = run(sb, ["hook", "claude-code", "session-start"], { FAKE_EXIT: "1" });
    assert.equal(s.status, 0);
    assert.doesNotMatch(s.stdout, /npm i -g/);
    assert.equal(run(sb, ["--bin", "load-lock-mcp"], { FAKE_EXIT: "3" }, "").status, 3);
  } finally {
    rmSync(sb.dir, { recursive: true, force: true });
  }
});

test("timeout: a stalled hook is killed and exits 0 fast; await-offer is not bounded by it", { skip: !posix }, () => {
  const sb = sandbox();
  try {
    const npxCli = join(sb.dir, "npx-cli.js");
    // A stalled npx whose own child holds stdout: the process group dies too.
    writeFileSync(
      npxCli,
      `const { spawn } = require("node:child_process");
       spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit" });
       setInterval(() => {}, 1000);`,
    );
    writeFileSync(join(sb.dir, "package.json"), JSON.stringify({ type: "commonjs" }));
    const env = { LOAD_LOCK_LAUNCHER_NPX_CLI: npxCli, LOAD_LOCK_LAUNCHER_TIMEOUT_MS: "300" };
    const r = run(sb, ["hook", "claude-code", "session-start"], env);
    assert.equal(r.status, 0);
    assert.ok(r.ms < 5000, `took ${r.ms}ms`);
    assert.match(r.stdout, /npm i -g/); // nothing came out, so the hint does

    linkOnPath(sb, plantPkg(join(sb.dir, "pkg"), "99.0.0"));
    const w = spawnSync(process.execPath, [LAUNCHER, "hook", "claude-code", "await-offer"], {
      env: { ...sb.env, FAKE_HANG: "1", LOAD_LOCK_LAUNCHER_TIMEOUT_MS: "200" },
      input: "{}",
      encoding: "utf8",
      timeout: 1500,
    });
    assert.equal((w.error as NodeJS.ErrnoException | undefined)?.code, "ETIMEDOUT", "await-offer must outlive the hook timeout");
  } finally {
    rmSync(sb.dir, { recursive: true, force: true });
  }
});

test("resolution helpers: Windows npm shim layout, npx.cmd fallback, state dir precedence", () => {
  const sb = sandbox();
  try {
    // Windows npm global layout: <prefix>\load-lock.cmd + <prefix>\node_modules\@aron98\load-lock
    const prefix = join(sb.dir, "npm-prefix");
    plantPkg(join(prefix, "node_modules", "@aron98", "load-lock"), "99.2.0");
    writeFileSync(join(prefix, "load-lock.cmd"), "@echo off\r\n");
    const found = L.pathCopy({ PATH: prefix }, "win32", "dist/cli/main.js");
    assert.equal(found?.version, "99.2.0");
    assert.equal(found?.source, "path");

    const noNode = join(sb.dir, "nodeless", "node.exe");
    assert.deepEqual(L.npxCommand({}, "win32", noNode), { command: "npx.cmd", args: [], shell: true });
    assert.deepEqual(L.npxCommand({}, "linux", noNode), { command: "npx", args: [], shell: false });

    assert.equal(L.stateDir({ LOAD_LOCK_STATE_DIR: "/x" }, "linux"), "/x");
    assert.equal(L.stateDir({ XDG_STATE_HOME: "/xdg", HOME: "/h" }, "linux"), join("/xdg", "load-lock"));
    assert.equal(L.stateDir({ HOME: "/h" }, "linux"), join("/h", ".local", "state", "load-lock"));
    assert.equal(L.stateDir({ LOCALAPPDATA: "C:/AppData" }, "win32"), join("C:/AppData", "load-lock"));

    assert.equal(L.compareVersions("1.10.0", "1.9.9"), 1);
    assert.equal(L.compareVersions("1.5.0", "1.5"), 0);
    assert.equal(L.compareVersions("1.4.9", "1.5.0"), -1);
  } finally {
    rmSync(sb.dir, { recursive: true, force: true });
  }
});
