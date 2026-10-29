/**
 * `load-lock setup` (issue #58): read-only inventory of every load-lock
 * integration on this machine, across every harness `load-lock install`
 * supports, plus the runtime copies (#52 / copies.ts).
 *
 * For each harness it lists what it finds — skill copies, MCP
 * registrations, loose hooks, plugins, policy sections, sandbox grants —
 * who wrote each entry (our installer, the harness's plugin system, ACE,
 * or something else), whether an entry points at a load-lock copy that no
 * longer exists, the current rung (plugin / loose / mcp / skill / none),
 * and duplicates.
 *
 * Paths mirror src/cli/install.ts exactly. Everything here only READS;
 * unreadable or unparseable files are skipped, never rewritten.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findInstalledCopies, type InstalledCopy } from "./copies.js";
import { loadRuntimes, readDaemonInfo, type RuntimeCopy } from "../shared/runtimes.js";
import { resolveStateDir } from "../shared/transport.js";
import { PKG_NAME } from "../shared/pkginfo.js";

/**
 * Name of the Claude Code plugin (decided on #61: the plugin is not called
 * `load-lock`, so it never collides with the standalone skill). Matched as
 * `<name>@<marketplace>` in `enabledPlugins`, whatever the marketplace.
 */
export const CLAUDE_PLUGIN_NAME = "load-lock-plugin";

const MD_MARKER = "<!-- load-lock:begin -->";
const GOOSE_BEGIN = "# load-lock:begin (managed by `load-lock install`)";
const CODEX_TOML_TAG = "# load-lock (added by `load-lock install`)";

export const HARNESSES = [
  "claude-code",
  "opencode",
  "codex",
  "cursor",
  "gemini-cli",
  "copilot-cli",
  "cline",
  "roo-code",
  "goose",
  "omac",
] as const;
export type Harness = (typeof HARNESSES)[number];

export type IntegrationKind = "plugin" | "hooks" | "mcp" | "policy" | "skill" | "grants";
/**
 * Who wrote the entry: `installer` = `load-lock install` (exact shape it
 * writes), `harness` = the harness's own plugin state (e.g. Claude Code
 * `enabledPlugins`), `ace` = an ACE install (`.ace.json` stamp next to it),
 * `other` = anything else (manual edits, npx entries, foreign tools).
 */
export type Owner = "installer" | "harness" | "ace" | "other";

export interface Integration {
  kind: IntegrationKind;
  scope: "user" | "project";
  /** File (or directory) the entry lives in. */
  file: string;
  /** Short description of the entry (key, events, ...). */
  detail: string;
  owner: Owner;
  /** Package root of the load-lock copy the entry runs, when it names one. */
  copy?: string;
  /** True when that copy no longer exists on disk. */
  stale?: boolean;
  /** Plugins only: the harness's enabled flag. */
  enabled?: boolean;
}

/**
 * Rung on the ladder (#47): `plugin` = harness plugin active, `loose` =
 * `load-lock install` wiring (hooks / policy / grants), `mcp` = only an MCP
 * registration, `skill` = only the skill, `none` = nothing found.
 */
export type Rung = "plugin" | "loose" | "mcp" | "skill" | "none";

export interface HarnessInventory {
  harness: Harness;
  rung: Rung;
  integrations: Integration[];
  /** Duplicates, stale entries and other problems worth fixing. */
  findings: string[];
}

export interface Inventory {
  home: string;
  project: string;
  harnesses: HarnessInventory[];
  runtime: {
    /** Copies detectable on disk (copies.ts). */
    copies: InstalledCopy[];
    /** The copy the daemon last recorded in daemon.json (#52). */
    daemon: { path: string; version: string | null } | null;
    /** Copies the daemon has seen via the client handshake (#52). */
    known: RuntimeCopy[];
  };
  findings: string[];
}

export interface InventoryOptions {
  project: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

// ---------------------------------------------------------------- io helpers

function readJson(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

function readText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

function isObject(v: unknown): v is Record<string, any> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** All string leaves of a value (command / args / cmd, nested or flat). */
function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) strings(x, out);
  else if (isObject(v)) for (const x of Object.values(v)) strings(x, out);
  return out;
}

/** Package root of an absolute `<root>/dist/<sub>/main.js` path, or null. */
function copyOfEntry(p: string, sub: "mcp" | "cli"): string | null {
  const norm = p.replace(/\\/g, "/");
  if (!norm.endsWith(`/dist/${sub}/main.js`)) return null;
  return path.resolve(p, "..", "..", "..");
}

// ------------------------------------------------------------ entry matchers

/**
 * Classify an MCP server entry. Returns null when it is not load-lock.
 * The installer's shape is `{ command: <node>, args: ["<root>/dist/mcp/main.js"] }`
 * under the key `load-lock` (goose: `cmd`; opencode: a `command` array).
 */
function mcpEntry(name: string, entry: unknown): { owner: Owner; copy?: string; stale?: boolean } | null {
  const strs = strings(isObject(entry) ? { command: entry.command, cmd: entry.cmd, args: entry.args } : entry);
  for (const s of strs) {
    const copy = copyOfEntry(s, "mcp");
    if (copy && (name === "load-lock" || /load-lock/.test(s))) {
      return { owner: name === "load-lock" ? "installer" : "other", copy, stale: !fs.existsSync(s) };
    }
  }
  const joined = strs.join(" ");
  if (joined.includes(PKG_NAME) || /(^|[\s/\\])load-lock(-mcp)?(\.cmd)?(\s|$)/.test(joined) || name === "load-lock") {
    return { owner: "other" };
  }
  return null;
}

/** Collect every `command` string in a hooks structure (nested or flat). */
function hookCommands(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) for (const x of v) hookCommands(x, out);
  else if (isObject(v)) {
    for (const [k, x] of Object.entries(v)) {
      if (k === "command" && typeof x === "string") out.push(x);
      else hookCommands(x, out);
    }
  }
  return out;
}

const INSTALLER_HOOK = /^(.*?) ("(?:[^"\\]|\\.)*") hook (\S+) (\S+)$/;

/**
 * Classify a hook command. The installer writes
 * `<node> "<root>/dist/cli/main.js" hook <harness> <sub>`; anything else
 * running `load-lock hook <harness> ...` is `other`.
 */
function hookCommand(cmd: string, harness: string): { owner: Owner; sub: string; copy?: string; stale?: boolean } | null {
  const m = INSTALLER_HOOK.exec(cmd);
  if (m && m[3] === harness) {
    let cli: string | undefined;
    try {
      cli = JSON.parse(m[2]);
    } catch {
      cli = undefined;
    }
    const copy = cli ? copyOfEntry(cli, "cli") : null;
    if (cli && copy) return { owner: "installer", sub: m[4], copy, stale: !fs.existsSync(cli) };
  }
  const loose = new RegExp(`load-lock\\S*\\s+hook\\s+${harness}\\s+(\\S+)`).exec(cmd);
  if (loose) return { owner: "other", sub: loose[1] };
  return null;
}

/**
 * load-lock hook entries in one hooks file, one integration per copy (so a
 * second copy's hooks show up as their own line), plus foreign ones.
 */
function hooksIn(file: string, hooks: unknown, harness: string, scope: Integration["scope"]): Integration[] {
  if (!isObject(hooks)) return [];
  const groups = new Map<string, { owner: Owner; copy?: string; stale?: boolean; subs: string[] }>();
  for (const [event, list] of Object.entries(hooks)) {
    for (const cmd of hookCommands(list)) {
      const h = hookCommand(cmd, harness);
      if (!h) continue;
      const key = h.owner + "\0" + (h.copy ?? "");
      const g = groups.get(key) ?? { owner: h.owner, copy: h.copy, stale: h.stale, subs: [] };
      g.subs.push(`${event}:${h.sub}`);
      groups.set(key, g);
    }
  }
  return [...groups.values()].map((g) => ({
    kind: "hooks" as const,
    scope,
    file,
    detail: g.subs.join(", "),
    owner: g.owner,
    ...(g.copy ? { copy: g.copy, stale: g.stale } : {}),
  }));
}

/** load-lock entries under `key` (mcpServers / servers / mcp) of a JSON file. */
function mcpServersIn(file: string, key: string, scope: Integration["scope"], cfg?: any): Integration[] {
  const c = cfg ?? readJson(file);
  if (!isObject(c) || !isObject(c[key])) return [];
  const out: Integration[] = [];
  for (const [name, entry] of Object.entries(c[key])) {
    const m = mcpEntry(name, entry);
    if (m) out.push({ kind: "mcp", scope, file, detail: `${key}.${name}`, ...m });
  }
  return out;
}

function policyIn(file: string, scope: Integration["scope"], what: string): Integration[] {
  const text = readText(file);
  if (text === undefined || !text.includes(MD_MARKER)) return [];
  return [{ kind: "policy", scope, file, detail: what, owner: "installer" }];
}

function ruleFile(file: string, scope: Integration["scope"], what: string): Integration[] {
  return fs.existsSync(file) ? [{ kind: "policy", scope, file, detail: what, owner: "installer" }] : [];
}

/** SKILL.md frontmatter `name`, if any. */
function skillName(text: string): string | undefined {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  return m ? /^name:\s*["']?([^"'\r\n]+?)["']?\s*$/m.exec(m[1])?.[1] : undefined;
}

/**
 * load-lock skills (and ACE skills-dir plugin bundles) under a skills dir:
 * `<dir>/load-lock/SKILL.md`, or any `<dir>/<x>/SKILL.md` named load-lock.
 */
function skillsIn(dir: string, scope: Integration["scope"], installerDir?: string): Integration[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: Integration[] = [];
  for (const n of names.sort()) {
    const d = path.join(dir, n);
    const ace = fs.existsSync(path.join(d, ".ace.json"));
    const text = readText(path.join(d, "SKILL.md"));
    if (text !== undefined && (n === "load-lock" || skillName(text) === "load-lock")) {
      out.push({
        kind: "skill",
        scope,
        file: d,
        detail: "SKILL.md",
        owner: ace ? "ace" : d === installerDir ? "installer" : "other",
      });
    }
    // ACE installs Claude plugins as skills-dir plugins (#64 Q4).
    const manifest = readJson(path.join(d, ".claude-plugin", "plugin.json"));
    if (isObject(manifest) && manifest.name === CLAUDE_PLUGIN_NAME) {
      out.push({
        kind: "plugin",
        scope,
        file: d,
        detail: `skills-dir plugin "${CLAUDE_PLUGIN_NAME}"`,
        owner: ace ? "ace" : "other",
      });
    }
  }
  return out;
}

// ------------------------------------------------------------- per harness

interface Ctx {
  home: string;
  project: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
}

function configHome(c: Ctx): string {
  const xdg = c.env.XDG_CONFIG_HOME;
  return xdg && xdg.trim() ? path.resolve(xdg) : path.join(c.home, ".config");
}

function scanClaudeCode(c: Ctx): Integration[] {
  const out: Integration[] = [];
  const claudeJson = path.join(c.home, ".claude.json");
  const cj = readJson(claudeJson);
  out.push(...mcpServersIn(claudeJson, "mcpServers", "user", cj));
  // local-scope servers live under projects[<path>] in ~/.claude.json
  const proj = isObject(cj?.projects) ? cj.projects[c.project] : undefined;
  if (isObject(proj)) out.push(...mcpServersIn(claudeJson, "mcpServers", "project", proj));
  const mcpJson = path.join(c.project, ".mcp.json");
  out.push(...mcpServersIn(mcpJson, "mcpServers", "project"));
  // ACE's MCP install patch uses a `servers` key (#64 Q4)
  out.push(...mcpServersIn(mcpJson, "servers", "project"));

  const settings: [string, Integration["scope"]][] = [
    [path.join(c.home, ".claude", "settings.json"), "user"],
    [path.join(c.project, ".claude", "settings.json"), "project"],
  ];
  for (const [file, scope] of settings) {
    const s = readJson(file);
    if (!isObject(s)) continue;
    out.push(...hooksIn(file, s.hooks, "claude-code", scope));
    if (isObject(s.enabledPlugins)) {
      for (const [key, on] of Object.entries(s.enabledPlugins)) {
        if (key.startsWith(CLAUDE_PLUGIN_NAME + "@")) {
          out.push({ kind: "plugin", scope, file, detail: `enabledPlugins["${key}"]`, owner: "harness", enabled: on === true });
        }
      }
    }
  }
  out.push(...policyIn(path.join(c.home, ".claude", "CLAUDE.md"), "user", "CLAUDE.md section"));
  const userSkills = path.join(c.home, ".claude", "skills");
  out.push(...skillsIn(userSkills, "user", path.join(userSkills, "load-lock")));
  out.push(...skillsIn(path.join(c.project, ".claude", "skills"), "project"));
  return out;
}

function scanOpenCode(c: Ctx): Integration[] {
  const out: Integration[] = [];
  const files: [string, Integration["scope"]][] = [
    [path.join(c.home, ".config", "opencode", "opencode.json"), "user"],
    [path.join(c.project, "opencode.json"), "project"],
  ];
  const stub = path.join(c.home, ".config", "opencode", "plugins", "load-lock");
  for (const [file, scope] of files) {
    const cfg = readJson(file);
    if (!isObject(cfg)) continue;
    // the installer writes `plugins`; OpenCode's documented key is `plugin`
    for (const key of ["plugin", "plugins"]) {
      if (!Array.isArray(cfg[key])) continue;
      for (const p of cfg[key]) {
        if (typeof p !== "string") continue;
        if (p === PKG_NAME || p.startsWith(PKG_NAME + "@")) {
          const owner: Owner = p === PKG_NAME && key === "plugins" && scope === "user" ? "installer" : "other";
          out.push({ kind: "plugin", scope, file, detail: `${key}: "${p}"`, owner });
        } else if (p === stub) {
          out.push({ kind: "plugin", scope, file, detail: `${key}: legacy stub ${p}`, owner: "installer", stale: !fs.existsSync(p) });
        }
      }
    }
    out.push(...mcpServersIn(file, "mcp", scope, cfg));
  }
  if (fs.existsSync(stub)) out.push({ kind: "plugin", scope: "user", file: stub, detail: "legacy plugin stub dir", owner: "installer" });
  out.push(...skillsIn(path.join(c.home, ".config", "opencode", "skills"), "user"));
  out.push(...skillsIn(path.join(c.project, ".opencode", "skills"), "project"));
  return out;
}

/** `[mcp_servers.<name>]` tables in a config.toml that run load-lock. */
function codexToml(file: string): Integration[] {
  const text = readText(file);
  if (text === undefined) return [];
  const lines = text.split(/\r?\n/);
  const out: Integration[] = [];
  for (let i = 0; i < lines.length; i++) {
    const h = /^\[mcp_servers\.("?)([^"\]]+)\1\]\s*$/.exec(lines[i]);
    if (!h) continue;
    let j = i + 1;
    while (j < lines.length && !/^\s*\[/.test(lines[j])) j++;
    const body = lines.slice(i + 1, j).join("\n");
    const args = /^args\s*=\s*\[\s*("(?:[^"\\]|\\.)*")/m.exec(body);
    const command = /^command\s*=\s*("(?:[^"\\]|\\.)*")/m.exec(body);
    const parse = (s?: string) => {
      try {
        return s ? (JSON.parse(s) as string) : undefined;
      } catch {
        return undefined;
      }
    };
    const m = mcpEntry(h[2], { command: parse(command?.[1]), args: [parse(args?.[1]) ?? body] });
    if (!m) continue;
    const tagged = i > 0 && lines[i - 1] === CODEX_TOML_TAG;
    out.push({
      kind: "mcp",
      scope: "user",
      file,
      detail: `[mcp_servers.${h[2]}]`,
      ...m,
      owner: tagged && m.owner === "installer" ? "installer" : "other",
    });
  }
  return out;
}

function scanCodex(c: Ctx): Integration[] {
  const codexHome = c.env.CODEX_HOME ?? path.join(c.home, ".codex");
  const hooksFile = path.join(codexHome, "hooks.json");
  return [
    ...hooksIn(hooksFile, readJson(hooksFile)?.hooks, "codex", "user"),
    ...codexToml(path.join(codexHome, "config.toml")),
    ...policyIn(path.join(codexHome, "AGENTS.md"), "user", "AGENTS.md section"),
    ...skillsIn(path.join(codexHome, "skills"), "user"),
    ...skillsIn(path.join(c.project, ".codex", "skills"), "project"),
  ];
}

function scanCursor(c: Ctx): Integration[] {
  const dir = path.join(c.project, ".cursor");
  const hooksFile = path.join(dir, "hooks.json");
  return [
    ...mcpServersIn(path.join(c.home, ".cursor", "mcp.json"), "mcpServers", "user").map((i) => ({ ...i, owner: "other" as const })),
    ...mcpServersIn(path.join(dir, "mcp.json"), "mcpServers", "project"),
    ...hooksIn(hooksFile, readJson(hooksFile)?.hooks, "cursor", "project"),
    ...ruleFile(path.join(dir, "rules", "load-lock.mdc"), "project", "rule load-lock.mdc"),
  ];
}

function scanGemini(c: Ctx): Integration[] {
  return [
    ...mcpServersIn(path.join(c.home, ".gemini", "settings.json"), "mcpServers", "user"),
    ...policyIn(path.join(c.home, ".gemini", "GEMINI.md"), "user", "GEMINI.md section"),
  ];
}

function scanCopilot(c: Ctx): Integration[] {
  return [
    ...mcpServersIn(path.join(c.home, ".copilot", "mcp-config.json"), "mcpServers", "user"),
    ...policyIn(path.join(c.home, ".copilot", "copilot-instructions.md"), "user", "copilot-instructions.md section"),
    ...skillsIn(path.join(c.project, ".github", "skills"), "project"),
  ];
}

function scanCline(c: Ctx): Integration[] {
  const file = c.env.CLINE_MCP_SETTINGS_PATH?.trim()
    ? path.resolve(c.env.CLINE_MCP_SETTINGS_PATH)
    : path.join(c.home, ".cline", "data", "settings", "cline_mcp_settings.json");
  return [
    ...mcpServersIn(file, "mcpServers", "user"),
    ...ruleFile(path.join(c.home, ".cline", "rules", "load-lock.md"), "user", "rule load-lock.md"),
  ];
}

/** Global Roo/Zoo mcp_settings.json files (same list as the installer). */
function rooGlobalMcpFiles(c: Ctx): string[] {
  const appData = c.platform === "darwin" ? path.join(c.home, "Library", "Application Support") : configHome(c);
  const out: string[] = [];
  for (const editor of ["Code", "Code - OSS", "VSCodium"]) {
    for (const ext of ["roocode.roo-cline", "RooCodeInc.roo-code", "ZooCodeOrganization.zoo-code"]) {
      const f = path.join(appData, editor, "User", "globalStorage", ext, "settings", "mcp_settings.json");
      if (fs.existsSync(f)) out.push(f);
    }
  }
  return out;
}

function scanRoo(c: Ctx): Integration[] {
  return [
    ...mcpServersIn(path.join(c.project, ".roo", "mcp.json"), "mcpServers", "project"),
    ...rooGlobalMcpFiles(c).flatMap((f) => mcpServersIn(f, "mcpServers", "user")),
    ...ruleFile(path.join(c.home, ".roo", "rules", "load-lock.md"), "user", "rule load-lock.md"),
  ];
}

function scanGoose(c: Ctx): Integration[] {
  const out: Integration[] = [];
  const file = path.join(configHome(c), "goose", "config.yaml");
  const text = readText(file);
  if (text !== undefined) {
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!/^\s+load-lock:\s*(#.*)?$/.test(lines[i])) continue;
      const marked = i > 0 && lines[i - 1].trim() === GOOSE_BEGIN;
      const args = /^\s+args:\s*\[\s*("(?:[^"\\]|\\.)*")/.exec(lines.slice(i + 1, i + 8).find((l) => /^\s+args:/.test(l)) ?? "");
      let copy: string | null = null;
      let stale: boolean | undefined;
      try {
        const a = args ? (JSON.parse(args[1]) as string) : undefined;
        copy = a ? copyOfEntry(a, "mcp") : null;
        if (a && copy) stale = !fs.existsSync(a);
      } catch {
        /* unparseable args — report without a copy */
      }
      out.push({
        kind: "mcp",
        scope: "user",
        file,
        detail: "extensions.load-lock",
        owner: marked ? "installer" : "other",
        ...(copy ? { copy, stale } : {}),
      });
    }
  }
  out.push(...policyIn(path.join(configHome(c), "goose", ".goosehints"), "user", ".goosehints section"));
  return out;
}

function scanOmac(c: Ctx): Integration[] {
  const file = path.join(configHome(c), "omac", "sandbox-profiles", "default.json");
  const p = readJson(file);
  if (!isObject(p)) return [];
  const stateDir = resolveStateDir(c.platform, c.env);
  const grants: string[] = [];
  if (isObject(p.filesystem) && Array.isArray(p.filesystem.allow_unix_dir) && p.filesystem.allow_unix_dir.includes(stateDir)) {
    grants.push("filesystem.allow_unix_dir");
  }
  if (isObject(p.filesystem) && Array.isArray(p.filesystem.read) && p.filesystem.read.some((r: unknown) => typeof r === "string" && r.endsWith(path.join("node_modules", PKG_NAME)))) {
    grants.push("filesystem.read");
  }
  if (isObject(p.environment) && Array.isArray(p.environment.allow_vars) && p.environment.allow_vars.includes("LOAD_LOCK_*")) {
    grants.push("environment.allow_vars");
  }
  return grants.length ? [{ kind: "grants", scope: "user", file, detail: grants.join(", "), owner: "installer" }] : [];
}

const SCANNERS: Record<Harness, (c: Ctx) => Integration[]> = {
  "claude-code": scanClaudeCode,
  opencode: scanOpenCode,
  codex: scanCodex,
  cursor: scanCursor,
  "gemini-cli": scanGemini,
  "copilot-cli": scanCopilot,
  cline: scanCline,
  "roo-code": scanRoo,
  goose: scanGoose,
  omac: scanOmac,
};

// ------------------------------------------------------------ rung + findings

/** A plugin entry the harness will actually load (ACE skills-dir plugins are unverified, #63). */
export function activePlugin(i: Integration): boolean {
  return i.kind === "plugin" && i.owner !== "ace" && i.enabled !== false && !i.detail.includes("legacy") && i.stale !== true;
}

function rungOf(list: Integration[]): Rung {
  if (list.some(activePlugin)) return "plugin";
  if (list.some((i) => i.kind === "hooks" || i.kind === "policy" || i.kind === "grants")) return "loose";
  if (list.some((i) => i.kind === "mcp")) return "mcp";
  if (list.some((i) => i.kind === "skill")) return "skill";
  return "none";
}

function findingsOf(h: Harness, list: Integration[]): string[] {
  const f: string[] = [];
  const plugins = list.filter(activePlugin);
  const hooks = list.filter((i) => i.kind === "hooks");
  const mcps = list.filter((i) => i.kind === "mcp");
  const skills = list.filter((i) => i.kind === "skill");

  if (plugins.length && hooks.length) {
    f.push(`loose + plugin double install: hooks in ${[...new Set(hooks.map((i) => i.file))].join(", ")} run next to the plugin's`);
  }
  if (plugins.length > 1) f.push(`plugin registered ${plugins.length} times: ${plugins.map((i) => i.detail).join("; ")}`);
  // A Claude Code plugin bundles an MCP server; the OpenCode plugin brings its own tools.
  const toolSources = mcps.length + (plugins.length ? 1 : 0);
  if (toolSources > 1) {
    f.push(
      `MCP registered ${toolSources} times: ` +
        [...(plugins.length ? [h === "opencode" ? "plugin tools" : "plugin-bundled server"] : []), ...mcps.map((i) => `${i.detail} in ${i.file}`)].join("; "),
    );
  }
  const hookCopies = new Set(hooks.map((i) => i.copy ?? i.owner + i.file));
  if (hookCopies.size > 1) f.push(`hooks from ${hookCopies.size} different sources: ${hooks.map((i) => i.copy ?? i.file).join("; ")}`);
  for (const i of hooks) {
    const subs = i.detail.split(", ");
    if (new Set(subs).size !== subs.length) f.push(`duplicate hook entries in ${i.file}: ${i.detail}`);
  }
  if (skills.length > 1) f.push(`skill installed ${skills.length} times: ${skills.map((i) => i.file).join("; ")}`);
  for (const i of list) {
    if (i.stale) f.push(`stale ${i.kind} entry (${i.detail} in ${i.file}) points at a missing copy${i.copy ? ` ${i.copy}` : ""}`);
    if (i.kind === "plugin" && i.enabled === false) f.push(`plugin ${i.detail} is installed but disabled`);
    if (i.kind === "plugin" && i.owner === "ace") f.push(`ACE skills-dir plugin at ${i.file} (whether Claude Code loads it is unverified, see #63)`);
  }
  return f;
}

// ------------------------------------------------------------------ public

export function inventory(opts: InventoryOptions): Inventory {
  const c: Ctx = {
    home: opts.home ?? os.homedir(),
    project: path.resolve(opts.project),
    env: opts.env ?? process.env,
    platform: opts.platform ?? process.platform,
  };
  const harnesses = HARNESSES.map((h) => {
    let integrations: Integration[];
    try {
      integrations = SCANNERS[h](c);
    } catch {
      integrations = []; // best-effort: a scanner never fails the inventory
    }
    return { harness: h, rung: rungOf(integrations), integrations, findings: findingsOf(h, integrations) };
  });

  const stateDir = resolveStateDir(c.platform, c.env);
  const copies = findInstalledCopies(c.platform, c.env);
  const dinfo = readDaemonInfo(stateDir);
  const findings: string[] = [];
  const versions = new Set(copies.map((x) => x.version).filter((v): v is string => v !== null));
  if (versions.size > 1) {
    findings.push(`multiple load-lock versions installed (${[...versions].sort().join(", ")}); the daemon moves to the newest copy that contacts it`);
  }
  return {
    home: c.home,
    project: c.project,
    harnesses,
    runtime: {
      copies,
      daemon: dinfo?.packageRoot ? { path: dinfo.packageRoot, version: dinfo.version ?? null } : null,
      known: loadRuntimes(stateDir),
    },
    findings,
  };
}

const RUNG_LABEL: Record<Rung, string> = {
  plugin: "plugin",
  loose: "loose (`load-lock install`)",
  mcp: "MCP only",
  skill: "skill only",
  none: "not installed",
};

/** Human-readable inventory. */
export function formatInventory(inv: Inventory): string {
  const tilde = (p: string) => (p === inv.home || p.startsWith(inv.home + path.sep) ? "~" + p.slice(inv.home.length) : p);
  const lines: string[] = [`load-lock setup: inventory (read-only), project ${tilde(inv.project)}`, ""];
  const width = Math.max(...inv.harnesses.map((h) => h.harness.length));
  for (const h of inv.harnesses) {
    lines.push(`${h.harness.padEnd(width)}  ${RUNG_LABEL[h.rung]}`);
    for (const i of h.integrations) {
      const via = i.copy ? ` -> ${tilde(i.copy)}${i.stale ? " (missing)" : ""}` : "";
      const en = i.enabled === false ? " (disabled)" : "";
      lines.push(`  ${i.kind.padEnd(6)} ${i.scope.padEnd(7)} ${tilde(i.file)}: ${i.detail}${en} [${i.owner}]${via}`);
    }
    for (const f of h.findings) lines.push(`  ! ${f.split(inv.home).join("~")}`);
  }
  lines.push("", "runtime copies:");
  for (const x of inv.runtime.copies) lines.push(`  ${x.source.padEnd(14)} ${x.version ?? "?"}  ${tilde(x.path)}`);
  if (inv.runtime.daemon) lines.push(`  daemon runs    ${inv.runtime.daemon.version ?? "?"}  ${tilde(inv.runtime.daemon.path)}`);
  for (const k of inv.runtime.known) lines.push(`  seen by daemon ${k.version}  ${tilde(k.path)}`);
  for (const f of inv.findings) lines.push(`  ! ${f}`);
  return lines.join("\n");
}
