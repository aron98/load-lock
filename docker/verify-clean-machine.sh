#!/bin/bash
# Clean-machine first-use check for the ACE artifacts (issue #104 / #66).
# Runs INSIDE a fresh stock node image as the unprivileged "node" user, with
# this repo mounted read-only at /repo (see docker/run-model-free-checks.sh).
# No model, no key, no global load-lock: each artifact starts from an empty
# npx cache and an empty default state dir (~/.local/state/load-lock), runs
# exactly the command its committed files name, and must leave a running
# daemon behind.
#
#   MCP server  ace/mcp/mcp.json: `npx -y @aron98/load-lock@<pin> mcp`,
#               driven over stdio: initialize -> status -> acquire -> release
#   skill       skills/load-lock/SKILL.md's pinned `npx -y ...@<pin> <cmd>`
#   plugin      plugins/claude-code unpacked as ACE does
#               (~/.claude/skills/load-lock-plugin/): the launcher as the
#               plugin's MCP server, and its SessionStart hook cold and warm
#
# The OpenCode artifact (ace/opencode/) needs OpenCode and is not covered.
# Exit 0 = all checks passed.
set -eu

REPO=/repo
STATE="$HOME/.local/state/load-lock"
note() { printf '\n===== %s =====\n' "$*"; }
result() { echo "RESULT $*"; }
fail() { echo "FAIL: $*"; exit 66; }

daemon_up() {
  node - "$STATE" <<'EOF'
const fs = require("fs"), path = require("path");
const dir = process.argv[2];
let d;
try { d = JSON.parse(fs.readFileSync(path.join(dir, "daemon.json"), "utf8")); }
catch { console.log("no daemon.json"); process.exit(1); }
try { process.kill(d.pid, 0); } catch { console.log(`daemon pid ${d.pid} not running`); process.exit(1); }
if (!fs.existsSync(d.socket)) { console.log(`socket ${d.socket} missing`); process.exit(1); }
console.log(`daemon pid ${d.pid} up, version ${d.version}, runtime ${d.packageRoot}`);
EOF
}

# Back to a clean machine: stop the daemon, drop npm's cache and the state dir.
wipe() {
  if [ -f "$STATE/daemon.json" ]; then
    local pid
    pid=$(node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).pid))' "$STATE/daemon.json")
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 50); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
  fi
  rm -rf "$HOME/.npm" "$STATE" "$HOME/.claude"
}

preflight() {
  if type -P load-lock >/dev/null; then fail "load-lock is on PATH - not a clean machine"; fi
  [ ! -e "$STATE" ] || fail "state dir exists - not a clean machine"
}

note "environment"
result "versions: node $(node -v), npm $(npm -v), $(. /etc/os-release && echo "$PRETTY_NAME")"
wipe
preflight

# ------------------------------------------------------------------ MCP
note "ACE MCP server (ace/mcp/mcp.json)"
mapfile -t MCP_CMD < <(node -e 'const m=JSON.parse(require("fs").readFileSync("/repo/ace/mcp/mcp.json","utf8"));for(const a of [m.command,...m.args])console.log(a)')
result "mcp: command from mcp.json: ${MCP_CMD[*]}"
t0=$(date +%s)
OUT=$(node "$REPO/docker/mcp-probe.mjs" \
  '[["status",{}],["acquire",{"reason":"clean-machine mcp","op_key":"verify/clean-mcp"}],["release",{"permit_token":"{{permit_token}}"}]]' \
  -- "${MCP_CMD[@]}") || fail "MCP probe failed: $OUT"
echo "$OUT"
grep -q '"state\\": \\"granted' <<<"$OUT" || fail "MCP acquire was not granted"
result "mcp: initialize + tools/list + status/acquire/release ok in $(( $(date +%s) - t0 ))s (cold npx fetch included); $(node -e 'const o=JSON.parse(process.argv[1]);process.stdout.write(`${o.server.name} ${o.server.version}, ${o.tools} tools, initialize after ${o.initMs}ms`)' "$OUT")"
D=$(daemon_up) || fail "no running daemon after the MCP server's first use: $D"
result "mcp: $D (after the MCP server exited)"
wipe

# ------------------------------------------------------------------ skill
note "ACE skill (skills/load-lock/SKILL.md, pinned npx)"
preflight
SPEC=$(grep -o '@aron98/load-lock@[0-9][0-9.]*' "$REPO/skills/load-lock/SKILL.md" | head -1)
result "skill: pinned command: npx -y $SPEC <command>"
t0=$(date +%s)
npx -y "$SPEC" status | tee /tmp/skill-status.txt
grep -q 'pool "heavy"' /tmp/skill-status.txt || fail "skill status output lacks the heavy pool"
D=$(daemon_up) || fail "no running daemon after the skill's first command: $D"
npx -y "$SPEC" acquire --json --op-key verify/clean-skill --reason "clean-machine skill" > /tmp/skill-acq.json
PERMIT=$(node -e 'const j=JSON.parse(require("fs").readFileSync("/tmp/skill-acq.json","utf8"));if(j.state!=="granted")process.exit(1);process.stdout.write(j.entry.permitToken)') \
  || fail "skill acquire not granted: $(cat /tmp/skill-acq.json)"
npx -y "$SPEC" release --permit "$PERMIT" > /dev/null
result "skill: status + acquire/release ok in $(( $(date +%s) - t0 ))s; $D"
wipe

# ------------------------------------------------------------------ plugin
note "ACE Claude Code plugin (plugins/claude-code in ~/.claude/skills/load-lock-plugin/)"
preflight
PLUG="$HOME/.claude/skills/load-lock-plugin"
mkdir -p "$(dirname "$PLUG")"
cp -r "$REPO/plugins/claude-code" "$PLUG"
HOOK_IN='{"session_id":"clean-machine","source":"startup","cwd":"/tmp","hook_event_name":"SessionStart"}'

# SessionStart before anything fetched the runtime: hooks run npx --offline.
COLD=$(CLAUDE_PLUGIN_ROOT="$PLUG" LOAD_LOCK_LAUNCHER_DEBUG=1 node "$PLUG/scripts/load-lock.mjs" hook claude-code session-start <<<"$HOOK_IN" 2>/tmp/cold.err) \
  || fail "cold SessionStart hook exited non-zero"
if grep -q "the plugin found no runtime" <<<"$COLD"; then result "plugin: cold SessionStart (empty npx cache): install hint, exit 0"
elif grep -q "load-lock now:" <<<"$COLD"; then result "plugin: cold SessionStart (empty npx cache): policy brief"
else fail "cold SessionStart printed neither hint nor policy: $COLD"; fi
result "plugin: cold hook launcher: $(grep -o 'load-lock launcher: [a-z]* [0-9.]*' /tmp/cold.err | head -1)"

# The plugin's MCP server (plugin.json: launcher --bin load-lock-mcp).
t0=$(date +%s)
OUT=$(CLAUDE_PLUGIN_ROOT="$PLUG" LOAD_LOCK_LAUNCHER_DEBUG=1 node "$REPO/docker/mcp-probe.mjs" \
  '[["status",{}],["acquire",{"reason":"clean-machine plugin","op_key":"verify/clean-plugin"}],["release",{"permit_token":"{{permit_token}}"}]]' \
  -- node "$PLUG/scripts/load-lock.mjs" --bin load-lock-mcp 2>/tmp/mcp.err) || fail "plugin MCP probe failed: $OUT $(cat /tmp/mcp.err)"
echo "$OUT"
grep -q '"state\\": \\"granted' <<<"$OUT" || fail "plugin MCP acquire was not granted"
result "plugin: MCP server launcher: $(grep -o 'load-lock launcher: [a-z]* [0-9.]*' /tmp/mcp.err | head -1); status/acquire/release ok in $(( $(date +%s) - t0 ))s"
D=$(daemon_up) || fail "no running daemon after the plugin MCP server's first use: $D"
result "plugin: $D"

# Same hook once the runtime is known: policy brief.
WARM=$(CLAUDE_PLUGIN_ROOT="$PLUG" LOAD_LOCK_LAUNCHER_DEBUG=1 node "$PLUG/scripts/load-lock.mjs" hook claude-code session-start <<<"$HOOK_IN" 2>/tmp/warm.err) \
  || fail "warm SessionStart hook exited non-zero"
grep -q "load-lock now:" <<<"$WARM" || fail "warm SessionStart did not print the policy brief: $WARM"
result "plugin: warm SessionStart: policy brief; launcher: $(grep -o 'load-lock launcher: [a-z]* [0-9.]*' /tmp/warm.err | head -1)"
wipe

echo
echo "CLEAN-MACHINE CHECKS PASSED"
