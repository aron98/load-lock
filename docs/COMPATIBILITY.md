# Harness compatibility matrix

load-lock separates **core capability** (daemon + protocol + CLI, fully
harness-agnostic) from **per-harness integration** (tools, policy
instruction injection, compaction restore, idle wakeup, lifecycle help).
Status labels mean exactly this:

- **Implemented + live-verified** — deployed on this machine and exercised
  end-to-end against the real harness.
- **Implemented + contract-tested** — adapter shipped; behavior tested
  against the harness's documented hook/tool JSON contracts
  (`src/test/hook.test.ts`, `src/test/mcp.test.ts`), but the harness itself
  was not installed during verification.
- **Implemented + config-tested** — installer shipped; install/uninstall
  round-trip tested against a temp HOME and validated against the harness's
  documented config schemas (`src/test/install.test.ts`), but the harness
  itself was not installed during verification.
- **Proposed / fallback** — research-verified harness capabilities only; no
  adapter shipped beyond the generic MCP path.

## Core (all harnesses)

| Capability | Status |
| --- | --- |
| Machine-wide pool, atomic acquire, FIFO offers, claim tokens, expiry → paused → rejoin | Implemented + tested (`core.test` 14, `daemon.test` 8) |
| Idempotent acquire/release, duplicate suppression, weighted head-block | Implemented + tested |
| Automatic cleanup: start deadline, tracked pgid process death, untracked lease, heartbeats, PID-reuse defense | Implemented + tested with real processes |
| Daemon restart: journal reconciliation, idempotent late release, ephemeral queues | Implemented + tested |
| Config via tools, CAS versions, persisted history with author+reason | Implemented + tested |
| Resource inspection incl. cgroup v2/v1 CPU+memory limits and pressure | Implemented + tested |
| CLI: acquire/claim/release/run/wait/status/configure/doctor/recover/install | Implemented + tested + demoed |

## Per-harness integration

| Harness | MCP tools | Policy injection | Compaction restore | Idle wakeup | Async push into context | Cleanup fidelity | Overall |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **OpenCode** (v2) | Native plugin, `load_lock_*` (better than MCP) | Context hook every model call | Yes (hook re-fires per model call) | Yes — `session.synthetic` at execution boundary (live-verified; never interrupts in-flight shell) | Yes (live-verified) | Full: `run_with_permit` tracked jobs + session heartbeats | **Implemented + live-verified** |
| **Claude Code** | MCP `mcp__load-lock__*` (user scope) — live-verified round-trip | `SessionStart` hook plain-stdout context (live-verified: model quoted the brief verbatim) | Yes (SessionStart matcher `compact`) — live-verified after `/compact` | Yes — `Stop` hook decision-block + async `await-offer` (`asyncRewake`), both live-verified | Yes, via asyncRewake (live-verified; the wake text itself is not rendered by the TTY, but the wake drives the full claim lifecycle) | Full via MCP `run_with_permit` + server heartbeats (live-verified incl. a job outliving the claude process) | **Implemented + live-verified** |
| **Codex CLI** | MCP `mcp__load-lock__*` (config.toml) | `SessionStart` + `SubagentStart` additionalContext; `~/.codex/AGENTS.md` | Yes (SessionStart matcher `compact`) | Yes — `Stop` hook `decision:"block"` continuation | Partial: async background hooks do NOT start a new turn (documented limitation); stop-hook covers turn boundaries | Full via MCP `run_with_permit` + server heartbeats | **Implemented + live-verified** (interactive TUI in Docker; exec-mode MCP blocked upstream — see Tier 2 notes) |
| **Gemini CLI** | Yes (`settings.json` mcpServers, first-class installer) | `GEMINI.md` global (config `context.fileName`) | Via global GEMINI.md (always loaded) | No hooks — `wait_for_turn` bounded sleep is the primary idle mechanism | No | Via MCP `run_with_permit` only | **Implemented (fallback tier, config-tested)** |
| **GitHub Copilot CLI** | Yes (`~/.copilot/mcp-config.json`, merge-only installer; verify with `copilot mcp list`) | `~/.copilot/copilot-instructions.md` (marked section) | Via global instructions file | Hooks reported in ecosystem content but **not verified in official docs** — none installed; `wait_for_turn` bounded sleep is the primary idle mechanism | Unverified | Via MCP `run_with_permit` only | **Implemented (fallback tier, config-tested)** |
| **Cursor** | Yes (project `.cursor/mcp.json`, merge-only installer) | `.cursor/rules/load-lock.mdc` (dedicated Always-apply rule file) | Rules re-apply (Always) | Yes — `stop` hook `{"followup_message":...}` continuation (hooks v1, officially documented) | No async watcher shipped; stop hook covers turn boundaries | Via MCP `run_with_permit` only | **Implemented + contract-tested** (hooks tier; not live-verified) |
| **Cline** | Yes (`cline_mcp_settings.json`, merge-only installer) | `~/.cline/rules/load-lock.md` (dedicated rule file) | Rules always loaded | No hooks — `wait_for_turn` bounded sleep is the primary idle mechanism | No | Via MCP `run_with_permit` only | **Implemented (fallback tier, config-tested)** |
| **Roo Code** | Yes (project `.roo/mcp.json` + existing global `mcp_settings.json`, merge-only installer) | `~/.roo/rules/load-lock.md` (dedicated rule file) | Rules always loaded | No hooks — `wait_for_turn` bounded sleep is the primary idle mechanism | No | Via MCP `run_with_permit` only | **Implemented (fallback tier, config-tested)** |
| **Goose** | Yes (`~/.config/goose/config.yaml` `extensions` block, merge-only installer) | `.goosehints` (global, marked section) | Hints always loaded | No hooks — `wait_for_turn` bounded sleep is the primary idle mechanism | No | Via MCP `run_with_permit` only | **Implemented (fallback tier, config-tested)** |
| **omac** (agent sandbox; verified with 0.11.0) | N/A — omac is a sandbox runtime, not a harness: the agent inside it uses whichever harness adapter applies (OpenCode, Claude Code, …) | via the inner harness | via the inner harness | via the inner harness | via the inner harness | Full for the sandbox grants: `load-lock uninstall --harness omac` removes exactly the entries install added (match-own-entries, empty sections pruned) | **Sandbox-profile grants installed + live-verified** (`install --harness omac`: `filesystem.allow_unix_dir` += state dir, `filesystem.read` += package tree when needed, `environment.allow_vars` += `LOAD_LOCK_*`) |
| **Aider** | **No MCP support** | CONVENTIONS.md / `.aider.conf.yml` | Read each run | N/A | N/A | CLI-only: same-shell `load-lock acquire ... && cmd; load-lock release ...` (manual) | Proposed (manual CLI tier) |

## Rung per harness

The install ladder (OPERATIONS.md, "The install ladder") has rungs 0 = skill
only, 1 = MCP server, 2 = harness plugin, plus the loose
`npm i -g` + `load-lock install --harness <h>` wiring. **Rung 0 works
everywhere** an agent can read the skill and run a shell: it only needs
the CLI (on PATH or through the skill's pinned `npx`), so it is not
repeated per row. `load-lock setup` reports the rung it finds per harness
as `plugin`, `loose`, `MCP only`, `skill only` or `not installed`.

| Harness | MCP server (1) | Plugin (2) | Loose `install` | Highest rung |
| --- | --- | --- | --- | --- |
| **OpenCode** | generic stdio registration works; the plugin's native `load_lock_*` tools are better | npm plugin `@aron98/load-lock` (also listed on ACE via `ace/opencode/`) — live-verified | `install --harness opencode` registers that same npm plugin | **plugin** |
| **Claude Code** | ACE `ace/mcp` or a manual stdio registration | `load-lock-plugin` from this repo's marketplace — contract-tested, passes `claude plugin validate --strict`; not yet live-verified as a plugin (pending #63); ACE's skills-dir install unverified (#63/#66) | `install --harness claude-code`: MCP + hooks + `CLAUDE.md` section + skill — live-verified in Docker | **plugin** (loose gives the same capability) |
| **Codex CLI** | `[mcp_servers]` entry in `~/.codex/config.toml` | none shipped | `install --harness codex`: MCP + hooks + `AGENTS.md` section — live-verified in Docker | **loose** |
| **Cursor** | project `.cursor/mcp.json` | none shipped | `install --harness cursor --project <dir>`: MCP + stop hook + rule — contract-tested | **loose** |
| **Gemini CLI, Copilot CLI, Cline, Roo Code, Goose** | the harness's MCP config | none shipped | `install --harness <h>`: MCP + instructions/rule file, no hooks — config-tested | **loose** (rung 1 plus a policy file; no idle wakeup) |
| **omac** | n/a (sandbox, not a harness) | — | `install --harness omac`: sandbox-profile grants — live-verified | the inner harness's rung |
| **Aider** | no MCP support | none | none | **0** (CLI only) |

"Highest rung" is what `load-lock setup --yes` converges a harness to once
it has some load-lock wiring (OPERATIONS.md, "Converging"). Mixing rungs in
one harness is safe (ARCHITECTURE.md, "Three layers").

## How each integration tier works

### Tier 1 — OpenCode (native plugin, live-verified)

Global plugin (`load-lock install --harness opencode`) registers:
- `load_lock_*` tools with session-bound agent identity and cwd,
- the policy brief injected into system context on **every** model call
  (survives compaction by construction),
- a `load-lock` skill with the full agent guide,
- daemon event watcher → `ctx.session.synthetic` offer messages with the
  real claim token, delivered at execution boundaries,
- per-session heartbeats,
- the package's `./tui` export: a **live lock-status dashboard panel**
  (issue #10) inside the opencode TUI — `/load-lock` opens the
  `load-lock.dashboard` session panel in-window (issue #24: side panel,
  not full-screen) with pools, holder cards, offer countdowns, queue,
  paused, event feed, `inspect_machine`; a clickable sidebar widget
  (`load-lock 0/3`, health-colored; `/load-lock` as the mouse-free
  fallback) and a home-footer `lock 1/1·Q2` indicator; and an `x` force-release flow
  gated behind an explicit select + confirm (the panel itself is read-only
  and never acquires a permit).

Verified live on opencode v2.0.29: plugin load, policy visible to the model,
tool round-trip (acquire → queued → wakeup → claim → release), execution-
boundary delivery without interrupting a running `sleep`, skill visible,
and graceful handling of a deliberately missed offer (paused → cancel).

#### ACE listing (opencode, issue #79)

ACE ([TNG/ace](https://github.com/TNG/ace)) cannot detect the root
`package.json` as an OpenCode plugin, because its entry point is the
gitignored `dist/`. The OpenCode listing therefore comes from the dedicated
folder `ace/opencode/`. It is a thin pointer: `index.js` re-exports
`@aron98/load-lock`, and `package.json` (`load-lock-opencode`, private) pins
that dependency to the release version through `scripts/check-pins.mjs`.
ACE finds the folder through its npm-package heuristic (a `main` that exists
in the git tree, plus `opencode` in the name or keywords). ACE marks every
such detection as **"verify before registering"**, so that note is expected.
`src/test/ace-opencode.test.ts` mirrors the heuristic (TNG/ace@b703410) and
asserts that this repo yields exactly one OpenCode plugin, at `ace/opencode`.
Users install the published package as usual (a `plugins` entry
`@aron98/load-lock` in `opencode.json`), not the folder itself. The
end-to-end ACE install is not yet live-verified (#66).

#### Multiple copies of load-lock (opencode)

`install --harness opencode` registers the **bare package name** in
`~/.config/opencode/opencode.json`, so opencode maintains its own private
copy of load-lock under
`~/.cache/opencode/npm/@aron98/load-lock@latest/<timestamp>/node_modules/@aron98/load-lock/`,
refreshed on opencode's schedule. That copy is *separate* from a globally
installed CLI on PATH, and the two can drift (this was observed on a real
machine with cache copies at 0.1.2, 1.0.0, 1.1.0 and 1.2.1 — issue #34).

Which copy is authoritative for what:

- **opencode plugin behavior** — the cache copy. Updated by opencode itself
  (it refreshes the cache entry); you cannot reliably update it by hand.
- **CLI commands** (`load-lock status`, `service`, `doctor`, …) — the copy on
  PATH (typically a global install via npm/bun). Update it with your usual
  global install command, or `load-lock update` (since #38), which detects
  the package manager from the copy's location and refuses to touch copies
  it does not manage: it will not "update" the opencode cache copy (opencode
  owns it) nor a git checkout (your git workflow owns it), and it restarts
  the service after a successful apply.
- **The daemon's code** — whichever copy spawned it (usually the CLI copy,
  since auto-spawn and `service start` run from the CLI client code). The
  version handshake makes a daemon self-restart onto updated code when a
  newer client contacts it. Since #53 the respawn moves onto the newer
  client's own copy (validated from its `clientRoot` hint), so a daemon
  spawned from a different copy than the one you updated follows the
  newer client. Clients older than #52 send no `clientRoot`; for them the
  respawn reuses the daemon's original argv and only picks up an in-place
  update of its spawning copy — `load-lock service restart` (since #38)
  re-spawns it from the current CLI copy.
- **npx-launched copies** (since #57) — skill / ACE / pinned MCP entries run
  `npx -y @aron98/load-lock@<pin>`, which installs a copy under the npm
  cache at `~/.npm/_npx/<hash>/node_modules/@aron98/load-lock/` (or under
  `$npm_config_cache/_npx`; `%LocalAppData%\npm-cache\_npx` on Windows).
  `doctor` lists these as `npx-cache`. They are owned by the pin that
  launches them: `load-lock update` refuses to touch them and points at
  bumping the pinned version (or the ACE artifact) instead.

The mirror drift — a *newer* adapter copy (opencode refreshed its cache)
with an *older* CLI on PATH — surfaces at adapter init (issue #38): the
plugin/MCP server prints one clear notice naming `load-lock update` and
embeds it in the injected context/instructions. Notify only, never
auto-install. See
[OPERATIONS.md](OPERATIONS.md#adapter-init-drift-notice) for the
in-memory-staleness limitation (a running session keeps the old adapter
code until the harness restarts).

`load-lock doctor` lists every copy it can find (PATH-resolved CLI, this
running copy, opencode cache copies) with versions and warns when they
drift. Detection is best-effort (never crashes on missing paths) and was
contract-tested with planted copies; the drift scenario itself was
observed live on this machine before the feature existed.

### Tier 2 — Claude Code / Codex CLI (hooks + MCP, live-verified)

`load-lock install --harness claude-code|codex` configures the MCP server
(user scope) plus hooks:

- **SessionStart** → policy brief + machine summary as developer context
  (matchers include `compact` so it re-fires after auto-compaction).
- **SubagentStart** (Codex) → same for spawned subagents.
- **Stop** → if the daemon has an offer whose entry cwd matches the session
  cwd, the hook continues the session with a claim instruction (decision
  block). Honors `stop_hook_active` to avoid loops; silent otherwise.
- **await-offer** (Claude Code, `async: true, asyncRewake: true`) → watches
  daemon events; on a matching offer exits 2 with a message that wakes an
  idle Claude. The token is deliberately NOT in that message (stderr may be
  shown); the agent claims via `pending`/`claim`.

**Tool names depend on the wiring.** A loose install (`load-lock install`)
registers the MCP server as `load-lock`, so Claude Code exposes
`mcp__load-lock__<tool>`. A plugin-bundled server is namespaced by plugin
and server key, `mcp__plugin_<plugin>_<server>__<tool>` (per the Claude Code
MCP docs), e.g. `mcp__plugin_load-lock-plugin_load-lock__claim` for the
`load-lock-plugin` Claude Code plugin. Every text
load-lock injects (policy brief, hook claim/wakeup messages, CLAUDE.md /
AGENTS.md sections, skill) therefore names tools neutrally ("the load-lock
`claim` tool") instead of hard-coding a prefix.

**Claude Code plugin** (`/plugin install load-lock-plugin@load-lock`, see
OPERATIONS "Claude Code plugin"): the same MCP server and hooks, bundled
and run through the dependency-free launcher; no skill, the detailed guide
comes from the `agent_guide` tool. Its manifest, hooks file and
marketplace entry are contract-tested (`src/test/plugin.test.ts`) and pass
`claude plugin validate --strict` (Claude Code 2.1.312), and the hook
commands are tested the way the plugin invokes them. Hooks use shell form
(one `command` string, `${CLAUDE_PLUGIN_ROOT}` quoted; #63).

**Plugin live verification** (#63; Claude Code 2.1.312, 2026-10-29, Linux
host): a real session with a throwaway `CLAUDE_CONFIG_DIR` and `HOME`,
load-lock isolated by `LOAD_LOCK_STATE_DIR` / `LOAD_LOCK_SOCKET`, the
plugin installed from this repo's marketplace with `claude plugin
marketplace add <checkout>` + `claude plugin install
load-lock-plugin@load-lock`, and the checkout's CLI first on `PATH`.
Headless `claude -p` and an interactive pty session. Status: **plugin
live-verified** for the checks marked observed:

| Check | Result |
| --- | --- |
| Shell-form hooks run, launcher takes the PATH branch | Observed (`load-lock launcher: path 1.5.0` on every hook) |
| SessionStart policy at startup | Observed (model quoted the isolated daemon's `load-lock now:` line) |
| SessionStart policy after `/compact` | Observed (`SessionStart:compact` hook ran; model quoted the fresh `1/1` line where the startup brief said `0/1`) |
| MCP tools named `mcp__plugin_load-lock-plugin_load-lock__<tool>` | Observed (all 19 tools listed under that prefix; server `plugin:load-lock-plugin:load-lock` connected) |
| `agent_guide` tool | Observed (called; returned the guide) |
| Stop offer continuation | Observed (headless: Stop hook returned `decision: block` with the offer token; model claimed and released) |
| `await-offer` idle wakeup (`async` + `asyncRewake`) | Observed (interactive: session idle ~18s, offer arrived, the watcher's exit 2 woke the session with a task notification; model ran `pending` → `claim` → `release`) |
| Daemon started by the plugin | Observed (fresh state dir; the daemon came up during session start with `CLAUDE_PLUGIN_ROOT` in its environment and `daemon.json` naming the PATH copy). Which plugin component spawned it first (hook or MCP server) was not determined. |
| Session-derived identity | Observed for the plugin MCP server (requests carried agent `claude-code:<session id>` matching the session's transcript). That hooks read the same `session_id` from stdin was not separately inspected. |
| Loose install + plugin together | Not observed (not run; covered by the #54 dedupe tests only) |
| Launcher npx / known-copy branches inside a live session | Not observed (only the PATH branch ran) |

The TUI labels the asyncRewake wake as "Stop hook blocking error from
command SessionStart:startup"; the message text is the watcher's.

Contract tests cover all hook stdin/stdout shapes against the documented
harness contracts. Claude Code is additionally **live-verified** (in Docker,
via `docker/run-claude-verify.sh` against the real `claude` CLI): SessionStart
policy brief in context at startup; the same brief re-injected after
`/compact` (the model quoted the fresh "load-lock now:" line, not a stale
copy); the full MCP round-trip acquire → queued → offer → claim →
`run_with_permit` → auto-release; the `Stop` hook decision-block live (async
watcher disabled so the stop path was exercised directly); the async
`await-offer` (`asyncRewake`) watcher waking an idle interactive session,
which then claimed and released; a `Task`-tool subagent using the MCP tools
and seeing the policy; and a `run_with_permit` background job that
outlived the `claude` process and was auto-released. One nuance: the TUI does
not render the async watcher's stderr wake text — the wake still works (the
session resumes and the claim round-trip succeeds), only the message is not
shown.

Codex CLI (0.163.0) is live-verified end-to-end in Docker
(`docker/verify-codex.sh`, driven through a real pty TUI session via
`docker/codex-pty.py`): SessionStart policy injection visible to the model,
MCP `status`/`acquire`/`claim`/`release` round-trip, FIFO queueing behind a
competing CLI holder, and Stop-hook `decision:"block"` wakeup that continues
the session with the claim instruction. The verification drives the real
interactive hook-trust review (the "Hooks need review" dialog) once —
`--dangerously-bypass-hook-trust` is deliberately NOT used because it forces
codex embedded mode, which never injects MCP tools (real users trust the
hooks once via `/hooks`; the installer prints this). Note: async background
hooks do not wake an idle Codex session — the Stop hook covers turn
boundaries only (verified as such).

Two upstream/provider constraints shaped the harness:

- Headless `codex exec` cannot inject MCP tools at all
  (openai/codex#38689), so live verification drives the interactive TUI
  through a pty.
- codex 0.163.0 declares MCP tools to the Responses API using the
  `namespace` tool type; the trustedtokens/GLM endpoint silently drops
  namespace tools, which made MCP tools invisible to the model even in the
  TUI. The verification container therefore fronts the API with
  `docker/codex-api-shim.js`, which rewrites namespaces to flat
  `mcp__<server>__<tool>` function tools on the wire (request, SSE
  response, and conversation history). This is a verification-harness
  workaround for the provider, not a change to load-lock itself.

### Tier 2 (contract-tested) — Cursor (hooks + MCP)

Cursor 1.7 (Sept 2025) introduced hooks as a beta with an under-documented
JSON contract — the original reason Cursor sat on the MCP-fallback tier
(issue #6: "do not ship against an unstable contract"). As of 2026-10-19 the
official docs at https://cursor.com/docs/hooks fully document the hooks
system with no beta caveats (per-event reference, common input schema, exit
codes, config-source priority, cloud-agent support, third-party hook
compatibility), so the contract is now treated as stable and the adapter
below shipped (issue #6).

`load-lock install --harness cursor --project <dir>` wires (all
project-level, merge-only, reversible by uninstall):

- **MCP server** — `mcpServers.load-lock` (stdio, absolute node path) in
  `<project>/.cursor/mcp.json` (documented project MCP config).
- **Stop hook** — flat hooks-v1 entry
  `{"type":"command","command":"<node> <cli> hook cursor stop"}` in
  `<project>/.cursor/hooks.json` (`{"version":1,"hooks":{"stop":[...]}}`;
  `version` is added only if absent, user entries preserved).
- **Rule** — dedicated `<project>/.cursor/rules/load-lock.mdc` with YAML
  frontmatter `alwaysApply: true` (note: plain `.md` files in
  `.cursor/rules` are ignored by Cursor — the rule must be `.mdc`).

The handler's documented stop contract: stdin carries `workspace_roots`
(no `cwd`) and `loop_count` (number of prior stop-hook followups for the
conversation); stdout JSON `{"followup_message":"..."}` is auto-submitted as
the next user message — Cursor's loop-style idle wakeup, analogous to
Claude/Codex `decision:"block"`. The handler is silent unless the daemon has
an offer matching `workspace_roots[0]`, and silent when `loop_count > 0`
(Cursor's equivalent of `stop_hook_active` — prevents wakeup loops;
Cursor's own `loop_limit` default of 5 per script is a second backstop).

**Verification status: contract-tested, not live-verified.** The stdin
parsing, followup payload, loop guard and silence paths are tested against
the documented contract in `src/test/hook.test.ts`; the install/uninstall
round-trip (user config preserved, idempotent re-install, clean bare-project
uninstall) is tested in `src/test/install.test.ts`. No Cursor install
exists on the verification machine, so end-to-end behavior inside the real
editor is unverified — the installer output says so explicitly. Sources:
official docs (https://cursor.com/docs/hooks, checked 2026-10-19), 1.7
release announcement (forum.cursor.com, Sept 2025), GitButler deep-dive
(Sept 2025), InfoQ coverage (Oct 2025).

### Tier 3 — MCP-only fallback (Gemini CLI, Copilot CLI, Cline, Roo Code, Goose)

The MCP server itself carries the policy in its `instructions`, every tool
result surfaces pending offers (tool-boundary delivery), and
`inspect_machine`/`get_config`/`configure` work unchanged.

**Every tier-3 MCP harness ships a first-class merge-only installer**
(Gemini CLI landed with issue #1; Copilot CLI, Cline, Roo Code
and Goose with issue #2). Cursor moved up to the hooks tier with its own
installer in issue #6 (see the Cursor section above). Each installer merges
into the harness's real config file
and never deletes anything the user wrote; `load-lock uninstall` removes
exactly the entries the installer added:

- **Gemini CLI** — `mcpServers.load-lock` (stdio) into
  `~/.gemini/settings.json` + a marked policy section in
  `~/.gemini/GEMINI.md`.
- **Copilot CLI** — `mcpServers.load-lock` (`type: local`) into
  `~/.copilot/mcp-config.json` (verify with `copilot mcp list`) + a marked
  section in `~/.copilot/copilot-instructions.md`. Hooks are reported in
  ecosystem content but unverified in official docs, so the installer ships
  none — no idle wakeup is claimed.
- **Cline** — `mcpServers.load-lock` into the MCP settings file
  (`~/.cline/data/settings/cline_mcp_settings.json`, or the path in
  `CLINE_MCP_SETTINGS_PATH`) + a dedicated `~/.cline/rules/load-lock.md`
  (our own file, so uninstall is a simple delete).
- **Roo Code** — `mcpServers.load-lock` into `<project>/.roo/mcp.json`
  (pass `--project`) plus every **existing** global `mcp_settings.json`
  (VS Code globalStorage for Roo/Zoo; existing files only — the installer
  never guesses storage paths) + a dedicated `~/.roo/rules/load-lock.md`.
- **Goose** — an `extensions.load-lock` stdio block (marker-tagged
  block-mapping YAML) into `~/.config/goose/config.yaml`
  (XDG_CONFIG_HOME respected) + a marked section in
  `~/.config/goose/.goosehints`.

Install/uninstall round-trips for all five are tested against a temp HOME
and validated against the harnesses' documented config schemas
(`src/test/install.test.ts`), but not live-verified against real
harnesses — hence *config-tested*.

`load-lock install --harness generic` still prints snippets for harnesses
without a dedicated installer.
Idle policy: these harnesses get no push notifications, so the PRIMARY
idle mechanism is the MCP `wait_for_turn` tool — a bounded, honest sleep
until it is the caller's turn. Queued agents call
the load-lock `wait_for_turn` tool (optionally with `timeout_ms`, default
600000, capped by the machine's `maxTurnWaitMs` config) and get a
structured result on every path: `granted` (the offer was auto-claimed —
`permit_token` included), `still_queued` (timeout, with queue position
and holders), `paused`/`cancelled`, or `not_found` (e.g. the daemon
restarted). The wait itself holds no permit and consumes no capacity;
harness tool cancellation aborts it cleanly. (Codex CLI note: async
background hooks never wake an idle session there either — the Stop hook
covers turn boundaries only — so the same `wait_for_turn` sleep is the
honest pattern for Codex subagents without hook wiring.)

Still missing on this tier: automatic context re-injection — there is no
push channel, so a woken agent relies on tool results (which carry
pending offers) rather than harness messages. We do not pretend these
harnesses got push notifications.

### omac — sandbox-profile grants (live-verified, issue #32)

omac runs agent harnesses inside a sandbox (bubblewrap + Landlock on
Linux, seatbelt on macOS) and strips the harness environment, allowing
through only what the user-global profile lists — so a load-lock client
inside omac cannot reach the host daemon without explicit grants.
`load-lock install --harness omac` merges three grants into
`~/.config/omac/sandbox-profiles/default.json` (merge-only, idempotent,
reversible by uninstall; omac parses profiles strictly so the installer
writes only known fields and never rewrites the user's bytes when
nothing changed):

- `filesystem.allow_unix_dir` += the load-lock state dir (AF_UNIX connect
  to the host daemon socket + read/write on the state dir);
- `filesystem.read` += the installed package tree — **only when load-lock
  lives outside an already-granted workdir** (a repo checkout needs
  nothing: the sandbox workdir grant covers it; a global bun/npm install
  does need it, see OPERATIONS.md gotcha #1);
- `environment.allow_vars` += `"LOAD_LOCK_*"` — one trailing-`*` prefix
  entry that passes all four client vars (`LOAD_LOCK_SOCKET`,
  `LOAD_LOCK_STATE_DIR`, `LOAD_LOCK_NO_SPAWN`, `LOAD_LOCK_LABEL_PREFIX`)
  through omac's env filter.

Verified live against omac 0.11.0 (see OPERATIONS.md for the exact
procedure and the two gotchas): profile accepted by omac's strict parser,
sandboxed CLI → host daemon round-trip, prefixed holder labels
(`omac:<label>`), client-only (`LOAD_LOCK_NO_SPAWN=1`) error contract, and
the global-install read grant proven necessary and sufficient
(ERR_MODULE_NOT_FOUND without it, working round-trip with it).
Install/uninstall round-trips are contract-tested in
`src/test/install.test.ts` (temp HOME: populated profile preserved,
idempotent re-install byte-identical, missing-profile creation, global
read grant, refusal on broken profiles).

### Tier 4 — Aider (manual CLI)

No MCP/hooks; nothing to install. Agents (or humans) use the CLI directly in
the shell: `load-lock acquire ... && load-lock run -- <cmd>` handles
acquire→run→release in one command line.

## Live dashboard surfaces (issue #10)

`load-lock dashboard` is portable and harness-agnostic: any integration that
spawns the daemon gets the same live dashboard in any terminal. The table
below is deliberately honest about what each harness gets **inside its own
UI** — where no UI surface exists, we say so rather than claim parity.

| Harness | In-harness dashboard | Also available |
| --- | --- | --- |
| **OpenCode** | Native TUI panel: `/load-lock` opens `load-lock.dashboard` **in-window** as a side panel (also opened by clicking the sidebar widget; deliberately **not** bound to any key — issue #28: the old `gl` sequence swallowed plain `g` typing, and the candidate `ctrl+g` is the host's `session.first` default) with pools, holder cards, offer claim-window countdowns, queue, paused, event feed, `inspect_machine`; home-footer `lock 1/1` indicator on the home screen plus a clickable, health-colored `load-lock 0/3` widget in the session sidebar; `x` force-release behind select + confirm. Implemented as the package's `./tui` companion plugin (main plugin unchanged). Live-verified: opencode 2.0.29 (panel render, palette/slash command, confirm-gated force-release) and opencode 2.0.32 in a real pty (sidebar widget render, click-to-open, in-window presentation, plain `g` reaches the composer, `ctrl+g` not intercepted by load-lock). | `load-lock dashboard` (alias `top`) |
| **Claude Code** | None in-app — load-lock ships no in-app view for Claude Code: `load-lock-plugin` bundles the MCP server + hooks only, and the loose install adds no UI either. The model can report status via the load-lock `status` MCP tool at tool boundaries, and each `SessionStart` hook injects a one-line machine summary. | `load-lock dashboard` (any terminal) |
| **Codex CLI** | None in-app — same reason. `load_lock_status` MCP tool; `SessionStart`/`SubagentStart` machine summary. | `load-lock dashboard` (alias `top`) |
| **Gemini CLI** | None in-app (no hooks, no UI plugin surface). `load_lock_status` MCP tool at tool boundaries. | `load-lock dashboard` (alias `top`) |
| **Copilot CLI, Cursor, Cline, Roo Code, Goose** | None in-app. MCP `status` tool where the MCP server is configured. | `load-lock dashboard` (alias `top`) |
| **omac** | None added by the omac installer — it only edits the sandbox profile; the inner harness keeps whatever surface its own adapter provides. | `load-lock dashboard` (alias `top`) |
| **Aider** | None (no MCP either). | `load-lock dashboard` (alias `top`) |

All dashboard surfaces are **read-only viewers that never acquire a
permit**; the single admin action (force-release) is gated behind an
explicit confirm. Data plumbing (event-cursor resume, daemon-restart
reconnect, view-model shaping, frame rendering) is covered by
`src/test/dashboard.test.ts`.

## Session identity per harness

The daemon routes offers, `pending` and op-key duplicate suppression by agent
id, so each harness session needs exactly one id, whichever wiring (CLI, MCP
server, hook) made the call. The default identity of the CLI (issue #49) and
of the MCP server (issue #50) comes from the shared resolver in
`src/shared/identity.ts`, first match wins:

1. explicit override: `--agent` (CLI), `agent_id` (MCP tools), or
   `LOAD_LOCK_AGENT`;
2. a harness session env var exported to the processes the harness spawns:
   `CLAUDE_CODE_SESSION_ID` → `claude-code:<session_id>` (the same value hooks
   receive as `session_id`; verified on Claude Code 2.1.x), and
   `OPENCODE_SESSION_ID` → the bare `sessionID` (exported by OpenCode's bash
   tool; verified on opencode 2.1.1). The bare id is exactly the native
   plugin's agent id, so CLI calls from an OpenCode shell share the plugin's
   identity;
3. the stable harness ancestor process (Linux): walk up from the CLI's parent
   past shells and launcher wrappers (`sh`/`bash`/`zsh`/…, `env`, `timeout`,
   `npm`/`npx`, nested `load-lock`) to the first other ancestor, identified as
   `proc:<pid>:<start time>` (pid-reuse safe via `/proc/<pid>/stat`), labelled
   `<comm>:<pid>`. This covers harnesses without a verified env var (Codex,
   Cursor, Gemini CLI, …), since one session = one long-lived harness process;
4. otherwise (no harness ancestor, or no `/proc` — macOS/Windows without a
   session env var) the legacy default: `cli:$USER@$HOSTNAME` for the CLI, a
   random per-process `agt_…` id for the MCP server.

So two MCP registrations in one session (plugin-bundled + standalone) share
one id: an `acquire` through one shows in `pending` through the other, and
both heartbeat the same id (idempotent). The CLI and the MCP server of one
session share an id too when both see the same session env var or the same
harness ancestor; whether a harness exports its session env var to MCP
server processes is not verified for every harness.

Labels stay human-readable: session-derived ids get a short holder label
(`claude-code:ee690007`, `codex:12345`); explicit ids label themselves.

| Harness | Identity | Notes |
| --- | --- | --- |
| OpenCode | plugin context `sessionID` (also MCP `_meta` when used); CLI via `OPENCODE_SESSION_ID` (same id) | automatic |
| Claude Code | hooks get `session_id`; CLI and MCP server via `CLAUDE_CODE_SESSION_ID`, else the harness ancestor; MCP tools also take explicit `agent_id` | automatic; explicit `agent_id` still wins |
| Codex | hooks get `session_id`; CLI and MCP server via harness ancestor process; MCP tools also take explicit `agent_id` | same |
| Cursor | hooks get `conversation_id` (no `cwd` — `workspace_roots[0]` identifies the request); CLI and MCP server via harness ancestor process; MCP tools also take explicit `agent_id` | same |
| omac (sandbox) | inner harness identity + `LOAD_LOCK_LABEL_PREFIX=omac` | dashboard shows holders as `omac:<label>` |
| Tier 3 | explicit `agent_id` argument; CLI and MCP server via harness ancestor process | MCP falls back to a per-server-process id only when no session is found |

## Platform matrix

| Platform | Status | Notes |
| --- | --- | --- |
| **Linux** | Implemented + live-verified | Primary target; all daemon/protocol/CLI tests and the 3-worktree demo run here. `/proc`-based liveness with start-time PID-reuse defense. |
| **macOS** | Implemented, limitations documented | Works; liveness falls back from `/proc` start times to `kill(pid, 0)` (weaker PID-reuse defense), no cgroup limits. See OPERATIONS.md. |
| **Windows** | Implemented, unit-tested on Linux — **not Windows-verified** | Named-pipe transport (`\\.\pipe\load-lock`), `%LOCALAPPDATA%` state dir, `kill(pid, 0)` liveness, `taskkill /T` job-tree kills. Covered by `src/test/platform.test.ts` via platform injection; no Windows machine was available for end-to-end verification. See the Windows procedure in OPERATIONS.md. |

## Verified vs proposed — summary counts

- Live-verified: OpenCode (full adapter, including wakeup); Claude Code
  (full adapter in Docker: policy injection, compact restore, Stop-hook and
  asyncRewake wakeup paths, subagents, background-job cleanup); Codex CLI
  (Docker, interactive TUI: policy injection, MCP round-trip, FIFO queueing
  behind a CLI holder, Stop-hook decision-block wakeup; exec-mode MCP
  injection blocked upstream — see Tier 2 notes); omac 0.11.0 (sandbox
  grants installer: profile accepted by omac's strict parser, sandboxed
  client → host daemon round-trip, `omac:`-prefixed labels,
  `LOAD_LOCK_NO_SPAWN=1` error contract, global-install read grant proven
  necessary and sufficient — see the omac section above and OPERATIONS.md).
- Contract-tested: Cursor (hooks-v1 stop-hook adapter + installer, tested
  against the officially documented hooks JSON contract; no Cursor install
  on the verification machine — see the Cursor section under Tier 2).
- Config-tested: Gemini CLI, Copilot CLI, Cline, Roo Code, Goose (installer
  round-trips, temp HOME; real harnesses not installed on the verification
  machine).
- Core daemon/protocol/CLI + adapters: 125 automated tests + scripted 3-worktree demo
  (three independent agent processes, real git worktrees, one pool), including
  9 dashboard tests (view-model shaping, event-cursor resume across a daemon
  restart, reconnect, and a `load-lock dashboard --once` render smoke test),
  9 bounded-wait tests (multi-process `wait_for_turn`: FIFO wake with
  auto-claim, timeout/pause/cancel/restart/abort paths, `maxTurnWaitMs` cap,
  MCP snake_case round trip) and 5 omac installer contract tests
  (populated-profile preservation, idempotent re-install, missing-profile
  creation, global-install read grant, broken-profile refusal).
- Proposed (researched capabilities, generic adapter only):
  Aider.
