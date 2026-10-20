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
import { LLClient, ensureDaemon } from "../shared/client.js";
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
