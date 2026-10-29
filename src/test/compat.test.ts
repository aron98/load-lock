/**
 * Persisted state format compatibility (issue #51): a state dir written by a
 * NEWER format (higher formatVersion, extra fields, unknown journal entry
 * kinds) must load in the current code, and unknown fields must survive a
 * rewrite. Also: what we write stays readable by older daemons (the journal
 * stays a bare array; config.json keeps `config` + `history`).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LLClient } from "../shared/client.js";
import { Machine } from "../core/state.js";
import { loadState, saveState, loadJournal, saveJournal, STATE_FORMAT_VERSION } from "../core/persist.js";
import type { JournalEntry } from "../shared/protocol.js";
import { daemonMainPath, probe, until } from "./testutil.js";

const TMP_BASE = process.env.LL_TEST_TMP ?? join(tmpdir(), "opencode");
mkdirSync(TMP_BASE, { recursive: true });

const FUTURE = STATE_FORMAT_VERSION + 7;

function newerConfigFile() {
  return {
    formatVersion: FUTURE,
    futureTopLevel: { keep: "me" },
    config: {
      version: 4,
      pools: { heavy: { capacity: 2, futurePoolField: "pool-x" }, gpu: { capacity: 1 } },
      offerTimeoutMs: 30_000,
      maxWaitMs: 5_000,
      maxTurnWaitMs: 600_000,
      startTimeoutMs: 120_000,
      untrackedLeaseMs: 15 * 60_000,
      guidance: { notes: "n", futureGuidance: 42 },
      futureConfigField: ["a", "b"],
    },
    history: [{ ts: 1, author: "newer", reason: "r", changes: {}, resultingVersion: 4, futureHistoryField: true }],
  };
}

function newerJournal(now: number) {
  return [
    // a held permit with an extra field + newer per-entry version
    {
      formatVersion: FUTURE,
      requestId: "req_held",
      pool: "heavy",
      agentId: "A",
      opKey: "op1",
      reason: "build",
      weight: 1,
      state: "held",
      permitToken: "pmt_held",
      phase: "running_untracked",
      claimedAt: now,
      futureEntryField: { x: 1 },
    },
    // an entry kind this version doesn't know
    { formatVersion: FUTURE, requestId: "req_future", pool: "heavy", agentId: "B", opKey: "op", reason: "r", weight: 1, state: "suspended", claimedAt: now },
    // a held permit in a phase this version doesn't know
    { requestId: "req_phase", pool: "gpu", agentId: "C", opKey: "op", reason: "r", weight: 1, state: "held", permitToken: "pmt_phase", phase: "paused_by_future", claimedAt: now },
    // malformed garbage
    "not an entry",
    { state: "held" },
    // a queued request with an extra field
    { requestId: "req_q", pool: "heavy", agentId: "D", opKey: "op", reason: "r", weight: 1, state: "queued", enqueuedAt: now, claimedAt: now, futureQueued: "q" },
  ];
}

function tmpDir(): string {
  return mkdtempSync(join(TMP_BASE, "ll-compat-"));
}

test("compat: newer config.json loads and unknown fields survive a config change", () => {
  const dir = tmpDir();
  try {
    writeFileSync(join(dir, "config.json"), JSON.stringify(newerConfigFile()));
    const st = loadState(dir);
    assert.equal(st.formatVersion, FUTURE);
    assert.equal(st.config.pools.heavy.capacity, 2);
    const m = new Machine(Date.now, st.config);
    m.history.push(...st.history);
    m.configure({ expectedVersion: 4, changes: { pools: { heavy: { capacity: 3 } }, guidance: { notes: "n2" } }, reason: "t", author: "me" });
    saveState(dir, m.config, m.history);

    const raw = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
    assert.equal(raw.formatVersion, STATE_FORMAT_VERSION);
    assert.deepEqual(raw.futureTopLevel, { keep: "me" });
    assert.deepEqual(raw.config.futureConfigField, ["a", "b"]);
    assert.equal(raw.config.pools.heavy.capacity, 3);
    assert.equal(raw.config.pools.heavy.futurePoolField, "pool-x");
    assert.equal(raw.config.guidance.notes, "n2");
    assert.equal(raw.config.guidance.futureGuidance, 42);
    assert.equal(raw.history[0].futureHistoryField, true);
    assert.equal(raw.history.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("compat: pre-versioning config.json reads as format 0; our writes keep the old shape", () => {
  const dir = tmpDir();
  try {
    const old = newerConfigFile();
    writeFileSync(join(dir, "config.json"), JSON.stringify({ config: old.config, history: [] }));
    const st = loadState(dir);
    assert.equal(st.formatVersion, 0);
    saveState(dir, st.config, st.history);
    const raw = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
    // older daemons read exactly `config` + `history`
    assert.equal(typeof raw.config, "object");
    assert.ok(Array.isArray(raw.history));

    // journal stays a bare array (what every released daemon reads)
    saveJournal(dir, [{ requestId: "r", pool: "heavy", agentId: "A", opKey: "o", reason: "r", weight: 1, claimedAt: 1, state: "queued" }]);
    const j = JSON.parse(readFileSync(join(dir, "journal.json"), "utf8"));
    assert.ok(Array.isArray(j));
    assert.equal(j[0].formatVersion, STATE_FORMAT_VERSION);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("compat: unknown journal entry kinds don't break restore; unknown fields round-trip", () => {
  const dir = tmpDir();
  try {
    const now = Date.now();
    writeFileSync(join(dir, "config.json"), JSON.stringify(newerConfigFile()));
    writeFileSync(join(dir, "journal.json"), JSON.stringify(newerJournal(now)));
    const st = loadState(dir);
    const m = new Machine(Date.now, st.config);
    const res = m.restore(loadJournal(dir), () => null);
    assert.equal(res.kept, 2, "held + unknown-phase held");
    assert.equal(res.queued, 1);
    assert.equal(res.skipped, 2, "unknown kind + malformed entry");
    const ev = m.eventsSince(0).find((e) => e.type === "daemon_recovered");
    assert.match(String(ev?.detail), /skipped 2 unrecognized/, "skips are reported in the recovery event");

    // unknown phase: kept, conservatively as untracked with a lease
    const out = m.journalEntries();
    const phase = out.find((e) => e.requestId === "req_phase")!;
    assert.equal(phase.phase, "running_untracked");
    assert.ok(phase.leaseDeadline && phase.leaseDeadline > now);

    // unknown per-entry fields are written back while the entry lives
    saveJournal(dir, out);
    const back = loadJournal(dir) as Array<JournalEntry & Record<string, unknown>>;
    assert.deepEqual(back.find((e) => e.requestId === "req_held")!.futureEntryField, { x: 1 });
    assert.equal(back.find((e) => e.requestId === "req_q")!.futureQueued, "q");
    assert.ok(back.every((e) => e.formatVersion === STATE_FORMAT_VERSION));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("compat: a daemon started on a newer-format state dir serves it and preserves unknown fields", async () => {
  const dir = tmpDir();
  const sock = join(dir, "daemon.sock");
  writeFileSync(join(dir, "config.json"), JSON.stringify(newerConfigFile()));
  writeFileSync(join(dir, "journal.json"), JSON.stringify(newerJournal(Date.now())));
  const child = spawn(process.execPath, [daemonMainPath, "--state-dir", dir, "--socket", sock], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, LOAD_LOCK_STATE_DIR: dir, LOAD_LOCK_SOCKET: sock },
  });
  try {
    await until("daemon listens", async () => await probe(sock));
    const c = new LLClient({ socket: sock, stateDir: dir, spawnDaemon: false });
    await c.connect();
    const st = (await c.request("status", {})) as any;
    const heavy = st.pools.find((p: any) => p.pool === "heavy");
    assert.ok(heavy, "heavy pool present");
    assert.equal(heavy.holders.length, 1, "known held permit restored");

    const cfg = (await c.request("get_config", {})) as any;
    await c.request("configure", {
      expectedVersion: cfg.config.version,
      changes: { pools: { heavy: { capacity: 5 } } },
      reason: "compat test",
      author: "test",
    });
    // the restored token still releases
    const rel = (await c.request("release", { permitToken: "pmt_held" })) as any;
    assert.equal(rel.releasedNow, true);
    c.close();

    const raw = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
    assert.equal(raw.config.pools.heavy.capacity, 5);
    assert.equal(raw.config.pools.heavy.futurePoolField, "pool-x");
    assert.deepEqual(raw.config.futureConfigField, ["a", "b"]);
    assert.deepEqual(raw.futureTopLevel, { keep: "me" });

    const j = JSON.parse(readFileSync(join(dir, "journal.json"), "utf8"));
    assert.ok(Array.isArray(j));
    assert.equal(j.find((e: any) => e.requestId === "req_q")?.futureQueued, "q");
  } finally {
    child.kill("SIGTERM");
    await new Promise<void>((r) => (child.exitCode !== null ? r() : child.once("exit", () => r())));
    rmSync(dir, { recursive: true, force: true });
  }
});
