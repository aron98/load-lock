/**
 * Integration tests for the update story (issue #34):
 *  - version handshake: hello/status carry daemonVersion; clients stamp
 *    their envelope with clientVersion
 *  - daemon self-restart: a NEWER client orders the daemon to persist
 *    state, drain, and respawn with the same argv (state survives)
 *  - same/older clients never restart it; no restart loops per version
 *  - offered entries restart as queued and are re-offered with fresh tokens
 *  - `service stop` waits bounded, escalates to SIGKILL, verifies the
 *    socket is free, and reports honestly
 *  - `service start` refusals name the conflicting pid
 *  - `doctor` reports installed copies and warns on drift
 *
 * Modeled after daemon.test.ts: real daemons over real sockets in temp
 * state dirs (LL_TEST_TMP / $TMPDIR/opencode — never the user's real dir).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, createServer } from "node:net";
import { LLClient } from "../shared/client.js";
import { packageVersion } from "../shared/version.js";
import { startDaemon, probe, delay, until, cliMainPath, type DaemonHandle } from "./testutil.js";

const TMP_BASE = process.env.LL_TEST_TMP ?? join(tmpdir(), "opencode");
mkdirSync(TMP_BASE, { recursive: true });

const ACQ = (agentId: string, opKey: string, extra: Record<string, unknown> = {}) => ({
  agentId,
  opKey,
  reason: "update-story test",
  ...extra,
});

/** Send a raw (handcrafted) envelope line; resolve the first response. */
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

/** hello envelope with an explicit client version (the handshake trigger). */
const helloFrom = (clientVersion?: string) =>
  ({ id: 1, method: "hello", params: {}, ...(clientVersion ? { clientVersion } : {}) }) as Record<string, unknown>;

/** Run the CLI with an explicit env (for fake-daemon fixtures). */
function runCliEnv(env: Record<string, string>, args: string[], timeoutMs = 60_000): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliMainPath, ...args], { env });
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

/** Kill whatever daemon currently owns the state dir (respawned daemons are not our child). */
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

/** Wait for the daemon on dir/sock to have a pid different from `oldPid`. */
async function waitRespawned(d: DaemonHandle, oldPid: number, timeoutMs = 15_000): Promise<number> {
  let pid = 0;
  await until("daemon respawned with a new pid", async () => {
    if (!(await probe(d.sock))) return false;
    const r = await rawRequest(d.sock, helloFrom(), 2000);
    if (r && r.ok && r.result && r.result.pid !== oldPid) {
      pid = r.result.pid as number;
      return true;
    }
    return false;
  }, timeoutMs);
  return pid;
}

// ------------------------------------------------------------------ tests

test("handshake: hello/status carry daemonVersion; client envelope carries clientVersion", async () => {
  const d = await startDaemon();
  try {
    const c = d.client();
    await c.connect();
    const h = (await c.request("hello", {})) as any;
    assert.equal(h.daemonVersion, packageVersion(), "hello reports the daemon package version");
    const st = (await c.request("status", {})) as any;
    assert.equal(st.daemon.daemonVersion, packageVersion(), "status reports the daemon package version");
    c.close();

    // A client with no version (pre-handshake) gets a normal response — the
    // field is additive both ways.
    const r = await rawRequest(d.sock, helloFrom());
    assert.ok(r.ok);
    assert.equal(r.result.daemonVersion, packageVersion());

    // The shared client stamps its envelope: a fake server captures the line.
    const capDir = mkdtempSync(join(TMP_BASE, "ll-capture-"));
    const capSock = join(capDir, "cap.sock");
    let captured = "";
    const server = createServer((s) => {
      s.on("data", (chunk) => {
        captured += chunk.toString("utf8");
        const idx = captured.indexOf("\n");
        if (idx !== -1) {
          try {
            const msg = JSON.parse(captured.slice(0, idx));
            s.write(JSON.stringify({ id: msg.id, ok: true, result: { echo: true } }) + "\n");
          } catch {
            /* ignore */
          }
        }
      });
    });
    await new Promise<void>((r) => server.listen(capSock, r));
    const cc = new LLClient({ socket: capSock, stateDir: capDir, spawnDaemon: false });
    await cc.connect();
    await cc.request("hello", {});
    cc.close();
    await new Promise<void>((r) => server.close(() => r()));
    const envelope = JSON.parse(captured.trim());
    assert.equal(envelope.clientVersion, packageVersion(), "client envelope carries clientVersion");
    rmSync(capDir, { recursive: true, force: true });

    // `service status` surfaces the version too.
    const svc = await runCliEnv(d.env, ["service", "status"]);
    assert.equal(svc.code, 0);
    assert.ok(svc.stdout.includes(`daemon v${packageVersion()}`), `service status shows daemon version: ${svc.stdout}`);
  } finally {
    await d.stop();
  }
});

test("self-restart: newer client respawns the daemon; held permits and queued requests survive", async () => {
  const d = await startDaemon();
  try {
    const pid1 = d.child.pid!;
    const c = d.client();
    await c.connect();
    // A: held, tracked on a live sleeper process.
    const g = (await c.request("acquire", ACQ("A", "op1"))) as any;
    const permitToken = g.entry.permitToken as string;
    const sleeper = spawn("sleep", ["60"], { stdio: "ignore" });
    await c.request("attach_pid", { permitToken, pid: sleeper.pid });
    // B: queued behind A (capacity 1).
    const q = (await c.request("acquire", ACQ("B", "op2"))) as any;
    assert.equal(q.state, "queued");
    const bRequestId = q.entry.requestId as string;
    c.close();

    // A NEWER client shows up -> the daemon answers first, then restarts.
    const r = await rawRequest(d.sock, helloFrom("999.0.0"));
    assert.ok(r.ok, "hello response still delivered before the restart");
    const pid2 = await waitRespawned(d, pid1);
    assert.notEqual(pid2, pid1);

    // Held permit survived with the same token and tracking.
    const c2 = d.client();
    await c2.connect();
    const st = (await c2.request("status", {})) as any;
    assert.equal(st.daemon.daemonVersion, packageVersion());
    assert.equal(st.pools[0].holders.length, 1, "held permit survives the self-restart");
    assert.equal(st.pools[0].holders[0].phase, "running_tracked");
    assert.equal(st.pools[0].holders[0].pid, sleeper.pid);
    // Queued request survived, same id (idempotent re-acquire keeps working).
    assert.equal(st.pools[0].queue.length, 1, "queued request survives the self-restart");
    assert.equal(st.pools[0].queue[0].requestId, bRequestId);

    // Same permit token still releases.
    const rel = (await c2.request("release", { permitToken })) as any;
    assert.equal(rel.releasedNow, true);

    // Idempotent re-acquire of the queued request resolves to the same id.
    const again = (await c2.request("acquire", ACQ("B", "op2"))) as any;
    assert.equal(again.entry.requestId, bRequestId);
    c2.close();

    sleeper.kill("SIGKILL");
    await new Promise<void>((r) => sleeper.once("exit", r));
  } finally {
    killDaemonFromJson(d.dir);
    await d.stop();
  }
});

test("no restart for same/older clients, and no restart loop after a respawn", async () => {
  const d = await startDaemon();
  try {
    const pid1 = d.child.pid!;
    // Same version: no restart.
    await rawRequest(d.sock, helloFrom(packageVersion()));
    await delay(600);
    const s1 = await rawRequest(d.sock, helloFrom());
    assert.equal(s1.result.pid, pid1, "same-version client does not restart the daemon");
    // Older client: no restart.
    await rawRequest(d.sock, helloFrom("0.0.1"));
    await delay(600);
    const s2 = await rawRequest(d.sock, helloFrom());
    assert.equal(s2.result.pid, pid1, "older client does not restart the daemon");
    // No clientVersion at all (pre-handshake client): no restart.
    await rawRequest(d.sock, helloFrom());
    await delay(600);
    const s3 = await rawRequest(d.sock, helloFrom());
    assert.equal(s3.result.pid, pid1);

    // Now restart for 999.0.0 ...
    await rawRequest(d.sock, helloFrom("999.0.0"));
    const pid2 = await waitRespawned(d, pid1);
    // ... and confirm neither 999.0.0 again nor an older version restarts
    // it a second time (LOAD_LOCK_RESTARTED_FOR marker prevents loops).
    await rawRequest(d.sock, helloFrom("999.0.0"));
    await delay(600);
    await rawRequest(d.sock, helloFrom("500.0.0"));
    await delay(600);
    const s4 = await rawRequest(d.sock, helloFrom());
    assert.equal(s4.result.pid, pid2, "respawned daemon is stable (no restart loop)");
  } finally {
    killDaemonFromJson(d.dir);
    await d.stop();
  }
});

test("offered entry restarts as queued and is re-offered with a fresh token", async () => {
  const d = await startDaemon();
  try {
    const pid1 = d.child.pid!;
    const cA = d.client();
    await cA.connect();
    const gA = (await cA.request("acquire", ACQ("A", "op1"))) as any;
    const cB = d.client();
    await cB.connect();
    const qB = (await cB.request("acquire", ACQ("B", "op1"))) as any;
    assert.equal(qB.state, "queued");

    // Free capacity -> B is offered (token t1).
    await cA.request("release", { permitToken: gA.entry.permitToken });
    const pend1 = (await cB.request("pending", { agentId: "B" })) as any;
    assert.equal(pend1.offers.length, 1);
    const t1 = pend1.offers[0].offerToken as string;
    assert.ok(t1);
    cA.close();
    cB.close();

    // Self-restart while the offer is outstanding.
    await rawRequest(d.sock, helloFrom("999.0.0"));
    await waitRespawned(d, pid1);

    // After the restart B is offered again — with a FRESH token.
    const c2 = d.client();
    await c2.connect();
    const pend2 = (await c2.request("pending", { agentId: "B" })) as any;
    assert.equal(pend2.offers.length, 1, "queued-then-offered request is re-offered after restart");
    const t2 = pend2.offers[0].offerToken as string;
    assert.ok(t2);
    assert.notEqual(t2, t1, "offer token is fresh after the restart");

    // The fresh token claims; the pre-restart token is stale.
    const cl = (await c2.request("claim", { offerToken: t2 })) as any;
    assert.equal(cl.entry.state, "held", "fresh offer token claims after the restart");
    await assert.rejects(c2.request("claim", { offerToken: t1 }), (e: any) => e.code === "stale_token");
    await c2.request("release", { permitToken: cl.entry.permitToken });
    c2.close();
  } finally {
    killDaemonFromJson(d.dir);
    await d.stop();
  }
});

test("service stop: graceful stop verified socket-free, daemon.json cleaned", async () => {
  const d = await startDaemon();
  try {
    const r = await runCliEnv(d.env, ["service", "stop"]);
    assert.equal(r.code, 0, `stdout: ${r.stdout} stderr: ${r.stderr}`);
    assert.ok(r.stdout.includes("stopped"), `honest success message: ${r.stdout}`);
    assert.ok(!(await probe(d.sock)), "socket is verifiably free");
    assert.ok(!existsSync(join(d.dir, "daemon.json")), "daemon.json removed");
  } finally {
    await d.stop();
  }
});

test("service stop: escalates to SIGKILL for a hung daemon and cleans the stale socket", async () => {
  const dir = mkdtempSync(join(TMP_BASE, "ll-hung-"));
  const sock = join(dir, "daemon.sock");
  // A fake daemon: owns the socket, writes daemon.json, ignores SIGTERM.
  const script = `
    const net = require("net");
    const fs = require("fs");
    const dir = process.argv[1], sock = process.argv[2];
    fs.writeFileSync(require("path").join(dir, "daemon.json"),
      JSON.stringify({ pid: process.pid, startedAt: Date.now(), socket: sock }));
    process.on("SIGTERM", () => {});
    const srv = net.createServer((s) => { s.on("data", () => {}); });
    srv.listen(sock, () => { setInterval(() => {}, 1000); });
  `;
  const child = spawn(process.execPath, ["-e", script, dir, sock], {
    stdio: "ignore",
    env: { ...process.env, LOAD_LOCK_STATE_DIR: dir, LOAD_LOCK_SOCKET: sock },
  });
  await until("fake hung daemon listens", () => probe(sock));
  const fakePid = child.pid!;
  try {
    const r = await runCliEnv(
      { ...process.env, LOAD_LOCK_STATE_DIR: dir, LOAD_LOCK_SOCKET: sock } as Record<string, string>,
      ["service", "stop", "--timeout", "700"],
    );
    assert.equal(r.code, 0, `stdout: ${r.stdout} stderr: ${r.stderr}`);
    assert.ok(/SIGKILL/i.test(r.stdout), `reports the escalation honestly: ${r.stdout}`);
    // The hung process is really dead and the endpoint is really free.
    await until("hung daemon exits", () => !isAlive(fakePid));
    assert.ok(!existsSync(sock), "stale socket file cleaned");
    assert.ok(!existsSync(join(dir, "daemon.json")), "stale daemon.json cleaned");
  } finally {
    try {
      child.kill("SIGKILL");
    } catch {
      /* ignore */
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("service start: refusal names the conflicting pid when the daemon hangs", async () => {
  const dir = mkdtempSync(join(TMP_BASE, "ll-refuse-"));
  const sock = join(dir, "daemon.sock");
  // Accepts connections but never answers hello; writes daemon.json.
  const script = `
    const net = require("net");
    const fs = require("fs");
    const path = require("path");
    const dir = process.argv[1], sock = process.argv[2];
    fs.writeFileSync(path.join(dir, "daemon.json"),
      JSON.stringify({ pid: process.pid, startedAt: Date.now(), socket: sock }));
    const srv = net.createServer((s) => { s.on("data", () => {}); });
    srv.listen(sock, () => { setInterval(() => {}, 1000); });
  `;
  const child = spawn(process.execPath, ["-e", script, dir, sock], {
    stdio: "ignore",
    env: { ...process.env, LOAD_LOCK_STATE_DIR: dir, LOAD_LOCK_SOCKET: sock },
  });
  await until("hung listener accepts", () => probe(sock));
  const fakePid = child.pid!;
  try {
    const r = await runCliEnv(
      { ...process.env, LOAD_LOCK_STATE_DIR: dir, LOAD_LOCK_SOCKET: sock } as Record<string, string>,
      ["service", "start", "--timeout", "1500"],
      30_000,
    );
    assert.notEqual(r.code, 0, "start must fail honestly");
    const combined = r.stdout + r.stderr;
    assert.ok(combined.includes(String(fakePid)), `refusal names the conflicting pid: ${combined}`);
    assert.ok(/daemon\.json names pid|answered from pid/.test(combined), `refusal points at the hang: ${combined}`);
  } finally {
    try {
      child.kill("SIGKILL");
    } catch {
      /* ignore */
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("service start: happy path reports pid + version", async () => {
  const d = await startDaemon();
  try {
    const r = await runCliEnv(d.env, ["service", "start"]);
    assert.equal(r.code, 0, `stdout: ${r.stdout} stderr: ${r.stderr}`);
    assert.ok(r.stdout.includes(`running on pid ${d.child.pid}`), `names the daemon pid: ${r.stdout}`);
    assert.ok(r.stdout.includes(`daemon v${packageVersion()}`), `names the daemon version: ${r.stdout}`);
  } finally {
    await d.stop();
  }
});

test("doctor: reports installed copies, versions, daemon skew, and copy drift", async () => {
  const d = await startDaemon();
  const cacheHome = mkdtempSync(join(TMP_BASE, "ll-cachehome-"));
  const fakePkg = mkdtempSync(join(TMP_BASE, "ll-fakepkg-"));
  try {
    // A stale copy in opencode's npm cache (issue #34 multi-copy reality).
    // Real layout: <cache>/opencode/npm/@aron98/load-lock@latest/<ts>/...
    const cacheCopy = join(cacheHome, "opencode", "npm", "@aron98", "load-lock@latest", "1700000000000", "node_modules", "@aron98", "load-lock");
    mkdirSync(cacheCopy, { recursive: true });
    writeFileSync(
      join(cacheCopy, "package.json"),
      JSON.stringify({ name: "@aron98/load-lock", version: "0.1.2" }),
    );
    // A drift copy on PATH.
    mkdirSync(join(fakePkg, "bin"), { recursive: true });
    writeFileSync(join(fakePkg, "package.json"), JSON.stringify({ name: "@aron98/load-lock", version: "9.9.9" }));
    writeFileSync(join(fakePkg, "bin", "load-lock"), "#!/bin/sh\ntrue\n");

    const env = {
      ...d.env,
      XDG_CACHE_HOME: cacheHome,
      PATH: join(fakePkg, "bin") + ":" + (process.env.PATH ?? ""),
    } as Record<string, string>;

    const r = await runCliEnv(env, ["doctor", "--json"]);
    assert.equal(r.code, 0, `stderr: ${r.stderr}`);
    const report = JSON.parse(r.stdout);
    assert.equal(report.installedVersion, packageVersion());
    // Daemon reached and versioned.
    assert.equal(report.hello.daemonVersion, packageVersion());
    // Both planted copies are detected...
    const versions = (report.copies as Array<{ source: string; path: string; version: string | null }>).map((c) => `${c.source}:${c.version}`);
    assert.ok(versions.includes("opencode-cache:0.1.2"), `opencode cache copy found: ${versions.join(", ")}`);
    assert.ok(versions.includes("path:9.9.9"), `PATH copy found: ${versions.join(", ")}`);
    assert.ok(versions.includes(`cli:${packageVersion()}`), `running copy reported: ${versions.join(", ")}`);
    // ...and the drift is warned about.
    assert.ok(Array.isArray(report.warnings) && report.warnings.length > 0);
    assert.ok(
      report.warnings.some((w: string) => w.includes("multiple load-lock versions") && w.includes("COMPATIBILITY")),
      `drift warning: ${JSON.stringify(report.warnings)}`,
    );
  } finally {
    await d.stop();
    rmSync(cacheHome, { recursive: true, force: true });
    rmSync(fakePkg, { recursive: true, force: true });
  }
});
