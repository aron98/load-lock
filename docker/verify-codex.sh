#!/bin/bash
# load-lock x Codex CLI live verification (runs INSIDE the container).
#
# Why the interactive TUI path: `codex exec` (0.163.0) connects to MCP
# servers but never injects their tools into the model's tool catalog
# (openai/codex#38689 — verified headlessly in this image: connection +
# handshake succeed; grace/required/startup-timeout knobs and the
# mcp_2026_07_28 / non_prefixed_mcp_tool_names feature flags do not help).
#
# Interactive codex exposes MCP tools, but as Responses-API `namespace`
# tool groups ({"type":"namespace","name":"mcp__<server>","tools":[…]}).
# trustedtokens/GLM does not support the namespace tool type and silently
# drops those groups, so the model would never see mcp__load-lock__*.
# The in-container shim (docker/codex-api-shim.js, port 8788) flattens
# namespace groups to plain function tools on the request side and
# rewrites the model's flat function_call names back to
# {"name","namespace"} pairs on the SSE response side — the form codex's
# tool router natively dispatches to MCP servers (source-verified against
# codex-rs 0.163.0; full loop first proven on the host).
#
# The full loop is driven through a real interactive TUI session
# (docker/codex-pty.py), without --dangerously-bypass-hook-trust: that
# flag forces embedded mode, which never injects MCP tools. The first
# TUI boot shows the hook-trust dialog (load-lock installs user-layer
# hooks); the probe drive trusts them ("2" + Enter), mirroring the
# real-user setup, and codex persists trust in config.toml.
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

# Daemon state dir: use the DEFAULT (~/.local/state/load-lock) for every
# process in this container — CLI, hooks AND the model's MCP tools. codex
# spawns MCP server children with a scrubbed environment, so a
# LOAD_LOCK_STATE_DIR override would silently put the CLI (and this script)
# on a different daemon than the MCP tools talk to (observed live: two
# daemons, the model's acquire never saw the CLI holder's permit and the
# contention path never fired). The default path is shared by all
# processes, mirroring a real user's machine.
STATE_DIR="$(node -e 'const{join}=require("node:path"),os=require("node:os");process.stdout.write(join(process.env.XDG_STATE_HOME||join(os.homedir(),".local","state"),"load-lock"))')"
cd /workspace

note() { printf '\n===== %s =====\n' "$*"; }

permit_of() { node -e 'process.stdout.write((JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).entry||{}).permitToken ?? "")' "$1"; }
state_of() { node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).state ?? "")' "$1"; }

# Strip ANSI escapes / control chars from a raw pty log, then join wrapped
# lines so word-wrapped phrases still grep cleanly.
clean_log() { perl -pe 's/\e\[[0-9;?]*[a-zA-Z]//g; s/\e\][^\e\x07]*(?:\e\\|\x07)?//g; s/[\x00-\x08\x0b-\x1f]//g' "$1" | tr '\n' ' '; }

note "doctor"
load-lock service stop >/dev/null 2>&1 || true
rm -rf "$STATE_DIR"
mkdir -p "$STATE_DIR"
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

# ----------------------------------------------------------------- step 0
# Start the namespace-flattening API shim (see header). codex's seeded
# base_url points at 127.0.0.1:8788; upstream is api.trustedtokens.eu.
note "starting codex-api-shim (namespace tool flattening)"
rm -f /workspace/api-shim.log
SHIM_UPSTREAM_HOST=api.trustedtokens.eu SHIM_LISTEN_PORT=8788 \
  node /usr/local/bin/codex-api-shim.js >/dev/null 2>&1 &
SHIM_PID=$!
trap 'kill "$SHIM_PID" 2>/dev/null || true' EXIT
for _ in $(seq 1 50); do
  if node -e 'const net=require("net");const s=net.connect(8788,"127.0.0.1",()=>{s.end();process.exit(0)});s.on("error",()=>process.exit(1))' 2>/dev/null; then
    break
  fi
  sleep 0.2
done
node -e 'const net=require("net");const s=net.connect(8788,"127.0.0.1",()=>{s.end();process.exit(0)});s.on("error",()=>process.exit(1))' \
  || { echo "FAIL: codex-api-shim did not come up on 127.0.0.1:8788"; tail -20 /workspace/api-shim.log 2>/dev/null || true; exit 66; }

# ----------------------------------------------------------------- step 1
# Short interactive probe: boot the TUI, handle the first-boot hook-trust
# dialog (option 2 = "Trust all and continue"; codex persists the trust
# state in config.toml, so the scenario boot later needs no dialog), then
# send a trivial prompt and confirm a real model turn fired and completed.
# The interactive TUI renders no "N tokens used" marker (that is a
# `codex exec`-only line), so the driver synchronizes on the
# machine-readable OSC 7501 state protocol the TUI emits:
# ESC ]7501;state=working:app=codex on turn start, state=idle on
# completion (verified on codex 0.163.0 host runs). rawexpect scans the
# raw byte stream because the ANSI cleaner strips OSC sequences.
note "pty probe (TUI boot + hook trust + OSC-7501 turn-marker detection)"
# The probe asks for "stressed" reversed -> "desserts": the echoed prompt
# contains "stressed" but never "desserts", so a grep for the reply word
# cannot be satisfied by the echo of the prompt itself.
cat > /workspace/pty-probe-driver.txt <<'EOF'
sleep 15
# First boot shows the hooks-trust dialog (load-lock installs user-layer
# SessionStart/SubagentStart/Stop hooks): "2" = Trust all and continue.
send 2
sleep 3
# Defensive: clear any stray input (if the dialog did not appear, the "2"
# landed in the prompt box instead) and dismiss the boot screen.
raw \x15
raw \r
sleep 2
mark
send Reply with the word "stressed" reversed, as a single word and nothing else.
rawexpect \x1b]7501;state=working:app=codex
rawexpect \x1b]7501;state=idle:app=codex
send /quit
wait-exit
EOF
set +e
/usr/local/bin/codex-pty.py /workspace/pty-probe.log /workspace/pty-probe-driver.txt -- --no-alt-screen
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
  || { echo "FAIL: probe model never replied with the expected word (turn markers fired but no reply text)"; tail -c 3000 /workspace/pty-probe.clean.txt; exit 66; }

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
# The CLI holder runs no tracked process, so acknowledge its start
# explicitly: without this the daemon's start-deadline sweep reclaims the
# permit after startTimeoutMs (120s in this container) if the model takes
# longer than that to queue (observed in run 2). The untracked lease
# (900s) covers the whole scenario.
load-lock mark-started --permit "$H1" >/dev/null

(
  for _ in $(seq 1 900); do
    load-lock status --json 2>/dev/null | grep -q '"opKey": "verify/build"' && break
    sleep 1
  done
  sleep 2
  load-lock release --permit "$H1" > /tmp/holder-release.json
) &
HOLDER_REL_PID=$!
trap 'kill "$HOLDER_REL_PID" 2>/dev/null || true; load-lock release --permit "$H1" >/dev/null 2>&1 || true; kill "$SHIM_PID" 2>/dev/null || true' EXIT

# The scenario prompt (single line: the pty driver submits it with one Enter).
SCENARIO_PROMPT="Verify the load-lock integration on this machine. Use ONLY the MCP tools named mcp__load-lock__* for load-lock actions - never the shell CLI for load-lock. Do exactly this, in order: (1) State whether your instructions include a section starting with '# load-lock: machine-wide heavy-work budget' and quote its first bullet. (2) Call the MCP tool mcp__load-lock__status and report the pool name, capacity and current usage. (3) Call the MCP tool mcp__load-lock__acquire with reason 'verify build' and op_key 'verify/build'. Report the exact state value it returns. (4) Run the shell command 'sleep 30' exactly once - that is light work while queued. (5) Finish with a one-paragraph summary of the states you observed so far; do not call any other load-lock tools before finishing. (6) If you then receive an instruction telling you that load-lock capacity is now reserved for you with an offer_token: call the load-lock claim tool with that exact offer_token, then call the load-lock release tool, and end with a final one-sentence confirmation."
export SCENARIO_PROMPT

# Turn synchronization: turn 1 = policy quote + MCP status + MCP acquire
# (queued) + `sleep 30` light work + summary; then the Stop hook fires and
# codex auto-continues the session (turn 2 = claim + release). Each turn is
# bracketed by the TUI's OSC 7501 state=working / state=idle markers.
cat > /workspace/codex-driver.txt <<EOF
sleep 15
raw \r
sleep 5
mark
send ${SCENARIO_PROMPT}
rawexpect \x1b]7501;state=working:app=codex
rawexpect \x1b]7501;state=idle:app=codex
rawexpect \x1b]7501;state=working:app=codex
rawexpect \x1b]7501;state=idle:app=codex
sleep 10
send /quit
wait-exit
EOF

note "running codex interactive verification scenario (pty)"
set +e
# 300s per-expectation ceiling: turn 1 includes a real 30s shell sleep plus
# several MCP round-trips; turn 2 is the Stop-hook continuation.
# Hooks were trusted in the probe boot, so this boot shows no dialog.
PTY_EXPECT_TIMEOUT=300 /usr/local/bin/codex-pty.py /workspace/codex-transcript.log /workspace/codex-driver.txt -- --no-alt-screen
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
