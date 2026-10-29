/**
 * Runtime-copy bookkeeping (issue #52):
 *  - daemon.json records the daemon's package root + version
 *  - the client envelope carries clientRoot; the daemon keeps a known-copies
 *    list (runtimes.json) deduped by real path, ignoring bogus hints and
 *    dropping copies whose path is gone
 *  - `doctor` lists the copies
 *  - self-restart onto the newer client's copy (issue #53), with bogus or
 *    mismatched hints falling back to the same-argv respawn, no loops
 *
 * Real daemons over real sockets in temp state dirs (never the user's).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, realpathSync, symlinkSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, createServer } from "node:net";
import { LLClient } from "../shared/client.js";
import { packageVersion, packageRoot } from "../shared/version.js";
import { loadRuntimes } from "../shared/runtimes.js";
import { restartEntry } from "../core/daemon.js";
import { startDaemon, cliMainPath, probe, delay, until } from "./testutil.js";

const TMP_BASE = process.env.LL_TEST_TMP ?? join(tmpdir(), "opencode");
mkdirSync(TMP_BASE, { recursive: true });

/** Send one raw envelope line; resolve the first response (or null). */
function rawRequest(sockPath: string, envelope: Record<string, unknown>, timeoutMs = 3000): Promise<any | null> {
  return new Promise((resolve) => {
    let buf = "";
    const s = connect(sockPath, () => s.write(JSON.stringify(envelope) + "\n"));
    const done = (v: any) => {
      s.destroy();
      resolve(v);
    };
    s.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const idx = buf.indexOf("\n");
      if (idx !== -1) done(JSON.parse(buf.slice(0, idx)));
    });
    s.on("error", () => done(null));
    setTimeout(() => done(null), timeoutMs).unref?.();
  });
}

/** Plant a fake package root with the given package.json name/version. */
function plantCopy(base: string, name: string, pkgName: string, version: string): string {
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: pkgName, version }));
  return dir;
}

test("daemon.json records the daemon's package root and version", async () => {
  const d = await startDaemon();
  try {
    const info = JSON.parse(readFileSync(join(d.dir, "daemon.json"), "utf8"));
    assert.equal(info.pid, d.child.pid);
    assert.equal(info.version, packageVersion());
    assert.equal(info.packageRoot, realpathSync(packageRoot()));
    // The daemon's own copy is the first known runtime.
    assert.ok(loadRuntimes(d.dir).some((c) => c.path === info.packageRoot && c.version === packageVersion()));
  } finally {
    await d.stop();
  }
});

test("client envelope carries clientRoot", async () => {
  const capDir = mkdtempSync(join(TMP_BASE, "ll-capture-"));
  const capSock = join(capDir, "cap.sock");
  let captured = "";
  const server = createServer((s) => {
    s.on("data", (chunk) => {
      captured += chunk.toString("utf8");
      const idx = captured.indexOf("\n");
      if (idx !== -1) s.write(JSON.stringify({ id: JSON.parse(captured.slice(0, idx)).id, ok: true, result: {} }) + "\n");
    });
  });
  await new Promise<void>((r) => server.listen(capSock, r));
  try {
    const c = new LLClient({ socket: capSock, stateDir: capDir, spawnDaemon: false });
    await c.connect();
    await c.request("hello", {});
    c.close();
    const envelope = JSON.parse(captured.trim());
    assert.equal(envelope.clientRoot, packageRoot());
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(capDir, { recursive: true, force: true });
  }
});

test("known copies: recorded from handshakes, deduped by real path, bogus hints ignored, gone paths dropped", async () => {
  const d = await startDaemon();
  const base = mkdtempSync(join(TMP_BASE, "ll-copies-"));
  try {
    const a = plantCopy(base, "a", "@aron98/load-lock", "0.0.1");
    const b = plantCopy(base, "b", "@aron98/load-lock", "0.0.2");
    const foreign = plantCopy(base, "foreign", "some-other-pkg", "9.9.9");
    symlinkSync(a, join(base, "a-link"));
    // No clientVersion: these hints never trigger a self-restart.
    for (const root of [a, join(base, "a-link"), foreign, join(base, "missing"), b]) {
      const r = await rawRequest(d.sock, { id: 1, method: "hello", params: {}, clientRoot: root });
      assert.ok(r?.ok, `hello with clientRoot ${root}`);
    }
    let copies = loadRuntimes(d.dir);
    const paths = copies.map((c) => c.path);
    assert.equal(paths.filter((p) => p === realpathSync(a)).length, 1, "symlinked hint deduped by real path");
    assert.ok(copies.some((c) => c.path === realpathSync(b) && c.version === "0.0.2"), "version read from disk");
    assert.ok(!paths.some((p) => p.includes("foreign") || p.includes("missing")), `bogus hints ignored: ${paths}`);

    // Copy a disappears (e.g. npx cache cleaned); the next new sighting
    // prunes it, and a reader never reports it either.
    rmSync(a, { recursive: true, force: true });
    const c = plantCopy(base, "c", "@aron98/load-lock", "0.0.3");
    await rawRequest(d.sock, { id: 1, method: "hello", params: {}, clientRoot: c });
    const raw = JSON.parse(readFileSync(join(d.dir, "runtimes.json"), "utf8"));
    assert.ok(!raw.copies.some((x: any) => x.path === join(realpathSync(base), "a")), "gone copy pruned on disk");
    copies = loadRuntimes(d.dir);
    assert.ok(copies.some((x) => x.version === "0.0.3"));
  } finally {
    await d.stop();
    rmSync(base, { recursive: true, force: true });
  }
});

test("doctor lists the daemon's runtime and known copies", async () => {
  const d = await startDaemon();
  const base = mkdtempSync(join(TMP_BASE, "ll-copies-"));
  try {
    const a = plantCopy(base, "a", "@aron98/load-lock", "0.0.1");
    await rawRequest(d.sock, { id: 1, method: "hello", params: {}, clientRoot: a });
    const r = await new Promise<{ code: number | null; stdout: string }>((resolve) => {
      const child = spawn(process.execPath, [cliMainPath, "doctor", "--json"], { env: d.env });
      let stdout = "";
      child.stdout!.on("data", (b) => (stdout += b));
      child.stdin!.end();
      child.once("exit", (code) => resolve({ code, stdout }));
    });
    assert.equal(r.code, 0);
    const report = JSON.parse(r.stdout);
    assert.equal(report.daemonRuntime.path, realpathSync(packageRoot()));
    assert.equal(report.daemonRuntime.version, packageVersion());
    const listed = (report.knownRuntimes as Array<{ path: string; version: string }>).map((c) => `${c.version}@${c.path}`);
    assert.ok(listed.includes(`0.0.1@${realpathSync(a)}`), `planted copy listed: ${listed}`);
    assert.ok(listed.includes(`${packageVersion()}@${realpathSync(packageRoot())}`), `own copy listed: ${listed}`);
  } finally {
    await d.stop();
    rmSync(base, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------- issue #53

/**
 * Plant a runnable load-lock copy: the built dist/ (minus tests), the real
 * package.json with a different version, node_modules symlinked to ours.
 */
function plantRuntime(base: string, name: string, version: string): string {
  const root = realpathSync(packageRoot());
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  cpSync(join(root, "dist"), join(dir, "dist"), { recursive: true, filter: (src) => !src.startsWith(join(root, "dist", "test")) });
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ ...pkg, version }));
  symlinkSync(join(root, "node_modules"), join(dir, "node_modules"));
  return realpathSync(dir);
}

/** Start a daemon from a planted copy; only raw (version-less) envelopes talk to it. */
async function startCopyDaemon(copy: string, dir: string): Promise<{ sock: string; pid: number }> {
  const sock = join(dir, "daemon.sock");
  const child = spawn(process.execPath, [join(copy, "dist", "core", "daemon-main.js"), "--state-dir", dir, "--socket", sock], {
    stdio: "ignore",
    detached: true,
  });
  child.unref();
  await until("planted daemon up", () => probe(sock), 10_000, 100);
  return { sock, pid: child.pid! };
}

function killFromJson(dir: string): void {
  try {
    process.kill(JSON.parse(readFileSync(join(dir, "daemon.json"), "utf8")).pid, "SIGKILL");
  } catch {
    /* gone */
  }
}

async function helloRaw(sock: string, extra: Record<string, unknown> = {}): Promise<any> {
  const r = await rawRequest(sock, { id: 1, method: "hello", params: {}, ...extra }, 2000);
  return r?.ok ? r.result : null;
}

async function waitNewPid(sock: string, oldPid: number): Promise<any> {
  let hello: any = null;
  await until("daemon respawned", async () => {
    if (!(await probe(sock))) return false;
    hello = await helloRaw(sock);
    return hello !== null && hello.pid !== oldPid;
  });
  return hello;
}

test("restartEntry: only a matching load-lock copy with a daemon entry qualifies", () => {
  const base = mkdtempSync(join(TMP_BASE, "ll-entry-"));
  try {
    const good = plantCopy(base, "good", "@aron98/load-lock", "0.2.0");
    mkdirSync(join(good, "dist", "core"), { recursive: true });
    writeFileSync(join(good, "dist", "core", "daemon-main.js"), "");
    const noEntry = plantCopy(base, "noentry", "@aron98/load-lock", "0.2.0");
    const foreign = plantCopy(base, "foreign", "not-load-lock", "0.2.0");
    mkdirSync(join(foreign, "dist", "core"), { recursive: true });
    writeFileSync(join(foreign, "dist", "core", "daemon-main.js"), "");
    assert.equal(restartEntry(good, "0.2.0"), join(realpathSync(good), "dist", "core", "daemon-main.js"));
    assert.equal(restartEntry(good, "0.3.0"), null, "claimed version must match the copy on disk");
    assert.equal(restartEntry(noEntry, "0.2.0"), null, "copy without a daemon entry");
    assert.equal(restartEntry(foreign, "0.2.0"), null, "foreign package");
    assert.equal(restartEntry(join(base, "missing"), "0.2.0"), null, "nonexistent path");
    assert.equal(restartEntry(undefined, "0.2.0"), null, "no hint");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("self-restart moves the daemon onto the newer client's copy; state and journal survive", async () => {
  const base = mkdtempSync(join(TMP_BASE, "ll-2c-"));
  const dir = join(base, "s");
  mkdirSync(dir);
  const sleeper = spawn("sleep", ["60"], { stdio: "ignore" });
  try {
    const oldCopy = plantRuntime(base, "old", "0.1.0");
    const newCopy = plantRuntime(base, "new", "0.2.0");
    const { sock, pid } = await startCopyDaemon(oldCopy, dir);
    assert.equal((await helloRaw(sock)).daemonVersion, "0.1.0");

    // A tracked permit held on the old daemon.
    const g = await rawRequest(sock, { id: 2, method: "acquire", params: { agentId: "A", opKey: "op1", reason: "two copies" } });
    const permitToken = g.result.entry.permitToken as string;
    await rawRequest(sock, { id: 3, method: "attach_pid", params: { permitToken, pid: sleeper.pid } });

    // A newer client from a different copy shows up.
    assert.ok(await helloRaw(sock, { clientVersion: "0.2.0", clientRoot: newCopy }));
    const h = await waitNewPid(sock, pid);
    assert.equal(h.daemonVersion, "0.2.0", "daemon now runs the newer copy");
    const info = JSON.parse(readFileSync(join(dir, "daemon.json"), "utf8"));
    assert.equal(info.packageRoot, newCopy);
    assert.equal(info.version, "0.2.0");

    const st = await rawRequest(sock, { id: 4, method: "status", params: {} });
    assert.equal(st.result.pools[0].holders.length, 1, "held permit survives the move");
    assert.equal(st.result.pools[0].holders[0].pid, sleeper.pid);
    const rel = await rawRequest(sock, { id: 5, method: "release", params: { permitToken } });
    assert.equal(rel.result.releasedNow, true, "same permit token still releases");

    // Stable afterwards: the same newer client does not restart it again.
    await helloRaw(sock, { clientVersion: "0.2.0", clientRoot: newCopy });
    await delay(600);
    assert.equal((await helloRaw(sock)).pid, h.pid);
  } finally {
    sleeper.kill("SIGKILL");
    killFromJson(dir);
    rmSync(base, { recursive: true, force: true });
  }
});

test("bogus or mismatched copy hint: no respawn onto it, same-argv fallback, no restart loop", async () => {
  const base = mkdtempSync(join(TMP_BASE, "ll-2c-"));
  const dir = join(base, "s");
  mkdirSync(dir);
  try {
    const oldCopy = plantRuntime(base, "old", "0.1.0");
    // Claims 0.2.0 but the copy on disk is 0.3.0.
    const mismatched = plantRuntime(base, "mismatch", "0.3.0");
    const { sock, pid } = await startCopyDaemon(oldCopy, dir);

    await helloRaw(sock, { clientVersion: "0.2.0", clientRoot: mismatched });
    const h = await waitNewPid(sock, pid);
    assert.equal(h.daemonVersion, "0.1.0", "respawned on its own copy, not the mismatched hint");
    assert.equal(JSON.parse(readFileSync(join(dir, "daemon.json"), "utf8")).packageRoot, oldCopy);

    // Further bogus hints for the same or an older version: no loop.
    await helloRaw(sock, { clientVersion: "0.2.0", clientRoot: mismatched });
    await helloRaw(sock, { clientVersion: "0.2.0", clientRoot: join(base, "nowhere") });
    await helloRaw(sock, { clientVersion: "0.1.5", clientRoot: "/" });
    await delay(800);
    assert.equal((await helloRaw(sock)).pid, h.pid, "no restart loop");
  } finally {
    killFromJson(dir);
    rmSync(base, { recursive: true, force: true });
  }
});
