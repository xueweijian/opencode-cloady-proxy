// opencode 代理 —— 通用 Node.js 版本（腾讯云/阿里云/Oracle/任意 VPS）
// 与 Wasmer 版逻辑完全一致，只把 WinterCG 入口换成 node:http。
// 依赖: Node.js >= 18（原生 fetch / Headers / TransformStream / crypto.webcrypto）
// 运行: node server.js   (默认监听 PORT 或 8080)
// 注意: 不要用 Node 16 及以下，fetch 缺失。

import { createServer } from "node:http";
import { once } from "node:events";

const UPSTREAM = process.env.UPSTREAM || "https://opencode.ai";
const PORT = Number(process.env.PORT || 8080);
const PROXY_UA = "cherry-opencode-proxy/1.0";
const GENERIC_UA_PATTERNS = [
  "okhttp", "okio", "dalvik", "java/", "apache-httpclient",
  "python-requests", "python-urllib", "python-httpx", "aiohttp", "httpx",
  "go-http-client", "dart", "dio", "undici", "axios", "node-fetch",
];
const SESSION_ALIASES = ["x-conversation-id", "x-session-id", "x-correlation-id"];
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PUT, DELETE, PATCH, OPTIONS",
  "access-control-allow-headers": "*",
};

function textFromContent(c) {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c.map((p) => (p && typeof p === "object" && typeof p.text === "string" ? p.text : "")).join("\n");
  }
  return "";
}

function extractPrefix(body) {
  try {
    if (!body || typeof body !== "object") return null;
    const model = typeof body.model === "string" ? body.model : "";
    const msgs = Array.isArray(body.messages) ? body.messages : [];
    let system = "";
    if (typeof body.system === "string") system = body.system;
    else if (Array.isArray(body.system)) system = textFromContent(body.system);
    let firstUser = "";
    for (const m of msgs) {
      if (!m || typeof m !== "object") continue;
      if (m.role === "system" && !system) { system = textFromContent(m.content); continue; }
      if (m.role === "user") { firstUser = textFromContent(m.content); break; }
    }
    return { model, system, firstUser };
  } catch { return null; }
}

async function sha256Hex(s) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function resolveSession(reqHeaders, bodyText) {
  const direct = reqHeaders["x-opencode-session"];
  if (direct && String(direct).trim()) return { value: String(direct).trim(), source: "passthrough" };
  for (const alt of SESSION_ALIASES) {
    const v = reqHeaders[alt];
    if (v && String(v).trim()) return { value: String(v).trim(), source: alt };
  }
  const ct = String(reqHeaders["content-type"] || "");
  if (bodyText && ct.includes("json")) {
    try {
      const p = extractPrefix(JSON.parse(bodyText));
      if (p) return { value: await sha256Hex(`ocp1|${p.model}|${p.system}|${p.firstUser}`), source: "fingerprint" };
    } catch {}
  }
  return { value: crypto.randomUUID(), source: "random" };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const DROP_HEADERS = new Set([
  "host", "connection", "content-length", "accept-encoding",
  "x-forwarded-host", "x-forwarded-proto", "x-forwarded-for", "x-real-ip",
  "x-vercel-id", "x-vercel-ip-country", "x-vercel-ip-city",
  "cf-connecting-ip", "cf-ipcountry", "cf-ray", "cf-visitor", "true-client-ip",
]);

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (req.method === "OPTIONS") {
    res.writeHead(204, { ...CORS, "access-control-max-age": "86400" });
    return res.end();
  }

  if (url.pathname === "/" || url.pathname === "") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ status: "healthy", host: "node", region: process.env.REGION || "unknown" }));
  }

  const targetPath = url.pathname;
  let targetUrl;
  if (targetPath.startsWith("/zen/")) {
    targetUrl = `${UPSTREAM}${targetPath}${url.search}`;
  } else if (targetPath.startsWith("/v1/")) {
    targetUrl = `${UPSTREAM}/zen/go/v1${targetPath.slice(3)}${url.search}`;
  } else {
    targetUrl = `${UPSTREAM}/zen/go/v1${targetPath}${url.search}`;
  }

  const fwd = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (DROP_HEADERS.has(k.toLowerCase())) continue;
    fwd[k] = Array.isArray(v) ? v.join(",") : v;
  }
  const ua = String(fwd["user-agent"] || "").toLowerCase();
  if (!ua || GENERIC_UA_PATTERNS.some((p) => ua.includes(p))) fwd["user-agent"] = PROXY_UA;

  let bodyBuf = null;
  let session = null;
  if (!["GET", "HEAD"].includes(req.method)) {
    bodyBuf = await readBody(req);
    const bodyText = String(req.headers["content-type"] || "").includes("json") ? bodyBuf.toString("utf8") : null;
    session = await resolveSession(req.headers, bodyText);
    fwd["x-opencode-session"] = session.value;
    fwd["content-length"] = String(bodyBuf.length);
  }

  try {
    const upstream = await fetch(targetUrl, {
      method: req.method,
      headers: fwd,
      body: bodyBuf,
      redirect: "follow",
    });

    const out = { ...CORS };
    for (const [k, v] of upstream.headers) {
      if (["content-encoding", "content-length", "transfer-encoding", "connection"].includes(k.toLowerCase())) continue;
      out[k] = v;
    }
    out["cache-control"] = "no-cache, no-transform";
    out["x-accel-buffering"] = "no";
    if (session) {
      out["x-ocp-session"] = session.value;
      out["x-ocp-session-source"] = session.source;
    }

    res.writeHead(upstream.status, out);

    const isChatCompletions = /\/(chat\/)?completions$/.test(url.pathname);
    const ct = String(upstream.headers.get("content-type") || "");
    const patch = isChatCompletions && ct.includes("text/event-stream") && upstream.body;

    if (patch) {
      const reader = upstream.body.getReader();
      // Upstream sometimes emits `data: [DONE]` / finish_reason itself. Blindly
      // appending our own pair produces a duplicate terminal frame, and a strict
      // client stops at the first [DONE], dropping anything after it. Track what
      // actually arrived and only fill the gaps.
      const decoder = new TextDecoder();
      let tail = "";
      let sawDone = false;
      let sawFinish = false;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          tail = (tail + decoder.decode(value, { stream: true })).slice(-4096);
          if (tail.includes("[DONE]")) sawDone = true;
          if (/"finish_reason"\s*:\s*"(stop|length|tool_calls|content_filter)"/.test(tail)) sawFinish = true;
          // res.write 返回 false 时等待 drain，避免大流量下内存堆积
          if (!res.write(value)) await once(res, "drain");
        }
        if (!sawFinish) {
          res.write(`data: {"id":"chatcmpl-end","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n`);
        }
        if (!sawDone) {
          res.write(`data: [DONE]\n\n`);
        }
      } catch (e) {
        // 客户端断开：静默结束
      }
      return res.end();
    }

    if (upstream.body) {
      const reader = upstream.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!res.write(value)) await once(res, "drain");
        }
      } catch {}
    }
    res.end();
  } catch (err) {
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "application/json", ...CORS });
      res.end(JSON.stringify({ error: String(err && err.message || err) }));
    } else {
      res.end();
    }
  }
});

// LLM 长响应：关掉 Node 默认的请求/响应超时
server.requestTimeout = 0;
server.headersTimeout = 0;
server.timeout = 0;
server.keepAliveTimeout = 120000;

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[opencode-proxy] listening on :${PORT} -> ${UPSTREAM}`);
});
