#!/bin/bash
# load-lock x Codex CLI live verification (runs INSIDE the container).
#
# Mirrors the opencode live-verification, adapted to Codex hook semantics:
#   1. policy brief must be visible to the model (SessionStart hook)
#   2. MCP tools registered (mcp__load-lock__*)
#   3. acquire -> queued (holder CLI process owns the only permit)
#   4. light work while queued (sleep)
#   5. Stop hook sees the cwd-matched offer after the holder releases and
#      continues the session with a claim instruction (idle wakeup)
#   6. model claims + releases; capacity ends clean
# Exit 0 = all assertions passed.
set -eu

export LOAD_LOCK_STATE_DIR=/tmp/ll-state
export LOAD_LOCK_SOCKET=/tmp/ll-state/daemon.sock
mkdir -p "$LOAD_LOCK_STATE_DIR"
cd /workspace

note() { printf '\n===== %s =====\n' "$*"; }

note "doctor"
load-lock doctor
load-lock service start

note "starting competing holder (holds the permit for 30s)"
load-lock run --reason "holder: competing build" --op-key holder/verify -- sleep 30 &
HOLDER_PID=$!

note "running codex exec verification scenario"
# sleep 1 gives the holder time to acquire first, so the model's acquire queues.
sleep 1
codex exec \
  --skip-git-repo-check \
  --dangerously-bypass-hook-trust \
  "Verify the load-lock integration on this machine. Do exactly this, in order, using ONLY the MCP tools named mcp__load-lock__* for load-lock actions - never the shell CLI for load-lock: \
(1) State whether your instructions include a section starting with '# load-lock: machine-wide heavy-work budget' and quote its first bullet. \
(2) Call the MCP tool mcp__load-lock__status and report the pool name, capacity and current usage. \
(3) Call the MCP tool mcp__load-lock__acquire with reason 'verify build' and op_key 'verify/build'. Report the exact state value (it should be 'queued' because another process holds the permit). \
(4) Run the shell command 'sleep 6'. That is light work while queued - do it once and do not sleep again. \
(5) After the sleep, finish with a one-paragraph summary of the states you observed so far. Do not call any other load-lock tools before finishing." \
  2>&1 | tee /workspace/codex-transcript.txt
CODEX_RC=${PIPESTATUS[0]}

wait "$HOLDER_PID"
note "codex exit code: $CODEX_RC"
[ "$CODEX_RC" -eq 0 ] || exit 65

note "daemon event log"
load-lock events | tee /workspace/events.json

note "final machine state"
load-lock status

# ---- assertions on the durable daemon event log ----
node --input-type=module - <<'EOF'
import { readFileSync } from "node:fs";
const txt = readFileSync("/workspace/events.json", "utf8");
const events = JSON.parse(txt).events;
const ok = (c, m) => { if (!c) { console.error("FAIL: " + m); process.exit(66); } };

const at = (pred, m) => { const e = events.find(pred); ok(e, m); return e; };
const byOp = (op) => (e) => e.entry?.opKey === op;

// holder: granted then released
const hG = at((e) => e.type === "granted" && byOp("holder/verify")(e), "no holder grant event");
at((e) => e.type === "released" && byOp("holder/verify")(e), "no holder release event");

// model agent (MCP): queued -> offered -> claimed -> released, in order
const q  = at((e) => e.type === "queued"    && byOp("verify/build")(e), "model never queued");
const of = at((e) => e.type === "offered"   && byOp("verify/build")(e), "model never offered");
const c  = at((e) => e.type === "claimed"   && byOp("verify/build")(e), "model never claimed");
const r  = at((e) => e.type === "released"  && byOp("verify/build")(e), "model never released");
ok(q.id < of.id, "queued event must precede offered");
ok(of.id < c.id, "offered event must precede claimed");
ok(c.id  < r.id, "claimed event must precede released");
ok(hG.id < q.id, "holder must have held the permit when the model queued");

console.log("PASS: holder granted@%s; model queued@%s offered@%s claimed@%s released@%s (event ids)",
  hG.id, q.id, of.id, c.id, r.id);
EOF

note "checking transcript for policy visibility"
grep -q "load-lock" /workspace/codex-transcript.txt \
  || { echo "FAIL: transcript never mentions load-lock"; exit 66; }

note "capacity must be free again"
IN_USE=$(load-lock status | head -1)
echo "$IN_USE" | grep -q "0/1 in use" || { echo "FAIL: $IN_USE"; exit 66; }

echo "ALL CHECKS PASSED"
exit 0
