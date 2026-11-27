/**
 * Issue #29: sandboxed thin clients.
 *
 *  - Client-only mode (LOAD_LOCK_NO_SPAWN): with the env set and the socket
 *    unreachable, the client must NEVER auto-spawn a daemon and must fail
 *    loudly, pointing at the Sandboxes section of docs/OPERATIONS.md.
 *  - Holder-label prefixing (labelPrefix / LOAD_LOCK_LABEL_PREFIX) so
 *    sandboxed clients are identifiable in the dashboard.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { LLClient, ensureDaemon, noSpawnReason, noSpawnRequested } from "../shared/client.js";
import { ProtocolError } from "../shared/protocol.js";
import { startDaemon, delay, probe, cliMainPath } from "./testutil.js";

const ACQ = (agentId: string, opKey: string, extra: Record<string, unknown> = {}) => ({
  agentId,
  opKey,
  reason: "sandbox test",
  ...extra,
});

/** Fresh empty state dir + socket path; the dir is NOT created. */
function freshDir(prefix: string): { dir: string; sock: string; cleanup: () => void } {
  const dir = mkdtempSync(join(process.env.LL_TEST_TMP ?? "/tmp", prefix));
  rmSync(dir, { recursive: true, force: true }); // we want it absent
  const sock = join(dir, "daemon.sock");
  return { dir, sock, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Stop a daemon spawned via auto-spawn (pid recorded in daemon.json). */
async function killSpawnedDaemon(dir: string): Promise<void> {
  const info = JSON.parse(readFileSync(join(dir, "daemon.json"), "utf8"));
  try {
    process.kill(info.pid, "SIGTERM");
  } catch {
    /* already gone */
  }
  await delay(300);
}

test("LOAD_LOCK_NO_SPAWN: no daemon spawned, loud error pointing at the docs", async () => {
  const { dir, sock, cleanup } = freshDir("ll-nospawn-");
  process.env.LOAD_LOCK_NO_SPAWN = "1";
  try {
    const c = new LLClient({ socket: sock, stateDir: dir });
    await assert.rejects(
      () => c.connect(),
      (e: unknown) => {
        assert.ok(e instanceof ProtocolError);
        assert.equal(e.code, "unavailable");
        assert.ok(e.message.includes("LOAD_LOCK_NO_SPAWN"), "error names the env var");
        assert.ok(e.message.includes("docs/OPERATIONS.md"), "error points at the docs");
        assert.ok(e.message.includes("Sandboxes"), "error points at the Sandboxes section");
        assert.ok(e.message.includes(sock), "error names the unreachable socket");
        return true;
      },
    );
    // No daemon process was spawned: the state dir was never even created
    // (ensureDaemon creates it only when spawning) and nothing is listening.
    assert.equal(existsSync(dir), false, "no state dir created");
    assert.equal(await probe(sock), false, "nothing listening on the socket");
    await delay(1_000); // would-be spawner waits up to 10s; give it a beat
    assert.equal(existsSync(dir), false, "still no state dir after a wait");
    assert.equal(await probe(sock), false, "still no daemon after a wait");
  } finally {
    delete process.env.LOAD_LOCK_NO_SPAWN;
    cleanup();
  }
});

test("LOAD_LOCK_NO_SPAWN: ensureDaemon refuses directly too", async () => {
  const { dir, sock, cleanup } = freshDir("ll-nospawn2-");
  process.env.LOAD_LOCK_NO_SPAWN = "true";
  try {
    await assert.rejects(
      () => ensureDaemon(dir, sock),
      (e: unknown) => e instanceof ProtocolError && e.message.includes("docs/OPERATIONS.md"),
    );
    assert.equal(existsSync(dir), false, "ensureDaemon created nothing");
  } finally {
    delete process.env.LOAD_LOCK_NO_SPAWN;
    cleanup();
  }
});

test("LOAD_LOCK_NO_SPAWN=0 disables client-only mode (daemon auto-spawns)", async () => {
  const { dir, sock, cleanup } = freshDir("ll-nospawn0-");
  process.env.LOAD_LOCK_NO_SPAWN = "0";
  try {
    const c = new LLClient({ socket: sock, stateDir: dir });
    await c.connect();
    const hello = (await c.request("hello", {})) as any;
    assert.ok(hello.pid, "daemon spawned and reachable");
    c.close();
    await killSpawnedDaemon(dir);
  } finally {
    delete process.env.LOAD_LOCK_NO_SPAWN;
    cleanup();
  }
});

test("CLI under LOAD_LOCK_NO_SPAWN fails loudly with a docs pointer", async () => {
  const { dir, sock, cleanup } = freshDir("ll-nospawncli-");
  const res = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [cliMainPath, "status"], {
      env: {
        ...process.env,
        LOAD_LOCK_NO_SPAWN: "1",
        LOAD_LOCK_STATE_DIR: dir,
        LOAD_LOCK_SOCKET: sock,
      },
    });
    let stderr = "";
    child.stderr.on("data", (b) => (stderr += b));
    child.once("exit", (code) => resolve({ code, stderr }));
  });
  try {
    assert.equal(res.code, 70, "unavailable -> exit 70");
    assert.ok(res.stderr.includes("docs/OPERATIONS.md"), "stderr points at the docs");
    assert.ok(res.stderr.includes("Sandboxes"), "stderr points at the Sandboxes section");
    assert.equal(existsSync(dir), false, "CLI spawned no daemon");
  } finally {
    cleanup();
  }
});

// ---- issue #109: client-only by default inside an omac sandbox ----------

/** Run `fn` with `vars` set in process.env, restoring the previous values. */
async function withEnv<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("omac sandbox marker detection: sandbox env vs sidecar env", () => {
  // Sandboxed inner process of `omac start`/`omac serve` (omac v0.14.0).
  for (const marker of ["OMAC_FACADE_TOKEN", "OMAC_SOCKET"]) {
    const env = { [marker]: "x" };
    assert.equal(noSpawnRequested(env), true, `${marker} alone means client-only`);
    assert.match(noSpawnReason(env)!, new RegExp(`omac sandbox: ${marker} is set`));
    assert.equal(noSpawnRequested({ ...env, LOAD_LOCK_NO_SPAWN: "0" }), false, "LOAD_LOCK_NO_SPAWN=0 overrides");
    assert.equal(noSpawnRequested({ ...env, LOAD_LOCK_NO_SPAWN: "" }), true, "empty NO_SPAWN does not override");
  }
  // The exact OMAC_*/SIDECAR_* vars omac's supervisor gives a host-side
  // sidecar (internal/supervisor/supervisor.go buildEnv): must still spawn.
  const sidecar = { SIDECAR_PORT: "4100", SIDECAR_SKILL: "x", OMAC_WORKDIR: "/w", OMAC_HARNESS_SKILLS_DIR: "/w/.claude/skills" };
  assert.equal(noSpawnRequested(sidecar), false, "sidecar env keeps auto-spawn");
  assert.equal(noSpawnRequested({ OMAC_FACADE_TOKEN: "" }), false, "empty marker is not a marker");
  assert.equal(noSpawnReason({ LOAD_LOCK_NO_SPAWN: "1", OMAC_SOCKET: "/s" }), "LOAD_LOCK_NO_SPAWN is set");
});

test("omac marker, no daemon: connect fails client-only and spawns nothing", async () => {
  const { dir, sock, cleanup } = freshDir("ll-omac-");
  try {
    await withEnv({ OMAC_FACADE_TOKEN: "test-token", LOAD_LOCK_NO_SPAWN: "" }, async () => {
      const c = new LLClient({ socket: sock, stateDir: dir });
      await assert.rejects(
        () => c.connect(),
        (e: unknown) => {
          assert.ok(e instanceof ProtocolError);
          assert.equal(e.code, "unavailable");
          assert.ok(e.message.includes("omac sandbox: OMAC_FACADE_TOKEN is set"), "error names the omac marker");
          assert.ok(e.message.includes("LOAD_LOCK_NO_SPAWN=0"), "error names the override");
          assert.ok(e.message.includes("docs/OPERATIONS.md"), "error points at the docs");
          return true;
        },
      );
      await assert.rejects(() => ensureDaemon(dir, sock), (e: unknown) => e instanceof ProtocolError);
    });
    assert.equal(existsSync(dir), false, "no state dir created");
    await delay(1_000);
    assert.equal(existsSync(dir), false, "still no state dir after a wait");
    assert.equal(await probe(sock), false, "no daemon listening");
  } finally {
    cleanup();
  }
});

test("omac marker + LOAD_LOCK_NO_SPAWN=0: override spawns the daemon", async () => {
  const { dir, sock, cleanup } = freshDir("ll-omac0-");
  try {
    await withEnv({ OMAC_SOCKET: "/tmp/omac-x/bridge.sock", LOAD_LOCK_NO_SPAWN: "0" }, async () => {
      const c = new LLClient({ socket: sock, stateDir: dir });
      await c.connect();
      const hello = (await c.request("hello", {})) as any;
      assert.ok(hello.pid, "daemon spawned and reachable");
      c.close();
    });
    await killSpawnedDaemon(dir);
  } finally {
    cleanup();
  }
});

test("CLI with the omac marker exits 70 and spawns no daemon", async () => {
  const { dir, sock, cleanup } = freshDir("ll-omaccli-");
  const env: Record<string, string | undefined> = {
    ...process.env,
    OMAC_FACADE_TOKEN: "test-token",
    LOAD_LOCK_STATE_DIR: dir,
    LOAD_LOCK_SOCKET: sock,
  };
  delete env.LOAD_LOCK_NO_SPAWN;
  const res = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [cliMainPath, "status"], { env });
    let stderr = "";
    child.stderr.on("data", (b) => (stderr += b));
    child.once("exit", (code) => resolve({ code, stderr }));
  });
  try {
    assert.equal(res.code, 70, "unavailable -> exit 70");
    assert.ok(res.stderr.includes("omac sandbox"), "stderr names the omac sandbox");
    assert.equal(existsSync(dir), false, "CLI spawned no daemon");
  } finally {
    cleanup();
  }
});

test("daemon-side labelPrefix end-to-end: holder shows prefixed label", async () => {
  const d = await startDaemon();
  try {
    const c = d.client();
    const acq = (await c.request("acquire", ACQ("agentSbx", "sbx-1", { agentLabel: "issue-42 build", labelPrefix: "omac" }))) as any;
    assert.equal(acq.state, "granted");
    assert.equal(acq.entry.agentLabel, "omac:issue-42 build");
    const st = (await c.request("status", {})) as any;
    assert.equal(st.pools[0].holders[0].agentLabel, "omac:issue-42 build");
  } finally {
    await d.stop();
  }
});

test("LOAD_LOCK_LABEL_PREFIX env is injected by the shared client; explicit param wins", async () => {
  const d = await startDaemon();
  process.env.LOAD_LOCK_LABEL_PREFIX = "bwrap";
  try {
    const c = d.client();
    // injected from env when the acquire does not pass labelPrefix itself
    const a = (await c.request("acquire", ACQ("agentEnv", "env-1", { agentLabel: "cargo test" }))) as any;
    assert.equal(a.entry.agentLabel, "bwrap:cargo test");
    // an explicit labelPrefix overrides the env-injected one
    const b = (await c.request("acquire", ACQ("agentEnv", "env-2", { agentLabel: "x", labelPrefix: "omac" }))) as any;
    assert.equal(b.entry.agentLabel, "omac:x");
    // unprefixable clients (no label) still show the prefix via agentId fallback
    const e2 = (await c.request("acquire", ACQ("agentEnv2", "env-3", { pool: "heavy", weight: 1 }))) as any;
    assert.ok(String(e2.entry.agentLabel).startsWith("bwrap:"), `fallback label was ${e2.entry.agentLabel}`);
  } finally {
    delete process.env.LOAD_LOCK_LABEL_PREFIX;
    await d.stop();
  }
});
