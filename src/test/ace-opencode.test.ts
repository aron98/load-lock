/**
 * ACE detection of the `ace/opencode/` pointer folder (issue #79).
 *
 * Reimplements ACE's repo-sync discovery as of TNG/ace@b703410
 * (https://github.com/TNG/ace/tree/b703410218833071800cc918cb95718e0404640a):
 *  - backend/app/features/repo_ingestion/service/repo_ingest/
 *    repo_ingestion_archive_discovery_service.py: `_discover`,
 *    `_opencode_local_candidates`, `_npm_plugin_candidates`
 *  - backend/app/domain/kinds/__init__.py: `detect_kind`,
 *    `entry_point_filenames` (SPEC order skill, subagent, mcp, policy, plugin)
 *  - backend/app/domain/kinds/plugin_kind.py: `ENTRY_POINT_PATH`,
 *    `OPENCODE_LOCAL_ENTRY_POINT`, `OPENCODE_PLUGIN_DIRS`,
 *    `opencode_local_plugin_dir`, `_resolve_package_main`,
 *    `resolve_npm_entry_point`, `is_opencode_npm_candidate`,
 *    `derive_npm_plugin_name`
 * and runs it over this repo's git tree (what a GitHub zipball contains).
 * Light: files only, no daemon.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");

// ------------------------------------------------------------ ACE mirror

type Files = Map<string, string>;
type Kind = "skill" | "subagent" | "mcp" | "policy" | "plugin";
interface Discovered {
  subpath: string;
  kind: Kind;
  format: "claude" | "opencode" | null;
  npmEntryPoint: string | null;
}

// plugin_kind.py
const ENTRY_POINT_PATH = ".claude-plugin/plugin.json";
const OPENCODE_LOCAL_ENTRY_POINT = ".opencode/plugins/plugin.ts";
const OPENCODE_PLUGIN_DIRS = [".opencode/plugins", ".opencode/plugin"];
const JS_ENTRY_EXTENSIONS = [".ts", ".js", ".mjs", ".cjs"];

// kinds/__init__.py: each SPEC's entry_point_filename, in SPEC order.
const KIND_ENTRIES: [Kind, string[]][] = [
  ["skill", ["SKILL.md"]],
  ["subagent", ["AGENT.md"]],
  ["mcp", ["mcp.json"]],
  ["policy", ["policy.md"]],
  ["plugin", [ENTRY_POINT_PATH, OPENCODE_LOCAL_ENTRY_POINT]],
];

function detectKind(names: Set<string>): Kind | null {
  const matched = KIND_ENTRIES.filter(([, entries]) => entries.some((e) => names.has(e))).map(([k]) => k);
  return matched.length === 1 ? matched[0] : null;
}

function loadPackageJson(files: Files): Record<string, unknown> | null {
  const raw = files.get("package.json");
  if (raw === undefined) return null;
  try {
    const m = JSON.parse(raw);
    return m && typeof m === "object" && !Array.isArray(m) ? m : null;
  } catch {
    return null;
  }
}

const normaliseRelpath = (p: string) => {
  p = p.replace(/\\/g, "/");
  return p.startsWith("./") ? p.slice(2) : p;
};

function resolvePackageMain(m: Record<string, unknown>): string | null {
  const main = m.main;
  if (typeof main === "string" && main.trim()) return normaliseRelpath(main);
  const exp = m.exports;
  let candidate: unknown = null;
  if (typeof exp === "string") candidate = exp;
  else if (exp && typeof exp === "object") {
    const root = (exp as Record<string, unknown>)["."];
    if (typeof root === "string") candidate = root;
    else if (root && typeof root === "object") {
      const r = root as Record<string, unknown>;
      candidate = r.import || r.require || r.default; // Python `or` chain
    }
  }
  return typeof candidate === "string" ? normaliseRelpath(candidate) : null;
}

function opencodeLocalPluginDir(path: string): string | null {
  const p = path.replace(/\\/g, "/");
  if (!JS_ENTRY_EXTENSIONS.some((e) => p.endsWith(e))) return null;
  for (const pdir of OPENCODE_PLUGIN_DIRS) {
    const seg = pdir + "/";
    if (p.startsWith(seg)) {
      if (!p.slice(seg.length).includes("/")) return "";
    } else {
      const marker = "/" + seg;
      const i = p.indexOf(marker);
      if (i !== -1 && !p.slice(i + marker.length).includes("/")) return p.slice(0, i);
    }
  }
  return null;
}

function resolveNpmEntryPoint(files: Files): string | null {
  const m = loadPackageJson(files);
  if (m === null) return null;
  const entry = resolvePackageMain(m);
  return entry !== null && files.has(entry) ? entry : null;
}

function isOpencodeNpmCandidate(files: Files, entry: string): boolean {
  if (!JS_ENTRY_EXTENSIONS.some((e) => entry.endsWith(e))) return false;
  const m = loadPackageJson(files);
  if (m === null) return false;
  let haystack = typeof m.name === "string" ? m.name : "";
  if (Array.isArray(m.keywords)) haystack += " " + m.keywords.filter((k) => typeof k === "string").join(" ");
  return haystack.toLowerCase().includes("opencode");
}

function deriveNpmPluginName(files: Files): string | null {
  const name = loadPackageJson(files)?.name;
  if (typeof name !== "string" || !name.trim()) return null;
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || null;
}

function npmPluginCandidates(files: Files, claimed: Set<string>): Map<string, string> {
  const dirs = new Set<string>();
  for (const p of files.keys()) {
    if (p === "package.json") dirs.add("");
    else if (p.endsWith("/package.json")) dirs.add(p.slice(0, -"/package.json".length));
  }
  const out = new Map<string, string>();
  for (const d of dirs) {
    if (claimed.has(d)) continue;
    const prefix = d === "" ? "" : d + "/";
    const local: Files = new Map();
    for (const [p, data] of files) if (p === d || p.startsWith(prefix)) local.set(p.slice(prefix.length), data);
    const entry = resolveNpmEntryPoint(local);
    if (entry !== null && isOpencodeNpmCandidate(local, entry)) out.set(d, entry);
  }
  return out;
}

function discover(files: Files): { discovered: Discovered[]; skips: string[] } {
  const entries = KIND_ENTRIES.flatMap(([, e]) => e);
  const roots = new Map<string, Set<string>>();
  const add = (d: string, e: string) => (roots.get(d) ?? roots.set(d, new Set()).get(d)!).add(e);
  for (const p of files.keys()) {
    for (const entry of entries) {
      if (p === entry) add("", entry);
      else if (p.endsWith("/" + entry)) add(p.slice(0, -(entry.length + 1)), entry);
    }
  }
  const discovered: Discovered[] = [];
  const skips: string[] = [];
  for (const [d, present] of roots) {
    const kind = detectKind(present);
    if (kind === null) {
      skips.push(`${d || "<root>"}: ambiguous entry-point files ${[...present].sort().join(",")}`);
      continue;
    }
    let format: Discovered["format"] = null;
    if (kind === "plugin") {
      const claude = present.has(ENTRY_POINT_PATH);
      if (claude && present.has(OPENCODE_LOCAL_ENTRY_POINT)) skips.push(`${d || "<root>"}: both Claude Code and OpenCode plugin entry points present`);
      format = claude ? "claude" : "opencode";
    }
    discovered.push({ subpath: d, kind, format, npmEntryPoint: null });
  }
  let claimed = new Set(roots.keys());
  const claudeDirs = new Set(discovered.filter((x) => x.kind === "plugin" && x.format === "claude").map((x) => x.subpath));
  const localDirs = new Set<string>();
  for (const p of files.keys()) {
    const d = opencodeLocalPluginDir(p);
    if (d !== null) localDirs.add(d);
  }
  for (const d of [...localDirs].filter((x) => !claimed.has(x)).sort()) {
    discovered.push({ subpath: d, kind: "plugin", format: "opencode", npmEntryPoint: null });
    skips.push(`${d || "<root>"}: detected as a local OpenCode plugin (.opencode/plugins/) — verify before registering`);
  }
  for (const d of [...localDirs].filter((x) => claudeDirs.has(x)).sort()) {
    skips.push(`${d || "<root>"}: both Claude Code and OpenCode plugin entry points present`);
  }
  claimed = new Set([...claimed, ...localDirs]);
  for (const [d, entry] of npmPluginCandidates(files, claimed)) {
    discovered.push({ subpath: d, kind: "plugin", format: "opencode", npmEntryPoint: entry });
    skips.push(`${d || "<root>"}: detected as an npm-distributed OpenCode plugin via package.json heuristic — verify before registering`);
  }
  return { discovered, skips };
}

// ------------------------------------------------------------ fixtures

/** The repo's git tree (tracked + untracked-not-ignored), as a GitHub zipball would carry it. */
function repoTree(): Files | null {
  const r = spawnSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: REPO_ROOT, encoding: "utf8" });
  if (r.status !== 0) return null;
  const files: Files = new Map();
  for (const p of r.stdout.split("\0")) {
    if (!p || !existsSync(join(REPO_ROOT, p))) continue; // deleted-but-staged
    files.set(p, p.endsWith(".json") ? readFileSync(join(REPO_ROOT, p), "utf8") : "");
  }
  return files;
}

const opencodePlugins = (d: Discovered[]) => d.filter((x) => x.kind === "plugin" && x.format === "opencode");

// ------------------------------------------------------------ tests

test("ace-opencode: mirror matches ACE on known shapes", () => {
  // Root package.json whose entry is gitignored build output: not detected (#64 finding).
  const root = discover(new Map([["package.json", JSON.stringify({ name: "@aron98/load-lock", keywords: ["opencode"], exports: { ".": { default: "./dist/x.js" } } })]]));
  assert.deepEqual(opencodePlugins(root.discovered), []);
  // Resolvable entry but no "opencode" naming signal: not detected.
  const noSignal = discover(new Map([["p/package.json", JSON.stringify({ name: "x", main: "i.js" })], ["p/i.js", ""]]));
  assert.deepEqual(opencodePlugins(noSignal.discovered), []);
  // A folder claimed by a Claude plugin manifest is never an npm candidate.
  const claimed = discover(new Map([
    ["p/package.json", JSON.stringify({ name: "x-opencode", main: "i.js" })],
    ["p/i.js", ""],
    ["p/.claude-plugin/plugin.json", "{}"],
  ]));
  assert.deepEqual(opencodePlugins(claimed.discovered), []);
  // exports "." import condition wins over require/default.
  const exp = discover(new Map([
    ["p/package.json", JSON.stringify({ name: "y", keywords: ["OpenCode"], exports: { ".": { import: "./a.mjs", default: "./b.js" } } })],
    ["p/a.mjs", ""],
  ]));
  assert.deepEqual(opencodePlugins(exp.discovered).map((x) => [x.subpath, x.npmEntryPoint]), [["p", "a.mjs"]]);
});

test("ace-opencode: this repo yields exactly one OpenCode plugin, at ace/opencode", (t) => {
  const files = repoTree();
  if (files === null) return t.skip("not a git checkout");
  assert.ok(files.has("ace/opencode/package.json"), "ace/opencode/package.json must be tracked");
  const { discovered, skips } = discover(files);
  const oc = opencodePlugins(discovered);
  assert.deepEqual(oc.map((x) => [x.subpath, x.npmEntryPoint]), [["ace/opencode", "index.js"]], JSON.stringify(discovered));
  // Detected only via the npm heuristic, never via a flat entry point or a local .opencode/plugins/ file.
  assert.ok(!discovered.some((x) => x.subpath === "ace/opencode" && x.npmEntryPoint === null));
  // No ambiguity / dual-format skip for the folder; ACE's only note is the informational "verify before registering".
  const ours = skips.filter((s) => s.startsWith("ace/opencode:"));
  assert.equal(ours.length, 1, ours.join("\n"));
  assert.match(ours[0], /npm-distributed OpenCode plugin .* verify before registering/);
  assert.ok(!skips.some((s) => s.includes("ambiguous") || s.includes("both Claude Code and OpenCode")), skips.join("\n"));

  // Artifact name ACE derives from package.json.
  const bundle: Files = new Map();
  for (const [p, d] of files) if (p.startsWith("ace/opencode/")) bundle.set(p.slice("ace/opencode/".length), d);
  assert.equal(deriveNpmPluginName(bundle), "load-lock-opencode");
});

test("ace-opencode: folder is a thin pointer to the published package, pinned to package.json", () => {
  const dir = join(REPO_ROOT, "ace", "opencode");
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const version = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")).version;
  assert.equal(pkg.private, true, "never publishable by accident");
  assert.equal(pkg.dependencies["@aron98/load-lock"], version);
  const code = readFileSync(join(dir, pkg.main), "utf8")
    .split("\n")
    .filter((l) => l.trim() && !l.trim().startsWith("//"));
  assert.deepEqual(code, [`export { default } from "@aron98/load-lock";`]);
});

test("ace-opencode: pin is declared in check-pins and --write rewrites it", async () => {
  const script = join(REPO_ROOT, "scripts", "check-pins.mjs");
  const pins = await import(pathToFileURL(script).href);
  const entry = pins.PINNED.find((e: { path: string }) => e.path === "ace/opencode/package.json");
  assert.deepEqual(entry, { path: "ace/opencode/package.json", kind: "json", key: "dependencies.@aron98/load-lock" });

  const root = mkdtempSync(join(tmpdir(), "ll-aceoc-"));
  try {
    mkdirSync(join(root, "ace", "opencode"), { recursive: true });
    const src = readFileSync(join(REPO_ROOT, "ace", "opencode", "package.json"), "utf8");
    writeFileSync(join(root, "ace", "opencode", "package.json"), src.replace(/"@aron98\/load-lock": "[^"]+"/, `"@aron98/load-lock": "0.0.1"`));
    assert.equal(pins.checkPins(root, "9.9.9", [entry]).length, 1);
    assert.deepEqual(pins.writePins(root, "9.9.9", [entry]), ["ace/opencode/package.json"]);
    assert.deepEqual(pins.checkPins(root, "9.9.9", [entry]), []);
    const after = JSON.parse(readFileSync(join(root, "ace", "opencode", "package.json"), "utf8"));
    assert.equal(after.dependencies["@aron98/load-lock"], "9.9.9");
    assert.equal(after.name, "load-lock-opencode");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
