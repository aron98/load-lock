#!/usr/bin/env node
/**
 * Minimal MCP stdio client (issue #104): start a server command, initialize,
 * list tools, call a few, print one JSON summary line. No dependencies.
 *
 *   node mcp-probe.mjs '<json array of [name, args] calls>' -- <command> [args...]
 *
 * Exit 0 when every call returned without isError; the server's stderr is
 * passed through (e.g. the plugin launcher's debug line).
 */
import { spawn } from "node:child_process";

const sep = process.argv.indexOf("--");
const calls = JSON.parse(process.argv[2] ?? "[]");
const [command, ...args] = process.argv.slice(sep + 1);
const TIMEOUT_MS = Number(process.env.MCP_PROBE_TIMEOUT_MS ?? 300_000);

const child = spawn(command, args, { stdio: ["pipe", "pipe", "inherit"] });
let buf = "";
let nextId = 1;
const waiting = new Map();
child.stdout.on("data", (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.id != null && waiting.has(msg.id)) {
      waiting.get(msg.id)(msg);
      waiting.delete(msg.id);
    }
  }
});
const send = (m) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
const request = (method, params) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    waiting.set(id, (m) => (m.error ? reject(new Error(`${method}: ${JSON.stringify(m.error)}`)) : resolve(m.result)));
    send({ id, method, params });
  });

const timer = setTimeout(() => {
  console.error(`mcp-probe: timed out after ${TIMEOUT_MS}ms`);
  child.kill("SIGKILL");
  process.exit(70);
}, TIMEOUT_MS);

const t0 = Date.now();
try {
  const init = await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "load-lock-mcp-probe", version: "1" },
  });
  const initMs = Date.now() - t0;
  send({ method: "notifications/initialized" });
  const { tools } = await request("tools/list", {});
  const results = [];
  let ok = true;
  let last = "";
  for (const [name, a] of calls) {
    // "{{permit_token}}" is filled from the previous call's result.
    const filled = JSON.parse(JSON.stringify(a ?? {}).replace(/\{\{permit_token\}\}/g, () => /"permit_token":\s*"([^"]+)"/.exec(last)?.[1] ?? ""));
    const r = await request("tools/call", { name, arguments: filled });
    last = (r.content ?? []).map((c) => c.text ?? "").join("\n");
    if (r.isError) ok = false;
    results.push({ name, isError: Boolean(r.isError), text: last.slice(0, 400) });
  }
  console.log(JSON.stringify({ server: init.serverInfo, initMs, tools: tools.length, results }));
  clearTimeout(timer);
  child.stdin.end();
  child.kill("SIGTERM");
  process.exit(ok ? 0 : 1);
} catch (e) {
  console.error(`mcp-probe: ${e.message}`);
  child.kill("SIGKILL");
  process.exit(1);
}
