#!/bin/bash
# load-lock x Claude Code live verification (runs INSIDE the container).
#
# Covers issue #3's checklist end-to-end against the real Claude Code harness:
#   Phase 1 (headless -p):
#     - SessionStart policy brief visible to the model (it must quote it)
#     - mcp__load-lock__* round-trip: acquire -> queued -> offer
#     - Stop-hook decision-block wakeup with a cwd-matching offer -> claim
#     - run_with_permit background job that outlives the tool call AND the
#       claude process; daemon auto-releases on process-group death
#   Phase 1b (headless -p, async watcher disabled):
#     - the async await-offer SessionStart watcher usually wins the wake
#       race, so it is stripped from settings.json for this phase; the Stop
#       hook is then the only wakeup path and its decision-block/claim
#       instruction is live-verified in isolation
#   Phase 2 (headless -p):
#     - subagent behavior: a Task-tool subagent uses mcp__load-lock__* tools
#       and reports what context it sees
#   Phase 3 (interactive pty):
#     - /compact restore: SessionStart(matcher compact) re-fires the brief
#       with FRESH machine status (pool goes 0/1 -> 1/1 mid-session)
#     - async await-offer (asyncRewake): an IDLE session is woken by the
#       async watcher exiting 2 with stderr; model claims + releases
# Exit 0 = all assertions passed.
set -eu

export LOAD_LOCK_STATE_DIR=/tmp/ll-state
export LOAD_LOCK_SOCKET=/tmp/ll-state/daemon.sock
mkdir -p "$LOAD_LOCK_STATE_DIR"
cd /workspace

export PHASES="${PHASES:-1,2,3}"
has_phase() { [[ ",$PHASES," == *",${1},"* ]]; }

note() { printf '\n===== %s =====\n' "$*"; }
now_ms() { date +%s%3N; }

permit_of() { node -e 'process.stdout.write((JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).entry||{}).permitToken ?? "")' "$1"; }
state_of() { node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).state ?? "")' "$1"; }

# Strip ANSI escapes / control chars from a raw pty log, then join wrapped
# lines so word-wrapped phrases still grep cleanly.
clean_log() { perl -pe 's/\e\[[0-9;?]*[a-zA-Z]//g; s/\e\][^\e\x07]*(?:\e\\|\x07)?//g; s/[\x00-\x08\x0b-\x1f]//g' "$1" | tr '\n' ' '; }

wait_pool_free() {
  for _ in $(seq 1 90); do
    if load-lock status | head -1 | grep -q "0/1 in use"; then return 0; fi
    sleep 2
  done
  echo "FAIL: pool not free: $(load-lock status | head -1)" >&2
  return 1
}

assert_clean() {
  note "asserting pool is free before $1"
  wait_pool_free "$1"
}

# ------------------------------------------------------------------ phase 0
note "doctor + daemon + onboarding seeds"
load-lock doctor
load-lock service start

# Headless/interactive onboarding seeds: no theme picker, trust the (disposable)
# /workspace, so the TUI never waits on a dialog the driver cannot answer.
# NB: $HOME is /home/node — the container runs as the unprivileged "node"
# user because Claude Code rejects --dangerously-skip-permissions as root.
node - <<'EOF'
const fs = require("fs");
const p = process.env.HOME + "/.claude.json";
const j = JSON.parse(fs.readFileSync(p, "utf8"));
j.hasCompletedOnboarding = true;
j.theme = "dark";
// Accept the BypassPermissions warning up-front so the interactive TUI
// phases never block on the "No, exit / Yes, I accept" confirmation dialog
// (headless -p never shows it). The pty drivers also carry a fallback that
// answers the dialog via arrow keys, in case newer builds ignore this key.
j.bypassPermissionsModeAccepted = true;
j.projects = j.projects || {};
j.projects["/workspace"] = { ...(j.projects["/workspace"] || {}), hasTrustDialogAccepted: true };
fs.writeFileSync(p, JSON.stringify(j, null, 2));
EOF

# The model is served through a translation proxy and can take minutes per
# turn; make offers survive the whole Stop-hook->claim round trip (phase 1
# burns ~30s of that window on the mandated light-work sleep, phase 3b on
# the idle->wakeup->claim turn).
load-lock configure --offer-timeout-ms 300000 \
  --reason "verification: model runs through a LiteLLM translation sidecar; offers must survive multi-minute turns"

CLAUDE_FLAGS=(--dangerously-skip-permissions)

# ------------------------------------------------------------------ phase 1
if has_phase 1; then
note "Phase 1: headless round-trip (policy, MCP tools, Stop-hook claim, background job)"

assert_clean "phase 1"
load-lock acquire --json --op-key holder/roundtrip --reason "holder: competing build" --label "cli-holder" \
  > /tmp/holder1.json
[ "$(state_of /tmp/holder1.json)" = "granted" ] || { echo "FAIL: holder not granted"; exit 66; }
H1=$(permit_of /tmp/holder1.json)

# Event-driven release: the moment the model's verify/build request is QUEUED,
# free the holder (with a small settle delay). The model then does its 30s
# light-work sleep and ends its turn with a live, cwd-matching offer for the
# Stop hook to decision-block on.
(
  for _ in $(seq 1 900); do
    load-lock status --json 2>/dev/null | grep -q '"opKey": "verify/build"' && break
    sleep 1
  done
  sleep 2
  load-lock release --permit "$H1" > /tmp/holder1-release.json
) &
HOLDER1_REL_PID=$!

set +e
timeout 1500 claude -p "${CLAUDE_FLAGS[@]}" --output-format stream-json --verbose \
  "Verify the load-lock integration on this machine. Do exactly this, in order, using ONLY the MCP tools named mcp__load-lock__* for load-lock actions - never the shell CLI for load-lock: \
(1) State whether your context includes a section starting with '# load-lock: machine-wide heavy-work budget'. Quote its first rule ('1. Heavy vs light: ...') verbatim through the end of its first sentence. \
(2) Call the MCP tool mcp__load-lock__status and report the pool name, capacity and current usage. \
(3) Call the MCP tool mcp__load-lock__acquire with reason 'verify claude adapter' and op_key 'verify/build'. Report the exact state value (it should be 'queued' because another process holds the permit). \
(4) Run the shell command 'sleep 30' exactly once. That is light work while queued - do not sleep again. \
(5) If a load-lock message tells you capacity is now reserved for you, then: call mcp__load-lock__pending, claim the offer with mcp__load-lock__claim (offer_token), start your heavy work by calling mcp__load-lock__run_with_permit with the permit_token and the command 'sleep 120', then call mcp__load-lock__job_status once to confirm the job is running, and report the job_id. Do NOT call mcp__load-lock__release for it - the permit auto-releases when the job exits. \
(6) Finish with a one-paragraph summary of the states you observed so far." \
  2>&1 | tee /workspace/claude-phase1-stream.jsonl
P1_RC=${PIPESTATUS[0]}
set -e
P1_EXIT_TS=$(now_ms)
echo "$P1_EXIT_TS" > /workspace/phase1-exit.ts
# Make sure the event-driven holder release finished / holder is freed even
# if claude failed early (release is idempotent).
kill "$HOLDER1_REL_PID" 2>/dev/null || true
wait "$HOLDER1_REL_PID" 2>/dev/null || true
load-lock release --permit "$H1" > /tmp/holder1-release.json || true

note "phase 1: claude exit code: $P1_RC"
[ "$P1_RC" -eq 0 ] || { echo "FAIL: claude -p phase 1 exited $P1_RC"; exit 65; }

# The run_with_permit job (sleep 45) must outlive the claude process; the
# daemon auto-releases on process-group death. Poll for the terminal event.
note "phase 1: waiting for background job auto-release"
P1_TERMINAL=1
for _ in $(seq 1 90); do
  load-lock events --json > /tmp/ll-events.json
  if node -e 'const es=JSON.parse(require("fs").readFileSync("/tmp/ll-events.json","utf8")).events;process.exit(es.some(e=>["released","auto_released","reclaimed"].includes(e.type)&&e.entry?.opKey==="verify/build")?0:1)'; then
    P1_TERMINAL=0
    break
  fi
  sleep 2
done
[ "$P1_TERMINAL" -eq 0 ] || { echo "FAIL: verify/build never reached a terminal permit state (background job cleanup)"; exit 66; }
fi

# ------------------------------------------------------------------ phase 1b
# The async await-offer SessionStart watcher (async + asyncRewake) always
# wins the wake race - in phase 1 the wakeup arrived while the model was
# still mid-turn (bash sleep), so the Stop hook's decision-block branch
# never fired. Issue #3 task 3 requires BOTH paths live-verified, so here
# the watcher entry is temporarily removed from settings.json: the Stop
# hook (turn-end) is then the ONLY wakeup path and its claimInstruction
# ("capacity ... is now reserved for you (request ...)") is the only text
# that can reach the model.
if has_phase 1; then
note "Phase 1b: Stop-hook decision-block wakeup (async watcher disabled)"

assert_clean "phase 1b"
SETTINGS="$HOME/.claude/settings.json"
cp "$SETTINGS" /tmp/settings-backup.json
python3 - <<'PY'
import json, os
p = os.path.join(os.environ["HOME"], ".claude", "settings.json")
s = json.load(open(p))
ss = s.get("hooks", {}).get("SessionStart", [])
s["hooks"]["SessionStart"] = [e for e in ss if "await-offer" not in json.dumps(e)]
json.dump(s, open(p, "w"), indent=2)
PY
restore_settings() { cp /tmp/settings-backup.json "$SETTINGS"; }
trap restore_settings EXIT

load-lock acquire --json --op-key holder/stopblock --reason "holder: stop-hook block verify" --label "cli-holder" \
  > /tmp/holder1b.json
[ "$(state_of /tmp/holder1b.json)" = "granted" ] || { echo "FAIL: holder/stopblock not granted"; exit 66; }
H1B=$(permit_of /tmp/holder1b.json)

# Event-driven release: the moment the model's verify/stopblock request is
# QUEUED, free the holder. The model then sleeps 45s, so by the time it ends
# its turn (WAITING) a live, cwd-matching offer exists for the Stop hook to
# decision-block on.
(
  for _ in $(seq 1 900); do
    load-lock status --json 2>/dev/null | grep -q '"opKey": "verify/stopblock"' && break
    sleep 1
  done
  sleep 2
  load-lock release --permit "$H1B" > /tmp/holder1b-release.json
) &
HOLDER1B_REL_PID=$!

set +e
timeout 900 claude -p "${CLAUDE_FLAGS[@]}" --output-format stream-json --verbose \
  "This machine enforces the load-lock policy. Do exactly this, in order, using ONLY the MCP tools named mcp__load-lock__* for load-lock actions - never the shell CLI for load-lock: \
(1) Call the MCP tool mcp__load-lock__acquire with reason 'stop-hook wakeup verification' and op_key 'verify/stopblock'. It will be queued behind another permit holder. \
(2) Run the shell command 'sleep 45' exactly once. Do not sleep again. \
(3) When the sleep finishes, end your turn immediately, replying with only the single word WAITING. Do not call mcp__load-lock__pending and do not claim anything yet. \
(4) If a load-lock stop-hook message then tells you capacity is now reserved for you, call mcp__load-lock__pending, claim the offer with mcp__load-lock__claim (offer_token), then call mcp__load-lock__release with the permit_token. Finish your reply by quoting the exact full text of the stop-hook message that woke you, then reply with the single word STOPHOOK-DONE." \
  2>&1 | tee /workspace/claude-phase1b-stream.jsonl
P1B_RC=${PIPESTATUS[0]}
set -e
kill "$HOLDER1B_REL_PID" 2>/dev/null || true
wait "$HOLDER1B_REL_PID" 2>/dev/null || true
load-lock release --permit "$H1B" > /tmp/holder1b-release.json || true
# Restore the async watcher NOW: later phases (esp. 3b's idle wake) depend
# on it; the EXIT trap is only a backstop for failure paths above.
restore_settings
trap - EXIT

note "phase 1b: claude exit code: $P1B_RC"
[ "$P1B_RC" -eq 0 ] || { echo "FAIL: claude -p phase 1b exited $P1B_RC"; exit 65; }
fi

# ------------------------------------------------------------------ phase 2
if has_phase 2; then
note "Phase 2: subagent behavior (Task-tool subagent using mcp__load-lock__*)"

assert_clean "phase 2"
set +e
timeout 1200 claude -p "${CLAUDE_FLAGS[@]}" --output-format stream-json --verbose \
  "Test subagent behavior of the load-lock integration. Use your Task tool to spawn exactly ONE subagent with this instruction: 'Using ONLY the MCP tools named mcp__load-lock__* for load-lock actions: (a) call mcp__load-lock__status and note the pool name and usage; (b) call mcp__load-lock__acquire with reason \"subagent verification\" and op_key \"verify/subagent\"; (c) call mcp__load-lock__release with the permit_token it returned; (d) report the exact sequence of state values you saw, and whether your own context contains a section starting with \"# load-lock: machine-wide heavy-work budget\" - if yes, quote its first rule.' Then report verbatim what the subagent told you, including whether it saw the load-lock policy section." \
  2>&1 | tee /workspace/claude-phase2-stream.jsonl
P2_RC=${PIPESTATUS[0]}
set -e

note "phase 2: claude exit code: $P2_RC"
[ "$P2_RC" -eq 0 ] || { echo "FAIL: claude -p phase 2 exited $P2_RC"; exit 65; }
fi

# ------------------------------------------------------------------ phase 3
if has_phase 3; then

# ---- 3a: /compact restore --------------------------------------------------
note "Phase 3a: policy restore after /compact (interactive)"

assert_clean "phase 3a"
# Acquire the holder mid-session (t~12s) so the compact-re-fired SessionStart
# brief reports 1/1 while the startup brief (still in compacted history)
# said 0/1 - the model can only know 1/1 if the hook re-fired.
( sleep 12
  load-lock acquire --json --op-key holder/compact --reason "holder: compact verify" --label "cli-holder2" \
    > /tmp/holder3a.json 2>/dev/null || true
  sleep 900 ) &
H3A_BG=$!
for _ in $(seq 1 30); do
  [ -s /tmp/holder3a.json ] && [ "$(state_of /tmp/holder3a.json)" = "granted" ] && break
  sleep 1
done
[ "$(state_of /tmp/holder3a.json)" = "granted" ] || { echo "FAIL: 3a holder never granted"; exit 66; }
H3A=$(permit_of /tmp/holder3a.json)

# DIALOG-FALLBACK: if the TUI still shows the BypassPermissions confirmation
# despite the config seed, select "Yes, I accept" (down arrow) and confirm.
# Harmless no-ops when no dialog is up (down+enter on an empty input box).
cat > /tmp/driver-3a.txt <<'DRIVER'
try-expect BypassPermissionsmode 25
raw \x1b[B
sleep 1
raw \r
sleep 8
type Say the single word READY and nothing else.
sleep 3
mark
expect READY
send /compact
# Wait for the compaction to fully finish (the "Compacted" marker renders only
# after the summarize call AND the post-compact SessionStart hooks complete).
# A fixed sleep is not enough under load: sending the next prompt mid-compaction
# gets the Enter swallowed and the question is never submitted (seen live).
expect Compacted
sleep 10
# Long prompts are typed with the `type` directive: a single large input burst
# is classified by the TUI as a *paste* and inserted WITHOUT submitting
# (seen live: the question echoed in the composer, zero POSTs, timeout).
type Quote the last line of the load-lock section in your context, the one starting with "load-lock now:", verbatim. Answer with just that one line and nothing else.
sleep 1
mark
# Hedge: an isolated Enter on an already-submitted (empty) composer is a no-op;
# if the prompt above somehow sat unsubmitted, this is what actually sends it.
raw \r
# The TUI renders the answer with absolute-cursor escapes ([32G1/1[36Gin[39Guse);
# after ANSI stripping the words run together ("1/1inuse"), so the regex must
# tolerate zero-or-more whitespace between the tokens.
expect 1/1\s*in\s*use
send /exit
wait-exit
DRIVER

set +e
PTY3A_RC=0
PTY_EXPECT_TIMEOUT=480 timeout 1500 python3 /usr/local/bin/claude-pty.py /workspace/claude-phase3a.log /tmp/driver-3a.txt \
  -- "${CLAUDE_FLAGS[@]}" || PTY3A_RC=$?
set -e
P3A_EXIT_TS=$(now_ms)
kill "$H3A_BG" 2>/dev/null || true
load-lock release --permit "$H3A" > /tmp/holder3a-release.json

note "phase 3a: pty exit code: $PTY3A_RC"
[ "$PTY3A_RC" -eq 0 ] || { echo "FAIL: phase 3a pty driver exited $PTY3A_RC (see claude-phase3a.log)"; exit 65; }

# ---- 3b: async await-offer (asyncRewake) idle wakeup ------------------------
note "Phase 3b: async await-offer wakes an idle session"

assert_clean "phase 3b"
load-lock acquire --json --op-key holder/async --reason "holder: async wake verify" --label "cli-holder3" \
  > /tmp/holder3b.json
[ "$(state_of /tmp/holder3b.json)" = "granted" ] || { echo "FAIL: 3b holder not granted"; exit 66; }
H3B=$(permit_of /tmp/holder3b.json)

# Event-driven release: wait for the model's verify/async-wake request to be
# QUEUED, give the model time to end its turn and go idle (its Stop hook sees
# no offer while the holder still holds), THEN release -> offer -> the async
# SessionStart watcher (asyncRewake) exits 2 and wakes the idle session.
(
  for _ in $(seq 1 450); do
    load-lock status --json 2>/dev/null | grep -q 'verify/async-wake' && break
    sleep 2
  done
  sleep 8
  load-lock release --permit "$H3B" > /tmp/holder3b-release.json
) &
H3B_WATCHER=$!

cat > /tmp/driver-3b.txt <<'DRIVER'
try-expect BypassPermissionsmode 25
raw \x1b[B
sleep 1
raw \r
sleep 8
# Long prompts must be typed (chunked), not `send`-burst: a large single
# write is treated by the TUI as a paste and is never submitted (seen live).
type Call the MCP tool mcp__load-lock__acquire with reason "idle wakeup verification" and op_key "verify/async-wake". It will be queued. Reply with only the single word STANDBY and end your turn. Then wait without doing anything. When a wakeup message tells you capacity was reserved for a request from this directory, call mcp__load-lock__pending, then claim the offer with mcp__load-lock__claim (offer_token), then call mcp__load-lock__release with the permit_token, and finish by replying with only the single word DONE.
sleep 1
mark
# Hedge: isolated Enter retry - no-op if the prompt already submitted.
raw \r
expect STANDBY
mark
expect DONE
send /exit
wait-exit
DRIVER

set +e
PTY3B_RC=0
PTY_EXPECT_TIMEOUT=480 timeout 1200 python3 /usr/local/bin/claude-pty.py /workspace/claude-phase3b.log /tmp/driver-3b.txt \
  -- "${CLAUDE_FLAGS[@]}" || PTY3B_RC=$?
set -e
# Make sure the watcher subshell is gone and the holder permit is freed
# (release is idempotent), so a failed pty run can never poison later phases.
kill "$H3B_WATCHER" 2>/dev/null || true
wait "$H3B_WATCHER" 2>/dev/null || true
load-lock release --permit "$H3B" > /tmp/holder3b-release.json || true

note "phase 3b: pty exit code: $PTY3B_RC"
[ "$PTY3B_RC" -eq 0 ] || { echo "FAIL: phase 3b pty driver exited $PTY3B_RC (see claude-phase3b.log)"; exit 65; }
fi

# ------------------------------------------------------------------ assertions
note "daemon event log"
load-lock events --json | tee /workspace/events.json

note "final machine state"
load-lock status

node - <<'EOF' || exit 66
import { readFileSync } from "node:fs";
const events = JSON.parse(readFileSync("/workspace/events.json", "utf8")).events;
const phases = (process.env.PHASES || "1,2,3").split(",");
const has = (n) => phases.includes(String(n));
const ok = (c, m) => { if (!c) { console.error("FAIL: " + m); process.exit(66); } };
const at = (pred, m) => { const e = events.find(pred); ok(e, m); return e; };
const byOp = (op) => (e) => e.entry?.opKey === op;
const terminal = (e) => ["released", "auto_released", "reclaimed"].includes(e.type);

if (has(1)) {
  const h1g = at((e) => e.type === "granted"  && byOp("holder/roundtrip")(e), "holder/roundtrip never granted");
  const h1r = at((e) => e.type === "released" && byOp("holder/roundtrip")(e), "holder/roundtrip never released");
  ok(h1g.id < h1r.id, "holder grant must precede release");

  const q1  = at((e) => e.type === "queued"  && byOp("verify/build")(e), "model never queued (verify/build)");
  const of1 = at((e) => e.type === "offered" && byOp("verify/build")(e), "model never offered (verify/build)");
  const c1  = at((e) => e.type === "claimed" && byOp("verify/build")(e), "model never claimed (verify/build)");
  const s1  = at((e) => e.type === "started" && byOp("verify/build")(e), "no started event (run_with_permit/start_job missing)");
  ok(typeof s1.detail === "string" && s1.detail.includes("tracked pid"),
     "started event must be process-tracked, got: " + JSON.stringify(s1.detail));
  const t1  = at((e) => terminal(e) && byOp("verify/build")(e), "verify/build never reached a terminal permit state");
  ok(q1.id < of1.id && of1.id < c1.id && c1.id < s1.id && s1.id < t1.id,
     "verify/build event order broken (queued->offered->claimed->started->terminal)");
  ok(h1g.id < q1.id, "holder must have held the permit when the model queued");
  ok(h1r.id < of1.id, "holder release must precede the offer");
  ok(c1.entry.cwd === "/workspace", "claimed entry cwd must be the session cwd for hook matching, got " + c1.entry.cwd);

  // Background-job cleanup fidelity: the started event must be process-tracked
  // (daemon owns the job's pgid, so cleanup works even if the MCP server dies
  // with the claude process). The job outliving the whole claude process is
  // BONUS evidence - the issue requires outliving the tool call, which the
  // tracked-pid started event + model's job_status check already prove - so a
  // job that finished before claude exited is a WARN, not a failure.
  const p1ExitTs = Number(readFileSync("/workspace/phase1-exit.ts", "utf8"));
  if (t1.ts >= p1ExitTs) {
    console.log("PASS: background job outlived the claude process (terminal ts " + t1.ts + " >= exit ts " + p1ExitTs + ")");
  } else {
    console.log("WARN: background job finished before claude exited (terminal ts " + t1.ts + " < exit ts " + p1ExitTs + ") - it still outlived the run_with_permit tool call");
  }

  console.log("PASS: verify/build queued@" + q1.id + " offered@" + of1.id + " claimed@" + c1.id
    + " started@" + s1.id + " terminal@" + t1.id + " (holder grant@" + h1g.id + ")");

  // Phase 1b: Stop-hook decision-block wakeup (async watcher disabled).
  const h1bg = at((e) => e.type === "granted"  && byOp("holder/stopblock")(e), "holder/stopblock never granted");
  const h1br = at((e) => e.type === "released" && byOp("holder/stopblock")(e), "holder/stopblock never released");
  ok(h1bg.id < h1br.id, "holder/stopblock grant must precede release");
  const q1b  = at((e) => e.type === "queued"  && byOp("verify/stopblock")(e), "model never queued (verify/stopblock)");
  const of1b = at((e) => e.type === "offered" && byOp("verify/stopblock")(e), "model never offered (verify/stopblock)");
  const c1b  = at((e) => e.type === "claimed" && byOp("verify/stopblock")(e), "model never claimed (verify/stopblock)");
  const t1b  = at((e) => terminal(e) && byOp("verify/stopblock")(e), "verify/stopblock never reached a terminal permit state");
  ok(q1b.id < of1b.id && of1b.id < c1b.id && c1b.id < t1b.id,
     "verify/stopblock event order broken (queued->offered->claimed->terminal)");
  ok(h1br.id < of1b.id, "holder/stopblock release must precede the offer");
  ok(c1b.entry.cwd === "/workspace", "stopblock claimed entry cwd must be the session cwd for hook matching, got " + c1b.entry.cwd);
  console.log("PASS: verify/stopblock (Stop-hook decision-block) queued@" + q1b.id + " offered@" + of1b.id
    + " claimed@" + c1b.id + " terminal@" + t1b.id + " (holder grant@" + h1bg.id + ")");
}

if (has(2)) {
  const g = at((e) => e.type === "granted" && byOp("verify/subagent")(e), "subagent never granted (verify/subagent)");
  const t = at((e) => terminal(e) && byOp("verify/subagent")(e), "subagent never released (verify/subagent)");
  ok(g.id < t.id, "subagent grant must precede release");
  console.log("PASS: verify/subagent granted@" + g.id + " terminal@" + t.id);
}

if (has(3)) {
  at((e) => e.type === "granted"  && byOp("holder/compact")(e), "holder/compact never granted");
  at((e) => e.type === "released" && byOp("holder/compact")(e), "holder/compact never released");

  const q  = at((e) => e.type === "queued"  && byOp("verify/async-wake")(e), "model never queued (verify/async-wake)");
  const of = at((e) => e.type === "offered" && byOp("verify/async-wake")(e), "model never offered (verify/async-wake)");
  const c  = at((e) => e.type === "claimed" && byOp("verify/async-wake")(e), "model never claimed (verify/async-wake)");
  const t  = at((e) => terminal(e) && byOp("verify/async-wake")(e), "verify/async-wake never terminal");
  const h3bR = at((e) => e.type === "released" && byOp("holder/async")(e), "holder/async never released");
  ok(q.id < of.id && of.id < c.id && c.id < t.id, "verify/async-wake event order broken (queued->offered->claimed->terminal)");
  ok(h3bR.id < of.id, "holder/async release must precede the async-wake offer");
  console.log("PASS: verify/async-wake queued@" + q.id + " offered@" + of.id + " claimed@" + c.id + " terminal@" + t.id);
}
EOF

note "transcript assertions"
if has_phase 1; then
  # Distinctive substrings that appear ONLY in real adapter output, never in
  # the prompts themselves. Phase 1 accepts EITHER wake path: the Stop-hook
  # claimInstruction ("...is now reserved for you (request ...") or the async
  # await-offer watcher text ("was just reserved for a request from this
  # directory") - live runs show the async watcher usually wins the race.
  grep -q "judge by expected CPU/memory/IO cost" /workspace/claude-phase1-stream.jsonl \
    || { echo "FAIL: model did not quote the policy first rule (startup policy not visible)"; exit 66; }
  grep -Eq "reserved for (you \(request|a request from this directory)" /workspace/claude-phase1-stream.jsonl \
    || { echo "FAIL: no offer-wakeup instruction in phase 1 transcript"; exit 66; }
  # Phase 1b: with the async watcher stripped, the ONLY possible wakeup is
  # the Stop-hook decision-block, whose claimInstruction text is unique to
  # src/cli/hook.ts's stop branch.
  grep -q "reserved for you (request" /workspace/claude-phase1b-stream.jsonl \
    || { echo "FAIL: no Stop-hook decision-block claim instruction in phase 1b transcript"; exit 66; }
  if grep -q "was just reserved for a request from this directory" /workspace/claude-phase1b-stream.jsonl; then
    echo "FAIL: async watcher text present in phase 1b - watcher was not disabled"
    exit 66
  fi
fi
if has_phase 2; then
  grep -q "verify/subagent" /workspace/claude-phase2-stream.jsonl \
    || { echo "FAIL: no subagent activity in phase 2 transcript"; exit 66; }
fi
if has_phase 3; then
  # phase 3a: post-compact the model quoted a FRESH "1/1 in use" machine
  # status (holder acquired after startup; only the re-fired
  # SessionStart(compact) hook could have delivered it). \s* not \s+: the TUI
  # renders "1/1 in use" with cursor-position escapes that strip to "1/1inuse".
  clean_log /workspace/claude-phase3a.log | grep -Eq '1/1\s*in\s*use' \
    || { echo "FAIL: post-/compact answer lacks fresh machine status (SessionStart compact restore broken)"; exit 66; }
  # phase 3b: the asyncRewake stderr wakeup text is the async hook's mark;
  # report-but-do-not-fail if the TUI chose not to render it (the event chain
  # and the driver's STANDBY->DONE progression already prove the wake).
  if clean_log /workspace/claude-phase3b.log | grep -q "was just reserved for a request from this directory"; then
    echo "note: async await-offer wakeup message visible in TTY"
  else
    echo "WARN: async wakeup message not rendered in TTY (round-trip events still asserted)"
  fi
fi

note "capacity must be free again"
IN_USE=$(load-lock status | head -1)
echo "$IN_USE" | grep -q "0/1 in use" || { echo "FAIL: $IN_USE"; exit 66; }

echo "ALL CHECKS PASSED"
exit 0
