# load-lock-plugin (Claude Code)

The Claude Code plugin for [load-lock](https://github.com/aron98/load-lock),
a machine-wide heavy-work budget shared by parallel coding agents.

```text
/plugin marketplace add aron98/load-lock
/plugin install load-lock-plugin@load-lock
```

It provides:

- the load-lock MCP server, so the tools are named
  `mcp__plugin_load-lock-plugin_load-lock__<tool>` (for example `acquire`,
  `claim`, `agent_guide`);
- a `SessionStart` hook that injects the policy brief at startup and again
  after compaction;
- a `Stop` hook and an async `await-offer` watcher (`asyncRewake`) that wake
  the session when capacity is offered to it.

The plugin has no skill. Install the `load-lock` skill separately if you
want it; the full guide is also available through the `agent_guide` tool.

## Runtime

The plugin ships no compiled code. `scripts/load-lock.mjs` (dependency-free)
runs `load-lock` from PATH when it is at least the plugin's version, else a
runtime copy known to the local daemon, else
`npx --yes --package=@aron98/load-lock@<version>`. Hooks never use the
network (npx `--offline`), are time-bounded, and exit 0 on any failure, so
a missing runtime never breaks a session. The MCP server's first start may
download the package through npx. To avoid that, install the CLI once:
`npm i -g @aron98/load-lock`.

Details: `docs/OPERATIONS.md` ("Plugin launcher", "Claude Code plugin").
