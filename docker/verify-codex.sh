#!/bin/bash
# load-lock x Codex CLI live verification (runs INSIDE the container).
#
# `codex exec` (0.163.0) connects to MCP servers but never injects their
# tools into the model's tool catalog (openai/codex#38689 — verified
# headlessly in this image: connection + handshake succeed, model reports
# the tools missing even with mcp_optional_startup_grace_ms=0,
# mcp_servers.load-lock.required=true and startup_timeout_sec=20).
# Interactive codex DOES register MCP tools, so the full loop is driven
# through a real TUI session with docker/codex-pty.py:
#
#   1. policy brief visible to the model (SessionStart hook)
#   2. MCP tools registered and callable in the TUI (mcp__load-lock__*)
#   3. acquire -> queued (a competing holder owns the only permit)
#   4. light work while queued (shell sleep)
#   5. holder releases the moment the model queues (event-driven), so a
#      cwd-matching offer exists when the model's turn ends
#   6. Stop hook decision-blocks with the claim instruction (idle wakeup)
#   7. model claims + releases; capacity ends clean
#
# Exit 0 = all assertions passed.
set -eu

export LOAD_LOCK_STATE_DIR=/tmp/ll-state
export LOAD_LOCK_SOCKET=/tmp/ll-state/daemon.sock
mkdir -p "$LOAD_LOCK_STATE_DIR"
cd /workspace

note() { printf '\n===== %s =====\n' "$*"; }

permit_of() { node -e 'process.stdout.write((JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).entry||{}).permitToken ?? "")' "$1"; }
state_of() { node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).state ?? "")' "$1"; }

# Strip ANSI escapes / control chars from a raw pty log, then join wrapped
# lines so word-wrapped phrases still grep cleanly.
clean_log() { perl -pe 's/\e\[[0-9;?]*[a-zA-Z]//g; s/\e\][^\e\x07]*(?:\e\\|\x07)?//g; s/[\x00-\x08\x0b-\x1f]//g' "$1" | tr '\n' ' '; }

note "doctor"
load-lock service stop >/dev/null 2>&1 || true
rm -rf "$LOAD_LOCK_STATE_DIR"
mkdir -p "$LOAD_LOCK_STATE_DIR"
load-lock doctor
load-lock service start

# The codex Stop-hook wakeup needs a full model turn restart (async hooks
# cannot wake an idle codex session — documented limitation), so the model
# claims its offer well after it was made. Real-model turn latency routinely
# exceeds the default 30s claim window; widen it for this verification run
# (documented knob; the queued->offered->claim->release semantics are
# unchanged and still fully exercised).
load-lock configure --offer-timeout-ms 180000 \
  --reason "verification container: codex Stop-hook wakeup costs a full model turn; default 30s claim window is too tight for real-model latency"

# ----------------------------------------------------------------- step 1
# Short interactive probe: boot the TUI, send a trivial prompt, confirm the
# model answers and detect the per-turn completion marker the TUI renders
# ("Worked for Ns • 10:38 AM" in codex 0.163.0's inline TUI). The scenario
# driver expectations are built from this.
note "pty probe (TUI boot + completion-marker detection)"
# The probe asks for "stressed" reversed -> "desserts": the echoed prompt
# contains "stressed" but never "desserts", so a grep for the reply word
# cannot be satisfied by the echo of the prompt itself.
cat > /workspace/pty-probe-driver.txt <<'EOF'
sleep 15
raw \r
mark
send Reply with the word "stressed" reversed, as a single word and nothing else.
expect Worked for
send /quit
wait-exit
EOF
set +e
PTY_EXPECT_TIMEOUT=360 /usr/local/bin/codex-pty.py /workspace/pty-probe.log /workspace/pty-probe-driver.txt -- --no-alt-screen --dangerously-bypass-hook-trust
PROBE_RC=$?
set -e
clean_log /workspace/pty-probe.log > /workspace/pty-probe.clean.txt
note "probe exit code: $PROBE_RC"
if [ "$PROBE_RC" -ne 0 ]; then
  echo "probe log tail:"
  tail -c 3000 /workspace/pty-probe.clean.txt
  exit 66
fi
grep -q "desserts" /workspace/pty-probe.clean.txt \
  || { echo "FAIL: probe model never replied with the expected word (TUI blocked on a dialog?)"; tail -c 3000 /workspace/pty-probe.clean.txt; exit 66; }
if grep -q "Worked for" /workspace/pty-probe.clean.txt; then
  TURN_END="Worked for"
else
  echo "FAIL: TUI renders no per-turn completion marker ('Worked for Ns'); cannot synchronize the pty driver on turns"
  tail -c 3000 /workspace/pty-probe.clean.txt
  exit 66
fi

# ----------------------------------------------------------------- step 2
# Contention scenario: a CLI holder owns the permit; the model's acquire
# queues. The holder is released the moment the model's request appears in
# the queue (event-driven), so by the time the model ends its turn a
# cwd-matching offer exists and the Stop hook must decision-block with the
# claim instruction.
note "starting competing holder (released once the model queues)"
load-lock acquire --json --op-key holder/roundtrip --reason "holder: competing build" --label "cli-holder" \
  > /tmp/holder.json
[ "$(state_of /tmp/holder.json)" = "granted" ] || { echo "FAIL: holder not granted"; exit 66; }
H1=$(permit_of /tmp/holder.json)

(
  for _ in $(seq 1 900); do
    load-lock status --json 2>/dev/null | grep -q '"opKey": "verify/build"' && break
    sleep 1
  done
  sleep 2
  load-lock release --permit "$H1" > /tmp/holder-release.json
) &
HOLDER_REL_PID=$!
trap 'kill "$HOLDER_REL_PID" 2>/dev/null || true; load-lock release --permit "$H1" >/dev/null 2>&1 || true' EXIT

# The scenario prompt (single line: the pty driver submits it with one Enter).
SCENARIO_PROMPT="Verify the load-lock integration on this machine. Use ONLY the MCP tools named mcp__load-lock__* for load-lock actions - never the shell CLI for load-lock. Do exactly this, in order: (1) State whether your instructions include a section starting with '# load-lock: machine-wide heavy-work budget' and quote its first bullet. (2) Call the MCP tool mcp__load-lock__status and report the pool name, capacity and current usage. (3) Call the MCP tool mcp__load-lock__acquire with reason 'verify build' and op_key 'verify/build'. Report the exact state value it returns. (4) Run the shell command 'sleep 30' exactly once - that is light work while queued. (5) Finish with a one-paragraph summary of the states you observed so far; do not call any other load-lock tools before finishing. (6) If you then receive an instruction telling you that load-lock capacity is now reserved for you with an offer_token: call the load-lock claim tool with that exact offer_token, then call the load-lock release tool, and end with a final one-sentence confirmation."
export SCENARIO_PROMPT

cat > /workspace/codex-driver.txt <<EOF
sleep 15
raw \r
mark
send ${SCENARIO_PROMPT}
expect ${TURN_END}
expect ${TURN_END}
sleep 10
send /quit
wait-exit
EOF

note "running codex interactive verification scenario (pty)"
set +e
PTY_EXPECT_TIMEOUT=420 /usr/local/bin/codex-pty.py /workspace/codex-transcript.log /workspace/codex-driver.txt -- --no-alt-screen --dangerously-bypass-hook-trust
PTY_RC=$?
set -e
note "pty driver exit code: $PTY_RC"
clean_log /workspace/codex-transcript.log > /workspace/codex-transcript.clean.txt

kill "$HOLDER_REL_PID" 2>/dev/null || true
wait "$HOLDER_REL_PID" 2>/dev/null || true
load-lock release --permit "$H1" > /tmp/holder-release.json || true

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
const hG = at((e) => e.type === "granted" && byOp("holder/roundtrip")(e), "no holder grant event");
at((e) => e.type === "released" && byOp("holder/roundtrip")(e), "no holder release event");

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
grep -q "load-lock" /workspace/codex-transcript.clean.txt \
  || { echo "FAIL: transcript never mentions load-lock"; exit 66; }
# Strong check: the scenario prompt only names the policy header, so the
# bullet text ("Heavy vs light: judge by expected CPU/memory/IO cost ...")
# can only appear if the SessionStart hook injected the real policy brief
# into the model's context and the model quoted it back.
grep -Eq "Heavy vs light|CPU/memory/IO" /workspace/codex-transcript.clean.txt \
  || { echo "FAIL: transcript never quotes the policy brief's first bullet (SessionStart hook did not inject context, or the model refused to quote it)"; exit 66; }

note "checking transcript for Stop-hook wakeup evidence"
# The Stop hook decision-block reason (claim instruction) is what codex
# feeds back as the continuation prompt; it must appear in the TUI log,
# or the second turn never happened. "Claim it NOW" and the offer_token
# id prefix ("off_") both come from claimInstruction() in the hook and
# never from the scenario prompt, so they prove the hook actually fired.
grep -q "Claim it NOW" /workspace/codex-transcript.clean.txt \
  || { echo "FAIL: transcript never shows the Stop-hook claim instruction"; exit 66; }
grep -q "off_" /workspace/codex-transcript.clean.txt \
  || { echo "FAIL: transcript never shows the offer_token from the Stop hook"; exit 66; }

note "capacity must be free again"
IN_USE=$(load-lock status | head -1)
echo "$IN_USE" | grep -q "0/1 in use" || { echo "FAIL: $IN_USE"; exit 66; }

echo "ALL CHECKS PASSED"
exit 0
