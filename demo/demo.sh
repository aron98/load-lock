#!/usr/bin/env bash
# load-lock demo: three agents in three git worktrees compete for one
# machine-wide heavy-work budget (capacity 1) while a shared daemon arbitrates.
#
# Fully scripted, reproducible, no network. Run:  bash demo/demo.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI=(node "$ROOT/dist/cli/main.js")
DEMO="$(mktemp -d /tmp/opencode/ll-demo-XXXXXX)"

cleanup() {
  "${CLI[@]}" service stop >/dev/null 2>&1 || true
  rm -rf "$DEMO"
}
trap cleanup EXIT

say()  { printf '\n\033[1m==== %s ====\033[0m\n' "$*"; }
line() { printf -- '---- %s\n' "$*"; }

# Poll `load-lock status` (human output) until it matches $2, else fail.
wait_for() {
  local desc="$1" pattern="$2" i
  for i in $(seq 1 150); do
    if "${CLI[@]}" status 2>/dev/null | grep -qE "$pattern"; then return 0; fi
    sleep 0.1
  done
  echo "TIMED OUT waiting for: $desc" >&2
  "${CLI[@]}" status || true
  exit 1
}

say "build"
(cd "$ROOT" && npm run build --silent)

say "workspace: git repo + 3 worktrees in $DEMO"
git init -q "$DEMO/repo"
git -C "$DEMO/repo" config user.email demo@load-lock
git -C "$DEMO/repo" config user.name  demo
echo 'fn main() { println!("heavy"); }' > "$DEMO/repo/main.rs"
git -C "$DEMO/repo" add -A
git -C "$DEMO/repo" commit -qm "init"
for w in a b c; do
  git -C "$DEMO/repo" worktree add -q "$DEMO/wt-$w" -b "wt-$w"
done
line "3 worktrees, one repo — 3 'agents' will share ONE budget regardless of checkout"

# Isolated daemon for the demo (does not touch any real state).
export LOAD_LOCK_STATE_DIR="$DEMO/state"
export LOAD_LOCK_SOCKET="$DEMO/state/daemon.sock"

say "start the shared daemon"
"${CLI[@]}" service start

say "machine inventory (what agents are told to reason with)"
"${CLI[@]}" inspect --json | node -e '
  let s=""; process.stdin.on("data", d => (s += d)).on("end", () => {
    const j = JSON.parse(s);
    console.log(`cpu: ${j.cpu.logicalCores} logical / ${j.cpu.effectiveCores} effective (${j.cpu.cgroupVersion})`);
    console.log(`memory: ${(j.memory.totalBytes/2**30).toFixed(1)} GiB total / ${(j.memory.effectiveLimitBytes/2**30).toFixed(1)} GiB effective limit`);
    console.log(`pressure: ${j.pressure.note}`);
  });'

say "configure: capacity 1, short claim window (2s) for a snappy demo"
"${CLI[@]}" configure --capacity 1 --offer-timeout-ms 2000 \
  --reason "demo: single heavy slot; short offer window to show expiry" --author "demo-operator" >/dev/null
line "any agent may propose changes like this via configure (versioned CAS); the demo pins it"

say "launch agent A (gets the only slot) — then B and C, which queue"
(cd "$DEMO/wt-a" && exec node "$ROOT/demo/sim-agent.mjs" --role A --agent sim-a --label "A build (wt-a)") &
PID_A=$!
wait_for "A holds the only slot" '1/1 in use'
(cd "$DEMO/wt-b" && exec node "$ROOT/demo/sim-agent.mjs" --role B --agent sim-b --label "B test (wt-b)") &
PID_B=$!
wait_for "B is queued" '1 queued'
(cd "$DEMO/wt-c" && exec node "$ROOT/demo/sim-agent.mjs" --role C --agent sim-c --label "C build (wt-c)") &
PID_C=$!
wait_for "C is queued too" '2 queued'

say "snapshot: one heavy job running, two agents queued (all in different worktrees)"
"${CLI[@]}" status

say "agents run on their own — watching the hand-off from A to B (strict FIFO)"
wait_for "A released; B now holds the permit" 'held: B test'
line "A finished its build; the daemon reserved the slot for the FIFO head (B) and made an offer"
wait_for "B finished; C gets an offer — but C is busy and will miss it" 'held: C build|1 paused'
line "C deliberately let its offer expire: the request is PAUSED, not recycled"
wait_for "capacity back to idle (C paused, nobody holds)" '0/1 in use'
"${CLI[@]}" status

say "C rejoins when actually ready, claims, runs"
wait_for "all three agents finished (capacity idle)" ': 0/1 in use'
wait "$PID_A" "$PID_B" "$PID_C"

say "final state"
"${CLI[@]}" status
"${CLI[@]}" get-config | node -e '
  let s=""; process.stdin.on("data", d => (s += d)).on("end", () => {
    const j = JSON.parse(s);
    console.log(`config version ${j.config.version}; capacity(heavy)=${j.config.pools.heavy.capacity}; offer window ${j.config.offerTimeoutMs}ms`);
    console.log("change history:");
    for (const h of j.history) console.log(`  v${h.resultingVersion} by ${h.author}: ${h.reason}`);
  });'

say "event log (durable identities — every grant, offer, claim, release)"
"${CLI[@]}" events --json | node -e '
  let s=""; process.stdin.on("data", d => (s += d)).on("end", () => {
    const j = JSON.parse(s);
    for (const ev of j.events) console.log(`  #${ev.id} ${ev.type.padEnd(13)} ${ev.entry?.agentLabel ?? ev.targetAgent ?? ""}`);
  });'

printf '\n\033[1mDemo complete:\033[0m capacity 1 was never exceeded; offers went out strictly in FIFO order;\nC missed its claim window, was paused (not endlessly recycled), and rejoined explicitly.\n'
