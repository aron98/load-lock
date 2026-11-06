import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Static consistency checks for the Hermes plugin (plugins/hermes).
 *
 * The plugin is Python + JSON + browser JS, so it can't run under the
 * compiled TS test suite; these layout checks keep the parts that MUST
 * agree from drifting: the manifest's declared tools, the registered
 * handlers, the tool schemas, the dashboard manifest, and the launcher
 * version pins (verified against package.json via scripts/check-pins.mjs).
 */

const here = dirname(fileURLToPath(import.meta.url));
const pluginDir = join(here, "..", "..", "plugins", "hermes");
const read = (rel: string) => readFileSync(join(pluginDir, rel), "utf8");

function yamlStringList(text: string, key: string): string[] {
  const m = text.match(new RegExp(`^${key}:[ \\t]*\\n((?:[ \\t]+- [^\\n]*\\n?)+)`, "m"));
  if (!m) throw new Error(`no list field "${key}" in plugin.yaml`);
  return m[1]
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("- "))
    .map((l) => l.slice(2).trim().replace(/^["']|["']$/g, ""));
}

test("hermes plugin: manifest tools == registered handlers == schemas == provides_tools", () => {
  const manifest = read("plugin.yaml");
  const tools = read("tools.py");
  const schemas = read("schemas.py");

  const declared = yamlStringList(manifest, "provides_tools");
  const handlers = [...tools.matchAll(/^ {4}"(load_lock_[a-z_]+)": \(/gm)].map((m) => m[1]);
  const schemaKeys = [...schemas.matchAll(/^ {4}"(load_lock_[a-z_]+)": \{/gm)].map((m) => m[1]);

  assert.ok(declared.length >= 15, `provides_tools suspiciously small: ${declared.length}`);
  assert.deepEqual([...declared].sort(), [...handlers].sort(), "plugin.yaml provides_tools != tools.py HANDLERS keys");
  assert.deepEqual([...declared].sort(), [...schemaKeys].sort(), "plugin.yaml provides_tools != schemas.py SCHEMAS keys");
});

test("hermes plugin: hooks and skill are declared and present", () => {
  const manifest = read("plugin.yaml");
  const declaredHooks = yamlStringList(manifest, "provides_hooks");
  assert.deepEqual(
    declaredHooks.sort(),
    ["on_session_end", "post_compaction", "pre_llm_call"],
    "unexpected provides_hooks",
  );
  const tools = read("tools.py");
  assert.match(tools, /\bdef pre_llm_call\(/, "pre_llm_call handler missing");
  assert.match(tools, /\bdef post_compaction\(/, "post_compaction handler missing");
  assert.match(tools, /\bdef on_session_end\(/, "on_session_end handler missing");
  assert.match(read("__init__.py"), /register_skill\(/, "skill registration missing");
});

test("hermes plugin: dashboard surface is coherent", () => {
  const dashboard = JSON.parse(read("dashboard/manifest.json"));
  assert.equal(dashboard.name, "load-lock");
  assert.equal(dashboard.api, "plugin_api.py");
  assert.equal(dashboard.entry, "dist/index.js");
  assert.equal(dashboard.css, "dist/style.css");
  assert.equal(dashboard.tab.path, "/load-lock");

  const api = read("dashboard/plugin_api.py");
  assert.match(api, /router = APIRouter\(\)/, "dashboard api must export a FastAPI router");
  for (const route of ["/snapshot", "/machine", "/events"]) {
    assert.match(api, new RegExp(`@router\\.get\\("${route.replace("/", "\\/")}"\\)`), `missing route ${route}`);
  }

  const js = read("dashboard/dist/index.js");
  assert.match(js, /register\("load-lock"/, "frontend must register the load-lock page");
  assert.doesNotMatch(js, /<[A-Z][A-Za-z]*>/, "no JSX allowed: the SDK ships plain React only");
});

test("hermes plugin: desktop half is coherent", () => {
  const plugin = read("desktop/plugin.js");

  // Import allowlist enforced by the desktop runtime loader: only
  // '@hermes/plugin-sdk' and 'react*' may appear in import statements.
  const imports = [...plugin.matchAll(/^\s*import\s+(?:[^;]+?\s+from\s+)?["']([^"']+)["']/gm)].map((m) => m[1]);
  assert.ok(imports.length >= 3, "desktop plugin should import the SDK and react");
  for (const spec of imports) {
    assert.ok(
      spec === "@hermes/plugin-sdk" || spec.startsWith("react"),
      `desktop plugin may only import @hermes/plugin-sdk and react*, found "${spec}"`,
    );
  }
  assert.doesNotMatch(plugin, /<[A-Z][A-Za-z]*>/, "no JSX syntax: use jsx()/jsxs() from react/jsx-runtime");
  // jsx()/jsxs() take children only via props.children; a third positional
  // argument is the key, so `jsxs(type, props, [kids])` renders an empty element.
  assert.doesNotMatch(
    plugin,
    /\bjsxs?\([^()]*\{[^{}]*\}\s*,\s*\[/,
    "jsx()/jsxs() positional children are dropped: pass children in props or use h()",
  );

  // Default HermesPlugin export with the load-lock id and a register().
  assert.match(plugin, /const ID = ["']load-lock["']/, "missing ID constant");
  assert.match(plugin, /export default \{[\s\S]*id: ID,/, "missing default HermesPlugin export with id");
  assert.match(plugin, /register\(ctx\)/, "missing register(ctx)");

  // The three contributions: pane + status-bar chip + palette row.
  assert.match(plugin, /area: PANES_AREA/, "pane contribution missing");
  assert.match(plugin, /area: STATUSBAR_AREAS\.right/, "status-bar chip contribution missing");
  assert.match(plugin, /area: PALETTE_AREA/, "palette contribution missing");
  // Chip reveals the pane via its namespaced id (<pluginId>:<localId>).
  assert.match(plugin, /PANE_ID = [`"'](?:\$\{ID\}:pane|load-lock:pane)[`"']/, "pane id must be the namespaced load-lock:pane");
  assert.match(plugin, /host\.revealPane\(/, "chip/palette must reveal the pane via host.revealPane");
});

test("hermes plugin: launcher pins are in sync with package.json", async () => {
  const root = join(here, "..", "..");
  const { checkPins, readPackageVersion } = await import(join(root, "scripts", "check-pins.mjs"));
  const problems = checkPins(root, readPackageVersion(root));
  assert.deepEqual(problems, [], "version pins out of sync — run `node scripts/check-pins.mjs --write`");
});
