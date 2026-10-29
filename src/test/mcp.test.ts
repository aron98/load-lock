/**
 * MCP server integration tests: spawn dist/mcp/main.js as a real MCP stdio
 * server (the way harnesses launch it) and exercise the tool round trips,
 * including the run_with_permit lifecycle.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startDaemon, delay, mcpMainPath, cliMainPath, type DaemonHandle } from "./testutil.js";

async function connectMcp(d: DaemonHandle, extraEnv: Record<string, string> = {}, args = [mcpMainPath]): Promise<Client> {
  const client = new Client({ name: "load-lock-test", version: "0.1.0" }, { capabilities: {} });
  // The test runner itself may be inside a harness session: drop inherited
  // session identity so each test controls it (issue #50).
  const env = { ...(d.env as Record<string, string>) };
  for (const k of ["LOAD_LOCK_AGENT", "CLAUDE_CODE_SESSION_ID", "OPENCODE_SESSION_ID"]) delete env[k];
  const transport = new StdioClientTransport({
    command: process.execPath,
    args,
    env: { ...env, ...extraEnv },
  });
  await client.connect(transport);
  return client;
}

async function callJson(c: Client, name: string, args: Record<string, unknown>): Promise<any> {
  const res = await c.callTool({ name, arguments: args });
  assert.equal(res.isError, undefined, `tool ${name} errored: ${JSON.stringify(res.content)}`);
  return JSON.parse((res.content as any)[0].text);
}

test("mcp: `load-lock mcp` serves the same MCP server as load-lock-mcp (#65)", async () => {
  const d = await startDaemon();
  const viaBin = await connectMcp(d);
  const viaCli = await connectMcp(d, {}, [cliMainPath, "mcp"]);
  try {
    const names = async (c: Client) => (await c.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(await names(viaCli), await names(viaBin), "identical tool set");
    assert.equal(viaCli.getServerVersion()?.name, viaBin.getServerVersion()?.name);
    const acq = await callJson(viaCli, "acquire", { reason: "build", op_key: "cli-mcp", agent_id: "cliMcpAgent" });
    assert.equal(acq.state, "granted");
    await callJson(viaCli, "release", { permit_token: acq.permit_token });
  } finally {
    await viaCli.close();
    await viaBin.close();
    await d.stop();
  }
});

test("mcp: initialize reports this package's version from package.json (#97)", async () => {
  const d = await startDaemon();
  const viaBin = await connectMcp(d); // load-lock-mcp entry point
  const viaCli = await connectMcp(d, {}, [cliMainPath, "mcp"]); // `load-lock mcp`
  try {
    const pkgVersion = JSON.parse(
      readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json"), "utf8"),
    ).version as string;
    assert.ok(pkgVersion, "package.json has a version");
    assert.equal(viaBin.getServerVersion()?.version, pkgVersion, "load-lock-mcp serverInfo.version matches package.json");
    assert.equal(viaCli.getServerVersion()?.version, pkgVersion, "`load-lock mcp` serverInfo.version matches package.json");
    assert.notEqual(pkgVersion, "0.1.0", "guards against the old hard-coded constant");
  } finally {
    await viaCli.close();
    await viaBin.close();
    await d.stop();
  }
});

test("mcp: tool listing + acquire/release/configure round trip", async () => {
  const d = await startDaemon();
  const c = await connectMcp(d);
  try {
    const tools = await c.listTools();
    const names = tools.tools.map((t) => t.name);
    for (const expected of ["acquire", "claim", "release", "cancel", "rejoin", "pending", "wait_for_turn", "status", "inspect_machine", "get_config", "configure", "run_with_permit", "job_status", "job_stop", "attach_pid", "mark_started", "wait_for_completion", "agent_guide"]) {
      assert.ok(names.includes(expected), `tool ${expected} registered`);
    }

    // agent_guide (issue #61): the same text `load-lock agent-guide` prints.
    const guide = await c.callTool({ name: "agent_guide", arguments: {} });
    assert.equal(
      (guide.content as any)[0].text,
      readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "docs", "AGENT_GUIDE.md"), "utf8"),
    );

    const acq = await callJson(c, "acquire", { reason: "build", op_key: "mcp-rt", agent_id: "mcpAgentA", label_prefix: "omac" });
    assert.equal(acq.state, "granted");
    assert.ok(acq.permit_token, "acquire result carries permit_token");
    assert.ok(acq.next_action, "structured next_action present");
    assert.equal(acq.entry.agentLabel, "omac:mcpAgentA", "label_prefix composes the holder label");

    // idempotent acquire with the same op_key
    const acq2 = await callJson(c, "acquire", { reason: "build", op_key: "mcp-rt", agent_id: "mcpAgentA" });
    assert.equal(acq2.request_id, acq.request_id, "same op_key -> same request");

    // a second agent queues
    const acqB = await callJson(c, "acquire", { reason: "tests", op_key: "mcp-b", agent_id: "mcpAgentB" });
    assert.equal(acqB.state, "queued");
    assert.equal(acqB.queue_position, 1);

    // configure: capacity up (CAS)
    const cfg = await callJson(c, "get_config", {});
    const conf = await callJson(c, "configure", {
      expected_version: cfg.config.version,
      changes: { pools: { heavy: { capacity: 2 } } },
      reason: "test: two cores of headroom",
      author: "mcp test",
    });
    assert.equal(conf.config.version, cfg.config.version + 1);

    // capacity increase admits the queued request -> offered to B
    const pend = await callJson(c, "pending", { agent_id: "mcpAgentB" });
    assert.equal(pend.offers.length, 1, "B has an outstanding offer after capacity increase");
    assert.ok(pend.offers[0].offerToken, "offer carries token");

    // claim it
    const claimed = await callJson(c, "claim", { offer_token: pend.offers[0].offerToken });
    assert.equal(claimed.state, "held");
    assert.ok(claimed.permit_token);

    // duplicate claim must fail cleanly (expired/stale token), not corrupt state
    const dup = await c.callTool({ name: "claim", arguments: { offer_token: pend.offers[0].offerToken } });
    assert.ok((dup as any).isError, "duplicate claim rejected (stale offer token)");

    // releases are idempotent
    const rel1 = await callJson(c, "release", { permit_token: acq.permit_token });
    assert.equal(rel1.released_now, true);
    const rel2 = await callJson(c, "release", { permit_token: acq.permit_token });
    assert.equal(rel2.released_now, false, "second release is idempotent");

    const st = await callJson(c, "status", {});
    assert.equal(st.pools[0].capacity, 2);
    assert.ok(st.pools[0].holders.length <= 1);
  } finally {
    await c.close();
    await d.stop();
  }
});

test("mcp: wait_for_turn sleeps bounded and returns structured snake_case results", async () => {
  const d = await startDaemon();
  const c = await connectMcp(d);
  try {
    const a = await callJson(c, "acquire", { reason: "build", op_key: "wft-a", agent_id: "mcpWaitA" });
    assert.equal(a.state, "granted");
    const b = await callJson(c, "acquire", { reason: "tests", op_key: "wft-b", agent_id: "mcpWaitB" });
    assert.equal(b.state, "queued");

    // Timeout is a structured still_queued result — never a tool error.
    const t0 = Date.now();
    const out1 = await callJson(c, "wait_for_turn", { agent_id: "mcpWaitB", timeout_ms: 700 });
    assert.equal(out1.state, "still_queued");
    assert.equal(out1.request_id, b.request_id);
    assert.equal(out1.queue_position, 1);
    assert.equal(out1.queue_length, 1);
    assert.ok(Array.isArray(out1.holders) && out1.holders.length >= 1, "holder info included");
    assert.equal(out1.holders[0].agentId, "mcpWaitA");
    assert.ok(out1.waited_ms >= 600 && Date.now() - t0 < 5_000, "wait respected the bound");

    // The cap is discoverable via configure + get_config (snake_case surface).
    const cfg = await callJson(c, "get_config", {});
    assert.equal(cfg.config.maxTurnWaitMs, 600_000, "default turn-wait cap present in config");

    // Wake path: release, sleep again, wake holding an auto-claimed permit.
    await callJson(c, "release", { permit_token: a.permit_token });
    const out2 = await callJson(c, "wait_for_turn", { agent_id: "mcpWaitB", timeout_ms: 10_000 });
    assert.equal(out2.state, "granted");
    assert.equal(out2.auto_claimed, true, "auto-claim is explicit in the response");
    assert.ok(out2.permit_token, "granted result carries a top-level permit_token");
    assert.equal(out2.request_id, b.request_id);
    await callJson(c, "release", { permit_token: out2.permit_token });
  } finally {
    await c.close();
    await d.stop();
  }
});

test("mcp: run_with_permit tracks a background job and auto-releases", async () => {
  const d = await startDaemon();
  const c = await connectMcp(d);
  try {
    const acq = await callJson(c, "acquire", { reason: "build", op_key: "mcp-job" });
    assert.equal(acq.state, "granted");

    const job = await callJson(c, "run_with_permit", {
      permit_token: acq.permit_token,
      command: `sh -c 'sleep 1 && echo done'`,
    });
    assert.ok(job.job_id, "returns a job handle for background execution");
    assert.equal(job.state, "running");

    // status while running
    const running = await callJson(c, "job_status", { job_id: job.job_id });
    assert.equal(running.running, true);

    // wait for completion (poll with cap)
    let exited: any = null;
    for (let i = 0; i < 40 && !exited; i++) {
      await delay(150);
      const s = await callJson(c, "job_status", { job_id: job.job_id });
      if (!s.running) exited = s;
    }
    assert.ok(exited, "job completed");
    assert.equal(exited.exit_code, 0);
    assert.ok(exited.output_tail.includes("done"));

    // auto-release happened without an explicit release call
    await delay(300);
    const st = await callJson(c, "status", {});
    assert.equal(st.pools[0].holders.length, 0, "permit auto-released after job exit");
  } finally {
    await c.close();
    await d.stop();
  }
});

test("mcp: wait_for_completion wakes promptly on an adapter-parented job with exit code + output tail", async () => {
  const d = await startDaemon();
  const c = await connectMcp(d);
  try {
    const acq = await callJson(c, "acquire", { reason: "build", op_key: "mcp-wfc" });
    assert.equal(acq.state, "granted");

    const job = await callJson(c, "run_with_permit", {
      permit_token: acq.permit_token,
      command: `sh -c 'sleep 1 && echo done'`,
    });
    assert.ok(job.job_id, "returns a job handle for background execution");

    // One bounded call sleeps through the execution phase.
    const t0 = Date.now();
    const res = await callJson(c, "wait_for_completion", { job_id: job.job_id, timeout_ms: 20_000 });
    const elapsed = Date.now() - t0;
    assert.equal(res.state, "finished");
    assert.equal(res.exit_code, 0, "exact exit code on wake");
    assert.ok(res.output_tail.includes("done"), "output tail included");
    assert.equal(res.permit_released, true, "permit was freed before the wake");
    assert.ok(elapsed < 8_000, `woke promptly on the child exit event (took ${elapsed}ms)`);
    assert.ok(res.waited_ms >= 800, `waited_ms reported (got ${res.waited_ms})`);

    const st = await callJson(c, "status", {});
    assert.equal(st.pools[0].holders.length, 0, "capacity is free the moment we wake");
  } finally {
    await c.close();
    await d.stop();
  }
});

test("mcp: run_with_permit wait:true fire-and-waits in one call", async () => {
  const d = await startDaemon();
  const c = await connectMcp(d);
  try {
    const acq = await callJson(c, "acquire", { reason: "build", op_key: "mcp-wfc-wait" });
    assert.equal(acq.state, "granted");

    const job = await callJson(c, "run_with_permit", {
      permit_token: acq.permit_token,
      command: `sh -c 'sleep 0.5 && echo hi'`,
      wait: true,
      wait_timeout_ms: 20_000,
    });
    assert.equal(job.state, "finished", "wait:true resolves the whole lifecycle in one call");
    assert.equal(job.exit_code, 0);
    assert.ok(job.output_tail.includes("hi"));
    assert.equal(job.permit_released, true);

    const st = await callJson(c, "status", {});
    assert.equal(st.pools[0].holders.length, 0);
  } finally {
    await c.close();
    await d.stop();
  }
});

test("mcp: wait_for_completion checkpoints on still_running and job_stop resolves stopped_by_request", async () => {
  const d = await startDaemon();
  const c = await connectMcp(d);
  try {
    const acq = await callJson(c, "acquire", { reason: "build", op_key: "mcp-wfc-stop" });
    assert.equal(acq.state, "granted");
    const job = await callJson(c, "run_with_permit", {
      permit_token: acq.permit_token,
      command: "sleep 30",
    });
    assert.ok(job.job_id);

    // Short budget elapses -> structured checkpoint, job untouched.
    const t0 = Date.now();
    const ck = await callJson(c, "wait_for_completion", { job_id: job.job_id, timeout_ms: 500 });
    assert.ok(Date.now() - t0 < 5_000, "checkpoint returns when the budget elapses");
    assert.equal(ck.state, "still_running");
    assert.ok(ck.waited_ms >= 400, `waited the budget (waited_ms=${ck.waited_ms})`);

    // Stopping the job wakes any waiter as stopped_by_request.
    await callJson(c, "job_stop", { job_id: job.job_id });
    const res = await callJson(c, "wait_for_completion", { job_id: job.job_id, timeout_ms: 20_000 });
    assert.equal(res.state, "stopped_by_request");
    assert.match(res.next_action ?? "", /job_stop|re-run/i);
    const st = await callJson(c, "status", {});
    assert.equal(st.pools[0].holders.length, 0, "stopping the job released the permit");
  } finally {
    await c.close();
    await d.stop();
  }
});

test("mcp: wait_for_completion on a daemon-tracked request_id (attach_pid) and job_unknown for bad ids", async () => {
  const d = await startDaemon();
  const c = await connectMcp(d);
  const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
  child.unref();
  try {
    const acq = await callJson(c, "acquire", { reason: "build", op_key: "mcp-wfc-tracked" });
    assert.equal(acq.state, "granted");

    // Daemon-tracked (not parented by this MCP server): liveness-sweep wake.
    await callJson(c, "attach_pid", { permit_token: acq.permit_token, pid: child.pid });
    const waitP = callJson(c, "wait_for_completion", { request_id: acq.request_id, timeout_ms: 25_000 });
    await delay(300);
    const t0 = Date.now();
    child.kill("SIGKILL");
    const res = await waitP;
    const elapsed = Date.now() - t0;
    assert.equal(res.state, "finished", "sweep wake on the daemon-tracked job");
    assert.equal(res.permit_released, true);
    assert.ok(elapsed < 8_000, `woke within roughly one sweep interval (took ${elapsed}ms)`);

    // Unknown ids are structured job_unknown results, never tool errors.
    const bad = await callJson(c, "wait_for_completion", { job_id: "job_nope_123", timeout_ms: 2_000 });
    assert.equal(bad.state, "job_unknown");
  } finally {
    if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
    await c.close();
    await d.stop();
  }
});

test("mcp: multiple server processes share one machine-wide budget", async () => {
  const d = await startDaemon();
  const c1 = await connectMcp(d, { CLAUDE_CODE_SESSION_ID: "budget-session-1" });
  const c2 = await connectMcp(d, { CLAUDE_CODE_SESSION_ID: "budget-session-2" }); // separate harness session
  try {
    const a1 = await callJson(c1, "acquire", { reason: "agent1 build", op_key: "a1" });
    assert.equal(a1.state, "granted");
    const a2 = await callJson(c2, "acquire", { reason: "agent2 tests", op_key: "a2" });
    assert.equal(a2.state, "queued", "second harness session sees the same capacity budget");
    assert.equal(a2.queue_position, 1);
    await callJson(c1, "release", { permit_token: a1.permit_token });

    // the offer for agent2 shows up in ITS tool boundary results
    const pend = await callJson(c2, "pending", {});
    assert.equal(pend.offers.length, 1);
    const claimed = await callJson(c2, "claim", { offer_token: pend.offers[0].offerToken });
    assert.equal(claimed.state, "held");
    await callJson(c2, "release", { permit_token: claimed.permit_token });
  } finally {
    await c1.close();
    await c2.close();
    await d.stop();
  }
});

test("mcp: two server processes from one harness session share an identity (issue #50)", async () => {
  const d = await startDaemon();
  // Same parent process, no session env: both resolve to the same harness
  // ancestor, like a plugin-bundled + a standalone registration.
  const c1 = await connectMcp(d);
  const c2 = await connectMcp(d);
  const other = await connectMcp(d, { CLAUDE_CODE_SESSION_ID: "other-session" });
  try {
    const filler = await callJson(other, "acquire", { reason: "other build", op_key: "fill" });
    assert.equal(filler.state, "granted");
    const a = await callJson(c1, "acquire", { reason: "session build", op_key: "shared-op" });
    assert.equal(a.state, "queued");
    if (process.platform === "linux") assert.match(a.entry.agentId, /^proc:\d+:\d+$/);

    // acquire through one server shows up in pending through the other
    const viaOther = await callJson(c2, "pending", {});
    assert.deepEqual(viaOther.queue.map((e: any) => e.requestId), [a.request_id]);
    // and the op_key dedupes across both registrations
    const again = await callJson(c2, "acquire", { reason: "session build", op_key: "shared-op" });
    assert.equal(again.request_id, a.request_id);

    // a server from a different session gets a distinct id and sees none of it
    const otherPending = await callJson(other, "pending", {});
    assert.equal(otherPending.queue.length, 0);
    assert.equal(otherPending.held[0].agentId, "claude-code:other-session");
    assert.notEqual(otherPending.held[0].agentId, a.entry.agentId);

    // the release hands the offer to the shared identity: visible via either server
    await callJson(other, "release", { permit_token: filler.permit_token });
    const p1 = await callJson(c1, "pending", {});
    assert.equal(p1.offers.length, 1);
    const claimed = await callJson(c2, "claim", { offer_token: p1.offers[0].offerToken });
    assert.equal(claimed.state, "held");
    await callJson(c1, "release", { permit_token: claimed.permit_token });
  } finally {
    await c1.close();
    await c2.close();
    await other.close();
    await d.stop();
  }
});
