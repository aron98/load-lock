# load-lock MCP server (ACE artifact)

This folder is the [ACE](https://github.com/TNG/ace) `mcp` artifact for
load-lock: a **local** (`transport: "stdio"`) MCP server that the agent host
starts with

```sh
npx -y @aron98/load-lock@<version> mcp
```

`load-lock mcp` is the same server as the package's `load-lock-mcp` binary.
The command goes through the default `load-lock` bin so that ACE's
`mcp_local_command_safe` check shows reviewers the real package name
(`@aron98/load-lock@<version>`). The first call starts the shared per-user
daemon (state in `~/.local/state/load-lock`); every later client reuses it.

**Install either this MCP server or the load-lock Claude Code plugin, not
both.** The plugin already bundles this server. Installing both gives two
registrations of the same tools. That is harmless (one daemon, one identity
per session), but redundant.

Keep this folder to `mcp.json` and this README: ACE checks every file under
`bin/`, `scripts/`, `config/` and `references/` against `companion_files`.
The `<version>` pin is kept in sync with `package.json` by
`scripts/check-pins.mjs` (`npm run check-pins -- --write` at release).
