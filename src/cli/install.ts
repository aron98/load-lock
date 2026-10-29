/**
 * `load-lock install --harness <id>` — wires load-lock into a harness.
 *
 * Everything here MERGES into existing files; unrelated user config is never
 * touched. Our own entries are tagged (LL marker / absolute paths into this
 * package) so uninstall removes exactly what install added.
 *
 * Harnesses:
 *  - opencode     : registers the published npm package in the `plugins`
 *                   array of ~/.config/opencode/opencode.json (opencode
 *                   resolves/installs/updates the package itself; legacy
 *                   local-stub installs are migrated away automatically).
 *  - claude-code  : user-scope MCP server in ~/.claude.json, SessionStart /
 *                   Stop hooks + background await-offer watcher in
 *                   ~/.claude/settings.json, CLAUDE.md section, skill.
 *  - codex        : ~/.codex/hooks.json (SessionStart/SubagentStart/Stop),
 *                   [mcp_servers.load-lock] in ~/.codex/config.toml,
 *                   ~/.codex/AGENTS.md pointer. Trust must be granted via /hooks.
 *  - gemini-cli   : mcpServers.load-lock in ~/.gemini/settings.json,
 *                   marked section in ~/.gemini/GEMINI.md. MCP-fallback
 *                   tier: Gemini CLI has no hooks and no async push (no
 *                   idle wakeup) — offers surface at tool boundaries.
 *  - copilot-cli  : mcpServers.load-lock (type "local" / stdio) in
 *                   ~/.copilot/mcp-config.json, marked section in the
 *                   global ~/.copilot/copilot-instructions.md. MCP-fallback
 *                   tier: Copilot CLI hooks are ecosystem-reported but NOT
 *                   verified in official docs — we install none.
 *  - cline        : mcpServers.load-lock in
 *                   ~/.cline/data/settings/cline_mcp_settings.json
 *                   (honors CLINE_MCP_SETTINGS_PATH), own rule file in
 *                   ~/.cline/rules/. MCP-fallback tier: no hooks.
 *  - roo-code     : project .roo/mcp.json (+ global Roo/Zoo mcp_settings.json
 *                   when a VS Code globalStorage copy exists), own rule
 *                   file in ~/.roo/rules/. MCP-fallback tier: no hooks.
 *  - goose        : extensions.load-lock (type: stdio) merged into
 *                   ~/.config/goose/config.yaml, marked section in the
 *                   global hints file ~/.config/goose/.goosehints.
 *                   MCP-fallback tier: no hooks.
 *  - cursor       : project-level (per --project) .cursor/mcp.json
 *                   (mcpServers.load-lock stdio), stop hook in
 *                   .cursor/hooks.json (hooks v1: {"followup_message":...}
 *                   continuation = idle wakeup), own Always-apply rule
 *                   .cursor/rules/load-lock.mdc. Contract-tested against
 *                   the documented hooks JSON; not live-verified.
 *  - generic      : prints an MCP stdio config snippet (any MCP-capable harness).
 *  - omac         : merges load-lock grants into omac's user-global sandbox
 *                   profile (~/.config/omac/sandbox-profiles/default.json):
 *                   filesystem.allow_unix_dir += the state dir (host-daemon
 *                   socket bridge), filesystem.read += the installed package
 *                   tree when load-lock lives outside any granted workdir
 *                   (global bun/npm installs; gotcha verified live), and
 *                   environment.allow_vars += "LOAD_LOCK_*". omac parses
 *                   profiles strictly (unknown fields are errors) and never
 *                   rewrites a profile it has created, so the installer only
 *                   writes known fields and touches nothing else.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { POLICY_BRIEF } from "../policy/text.js";
import { resolveStateDir } from "../shared/transport.js";

export interface InstallOptions {
  harness: string;
  project: string;
  json?: boolean;
  global?: boolean;
  binDir?: string; // dist/cli — lets us locate package root
}

export interface UninstallOptions {
  harness: string;
  project: string;
}

const HOME = os.homedir();
const PKG_NAME = "@aron98/load-lock";

export function pkgRoot(binDir?: string): string {
  const d = binDir ?? path.join(import.meta.dirname ?? ".", ".."); // dist/cli -> dist
  return path.resolve(d, ".."); // dist -> package root
}

function pkgPaths(binDir?: string) {
  const root = pkgRoot(binDir);
  return {
    root,
    cli: path.join(root, "dist", "cli", "main.js"),
    mcp: path.join(root, "dist", "mcp", "main.js"),
    docs: path.join(root, "docs"),
    skill: path.join(root, "skills", "load-lock", "SKILL.md"),
    node: process.execPath,
  };
}

function say(opts: { json?: boolean }, msg: string) {
  if (!opts.json) process.stdout.write(msg + "\n");
}

// ---------------------------------------------------------------- io helpers

function readJson(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

function writeJson(file: string, data: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp-ll-" + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

/** Atomic plain-text write (used for YAML / hints files). */
function writeText(file: string, text: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp-ll-" + process.pid;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

/**
 * Append a marked section to a markdown file once. The section must start with
 * `marker`; exactly one newline separates the user's existing bytes from it, so
 * a removeMdSection round-trip restores the original bytes exactly.
 */
function mdSection(file: string, marker: string, section: string): boolean {
  const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  if (existing.includes(marker)) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, existing === "" ? section : existing + "\n" + section);
  return true;
}

function removeMdSection(file: string, marker: string) {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, "utf8");
  const idx = text.indexOf(marker);
  if (idx === -1) return;
  const next = text.indexOf(marker, idx + marker.length);
  const end = next === -1 ? text.length : next;
  // mdSection put exactly one newline before our section; take it back.
  const start = idx > 0 && text[idx - 1] === "\n" ? idx - 1 : idx;
  fs.writeFileSync(file, text.slice(0, start) + text.slice(end));
}

/**
 * Collect every string value of `key` anywhere in a nested object/array
 * (hook entries nest the command inside a `hooks` array for Claude Code and
 * Codex; Cursor hooks v1 keep it at the top level).
 */
function collectCommandStrings(e: unknown, key = "command", out: string[] = []): string[] {
  if (Array.isArray(e)) {
    for (const v of e) collectCommandStrings(v, key, out);
  } else if (typeof e === "object" && e !== null) {
    for (const [k, v] of Object.entries(e)) {
      if (k === key && typeof v === "string") out.push(v);
      else collectCommandStrings(v, key, out);
    }
  }
  return out;
}

/**
 * Is this hooks entry ours? Our hook commands are
 * `<node> "<...>/dist/cli/main.js" hook <harness> <sub>`, matched on the
 * JSON-quoted cli path plus the ` hook <harness> ` marker INSIDE the actual
 * command string. Substring-matching a re-serialized entry with an un-quoted
 * path never matches our own entries — re-serialization escapes the path's
 * closing quote (`main.js\" hook`) — which made install duplicate hook
 * entries and uninstall leave them behind (issue #19).
 */
function isOurHook(e: unknown, cliPath: string, harness: string): boolean {
  const tag = ` hook ${harness} `;
  return collectCommandStrings(e).some((c) => c.includes(JSON.stringify(cliPath)) && c.includes(tag));
}

// ------------------------------------------------------------------ opencode

function installOpenCode(opts: InstallOptions, P: ReturnType<typeof pkgPaths>): string[] {
  const actions: string[] = [];
  const pluginDir = path.join(HOME, ".config", "opencode", "plugins", "load-lock");

  // Migrate away from the legacy stub dir (pre-publish installs used a
  // local stub with a file: symlink dep, which bun does not resolve).
  if (fs.existsSync(pluginDir)) {
    fs.rmSync(pluginDir, { recursive: true, force: true });
    actions.push(`removed legacy plugin stub ${pluginDir}`);
  }

  // Register the published npm package; opencode resolves, installs and
  // updates it itself (shows up in /plugins with the real version).
  const cfgFile = path.join(HOME, ".config", "opencode", "opencode.json");
  const cfg = readJson(cfgFile) ?? {};
  if (!Array.isArray(cfg.plugins)) cfg.plugins = [];
  const before = cfg.plugins.length;
  cfg.plugins = cfg.plugins.filter((p: unknown) => p !== pluginDir && p !== PKG_NAME);
  cfg.plugins.push(PKG_NAME);
  writeJson(cfgFile, cfg);
  actions.push(`plugins entry "${PKG_NAME}" in ${cfgFile}`);
  if (before !== cfg.plugins.length) actions.push("(replaced legacy plugins entry)");

  actions.push("restart or reload your opencode service to load the plugin");
  return actions;
}

function uninstallOpenCode(): string[] {
  const actions: string[] = [];
  const pluginDir = path.join(HOME, ".config", "opencode", "plugins", "load-lock");
  if (fs.existsSync(pluginDir)) {
    fs.rmSync(pluginDir, { recursive: true, force: true });
    actions.push(`removed ${pluginDir}`);
  }
  const cfgFile = path.join(HOME, ".config", "opencode", "opencode.json");
  const cfg = readJson(cfgFile);
  if (cfg && Array.isArray(cfg.plugins)) {
    const before = cfg.plugins.length;
    cfg.plugins = cfg.plugins.filter((p: unknown) => p !== pluginDir && p !== PKG_NAME);
    if (cfg.plugins.length !== before) {
      writeJson(cfgFile, cfg);
      actions.push(`removed plugins entry from ${cfgFile}`);
    }
  }
  return actions;
}

// -------------------------------------------------------------- claude-code

function hookEntry(P: ReturnType<typeof pkgPaths>, event: string, extra?: Record<string, unknown>) {
  const cmd = `${P.node} ${JSON.stringify(P.cli)} hook claude-code`;
  return {
    hooks: [
      {
        type: "command",
        command:
          event === "session-start"
            ? `${cmd} session-start`
            : event === "stop"
              ? `${cmd} stop`
              : `${cmd} await-offer`,
        ...extra,
      },
    ],
  };
}

function installClaudeCode(opts: InstallOptions, P: ReturnType<typeof pkgPaths>): string[] {
  const actions: string[] = [];

  // 1. user-scope MCP server in ~/.claude.json
  const claudeJson = path.join(HOME, ".claude.json");
  const cj = readJson(claudeJson) ?? {};
  if (typeof cj !== "object" || cj === null) throw new Error(`${claudeJson} is not a JSON object; refusing to overwrite`);
  if (!cj.mcpServers || typeof cj.mcpServers !== "object") cj.mcpServers = {};
  cj.mcpServers["load-lock"] = { type: "stdio", command: P.node, args: [P.mcp] };
  writeJson(claudeJson, cj);
  actions.push(`MCP server "load-lock" in ${claudeJson}`);

  // 2. hooks in ~/.claude/settings.json (merge; replace only our own entries)
  const settingsFile = path.join(HOME, ".claude", "settings.json");
  const s = readJson(settingsFile) ?? {};
  if (!s.hooks || typeof s.hooks !== "object") s.hooks = {};
  const cc = (event: string, entries: any[]) => {
    const prev = Array.isArray(s.hooks[event]) ? s.hooks[event] : [];
    const kept = prev.filter((e: any) => !isOurHook(e, P.cli, "claude-code"));
    s.hooks[event] = [...kept, ...entries];
  };
  cc("SessionStart", [hookEntry(P, "session-start")]);
  cc("Stop", [hookEntry(P, "stop")]);
  // background watcher: async + asyncRewake wakes Claude (exit 2 + stderr)
  s.hooks.SessionStart.push(hookEntry(P, "await-offer", { async: true, asyncRewake: true }));
  writeJson(settingsFile, s);
  actions.push(`hooks (SessionStart policy, Stop offer wakeup, await-offer watcher) in ${settingsFile}`);

  // 3. CLAUDE.md pointer
  const md = path.join(HOME, ".claude", "CLAUDE.md");
  const marker = "<!-- load-lock:begin -->";
  if (
    mdSection(
      md,
      marker,
      `${marker}\n## load-lock: machine-wide heavy-work budget\n\n` +
        `Before resource-intensive local work (full builds, big test suites), coordinate with other agents on this machine:\n\n` +
        `1. Call the load-lock \`acquire\` tool (reason + op_key) — it grants a permit or queues you.\n` +
        `2. While queued, keep doing light work. When an offer arrives (hook wakeup or the \`pending\` tool), claim it via the \`claim\` tool within the window (default 30s).\n` +
        `3. Only start heavy work after acquire/claim succeeds. Use \`run_with_permit\` for full lifecycle ownership (auto-release), or \`attach_pid\` for processes you already started.\n` +
        `4. Release (or cancel queued work) promptly. Inspect the machine with \`inspect_machine\`; adjust capacity via \`configure\` when warranted.\n\n` +
        `Exact tool names vary with the wiring (standalone MCP server vs. plugin); use the load-lock tools you have.\n\n` +
        `Full guide: \`load-lock agent-guide\`.\n<!-- load-lock:end -->\n`,
    )
  )
    actions.push(`CLAUDE.md section in ${md}`);

  // 4. skill
  const skillDir = path.join(HOME, ".claude", "skills", "load-lock");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.copyFileSync(P.skill, path.join(skillDir, "SKILL.md"));
  actions.push(`skill in ${skillDir}/SKILL.md`);
  return actions;
}

function uninstallClaudeCode(): string[] {
  const actions: string[] = [];
  const P = pkgPaths(); // cli path for our-entry matching below
  const claudeJson = path.join(HOME, ".claude.json");
  const cj = readJson(claudeJson);
  if (cj?.mcpServers && typeof cj.mcpServers === "object" && "load-lock" in cj.mcpServers) {
    delete cj.mcpServers["load-lock"];
    writeJson(claudeJson, cj);
    actions.push(`removed MCP server from ${claudeJson}`);
  }
  const settingsFile = path.join(HOME, ".claude", "settings.json");
  const s = readJson(settingsFile);
  if (s?.hooks && typeof s.hooks === "object") {
    let changed = false;
    for (const ev of Object.keys(s.hooks)) {
      const list = s.hooks[ev];
      if (Array.isArray(list)) {
        const kept = list.filter((e: any) => !isOurHook(e, P.cli, "claude-code"));
        if (kept.length !== list.length) {
          changed = true;
          if (kept.length) s.hooks[ev] = kept;
          else delete s.hooks[ev];
        }
      }
    }
    if (Object.keys(s.hooks).length === 0) delete s.hooks;
    if (changed) {
      // If nothing but our bare-install shape remains, the file is ours.
      if (Object.keys(s).length === 0) {
        fs.rmSync(settingsFile);
        actions.push(`removed ${settingsFile} (nothing else was in it)`);
      } else {
        writeJson(settingsFile, s);
        actions.push(`removed hooks from ${settingsFile}`);
      }
    }
  }
  const md = path.join(HOME, ".claude", "CLAUDE.md");
  removeMdSection(md, "<!-- load-lock:begin -->");
  actions.push(`removed CLAUDE.md section`);
  fs.rmSync(path.join(HOME, ".claude", "skills", "load-lock"), { recursive: true, force: true });
  pruneEmptyDirs(path.join(HOME, ".claude", "skills"), path.join(HOME, ".claude"));
  actions.push("removed skill");
  return actions;
}

// --------------------------------------------------------------------- codex

function installCodex(opts: InstallOptions, P: ReturnType<typeof pkgPaths>): string[] {
  const actions: string[] = [];
  const codexHome = process.env.CODEX_HOME ?? path.join(HOME, ".codex");

  // 1. hooks.json (merge by replacing only our entries)
  const hooksFile = path.join(codexHome, "hooks.json");
  const h = readJson(hooksFile) ?? {};
  if (typeof h !== "object" || h === null) throw new Error(`${hooksFile} is not a JSON object; refusing to overwrite`);
  if (!h.hooks || typeof h.hooks !== "object") h.hooks = {};
  const mk = (event: string, sub: string) => [
    {
      hooks: [
        {
          type: "command",
          command: `${P.node} ${JSON.stringify(P.cli)} hook codex ${sub}`,
        },
      ],
    },
  ];
  const mergeEv = (event: string, entries: any[]) => {
    const prev = Array.isArray(h.hooks[event]) ? h.hooks[event] : [];
    h.hooks[event] = [...prev.filter((e: any) => !isOurHook(e, P.cli, "codex")), ...entries];
  };
  mergeEv("SessionStart", [{ matcher: "startup|resume|clear|compact|fork", hooks: [{ type: "command", command: `${P.node} ${JSON.stringify(P.cli)} hook codex session-start` }] }]);
  mergeEv("SubagentStart", [{ matcher: "*", hooks: [{ type: "command", command: `${P.node} ${JSON.stringify(P.cli)} hook codex subagent-start` }] }]);
  mergeEv("Stop", mk("Stop", "stop"));
  writeJson(hooksFile, h);
  actions.push(`hooks in ${hooksFile} (SessionStart/SubagentStart/Stop)`);

  // 2. MCP server in config.toml (append block only if absent)
  const tomlFile = path.join(codexHome, "config.toml");
  fs.mkdirSync(codexHome, { recursive: true });
  const toml = fs.existsSync(tomlFile) ? fs.readFileSync(tomlFile, "utf8") : "";
  // 2. MCP server in config.toml (append block only if absent).
  // Match only a real table header at line start - a comment or docs text
  // mentioning the section must not be treated as "already installed".
  if (!/^\[mcp_servers\.load-lock\]\s*$/m.test(toml)) {
    fs.writeFileSync(
      tomlFile,
      toml +
        (toml.endsWith("\n") ? "" : "\n") +
        `\n# load-lock (added by \`load-lock install\`)\n[mcp_servers.load-lock]\n` +
        `command = ${JSON.stringify(P.node)}\n` +
        `args = [${JSON.stringify(P.mcp)}]\n`,
    );
    actions.push(`[mcp_servers.load-lock] appended to ${tomlFile}`);
  } else {
    actions.push(`[mcp_servers.load-lock] already present in ${tomlFile}`);
  }

  // 3. AGENTS.md pointer
  const agentsMd = path.join(codexHome, "AGENTS.md");
  if (
    mdSection(
      agentsMd,
      "<!-- load-lock:begin -->",
      `<!-- load-lock:begin -->\n## load-lock: machine-wide heavy-work budget\n\n` +
        `Before resource-intensive local work (full builds, big test suites), coordinate with other agents on this machine via the \`load-lock\` MCP tools (acquire / claim / release / run_with_permit / pending / status / inspect_machine / configure). ` +
        `Acquire before heavy work, keep doing light work while queued, claim offers promptly (they expire), release when done. Full guide: \`load-lock agent-guide\`.\n<!-- load-lock:end -->\n`,
    )
  )
    actions.push(`AGENTS.md section in ${agentsMd}`);

  actions.push("IMPORTANT: run `/hooks` inside Codex and grant trust to the new hooks (they are inert until trusted)");
  return actions;
}

function uninstallCodex(): string[] {
  const actions: string[] = [];
  const P = pkgPaths(); // cli path for our-entry matching below
  const codexHome = process.env.CODEX_HOME ?? path.join(HOME, ".codex");
  const hooksFile = path.join(codexHome, "hooks.json");
  const h = readJson(hooksFile);
  if (h?.hooks && typeof h.hooks === "object") {
    let changed = false;
    for (const ev of Object.keys(h.hooks)) {
      const list = h.hooks[ev];
      if (Array.isArray(list)) {
        const kept = list.filter((e: any) => !isOurHook(e, P.cli, "codex"));
        if (kept.length !== list.length) {
          changed = true;
          if (kept.length) h.hooks[ev] = kept;
          else delete h.hooks[ev];
        }
      }
    }
    if (Object.keys(h.hooks).length === 0) delete h.hooks;
    if (changed) {
      // If nothing but our bare-install shape remains, the file is ours.
      if (Object.keys(h).length === 0) {
        fs.rmSync(hooksFile);
        actions.push(`removed ${hooksFile} (nothing else was in it)`);
      } else {
        writeJson(hooksFile, h);
        actions.push(`removed hooks from ${hooksFile}`);
      }
    }
  }
  const tomlFile = path.join(codexHome, "config.toml");
  if (fs.existsSync(tomlFile)) {
    const toml = fs.readFileSync(tomlFile, "utf8");
    const re = /\n?# load-lock \(added by `load-lock install`\)\n\[mcp_servers\.load-lock\]\n[^\n]*\n[^\n]*\n/;
    if (re.test(toml)) {
      fs.writeFileSync(tomlFile, toml.replace(re, ""));
      actions.push(`removed [mcp_servers.load-lock] from ${tomlFile}`);
    }
  }
  const agentsMd = path.join(codexHome, "AGENTS.md");
  removeMdSection(agentsMd, "<!-- load-lock:begin -->");
  actions.push("removed AGENTS.md section");
  return actions;
}

// ---------------------------------------------------------------- gemini-cli

function installGeminiCli(opts: InstallOptions, P: ReturnType<typeof pkgPaths>): string[] {
  const actions: string[] = [];

  // 1. mcpServers.load-lock in ~/.gemini/settings.json (merge; replace only
  //    our own entry). Gemini CLI's stdio shape is { command, args } — the
  //    presence of `command` selects the stdio transport.
  const settingsFile = path.join(HOME, ".gemini", "settings.json");
  const s = readJson(settingsFile) ?? {};
  if (typeof s !== "object" || s === null || Array.isArray(s)) {
    throw new Error(`${settingsFile} is not a JSON object; refusing to overwrite`);
  }
  if (!s.mcpServers || typeof s.mcpServers !== "object" || s.mcpServers === null) s.mcpServers = {};
  s.mcpServers["load-lock"] = { command: P.node, args: [P.mcp] };
  writeJson(settingsFile, s);
  actions.push(`MCP server "load-lock" (stdio) in ${settingsFile}`);

  // 2. marked policy section in ~/.gemini/GEMINI.md (global instructions file)
  const geminiMd = path.join(HOME, ".gemini", "GEMINI.md");
  const marker = "<!-- load-lock:begin -->";
  if (
    mdSection(
      geminiMd,
      marker,
      `${marker}\n## load-lock: machine-wide heavy-work budget\n\n` +
        `Before resource-intensive local work (full builds, big test suites), coordinate with other agents on this machine:\n\n` +
        `1. Call the \`load-lock\` MCP \`acquire\` tool (reason + op_key) — it grants a permit or queues you. Pass \`wait_ms\` for a bounded blocking wait, or keep doing light work while queued.\n` +
        `2. Offers surface in every tool result (tool-boundary delivery) — check \`pending\` and claim promptly via \`claim\` within the window (default 30s); expired offers pass capacity to the next waiter.\n` +
        `3. Only start heavy work after acquire/claim succeeds. Prefer \`run_with_permit\` for full lifecycle ownership (auto-release), or \`attach_pid\` / \`mark_started\` for processes you already started.\n` +
        `4. Release (or cancel queued work) promptly when done. Inspect the machine with \`inspect_machine\`; adjust capacity via \`configure\` when warranted.\n\n` +
        `Note: Gemini CLI has no hooks and no async push — there is NO idle wakeup. You discover offers at your next tool call or via a bounded \`wait_ms\`.\n` +
        `Full guide: \`load-lock agent-guide\`.\n<!-- load-lock:end -->\n`,
    )
  )
    actions.push(`GEMINI.md section in ${geminiMd}`);

  // 3. be honest about the tier
  actions.push(
    "tier: MCP fallback — offers arrive at tool boundaries (tool-result delivery + bounded wait_ms); " +
      "Gemini CLI has no hooks and no async push, so there is no idle wakeup",
  );
  actions.push("restart Gemini CLI to pick up the MCP server");
  return actions;
}

function uninstallGeminiCli(): string[] {
  const actions: string[] = [];
  const settingsFile = path.join(HOME, ".gemini", "settings.json");
  const s = readJson(settingsFile);
  if (s?.mcpServers && typeof s.mcpServers === "object" && "load-lock" in s.mcpServers) {
    delete s.mcpServers["load-lock"];
    writeJson(settingsFile, s);
    actions.push(`removed MCP server from ${settingsFile}`);
  }
  const geminiMd = path.join(HOME, ".gemini", "GEMINI.md");
  removeMdSection(geminiMd, "<!-- load-lock:begin -->");
  actions.push("removed GEMINI.md section");
  return actions;
}

// ------------------------------------------------- shared MCP-fallback bits

/** XDG-ish config home (~/.config on Linux/macOS default). */
function configHome(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  return xdg && xdg.trim() ? path.resolve(xdg) : path.join(HOME, ".config");
}

/**
 * Policy section for MCP-fallback-tier harnesses (no hooks, no async push).
 * `note` states the harness-specific honesty line (never claim wakeup).
 */
function fallbackSection(note: string): string {
  return (
    `## load-lock: machine-wide heavy-work budget\n\n` +
    `Before resource-intensive local work (full builds, big test suites), coordinate with other agents on this machine:\n\n` +
    `1. Call the \`load-lock\` MCP \`acquire\` tool (reason + op_key) — it grants a permit or queues you. Pass \`wait_ms\` for a bounded blocking wait, or keep doing light work while queued.\n` +
    `2. Offers surface in every tool result (tool-boundary delivery) — check \`pending\` and claim promptly via \`claim\` within the window (default 30s); expired offers pass capacity to the next waiter.\n` +
    `3. Only start heavy work after acquire/claim succeeds. Prefer \`run_with_permit\` for full lifecycle ownership (auto-release), or \`attach_pid\` / \`mark_started\` for processes you already started.\n` +
    `4. Release (or cancel queued work) promptly when done. Inspect the machine with \`inspect_machine\`; adjust capacity via \`configure\` when warranted.\n\n` +
    `Note: ${note}\n` +
    `Full guide: \`load-lock agent-guide\`.\n`
  );
}

const NO_WAKEUP_NOTE = (h: string) =>
  `${h} has no hooks and no async push — there is NO idle wakeup. You discover offers at your next tool call or via a bounded \`wait_ms\`.`;

/** Merge `key` under `obj.mcpServers` in a JSON settings file (create-safe). */
function mergeMcpServer(
  file: string,
  entry: Record<string, unknown>,
  action: string,
): string[] {
  const cfg = readJson(file) ?? {};
  if (typeof cfg !== "object" || cfg === null || Array.isArray(cfg)) {
    throw new Error(`${file} is not a JSON object; refusing to overwrite`);
  }
  if (!cfg.mcpServers || typeof cfg.mcpServers !== "object" || cfg.mcpServers === null) {
    cfg.mcpServers = {};
  }
  cfg.mcpServers["load-lock"] = entry;
  writeJson(file, cfg);
  return [action];
}

/** Remove our `mcpServers["load-lock"]` from a JSON settings file, if present. */
function removeMcpServer(file: string, action: string): string[] {
  const actions: string[] = [];
  const cfg = readJson(file);
  if (cfg?.mcpServers && typeof cfg.mcpServers === "object" && "load-lock" in cfg.mcpServers) {
    delete cfg.mcpServers["load-lock"];
    writeJson(file, cfg);
    actions.push(action);
  }
  return actions;
}

/**
 * rmdir empty directories from `startDir` upward, never leaving `stopDir`'s
 * parent (only dirs that are empty because we created them disappear).
 */
function pruneEmptyDirs(startDir: string, stopDir: string) {
  if (path.relative(stopDir, startDir).startsWith("..")) return;
  let up = startDir;
  while (path.relative(stopDir, up) !== "..") {
    try {
      fs.rmdirSync(up); // only succeeds when empty
    } catch {
      break;
    }
    up = path.dirname(up);
  }
}

// --------------------------------------------------------------- copilot-cli

function installCopilotCli(opts: InstallOptions, P: ReturnType<typeof pkgPaths>): string[] {
  const actions: string[] = [];

  // 1. mcpServers.load-lock (type "local" == stdio) in ~/.copilot/mcp-config.json
  //    (the file `copilot mcp add` writes; per official Copilot CLI docs).
  const cfgFile = path.join(HOME, ".copilot", "mcp-config.json");
  actions.push(
    ...mergeMcpServer(
      cfgFile,
      { type: "local", command: P.node, args: [P.mcp], env: {}, tools: ["*"] },
      `MCP server "load-lock" (type: local / stdio) in ${cfgFile}`,
    ),
  );

  // 2. marked policy section in the global personal instructions file
  const instructions = path.join(HOME, ".copilot", "copilot-instructions.md");
  const marker = "<!-- load-lock:begin -->";
  if (
    mdSection(
      instructions,
      marker,
      `${marker}\n` +
        fallbackSection(
          `Copilot CLI hook support is ecosystem-reported but NOT verified in official docs — load-lock installs no hooks here; there is no idle wakeup. You discover offers at your next tool call or via a bounded \`wait_ms\`.`,
        ) +
        `<!-- load-lock:end -->\n`,
    )
  )
    actions.push(`marked section in ${instructions} (global personal instructions)`);

  // 3. be honest about the tier
  actions.push(
    "tier: MCP fallback — Copilot CLI hooks are ecosystem-reported but not verified in official docs; " +
      "we install none, so there is no idle wakeup — offers surface at tool boundaries",
  );
  actions.push("verify with `copilot mcp list` (or `/mcp` inside Copilot CLI)");
  return actions;
}

function uninstallCopilotCli(): string[] {
  const actions: string[] = [];
  const cfgFile = path.join(HOME, ".copilot", "mcp-config.json");
  actions.push(...removeMcpServer(cfgFile, `removed MCP server from ${cfgFile}`));
  removeMdSection(path.join(HOME, ".copilot", "copilot-instructions.md"), "<!-- load-lock:begin -->");
  actions.push("removed copilot-instructions.md section");
  return actions;
}

// -------------------------------------------------------------------- cline

function clineMcpSettingsFile(): string {
  // Official Cline docs: CLI reads ~/.cline/data/settings/cline_mcp_settings.json,
  // overridable via CLINE_MCP_SETTINGS_PATH.
  return process.env.CLINE_MCP_SETTINGS_PATH?.trim()
    ? path.resolve(process.env.CLINE_MCP_SETTINGS_PATH)
    : path.join(HOME, ".cline", "data", "settings", "cline_mcp_settings.json");
}

function installCline(opts: InstallOptions, P: ReturnType<typeof pkgPaths>): string[] {
  const actions: string[] = [];

  // 1. mcpServers.load-lock (stdio) in the MCP settings file
  const cfgFile = clineMcpSettingsFile();
  actions.push(
    ...mergeMcpServer(
      cfgFile,
      { command: P.node, args: [P.mcp], env: {}, disabled: false, autoApprove: [] },
      `MCP server "load-lock" (stdio) in ${cfgFile}`,
    ),
  );

  // 2. own rule file in the global rules dir (whole file is ours → trivially clean uninstall)
  const ruleFile = path.join(HOME, ".cline", "rules", "load-lock.md");
  fs.mkdirSync(path.dirname(ruleFile), { recursive: true });
  fs.writeFileSync(
    ruleFile,
    `# load-lock: machine-wide heavy-work budget\n\n` +
      `Before resource-intensive local work (full builds, big test suites), coordinate with other agents on this machine via the \`load-lock\` MCP tools (acquire / claim / release / cancel / rejoin / pending / status / run_with_permit / attach_pid / mark_started / inspect_machine / configure). ` +
      `Acquire before heavy work, keep doing light work while queued, claim offers promptly (they expire), release when done.\n\n` +
      `${NO_WAKEUP_NOTE("Cline")}\n` +
      `Full guide: \`load-lock agent-guide\`.\n`,
  );
  actions.push(`global rule file ${ruleFile}`);

  // 3. be honest about the tier
  actions.push("tier: MCP fallback — Cline has no hooks and no async push, so there is no idle wakeup; offers surface at tool boundaries");
  actions.push("restart Cline (or reload the window) to pick up the MCP server");
  return actions;
}

function uninstallCline(): string[] {
  const actions: string[] = [];
  const cfgFile = clineMcpSettingsFile();
  actions.push(...removeMcpServer(cfgFile, `removed MCP server from ${cfgFile}`));
  const ruleFile = path.join(HOME, ".cline", "rules", "load-lock.md");
  if (fs.existsSync(ruleFile)) {
    fs.rmSync(ruleFile);
    actions.push(`removed ${ruleFile}`);
    pruneEmptyDirs(path.dirname(ruleFile), path.join(HOME, ".cline"));
  }
  return actions;
}

// ----------------------------------------------------------------- roo-code

/**
 * Existing global Roo Code / Zoo Code `mcp_settings.json` files (VS Code keeps
 * them in per-extension globalStorage; the extension id changed across
 * roo-cline → roo-code → zoo-code releases, and the editor may be Code,
 * Code - OSS or VSCodium). We merge into every one we FIND; we never create
 * one — if it is absent the user manages the global file via the Roo/Zoo
 * settings UI ("Edit Global MCP") and we write the project file instead.
 */
function rooGlobalMcpFiles(): string[] {
  const appData =
    process.platform === "darwin" ? path.join(HOME, "Library", "Application Support") : configHome();
  const out: string[] = [];
  for (const editor of ["Code", "Code - OSS", "VSCodium"]) {
    for (const ext of ["roocode.roo-cline", "RooCodeInc.roo-code", "ZooCodeOrganization.zoo-code"]) {
      const f = path.join(appData, editor, "User", "globalStorage", ext, "settings", "mcp_settings.json");
      if (fs.existsSync(f)) out.push(f);
    }
  }
  return out;
}

function installRooCode(opts: InstallOptions, P: ReturnType<typeof pkgPaths>): string[] {
  const actions: string[] = [];

  // 1. project-level .roo/mcp.json (documented, auto-loaded, shareable)
  const projMcp = path.join(opts.project, ".roo", "mcp.json");
  actions.push(
    ...mergeMcpServer(
      projMcp,
      { command: P.node, args: [P.mcp], disabled: false },
      `MCP server "load-lock" (stdio) in ${projMcp} (project-level; Roo/Zoo auto-loads it)`,
    ),
  );

  // 2. own rule file in the global rules dir
  const ruleFile = path.join(HOME, ".roo", "rules", "load-lock.md");
  fs.mkdirSync(path.dirname(ruleFile), { recursive: true });
  fs.writeFileSync(
    ruleFile,
    `# load-lock: machine-wide heavy-work budget\n\n` +
      `Before resource-intensive local work (full builds, big test suites), coordinate with other agents on this machine via the \`load-lock\` MCP tools (acquire / claim / release / cancel / rejoin / pending / status / run_with_permit / attach_pid / mark_started / inspect_machine / configure). ` +
      `Acquire before heavy work, keep doing light work while queued, claim offers promptly (they expire), release when done.\n\n` +
      `${NO_WAKEUP_NOTE("Roo Code")}\n` +
      `Full guide: \`load-lock agent-guide\`.\n`,
  );
  actions.push(`global rule file ${ruleFile}`);

  // 3. global mcp_settings.json copies that already exist
  const globals = rooGlobalMcpFiles();
  for (const f of globals) {
    actions.push(...mergeMcpServer(f, { command: P.node, args: [P.mcp], disabled: false }, `MCP server "load-lock" in existing global ${f}`));
  }
  if (!globals.length) {
    actions.push(
      "no global Roo/Zoo mcp_settings.json found — to add the server globally, use " +
        "\"Edit Global MCP\" in the Roo/Zoo MCP settings UI and paste the same stdio entry",
    );
  }

  // 4. be honest about the tier
  actions.push("tier: MCP fallback — Roo Code has no hooks and no async push, so there is no idle wakeup; offers surface at tool boundaries");
  return actions;
}

function uninstallRooCode(opts: UninstallOptions): string[] {
  const actions: string[] = [];
  const projMcp = path.join(opts.project, ".roo", "mcp.json");
  actions.push(...removeMcpServer(projMcp, `removed MCP server from ${projMcp}`));
  for (const f of rooGlobalMcpFiles()) {
    actions.push(...removeMcpServer(f, `removed MCP server from ${f}`));
  }
  const ruleFile = path.join(HOME, ".roo", "rules", "load-lock.md");
  if (fs.existsSync(ruleFile)) {
    fs.rmSync(ruleFile);
    actions.push(`removed ${ruleFile}`);
    pruneEmptyDirs(path.dirname(ruleFile), path.join(HOME, ".roo"));
  }
  return actions;
}

// -------------------------------------------------------------------- goose

// goose config.yaml is YAML. Rather than a full parser (a new dependency, and
// a formatting-destroying one), we do a careful line-oriented block-mapping
// merge for the one key we touch (`extensions`), and refuse anything we do
// not understand (flow style) instead of guessing.
const GOOSE_BEGIN = "# load-lock:begin (managed by `load-lock install`)";
const GOOSE_END = "# load-lock:end";
const GOOSE_HEADER_TAG = "# load-lock-created (managed by `load-lock install`)";

function gooseConfigFile(): string {
  // Official goose docs: macOS/Linux ~/.config/goose/config.yaml
  // (Windows: %APPDATA%\Block\goose\config\config.yaml — not supported by load-lock).
  return path.join(configHome(), "goose", "config.yaml");
}

function gooseBlockLines(P: ReturnType<typeof pkgPaths>): string[] {
  return [
    `  ${GOOSE_BEGIN}`,
    "  load-lock:",
    "    type: stdio",
    "    name: load-lock",
    "    enabled: true",
    `    cmd: ${JSON.stringify(P.node)}`,
    `    args: [${JSON.stringify(P.mcp)}]`,
    `  ${GOOSE_END}`,
  ];
}

/** Remove our marked child block(s) from a goose config.yaml text. */
function gooseRemoveMarked(lines: string[]): string[] {
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    if (/^\s+# load-lock:begin \(managed by `load-lock install`\)$/.test(line)) {
      skipping = true;
      continue;
    }
    if (skipping && /^\s+# load-lock:end$/.test(line)) {
      skipping = false;
      continue;
    }
    if (!skipping) out.push(line);
  }
  return out;
}

/**
 * Remove an unmarked `load-lock:` child block under `extensions:` (pre-existing
 * name collision) so we never write a duplicate YAML key. Only touches the
 * `load-lock` child; sibling extensions are preserved.
 */
function gooseRemoveCollidingChild(lines: string[], extIdx: number): string[] {
  const childRe = /^(\s+)load-lock:\s*(#.*)?$/;
  for (let i = extIdx + 1; i < lines.length; i++) {
    if (/^\S/.test(lines[i])) break; // left the extensions block
    const m = childRe.exec(lines[i]);
    if (m) {
      const indent = m[1].length;
      let j = i + 1;
      while (j < lines.length && (lines[j].trim() === "" || new RegExp(`^\\s{${indent + 1},}\\S`).test(lines[j]))) j++;
      while (j > i + 1 && lines[j - 1].trim() === "") j--; // keep trailing blank separators
      lines.splice(i, j - i);
      break;
    }
  }
  return lines;
}

/**
 * If our tagged `extensions:` header has no other children, remove it — and the
 * separator blank we own immediately before it, when the header sits at end of
 * file — so an install/uninstall round-trip restores the user's bytes exactly.
 */
function gooseDropChildlessTaggedHeader(lines: string[]): string[] {
  const taggedIdx = lines.findIndex((l) => l === `extensions: ${GOOSE_HEADER_TAG}`);
  if (taggedIdx === -1) return lines;
  let hasChild = false;
  for (let i = taggedIdx + 1; i < lines.length && !/^\S/.test(lines[i]); i++) {
    if (/\S/.test(lines[i]) && !/^\s*#/.test(lines[i])) hasChild = true;
  }
  if (!hasChild) {
    lines.splice(taggedIdx, 1);
    if (
      taggedIdx > 0 &&
      lines[taggedIdx - 1].trim() === "" &&
      lines.slice(taggedIdx).every((l) => l.trim() === "")
    ) {
      lines.splice(taggedIdx - 1, 1);
    }
  }
  return lines;
}

/** Merge/replace the `extensions.load-lock` stdio entry in goose config.yaml text. */
function gooseUpsertExtension(text: string, P: ReturnType<typeof pkgPaths>): string {
  // NOTE: [ \t]* (not \s*) — \s would span the newline and misread the first
  // block-mapping child as a flow-style value on the header line.
  const flow = /^extensions:[ \t]*[^\s#]/m.exec(text);
  if (flow) {
    throw new Error(
      "goose config.yaml uses a non-block-style `extensions:` value; load-lock refuses to guess — " +
        "convert it to a block mapping or add the load-lock extension manually",
    );
  }
  let lines = gooseRemoveMarked(text.split("\n"));
  lines = gooseDropChildlessTaggedHeader(lines);

  const block = gooseBlockLines(P);
  const extIdx = lines.findIndex((l) => /^extensions:\s*(#.*)?$/.test(l));
  if (extIdx === -1) {
    // no extensions key yet → append one, tagged as ours
    if (lines.length && lines[lines.length - 1] === "") lines.pop(); // normalize trailing newline
    if (lines.length) lines.push(""); // separator blank (ours; removed on uninstall)
    lines.push(`extensions: ${GOOSE_HEADER_TAG}`, ...block, "");
  } else {
    lines = gooseRemoveCollidingChild(lines, extIdx);
    lines.splice(extIdx + 1, 0, ...block);
  }
  return lines.join("\n");
}

/** Remove our extension from a goose config.yaml text (idempotent, no-op safe). */
function gooseRemoveExtension(text: string): string {
  let lines = gooseRemoveMarked(text.split("\n"));
  lines = gooseDropChildlessTaggedHeader(lines);
  return lines.join("\n");
}

function installGoose(opts: InstallOptions, P: ReturnType<typeof pkgPaths>): string[] {
  const actions: string[] = [];
  const cfgFile = gooseConfigFile();
  fs.mkdirSync(path.dirname(cfgFile), { recursive: true });
  const prev = fs.existsSync(cfgFile) ? fs.readFileSync(cfgFile, "utf8") : "";
  writeText(cfgFile, gooseUpsertExtension(prev, P));
  actions.push(`extensions.load-lock (type: stdio) in ${cfgFile}`);

  // 2. marked section in the global hints file (~/.config/goose/.goosehints)
  const hints = path.join(configHome(), "goose", ".goosehints");
  const marker = "<!-- load-lock:begin -->";
  if (mdSection(hints, marker, `${marker}\n` + fallbackSection(NO_WAKEUP_NOTE("Goose")) + `<!-- load-lock:end -->\n`))
    actions.push(`marked section in ${hints} (global hints)`);

  // 3. be honest about the tier
  actions.push("tier: MCP fallback — Goose has no hooks and no async push, so there is no idle wakeup; offers surface at tool boundaries");
  actions.push("restart goose sessions to pick up the extension");
  return actions;
}

function uninstallGoose(): string[] {
  const actions: string[] = [];
  const cfgFile = gooseConfigFile();
  if (fs.existsSync(cfgFile)) {
    const prev = fs.readFileSync(cfgFile, "utf8");
    const next = gooseRemoveExtension(prev);
    if (next !== prev) writeText(cfgFile, next);
    if (next.trim() === "") {
      fs.rmSync(cfgFile);
      actions.push(`removed ${cfgFile} (nothing else was in it)`);
    } else {
      actions.push(`removed extensions.load-lock from ${cfgFile}`);
    }
  }
  const hints = path.join(configHome(), "goose", ".goosehints");
  removeMdSection(hints, "<!-- load-lock:begin -->");
  actions.push("removed hints section");
  if (fs.existsSync(hints) && fs.readFileSync(hints, "utf8").trim() === "") {
    fs.rmSync(hints);
    actions.push(`removed ${hints} (nothing else was in it)`);
  }
  pruneEmptyDirs(path.dirname(cfgFile), path.dirname(cfgFile));
  return actions;
}

// ------------------------------------------------------------------ cursor

/**
 * Policy text for the dedicated .cursor/rules/load-lock.mdc rule file
 * (YAML frontmatter with alwaysApply: true — plain .md is ignored by Cursor).
 */
function cursorRuleText(): string {
  return (
    `---\nalwaysApply: true\n---\n` +
    `# load-lock: machine-wide heavy-work budget\n\n` +
    `Before resource-intensive local work (full builds, big test suites), coordinate with other agents on this machine via the \`load-lock\` MCP tools (acquire / claim / release / cancel / rejoin / pending / status / run_with_permit / attach_pid / mark_started / inspect_machine / configure). ` +
    `Acquire before heavy work, keep doing light work while queued, claim offers promptly (they expire), release when done.\n\n` +
    `When you are queued and idle, a load-lock stop hook wakes you: Cursor auto-submits a follow-up message telling you which offer_token to claim — claim it immediately (it expires) and start your heavy work right away.\n\n` +
    `Full guide: \`load-lock agent-guide\`.\n`
  );
}

/**
 * Cursor (hooks v1, documented at https://cursor.com/docs/hooks — no longer
 * beta). Everything is project-level under --project/.cursor/:
 *  - mcp.json: mcpServers.load-lock stdio entry
 *  - hooks.json: { version: 1, hooks: { stop: [ ... ] } } — FLAT entries
 *    ({type:"command", command}), merged; only our own entries are replaced.
 *  - rules/load-lock.mdc: our own Always-apply rule (clean uninstall).
 */
function installCursor(opts: InstallOptions, P: ReturnType<typeof pkgPaths>): string[] {
  const actions: string[] = [];
  const cursorDir = path.join(opts.project, ".cursor");

  // 1. MCP server (stdio) in the project .cursor/mcp.json (documented path)
  const mcpFile = path.join(cursorDir, "mcp.json");
  actions.push(
    ...mergeMcpServer(
      mcpFile,
      { command: P.node, args: [P.mcp] },
      `MCP server "load-lock" (stdio) in ${mcpFile} (project-level)`,
    ),
  );

  // 2. stop hook in the project .cursor/hooks.json (merge; replace only ours)
  const hooksFile = path.join(cursorDir, "hooks.json");
  const h = readJson(hooksFile) ?? {};
  if (typeof h !== "object" || h === null || Array.isArray(h)) {
    throw new Error(`${hooksFile} is not a JSON object; refusing to overwrite`);
  }
  if (h.version === undefined) h.version = 1; // required positive integer per docs
  if (h.hooks === undefined) {
    h.hooks = {};
  } else if (typeof h.hooks !== "object" || h.hooks === null || Array.isArray(h.hooks)) {
    throw new Error(`${hooksFile} has a non-object "hooks" key; refusing to overwrite`);
  }
  if (h.hooks.stop === undefined) {
    h.hooks.stop = [];
  } else if (!Array.isArray(h.hooks.stop)) {
    throw new Error(`${hooksFile} has a non-array "hooks.stop" key; refusing to overwrite`);
  }
  h.hooks.stop = [
    ...h.hooks.stop.filter((e: any) => !isOurHook(e, P.cli, "cursor")),
    { type: "command", command: `${P.node} ${JSON.stringify(P.cli)} hook cursor stop` },
  ];
  writeJson(hooksFile, h);
  actions.push(`stop hook in ${hooksFile} (hooks v1, project-level)`);

  // 3. own Always-apply rule file (whole file is ours → trivially clean uninstall)
  const ruleFile = path.join(cursorDir, "rules", "load-lock.mdc");
  fs.mkdirSync(path.dirname(ruleFile), { recursive: true });
  fs.writeFileSync(ruleFile, cursorRuleText());
  actions.push(`Always-apply rule file ${ruleFile} (.cursor/rules, survives compaction)`);

  // 4. be honest about the tier and verification status
  actions.push(
    "tier: MCP + stop-hook wakeup — the stop hook returns {\"followup_message\":...} so Cursor continues " +
      "the session when a load-lock offer arrives; contract-tested against the documented Cursor hooks " +
      "JSON (https://cursor.com/docs/hooks), not live-verified",
  );
  actions.push("restart Cursor (or reload the window) to pick up the MCP server and hooks");
  return actions;
}

function uninstallCursor(opts: UninstallOptions): string[] {
  const actions: string[] = [];
  const cursorDir = path.join(opts.project, ".cursor");
  const P = pkgPaths(); // only needed for our-entry matching below

  // 1. MCP server
  const mcpFile = path.join(cursorDir, "mcp.json");
  actions.push(...removeMcpServer(mcpFile, `removed MCP server from ${mcpFile}`));
  const mcpAfter = readJson(mcpFile);
  if (
    mcpAfter &&
    typeof mcpAfter === "object" &&
    Object.keys(mcpAfter).length === 1 &&
    typeof mcpAfter.mcpServers === "object" &&
    Object.keys(mcpAfter.mcpServers).length === 0
  ) {
    fs.rmSync(mcpFile); // we created it; nothing user-owned was ever in it
    actions.push(`removed ${mcpFile} (nothing else was in it)`);
  }

  // 2. hooks: remove exactly our entries from every event
  const hooksFile = path.join(cursorDir, "hooks.json");
  const h = readJson(hooksFile);
  if (h && typeof h === "object" && h !== null) {
    let changed = false;
    if (h.hooks && typeof h.hooks === "object" && !Array.isArray(h.hooks)) {
      for (const ev of Object.keys(h.hooks)) {
        if (!Array.isArray(h.hooks[ev])) continue;
        const list: any[] = h.hooks[ev];
        const kept = list.filter((e) => !isOurHook(e, P.cli, "cursor"));
        if (kept.length !== list.length) {
          changed = true;
          if (kept.length) h.hooks[ev] = kept;
          else delete h.hooks[ev];
        }
      }
      if (Object.keys(h.hooks).length === 0) delete h.hooks;
    }
    if (changed) {
      // If only our bare-install shape remains ({version:1} or {}), the file
      // is ours — remove it. Anything user-owned stays untouched.
      if (Object.keys(h).length === 0 || (Object.keys(h).length === 1 && h.version === 1)) {
        fs.rmSync(hooksFile);
        actions.push(`removed ${hooksFile} (nothing else was in it)`);
      } else {
        writeJson(hooksFile, h);
        actions.push(`removed stop hook from ${hooksFile}`);
      }
    }
  }

  // 3. our rule file
  const ruleFile = path.join(cursorDir, "rules", "load-lock.mdc");
  if (fs.existsSync(ruleFile)) {
    fs.rmSync(ruleFile);
    actions.push(`removed ${ruleFile}`);
    pruneEmptyDirs(path.dirname(ruleFile), path.dirname(ruleFile)); // rules/ if now empty
  }

  // .cursor/ itself, if we left it empty
  pruneEmptyDirs(cursorDir, cursorDir);
  return actions;
}

// --------------------------------------------------------------------- omac

// omac (verified against 0.11.0) sandboxes agents with bubblewrap +
// Landlock on Linux and strips the harness environment, allowing through
// only what the user-global sandbox profile lists. Known profile fields
// (strict parsing — unknown fields are hard errors): top-level `workdir`,
// `network`, `filesystem`, `environment`; `workdir.access`,
// `network.allow_domain`/`deny_domain`/`allow_tcp_connect`,
// `filesystem.allow`/`read`/`write`/`allow_unix_dir`/`deny`,
// `environment.allow_vars` — all lists of strings. omac never rewrites a
// profile it has created, so the profile file is the whole extension
// point and we only ever write known fields.
const OMAC_LL_ENV_ENTRY = "LOAD_LOCK_*"; // allow_vars trailing-* prefix (verified: accepted by 0.11.0)

/** omac's user-global sandbox profile (no project equivalent exists). */
function omacProfileFile(): string {
  return path.join(configHome(), "omac", "sandbox-profiles", "default.json");
}

/** Read + shape-check the profile; undefined when the file does not exist. */
function omacReadProfile(file: string): Record<string, unknown> | undefined {
  if (!fs.existsSync(file)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(
      `${file} is not valid JSON (${e instanceof Error ? e.message : String(e)}). omac parses ` +
        `profiles strictly; load-lock refuses to overwrite it — fix or remove the file, then re-run install`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${file} is not a JSON object; refusing to overwrite`);
  }
  return parsed as Record<string, unknown>;
}

/** The profile sub-object `key`, created when absent; refuses non-objects. */
function omacSection(profile: Record<string, unknown>, key: string): Record<string, unknown> {
  const v = profile[key];
  if (v === undefined) {
    const section: Record<string, unknown> = {};
    profile[key] = section;
    return section;
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new Error(`omac profile: "${key}" is not an object; refusing to overwrite`);
  }
  return v as Record<string, unknown>;
}

/**
 * Merge string entries into section[key] (created only when something is
 * added, so we never write empty arrays). Returns the entries actually
 * added; refuses non-string-array values instead of mangling them.
 */
function omacMergeList(section: Record<string, unknown>, key: string, entries: string[]): string[] {
  const v = section[key];
  let list: string[];
  if (v === undefined) list = [];
  else if (Array.isArray(v) && v.every((x) => typeof x === "string")) list = [...v];
  else throw new Error(`omac profile: "${key}" is not an array of strings; refusing to overwrite`);
  const added = entries.filter((e) => !list.includes(e));
  if (added.length) section[key] = [...list, ...added];
  return added;
}

/**
 * The installed package tree a sandboxed CLI must be able to *read*.
 * Live-verified gotcha: a global bun/npm install grants the bin dir, but
 * the launcher resolves the dist tree under `.../node_modules/@aron98/
 * load-lock` — without a read grant the CLI dies with ERR_MODULE_NOT_FOUND
 * before ever reaching the socket. Returns the realpath of the package
 * root, or null when load-lock lives in a repo checkout / worktree (the
 * nearest `.git`): there the agent's omac workdir grant already covers
 * it, and a read grant would be noise.
 */
function omacReadGrant(P: ReturnType<typeof pkgPaths>): string | null {
  let root = P.root;
  try {
    root = fs.realpathSync(root);
  } catch {
    /* keep the unresolved path — omac grants are not existence-filtered */
  }
  for (let dir = root; ; ) {
    if (fs.existsSync(path.join(dir, ".git"))) return null; // repo checkout / git worktree
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return root;
}

/**
 * Remove our entries (match-own-entries style: exact current state dir,
 * the "LOAD_LOCK_*" prefix entry, and read entries pointing at the
 * current package root or at a global `node_modules/@aron98/load-lock`
 * tree — the shape the installer writes). Keys whose lists we emptied are
 * dropped; sections that become empty are dropped; the file is removed
 * (and dirs pruned) when nothing user-owned remains.
 */
function uninstallOmac(): string[] {
  const actions: string[] = [];
  const file = omacProfileFile();
  const profile = omacReadProfile(file);
  if (!profile) return actions; // nothing installed; uninstall never creates anything

  const stateDir = resolveStateDir(process.platform, process.env);
  const readTree = omacReadGrant(pkgPaths());
  const globalPkgSuffix = path.join("node_modules", PKG_NAME);
  let changed = false;
  const drop = (sectionKey: string, key: string, isOurs: (entry: string) => boolean) => {
    const section = profile[sectionKey];
    if (!section || typeof section !== "object" || Array.isArray(section)) return;
    const list = (section as Record<string, unknown>)[key];
    if (!Array.isArray(list) || !list.every((x) => typeof x === "string")) return;
    const kept = list.filter((e: string) => !isOurs(e));
    if (kept.length === list.length) return;
    changed = true;
    if (kept.length) (section as Record<string, unknown>)[key] = kept;
    else delete (section as Record<string, unknown>)[key];
  };
  drop("filesystem", "allow_unix_dir", (e) => e === stateDir);
  drop("filesystem", "read", (e) => (readTree !== null && e === readTree) || e.endsWith(globalPkgSuffix));
  drop("environment", "allow_vars", (e) => e === OMAC_LL_ENV_ENTRY);

  // prune sections our removals emptied (never anything the user still has)
  for (const key of ["filesystem", "environment"]) {
    const section = profile[key];
    if (section && typeof section === "object" && !Array.isArray(section) && Object.keys(section).length === 0) {
      delete profile[key];
    }
  }
  if (!changed) {
    actions.push(`no load-lock grants found in ${file}`);
    return actions;
  }
  if (Object.keys(profile).length === 0) {
    fs.rmSync(file);
    actions.push(`removed ${file} (nothing else was in it)`);
    pruneEmptyDirs(path.dirname(file), path.join(configHome(), "omac"));
  } else {
    writeJson(file, profile);
    actions.push(`removed load-lock grants from ${file}`);
  }
  return actions;
}

function installOmac(opts: InstallOptions, P: ReturnType<typeof pkgPaths>): string[] {
  const actions: string[] = [];
  const file = omacProfileFile();
  const existed = fs.existsSync(file);
  const profile = omacReadProfile(file) ?? {};
  const stateDir = resolveStateDir(process.platform, process.env);

  const grants: string[] = [];
  const fsSection = omacSection(profile, "filesystem");
  grants.push(...omacMergeList(fsSection, "allow_unix_dir", [stateDir]));
  const readTree = omacReadGrant(P);
  if (readTree) grants.push(...omacMergeList(fsSection, "read", [readTree]));
  const envSection = omacSection(profile, "environment");
  grants.push(...omacMergeList(envSection, "allow_vars", [OMAC_LL_ENV_ENTRY]));

  // merge-only: never rewrite the file when nothing changed (idempotent
  // re-install leaves the user's bytes untouched)
  if (grants.length || !existed) writeJson(file, profile);

  if (!existed) actions.push(`created ${file} (omac's user-global sandbox profile)`);
  else if (grants.length) actions.push(`grants merged into ${file}`);
  else actions.push(`all grants already present in ${file} — nothing to do`);

  for (const g of grants) {
    if (g === OMAC_LL_ENV_ENTRY) {
      actions.push(`environment.allow_vars += "${OMAC_LL_ENV_ENTRY}" (prefix pattern; passes all four LOAD_LOCK_* vars through the sandbox env filter)`);
    } else if (g === stateDir) {
      actions.push(`filesystem.allow_unix_dir += ${stateDir} (AF_UNIX connect to the host daemon socket + read/write on the state dir)`);
    } else {
      actions.push(`filesystem.read += ${g} (installed package tree — the bin-dir grant alone is not enough; without this the CLI dies with ERR_MODULE_NOT_FOUND before reaching the socket)`);
    }
  }
  if (!readTree) {
    actions.push(`skipped filesystem.read: load-lock lives in a repo checkout (${P.root}) — the omac workdir grant already covers it`);
  }
  actions.push(
    "set the values in your harness env (the grants only allow the names through): " +
      "LOAD_LOCK_NO_SPAWN=1 (client-only; the daemon must run on the host, e.g. load-lock service start), " +
      "LOAD_LOCK_LABEL_PREFIX=omac (dashboard shows holders as omac:<label>); " +
      "LOAD_LOCK_SOCKET only if the default <state dir>/daemon.sock is not what the sandbox sees",
  );
  actions.push(
    "label prefixes need load-lock >= 1.2.0 on BOTH ends: a daemon started before v1.2.0 " +
      "silently strips the unknown labelPrefix field — upgrade and restart the daemon (load-lock service restart)",
  );
  actions.push(
    "verified live against omac 0.11.0 (bubblewrap + Landlock): sandboxed client -> host daemon " +
      "round-trip, prefixed labels, LOAD_LOCK_NO_SPAWN error contract",
  );
  return actions;
}

// -------------------------------------------------------------------- public

export async function installCommand(opts: InstallOptions): Promise<void> {
  const P = pkgPaths(opts.binDir);
  if (!fs.existsSync(P.mcp)) {
    throw new Error(`compiled entry not found at ${P.mcp} — run \`npm run build\` inside the load-lock package first`);
  }
  const harness = opts.harness;
  if (!harness) throw new Error("install: --harness <opencode|claude-code|codex|cursor|gemini-cli|copilot-cli|cline|roo-code|goose|omac|generic> is required");

  let actions: string[];
  switch (harness) {
    case "opencode":
      actions = installOpenCode(opts, P);
      break;
    case "claude-code":
    case "claude":
      actions = installClaudeCode(opts, P);
      break;
    case "codex":
      actions = installCodex(opts, P);
      break;
    case "cursor":
      actions = installCursor(opts, P);
      break;
    case "gemini-cli":
    case "gemini":
      actions = installGeminiCli(opts, P);
      break;
    case "copilot-cli":
    case "copilot":
      actions = installCopilotCli(opts, P);
      break;
    case "cline":
      actions = installCline(opts, P);
      break;
    case "roo-code":
    case "roo":
    case "zoo-code":
    case "zoo":
      actions = installRooCode(opts, P);
      break;
    case "goose":
      actions = installGoose(opts, P);
      break;
    case "omac":
      actions = installOmac(opts, P);
      break;
    case "generic":
    case "all":
    default:
      // generic: print an MCP stdio snippet for any MCP-capable harness
      process.stdout.write(
        `\nAdd this MCP stdio server to your harness's MCP config:\n\n` +
          `  name: load-lock\n  command: ${P.node}\n  args: [${JSON.stringify(P.mcp)}]\n\n` +
          `Tools: acquire, claim, release, cancel, rejoin, pending, status, inspect_machine,\n` +
          `get_config, configure, run_with_permit, job_status, job_stop, attach_pid, mark_started.\n` +
          `Then make sure your harness instructions tell agents to use it (see docs/AGENT_GUIDE.md).\n\n`,
      );
      return;
  }
  say(opts, `\nload-lock installed for ${harness}:`);
  for (const a of actions) say(opts, "  - " + a);
  say(opts, "");
}

export async function uninstallCommand(opts: UninstallOptions): Promise<void> {
  let actions: string[];
  switch (opts.harness) {
    case "opencode":
      actions = uninstallOpenCode();
      break;
    case "claude-code":
    case "claude":
      actions = uninstallClaudeCode();
      break;
    case "codex":
      actions = uninstallCodex();
      break;
    case "cursor":
      actions = uninstallCursor(opts);
      break;
    case "gemini-cli":
    case "gemini":
      actions = uninstallGeminiCli();
      break;
    case "copilot-cli":
    case "copilot":
      actions = uninstallCopilotCli();
      break;
    case "cline":
      actions = uninstallCline();
      break;
    case "roo-code":
    case "roo":
    case "zoo-code":
    case "zoo":
      actions = uninstallRooCode(opts);
      break;
    case "goose":
      actions = uninstallGoose();
      break;
    case "omac":
      actions = uninstallOmac();
      break;
    default:
      throw new Error(`uninstall: unknown harness "${opts.harness}"`);
  }
  process.stdout.write(`\nload-lock uninstalled for ${opts.harness}:\n`);
  for (const a of actions) process.stdout.write("  - " + a + "\n");
  process.stdout.write("\n");
}

// keep POLICY_BRIEF referenced for potential future use in generic snippets
void POLICY_BRIEF;
