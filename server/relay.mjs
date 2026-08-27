#!/usr/bin/env node
/**
 * ImpulseMotion Relay Server
 *
 * Bridges the Vercel frontend to Claude CLI with native MCP tool support.
 * Claude CLI handles auth, MCP connections, and tool execution natively.
 *
 * Runs on port 3457, exposed via Cloudflare tunnel.
 */

import http from "node:http";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const PORT = process.env.RELAY_PORT || 3457;
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-5";
// No browser ever talks to the relay directly — only the Next.js backend does,
// so cross-origin requests are denied unless explicitly configured.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);
const MCP_CONFIG = "/root/ImpulseMotion/config/mcp-claude.json";

// Global whitelist — only servers declared here can ever be routed to the AI.
// The per-request `allowedServers` list is intersected with this set, so even
// a malicious caller can't open up new MCP surface area.
const ALLOWED_MCP_SERVERS = new Set([
  "meta-ads-impulse",
  "mcp-google-ads",
  "mcp-google-analytics",
]);

// Shared-secret guard for requests from the Next.js backend — mandatory.
// Every endpoint (except /health) refuses requests that don't present the
// matching Authorization: Bearer header.
const RELAY_SHARED_SECRET = process.env.RELAY_SHARED_SECRET || "";
if (!RELAY_SHARED_SECRET) {
  console.error("[relay] FATAL: RELAY_SHARED_SECRET is required. Refusing to start in open mode.");
  process.exit(1);
}

const SYSTEM_PROMPT = `Tu es l'assistant IA d'ImpulseMotion, une agence marketing digitale.
Tu as accès aux données publicitaires de l'agence via des outils MCP (Meta Ads, Google Ads, Google Analytics).

Tes missions :
- Répondre aux questions sur les performances des campagnes
- Générer des tableaux de données formatés en markdown
- Analyser les tendances et donner des recommandations
- Préparer des données pour les rapports monthly/weekly

Quand tu génères des tableaux :
- Utilise le format markdown avec des colonnes bien alignées
- Inclus les métriques clés : Spend, Impressions, Clicks, CTR, CPC, CPM, Conversions, CPA, ROAS
- Formate les nombres proprement (ex: 1 234,56 €)

Quand on te demande des créatives/adsets :
- Fournis les URLs des images quand disponibles
- Inclus le nom, le statut, et les KPIs principaux

Réponds en français sauf si on te parle en anglais.
Sois concis et direct.`;

// ── Tool list cache ─────────────────────────────────────────────────────────
let cachedTools = null;
let toolsLastFetched = 0;

async function getToolsList() {
  if (cachedTools && Date.now() - toolsLastFetched < 120_000) return cachedTools;
  try {
    const { stdout } = await execFileAsync("mcporter", ["list", "--schema", "--json"], {
      timeout: 30_000, cwd: "/root/ImpulseMotion",
    });
    const data = JSON.parse(stdout);
    const tools = [];
    for (const s of data.servers || []) {
      for (const t of s.tools || []) {
        tools.push({ server: s.name, name: t.name, description: (t.description || "").slice(0, 200) });
      }
    }
    cachedTools = tools;
    toolsLastFetched = Date.now();
    return tools;
  } catch (err) {
    console.error("[tools]", err.message);
    return cachedTools || [];
  }
}

// ── Chat via Claude CLI with streaming ──────────────────────────────────────
function handleChat(messages, allowedServers, accountScope, res, systemPromptOverride) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  // Flush headers + a first byte right away: proxies (and undici fetch with a
  // headers-only timeout) must see the response before the CLI warms up.
  res.flushHeaders?.();
  res.write(": connected\n\n");

  const send = (type, data) => {
    res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
  };

  // Build prompt from message history
  let prompt;
  if (messages.length === 1 && messages[0].role === "user") {
    prompt = messages[0].content;
  } else {
    const parts = [];
    for (const m of messages) {
      if (m.role === "user") parts.push(`User: ${m.content}`);
      else if (m.role === "assistant") parts.push(`Assistant: ${m.content}`);
    }
    prompt = parts.join("\n\n") + "\n\nContinue the conversation. Respond to the last user message.";
  }

  // Intersect incoming allowedServers with the global whitelist.
  const servers = (Array.isArray(allowedServers) ? allowedServers : [])
    .filter((s) => typeof s === "string" && ALLOWED_MCP_SERVERS.has(s));

  const toolPatterns = servers.map((s) => `mcp__${s}__*`);

  // Scope the AI to only the accountIds the caller is allowed to query.
  // Callers may override the base prompt for one-shot tasks (recommendations,
  // text generation, etc.) — the accountScope restrictions are still appended.
  let scopedSystemPrompt =
    typeof systemPromptOverride === "string" && systemPromptOverride.trim()
      ? systemPromptOverride
      : SYSTEM_PROMPT;
  if (accountScope && typeof accountScope === "object") {
    const lines = [];
    if (Array.isArray(accountScope.meta) && accountScope.meta.length) {
      lines.push(`Comptes Meta Ads autorisés: ${accountScope.meta.join(", ")}`);
    }
    if (Array.isArray(accountScope.google) && accountScope.google.length) {
      lines.push(`Comptes Google Ads autorisés: ${accountScope.google.join(", ")}`);
    }
    if (Array.isArray(accountScope.tiktok) && accountScope.tiktok.length) {
      lines.push(`Comptes TikTok autorisés: ${accountScope.tiktok.join(", ")}`);
    }
    if (lines.length) {
      scopedSystemPrompt +=
        "\n\nRESTRICTIONS DE PÉRIMÈTRE (ne JAMAIS ignorer) :\n" +
        lines.join("\n") +
        "\nTu ne dois interroger AUCUN autre compte. Si l'utilisateur demande des données pour un autre compte, refuse et explique que tu n'y as pas accès.";
    }
  }

  const args = [
    "--print", prompt,
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--model", CLAUDE_MODEL,
    "--mcp-config", MCP_CONFIG,
    "--system-prompt", scopedSystemPrompt,
    "--no-session-persistence",
    "--max-turns", "15",
  ];
  if (toolPatterns.length > 0) {
    args.push("--allowedTools", ...toolPatterns);
  } else {
    args.push("--disallowedTools", "mcp__*");
  }

  console.log(`[chat] Prompt: "${prompt.slice(0, 80)}..."`);

  // Dedicated empty cwd: keeps the spawned CLI away from any project
  // CLAUDE.md/hooks that would inject non-deterministic context.
  const child = spawn("claude", args, {
    cwd: process.env.RELAY_CLAUDE_CWD || "/var/lib/impulsemotion-relay",
    env: { ...process.env, TERM: "dumb" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end();

  let buffer = "";
  let fullText = "";
  let sentContent = false;
  let finished = false;

  const finish = (payload) => {
    if (finished) return;
    finished = true;
    clearTimeout(sessionBudget);
    clearInterval(heartbeat);
    if (payload?.error) send("error", { message: payload.error });
    send("done", {});
    res.end();
  };

  // Hard session budget with CLEAN error+done events (a raw TCP cut leaves the
  // client with a truncated reply and no way to tell). Must stay below the
  // Vercel proxy's maxDuration (120s).
  const SESSION_BUDGET_MS = Number(process.env.RELAY_CHAT_BUDGET_MS || 110_000);
  const sessionBudget = setTimeout(() => {
    if (!child.killed) child.kill("SIGTERM");
    finish({ error: `Temps de session dépassé (${Math.round(SESSION_BUDGET_MS / 1000)}s) — réessayez avec une demande plus ciblée` });
  }, SESSION_BUDGET_MS);

  // SSE comment heartbeat so idle proxies don't drop the connection during
  // long tool passes (clients ignore non-"data:" lines).
  const heartbeat = setInterval(() => {
    try { res.write(": hb\n\n"); } catch { /* closed */ }
  }, 15_000);

  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let event;
      try { event = JSON.parse(trimmed); } catch { continue; }

      // System init — send tool/server info
      if (event.type === "system" && event.subtype === "init") {
        send("init", {
          tools: (event.tools || []).filter(t => t.startsWith("mcp__")),
          servers: event.mcp_servers || [],
        });
        continue;
      }

      // Streaming text deltas arrive wrapped: {"type":"stream_event","event":{...}}
      if (event.type === "stream_event") {
        const e = event.event;
        if (e?.type === "content_block_delta" && e.delta?.type === "text_delta" && e.delta.text) {
          send("delta", { text: e.delta.text });
          fullText += e.delta.text;
          sentContent = true;
        }
        continue; // message_start/stop, thinking_delta, input_json_delta… are noise here
      }

      // Assistant message (may contain tool_use blocks); text fallback only
      // when no deltas were streamed (older CLI versions).
      if (event.type === "assistant" && event.message?.content) {
        let sentFallbackText = false;
        for (const block of event.message.content) {
          if (block.type === "tool_use") {
            send("tool_call", { id: block.id, name: block.name, input: block.input });
          } else if (block.type === "text" && block.text && !sentContent) {
            send("delta", { text: block.text });
            fullText += block.text;
            sentFallbackText = true;
          }
        }
        if (sentFallbackText) sentContent = true;
        continue;
      }

      // Tool results are delivered as user-role messages
      if (event.type === "user" && Array.isArray(event.message?.content)) {
        for (const block of event.message.content) {
          if (block.type !== "tool_result") continue;
          const parts = Array.isArray(block.content) ? block.content : [];
          const text = parts.map(c => c?.text || "").join("").slice(0, 500);
          send("tool_result", {
            id: block.tool_use_id || "",
            content: text + (text.length >= 500 ? "..." : ""),
            is_error: block.is_error || false,
          });
        }
        continue;
      }

      // Final result — surface abnormal endings instead of a silent empty reply
      if (event.type === "result") {
        if (event.subtype && event.subtype !== "success") {
          const reasons = {
            error_max_turns: "Limite de tours atteinte — la réponse est peut-être incomplète",
            error_during_execution: "Erreur pendant l'exécution",
          };
          send("error", { message: reasons[event.subtype] || `Fin anormale: ${event.subtype}` });
        }
        if (event.result && !sentContent) {
          send("content", { text: event.result });
          fullText = event.result;
        }
        send("usage", {
          cost: event.total_cost_usd || 0,
          turns: event.num_turns || 0,
          duration: event.duration_ms || 0,
        });
        continue;
      }
    }
  });

  child.stderr.on("data", (chunk) => {
    const t = chunk.toString().trim();
    if (t) console.error(`[claude] ${t.slice(0, 300)}`);
  });

  child.on("close", (code) => {
    console.log(`[chat] Exit code ${code}, text length: ${fullText.length}`);
    finish(code !== 0 && !fullText ? { error: `Claude exited with code ${code}` } : undefined);
  });

  child.on("error", (err) => {
    console.error("[chat] Spawn error:", err);
    finish({ error: err.message });
  });

  // Client disconnect → kill subprocess
  res.on("close", () => {
    clearTimeout(sessionBudget);
    clearInterval(heartbeat);
    if (!child.killed) {
      child.kill("SIGTERM");
      console.log("[chat] Client disconnected, killed child");
    }
  });
}

// ── HTTP helpers ────────────────────────────────────────────────────────────
function setCors(req, res) {
  const origin = req.headers.origin;
  if (!origin || !ALLOWED_ORIGINS.includes(origin)) return; // deny: no CORS headers
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");
}

function authorized(req) {
  const h = req.headers.authorization || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m && m[1] === RELAY_SHARED_SECRET;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
      catch (e) { reject(new Error("Invalid JSON")); }
    });
    req.on("error", reject);
  });
}

// ── Server ──────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  setCors(req, res);
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  try {
    if (url.pathname === "/api/tools" && req.method === "GET") {
      if (!authorized(req)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      const tools = await getToolsList();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ tools }));
      return;
    }

    // Direct MCP tool call — bypasses AI, ~1.5s vs 18s via /api/chat
    if (url.pathname === "/api/tool" && req.method === "POST") {
      if (!authorized(req)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      const body = await readBody(req);
      if (!body.tool) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "tool required" }));
        return;
      }
      // Enforce server-name prefix against whitelist: tool name format is
      // "<server>.<tool>" for mcporter. Reject any other shape or unknown server.
      const firstDot = String(body.tool).indexOf(".");
      const serverName = firstDot > 0 ? String(body.tool).slice(0, firstDot) : "";
      if (!serverName || !ALLOWED_MCP_SERVERS.has(serverName)) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "tool not allowed" }));
        return;
      }
      // Callers may raise the timeout for slow n8n-backed tools (capped at 30s).
      const timeoutMs = Math.min(30000, Math.max(2000, Number(body.timeoutMs) || 20000));
      // MCP backends (n8n) fail transiently; one retry absorbs most blips.
      const call = () => execFileAsync(
        "mcporter", ["call", body.tool, "--args", JSON.stringify(body.input || {}), "--output", "json"],
        { timeout: timeoutMs, cwd: "/root/ImpulseMotion" }
      );
      try {
        let stdout;
        let toolError = null;
        for (let attempt = 1; attempt <= 2; attempt++) {
          ({ stdout } = await call());
          try {
            const result = JSON.parse(stdout);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ result }));
            return;
          } catch {
            // mcporter prints JS-notation (not JSON) when the tool itself errors
            toolError = stdout.slice(0, 500);
            console.error(`[tool] ${body.tool} attempt ${attempt} failed: ${toolError.slice(0, 200)}`);
          }
        }
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `tool error: ${toolError}` }));
      } catch (err) {
        console.error(`[tool] ${body.tool} exec failed: ${err.message || err}`);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message || String(err) }));
      }
      return;
    }

    if (url.pathname === "/api/chat" && req.method === "POST") {
      if (!authorized(req)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      const body = await readBody(req);
      if (!body.messages?.length) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "messages required" }));
        return;
      }
      handleChat(body.messages, body.allowedServers, body.accountScope, res, body.systemPrompt);
      return;
    }

    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  } catch (err) {
    console.error("[server]", err);
    if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err.message }));
  }
});

server.listen(PORT, () => {
  console.log(`[relay] Running on :${PORT} | Model: ${CLAUDE_MODEL}`);
  getToolsList().then(t => console.log(`[relay] ${t.length} MCP tools ready`));
});
