# load-lock for OpenCode (ACE listing)

This folder exists so that [ACE](https://github.com/TNG/ace) lists the
load-lock OpenCode plugin. It holds no plugin logic. `index.js` re-exports
the published [`@aron98/load-lock`](https://www.npmjs.com/package/@aron98/load-lock)
package, and `package.json` pins the version that this repo's release ships.

ACE detects the folder through its npm-package heuristic, and ACE marks
every such detection as **"verify before registering"**. That is expected.

## Install

Install the published package, not this folder. Add `@aron98/load-lock` to
the `plugins` array of `~/.config/opencode/opencode.json`, then restart
OpenCode. OpenCode downloads and updates the package itself. If the load-lock
CLI is installed, `load-lock install --harness opencode` makes the same edit.

```json
{ "plugins": ["@aron98/load-lock"] }
```

See `docs/COMPATIBILITY.md` (OpenCode) in the load-lock repository for
what the plugin provides and which versions were verified live.
