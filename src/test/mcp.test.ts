/**
 * MCP server integration tests: spawn dist/mcp/main.js as a real MCP stdio
 * server (the way harnesses launch it) and exercise the tool round trips,
 * including the run_with_permit lifecycle.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startDaemon, delay, mcpMainPath, type DaemonHandle } from "./testutil.js";

async function connectMcp(d: DaemonHandle): Promise<Client> {
  const client = new Client({ name: "load-lock-test", version: "0.1.0" }, { capabilities: {} });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [mcpMainPath],
    env: d.env as Record<string, string>,
  });
  await client.connect(transport);
  return client;
}

async function callJson(c: Client, name: string, args: Record<string, unknown>): Promise<any> {
  const res = await c.callTool({ name, arguments: args });
  assert.equal(res.isError, undefined, `tool ${name} errored: ${JSON.stringify(res.content)}`);
  return JSON.parse((res.content as any)[0].text);
}

test("mcp: tool listing + acquire/release/configure round trip", async () => {
  const d = await startDaemon();
  const c = await connectMcp(d);
  try {
    const tools = await c.listTools();
    const names = tools.tools.map((t) => t.name);
    for (const expected of ["acquire", "claim", "release", "cancel", "rejoin", "pending", "status", "inspect_machine", "get_config", "configure", "run_with_permit", "job_status", "job_stop", "attach_pid", "mark_started"]) {
      assert.ok(names.includes(expected), `tool ${expected} registered`);
    }

    const acq = await callJson(c, "acquire", { reason: "build", op_key: "mcp-rt", agent_id: "mcpAgentA" });
    assert.equal(acq.state, "granted");
    assert.ok(acq.permit_token, "acquire result carries permit_token");
    assert.ok(acq.next_action, "structured next_action present");

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

test("mcp: multiple server processes share one machine-wide budget", async () => {
  const d = await startDaemon();
  const c1 = await connectMcp(d);
  const c2 = await connectMcp(d); // separate process = separate harness session
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
