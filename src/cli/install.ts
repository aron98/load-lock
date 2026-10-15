/**
 * `load-lock install --harness <id>` — wires load-lock into a harness.
 *
 * Everything here MERGES into existing files; unrelated user config is never
 * touched. Our own entries are tagged (LL marker / absolute paths into this
 * package) so uninstall removes exactly what install added.
 *
 * Harnesses:
 *  - opencode     : plugin dir ~/.config/opencode/plugins/load-lock/ (stub that
 *                   re-exports the compiled plugin from this package, with a
 *                   local package.json so `@opencode/plugin` + `load-lock`
 *                   resolve), plus a `plugins` entry in opencode.json.
 *  - claude-code  : user-scope MCP server in ~/.claude.json, SessionStart /
 *                   Stop hooks + background await-offer watcher in
 *                   ~/.claude/settings.json, CLAUDE.md section, skill.
 *  - codex        : ~/.codex/hooks.json (SessionStart/SubagentStart/Stop),
 *                   [mcp_servers.load-lock] in ~/.codex/config.toml,
 *                   ~/.codex/AGENTS.md pointer. Trust must be granted via /hooks.
 *  - generic      : prints an MCP stdio config snippet (any MCP-capable harness).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { POLICY_BRIEF } from "../policy/text.js";

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

/** Append a marked section to a markdown file once. */
function mdSection(file: string, marker: string, section: string): boolean {
  const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  if (existing.includes(marker)) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, existing + (existing.endsWith("\n") ? "" : "\n") + section);
  return true;
}

function removeMdSection(file: string, marker: string) {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, "utf8");
  const idx = text.indexOf(marker);
  if (idx === -1) return;
  const next = text.indexOf(marker, idx + marker.length);
  const end = next === -1 ? text.length : next;
  fs.writeFileSync(file, text.slice(0, idx) + text.slice(end));
}

const LL_HOOK_TAG = "dist/cli/main.js hook"; // how we recognize our hook entries

// ------------------------------------------------------------------ opencode

function installOpenCode(opts: InstallOptions, P: ReturnType<typeof pkgPaths>): string[] {
  const actions: string[] = [];
  const pluginDir = path.join(HOME, ".config", "opencode", "plugins", "load-lock");
  fs.mkdirSync(pluginDir, { recursive: true });

  // Stub that re-exports the compiled plugin from this package.
  fs.writeFileSync(
    path.join(pluginDir, "index.js"),
    `// installed by load-lock; re-exports the compiled plugin\n` +
      `export { default } from "@aron98/load-lock/dist/adapters/opencode/plugin.js";\n`,
  );
  actions.push(`plugin stub: ${pluginDir}/index.js`);

  fs.writeFileSync(
    path.join(pluginDir, "package.json"),
    JSON.stringify(
      {
        name: "load-lock-opencode-plugin",
        version: "0.1.0",
        type: "module",
        main: "index.js",
        dependencies: {
          "@opencode/plugin": "^2.0.29",
          "@aron98/load-lock": "file:" + P.root,
        },
      },
      null,
      2,
    ) + "\n",
  );
  actions.push("plugin package.json (file: dep on this package)");

  const npmInstall = spawnSync("npm", ["install", "--no-audit", "--no-fund"], { cwd: pluginDir, encoding: "utf8" });
  if (npmInstall.status !== 0) {
    actions.push("WARNING: npm install inside plugin dir failed — see errors above");
  } else {
    actions.push("plugin dependencies installed");
  }

  // Register in ~/.config/opencode/opencode.json (merge, preserve).
  const cfgFile = path.join(HOME, ".config", "opencode", "opencode.json");
  const cfg = readJson(cfgFile) ?? {};
  if (!Array.isArray(cfg.plugins)) cfg.plugins = [];
  if (!cfg.plugins.includes(pluginDir)) cfg.plugins.push(pluginDir);
  writeJson(cfgFile, cfg);
  actions.push(`plugins entry in ${cfgFile}`);

  actions.push("restart or reload your opencode service to load the plugin");
  return actions;
}

function uninstallOpenCode(): string[] {
  const actions: string[] = [];
  const pluginDir = path.join(HOME, ".config", "opencode", "plugins", "load-lock");
  fs.rmSync(pluginDir, { recursive: true, force: true });
  actions.push(`removed ${pluginDir}`);
  const cfgFile = path.join(HOME, ".config", "opencode", "opencode.json");
  const cfg = readJson(cfgFile);
  if (cfg && Array.isArray(cfg.plugins)) {
    cfg.plugins = cfg.plugins.filter((p: unknown) => p !== pluginDir);
    writeJson(cfgFile, cfg);
    actions.push(`removed plugins entry from ${cfgFile}`);
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
  const ours = (list: any[]) => list.filter((e) => JSON.stringify(e).includes(LL_HOOK_TAG));
  const cc = (event: string, entries: any[]) => {
    const prev = Array.isArray(s.hooks[event]) ? s.hooks[event] : [];
    const kept = prev.filter((e: any) => !ours([e]).length);
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
      `\n${marker}\n## load-lock: machine-wide heavy-work budget\n\n` +
        `Before resource-intensive local work (full builds, big test suites), coordinate with other agents on this machine:\n\n` +
        `1. Call the MCP tool \`mcp__load-lock__acquire\` (reason + op_key) — it grants a permit or queues you.\n` +
        `2. While queued, keep doing light work. When an offer arrives (hook wakeup or \`mcp__load-lock__pending\`), claim it via \`mcp__load-lock__claim\` within the window (default 30s).\n` +
        `3. Only start heavy work after acquire/claim succeeds. Use \`mcp__load-lock__run_with_permit\` for full lifecycle ownership (auto-release), or \`attach_pid\` for processes you already started.\n` +
        `4. Release (or cancel queued work) promptly. Inspect the machine with \`mcp__load-lock__inspect_machine\`; adjust capacity via \`mcp__load-lock__configure\` when warranted.\n\n` +
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
    for (const ev of Object.keys(s.hooks)) {
      const list = s.hooks[ev];
      if (Array.isArray(list)) {
        const kept = list.filter((e: any) => !JSON.stringify(e).includes(LL_HOOK_TAG));
        if (kept.length) s.hooks[ev] = kept;
        else delete s.hooks[ev];
      }
    }
    writeJson(settingsFile, s);
    actions.push(`removed hooks from ${settingsFile}`);
  }
  const md = path.join(HOME, ".claude", "CLAUDE.md");
  removeMdSection(md, "<!-- load-lock:begin -->");
  actions.push(`removed CLAUDE.md section`);
  fs.rmSync(path.join(HOME, ".claude", "skills", "load-lock"), { recursive: true, force: true });
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
    h.hooks[event] = [...prev.filter((e: any) => !JSON.stringify(e).includes(LL_HOOK_TAG)), ...entries];
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
      `\n<!-- load-lock:begin -->\n## load-lock: machine-wide heavy-work budget\n\n` +
        `Before resource-intensive local work (full builds, big test suites), coordinate with other agents on this machine via the \`load-lock\` MCP tools (mcp__load-lock__acquire / claim / release / run_with_permit / pending / status / inspect_machine / configure). ` +
        `Acquire before heavy work, keep doing light work while queued, claim offers promptly (they expire), release when done. Full guide: \`load-lock agent-guide\`.\n<!-- load-lock:end -->\n`,
    )
  )
    actions.push(`AGENTS.md section in ${agentsMd}`);

  actions.push("IMPORTANT: run `/hooks` inside Codex and grant trust to the new hooks (they are inert until trusted)");
  return actions;
}

function uninstallCodex(): string[] {
  const actions: string[] = [];
  const codexHome = process.env.CODEX_HOME ?? path.join(HOME, ".codex");
  const hooksFile = path.join(codexHome, "hooks.json");
  const h = readJson(hooksFile);
  if (h?.hooks && typeof h.hooks === "object") {
    for (const ev of Object.keys(h.hooks)) {
      const list = h.hooks[ev];
      if (Array.isArray(list)) {
        const kept = list.filter((e: any) => !JSON.stringify(e).includes(LL_HOOK_TAG));
        if (kept.length) h.hooks[ev] = kept;
        else delete h.hooks[ev];
      }
    }
    writeJson(hooksFile, h);
    actions.push(`removed hooks from ${hooksFile}`);
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

// -------------------------------------------------------------------- public

export async function installCommand(opts: InstallOptions): Promise<void> {
  const P = pkgPaths(opts.binDir);
  if (!fs.existsSync(P.mcp)) {
    throw new Error(`compiled entry not found at ${P.mcp} — run \`npm run build\` inside the load-lock package first`);
  }
  const harness = opts.harness;
  if (!harness) throw new Error("install: --harness <opencode|claude-code|codex|generic> is required");

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
    default:
      throw new Error(`uninstall: unknown harness "${opts.harness}"`);
  }
  process.stdout.write(`\nload-lock uninstalled for ${opts.harness}:\n`);
  for (const a of actions) process.stdout.write("  - " + a + "\n");
  process.stdout.write("\n");
}

// keep POLICY_BRIEF referenced for potential future use in generic snippets
void POLICY_BRIEF;
