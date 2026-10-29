# AGENTS.md

`@aron98/load-lock` — machine-wide counting semaphore coordinating heavy work
across parallel coding agents. Single TypeScript ESM package, no monorepo.
Node >= 20 required.

## Commands

```sh
npm run build        # tsc -p tsconfig.json  (compiles src/ -> dist/)
npm test             # builds, then node --test dist/test/*.test.js
npm run typecheck    # tsc --noEmit
```

There is no lint or formatter config — don't add one unasked.

**Tests run compiled output.** Tests are TypeScript compiled to `dist/`, so
rebuild (`npm run build`) after editing source before re-running tests.

Single test file / single test:

```sh
npm run build && node --test dist/test/daemon.test.js
node --test --test-name-pattern "offer" dist/test/core.test.js
```

## Testing quirks

- Tests are integration-heavy: they spawn real daemons as child processes in
  temp state dirs (under `$(tmpdir)/opencode/`), use real processes/ptys, and
  cover restarts, races, expiry, PID-reuse. The full suite is genuinely
  heavy — acquire a load-lock permit before running it (yes, this repo is
  its own first customer).
- Test daemons are isolated via `LOAD_LOCK_STATE_DIR` and `LOAD_LOCK_SOCKET`
  env overrides (see `src/test/testutil.ts`). Always use these in new tests —
  never touch the user's real state dir `~/.local/state/load-lock`.
- `src/test/testutil.ts` is a helper, not a test file (excluded by the
  `*.test.js` pattern); path constants there resolve binaries from `dist/`,
  not `src/`.

## Layout & architecture

- `src/core/` — daemon (`daemon-main.ts` entry, `daemon.ts` loop), state
  machine (`state.ts`), journal/persistence (`persist.ts`), machine
  inspection (`sysinfo.ts`). The daemon is a long-lived process,
  auto-spawned by clients on first use, communicating over a Unix socket.
- `src/shared/` — `protocol.ts` (wire types, zod) and `client.ts` (client +
  daemon spawn logic). All adapters and the CLI talk through this; protocol
  changes ripple everywhere.
- `src/mcp/` — universal MCP stdio server (`main.ts` entry) for harnesses
  without a native adapter.
- `src/adapters/opencode/` — native OpenCode plugin (`plugin.ts`) and TUI
  dashboard panel (`tui.tsx`). Note: `package.json`'s root export (`.`)
  points at the plugin, not a library index.
- `src/cli/` — `main.ts` (CLI + installer + doctor/top/run/wait),
  `hook.ts` (harness hook handlers), `top.ts`.
- `src/policy/text.ts` — the policy text injected into agent contexts;
  keep it in sync with actual tool semantics.
- `src/dashboard/` — feed/frame/view model shared by the TUI panel and
  `load-lock top`.
- `plugins/claude-code/` — Claude Code plugin `load-lock-plugin` (manifest,
  `hooks/hooks.json`, committed dependency-free launcher
  `scripts/load-lock.mjs`; no build, no `dist/`), listed by the root
  `.claude-plugin/marketplace.json`. Keep it to ACE's plugin layout (no
  `package.json`, no `SKILL.md`; see `src/test/plugin.test.ts`).
- `src/test/`, `demo/` (3-worktree repro script), `skills/load-lock/SKILL.md`
  (packaged skill), `docs/` (ARCHITECTURE / OPERATIONS / COMPATIBILITY /
  AGENT_GUIDE / ADAPTERS — authoritative for design decisions).

## Conventions

- ESM with NodeNext resolution: relative imports in TS source need explicit
  `.js` extensions.
- TSX only in the OpenCode TUI adapter (`jsxImportSource: @opentui/solid`);
  the opentui/solid-js deps are optional peers — never import them from
  core/shared/cli code.
- Installers for every harness must be merge-only/non-destructive and
  reversible by uninstall; contract-test them via temp-HOME round-trips
  (see `src/test/install.test.ts`).

## CI & release

- CI (`.github/workflows/ci.yml`): Node 20 + 24 matrix; `npm ci` → build →
  `node --test`; plus an install-from-tarball smoke job and a `pins` job.
- Version pins: `scripts/check-pins.mjs` (plain JS, declared `PINNED` list)
  checks every pinned `@aron98/load-lock@<version>` against `package.json`;
  the release commit runs `npm run check-pins -- --write`. See "Releasing"
  in `docs/OPERATIONS.md`.
- Publishing (`publish.yml`) is triggered by a GitHub Release, uses npm
  Trusted Publishing (OIDC, no tokens), requires Node 24. Read its comments
  before touching the release flow.
