/**
 * End-to-end tests for the `load-lock run` helper: separate CLI processes
 * (independent OS processes, as a real agent would spawn them) against a real
 * daemon; exit codes and automatic release semantics.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { startDaemon, runCli, delay, type DaemonHandle } from "./testutil.js";

test("run: success and failure propagate exit codes and auto-release", async () => {
  const d = await startDaemon();
  try {
    const ok = await runCli(d, ["run", "--reason", "build", "--op-key", "ok1", "--", "sh", "-c", "echo heavy-done"]);
    assert.equal(ok.code, 0, `stdout: ${ok.stdout}\nstderr: ${ok.stderr}`);
    assert.ok(ok.stdout.includes("heavy-done"));
    const bad = await runCli(d, ["run", "--reason", "build", "--op-key", "bad1", "--", "sh", "-c", "exit 3"]);
    assert.equal(bad.code, 3, "the job's exit code propagates");
    // both permits auto-released
    const c = d.client();
    await c.connect();
    const st = (await c.request("status", {})) as any;
    assert.equal(st.pools[0].holders.length, 0);
    assert.equal(st.pools[0].used, 0);
    c.close();
  } finally {
    await d.stop();
  }
});

test("run: exits 68 (queued) while another process holds the permit; FIFO continuation", async () => {
  const d = await startDaemon();
  const c = d.client();
  try {
    await c.connect();
    // a holder that keeps the permit for ~2s, in a SEPARATE process
    const holder = runCli(d, ["run", "--reason", "hold", "--op-key", "hold1", "--wait-ms", "0", "--", "sleep", "2"]);
    await (async () => {
      // wait until the holder actually holds
      for (let i = 0; i < 50; i++) {
        const st = (await c.request("status", {})) as any;
        if (st.pools[0].holders.length === 1) return;
        await delay(100);
      }
      throw new Error("holder did not acquire");
    })();
    const queued = await runCli(d, ["run", "--reason", "second", "--op-key", "q1", "--wait-ms", "0", "--", "true"]);
    assert.equal(queued.code, 68, "queued run exits 68 instead of blocking forever");
    assert.equal((await holder).code, 0);
    // after the holder finishes, capacity is free again
    const st2 = (await c.request("status", {})) as any;
    assert.equal(st2.pools[0].holders.length, 0);
  } finally {
    await d.stop();
  }
});

test("wait: bounded blocking offer-watcher for scriptable flows", async () => {
  const d: DaemonHandle = await startDaemon();
  const c = d.client();
  try {
    await c.connect();
    // A holds; B queues (as a separate CLI process for realism)
    const acqA = await runCli(d, ["acquire", "--agent", "agentA", "--op-key", "a1", "--reason", "hold", "--json"]);
    assert.equal(acqA.code, 0);
    const aPermit = (JSON.parse(acqA.stdout) as any).entry.permitToken;
    const acqB = await runCli(d, ["acquire", "--agent", "agentB", "--op-key", "b1", "--reason", "waiter", "--json"]);
    assert.equal(acqB.code, 68);
    const bReqId = (JSON.parse(acqB.stdout) as any).entry.requestId;

    // waiter watches for its offer in a separate process
    const waiter = runCli(d, ["wait", "--id", bReqId, "--agent", "agentB", "--timeout", "8000", "--json"]);
    await delay(300);
    await c.request("release", { permitToken: aPermit });
    const w = await waiter;
    assert.equal(w.code, 0, `waiter stdout: ${w.stdout}\nstderr: ${w.stderr}`);
    const permit = (JSON.parse(w.stdout) as any).permit_token;
    assert.ok(permit, "wait prints the claimed permit token");
    // clean up: release B
    const rel = await runCli(d, ["release", "--permit", permit, "--json"]);
    assert.equal(rel.code, 0);
  } finally {
    await d.stop();
  }
});
