/**
 * Runtime-copy bookkeeping (issue #52):
 *  - daemon.json records the daemon's package root + version
 *  - the client envelope carries clientRoot; the daemon keeps a known-copies
 *    list (runtimes.json) deduped by real path, ignoring bogus hints and
 *    dropping copies whose path is gone
 *  - `doctor` lists the copies
 *
 * Real daemons over real sockets in temp state dirs (never the user's).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, createServer } from "node:net";
import { LLClient } from "../shared/client.js";
import { packageVersion, packageRoot } from "../shared/version.js";
import { loadRuntimes } from "../shared/runtimes.js";
import { startDaemon, cliMainPath } from "./testutil.js";

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
