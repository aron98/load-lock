#!/usr/bin/env node
/**
 * Simulated coding agent for the load-lock demo.
 *
 * Each instance is a separate OS process playing one agent from one harness,
 * working inside one git worktree. It talks to the shared load-lock daemon
 * exactly the way a scripted agent (e.g. aider, a shell-driven flow) would:
 * via the `load-lock` CLI. Real agents would use MCP tools or the native
 * OpenCode plugin instead — same daemon, same protocol, same FIFO.
 *
 * Usage (normally launched by demo.sh, not directly):
 *   cd <worktree> && node sim-agent.mjs --role A --agent sim-a --label "A (wt-a)"
 *
 * Roles:
 *   A — gets the permit immediately, runs heavy work, releases.
 *   B — queues, does light work meanwhile, claims its FIFO offer, runs heavy work.
 *   C — queues, deliberately MISSES its claim window (offer expires → paused),
 *       then explicitly rejoins once actually ready, claims, runs heavy work.
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    role: { type: "string" },
    agent: { type: "string" },
    label: { type: "string" },
  },
});
const role = values.role;
const agent = values.agent;
const label = values.label ?? agent;
if (!role || !agent) {
  console.error("sim-agent: --role and --agent are required");
  process.exit(64);
}

const CLI = join(import.meta.dirname, "..", "dist", "cli", "main.js");

/** Run the load-lock CLI; returns {code, stdout, stderr, json}. */
function ll(args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", timeout: 120_000 });
  let json = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    /* human output */
  }
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

const log = (msg) => console.log(`[${label}] ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (msg) => {
  console.error(`[${label}] FATAL: ${msg}`);
  process.exit(70);
};

const ACQ = ["acquire", "--agent", agent, "--label", label];

/** Poll own pending offers until one appears (or bail after ~30s). */
async function waitForOffer() {
  for (let i = 0; i < 100; i++) {
    const p = ll(["pending", "--agent", agent]);
    const offer = p.json?.offers?.[0];
    if (offer) return offer;
    await sleep(300);
  }
  fail("no offer arrived within 30s");
}

// ---------------------------------------------------------------------- role A
async function roleA() {
  log("I need to run a heavy job: cargo build (simulated with `sleep 2`)");
  const acq = ll([...ACQ, "--op-key", "build-wt-a", "--reason", "cargo build (simulated)"]);
  if (acq.code !== 0 || acq.json?.state !== "granted") {
    fail(`expected an immediate grant, got: ${acq.stdout.trim() || acq.stderr.trim()}`);
  }
  const permit = acq.json.entry.permitToken;
  log(`capacity was free: permit granted immediately (${permit.slice(0, 12)}…). Starting heavy work.`);
  const run = ll(["run", "--permit", permit, "--", "sleep", "2"]);
  log(`heavy work finished (exit ${run.code}); the run helper released the permit with the job's outcome.`);
}

// ---------------------------------------------------------------------- role B
async function roleB() {
  log("I need to run a heavy job: cargo test (simulated with `sleep 1.5`)");
  const acq = ll([...ACQ, "--op-key", "build-wt-b", "--reason", "cargo test (simulated)"]);
  if (acq.json?.state !== "queued") fail(`expected to queue, got: ${acq.stdout.trim()}`);
  log(
    `machine is busy: registered in the FIFO queue at position ${acq.json.entry.position} ` +
      `(request ${acq.json.entry.requestId.slice(0, 12)}…). No permit yet.`,
  );
  log("continuing useful LIGHT work meanwhile — no permit needed for these:");
  for (let i = 1; i <= 3; i++) {
    await sleep(400);
    log(`  light work ${i}/3: grep TODOs in my worktree`);
  }
  log("blocking on my queued request (bounded wait; a real agent would just check pending at the next tool call)…");
  const w = ll(["wait", "--id", acq.json.entry.requestId, "--agent", agent, "--timeout", "30000"]);
  if (w.code !== 0) fail(`wait failed: ${w.stderr.trim() || w.stdout.trim()}`);
  const permit = w.json.permit_token;
  log(`FIFO offer arrived and was claimed (permit ${permit.slice(0, 12)}…). Starting heavy work.`);
  const run = ll(["run", "--permit", permit, "--", "sleep", "1.5"]);
  log(`heavy work finished (exit ${run.code}); permit released.`);
}

// ---------------------------------------------------------------------- role C
async function roleC() {
  log("I need to run a heavy job too: cargo build (simulated with `sleep 1`)");
  const acq = ll([...ACQ, "--op-key", "build-wt-c", "--reason", "cargo build (simulated)"]);
  if (acq.json?.state !== "queued") fail(`expected to queue, got: ${acq.stdout.trim()}`);
  log(`machine is busy: queued at position ${acq.json.entry.position}. Doing light work while I wait.`);
  const offer = await waitForOffer();
  log(
    `offer arrived (claim window ~2s, expires ${new Date(offer.offerExpiresAt).toISOString()}) ` +
      "— but I'm mid-edit on a file; I will deliberately NOT claim it yet.",
  );
  await sleep(3200); // longer than the 2s claim window
  const p = ll(["pending", "--agent", agent]);
  const paused = p.json?.paused?.[0];
  if (!paused) fail("expected my request to be PAUSED after missing the claim window");
  log(
    "claim window elapsed → my request is PAUSED (the machine did not wait for me; " +
      "capacity moved on, and I am not endlessly recycled).",
  );
  log("I'm ready now — explicitly rejoining the queue.");
  ll(["rejoin", "--id", acq.json.entry.requestId]);
  const offer2 = await waitForOffer();
  log(`re-offered (request retained its FIFO identity). Claiming now, before the window lapses.`);
  const claim = ll(["claim", "--offer", offer2.offerToken]);
  if (claim.code !== 0) fail(`claim failed: ${claim.stderr.trim() || claim.stdout.trim()}`);
  const permit = claim.json.entry.permitToken;
  log(`claimed (${permit.slice(0, 12)}…). Starting heavy work.`);
  const run = ll(["run", "--permit", permit, "--", "sleep", "1"]);
  log(`heavy work finished (exit ${run.code}); permit released.`);
}

// -------------------------------------------------------------------------------
try {
  if (role === "A") await roleA();
  else if (role === "B") await roleB();
  else if (role === "C") await roleC();
  else fail(`unknown role "${role}"`);
  log("done. ✅");
} catch (e) {
  fail(e?.stack ?? String(e));
}
