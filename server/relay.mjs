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
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const execFileAsync = promisify(execFile);

const PORT = process.env.RELAY_PORT || 3457;
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-5";
// Per-request model + effort (subscription only — Bedrock keeps BEDROCK_MODEL).
// Callers name a profile alias, never an arbitrary model id: "opus" is the
// staff chat with MCP tools (Opus 5 at low effort = fewer thinking tokens for
// tool-driven Q&A), "sonnet" the default one-shot writer. Anything else is
// ignored and the relay default applies.
const MODEL_ALIASES = {
  sonnet: process.env.CLAUDE_MODEL_SONNET || "claude-sonnet-5",
  opus: process.env.CLAUDE_MODEL_OPUS || "claude-opus-5",
};
const EFFORT_LEVELS = new Set(["low", "medium", "high"]);
function resolveModel(alias, useBedrock) {
  if (useBedrock) return BEDROCK_MODEL;
  return (typeof alias === "string" && MODEL_ALIASES[alias]) || CLAUDE_MODEL;
}
function resolveEffort(effort) {
  return typeof effort === "string" && EFFORT_LEVELS.has(effort) ? effort : null;
}

// ── Conversation sessions ────────────────────────────────────────────────────
// A multi-turn chat used to be replayed as ONE flat user message per turn
// ("User: … Assistant: … Continue the conversation"): every turn re-billed the
// whole transcript as fresh input, and the model lost every tool result of
// the previous turns (so a follow-up re-queried Meta/Google). Now a caller
// names its conversation with `sessionKey`; the relay keeps one CLI session
// per key and resumes it (--resume) with only the new user message. Prior
// turns and tool results then sit in the CLI transcript, served back to the
// model as a cached prefix.
//
// The transcript lives on disk (CLI persistence, root-only) under
// CLAUDE_PROJECT_DIR; SESSION_TTL_MS bounds how long it stays.
const RELAY_CLAUDE_CWD = process.env.RELAY_CLAUDE_CWD || "/var/lib/impulsemotion-relay";
const SESSIONS_FILE = path.join(RELAY_CLAUDE_CWD, "sessions.json");
const CLAUDE_PROJECT_DIR = path.join(os.homedir(), ".claude", "projects", RELAY_CLAUDE_CWD.replace(/[^a-zA-Z0-9]/g, "-"));
const SESSION_TTL_MS = Number(process.env.RELAY_SESSION_TTL_MS || 3 * 24 * 3600 * 1000);
const SESSION_KEY_RE = /^[a-z]+:[A-Za-z0-9:_-]{1,200}$/;
let sessions = {};
try { sessions = JSON.parse(fs.readFileSync(SESSIONS_FILE, "utf8")); } catch { sessions = {}; }
function saveSessions() {
  try { fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions)); } catch (e) { console.error("[sessions] save failed", e.message); }
}
function transcriptPath(id) { return path.join(CLAUDE_PROJECT_DIR, `${id}.jsonl`); }
/** Everything that must not change under a resumed session (scope, tools, backend). */
function scopeFingerprint(parts) {
  return JSON.stringify(parts);
}
function forgetSession(key) {
  const s = sessions[key];
  delete sessions[key];
  saveSessions();
  if (s) { try { fs.unlinkSync(transcriptPath(s.id)); } catch { /* already gone */ } }
}
/** Drops transcripts past the TTL (and orphans the CLI left behind). */
function pruneSessions() {
  const now = Date.now();
  let dropped = 0;
  for (const [key, s] of Object.entries(sessions)) {
    if (now - (s.updatedAt || 0) > SESSION_TTL_MS) { forgetSession(key); dropped++; }
  }
  const live = new Set(Object.values(sessions).map((s) => s.id));
  try {
    for (const f of fs.readdirSync(CLAUDE_PROJECT_DIR)) {
      if (!f.endsWith(".jsonl")) continue;
      const id = f.slice(0, -6);
      const full = path.join(CLAUDE_PROJECT_DIR, f);
      if (live.has(id)) continue;
      try {
        if (now - fs.statSync(full).mtimeMs > SESSION_TTL_MS) { fs.unlinkSync(full); dropped++; }
      } catch { /* raced */ }
    }
  } catch { /* project dir not created yet */ }
  if (dropped) console.log(`[sessions] pruned ${dropped}`);
}
setInterval(pruneSessions, 60 * 60 * 1000).unref();
pruneSessions();
// Amazon Bedrock — used ONLY when a caller asks for it (`provider: "bedrock"`,
// today the private client bots): inference then runs in the agency's AWS
// account, EU region, instead of the host's Claude subscription. Credentials
// come from the host's AWS profile (~/.aws). No silent fallback either way.
const BEDROCK_MODEL = process.env.BEDROCK_MODEL || "eu.anthropic.claude-sonnet-4-6";
const BEDROCK_REGION = process.env.BEDROCK_REGION || "eu-west-3";
// No browser ever talks to the relay directly — only the Next.js backend does,
// so cross-origin requests are denied unless explicitly configured.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);
const MCP_CONFIG = "/root/ImpulseMotion/config/mcp-claude.json";
// MCP stdio "client-data" (entrepôt e-commerce des bots clients). Démarré à la
// demande, scoped par CLIENT_KEY côté serveur — voir buildScopedMcpConfig().
const CLIENT_DATA_SERVER = "client-data";
const CLIENT_DATA_MCP_SCRIPT = "/root/ImpulseMotion/server/mcp-client-data.mjs";
const SCOPED_ADS_MCP_SCRIPT = "/root/ImpulseMotion/server/mcp-scoped-ads.mjs";
const CLIENT_KEY_RE = /^[a-z0-9][a-z0-9_-]{1,39}$/;
// HQ (hqforwork.com) — mémoire d'entreprise de l'agence : skills, knowledge,
// projets, policies. Ce n'est PAS une entrée de mcp-claude.json : c'est le
// connecteur claude.ai du compte hôte ("claude.ai mcp hq"), que le CLI ne charge
// que sans --strict-mcp-config. Il agit avec l'identité propriétaire de
// l'agence, donc : IA interne uniquement (jamais un bot client), et uniquement
// les outils de lecture listés ci-dessous.
const HQ_SERVER = "hq";
const HQ_TOOL_PREFIX = "mcp__claude_ai_mcp_hq__";
const HQ_READ_TOOLS = [
  "hq_context_grounding", "hq_companies_list", "search", "fetch", "hq_content_get",
  "hq_knowledge_list", "hq_knowledge_get", "hq_files_list", "hq_files_read",
  "hq_projects_list", "hq_project_get", "hq_project_status",
  "hq_policies_list", "hq_policy_get", "hq_skill_list", "hq_skill_get",
];

// Global whitelist — only servers declared here can ever be routed to the AI.
// The per-request `allowedServers` list is intersected with this set, so even
// a malicious caller can't open up new MCP surface area.
const ALLOWED_MCP_SERVERS = new Set([
  "meta-ads-impulse",
  "mcp-google-ads",
  "mcp-google-analytics",
  CLIENT_DATA_SERVER,
  HQ_SERVER,
]);

// Per-server explicit tool allowlist (read-only). Servers absent from this map
// expose read-only tools only and are allowed wholesale (mcp__<server>__*).
const SERVER_TOOL_ALLOWLIST = {
  "mcp-google-analytics": [
    "get_data_retention_settings", "get_data_stream", "get_enhanced_measurement_settings",
    "get_metadata", "get_property", "list_accounts", "list_audiences",
    "list_custom_dimensions", "list_custom_metrics", "list_data_streams",
    "list_firebase_links", "list_google_ads_links", "list_key_events", "list_properties",
    "run_pivot_report", "run_realtime_report", "run_report",
  ],
};

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

// ── MCP scoping ─────────────────────────────────────────────────────────────

/** Ads/analytics servers that can run behind the scope proxy, and where their
 *  allowed ids come from in the request. */
const SCOPED_ADS_SERVERS = {
  "meta-ads-impulse": (scope) => scope.meta,
  "mcp-google-ads": (scope) => scope.google,
  "mcp-google-analytics": (scope) => scope.ga4,
};

/**
 * Builds the mcp-config the spawned CLI will see, pinning every scope in the
 * environment instead of in the prompt.
 *
 *   - "client-data" becomes a stdio server whose env pins CLIENT_KEY (the LLM
 *     never picks the client) and the READ-ONLY warehouse URL.
 *   - each ads/analytics server becomes a stdio proxy (mcp-scoped-ads) that
 *     refuses any account id outside the caller's scope. Without it the
 *     restriction was only a paragraph of the system prompt, i.e. nothing.
 *     `unrestricted` (admins) goes through the same proxy with "*" (no
 *     account filter, outputs still compacted).
 *
 * Servers we cannot scope are dropped, never passed through. Written to a 0600
 * temp file, removed once the CLI exits.
 * Returns { path, cleanup, servers } — servers being the surviving list.
 */
function buildScopedMcpConfig({ servers, clientKey, accountScope, ga4PropertyId }) {
  let base;
  try { base = JSON.parse(fs.readFileSync(MCP_CONFIG, "utf8")); }
  catch (err) { console.error("[chat] mcp-config illisible:", err.message); return null; }

  const scope = accountScope && typeof accountScope === "object" ? accountScope : {};
  const unrestricted = scope.unrestricted === true;
  // GA4 has no ACL table of its own: the bot passes the one property it may read.
  const effectiveScope = { ...scope, ga4: ga4PropertyId ? [ga4PropertyId] : [] };

  const baseServers = base.mcpServers || {};
  const mcpServers = {};
  const kept = [];

  for (const name of servers) {
    if (name === CLIENT_DATA_SERVER) {
      const dataUrl = process.env.DATA_DATABASE_URL || "";
      if (!clientKey || !dataUrl) {
        console.error("[chat] client-data désactivé (clientKey ou DATA_DATABASE_URL absent)");
        continue;
      }
      mcpServers[name] = {
        command: "node",
        args: [CLIENT_DATA_MCP_SCRIPT],
        env: { CLIENT_KEY: clientKey, DATA_DATABASE_URL: dataUrl },
      };
      kept.push(name);
      continue;
    }

    const pick = SCOPED_ADS_SERVERS[name];
    const upstream = baseServers[name];
    if (!pick || !upstream) {
      // Not a scopable server and not in the base config: nothing to serve.
      if (upstream) { mcpServers[name] = upstream; kept.push(name); }
      continue;
    }
    // Admins keep business-manager-wide access, but still through the proxy:
    // it is also where tool outputs get compacted before reaching the model.
    const ids = unrestricted ? ["*"] : (pick(effectiveScope) || []).filter((v) => typeof v === "string" && v.trim());
    if (ids.length === 0) {
      console.error(`[chat] ${name} retiré — aucun compte autorisé pour cet appelant`);
      continue;
    }
    if (!upstream.url) {
      console.error(`[chat] ${name} retiré — pas d'URL amont à relayer`);
      continue;
    }
    mcpServers[name] = {
      command: "node",
      args: [SCOPED_ADS_MCP_SCRIPT],
      env: {
        SCOPED_SERVER_NAME: name,
        SCOPED_UPSTREAM_URL: upstream.url,
        SCOPED_ACCOUNTS: ids.join(","),
      },
    };
    kept.push(name);
  }

  const summary = kept.map((n) => {
    const e = mcpServers[n];
    if (e.args?.[0] === SCOPED_ADS_MCP_SCRIPT) return `${n}[${e.env.SCOPED_ACCOUNTS}]`;
    if (n === CLIENT_DATA_SERVER) return `${n}[${e.env.CLIENT_KEY}]`;
    return `${n}[non restreint]`;
  });
  console.log(`[chat] MCP: ${summary.join(" ") || "(aucun serveur)"}`);

  const file = path.join(os.tmpdir(), `im-mcp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify({ ...base, mcpServers }), { mode: 0o600 });
  let done = false;
  const cleanup = () => {
    if (done) return;
    done = true;
    try { fs.unlinkSync(file); } catch { /* already gone */ }
  };
  return { path: file, cleanup, servers: kept };
}

// ── Chat via Claude CLI with streaming ──────────────────────────────────────
function handleChat(messages, allowedServers, accountScope, res, systemPromptOverride, budgetMs, dataScope, provider, options = {}) {
  const useBedrock = provider === "bedrock";
  const model = resolveModel(options.model, useBedrock);
  const effort = resolveEffort(options.effort);
  // Tool-driven sessions may cap the agentic loop lower than the default: a
  // short, deterministic lookup (HQ client context) has no business running 15 turns.
  const maxTurns = Number.isInteger(options.maxTurns) && options.maxTurns >= 1 && options.maxTurns <= 15 ? options.maxTurns : 15;
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

  const sessionKey = typeof options.sessionKey === "string" && SESSION_KEY_RE.test(options.sessionKey) ? options.sessionKey : null;
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const flattenHistory = () => {
    if (messages.length === 1 && messages[0].role === "user") return messages[0].content;
    const parts = [];
    for (const m of messages) {
      if (m.role === "user") parts.push(`User: ${m.content}`);
      else if (m.role === "assistant") parts.push(`Assistant: ${m.content}`);
    }
    return parts.join("\n\n") + "\n\nContinue the conversation. Respond to the last user message.";
  };

  // Intersect incoming allowedServers with the global whitelist.
  let servers = (Array.isArray(allowedServers) ? allowedServers : [])
    .filter((s) => typeof s === "string" && ALLOWED_MCP_SERVERS.has(s));

  // "client-data" only ever runs pinned to a server-side clientKey.
  const clientKey =
    dataScope && typeof dataScope === "object" && typeof dataScope.clientKey === "string" && CLIENT_KEY_RE.test(dataScope.clientKey)
      ? dataScope.clientKey
      : null;
  const ga4PropertyId =
    dataScope && typeof dataScope === "object" && typeof dataScope.ga4PropertyId === "string" && dataScope.ga4PropertyId.trim()
      ? dataScope.ga4PropertyId.trim().slice(0, 64)
      : null;
  // HQ carries the agency owner's identity: never for a client bot (dataScope
  // or Bedrock = bot client). Pulled out of `servers` either way — it has no
  // entry in the mcp-config, the CLI gets it from the host claude.ai account.
  const useHq = servers.includes(HQ_SERVER) && !dataScope && !useBedrock;
  if (servers.includes(HQ_SERVER) && !useHq) console.error("[chat] hq refusé — requête de bot client");
  servers = servers.filter((s) => s !== HQ_SERVER);

  // Every chat goes through a generated config: scopes are pinned in the
  // environment of stdio servers, never left to the prompt.
  const scopedMcp = buildScopedMcpConfig({ servers, clientKey, accountScope, ga4PropertyId });
  if (scopedMcp) servers = scopedMcp.servers;
  const mcpConfigPath = scopedMcp ? scopedMcp.path : MCP_CONFIG;
  const cleanupScopedMcp = () => scopedMcp?.cleanup();

  // Read-only tool allowlists: the GA4 MCP also exposes mutations
  // (create/update/archive custom dimensions, key events, retention…). No chat
  // caller — client bot or staff — may ever mutate a client property.
  const toolPatterns = servers.flatMap((s) =>
    SERVER_TOOL_ALLOWLIST[s] ? SERVER_TOOL_ALLOWLIST[s].map((t) => `mcp__${s}__${t}`) : [`mcp__${s}__*`],
  );
  if (useHq) toolPatterns.push(...HQ_READ_TOOLS.map((t) => `${HQ_TOOL_PREFIX}${t}`));

  // Scope the AI to only the accountIds the caller is allowed to query.
  // Callers may override the base prompt for one-shot tasks (recommendations,
  // text generation, etc.) — the accountScope restrictions are still appended.
  let scopedSystemPrompt =
    typeof systemPromptOverride === "string" && systemPromptOverride.trim()
      ? systemPromptOverride
      : SYSTEM_PROMPT;
  const lines = [];
  if (accountScope && typeof accountScope === "object") {
    if (Array.isArray(accountScope.meta) && accountScope.meta.length) {
      lines.push(`Comptes Meta Ads autorisés: ${accountScope.meta.join(", ")}`);
    }
    if (Array.isArray(accountScope.google) && accountScope.google.length) {
      lines.push(`Comptes Google Ads autorisés: ${accountScope.google.join(", ")}`);
    }
    if (Array.isArray(accountScope.tiktok) && accountScope.tiktok.length) {
      lines.push(`Comptes TikTok autorisés: ${accountScope.tiktok.join(", ")}`);
    }
  }
  if (ga4PropertyId) {
    lines.push(`Propriété GA4 autorisée : ${ga4PropertyId}`);
  }
  if (lines.length) {
    scopedSystemPrompt +=
      "\n\nRESTRICTIONS DE PÉRIMÈTRE (ne JAMAIS ignorer) :\n" +
      lines.join("\n") +
      "\nTu ne dois interroger AUCUN autre compte. Si l'utilisateur demande des données pour un autre compte, refuse et explique que tu n'y as pas accès.";
  }

  if (useHq) {
    scopedSystemPrompt +=
      "\n\nTu as aussi accès, en LECTURE SEULE, à HQ : la mémoire de l'agence (company `impulse-analytics`) — skills (méthodes et playbooks par client), knowledge, projets, policies." +
      "\nPour une question sur un client, une méthode ou une décision de l'agence, cherche d'abord dans HQ (search puis fetch, ou hq_skill_list puis hq_skill_get) avant de répondre.";
  }

  // Resume when the caller named a conversation that we already hold, whose
  // scope fingerprint is unchanged, and which is not being restarted (a
  // single-message thread = "nouvelle conversation"). Anything else starts a
  // fresh session, replaying whatever history the caller sent.
  const fingerprint = scopeFingerprint({ servers, toolPatterns, accountScope: accountScope ?? null, clientKey, ga4PropertyId, useBedrock, model });
  const existing = sessionKey ? sessions[sessionKey] : null;
  const canResume = !!existing && messages.length > 1 && existing.fingerprint === fingerprint && fs.existsSync(transcriptPath(existing.id));
  if (sessionKey && existing && !canResume) forgetSession(sessionKey);
  const sessionId = canResume ? existing.id : (sessionKey ? crypto.randomUUID() : null);
  const prompt = canResume && lastUser ? lastUser.content : flattenHistory();
  if (sessionKey) {
    sessions[sessionKey] = { id: sessionId, fingerprint, updatedAt: Date.now() };
    saveSessions();
  }

  // Today's date, last (it changes daily: keeping it at the tail leaves the
  // rest of the prompt as a stable cache prefix). The ads tools now take
  // explicit YYYY-MM-DD ranges, so the model must know what "hier" is.
  const todayParis = new Intl.DateTimeFormat("fr-CA", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  scopedSystemPrompt += `\n\nDATE DU JOUR : ${todayParis} (Europe/Paris). Les données du jour sont partielles : par défaut, raisonne sur des jours complets (ex. « 7 derniers jours » = J-7 → J-1) et passe des dates explicites aux outils.`;

  const args = [
    "--print", prompt,
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--model", model,
    ...(effort ? ["--effort", effort] : []),
    "--mcp-config", mcpConfigPath,
    // Only the servers we declare: never the claude.ai connectors of the host
    // account — except for HQ, which only exists as one. The other connectors
    // then load too, but stay unusable: in --print mode a tool outside
    // --allowedTools is denied, and only HQ_READ_TOOLS are listed.
    ...(useHq ? [] : ["--strict-mcp-config"]),
    "--system-prompt", scopedSystemPrompt,
    // One-shot calls leave nothing on disk; named conversations persist so
    // the next turn can --resume them.
    ...(sessionKey ? (canResume ? ["--resume", sessionId] : ["--session-id", sessionId]) : ["--no-session-persistence"]),
    "--max-turns", String(maxTurns),
    // The CLI runs as root with the host's HOME, whose settings allow
    // Read/Write/Edit(*): without this, any chat — a client bot included, one
    // prompt injection away — could read and write server files. --restricted
    // ignores those settings files and drops Bash & co; --tools keeps a single
    // built-in, ToolSearch, which the CLI needs to load deferred MCP tools.
    "--restricted",
    "--tools", "ToolSearch",
  ];
  if (toolPatterns.length > 0) {
    args.push("--allowedTools", ...toolPatterns);
  } else {
    args.push("--disallowedTools", "mcp__*");
  }

  console.log(`[chat] Prompt: "${prompt.slice(0, 80)}..." | model=${model}${effort ? `/${effort}` : ""}${sessionKey ? ` | session=${canResume ? "resume" : "new"}` : ""}${useHq ? " | hq" : ""}${clientKey && scopedMcp ? ` | client-data=${clientKey}` : ""}${useBedrock ? ` | bedrock@${BEDROCK_REGION}` : ""}`);

  // Dedicated empty cwd: keeps the spawned CLI away from any project
  // CLAUDE.md/hooks that would inject non-deterministic context.
  const child = spawn("claude", args, {
    cwd: RELAY_CLAUDE_CWD,
    env: {
      ...process.env,
      TERM: "dumb",
      ...(useBedrock
        ? {
            CLAUDE_CODE_USE_BEDROCK: "1",
            AWS_REGION: BEDROCK_REGION,
            // Background/small-model calls must stay on Bedrock too.
            ANTHROPIC_DEFAULT_HAIKU_MODEL: BEDROCK_MODEL,
          }
        : {}),
    },
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
  // Callers running under a longer serverless budget (report generation,
  // maxDuration 300) may request more, capped by RELAY_CHAT_MAX_BUDGET_MS.
  const DEFAULT_BUDGET_MS = Number(process.env.RELAY_CHAT_BUDGET_MS || 110_000);
  const MAX_BUDGET_MS = Number(process.env.RELAY_CHAT_MAX_BUDGET_MS || 280_000);
  const requested = Number(budgetMs);
  const SESSION_BUDGET_MS = Number.isFinite(requested) && requested > 0
    ? Math.min(Math.max(requested, 10_000), MAX_BUDGET_MS)
    : DEFAULT_BUDGET_MS;
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
        // Tokens summed over every model of the session (billing ledger).
        const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
        for (const m of Object.values(event.modelUsage || {})) {
          tokens.input += m.inputTokens || 0;
          tokens.output += m.outputTokens || 0;
          tokens.cacheRead += m.cacheReadInputTokens || 0;
          tokens.cacheWrite += m.cacheCreationInputTokens || 0;
        }
        send("usage", {
          cost: event.total_cost_usd || 0,
          turns: event.num_turns || 0,
          duration: event.duration_ms || 0,
          provider: useBedrock ? "bedrock" : "subscription",
          model,
          effort,
          tokens,
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
    cleanupScopedMcp();
    console.log(`[chat] Exit code ${code}, text length: ${fullText.length}`);
    if (code !== 0 && !fullText && sessionKey) {
      // A transcript the CLI could not resume (or a crashed first turn) must
      // not poison the conversation: the next turn starts a fresh session.
      forgetSession(sessionKey);
    }
    finish(code !== 0 && !fullText ? { error: `Claude exited with code ${code}` } : undefined);
  });

  child.on("error", (err) => {
    cleanupScopedMcp();
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
      // HQ is chat-only: no direct call, its read-only list lives in handleChat.
      if (!serverName || serverName === HQ_SERVER || !ALLOWED_MCP_SERVERS.has(serverName)) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "tool not allowed" }));
        return;
      }
      // Callers may raise the timeout for slow n8n-backed tools (capped at 30s).
      const timeoutMs = Math.min(30000, Math.max(2000, Number(body.timeoutMs) || 20000));
      // MCP backends (n8n) fail transiently; one retry absorbs most blips.
      // stdout goes to a temp FILE, not a pipe: mcporter exits without
      // flushing async pipe writes, which truncates large outputs (>~128KB)
      // and made big accounts 502 on every call. File writes are synchronous.
      const call = () => new Promise((resolve, reject) => {
        const tmp = path.join(os.tmpdir(), `mcporter-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.out`);
        const fd = fs.openSync(tmp, "w");
        const cleanup = () => { try { fs.unlinkSync(tmp); } catch { /* already gone */ } };
        const child = spawn(
          "mcporter", ["call", body.tool, "--args", JSON.stringify(body.input || {}), "--output", "json"],
          { cwd: "/root/ImpulseMotion", stdio: ["ignore", fd, "pipe"], timeout: timeoutMs }
        );
        let stderr = "";
        child.stderr.on("data", (c) => { stderr += c; });
        child.on("error", (err) => { fs.closeSync(fd); cleanup(); reject(err); });
        child.on("close", (code, signal) => {
          fs.closeSync(fd);
          if (signal) { cleanup(); reject(new Error(`mcporter killed (${signal}) after ${timeoutMs}ms`)); return; }
          if (code !== 0) { cleanup(); reject(new Error(`mcporter exit ${code}: ${stderr.slice(0, 300)}`)); return; }
          const stdout = fs.readFileSync(tmp, "utf8");
          cleanup();
          resolve({ stdout });
        });
      });
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
      handleChat(body.messages, body.allowedServers, body.accountScope, res, body.systemPrompt, body.budgetMs, body.dataScope, body.provider, {
        model: body.model,
        effort: body.effort,
        maxTurns: body.maxTurns,
        sessionKey: body.sessionKey,
      });
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
