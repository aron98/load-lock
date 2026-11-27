# Plugin-mode phases for verify-claude-code.sh (MODE=plugin, issue #104).
# Sourced, not run: uses note/result/has_phase/state_of/permit_of/
# wait_pool_free, PLUGIN_REPO, LAUNCHER, TOOL_NS and CLAUDE_FLAGS from the
# main script.
#
# Phases s1-s3 drive a real Claude Code session against
# docker/anthropic-stub.mjs instead of a model: plugins, hooks and MCP
# servers are real, the "model" is a fixed tool-call script, and the checks
# read what Claude Code sent to the API (system prompt with hook output,
# tool results, hook continuations) from the stub's request log.

STUB_PORT=4100
ART=/workspace

# Real load-lock CLI on PATH, ignoring the launcher shell function.
global_load_lock() { type -P load-lock || true; }

# What Claude Code sent, from a stub request log. Only main-conversation
# requests (those with tools) count.
cat > /tmp/stubq.mjs <<'EOF'
import { readFileSync } from "node:fs";
const [cmd, file] = process.argv.slice(2);
const reqs = readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
  .filter((r) => Array.isArray(r.body?.tools) && r.body.tools.length > 0);
const strings = (v, out = []) => {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => strings(x, out));
  else if (v && typeof v === "object") Object.values(v).forEach((x) => strings(x, out));
  return out;
};
const textOf = (r) => (r ? strings({ system: r.body.system, messages: r.body.messages }).join("\n") : "");
const last = reqs.at(-1);
if (cmd === "first") console.log(textOf(reqs[0]));
else if (cmd === "last") console.log(textOf(last));
else if (cmd === "final") console.log(last?.decision?.text ?? "(no final text: last reply was a tool call)");
else if (cmd === "results") {
  const blocks = (last?.body.messages ?? []).filter((m) => Array.isArray(m.content)).flatMap((m) => m.content);
  console.log(blocks.filter((b) => b?.type === "tool_result").map((b) => strings(b.content).join("\n")).join("\n----\n"));
} else if (cmd === "requests") console.log(reqs.length);
EOF
stubq() { node /tmp/stubq.mjs "$@"; }

# stub_session NAME PLAN_JSON [claude args...]: one headless session against
# the stub. Logs: $ART/stub-NAME.{jsonl,debug.txt,out}.
stub_session() {
  local name="$1" plan="$2"
  shift 2
  printf '%s\n' "$plan" > "/tmp/plan-$name.json"
  : > "$ART/stub-$name.jsonl"
  node /usr/local/bin/anthropic-stub.mjs --port "$STUB_PORT" --log "$ART/stub-$name.jsonl" \
    --plan "/tmp/plan-$name.json" 2>/dev/null &
  local stub=$!
  for _ in $(seq 1 50); do
    (exec 3<>"/dev/tcp/127.0.0.1/$STUB_PORT") 2>/dev/null && break
    sleep 0.1
  done
  local rc=0 t0
  t0=$(date +%s)
  env -u ANTHROPIC_AUTH_TOKEN \
    ANTHROPIC_BASE_URL="http://127.0.0.1:$STUB_PORT" \
    ANTHROPIC_API_KEY=sk-stub-not-a-real-key \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
    LOAD_LOCK_LAUNCHER_DEBUG=1 \
    timeout 600 claude -p "${CLAUDE_FLAGS[@]}" --debug-file "$ART/stub-$name.debug.txt" "$@" \
      "stub session $name" > "$ART/stub-$name.out" 2>&1 || rc=$?
  kill "$stub" 2>/dev/null || true
  wait "$stub" 2>/dev/null || true
  echo "stub session $name: exit $rc after $(( $(date +%s) - t0 ))s, final reply: $(stubq final "$ART/stub-$name.jsonl")"
  return "$rc"
}

# How SessionStart reached the model in a session: policy, install hint or nothing.
session_start_seen() {
  local t
  t=$(stubq first "$1")
  if grep -q "load-lock now:" <<<"$t"; then echo "policy brief"
  elif grep -q "the plugin found no runtime" <<<"$t"; then echo "install hint"
  else echo "nothing"; fi
}

# Launcher branches the session's hooks and MCP server took (debug log).
launcher_branches() {
  grep -o "load-lock launcher: [a-z]* [0-9.]*" "$1" | sed 's/load-lock launcher: //' | sort | uniq -c \
    | awk '{printf "%s%s x%s", (NR>1?", ":""), $2" "$3, $1}'
}

# ToolSearch first: MCP tools are deferred, and a server still fetching its
# runtime through npx shows up as "still connecting" for a while.
toolsearch_step() {
  printf '{"tool":"ToolSearch","input":{"query":"select:%s","max_results":10},"retryWhile":"still connecting|No matching deferred tools","retryDelayMs":3000}' "$1"
}

plugin_preflight() {
  note "plugin mode: preflight (clean machine) + marketplace install"
  local gl
  gl=$(global_load_lock)
  [ -z "$gl" ] || { echo "FAIL: plugin mode needs an image without a global load-lock, found $gl"; exit 66; }
  if ls "$HOME/.npm/_npx" 2>/dev/null | grep -q .; then
    echo "FAIL: npx cache not empty - not a clean machine"; exit 66
  fi
  result "versions: claude $(claude --version | head -1); node $(node -v); npm $(npm -v); plugin pin $(grep -o '@aron98/load-lock@[0-9.]*' "$LAUNCHER" | head -1)"
  claude plugin marketplace add "$PLUGIN_REPO"
  claude plugin install load-lock-plugin@load-lock
  claude plugin list | tee /tmp/plugin-list.txt
  grep -q "load-lock-plugin@load-lock" /tmp/plugin-list.txt || { echo "FAIL: plugin not installed"; exit 66; }
}

phase_s1() {
  note "Phase s1 (stub model): clean machine - npx branch, plugin starts the daemon"
  [ ! -e "$LOAD_LOCK_STATE_DIR/daemon.json" ] || { echo "FAIL: s1 needs a fresh state dir"; exit 66; }
  local name plan ts
  ts="$(toolsearch_step "${TOOL_NS}status,${TOOL_NS}acquire,${TOOL_NS}release")"
  for name in s1-cold s1-warm; do
    plan='{"steps":['"$ts"',
      {"tool":"'"${TOOL_NS}"'status","input":{}},
      {"tool":"'"${TOOL_NS}"'acquire","input":{"reason":"stub '"$name"'","op_key":"verify/'"$name"'"}},
      {"tool":"'"${TOOL_NS}"'release","input":{"permit_token":"{{permit_token}}"}}]}'
    stub_session "$name" "$plan" || { echo "FAIL: $name session exited non-zero"; exit 65; }
    result "$name: SessionStart delivered: $(session_start_seen "$ART/stub-$name.jsonl")"
    result "$name: launcher branches: $(launcher_branches "$ART/stub-$name.debug.txt")"
    [ "$(stubq final "$ART/stub-$name.jsonl")" = STUB-DONE ] \
      || { echo "FAIL: $name did not finish the MCP round-trip (see stub-$name.jsonl)"; exit 66; }
    stubq results "$ART/stub-$name.jsonl" | grep -q '"state": "granted"' \
      || { echo "FAIL: $name acquire through the plugin MCP server was not granted"; exit 66; }
    result "$name: plugin MCP round-trip status -> acquire (granted) -> release: ok"
  done
  # Cold: nothing on PATH, nothing known, nothing cached -> npx (fetch) branch.
  grep -q "load-lock launcher: npx" "$ART/stub-s1-cold.debug.txt" \
    || { echo "FAIL: s1-cold never took the launcher's npx branch"; exit 66; }
  # Warm: the session's daemon recorded its (npx cache) copy -> known-copy branch.
  [ "$(session_start_seen "$ART/stub-s1-warm.jsonl")" = "policy brief" ] \
    || { echo "FAIL: s1-warm SessionStart did not deliver the policy brief"; exit 66; }
  # Daemon started by the plugin: nothing else on this machine could start it.
  local pid root
  pid=$(node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).pid))' "$LOAD_LOCK_STATE_DIR/daemon.json")
  root=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).packageRoot)' "$LOAD_LOCK_STATE_DIR/daemon.json")
  kill -0 "$pid" || { echo "FAIL: daemon pid $pid not running"; exit 66; }
  [[ "$root" == */_npx/* ]] || { echo "FAIL: daemon runs $root, expected the npx cache copy"; exit 66; }
  tr '\0' '\n' < "/proc/$pid/environ" | grep -q "^CLAUDE_PLUGIN_ROOT=$PLUGIN_REPO/plugins/claude-code$" \
    || { echo "FAIL: daemon environment lacks the plugin's CLAUDE_PLUGIN_ROOT"; exit 66; }
  result "s1: daemon started by the plugin: pid $pid, runtime $root, CLAUDE_PLUGIN_ROOT in its environment"
}

phase_s2() {
  note "Phase s2 (stub model): ACE skills-dir layout"
  claude plugin uninstall load-lock-plugin@load-lock
  if claude plugin list | grep -q "load-lock-plugin@load-lock"; then echo "FAIL: marketplace plugin still installed"; exit 66; fi
  local scope dir name plan ts
  ts="$(toolsearch_step "${TOOL_NS}status")"
  plan='{"steps":['"$ts"',{"tool":"'"${TOOL_NS}"'status","input":{}}]}'
  for scope in project user; do
    if [ "$scope" = project ]; then dir=/workspace/.claude/skills/load-lock-plugin; else dir="$HOME/.claude/skills/load-lock-plugin"; fi
    name="s2-$scope"
    mkdir -p "$(dirname "$dir")"
    # What ACE unpacks: the plugin folder's contents, under the plugin's name.
    cp -r "$PLUGIN_REPO/plugins/claude-code" "$dir"
    stub_session "$name" "$plan" || { echo "FAIL: $name session exited non-zero"; exit 65; }
    local loaded="no" rooted="no"
    grep -q "plugin load-lock-plugin@skills-dir" "$ART/stub-$name.debug.txt" && loaded="yes (load-lock-plugin@skills-dir)"
    grep -q "node \"$dir/scripts/load-lock.mjs\" hook claude-code" "$ART/stub-$name.debug.txt" && rooted="yes ($dir)"
    result "$name ($dir): loaded as plugin: $loaded; hooks ran with \${CLAUDE_PLUGIN_ROOT} resolved: $rooted"
    result "$name: SessionStart delivered: $(session_start_seen "$ART/stub-$name.jsonl"); launcher branches: $(launcher_branches "$ART/stub-$name.debug.txt")"
    local mcp
    mcp=$(claude mcp list 2>&1 | grep "plugin:load-lock-plugin" || echo "(not listed)")
    result "$name: claude mcp list: $mcp"
    [ "$(session_start_seen "$ART/stub-$name.jsonl")" = "policy brief" ] \
      || { echo "FAIL: $name: SessionStart policy not delivered from the skills dir"; exit 66; }
    [ "$(stubq final "$ART/stub-$name.jsonl")" = STUB-DONE ] \
      || { echo "FAIL: $name: plugin MCP tool not served from the skills dir"; exit 66; }
    stubq results "$ART/stub-$name.jsonl" | grep -q 'pool' \
      || { echo "FAIL: $name: status tool result missing"; exit 66; }
    result "$name: plugin MCP status tool call from the skills dir: ok"
    rm -rf "$dir"
  done
  # Back to the marketplace install for the phases after this one.
  claude plugin install load-lock-plugin@load-lock
}

phase_s3() {
  note "Phase s3 (stub model): plugin + loose install together"
  npm install -g --prefix "$HOME/.npm-global" /pkg/*.tgz
  export PATH="$HOME/.npm-global/bin:$PATH"
  unset -f load-lock
  load-lock install --harness claude-code --legacy
  local mode
  mode=$(load-lock doctor --json | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>process.stdout.write(String(JSON.parse(s).claudeCodeMode)))')
  result "s3: load-lock doctor claudeCodeMode: $mode"
  [ "$mode" = both ] || { echo "FAIL: expected claudeCodeMode both, got $mode"; exit 66; }
  claude mcp list 2>&1 | grep -i "load-lock" | sed 's/^/  /' | tee /tmp/s3-mcp.txt
  result "s3: MCP servers listed: $(grep -c . /tmp/s3-mcp.txt)"

  wait_pool_free
  load-lock acquire --json --op-key holder/s3 --reason "holder: plugin+loose verify" --label "cli-holder-s3" > /tmp/holder-s3.json
  [ "$(state_of /tmp/holder-s3.json)" = granted ] || { echo "FAIL: s3 holder not granted"; exit 66; }
  local hs3
  hs3=$(permit_of /tmp/holder-s3.json)
  ( for _ in $(seq 1 300); do
      load-lock status --json 2>/dev/null | grep -q '"opKey": "verify/s3"' && break
      sleep 1
    done
    sleep 2
    load-lock release --permit "$hs3" > /tmp/holder-s3-release.json ) &
  local rel=$!

  local ts plan
  ts="$(toolsearch_step "${TOOL_NS}acquire,${TOOL_NS}pending,${TOOL_NS}claim,${TOOL_NS}release")"
  plan='{"steps":['"$ts"',
    {"tool":"'"${TOOL_NS}"'acquire","input":{"reason":"plugin+loose wakeup","op_key":"verify/s3"}},
    {"tool":"Bash","input":{"command":"sleep 15","description":"light work while queued"}},
    {"tool":"'"${TOOL_NS}"'pending","input":{},"await":"reserved for you \\(request|was just reserved for a request from this directory"},
    {"tool":"'"${TOOL_NS}"'claim","input":{"offer_token":"{{offer_token}}"}},
    {"tool":"'"${TOOL_NS}"'release","input":{"permit_token":"{{permit_token}}"}}]}'
  stub_session s3 "$plan" || { kill "$rel" 2>/dev/null; echo "FAIL: s3 session exited non-zero"; exit 65; }
  kill "$rel" 2>/dev/null || true
  wait "$rel" 2>/dev/null || true
  load-lock release --permit "$hs3" > /dev/null 2>&1 || true

  local first last briefs stopw asyncw
  first=$(stubq first "$ART/stub-s3.jsonl")
  last=$(stubq last "$ART/stub-s3.jsonl")
  briefs=$(grep -o "load-lock now:" <<<"$first" | wc -l)
  # Claude Code shows one blocking hook's text twice (a "Stop hook feedback"
  # reminder and a "Stop hook blocking error from command ..." entry), so
  # count deliveries by the latter: one entry per hook run that woke it.
  stopw=$(grep -E "blocking error from command.*is now reserved for you \(request" <<<"$last" | wc -l)
  asyncw=$(grep -E "blocking error from command.*was just reserved for a request from this directory" <<<"$last" | wc -l)
  result "s3: SessionStart machine briefs in context: $briefs (two SessionStart hooks wired)"
  result "s3: wakeups delivered: Stop continuation x$stopw, async await-offer x$asyncw"
  result "s3: SessionStart hooks run: $(grep -c 'Hooks: SessionStart:startup \[.*session-start\]' "$ART/stub-s3.debug.txt"), Stop hooks run: $(grep -c 'Hooks: Stop \[' "$ART/stub-s3.debug.txt")"
  result "s3: launcher branches: $(launcher_branches "$ART/stub-s3.debug.txt")"
  [ "$briefs" -eq 1 ] || { echo "FAIL: expected exactly one policy brief with plugin + loose, got $briefs"; exit 66; }
  [ "$stopw" -le 1 ] && [ "$asyncw" -le 1 ] && [ $((stopw + asyncw)) -ge 1 ] \
    || { echo "FAIL: expected one wakeup per path (at least one), got stop=$stopw async=$asyncw"; exit 66; }
  [ "$(stubq final "$ART/stub-s3.jsonl")" = STUB-DONE ] \
    || { echo "FAIL: s3 did not finish pending -> claim -> release"; exit 66; }
  load-lock events --json > /tmp/s3-events.json
  local order
  order=$(node - <<'EOF'
const es = JSON.parse(require("fs").readFileSync("/tmp/s3-events.json", "utf8")).events.filter((e) => e.entry?.opKey === "verify/s3");
const id = (t) => es.find((e) => e.type === t)?.id;
const [q, o, c, r] = ["queued", "offered", "claimed", "released"].map(id);
if (!(q < o && o < c && c < r)) { console.error("FAIL: verify/s3 events out of order or missing: " + JSON.stringify(es.map((e) => e.type))); process.exit(66); }
console.log(`verify/s3 queued@${q} offered@${o} claimed@${c} released@${r}`);
EOF
) || exit 66
  result "s3: $order"
}
