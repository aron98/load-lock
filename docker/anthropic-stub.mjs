#!/usr/bin/env node
/**
 * Scripted stand-in for the Anthropic Messages API (issue #104).
 *
 * Lets a real Claude Code session run with no model and no key: Claude Code
 * still loads plugins, runs hooks and starts MCP servers, and sends their
 * output (SessionStart context, tool list, tool results, Stop-hook
 * continuations) to this server, which logs every request body. Tests then
 * assert on what Claude Code actually sent. It proves harness plumbing only,
 * never model behaviour.
 *
 *   node anthropic-stub.mjs --port 4100 --log requests.jsonl --plan plan.json
 *
 * plan.json: { "steps": [step...], "waitText": "WAITING", "finalText": "STUB-DONE" }
 *   step = { "tool": "<full tool name>" | "*__<suffix>", "input": {...},
 *            "await": "<regex>", "retryWhile": "<regex>", "retryDelayMs": n }
 * A request with tools is the main conversation. Its step index is the number
 * of tool_use blocks this stub already issued in it, except that a step with
 * `retryWhile` is issued again (after retryDelayMs, at most 40 times) while
 * its last tool result matches that regex (e.g. ToolSearch while an MCP
 * server is "still connecting"). The step's tool call is returned; if
 * `await` is set and no text in the request matches it yet, the turn ends
 * with waitText instead. After the last step: finalText. A
 * "*__status" tool picks the first tool whose name ends in "__status"; when
 * no tool matches, the turn ends with "NO-TOOL <tool>". Input strings
 * "{{offer_token}}" / "{{permit_token}}" are filled from the latest such
 * token (snake_case or camelCase field) in the request text (tool results,
 * hook messages).
 * Requests without tools (titles, summaries) get a plain "ok".
 */
import { appendFileSync, readFileSync } from "node:fs";
import { createServer } from "node:http";

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
};
const port = Number(arg("port", "4100"));
const logFile = arg("log", "stub-requests.jsonl");
const planFile = arg("plan");
const plan = planFile ? JSON.parse(readFileSync(planFile, "utf8")) : { steps: [] };
const waitText = plan.waitText ?? "WAITING";
const finalText = plan.finalText ?? "STUB-DONE";

/** Every string value in a JSON value, in order. */
function strings(v, out = []) {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) strings(x, out);
  else if (v && typeof v === "object") for (const x of Object.values(v)) strings(x, out);
  return out;
}

function lastToken(text, field) {
  // MCP results use offer_token / permit_token, raw entries (pending) offerToken / permitToken.
  const camel = field.replace(/_(\w)/, (_, c) => c.toUpperCase());
  const re = new RegExp(`(?:${field}|${camel})"?\\s*:?\\s*"([A-Za-z0-9_-]+)"`, "g");
  let found;
  for (const m of text.matchAll(re)) found = m[1];
  return found;
}

function fill(input, text) {
  return JSON.parse(
    JSON.stringify(input ?? {}).replace(/\{\{(offer_token|permit_token)\}\}/g, (_, f) => lastToken(text, f) ?? `missing-${f}`),
  );
}

let seq = 0;
function decide(body) {
  const tools = Array.isArray(body.tools) ? body.tools.map((t) => t.name).filter(Boolean) : [];
  if (tools.length === 0) return { kind: "text", text: "ok" };
  const messages = body.messages ?? [];
  const blocks = messages.filter((m) => Array.isArray(m.content)).flatMap((m) => m.content);
  const resultOf = (id) => strings(blocks.find((b) => b?.type === "tool_result" && b.tool_use_id === id)?.content ?? "").join("\n");
  let issued = 0;
  let retries = 0;
  let retrying = false;
  for (const b of blocks) {
    if (b?.type !== "tool_use" || !String(b.id).startsWith("toolu_stub_")) continue;
    const st = plan.steps[issued];
    retrying = Boolean(st?.retryWhile && retries < 40 && new RegExp(st.retryWhile).test(resultOf(b.id)));
    if (retrying) retries++;
    else {
      issued++;
      retries = 0;
    }
  }
  const step = plan.steps[issued];
  if (!step) return { kind: "text", text: finalText, step: issued };
  const text = strings({ system: body.system, messages }).join("\n");
  if (step.await && !new RegExp(step.await).test(text)) return { kind: "text", text: waitText, step: issued };
  const name = step.tool.startsWith("*__") ? tools.find((t) => t.endsWith(step.tool.slice(1))) : tools.find((t) => t === step.tool);
  if (!name) return { kind: "text", text: `NO-TOOL ${step.tool}`, step: issued };
  const delayMs = retrying ? (step.retryDelayMs ?? 2000) : 0;
  return { kind: "tool_use", name, input: fill(step.input, text), id: `toolu_stub_${++seq}`, step: issued, retry: retries, delayMs };
}

function sse(res, model, d) {
  const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  ev("message_start", {
    message: {
      id: `msg_stub_${++seq}`, type: "message", role: "assistant", model, content: [],
      stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 },
    },
  });
  if (d.kind === "tool_use") {
    ev("content_block_start", { index: 0, content_block: { type: "tool_use", id: d.id, name: d.name, input: {} } });
    ev("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(d.input) } });
  } else {
    ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
    ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: d.text } });
  }
  ev("content_block_stop", { index: 0 });
  ev("message_delta", { delta: { stop_reason: d.kind === "tool_use" ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } });
  ev("message_stop", {});
  res.end();
}

function message(res, model, d) {
  const content = d.kind === "tool_use" ? [{ type: "tool_use", id: d.id, name: d.name, input: d.input }] : [{ type: "text", text: d.text }];
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({
    id: `msg_stub_${++seq}`, type: "message", role: "assistant", model, content,
    stop_reason: d.kind === "tool_use" ? "tool_use" : "end_turn", stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
  }));
}

createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const path = (req.url ?? "").split("?")[0];
    let body = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      /* not JSON */
    }
    if (req.method === "POST" && path.endsWith("/messages/count_tokens")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ input_tokens: 100 }));
    }
    if (req.method === "POST" && path.endsWith("/messages")) {
      const d = decide(body);
      appendFileSync(logFile, JSON.stringify({ ts: Date.now(), path, decision: d, body }) + "\n");
      const reply = () => (body.stream ? sse(res, body.model ?? "stub", d) : message(res, body.model ?? "stub", d));
      return d.delayMs ? setTimeout(reply, d.delayMs) : reply();
    }
    appendFileSync(logFile, JSON.stringify({ ts: Date.now(), path, method: req.method, unhandled: true }) + "\n");
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: "stub" } }));
  });
}).listen(port, "127.0.0.1", () => process.stderr.write(`anthropic-stub listening on ${port}\n`));
