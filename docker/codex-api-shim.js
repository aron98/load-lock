// codex-api-shim.js — namespace-flattening API shim for codex + providers
// that do not support the Responses-API `namespace` tool type (e.g.
// trustedtokens/GLM). Run in-loop (same host as codex), points codex's
// provider base_url at this shim's http://127.0.0.1:8788/v1.
//
// Request side:  {"type":"namespace","name":"mcp__<server>","tools":[…]}
//                → flat {"type":"function","name":"mcp__<server>__<tool>"}.
// Response side: model function calls arrive with flat names; rewrite SSE
//                lines "name":"mcp__<server>__<tool>" →
//                "name":"<tool>","namespace":"mcp__<server_underscores>" so
//                codex's namespace tool router can dispatch them.
//
// Upstream + listen ports are configurable via env:
//   SHIM_UPSTREAM_HOST (default api.trustedtokens.eu)
//   SHIM_LISTEN_PORT   (default 8788)
// Headers (incl. Authorization) pass through untouched; this shim NEVER logs
// headers. Request bodies are logged (tools only, truncated) for evidence.
const http = require("http");
const https = require("https");
const fs = require("fs");

const UPSTREAM_HOST = process.env.SHIM_UPSTREAM_HOST || "api.trustedtokens.eu";
const LISTEN_PORT = Number(process.env.SHIM_LISTEN_PORT || 8788);
const LOG = process.env.SHIM_LOG || "/workspace/api-shim.log";

function log(line) {
  try {
    fs.appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`);
  } catch {
    /* best effort */
  }
}

function flattenTools(obj) {
  if (!obj || !Array.isArray(obj.tools)) return obj;
  const out = [];
  for (const t of obj.tools) {
    if (t && t.type === "namespace" && typeof t.name === "string" && t.name.startsWith("mcp__")) {
      const server = t.name.replace(/^mcp__/, "").replace(/_/g, "-");
      for (const inner of t.tools || []) {
        out.push({
          type: "function",
          name: `mcp__${server}__${inner.name}`,
          description: inner.description,
          strict: false,
          parameters: inner.parameters || { type: "object", properties: {} },
        });
      }
    } else {
      out.push(t);
    }
  }
  obj.tools = out;
  return obj;
}

// "name":"mcp__load-lock__inspect_machine" -> "name":"inspect_machine","namespace":"mcp__load_lock"
function rewriteSseLine(line) {
  return line.replace(
    /"name"\s*:\s*"mcp__([a-zA-Z0-9_-]+?)__([a-zA-Z0-9_]+)"/g,
    (_m, srv, tool) => `"name":"${tool}","namespace":"mcp__${srv.replace(/-/g, "_")}"`,
  );
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    let body = Buffer.concat(chunks);
    let flattened = 0;
    try {
      const parsed = JSON.parse(body.toString("utf-8"));
      flattened = (parsed.tools || []).filter((t) => t && t.type === "namespace").length;
      body = Buffer.from(JSON.stringify(flattenTools(parsed)));
    } catch (e) {
      log(`request parse fail: ${e.message}`);
    }
    log(`request ${req.method} ${req.url} namespaces_flattened=${flattened}`);
    const hdrs = { ...req.headers, host: UPSTREAM_HOST };
    delete hdrs["content-length"];
    delete hdrs["transfer-encoding"];
    delete hdrs["accept-encoding"]; // upstream stays plain so SSE rewriting is safe
    const upstream = https.request(
      {
        hostname: UPSTREAM_HOST,
        port: 443,
        path: req.url,
        method: req.method,
        headers: { ...hdrs, "content-length": body.length },
      },
      (ur) => {
        const ct = String(ur.headers["content-type"] || "");
        if (!ct.includes("text/event-stream")) {
          res.writeHead(ur.statusCode, ur.headers);
          ur.pipe(res);
          return;
        }
        const outHeaders = { ...ur.headers };
        delete outHeaders["content-length"];
        res.writeHead(ur.statusCode, outHeaders);
        let carry = "";
        let rewrites = 0;
        ur.setEncoding("utf-8");
        ur.on("data", (chunk) => {
          const lines = (carry + chunk).split("\n");
          carry = lines.pop(); // incomplete tail stays buffered
          for (const l of lines) {
            const r = rewriteSseLine(l);
            if (r !== l) rewrites++;
            res.write(r + "\n");
          }
        });
        ur.on("end", () => {
          if (carry) res.write(rewriteSseLine(carry));
          if (rewrites) log(`response sse function_call rewrites=${rewrites}`);
          res.end();
        });
      },
    );
    upstream.on("error", (e) => {
      log(`upstream error: ${e.message}`);
      res.writeHead(502);
      res.end("shim upstream error");
    });
    upstream.end(body);
  });
});
server.listen(LISTEN_PORT, "127.0.0.1", () =>
  log(`codex-api-shim listening on 127.0.0.1:${LISTEN_PORT} → https://${UPSTREAM_HOST}`),
);
