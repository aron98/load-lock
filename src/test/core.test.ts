/**
 * Unit tests for the pure state machine (no I/O, injectable clock).
 * Compile + run: npm test  (node --test dist/test/)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { Machine, defaultConfig } from "../core/state.js";
import { ProtocolError } from "../shared/protocol.js";

function mk(config = defaultConfig()) {
  let t = 1_000_000; // fixed base for deterministic math
  const clock = () => t;
  return {
    m: new Machine(clock, { ...config }),
    advance: (ms: number) => {
      t += ms;
    },
    now: () => t,
  };
}

const A = "agentA", B = "agentB", C = "agentC";

/** Current state of a request (snapshots returned by acquire() are frozen). */
const stateOf = (m: Machine, id: string) => m.entryById(id).state;
/** Current offer token of an agent's offered request. */
const offerOf = (m: Machine, agentId: string) => {
  const o = m.pending(agentId).offers[0];
  assert.ok(o, `${agentId} should have an outstanding offer`);
  return o.offerToken!;
};

function grant(m: Machine, agent = A, op = "op1", extra: Record<string, unknown> = {}) {
  const r = m.acquire({ agentId: agent, opKey: op, reason: "test", pool: "heavy", ...extra });
  assert.equal(r.state, "granted", `expected grant for ${agent}`);
  return r.entry!;
}

test("immediate grant then FIFO queueing with positions", () => {
  const { m } = mk();
  const a = grant(m);
  const b = m.acquire({ agentId: B, opKey: "op1", reason: "b" });
  const c = m.acquire({ agentId: C, opKey: "op1", reason: "c" });
  assert.equal(b.state, "queued");
  assert.equal(c.state, "queued");
  assert.equal(b.entry!.position, 1);
  assert.equal(c.entry!.position, 2);
  assert.equal(m.used("heavy"), 1);
  // owner sees the permit token; the public snapshot never does
  assert.ok(a.permitToken!.startsWith("prm_"));
  const st = m.status();
  assert.equal(st.pools[0].holders[0].state, "held");
  assert.equal((st.pools[0].holders[0] as any).permitToken, undefined);
  assert.equal(a.requestId, st.pools[0].holders[0].requestId);
});

test("idempotent acquire returns the same live request (tokens included)", () => {
  const { m } = mk();
  const a = grant(m, A, "op1");
  const again = m.acquire({ agentId: A, opKey: "op1", reason: "again" });
  assert.equal(again.state, "granted");
  assert.equal(again.entry!.requestId, a.requestId);
  assert.equal(again.entry!.permitToken, a.permitToken);
  // distinct op keys are distinct requests
  const other = m.acquire({ agentId: A, opKey: "op2", reason: "other" });
  assert.equal(other.state, "queued");
});

test("strict FIFO offers on release; claim converts offer to permit", () => {
  const { m } = mk();
  const a = grant(m, A, "op1");
  const b = m.acquire({ agentId: B, opKey: "op1", reason: "b" });
  const c = m.acquire({ agentId: C, opKey: "op1", reason: "c" });
  const bId = b.entry!.requestId, cId = c.entry!.requestId;
  m.release(a.permitToken!);
  // B (head of queue) is offered, C stays queued
  assert.equal(stateOf(m, bId), "offered");
  assert.equal(stateOf(m, cId), "queued");
  // outstanding offers consume capacity
  assert.equal(m.used("heavy"), 1);
  const bTok = offerOf(m, B);
  assert.ok(bTok.startsWith("off_"));
  const claimed = m.claim(bTok);
  assert.equal(claimed.entry.state, "held");
  assert.ok(claimed.entry.permitToken!.startsWith("prm_"));
  // duplicate claim of a consumed offer token is rejected
  assert.throws(() => m.claim(bTok), (e: unknown) => e instanceof ProtocolError && e.code === "stale_token");
});

test("offer expiry pauses the request and passes capacity to the next waiter", () => {
  const { m, advance } = mk();
  const a = grant(m, A, "op1");
  const b = m.acquire({ agentId: B, opKey: "op1", reason: "b" });
  const c = m.acquire({ agentId: C, opKey: "op1", reason: "c" });
  const bId = b.entry!.requestId, cId = c.entry!.requestId;
  m.release(a.permitToken!);
  assert.equal(stateOf(m, bId), "offered");
  const bTok = offerOf(m, B);
  advance(30_001);
  m.tick(m.now());
  assert.equal(stateOf(m, bId), "paused");
  assert.equal(stateOf(m, cId), "offered"); // capacity passed on
  // claiming the expired offer is deterministically rejected
  assert.throws(() => m.claim(bTok), (e: unknown) => e instanceof ProtocolError && e.code === "offer_expired");
  assert.equal(stateOf(m, bId), "paused"); // never auto-recycled
  // claim C's fresh offer, release -> free capacity
  m.release(m.claim(offerOf(m, C)).entry.permitToken!);
  // rejoin goes to the tail of the FIFO (here: it's the only waiter)
  const rejoined = m.rejoin({ requestId: bId });
  assert.equal(rejoined.state, "offered");
  assert.ok(rejoined.offerToken);
});

test("explicit decline frees the reserved capacity", () => {
  const { m } = mk();
  const a = grant(m, A, "op1");
  const b = m.acquire({ agentId: B, opKey: "op1", reason: "b" });
  const bId = b.entry!.requestId;
  m.release(a.permitToken!);
  m.decline(offerOf(m, B));
  assert.equal(stateOf(m, bId), "paused");
  const again = m.acquire({ agentId: A, opKey: "op2", reason: "again" });
  assert.equal(again.state, "granted");
});

test("start deadline reclaims a claimed-but-never-started permit", () => {
  const { m, advance } = mk();
  const a = grant(m, A, "op1");
  advance(120_001);
  m.tick(m.now());
  assert.equal(stateOf(m, a.requestId), "released");
  // capacity freed: a fresh request grants directly
  const b = m.acquire({ agentId: B, opKey: "op1", reason: "b" });
  assert.equal(b.state, "granted");
  // late explicit release of the reclaimed permit is idempotent, not an error
  m.release(a.permitToken!);
});

test("start_job is atomic against reclamation (race: tick first)", () => {
  const { m, advance } = mk();
  const a = grant(m, A, "op1");
  advance(120_001);
  m.tick(m.now()); // reclaims the never-started permit
  assert.throws(
    () => m.startJob(a.permitToken!, 12345, 12345),
    (e: unknown) => e instanceof ProtocolError && (e.code === "stale_token" || e.code === "wrong_state"),
  );
});

test("start_job transitions to tracked; mark_started to untracked lease", () => {
  const cfg = defaultConfig();
  cfg.pools = { heavy: { capacity: 2 } };
  const { m, advance } = mk(cfg);
  const a = grant(m, A, "op1");
  m.startJob(a.permitToken!, 4242, 4242, "100");
  assert.equal(m.entryById(a.requestId).phase, "running_tracked");
  // tracked permits have no automatic deadline at all
  advance(10 * 60_000);
  m.tick(m.now());
  assert.equal(stateOf(m, a.requestId), "held", "running tracked job is never revoked on duration");

  const b = grant(m, B, "op1");
  m.markStarted(b.permitToken!);
  assert.equal(m.entryById(b.requestId).phase, "running_untracked");
  advance(14 * 60_000);
  m.heartbeat(B); // adapter heartbeat renews the lease
  advance(14 * 60_000);
  m.tick(m.now());
  assert.equal(stateOf(m, b.requestId), "held", "heartbeat renews the untracked lease");
  advance(16 * 60_000);
  m.tick(m.now());
  assert.equal(stateOf(m, b.requestId), "released", "lease expires without heartbeats");
});

test("release is idempotent; cancel paths behave", () => {
  const { m } = mk();
  const a = grant(m, A, "op1");
  // cancel a queued request
  const b = m.acquire({ agentId: B, opKey: "op1", reason: "b" });
  assert.equal(b.state, "queued");
  const c = m.cancel({ requestId: b.entry!.requestId });
  assert.equal(c.entry.state, "cancelled");
  // cancelling a held permit without admin fails
  assert.throws(() => m.cancel({ requestId: a.requestId }), (e: unknown) => e instanceof ProtocolError);
  // release: idempotent
  const r1 = m.release(a.permitToken!);
  assert.equal(r1.releasedNow, true);
  const r2 = m.release(a.permitToken!);
  assert.equal(r2.releasedNow, false);
  assert.equal(r2.entry.state, "released");
  // admin force-release works and frees capacity
  const d = grant(m, C, "op1");
  m.adminRelease(d.requestId);
  assert.equal(stateOf(m, d.requestId), "released");
});

test("weighted requests: the FIFO head blocks lighter requests behind it", () => {
  const cfg = defaultConfig();
  cfg.pools = { heavy: { capacity: 3 } };
  const { m } = mk(cfg);
  const a = grant(m, A, "op1", { weight: 2 });
  const b = m.acquire({ agentId: B, opKey: "op1", reason: "b", weight: 2 });
  const c = m.acquire({ agentId: C, opKey: "op1", reason: "c", weight: 2 });
  const bId = b.entry!.requestId, cId = c.entry!.requestId;
  assert.equal(b.state, "queued");
  assert.equal(c.state, "queued"); // weight-2 head cannot be bypassed
  m.release(a.permitToken!);
  assert.equal(stateOf(m, bId), "offered", "the heavy head is admitted first");
  assert.equal(stateOf(m, cId), "queued", "the next heavy request still does not fit");
  assert.equal(m.used("heavy"), 2);
});

test("configure: CAS versioning, capacity up admits, down never revokes", () => {
  const { m } = mk();
  const a = grant(m, A, "op1");
  const b = m.acquire({ agentId: B, opKey: "op1", reason: "b" });
  const bId = b.entry!.requestId;
  assert.equal(b.state, "queued");
  // stale expected_version -> conflict
  assert.throws(
    () => m.configure({ expectedVersion: 99, changes: {}, reason: "stale", author: "t" }),
    (e: unknown) => e instanceof ProtocolError && e.code === "version_conflict",
  );
  // capacity increase: queued request is admitted immediately
  const r = m.configure({ expectedVersion: 1, changes: { pools: { heavy: { capacity: 2 } } }, reason: "more", author: "t" });
  assert.equal(r.config.version, 2);
  assert.equal(stateOf(m, bId), "offered");
  // capacity decrease: holders keep their permits
  m.configure({ expectedVersion: 2, changes: { pools: { heavy: { capacity: 1 } } }, reason: "less", author: "t" });
  assert.equal(stateOf(m, a.requestId), "held");
  // history persisted with author + reason
  const hist = m.get_config().history;
  assert.equal(hist.length, 2);
  assert.equal(hist[1].author, "t");
  assert.equal(hist[1].reason, "less");
});

test("events: durable identities, owner filtering, token stripping", () => {
  const { m } = mk();
  const a = grant(m, A, "op1");
  m.acquire({ agentId: B, opKey: "op1", reason: "b" });
  const before = m.latestEventId();
  m.release(a.permitToken!);
  const evsB = m.eventsSince(before, B);
  const offerB = evsB.find((e) => e.type === "offered");
  assert.ok(offerB, "owner sees its own offered event");
  const evsC = m.eventsSince(before, C);
  assert.equal(evsC.find((e) => e.type === "offered"), undefined, "other agents do not see B's offered event");
  const all = m.eventsSince(before, "*");
  const offeredAll = all.filter((e) => e.type === "offered");
  assert.ok(offeredAll.every((e) => (e.entry as any).offerToken === undefined), "public event snapshots strip tokens");
  assert.ok(all.every((e) => e.id > before && e.ts > 0), "durable event identities");
  // claim tokens are attached by the daemon layer (owner-filtered pulls and
  // watch pushes) — covered by the daemon integration tests.
});

test("journal: tracked-alive kept, tracked-dead released, claimed keeps deadline, untracked fresh lease", () => {
  const cfg = defaultConfig();
  cfg.pools = { heavy: { capacity: 4 } };
  const { m, advance } = mk(cfg);
  const a = grant(m, A, "alive");
  m.startJob(a.permitToken!, 111, 111, "start-111");
  const b = grant(m, B, "dead");
  m.startJob(b.permitToken!, 222, 222, "start-222");
  const c = grant(m, C, "claimed"); // never started
  const d = grant(m, A, "untracked");
  m.markStarted(d.permitToken!);
  const journal = m.journalEntries();
  assert.equal(journal.length, 4);

  const m2 = new Machine(() => m.now(), { ...defaultConfig() });
  const res = m2.restore(journal, (e) => {
    if (e.pid === 111) return true; // alive
    if (e.pid === 222) return false; // dead
    return null; // unknown
  });
  assert.equal(res.kept, 3);
  assert.equal(res.releasedDead, 1);
  // the restored permit keeps its token: a late explicit release works
  const rel = m2.release(a.permitToken!);
  assert.equal(rel.releasedNow, true);
  // restored claimed permit keeps the original start deadline
  const before = m.now();
  m2.tick(before + 1);
  assert.equal(m2.entryById(c.requestId).state, "held");
  m2.tick(before + 200_000);
  assert.equal(m2.entryById(c.requestId).state, "released", "restored claimed permit still reclaims at its deadline");
  // restored untracked permit got a fresh lease window
  assert.equal(m2.entryById(d.requestId).phase, "running_untracked");
  assert.ok((m2.entryById(d.requestId) as any).leaseDeadline > before);
});

test("diagnose reports holder info and flags long holds without revoking", () => {
  const { m, advance } = mk();
  const a = grant(m, A, "op1");
  m.startJob(a.permitToken!, 333, 333, "start-333");
  advance(31 * 60_000);
  const diags = m.diagnose((e) => (e.pid === 333 ? true : null));
  assert.equal(diags.length, 1);
  assert.equal(diags[0].diagnostics.tracked, true);
  assert.equal(diags[0].diagnostics.processAlive, true);
  assert.equal(diags[0].diagnostics.longHold, true);
  assert.equal(stateOf(m, a.requestId), "held", "long hold alone never revokes a running job");
  assert.ok(diags[0].diagnostics.note.includes("pid 333"));
});

// ------------------------------------------------------- labelPrefix (issue #29)

test("labelPrefix composes the holder label; agentId fallback when unlabeled", () => {
  const { m } = mk();
  const a = grant(m, A, "op1", { agentLabel: "issue-42 build", labelPrefix: "omac" });
  assert.equal(a.agentLabel, "omac:issue-42 build");
  // queued entry composes too, falling back to agentId without a label
  const b = m.acquire({ agentId: B, opKey: "op1", reason: "b", labelPrefix: "omac" });
  assert.equal(b.state, "queued");
  assert.equal(b.entry!.agentLabel, "omac:" + B);
  // status (dashboard data source) shows the composed labels
  const st = m.status();
  assert.equal(st.pools[0].holders[0].agentLabel, "omac:issue-42 build");
  assert.equal(st.pools[0].queue[0].agentLabel, "omac:" + B);
  // events and journal carry the composed label (restart reconciliation)
  assert.equal(m.eventsSince(0)[1].entry!.agentLabel, "omac:issue-42 build");
  assert.equal(m.journalEntries()[0].agentLabel, "omac:issue-42 build");
  // no prefix: unchanged behavior
  const c = m.acquire({ agentId: C, opKey: "op1", reason: "c", agentLabel: "plain" });
  assert.equal(c.entry!.agentLabel, "plain");
});

test("labelPrefix is trimmed and must be non-empty when present", () => {
  const { m } = mk();
  const a = grant(m, A, "op1", { agentLabel: "build", labelPrefix: " omac " });
  assert.equal(a.agentLabel, "omac:build");
  assert.throws(
    () => m.acquire({ agentId: A, opKey: "op2", reason: "r", labelPrefix: "  " }),
    (e: unknown) => e instanceof ProtocolError && e.code === "invalid",
  );
  assert.throws(
    () => m.acquire({ agentId: A, opKey: "op3", reason: "r", labelPrefix: "" }),
    (e: unknown) => e instanceof ProtocolError && e.code === "invalid",
  );
});
