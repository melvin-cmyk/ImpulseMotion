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
import { looksLikeUsageLimit, makeWebhookNotifier } from "./quota.mjs";
import * as hqOauth from "./hq-oauth.mjs";
import { hqToolCall } from "./hq-client.mjs";
import * as maxAccounts from "./max-accounts.mjs";
import * as gwsAuth from "./gws-auth.mjs";
import { handleSheetsRequest } from "./sheets-direct.mjs";
import { buildSystemPrompt, buildTurnPrompt, cliTokenEnv, createTurnMeter, promptLogExcerpt } from "./relay-prompt.mjs";
import { accountsOfTikTokCall, prepareTikTokArgs } from "./mcp-tiktok-args.mjs";
let hqProjectsCache = null;

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
  opus: process.env.CLAUDE_MODEL_OPUS || "claude-opus-5-5",
  // Fable 5.1 (Mythos-class) — available to the agency's Max subscriptions.
  fable: process.env.CLAUDE_MODEL_FABLE || "claude-fable-5-1",
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
// come from the host's AWS profile (~/.aws). Also the quota fallback target (see below).
const BEDROCK_MODEL = process.env.BEDROCK_MODEL || "eu.anthropic.claude-sonnet-4-6";
const BEDROCK_REGION = process.env.BEDROCK_REGION || "eu-west-3";
// No browser ever talks to the relay directly — only the Next.js backend does,
// so cross-origin requests are denied unless explicitly configured.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);
// RELAY_MCP_CONFIG : autre fichier pour les tests (le relay de production lit celui du dépôt).
const MCP_CONFIG = process.env.RELAY_MCP_CONFIG || "/root/ImpulseMotion/config/mcp-claude.json";
// MCP stdio "client-data" (entrepôt e-commerce des bots clients). Démarré à la
// demande, scoped par CLIENT_KEY côté serveur — voir buildScopedMcpConfig().
const CLIENT_DATA_SERVER = "client-data";
const CLIENT_DATA_MCP_SCRIPT = "/root/ImpulseMotion/server/mcp-client-data.mjs";
const SCOPED_ADS_MCP_SCRIPT = "/root/ImpulseMotion/server/mcp-scoped-ads.mjs";
// Bac à sable Python (server/mcp-sandbox.mjs, image server/sandbox/Dockerfile) :
// staff uniquement, un workspace par conversation (sessionKey) sous WORKSPACES_DIR,
// dont les sorties (out/) et dépôts (uploads/) sont servis par /api/files.
const SANDBOX_SERVER = "sandbox";
const SANDBOX_MCP_SCRIPT = "/root/ImpulseMotion/server/mcp-sandbox.mjs";
// Google Workspace (server/mcp-gws.mjs) : CLI gws officiel installé sur l'hôte,
// identité partagée data@impulse-analytics.com, lecture seule, staff uniquement.
// Le jeton d'accès court est minté par le relay (server/gws-auth.mjs) et passé
// en env au serveur stdio ; les secrets ne sortent jamais du relay.
const GWS_SERVER = "gws";
const GWS_MCP_SCRIPT = "/root/ImpulseMotion/server/mcp-gws.mjs";
const WORKSPACES_DIR = path.join(RELAY_CLAUDE_CWD, "workspaces");
const WORKSPACE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const WORKSPACE_ID_RE = /^[a-f0-9]{24}$/;
const WORKSPACE_PATH_RE = /^(out|uploads)\/[A-Za-z0-9._ \-()]{1,120}$/;
const UPLOAD_MAX_BYTES = 25 * 1024 * 1024;
const SANDBOX_UID = 1000;
// Skills HQ synchronisées par claude.ai sur le compte hôte (~/.claude/skills/synced/<id>/<slug>/) :
// SKILL.md + assets (fonds, logos de la DA Impulse). Montées en lecture seule sur
// /skills dans le bac à sable pour que le modèle utilise les vrais assets.
// SKILLS_DIR dans l'env du service force un dossier précis.
const SKILLS_SYNC_ROOT = path.join(process.env.HOME || os.homedir(), ".claude", "skills", "synced");
function syncedSkillsDir() {
  const forced = process.env.SKILLS_DIR;
  if (forced) return path.isAbsolute(forced) && fs.existsSync(forced) ? forced : null;
  // Several accounts sync their skills here (one folder each): the agency
  // set is the one holding the most skills, not the most recently touched —
  // a personal account syncing a handful of skills must not shadow it.
  let best = null;
  try {
    for (const e of fs.readdirSync(SKILLS_SYNC_ROOT, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const abs = path.join(SKILLS_SYNC_ROOT, e.name);
      let count = 0;
      try { count = fs.readdirSync(abs, { withFileTypes: true }).filter((d) => d.isDirectory()).length; } catch { continue; }
      const mtime = fs.statSync(abs).mtimeMs;
      if (!best || count > best.count || (count === best.count && mtime > best.mtime)) best = { abs, mtime, count };
    }
  } catch { /* pas de skills synchronisées */ }
  return best ? best.abs : null;
}
// ── Workspace files ──────────────────────────────────────────────────────────
// out/ and uploads/ are written by a container that runs code the model wrote,
// possibly under the influence of a hostile document: whatever is in there is
// untrusted, names and file types included. A symbolic link (out/x → a host
// file, or out itself → a host folder) must never be followed by the relay,
// which runs as root. So nothing is opened by its path alone:
//   1. the folder is opened itself (O_NOFOLLOW), and the descriptor is asked
//      where it really is (/proc/self/fd) — it must be the workspace's folder;
//   2. the file is opened THROUGH that descriptor, O_NOFOLLOW again, then
//      checked (fstat) and read or written through its own descriptor.
// What is checked is what is used: swapping a file for a link between the
// check and the opening changes nothing. Linux only (/proc); elsewhere every
// request is refused.
const fdPath = (fd) => `/proc/self/fd/${fd}`;
const REAL_DIR = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
const mkdirIfAbsent = (p) => { try { fs.mkdirSync(p); } catch (e) { if (e.code !== "EEXIST") throw e; } };
/**
 * Makes <workspace>/<sub> a real folder. Nothing is created by a path the
 * container can bend: the workspace is opened itself (a workspace that is a
 * link is refused), and the folder is made through that descriptor. mkdir
 * never follows a link left under the name; such a link — dangling or not —
 * is removed itself (unlink does not follow either), then the folder is made.
 */
function ensureWorkspaceDir(wsId, sub) {
  if (!WORKSPACE_ID_RE.test(wsId) || (sub !== "out" && sub !== "uploads")) throw new Error("hors du workspace");
  fs.mkdirSync(WORKSPACES_DIR, { recursive: true });
  const ws = path.join(fs.realpathSync(WORKSPACES_DIR), wsId);
  mkdirIfAbsent(ws);
  const wsFd = fs.openSync(ws, REAL_DIR);
  try {
    if (fs.readlinkSync(fdPath(wsFd)) !== ws) throw new Error("hors du workspace");
    const entry = `${fdPath(wsFd)}/${sub}`;
    mkdirIfAbsent(entry);
    if (fs.lstatSync(entry).isSymbolicLink()) {
      fs.unlinkSync(entry);
      console.error(`[workspace] ${wsId}/${sub} était un lien — lien retiré, dossier recréé`);
      mkdirIfAbsent(entry);
    }
  } finally {
    fs.closeSync(wsFd);
  }
}
/** Opens <workspace>/<sub>, the real folder or nothing. Caller closes. */
function openWorkspaceDir(wsId, sub, { create = false } = {}) {
  if (!WORKSPACE_ID_RE.test(wsId) || (sub !== "out" && sub !== "uploads")) throw new Error("hors du workspace");
  if (create) ensureWorkspaceDir(wsId, sub);
  const expected = path.join(fs.realpathSync(WORKSPACES_DIR), wsId, sub);
  const fd = fs.openSync(expected, REAL_DIR);
  try {
    if (fs.readlinkSync(fdPath(fd)) !== expected) throw new Error("hors du workspace");
    return fd;
  } catch (e) {
    fs.closeSync(fd);
    throw e;
  }
}
/** Opens a regular file of out/ or uploads/ for reading. Caller owns `fd`. */
function openWorkspaceFile(wsId, rel) {
  if (!WORKSPACE_PATH_RE.test(rel)) throw new Error("hors du workspace");
  const [sub, name] = rel.split("/");
  const dirFd = openWorkspaceDir(wsId, sub);
  try {
    // O_NONBLOCK: a named pipe must not hang the relay while it is opened.
    const fd = fs.openSync(`${fdPath(dirFd)}/${name}`, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile()) throw new Error("pas un fichier");
      return { fd, size: st.size };
    } catch (e) {
      fs.closeSync(fd);
      throw e;
    }
  } finally {
    fs.closeSync(dirFd);
  }
}
/** Regular files of out/ and uploads/ — links and folders are not listed. */
function listWorkspaceFiles(wsId) {
  const list = [];
  for (const sub of ["uploads", "out"]) {
    let dirFd;
    try { dirFd = openWorkspaceDir(wsId, sub); } catch { continue; }
    try {
      for (const f of fs.readdirSync(fdPath(dirFd))) {
        try {
          const st = fs.lstatSync(`${fdPath(dirFd)}/${f}`);
          if (st.isFile()) list.push({ path: `${sub}/${f}`, bytes: st.size, mtime: st.mtimeMs });
        } catch { /* raced */ }
      }
    } catch { /* none */ } finally { fs.closeSync(dirFd); }
  }
  return list;
}
/**
 * Stores a consultant's upload in uploads/. Written under a temporary name
 * that did not exist (O_EXCL), then renamed: a link waiting under the final
 * name is replaced, never written through, and ownership is given on the
 * descriptors, never on a path.
 */
function writeWorkspaceUpload(wsId, name, buf) {
  const dirFd = openWorkspaceDir(wsId, "uploads", { create: true });
  const tmp = `${fdPath(dirFd)}/.depot-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  try {
    const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o644);
    try {
      fs.writeFileSync(fd, buf);
      try { fs.fchownSync(fd, SANDBOX_UID, SANDBOX_UID); } catch { /* best effort */ }
    } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, `${fdPath(dirFd)}/${name}`);
    try { fs.fchownSync(dirFd, SANDBOX_UID, SANDBOX_UID); fs.lchownSync(path.join(WORKSPACES_DIR, wsId), SANDBOX_UID, SANDBOX_UID); } catch { /* best effort */ }
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* never created, or renamed */ }
    throw e;
  } finally {
    fs.closeSync(dirFd);
  }
}
function workspaceIdFor(sessionKey) {
  return crypto.createHash("sha256").update(sessionKey).digest("hex").slice(0, 24);
}
/**
 * Empties a folder through its descriptor. A sub-folder is opened itself
 * (O_NOFOLLOW) before anything in it is removed, a link is removed as a link:
 * nothing outside the folder is ever reached, even if the container swaps a
 * folder for a link while the purge runs (fs.rmSync goes by path, and would
 * then empty the folder the link points to).
 */
function emptyDirByFd(dirFd) {
  for (const name of fs.readdirSync(fdPath(dirFd))) {
    const entry = `${fdPath(dirFd)}/${name}`;
    if (!fs.lstatSync(entry).isDirectory()) { fs.unlinkSync(entry); continue; }
    const fd = fs.openSync(entry, REAL_DIR);
    try { emptyDirByFd(fd); } finally { fs.closeSync(fd); }
    fs.rmdirSync(entry);
  }
}
function pruneWorkspaces() {
  let dirs;
  try { dirs = fs.readdirSync(WORKSPACES_DIR); } catch { return; }
  const cutoff = Date.now() - WORKSPACE_TTL_MS;
  for (const d of dirs) {
    const abs = path.join(WORKSPACES_DIR, d);
    try {
      // lstat: a workspace that is itself a link is not one — neither dated
      // nor purged through it, and left where it is.
      const st = fs.lstatSync(abs);
      if (st.isSymbolicLink()) { console.error(`[workspace] ${d} est un lien — ignoré par la purge`); continue; }
      if (!st.isDirectory()) {
        if (st.mtimeMs < cutoff) { fs.unlinkSync(abs); console.log(`[workspace] purgé ${d}`); }
        continue;
      }
      const wsFd = fs.openSync(abs, REAL_DIR);
      try {
        let newest = fs.fstatSync(wsFd).mtimeMs;
        for (const sub of ["out", "uploads"]) {
          let subFd;
          try { subFd = fs.openSync(`${fdPath(wsFd)}/${sub}`, REAL_DIR); } catch { continue; /* none, or a link */ }
          try {
            // lstat: a link planted by the container must not make the date
            // of a host file pass for the workspace's.
            for (const f of fs.readdirSync(fdPath(subFd))) newest = Math.max(newest, fs.lstatSync(`${fdPath(subFd)}/${f}`).mtimeMs);
          } catch { /* raced */ } finally { fs.closeSync(subFd); }
        }
        if (newest < cutoff) { emptyDirByFd(wsFd); fs.rmdirSync(abs); console.log(`[workspace] purgé ${d}`); }
      } finally {
        fs.closeSync(wsFd);
      }
    } catch (e) { console.error(`[workspace] purge de ${d} impossible : ${e.code || e.message}`); }
  }
}
setInterval(pruneWorkspaces, 60 * 60 * 1000).unref();
pruneWorkspaces();
const CLIENT_KEY_RE = /^[a-z0-9][a-z0-9_-]{1,39}$/;
// What this relay understands in a /api/chat request beyond the historical
// fields, announced by /health. The application reads it before relying on a
// field an older relay would silently ignore (lib/dashboard-copilot.ts), so
// the relay and the application can be deployed in any order.
const CAPABILITIES = ["turnContext", "hqGuidance", "sheetsDirect", "toolAllowlist"];
// Agentic loop cap. 15 by default; staff surfaces with the sandbox ask for more.
const MAX_TURNS_CAP = 40;
// Pseudo-server "web": not an MCP server but the CLI's built-in WebSearch /
// WebFetch. Staff only (never a client bot: a fetched page is an injection
// vector). WebSearch is an Anthropic server-side tool, absent on Bedrock.
const WEB_SERVER = "web";
// Image attachments (copilote) — bounded so a chat can't ship megabytes of pixels.
const IMAGE_MEDIA_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const IMAGE_MAX_B64_CHARS = 2_000_000; // ≈1.5 MB per image
const IMAGES_PER_MESSAGE = 4;
const IMAGES_PER_PROMPT = 6;
// HQ (hqforwork.com) — mémoire d'entreprise de l'agence : skills, knowledge,
// projets, policies. Ce n'est PAS une entrée de mcp-claude.json : le CLI ne le
// charge que sans --strict-mcp-config, depuis le compte hôte, sous deux formes :
//   - abonnement Claude Max : le connecteur claude.ai "claude.ai mcp hq"
//     (préfixe mcp__claude_ai_mcp_hq__) ;
//   - Bedrock (bascule quota) : les connecteurs claude.ai ne se chargent pas.
//     Le relay déclare alors lui-même un serveur MCP HTTP "hq" (préfixe
//     mcp__hq__) avec un bearer qu'il tient à jour (server/hq-oauth.mjs,
//     jeton obtenu une fois par OAuth navigateur). Sans jeton, HQ manque,
//     ce que le log signale.
// Il agit avec l'identité propriétaire de l'agence, donc : IA interne
// uniquement (jamais un bot client), et uniquement les outils de lecture
// listés ci-dessous.
const HQ_SERVER = "hq";
const HQ_TOOL_PREFIX = "mcp__claude_ai_mcp_hq__";
const HQ_LOCAL_TOOL_PREFIX = "mcp__hq__";
const HQ_INIT_NAMES = new Set(["claude.ai mcp hq", HQ_SERVER]);
const HQ_READ_TOOLS = [
  "hq_ping", "hq_whoami", "hq_context_grounding", "hq_companies_list", "search", "fetch", "hq_content_get",
  "hq_knowledge_list", "hq_knowledge_get", "hq_files_list", "hq_files_read",
  "hq_projects_list", "hq_project_get", "hq_project_status",
  "hq_policies_list", "hq_policy_get", "hq_skill_list", "hq_skill_get",
  // Additive writes only (a dated file is created, nothing is edited or
  // removed): the consultant can ask the AI to log a note itself.
  "hq_project_journal_append", "hq_knowledge_capture",
  // Skills (méthodes / playbooks) : création, mise à jour sous verrou
  // optimiste (expectedContentHash), proposition d'amélioration en commentaire.
  "hq_skill_create", "hq_skill_update", "hq_skill_improvement_post",
];

// Notion de l'agence : serveur MCP n8n (workflow « Notion_MCP_Server »,
// déclaré dans config/mcp-claude.json). n8n tient l'accès à Notion, donc il
// suit chaque chat quel que soit le compte du pool ou le fournisseur. Il voit
// tout l'espace de l'agence : IA interne uniquement, jamais un bot client.
const NOTION_SERVER = "notion";

// TikTok Ads : serveur MCP n8n en lecture seule (« TikTok Ads MCP v2.1 »), un
// seul jeton pour tous les annonceurs de l'agence. Toujours derrière le proxy
// de périmètre, qui complète aussi les arguments des rapports.
const TIKTOK_SERVER = "mcp-tiktok-ads";
// Performance seulement : ce qu'un bot client peut lire.
const TIKTOK_CLIENT_TOOLS = [
  "get_advertiser_info", "get_campaigns", "get_adgroups", "get_ads",
  "get_campaign_performance", "get_adgroup_performance", "get_ad_performance",
  "get_breakdown_report", "get_report_integrated",
];
// L'équipe lit aussi les audiences, la médiathèque, et la liste des Business
// Centers et de leurs comptes (le proxy la refuse hors périmètre illimité).
// `list_advertisers` (le secret de l'application en paramètre) n'est ouvert à
// aucune conversation.
const TIKTOK_STAFF_TOOLS = [
  ...TIKTOK_CLIENT_TOOLS, "list_custom_audiences", "search_ad_videos", "search_ad_images",
  "list_business_centers", "list_bc_advertisers",
];

// Global whitelist — only servers declared here can ever be routed to the AI.
// The per-request `allowedServers` list is intersected with this set, so even
// a malicious caller can't open up new MCP surface area.
const ALLOWED_MCP_SERVERS = new Set([
  SANDBOX_SERVER,
  GWS_SERVER,
  "meta-ads-impulse",
  "mcp-google-ads",
  "mcp-google-analytics",
  TIKTOK_SERVER,
  // Google Sheets (n8n, compte data@ de l'agence) : lecture seule, staff.
  // Le consultant partage sa feuille avec ce compte, puis colle le lien.
  "mcp-google-sheet",
  CLIENT_DATA_SERVER,
  HQ_SERVER,
  NOTION_SERVER,
]);

// Per-server explicit tool allowlist for the CHAT (handleChat). Servers absent
// from this map are allowed wholesale there (mcp__<server>__*), which does not
// mean they only hold read tools: mcp-google-ads has Create_Conversion_Action.
// In a chat the ads servers run behind server/mcp-scoped-ads.mjs, which
// refuses their write tools; /api/tool has no such proxy and follows
// DIRECT_TOOL_ALLOWLIST below instead.
const SERVER_TOOL_ALLOWLIST = {
  "mcp-google-sheet": ["search_sheet", "Get_row_s_in_sheet_in_Google_Sheets"],
  // Notion : lecture, et écritures qui AJOUTENT seulement (sur demande explicite
  // du consultant, voir la consigne système). Notion_Replace_Page_Content, qui
  // écrase le contenu d'une page existante, reste fermé.
  [NOTION_SERVER]: [
    "Notion_Search_Pages", "Notion_Search_Databases", "Notion_Read_Page", "Notion_Read_Database_Rows",
    "Notion_Create_Page", "Notion_Create_Database_Row", "Notion_Append_Text_To_Page",
  ],
  "mcp-google-analytics": [
    "get_data_retention_settings", "get_data_stream", "get_enhanced_measurement_settings",
    "get_metadata", "get_property", "list_accounts", "list_audiences",
    "list_custom_dimensions", "list_custom_metrics", "list_data_streams",
    "list_firebase_links", "list_google_ads_links", "list_key_events", "list_properties",
    "run_pivot_report", "run_realtime_report", "run_report",
  ],
  // Liste fermée : un outil ajouté plus tard dans n8n reste fermé tant qu'il
  // n'est pas nommé ici. Un bot client reçoit TIKTOK_CLIENT_TOOLS (chatToolsOf).
  [TIKTOK_SERVER]: TIKTOK_STAFF_TOOLS,
};

/** Tools of a server open to this chat: fewer for a client bot where it matters. */
function chatToolsOf(server, clientBot) {
  if (server === TIKTOK_SERVER && clientBot) return TIKTOK_CLIENT_TOOLS;
  return SERVER_TOOL_ALLOWLIST[server] ?? null;
}

// Tools open to /api/tool (direct call, no AI, no scope proxy): read tools
// only, named one by one. A server absent from this map, or a tool absent from
// its list, is refused — so a tool added upstream in n8n stays closed until it
// is listed here. Writes never go through /api/tool: Sheets are written by
// /api/sheets/* (server/sheets-direct.mjs), nothing else is written at all.
const DIRECT_TOOL_ALLOWLIST = {
  "mcp-google-ads": [
    "List_Customers", "Custom_GAQL_Query", "Get_Campaigns", "Campaign_Performance",
    "AdGroup_Performance", "Ads_Performance", "Keywords_Performance", "Search_Terms",
    "Audience_Performance", "Geo_Performance", "Device_Performance", "Daily_Performance",
    "Conversion_Actions", "List_Conversion_Actions", "Budget_Info",
  ],
  "meta-ads-impulse": [
    "List_Ad_Accounts1", "Get_Campaigns1", "Get_AdSets_Structure1", "Get_Ad_Creatives1",
    "Account_Overview1", "Campaign_Performance1", "AdSet_Performance1", "Ad_Performance1",
    "Daily_Performance1", "Campaign_Daily_Trend1", "Conversion_Funnel1",
    "Age_Gender_Breakdown1", "Device_Breakdown1", "Country_Breakdown1", "Placement_Breakdown1",
  ],
  "mcp-google-analytics": SERVER_TOOL_ALLOWLIST["mcp-google-analytics"],
  "mcp-google-sheet": SERVER_TOOL_ALLOWLIST["mcp-google-sheet"],
  // No scope proxy here, like Google's GAQL: the application checks the
  // caller's accounts before asking (lib/tiktok-data.ts). The arguments are
  // still read and completed by prepareTikTokArgs (fixed metrics, strict JSON,
  // one advertiser named), see tiktokDirectInput.
  [TIKTOK_SERVER]: ["get_advertiser_info", "get_campaigns", "get_report_integrated", "list_business_centers", "list_bc_advertisers"],
};

/** "<server>.<tool>" → null when /api/tool may call it, the reason otherwise. */
function directToolRefusal(tool) {
  const name = typeof tool === "string" ? tool : "";
  const firstDot = name.indexOf(".");
  const server = firstDot > 0 ? name.slice(0, firstDot) : "";
  const allowed = Object.prototype.hasOwnProperty.call(DIRECT_TOOL_ALLOWLIST, server) ? DIRECT_TOOL_ALLOWLIST[server] : null;
  if (!allowed || !ALLOWED_MCP_SERVERS.has(server)) return "tool not allowed: serveur fermé aux appels directs";
  if (!allowed.includes(name.slice(firstDot + 1))) return "tool not allowed: seuls les outils de lecture listés par le relay sont ouverts aux appels directs";
  return null;
}

// Shared-secret guard for requests from the Next.js backend — mandatory.
// Every endpoint (except /health) refuses requests that don't present the
// matching Authorization: Bearer header.
const RELAY_SHARED_SECRET = process.env.RELAY_SHARED_SECRET || "";
if (!RELAY_SHARED_SECRET) {
  console.error("[relay] FATAL: RELAY_SHARED_SECRET is required. Refusing to start in open mode.");
  process.exit(1);
}

// Claude Max quota (see server/quota.mjs). Since 2026-10-01 a saturated
// account hands staff chats to another Max account, never to Bedrock:
// Bedrock is reserved for the client bots. BEDROCK_FALLBACK is ignored.
const BEDROCK_FALLBACK = false;
// Pool de comptes Claude Max (server/max-accounts.mjs) : le login du serveur
// + les jetons `claude setup-token` ajoutés via /api/accounts. Un moniteur de
// quota par compte ; `quota` reste celui du compte serveur (compatibilité).
maxAccounts.init({
  warnPct: process.env.QUOTA_WARN_PCT,
  switchPct: process.env.QUOTA_SWITCH_PCT,
  notify: makeWebhookNotifier({
    url: process.env.N8N_ALERT_WEBHOOK_URL,
    secret: process.env.N8N_ALERT_WEBHOOK_SECRET,
    slackChannel: process.env.RELAY_ALERT_SLACK_CHANNEL,
    appUrl: (process.env.APP_URL || "https://impulsemotion.vercel.app").replace(/\/$/, ""),
  }),
  probeMs: Number(process.env.QUOTA_PROBE_MS || 300_000),
});
const quota = maxAccounts.hostMonitor();

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
        tools.push({
          server: s.name,
          name: t.name,
          description: (t.description || "").slice(0, 200),
          // Which calling convention the tool expects (see adaptToolInput).
          // `mcporter list` without a server name carries no schema, but the
          // retired n8n tool node always appends this sentence to its description.
          legacyInput: /stringified JSON object/i.test(t.description || ""),
        });
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
  [TIKTOK_SERVER]: (scope) => scope.tiktok,
};
// Servers whose open tools are also pinned in the proxy (SCOPED_TOOLS), not
// only in the CLI's --allowedTools.
const PROXY_PINNED_TOOLS = new Set([TIKTOK_SERVER]);

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
// HQ as a plain HTTP MCP entry, authenticated by the relay's own bearer
// (--restricted never loads the host's user-scope servers, and the CLI's
// OAuth store is not something we can fill from outside).
const HQ_MCP_URL = process.env.HQ_MCP_URL || "https://hq-mcp.hq.computer/mcp";
function hqLocalEntry(token) {
  return { type: "http", url: HQ_MCP_URL, headers: { Authorization: `Bearer ${token}` } };
}

function buildScopedMcpConfig({ servers, clientKey, accountScope, ga4PropertyId, hqToken = null, workspaceDir = null, gwsAuthState = null, clientBot = false }) {
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
  if (hqToken) mcpServers[HQ_SERVER] = hqLocalEntry(hqToken);

  for (const name of servers) {
    if (name === SANDBOX_SERVER) {
      if (!workspaceDir) { console.error("[chat] sandbox désactivé (pas de workspace : sessionKey absente ou bot client)"); continue; }
      mcpServers[name] = {
        command: "node",
        args: [SANDBOX_MCP_SCRIPT],
        env: {
          WORKSPACE_DIR: workspaceDir,
          ...(process.env.SANDBOX_IMAGE ? { SANDBOX_IMAGE: process.env.SANDBOX_IMAGE } : {}),
          ...(syncedSkillsDir() ? { SKILLS_DIR: syncedSkillsDir() } : {}),
        },
      };
      kept.push(name);
      continue;
    }
    if (name === GWS_SERVER) {
      if (!gwsAuthState) continue;
      mcpServers[name] = {
        command: "node",
        args: [GWS_MCP_SCRIPT],
        env: {
          ...(gwsAuthState.token ? { GWS_ACCESS_TOKEN: gwsAuthState.token, GWS_TOKEN_EXPIRES_AT: String(gwsAuthState.expiresAt) } : {}),
          ...(gwsAuthState.error ? { GWS_AUTH_ERROR: gwsAuthState.error } : {}),
          // Same workspace as the sandbox: uploads/attachments come from it,
          // downloads land in out/ and are served by /api/files.
          ...(workspaceDir ? { WORKSPACE_DIR: workspaceDir } : {}),
        },
      };
      kept.push(name);
      continue;
    }
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
    // "*" is the word of the unrestricted scope only: never an id a caller can list.
    const ids = unrestricted ? ["*"] : (pick(effectiveScope) || []).filter((v) => typeof v === "string" && v.trim() && v.trim() !== "*");
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
        ...(PROXY_PINNED_TOOLS.has(name) ? { SCOPED_TOOLS: (chatToolsOf(name, clientBot) || []).join(",") } : {}),
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

// ── One turn at a time per conversation ─────────────────────────────────────
// Two turns running at once on the same sessionKey would start from the same
// stored total (the ledger then bills one of them wrongly) and --resume the
// same transcript twice. The second one is REFUSED, with a message: making it
// wait would bill it against a total it did not see coming, and hold a
// request open for as long as the first one runs. The one exception is a turn
// the relay is already stopping (time budget, result received): the chat
// surfaces relaunch at once, so the newcomer waits for the CLI to be gone.
const sessionLocks = new Map();
const SESSION_LOCK_WAIT_MS = 10_000;
// A CLI that ignores SIGTERM is killed for good after this long.
const KILL_GRACE_MS = 5_000;
// How long the CLI may take to exit once its `result` is out.
const RESULT_GRACE_MS = Number(process.env.RELAY_RESULT_GRACE_MS || 10_000);
/** The lock of a conversation, or null when a turn is running on it. */
async function acquireSessionLock(key) {
  const deadline = Date.now() + SESSION_LOCK_WAIT_MS;
  for (let held = sessionLocks.get(key); held; held = sessionLocks.get(key)) {
    const left = deadline - Date.now();
    if (!held.stopping || left <= 0) return null;
    let timer;
    await Promise.race([held.freed, new Promise((r) => { timer = setTimeout(r, left); })]);
    clearTimeout(timer);
  }
  let free;
  const lock = {
    stopping: false,
    freed: new Promise((r) => { free = r; }),
    release() {
      if (sessionLocks.get(key) === lock) sessionLocks.delete(key);
      free();
    },
  };
  sessionLocks.set(key, lock);
  return lock;
}
const SESSION_BUSY_MESSAGE = "Une réponse est déjà en cours sur cette conversation. Attendez qu'elle soit terminée avant d'envoyer la suite.";

/** Ends a chat that could not run with an explicit error, never an empty stream. */
function failChat(res, message) {
  if (res.writableEnded) return;
  if (!res.headersSent) { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: message })); return; }
  res.write(`data: ${JSON.stringify({ type: "error", message })}\n\n`);
  res.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
  res.end();
}
const roundUsd = (v) => Math.round(v * 1e9) / 1e9;
const addTokens = (a, b) => ({ input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite });

// ── Chat via Claude CLI with streaming ──────────────────────────────────────
async function handleChat(messages, allowedServers, accountScope, res, systemPromptOverride, budgetMs, dataScope, provider, options = {}) {
  if (!res.headersSent) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    // Flush headers + a first byte right away: proxies (and undici fetch with a
    // headers-only timeout) must see the response before the CLI warms up.
    res.flushHeaders?.();
    res.write(": connected\n\n");
  }
  // A relaunched attempt (other account) inherits the lock of the first one.
  const sessionKey = typeof options.sessionKey === "string" && SESSION_KEY_RE.test(options.sessionKey) ? options.sessionKey : null;
  const lock = options.lock ?? (sessionKey ? await acquireSessionLock(sessionKey) : null);
  if (sessionKey && !lock) {
    console.error(`[chat] ${sessionKey} : tour refusé — un tour est déjà en cours sur cette conversation`);
    failChat(res, SESSION_BUSY_MESSAGE);
    return;
  }
  try {
    await runChat(messages, allowedServers, accountScope, res, systemPromptOverride, budgetMs, dataScope, provider, { ...options, lock });
  } catch (err) {
    lock?.release();
    throw err;
  }
}

async function runChat(messages, allowedServers, accountScope, res, systemPromptOverride, budgetMs, dataScope, provider, options = {}) {
  const lock = options.lock ?? null;
  // Tokens and cost of the attempts this one replaces (account that ran dry
  // after it had consumed): they belong to the turn, and to its ledger line.
  const carried = options.carried ?? null;
  // Subscription exhausted (or nearly): every chat runs on Bedrock until the
  // window resets. Explicit Bedrock callers (client bots) are unchanged.
  // Which Claude Max account answers: the caller's pick while it has room,
  // else the account with the most room, else Bedrock (quota fallback).
  const preferredAccount = typeof options.account === "string" && maxAccounts.isKnown(options.account) ? options.account : null;
  const excludedAccounts = Array.isArray(options.excludeAccounts) ? options.excludeAccounts : [];
  // Amazon Bedrock is for the client bots only (provider "bedrock"): a staff
  // chat always runs on a Claude Max account — the one with the most room,
  // then the least used still answering (rule of 2026-10-01, Melvin).
  let account = provider === "bedrock" ? null : maxAccounts.pickForStaff({ preferred: preferredAccount, exclude: excludedAccounts });
  if (!account && provider !== "bedrock") account = preferredAccount ?? maxAccounts.HOST_ACCOUNT;
  const fallback = false;
  const useBedrock = provider === "bedrock";
  const accountMonitor = account ? maxAccounts.monitor(account) : null;
  const model = resolveModel(options.model, useBedrock);
  const effort = resolveEffort(options.effort);
  // Tool-driven sessions may cap the agentic loop lower than the default: a
  // short, deterministic lookup (HQ client context) has no business running 15 turns.
  const maxTurns = Number.isInteger(options.maxTurns) && options.maxTurns >= 1 && options.maxTurns <= MAX_TURNS_CAP ? options.maxTurns : 15;

  const send = (type, data) => {
    res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
  };

  const sessionKey = typeof options.sessionKey === "string" && SESSION_KEY_RE.test(options.sessionKey) ? options.sessionKey : null;
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  // Images attached to user messages ({ mediaType, data } base64). They go to
  // the CLI as image content blocks over stdin (--input-format stream-json);
  // the text path is untouched when there are none.
  const imagesOf = (m) => (Array.isArray(m?.images) ? m.images : [])
    .filter((im) => im && IMAGE_MEDIA_TYPES.has(im.mediaType) && typeof im.data === "string" && im.data.length > 0 && im.data.length <= IMAGE_MAX_B64_CHARS)
    .slice(0, IMAGES_PER_MESSAGE);
  // Fresh session: the whole history is replayed as text, plus the most recent
  // images (older ones are described, not re-sent — the budget is bounded).
  const historyImages = () => {
    const out = [];
    messages.forEach((m, i) => { if (m.role === "user") for (const im of imagesOf(m)) out.push({ ...im, index: i + 1 }); });
    return out.slice(-IMAGES_PER_PROMPT);
  };
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
  const requestedServers = Array.isArray(allowedServers) ? allowedServers : [];
  let servers = requestedServers.filter((s) => typeof s === "string" && ALLOWED_MCP_SERVERS.has(s));

  // "client-data" only ever runs pinned to a server-side clientKey.
  const clientKey =
    dataScope && typeof dataScope === "object" && typeof dataScope.clientKey === "string" && CLIENT_KEY_RE.test(dataScope.clientKey)
      ? dataScope.clientKey
      : null;
  const ga4PropertyId =
    dataScope && typeof dataScope === "object" && typeof dataScope.ga4PropertyId === "string" && dataScope.ga4PropertyId.trim()
      ? dataScope.ga4PropertyId.trim().slice(0, 64)
      : null;
  // HQ carries the agency owner's identity: never for a client bot (dataScope,
  // or an explicit `provider: "bedrock"` caller). A staff chat pushed onto
  // Bedrock by the quota fallback keeps HQ, through the host's local "hq"
  // server instead of the claude.ai connector. Pulled out of `servers` either
  // way — it has no entry in the mcp-config, the CLI gets it from the host.
  const clientBot = !!dataScope || provider === "bedrock" || options.clientBot === true;
  const useWeb = requestedServers.includes(WEB_SERVER) && !clientBot;
  const builtinTools = ["ToolSearch", ...(useWeb ? ["WebFetch", ...(useBedrock ? [] : ["WebSearch"])] : [])];
  let useHq = servers.includes(HQ_SERVER) && !clientBot;
  // HQ always goes through the relay's own bearer (server/hq-oauth.mjs): the
  // host's claude.ai connector would tie HQ to one Max login, and the pool
  // runs chats under other logins. Without a token the chat runs without HQ.
  const hqToolPrefix = HQ_LOCAL_TOOL_PREFIX;
  if (servers.includes(HQ_SERVER) && !useHq) console.error("[chat] hq refusé — requête de bot client");
  servers = servers.filter((s) => s !== HQ_SERVER);
  let hqToken = null;
  if (useHq) {
    hqToken = await hqOauth.getAccessToken();
    if (!hqToken) { console.error("[chat] hq indisponible — aucun jeton HQ valide (voir server/hq-oauth.mjs)"); useHq = false; }
  }

  // Notion: staff only, like HQ.
  if (servers.includes(NOTION_SERVER) && clientBot) {
    servers = servers.filter((s) => s !== NOTION_SERVER);
    console.error("[chat] notion refusé — requête de bot client");
  }

  // Every chat goes through a generated config: scopes are pinned in the
  // environment of stdio servers, never left to the prompt.
  // Sandbox: staff only, and only for a named conversation (its workspace).
  let workspaceDir = null;
  if (servers.includes(SANDBOX_SERVER)) {
    if (clientBot || !sessionKey) servers = servers.filter((s) => s !== SANDBOX_SERVER);
    else {
      const wsId = workspaceIdFor(sessionKey);
      workspaceDir = path.join(WORKSPACES_DIR, wsId);
      try {
        for (const sub of ["uploads", "out"]) ensureWorkspaceDir(wsId, sub);
      } catch (e) {
        console.error(`[chat] workspace ${wsId} inutilisable : ${e.code || e.message}`);
        lock?.release();
        failChat(res, "Le dossier de travail de cette conversation est inutilisable. Ouvrez une nouvelle conversation ; si l'erreur persiste, prévenez un administrateur.");
        return;
      }
    }
  }
  // Google Workspace: staff only. The token is minted here (never by the
  // model); without one the server still starts so gws_status can explain.
  let gwsAuthState = null;
  if (servers.includes(GWS_SERVER)) {
    if (clientBot) { servers = servers.filter((s) => s !== GWS_SERVER); console.error("[chat] gws refusé — requête de bot client"); }
    else {
      try { gwsAuthState = await gwsAuth.getAccessToken(); }
      catch (err) { gwsAuthState = { error: err.message }; }
    }
  }
  const scopedMcp = buildScopedMcpConfig({ servers, clientKey, accountScope, ga4PropertyId, hqToken, workspaceDir, gwsAuthState, clientBot });
  if (scopedMcp) servers = scopedMcp.servers;
  const mcpConfigPath = scopedMcp ? scopedMcp.path : MCP_CONFIG;
  const cleanupScopedMcp = () => scopedMcp?.cleanup();

  // Read-only tool allowlists: the GA4 MCP also exposes mutations
  // (create/update/archive custom dimensions, key events, retention…). No chat
  // caller — client bot or staff — may ever mutate a client property.
  const toolPatterns = servers.flatMap((s) => {
    const tools = chatToolsOf(s, clientBot);
    return tools ? tools.map((t) => `mcp__${s}__${t}`) : [`mcp__${s}__*`];
  });
  if (useHq) toolPatterns.push(...HQ_READ_TOOLS.map((t) => `${hqToolPrefix}${t}`));
  // Built-ins are denied in --print mode unless allowed explicitly, like MCP tools.
  if (useWeb) toolPatterns.push(...builtinTools.filter((t) => t !== "ToolSearch"));

  // Scope the AI to only the accountIds the caller is allowed to query.
  // Callers may override the base prompt for one-shot tasks (recommendations,
  // text generation, etc.) — the accountScope restrictions are still appended.
  // Static text first, per-caller text after the cache boundary, and nothing
  // that changes with the day (see server/relay-prompt.mjs).
  const scopedSystemPrompt = buildSystemPrompt({
    base: typeof systemPromptOverride === "string" && systemPromptOverride.trim() ? systemPromptOverride : SYSTEM_PROMPT,
    accountScope,
    ga4PropertyId,
    useHq,
    callerTeachesHq: options.hqGuidance === "caller",
    useNotion: servers.includes(NOTION_SERVER),
  });

  // Resume when the caller named a conversation that we already hold, whose
  // scope fingerprint is unchanged, and which is not being restarted (a
  // single-message thread = "nouvelle conversation"). Anything else starts a
  // fresh session, replaying whatever history the caller sent.
  const fingerprint = scopeFingerprint({ servers, toolPatterns, accountScope: accountScope ?? null, clientKey, ga4PropertyId, useBedrock, model });
  const existing = sessionKey ? sessions[sessionKey] : null;
  const canResume = !!existing && messages.length > 1 && existing.fingerprint === fingerprint && fs.existsSync(transcriptPath(existing.id));
  if (sessionKey && existing && !canResume) forgetSession(sessionKey);
  const sessionId = canResume ? existing.id : (sessionKey ? crypto.randomUUID() : null);
  // Today's date and the caller's turn context (what moves during the
  // conversation, e.g. the dashboard's widgets) travel with the user message:
  // a resumed session keeps the system prompt of its first turn. The context
  // is sent again only when it differs from the one this session last saw.
  const turn = buildTurnPrompt({
    prompt: canResume && lastUser ? lastUser.content : flattenHistory(),
    turnContext: options.turnContext,
    sentContextHash: canResume && !options.resendContext ? existing.contextHash ?? null : null,
  });
  const prompt = turn.text;
  if (turn.contextTruncated) console.error(`[chat] contexte de tour tronqué : ${turn.contextChars} caractères reçus${sessionKey ? ` (${sessionKey})` : ""}`);
  // The count of this turn (billing ledger), see server/relay-prompt.mjs.
  const meter = createTurnMeter({
    resumed: canResume,
    stored: canResume ? existing : null,
    log: (message) => console.error(`[usage] ${sessionKey ?? "sans session"} : ${message}`),
  });
  const promptImages = canResume && lastUser ? imagesOf(lastUser).map((im) => ({ ...im, index: messages.length })) : historyImages();
  if (sessionKey) {
    sessions[sessionKey] = { id: sessionId, fingerprint, updatedAt: Date.now(), ...(turn.contextHash ? { contextHash: turn.contextHash } : {}), ...meter.sessionFields() };
    saveSessions();
  }

  const args = [
    // With images the prompt travels on stdin as content blocks instead.
    ...(promptImages.length ? ["--print", "--input-format", "stream-json"] : ["--print", prompt]),
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--model", model,
    ...(effort ? ["--effort", effort] : []),
    "--mcp-config", mcpConfigPath,
    // Only the servers we declare: never the claude.ai connectors of the host
    // account — except for HQ on the subscription, which only exists as one.
    // The other connectors then load too, but stay unusable: in --print mode a
    // tool outside --allowedTools is denied, and only HQ_READ_TOOLS are listed.
    // On Bedrock the connectors never load; HQ is then the declared "hq" entry.
    "--strict-mcp-config",
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
    "--tools", builtinTools.join(","),
  ];
  if (toolPatterns.length > 0) {
    args.push("--allowedTools", ...toolPatterns);
  } else {
    args.push("--disallowedTools", "mcp__*");
  }

  console.log(`[chat] Prompt: "${promptLogExcerpt(lastUser?.content ?? prompt)}"${turn.contextSent ? ` | contexte=${turn.contextChars}c${turn.contextTruncated ? " (tronqué)" : ""}` : ""} | model=${model}${effort ? `/${effort}` : ""}${sessionKey ? ` | session=${canResume ? "resume" : "new"}` : ""}${useHq ? " | hq" : ""}${servers.includes(NOTION_SERVER) ? " | notion" : ""}${useWeb ? " | web" : ""}${gwsAuthState ? ` | gws${gwsAuthState.token ? "" : " (sans jeton)"}` : ""}${clientKey && scopedMcp ? ` | client-data=${clientKey}` : ""}${useBedrock ? ` | bedrock@${BEDROCK_REGION}${fallback ? " (fallback quota)" : ""}` : ` | compte=${account}`}`);

  // Dedicated empty cwd: keeps the spawned CLI away from any project
  // CLAUDE.md/hooks that would inject non-deterministic context.
  const child = spawn("claude", args, {
    cwd: RELAY_CLAUDE_CWD,
    env: {
      ...process.env,
      TERM: "dumb",
      ...cliTokenEnv({ useBedrock, resumable: !!sessionKey, maxMcpOutputTokens: process.env.RELAY_MAX_MCP_OUTPUT_TOKENS }),
      ...(useBedrock
        ? {
            CLAUDE_CODE_USE_BEDROCK: "1",
            AWS_REGION: BEDROCK_REGION,
            // Background/small-model calls must stay on Bedrock too.
            ANTHROPIC_DEFAULT_HAIKU_MODEL: BEDROCK_MODEL,
          }
        : maxAccounts.envFor(account)),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (promptImages.length) {
    const content = [{ type: "text", text: prompt }];
    for (const im of promptImages) {
      content.push({ type: "text", text: `[Image jointe par le consultant au message ${im.index}${im.name ? ` : ${String(im.name).slice(0, 80)}` : ""}]` });
      content.push({ type: "image", source: { type: "base64", media_type: im.mediaType, data: im.data } });
    }
    child.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n");
  }
  child.stdin.end();

  let buffer = "";
  let fullText = "";
  let sentContent = false;
  let finished = false;
  // Set when the account ran dry before any content went out: the chat is
  // relaunched on another account (or Bedrock) over the same response.
  let retrying = false;
  // The relay itself stopped the CLI (time budget, client gone): the session
  // is sound and must stay resumable, even if no text was written yet.
  let stoppedByRelay = false;
  // Tokens counted live, one model call at a time: a turn that is cut never
  // reaches the CLI's final `result`, and must still reach the usage ledger.
  const startedAt = Date.now();
  const sendLiveUsage = () => {
    // Once the result is in, the final usage is out: a partial one sent after
    // it would be the last the application sees, and the turn billed 0.
    if (meter.settled) return;
    const live = meter.observed();
    if (!live) return;
    send("usage", {
      partial: true,
      cost: carried ? carried.cost : 0,
      ...(carried ? { earlierAttempts: carried.attempts } : {}),
      turns: live.calls,
      duration: Date.now() - startedAt,
      provider: useBedrock ? "bedrock" : "subscription",
      account: useBedrock ? null : account,
      fallback,
      model,
      effort,
      tokens: carried ? addTokens(live.tokens, carried.tokens) : live.tokens,
    });
  };
  // Stops the CLI for good: SIGTERM, then SIGKILL if it does not leave — the
  // conversation stays locked until it has.
  let stopping = false;
  const stopChild = () => {
    stoppedByRelay = true;
    if (lock) lock.stopping = true;
    if (stopping || child.exitCode !== null || child.signalCode !== null) return false;
    stopping = true;
    child.kill("SIGTERM");
    setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }, KILL_GRACE_MS).unref();
    return true;
  };
  // The first ~160 chars of a reply are held back until they are clearly not
  // an account error ("Failed to authenticate", "usage limit"…): the CLI
  // streams those as ordinary assistant text, and a held error lets the turn
  // be relaunched on another account without leaking the error to the client.
  let head = "";
  let sawDelta = false; // deltas streamed → the assistant message's text is a duplicate
  const HEAD_LIMIT = 160;
  const isAccountError = (t) => looksLikeUsageLimit(t) || /failed to authenticate|oauth access token/i.test(t);
  const flushHead = () => {
    if (!head) return;
    send("delta", { text: head });
    fullText += head;
    sentContent = true;
    head = "";
  };

  const finish = (payload) => {
    if (finished) return;
    finished = true;
    clearTimeout(sessionBudget);
    clearTimeout(resultGrace);
    clearInterval(heartbeat);
    if (payload?.error) send("error", { message: payload.error, ...(payload.resumable ? { resumable: true } : {}) });
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
  // The turn is over once its result came, whatever the CLI does next: it is
  // given a moment to exit, then stopped, and the reply ends as a success.
  let resultGrace = null;
  const endAfterResult = () => {
    stopChild();
    finish();
  };
  const sessionBudget = setTimeout(() => {
    // Never a partial usage nor « resumable » on a turn that has its result.
    if (meter.settled) { endAfterResult(); return; }
    sendLiveUsage();
    stopChild();
    // With a session the work is not lost: the transcript and the workspace
    // stay, and the chat surfaces relaunch the turn by themselves (resumable).
    finish({
      error: sessionKey
        ? "La tâche est longue et n'est pas terminée. Le travail déjà fait est conservé : écrivez « continue » pour la poursuivre."
        : "La demande a pris trop de temps pour aboutir en une fois. Relancez-la, ou découpez-la en étapes plus courtes.",
      resumable: !!sessionKey,
    });
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
        if (useHq) {
          const hq = (event.mcp_servers || []).filter((m) => HQ_INIT_NAMES.has(m.name));
          const ok = hq.some((m) => m.status === "connected");
          if (!ok) console.error(`[chat] hq indisponible (jeton HQ refusé ?) — ${hq.map((m) => `${m.name}=${m.status}`).join(", ") || "absent"}`);
        }
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
          sawDelta = true;
          if (!sentContent) {
            head += e.delta.text;
            if (!isAccountError(head) && head.length >= HEAD_LIMIT) flushHead();
          } else {
            send("delta", { text: e.delta.text });
            fullText += e.delta.text;
          }
        }
        // What the model is doing between two visible events, so the chat
        // can say it is alive: thinking, writing, or preparing a tool call
        // (a long script is streamed for a while before the call is sent).
        if (meter.onStreamEvent(e)) sendLiveUsage();
        if (e?.type === "message_start") {
          send("activity", { phase: "thinking" });
        } else if (e?.type === "content_block_start") {
          const kind = e.content_block?.type;
          if (kind === "tool_use") {
            // The sentence announcing the work must not wait for the end.
            if (head && !isAccountError(head)) flushHead();
            send("activity", { phase: "tool", name: e.content_block.name });
          } else if (kind === "thinking") {
            send("activity", { phase: "thinking" });
          } else if (kind === "text") {
            send("activity", { phase: "writing" });
          }
        }
        continue; // message_stop, thinking_delta, input_json_delta… are noise here
      }

      // Assistant message (may contain tool_use blocks); text fallback only
      // when no deltas were streamed (older CLI versions).
      if (event.type === "assistant" && event.message?.content) {
        let sentFallbackText = false;
        for (const block of event.message.content) {
          if (block.type === "tool_use") {
            if (head && !isAccountError(head)) flushHead();
            send("tool_call", { id: block.id, name: block.name, input: block.input });
          } else if (block.type === "text" && block.text && !sentContent && !sawDelta) {
            head += block.text;
            if (!isAccountError(head)) flushHead();
            sentFallbackText = true;
          }
        }
        if (sentFallbackText && !head) sentContent = true;
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
        // A pool account whose token is refused (revoked, expired) is treated
        // like a dry one: parked for a while, the turn relaunched elsewhere.
        const authFailed = !useBedrock && account !== maxAccounts.HOST_ACCOUNT && event.is_error && /failed to authenticate|oauth access token|401/i.test(String(event.result || ""));
        const accountError = !useBedrock && event.is_error && (looksLikeUsageLimit(event.result) || authFailed);
        if (!accountError) flushHead(); else head = "";
        if (accountError) {
          // This account just ran dry: mark it, and relaunch the turn on
          // another account (or Bedrock) if nothing has been sent yet.
          void accountMonitor?.markExhausted(authFailed ? `jeton refusé : ${String(event.result).slice(0, 120)}` : event.result);
          const nextExclude = [...excludedAccounts, account];
          const alternative = maxAccounts.pickForStaff({ preferred: preferredAccount, exclude: nextExclude, onlyAnswering: true });
          if (!sentContent && alternative) {
            console.log(`[chat] compte ${account} saturé — relance sur ${alternative}`);
            retrying = true;
            finished = true;
            clearTimeout(sessionBudget);
            clearInterval(heartbeat);
            cleanupScopedMcp();
            // Most refusals come before anything was consumed; when this
            // attempt did consume, its tokens and cost go with the turn.
            const wasted = meter.settle(event);
            if (sessionKey && sessions[sessionKey]?.id === sessionId) {
              Object.assign(sessions[sessionKey], meter.sessionFields());
              saveSessions();
            }
            const consumed = wasted.cost > 0 || Object.values(wasted.tokens).some((n) => n > 0);
            if (consumed) console.error(`[usage] ${sessionKey ?? "sans session"} : tentative sur le compte ${account} refusée après consommation (${JSON.stringify(wasted.tokens)}, coût ${wasted.cost}) — reportée sur le tour relancé`);
            const nextCarried = consumed
              ? {
                  tokens: carried ? addTokens(carried.tokens, wasted.tokens) : wasted.tokens,
                  cost: roundUsd((carried ? carried.cost : 0) + wasted.cost),
                  attempts: [...(carried ? carried.attempts : []), { account, model, tokens: wasted.tokens, cost: wasted.cost }],
                }
              : carried;
            handleChat(messages, allowedServers, accountScope, res, systemPromptOverride, budgetMs, dataScope, provider, { ...options, excludeAccounts: nextExclude, resendContext: true, lock, carried: nextCarried })
              .catch((err) => {
                console.error("[chat] échec de la relance:", err.message || err);
                failChat(res, "La relance sur un autre compte a échoué. Renvoyez votre message.");
              });
            continue;
          }
          if (alternative) {
            send("error", { message: `Compte Claude Max « ${maxAccounts.labelOf(account)} » saturé — relancez votre demande, elle partira sur un autre compte.` });
          } else {
            const reset = maxAccounts.nextReset();
            const at = reset ? new Date(reset).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Paris" }) : null;
            send("error", { message: `Tous les comptes Claude Max de l'agence sont saturés${at ? ` — le premier se libère vers ${at}` : ""}. Réessayez à ce moment-là.` });
          }
        }
        if (event.result && !sentContent) {
          send("content", { text: event.result });
          fullText = event.result;
        }
        // This turn only (billing ledger): on a resumed session the CLI's
        // own totals run since the first turn.
        const spent = meter.settle(event);
        const tokens = carried ? addTokens(spent.tokens, carried.tokens) : spent.tokens;
        if (sessionKey && sessions[sessionKey]?.id === sessionId) {
          Object.assign(sessions[sessionKey], meter.sessionFields());
          saveSessions();
        }
        // The turn has ended: the time budget has nothing left to cut.
        clearTimeout(sessionBudget);
        if (!finished) resultGrace = setTimeout(endAfterResult, Math.max(0, Math.min(RESULT_GRACE_MS, startedAt + SESSION_BUDGET_MS - Date.now())));
        send("usage", {
          cost: carried ? roundUsd(spent.cost + carried.cost) : spent.cost,
          ...(spent.costEstimated ? { costEstimated: true } : {}),
          ...(carried ? { earlierAttempts: carried.attempts } : {}),
          turns: event.num_turns || 0,
          duration: event.duration_ms || 0,
          provider: useBedrock ? "bedrock" : "subscription",
          account: useBedrock ? null : account,
          fallback,
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
    if (t && !useBedrock && looksLikeUsageLimit(t)) void accountMonitor?.markExhausted(t);
  });

  child.on("close", (code) => {
    cleanupScopedMcp();
    if (retrying) return; // the relaunched attempt owns the response now, and the lock
    lock?.release();
    console.log(`[chat] Exit code ${code}, text length: ${fullText.length}`);
    if (code !== 0 && !fullText && sessionKey && !stoppedByRelay) {
      // A transcript the CLI could not resume (or a crashed first turn) must
      // not poison the conversation: the next turn starts a fresh session.
      forgetSession(sessionKey);
    }
    finish(code !== 0 && !fullText ? { error: `Claude exited with code ${code}` } : undefined);
  });

  child.on("error", (err) => {
    cleanupScopedMcp();
    if (!retrying) lock?.release();
    console.error("[chat] Spawn error:", err);
    finish({ error: err.message });
  });

  // Client disconnect → kill subprocess
  res.on("close", () => {
    clearTimeout(sessionBudget);
    clearTimeout(resultGrace);
    clearInterval(heartbeat);
    if (retrying) return; // the response is the relaunched attempt's
    if (stopChild()) console.log("[chat] Client disconnected, killed child");
  });
}

// ── Tool input conventions ──────────────────────────────────────────────────
// n8n exposes two shapes depending on the node behind a tool:
//   - retired "HTTP Request Tool" (Meta today): ONE property `input` holding a
//     stringified JSON object of the real parameters;
//   - modern HTTP Request node used as a tool (Google Ads since 2026-09-22):
//     the real parameters as typed properties.
// Callers in the app were written against the first shape. The relay adapts
// either way from the tool's schema, so a node migration never breaks a widget.
/**
 * TikTok on /api/tool: the same reading as in a chat (server/mcp-tiktok-args.mjs)
 * — only the parameters the tool declares leave, each one checked, and a
 * report names exactly one advertiser. Returns { input } or { error }.
 */
export function tiktokDirectInput(name, input) {
  const prepared = prepareTikTokArgs(name, input ?? {}, { legacy: true });
  if (prepared.error) return { error: prepared.error };
  const named = accountsOfTikTokCall(name, prepared.object);
  if (named.error) return { error: named.error };
  return { input: prepared.args };
}

async function adaptToolInput(toolName, input) {
  const firstDot = toolName.indexOf(".");
  const server = toolName.slice(0, firstDot);
  const name = toolName.slice(firstDot + 1);
  const meta = (await getToolsList()).find((t) => t.server === server && t.name === name);
  if (!meta) return input;
  const isLegacyShape = input && typeof input === "object" && typeof input.input === "string" && Object.keys(input).length === 1;
  if (meta.legacyInput && !isLegacyShape) {
    return { input: JSON.stringify(input ?? {}) };
  }
  if (!meta.legacyInput && isLegacyShape) {
    try { return JSON.parse(input.input || "{}"); } catch { return {}; }
  }
  return input;
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
      // Tool name format is "<server>.<tool>" for mcporter. Server AND tool
      // must be listed in DIRECT_TOOL_ALLOWLIST (read tools only). HQ, gws,
      // Notion, the sandbox and client-data are chat-only: they are not in it.
      const refusal = directToolRefusal(body.tool);
      if (refusal) {
        console.error(`[tool] refus ${String(body.tool).slice(0, 120)}`);
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: refusal }));
        return;
      }
      // Callers may raise the timeout for slow n8n-backed tools (capped at 30s).
      const timeoutMs = Math.min(30000, Math.max(2000, Number(body.timeoutMs) || 20000));
      let toolInput;
      if (String(body.tool).startsWith(`${TIKTOK_SERVER}.`)) {
        const direct = tiktokDirectInput(String(body.tool).slice(TIKTOK_SERVER.length + 1), body.input || {});
        if (direct.error) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: direct.error }));
          return;
        }
        toolInput = direct.input;
      } else {
        toolInput = await adaptToolInput(String(body.tool), body.input || {});
      }
      // MCP backends (n8n) fail transiently; one retry absorbs most blips.
      // stdout goes to a temp FILE, not a pipe: mcporter exits without
      // flushing async pipe writes, which truncates large outputs (>~128KB)
      // and made big accounts 502 on every call. File writes are synchronous.
      const call = () => new Promise((resolve, reject) => {
        const tmp = path.join(os.tmpdir(), `mcporter-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.out`);
        const fd = fs.openSync(tmp, "w");
        const cleanup = () => { try { fs.unlinkSync(tmp); } catch { /* already gone */ } };
        // "error" (mcporter introuvable) est suivi de "close" : fermer deux fois
        // le descripteur levait une exception hors de la promesse, et le relay tombait.
        let open = true;
        const closeFd = () => { if (open) { open = false; fs.closeSync(fd); } };
        const child = spawn(
          "mcporter", ["call", body.tool, "--args", JSON.stringify(toolInput), "--output", "json"],
          { cwd: "/root/ImpulseMotion", stdio: ["ignore", fd, "pipe"], timeout: timeoutMs }
        );
        let stderr = "";
        child.stderr.on("data", (c) => { stderr += c; });
        child.on("error", (err) => { closeFd(); cleanup(); reject(err); });
        child.on("close", (code, signal) => {
          closeFd();
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

    // Google Sheets without AI, for the routines: read, append, update by
    // column name (server/sheets-direct.mjs), as data@impulse-analytics.com.
    const sheetsMatch = url.pathname.match(/^\/api\/sheets\/(read|append|update)$/);
    if (sheetsMatch && req.method === "POST") {
      if (!authorized(req)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      let body;
      try { body = await readBody(req); }
      catch { body = null; }
      const out = await handleSheetsRequest(sheetsMatch[1], body, {
        getToken: async () => (await gwsAuth.getAccessToken()).token,
      });
      // Counts only: never a cell value in the logs.
      const size = out.json.result?.rows?.length ?? out.json.result?.appendedRows ?? out.json.result?.updatedCells ?? 0;
      console.log(`[sheets] ${sheetsMatch[1]} ${String(body?.spreadsheetId ?? "").slice(0, 8)}… → ${out.status}${out.status === 200 ? ` (${size})` : ` ${out.json.class}: ${out.json.error}`}`);
      res.writeHead(out.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(out.json));
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
        account: body.account,
        clientBot: body.clientBot === true,
        turnContext: body.turnContext,
        hqGuidance: body.hqGuidance,
      }).catch((err) => {
        console.error("[chat] échec avant lancement:", err.message || err);
        failChat(res, "La demande n'a pas pu être lancée (erreur interne du relay). Réessayez ; si l'erreur persiste, prévenez un administrateur.");
      });
      return;
    }

    // Workspace files: GET /api/files/<ws>/<out|uploads>/<name> streams a
    // file; POST /api/files/<ws> { name, data(base64) } stores a consultant
    // upload in uploads/; GET /api/files/<ws> lists both folders.
    const filesMatch = url.pathname.match(/^\/api\/files\/([a-f0-9]{24})(?:\/(.+))?$/);
    if (filesMatch) {
      if (!authorized(req)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      const wsId = filesMatch[1];
      let rel = null;
      try { rel = filesMatch[2] ? decodeURIComponent(filesMatch[2]) : null; } catch { res.writeHead(400); res.end("bad path"); return; }
      if (req.method === "GET" && rel) {
        if (!WORKSPACE_PATH_RE.test(rel)) { res.writeHead(400); res.end("bad path"); return; }
        // Links are refused, and the descriptor checked is the one streamed.
        let file;
        try { file = openWorkspaceFile(wsId, rel); }
        catch (e) {
          if (e.code !== "ENOENT") console.error(`[files] refusé ${wsId}/${rel} : ${e.code || e.message}`);
          res.writeHead(404); res.end("not found"); return;
        }
        res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": String(file.size), "Cache-Control": "private, max-age=300" });
        const stream = fs.createReadStream("", { fd: file.fd, start: 0, end: Math.max(file.size - 1, 0), autoClose: true });
        stream.on("error", () => res.destroy());
        if (file.size === 0) { stream.destroy(); res.end(); } else stream.pipe(res);
        return;
      }
      if (req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ files: listWorkspaceFiles(wsId) }));
        return;
      }
      if (req.method === "POST" && !rel) {
        const body = await readBody(req);
        const name = typeof body?.name === "string" ? body.name.replace(/[^A-Za-z0-9._ \-()]/g, "_").slice(0, 120) : "";
        if (!name || name.startsWith(".") || typeof body?.data !== "string") { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "name/data requis" })); return; }
        const buf = Buffer.from(body.data, "base64");
        if (!buf.length || buf.length > UPLOAD_MAX_BYTES) { res.writeHead(413, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "fichier vide ou > 25 Mo" })); return; }
        try { fs.mkdirSync(WORKSPACES_DIR, { recursive: true }); writeWorkspaceUpload(wsId, name, buf); }
        catch (e) {
          console.error(`[files] dépôt refusé ${wsId}/uploads/${name} : ${e.code || e.message}`);
          res.writeHead(409, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "dépôt impossible dans ce workspace" })); return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ path: `uploads/${name}`, bytes: buf.length }));
        return;
      }
      res.writeHead(405); res.end();
      return;
    }

    // Mémoire client : ajoute une entrée datée au journal du projet HQ du
    // client. Écriture faite par le code (pas par le modèle), bearer du relay.
    if (url.pathname === "/api/hq/journal" && req.method === "POST") {
      if (!authorized(req)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      const body = await readBody(req);
      const project = typeof body?.project === "string" && /^[a-z0-9][a-z0-9-]{0,79}$/.test(body.project) ? body.project : null;
      const slug = typeof body?.slug === "string" ? body.slug.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) : "";
      const content = typeof body?.content === "string" ? body.content.slice(0, 40_000) : "";
      const company = typeof body?.company === "string" && /^[a-z0-9-]{1,60}$/.test(body.company) ? body.company : (process.env.HQ_COMPANY || "impulse-analytics");
      if (!project || !slug || !content.trim()) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "project, slug et content requis" }));
        return;
      }
      try {
        const text = await hqToolCall("hq_project_journal_append", { company, project, slug, content });
        console.log(`[hq] journal ${company}/${project} ← ${slug}`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, result: text.slice(0, 500) }));
      } catch (e) {
        console.error("[hq] journal échec:", e.message);
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    // Liste des projets HQ (pour choisir le dossier d'une note), cache 10 min.
    if (url.pathname === "/api/hq/projects" && req.method === "GET") {
      if (!authorized(req)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      try {
        if (!hqProjectsCache || hqProjectsCache.at < Date.now() - 10 * 60 * 1000) {
          const company = process.env.HQ_COMPANY || "impulse-analytics";
          const raw = await hqToolCall("hq_projects_list", { company });
          let list = [];
          try { list = JSON.parse(raw); } catch { list = []; }
          hqProjectsCache = {
            at: Date.now(),
            projects: (Array.isArray(list) ? list : []).map((p) => ({ slug: String(p.slug ?? ""), name: String(p.name ?? p.slug ?? "") })).filter((p) => p.slug),
          };
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ projects: hqProjectsCache.projects }));
      } catch (e) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    // Pool de comptes Claude Max : liste (sans jetons), ajout, retrait.
    if (url.pathname === "/api/accounts") {
      if (!authorized(req)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      try {
        if (req.method === "GET") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ accounts: maxAccounts.snapshot(), fallbackEnabled: BEDROCK_FALLBACK }));
          return;
        }
        if (req.method === "POST") {
          const body = await readBody(req);
          const added = await maxAccounts.add({ label: body?.label, token: body?.token });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, account: added, accounts: maxAccounts.snapshot() }));
          return;
        }
        if (req.method === "DELETE") {
          const body = await readBody(req);
          maxAccounts.remove(String(body?.id ?? ""));
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, accounts: maxAccounts.snapshot() }));
          return;
        }
        res.writeHead(405); res.end();
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    if (url.pathname === "/api/quota" && req.method === "GET") {
      if (!authorized(req)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      const refresh = url.searchParams.get("refresh") === "1";
      const snap = refresh ? await quota.probe() : quota.snapshot();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ...snap, accounts: maxAccounts.snapshot(), fallbackEnabled: BEDROCK_FALLBACK, bedrockModel: BEDROCK_MODEL, subscriptionModel: CLAUDE_MODEL }));
      return;
    }

    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", capabilities: CAPABILITIES }));
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
