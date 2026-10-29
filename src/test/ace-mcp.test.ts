/**
 * Contract test for the ACE MCP artifact (issue #65): `ace/mcp/mcp.json`
 * must validate against ACE's manifest schema, as found in the #64 spike,
 * and the folder must pass ACE's file-level rules. Light: files only, no
 * daemon. (`load-lock mcp` itself is exercised in mcp.test.ts.)
 *
 * Source of truth, copied verbatim below:
 * https://github.com/TNG/ace/blob/b703410218833071800cc918cb95718e0404640a/backend/app/domain/kinds/mcp_manifest.schema.json
 * Rules from the same revision: backend/app/domain/kinds/MCP.md (inline
 * secrets), compliance_mcp_rule_checks_service.py (`_first_non_flag`,
 * companion-file roots), artifact_import_zip_safety_service.py (forbidden
 * names in a non-plugin bundle), and artifact_import_entry_points_service.py
 * (`_split_mcp_bundle_members`, `_require_companion_files_match` — the MCP
 * bundle layout rules mirrored below; issue #98).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ACE_MCP_DIR = join(REPO_ROOT, "ace", "mcp");
const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));

const ACE_MCP_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  required: ["name", "transport"],
  properties: {
    name: { type: "string", minLength: 1 },
    description: { type: "string" },
    transport: { type: "string", enum: ["stdio", "http", "sse"] },
    command: { type: "string", minLength: 1 },
    args: { type: "array", items: { type: "string" } },
    env: { type: "object", additionalProperties: { type: "string" } },
    cwd: { type: "string" },
    companion_files: { type: "array", items: { type: "string" } },
    url: { type: "string", format: "uri", pattern: "^https://" },
    headers: { type: "object", additionalProperties: { type: "string" } },
  },
  additionalProperties: false,
  oneOf: [
    {
      title: "Stdio (local) MCP",
      properties: { transport: { const: "stdio" } },
      required: ["transport", "command"],
      not: { anyOf: [{ required: ["url"] }, { required: ["headers"] }] },
    },
    {
      title: "HTTP/SSE (remote) MCP",
      properties: { transport: { enum: ["http", "sse"] } },
      required: ["transport", "url"],
      not: {
        anyOf: [
          { required: ["command"] },
          { required: ["args"] },
          { required: ["env"] },
          { required: ["cwd"] },
          { required: ["companion_files"] },
        ],
      },
    },
  ],
};

/**
 * Minimal JSON Schema check covering exactly the keywords the ACE schema
 * uses (`format` is annotation-only in 2020-12). Returns error paths.
 */
function validate(schema: any, v: any, path = "$"): string[] {
  const errs: string[] = [];
  const isObj = (x: unknown) => typeof x === "object" && x !== null && !Array.isArray(x);
  if (schema.type) {
    const ok = schema.type === "array" ? Array.isArray(v) : schema.type === "object" ? isObj(v) : typeof v === schema.type;
    if (!ok) return [`${path}: expected ${schema.type}`];
  }
  if ("const" in schema && v !== schema.const) errs.push(`${path}: expected ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(v)) errs.push(`${path}: not one of ${schema.enum.join("|")}`);
  if (schema.minLength !== undefined && typeof v === "string" && v.length < schema.minLength) errs.push(`${path}: too short`);
  if (schema.pattern && typeof v === "string" && !new RegExp(schema.pattern, "u").test(v)) errs.push(`${path}: pattern`);
  if (schema.items && Array.isArray(v)) v.forEach((x, i) => errs.push(...validate(schema.items, x, `${path}[${i}]`)));
  if (isObj(v)) {
    for (const k of schema.required ?? []) if (!(k in v)) errs.push(`${path}: missing ${k}`);
    for (const [k, x] of Object.entries(v)) {
      if (schema.properties && k in schema.properties) errs.push(...validate(schema.properties[k], x, `${path}.${k}`));
      else if (schema.additionalProperties === false) errs.push(`${path}.${k}: unknown field`);
      else if (isObj(schema.additionalProperties)) errs.push(...validate(schema.additionalProperties, x, `${path}.${k}`));
    }
  }
  if (schema.anyOf && !schema.anyOf.some((s: any) => validate(s, v, path).length === 0)) errs.push(`${path}: anyOf`);
  if (schema.not && validate(schema.not, v, path).length === 0) errs.push(`${path}: matches not`);
  if (schema.oneOf) {
    const n = schema.oneOf.filter((s: any) => validate(s, v, path).length === 0).length;
    if (n !== 1) errs.push(`${path}: matches ${n} oneOf branches`);
  }
  return errs;
}

/** ACE's `_first_non_flag`: the package the npx shim will fetch, shown to reviewers. */
function firstNonFlag(args: string[]): string | undefined {
  return args.find((a) => !a.startsWith("-") && a !== "dlx");
}

const SECRET_KEY = /^(authorization|.*token|.*key|.*secret)$/i;

const manifest = JSON.parse(readFileSync(join(ACE_MCP_DIR, "mcp.json"), "utf8"));

test("ace mcp.json: validates against ACE's manifest schema", () => {
  assert.deepEqual(validate(ACE_MCP_SCHEMA, manifest), []);
});

test("ace mcp.json: the validator rejects what ACE rejects", () => {
  const ok = { name: "x", transport: "stdio", command: "npx" };
  assert.deepEqual(validate(ACE_MCP_SCHEMA, ok), []);
  assert.notDeepEqual(validate(ACE_MCP_SCHEMA, { ...ok, mode: "local" }), [], "unknown field (no `mode`)");
  assert.notDeepEqual(validate(ACE_MCP_SCHEMA, { name: "x", transport: "stdio" }), [], "stdio without command");
  assert.notDeepEqual(validate(ACE_MCP_SCHEMA, { ...ok, url: "https://x" }), [], "stdio with url");
  assert.notDeepEqual(validate(ACE_MCP_SCHEMA, { ...ok, transport: "local" }), [], "bad transport");
  assert.notDeepEqual(validate(ACE_MCP_SCHEMA, { ...ok, args: ["a", 1] }), [], "non-string arg");
  assert.notDeepEqual(validate(ACE_MCP_SCHEMA, { ...ok, name: "" }), [], "empty name");
});

test("ace mcp.json: local npx server running `load-lock mcp` at the package.json pin", () => {
  assert.equal(manifest.name, "load-lock");
  assert.equal(manifest.transport, "stdio", "local only, never remote");
  assert.equal(manifest.command, "npx");
  assert.deepEqual(manifest.args, ["-y", `${pkg.name}@${pkg.version}`, "mcp"]);
  // ACE's mcp_local_command_safe shows reviewers this as the fetched package.
  assert.equal(firstNonFlag(manifest.args), `${pkg.name}@${pkg.version}`);
  // npx runs the bin named after the unscoped package; it must be the CLI.
  const unscoped = String(pkg.name).split("/").pop()!;
  assert.equal(pkg.bin[unscoped], "dist/cli/main.js");
  // `cwd` is dropped from ACE's install patch: never rely on it.
  assert.equal(manifest.cwd, undefined);
  for (const [k, v] of Object.entries(manifest.env ?? {})) {
    if (SECRET_KEY.test(k)) assert.match(String(v), /\$\{[^}]+\}/, `env ${k} must be a \${VAR} placeholder`);
  }
});

/**
 * Every file in the ace/mcp bundle, as `member` paths relative to the bundle
 * root (POSIX separators), mirroring what ACE's `parse_mcp_zip` sees.
 */
function listBundleMembers(dir: string, rel = ""): string[] {
  const members: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const relPath = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) members.push(...listBundleMembers(join(dir, e.name), relPath));
    else members.push(relPath);
  }
  return members.sort();
}

test("ace/mcp bundle: _split_mcp_bundle_members — only mcp.json at the root", () => {
  // ACE's artifact_import_entry_points_service.py `_split_mcp_bundle_members`:
  // the bundle root may contain ONLY `mcp.json`; every other member must live
  // under one of bin/ | scripts/ | config/ | references/. A root-level file
  // like the old README.md gets the whole bundle rejected (issue #98).
  const members = listBundleMembers(ACE_MCP_DIR);
  assert.ok(members.includes("mcp.json"), "mcp.json must exist at the bundle root");
  const rootFiles = members.filter((m) => !m.includes("/"));
  assert.deepEqual(rootFiles, ["mcp.json"], "only mcp.json at the bundle root");
  const allowedDirs = ["bin", "scripts", "config", "references"];
  for (const entry of readdirSync(ACE_MCP_DIR)) {
    if (entry === "mcp.json") continue;
    assert.ok(
      allowedDirs.includes(entry),
      `root member ${entry} must be a directory under ${allowedDirs.join("|")}/`,
    );
  }
  for (const m of members) {
    if (m === "mcp.json") continue;
    assert.ok(
      allowedDirs.includes(m.split("/")[0]!),
      `member ${m} must be under ${allowedDirs.join("|")}/`,
    );
  }
  // Names forbidden in a non-plugin bundle (artifact_import_zip_safety_service.py).
  for (const bad of [".claude-plugin", ".mcp.json", ".lsp.json", ".opencode"]) {
    assert.ok(!members.includes(bad), bad);
  }
});

test("ace/mcp bundle: _require_companion_files_match — bin|scripts|config == companion_files", () => {
  // ACE's artifact_import_entry_points_service.py
  // `_require_companion_files_match`: every file under bin/, scripts/ or
  // config/ must be listed in the manifest's `companion_files`, and every
  // `companion_files` entry must exist — exactly. Files under references/
  // are exempt (issue #98 moved README.md there).
  const members = listBundleMembers(ACE_MCP_DIR);
  const companionRoots = ["bin", "scripts", "config"];
  const declared = new Set((manifest.companion_files ?? []) as string[]);
  const present = members.filter((m) => companionRoots.includes(m.split("/")[0]!));
  assert.deepEqual(
    [...declared].sort(),
    present,
    "companion_files and the files under bin|scripts|config must match exactly",
  );
  // references/ members must NOT need a companion_files entry.
  for (const m of members.filter((m2) => m2.startsWith("references/"))) {
    assert.ok(!declared.has(m), `references/ member ${m} is exempt from companion_files`);
  }
});

test("ace mcp.json: pin is declared in scripts/check-pins.mjs", async () => {
  const pins = (await import(pathToFileURL(join(REPO_ROOT, "scripts", "check-pins.mjs")).href)) as {
    PINNED: { path: string; kind: string }[];
    checkPins(root: string, version: string): string[];
  };
  assert.ok(pins.PINNED.some((e) => e.path === "ace/mcp/mcp.json" && e.kind === "spec"));
  assert.deepEqual(pins.checkPins(REPO_ROOT, pkg.version), []);
});
