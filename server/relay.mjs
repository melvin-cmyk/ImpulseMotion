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
import { HOST_CREDENTIALS, startAuthWatch } from "./auth-watch.mjs";
import { hqToolCall } from "./hq-client.mjs";
import * as maxAccounts from "./max-accounts.mjs";
import * as voice from "./voice.mjs";
import * as adlib from "./adlib.mjs";
import * as gwsAuth from "./gws-auth.mjs";
import { handleSheetsRequest } from "./sheets-direct.mjs";
import { buildSystemPrompt, buildTurnPrompt, cliTokenEnv, createTurnMeter, promptLogExcerpt } from "./relay-prompt.mjs";
import { accountsOfTikTokCall, prepareTikTokArgs } from "./mcp-tiktok-args.mjs";
import * as agnes from "./agnes.mjs";
import * as fal from "./fal.mjs";
import * as jobs from "./jobs.mjs";
import * as sessionPool from "./sessions.mjs";
import * as figcraft from "./figcraft.mjs";
import * as drive from "./drive-direct.mjs";
import { timingSafeEqual } from "node:crypto";
let hqProjectsCache = null;

// Fichiers d'un dossier client HQ que l'app peut lire en direct : projects/{slug}/…
// et le registre clients.yaml (jamais settings/, secrets ni un chemin remontant).
const HQ_WRITABLE_FILES = ["brain/recherche/personas.md", "brain/contenu/statics-context.md"];
const HQ_PROJECT_FILE_RE = /^(projects\/[a-z0-9][a-z0-9-]{0,79}(\/[A-Za-z0-9._-]{1,80}){1,6}|clients\.yaml)$/;

/** « (customer_id=…) » / « (account_id=…) » for the tool log: the account targeted, nothing else. */
function toolTarget(tool, input) {
  try {
    const raw = input && typeof input.input === "string" ? JSON.parse(input.input) : input;
    const id = raw?.customer_id ?? raw?.customerId ?? raw?.account_id ?? raw?.accountId ?? raw?.advertiser_id;
    return id ? ` (${raw.customer_id || raw.customerId ? "customer_id" : raw.advertiser_id ? "advertiser_id" : "account_id"}=${String(id).slice(0, 40)})` : "";
  } catch { return ""; }
}

function parseHqJson(raw) {
  try { return JSON.parse(raw); } catch { return null; }
}

/** hq_files_read answers with JSON ({content}) or the raw text, depending on the bridge version. */
function hqFileText(raw) {
  const parsed = parseHqJson(raw);
  if (parsed && typeof parsed === "object") {
    if (typeof parsed.content === "string") return parsed.content;
    if (typeof parsed.text === "string") return parsed.text;
  }
  return String(raw ?? "");
}

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
// What the spawned CLI (and through it every stdio MCP server) inherits: the
// relay's environment minus the secrets only the relay needs. Each MCP server
// receives what it needs explicitly in its `env` (buildScopedMcpConfig).
const CHILD_ENV_DENY = new Set([
  "RELAY_SHARED_SECRET", "RELAY_SHARED_SECRET_PREVIOUS", "AGNES_API_KEY", "FAL_KEY",
  "N8N_ALERT_WEBHOOK_SECRET", "N8N_ALERT_WEBHOOK_URL", "N8N_MCP_TOKEN", "N8N_TOOLS_TOKEN",
  "DATA_DATABASE_URL", "DATABASE_URL", "HQ_CLIENT_SECRET",
  // FigCraft publish key: the relay creates and removes design files; the AI only gets a file's edit link.
  "FIGCRAFT_SERVER_URL",
]);
function childBaseEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!CHILD_ENV_DENY.has(k)) env[k] = v;
  return env;
}
// Bearer the n8n MCP servers (Meta, Google Ads, TikTok, GA4, Sheets, Notion,
// Merchant Center, Magento) require once their trigger nodes authenticate.
// Empty = the servers are still open (to be closed before the public beta).
const N8N_TOOLS_TOKEN = (process.env.N8N_TOOLS_TOKEN || "").trim();
const N8N_TOOLS_HOST = (process.env.N8N_TOOLS_HOST || "impulseai.app.n8n.cloud").trim();
function isN8nToolsUrl(url) {
  try { return new URL(url).hostname === N8N_TOOLS_HOST; } catch { return false; }
}
/** The config entry of an n8n server, with its bearer when one is configured. */
function withN8nAuth(entry) {
  if (!N8N_TOOLS_TOKEN || !entry?.url || !isN8nToolsUrl(entry.url)) return entry;
  return { ...entry, headers: { ...(entry.headers || {}), Authorization: `Bearer ${N8N_TOOLS_TOKEN}` } };
}
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
// FigCraft (server/figcraft.mjs, server/mcp-figcraft.mjs) : éditeur de design
// des consultants. Dans une conversation de design, l'IA rejoint le fichier
// partagé (lien d'édition porté par la requête) et y travaille en direct ;
// ses lectures/écritures de fichiers restent dans le workspace de la conversation.
const FIGCRAFT_SERVER = "figcraft";
const FIGCRAFT_MCP_SCRIPT = "/root/ImpulseMotion/server/mcp-figcraft.mjs";
// PhotoCraft (server/mcp-photocraft.mjs) : retouche d'images (Photoshop open
// source, même équipe que FigCraft), headless, sur les fichiers du workspace.
const PHOTOCRAFT_SERVER = "photocraft";
const PHOTOCRAFT_MCP_SCRIPT = "/root/ImpulseMotion/server/mcp-photocraft.mjs";
// Mo's hands (server/mcp-mo.mjs): the application's own tools (créas, génération, publication)
// run as the consultant speaking to Mo — the app names them in the request, the model never does.
const MO_SERVER = "mo";
const MO_MCP_SCRIPT = "/root/ImpulseMotion/server/mcp-mo.mjs";
const PHOTOCRAFT_CLI = process.env.PHOTOCRAFT_CLI || "/usr/local/bin/photocraft-cli";
function photocraftConfigured() { return fs.existsSync(PHOTOCRAFT_CLI); }
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
const CAPABILITIES = ["turnContext", "hqGuidance", "sheetsDirect", "toolAllowlist", "jobs", "figcraft", "photocraft", "voice", "adlib", "chatWarm"];
// Detached turns (jobs) hold no HTTP response open: they may run longer than
// a streamed one, up to this cap.
const DETACHED_MAX_BUDGET_MS = Number(process.env.RELAY_DETACHED_MAX_BUDGET_MS || 15 * 60 * 1000);
// Where the app is told a job is over (POST /api/ai/jobs/complete, bearer =
// the shared secret). Unset: the app finds out by reading the job itself.
const RELAY_APP_URL = process.env.RELAY_APP_URL || "";
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
// Google Merchant Center : serveur MCP n8n (« MCP Google Merchant Center »),
// compte Google de l'agence, lecture seule (register_gcp_developer, une
// écriture d'administration, reste fermé). Staff uniquement, comme Notion :
// un seul accès lit tous les comptes Merchant de l'agence.
const MERCHANT_SERVER = "mcp-merchant-center";
// Magento LPEV : serveur MCP n8n « MCP Magento LPEV » (lecture seule sur l'API
// REST de la boutique lpev.fr : commandes, produits, codes prescripteurs ;
// aucune donnée nominative). Un seul client, mais un accès de l'agence :
// staff uniquement, jamais un bot client (le bot LPEV a son entrepôt
// client-data). Liste fermée : un outil ajouté dans n8n reste fermé ici.
const MAGENTO_SERVER = "mcp-magento-lpev";
const MAGENTO_READ_TOOLS = ["lpev_orders_summary", "lpev_orders_list", "lpev_order_get", "lpev_products_top", "lpev_prescripteurs"];
// n8n de l'agence : le serveur MCP intégré de l'instance (Settings → MCP access),
// déclaré par le relay avec un jeton d'accès (N8N_MCP_TOKEN, env du service).
// Le consultant fait construire ses automatisations par l'IA (import d'un
// rapport dans un Google Sheet, export CRM, calcul planifié…) pour alimenter
// ses dashboards. Un seul accès voit tous les flux de l'agence : staff
// uniquement, jamais un bot client. Tout est ouvert sauf ce qui casse ou
// efface l'existant (N8N_DENIED_TOOL_PATTERNS) : dépublier, archiver,
// supprimer, restaurer une version par-dessus l'actuelle.
const N8N_SERVER = "n8n";
const N8N_MCP_URL = process.env.N8N_MCP_URL || "https://impulseai.app.n8n.cloud/mcp-server/http";
const N8N_MCP_TOKEN = (process.env.N8N_MCP_TOKEN || "").trim();
const N8N_DENIED_TOOL_PATTERNS = ["unpublish_*", "archive_*", "delete_*", "restore_*", "remove_*"].map((t) => `mcp__${N8N_SERVER}__${t}`);
function n8nLocalEntry(token) {
  return { type: "http", url: N8N_MCP_URL, headers: { Authorization: `Bearer ${token}` } };
}
const MERCHANT_READ_TOOLS = [
  "list_merchant_accounts", "list_subaccounts", "list_products", "get_product",
  "get_account_issues", "list_data_sources", "search_reports",
];
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
  MERCHANT_SERVER,
  MAGENTO_SERVER,
  N8N_SERVER,
  FIGCRAFT_SERVER,
  PHOTOCRAFT_SERVER,
  MO_SERVER,
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
  [MERCHANT_SERVER]: MERCHANT_READ_TOOLS,
  [MAGENTO_SERVER]: MAGENTO_READ_TOOLS,
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
  // get_adgroups / get_ads: the structure of an advertiser for Pilotage (lib/pilot/tiktok.ts), read only.
  // search_ad_videos / search_ad_images: covers and image URLs of the creative warehouse (lib/ads-warehouse/tiktok.ts), read only.
  [TIKTOK_SERVER]: ["get_advertiser_info", "get_campaigns", "get_adgroups", "get_ads", "get_report_integrated", "list_business_centers", "list_bc_advertisers", "search_ad_videos", "search_ad_images"],
  // Merchant Center (lib/merchant-center.ts) : liste des comptes pour le
  // rattachement, puis diagnostics, statuts et performance produits des rapports.
  [MERCHANT_SERVER]: ["list_merchant_accounts", "list_subaccounts", "get_account_issues", "list_data_sources", "search_reports", "list_products"],
  // Magento LPEV : jeux de données des dashboards du staff (lecture seule).
  [MAGENTO_SERVER]: MAGENTO_READ_TOOLS,
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
// Expiring logins (Claude Max, HQ) are announced on Slack before they die, and
// HQ's refresh token is kept alive on a timer (server/auth-watch.mjs).
const authNotifier = makeWebhookNotifier({
  url: process.env.N8N_ALERT_WEBHOOK_URL,
  secret: process.env.N8N_ALERT_WEBHOOK_SECRET,
  slackChannel: process.env.RELAY_ALERT_SLACK_CHANNEL,
  appUrl: (process.env.APP_URL || "https://impulsemotion.vercel.app").replace(/\/$/, ""),
});
startAuthWatch({
  accounts: () => [{ id: maxAccounts.HOST_ACCOUNT, label: "compte serveur (bot@)", credentialsPath: HOST_CREDENTIALS }, ...maxAccounts.loginAccounts()],
  notify: authNotifier,
});

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

function buildScopedMcpConfig({ servers, clientKey, clientKeys = null, accountScope, ga4PropertyId, hqToken = null, n8nToken = null, workspaceDir = null, gwsAuthState = null, clientBot = false, dataTools = null, figcraftLink = null, photocraft = false, mo = null }) {
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
  if (n8nToken) { mcpServers[N8N_SERVER] = n8nLocalEntry(n8nToken); kept.push(N8N_SERVER); }

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
    if (name === FIGCRAFT_SERVER) {
      // The AI joins the conversation's design file; its file reads and writes
      // stay in the workspace (uploads/ read, out/ written: served by /api/files).
      if (!figcraftLink || !workspaceDir) continue;
      mcpServers[name] = {
        command: "node",
        args: [FIGCRAFT_MCP_SCRIPT],
        env: { FIGCRAFT_JOIN_LINK: figcraftLink, FIGCRAFT_CLI: figcraft.FIGCRAFT_CLI, WORKSPACE_DIR: workspaceDir },
      };
      kept.push(name);
      continue;
    }
    if (name === MO_SERVER) {
      // Mo's tools, pinned to the consultant and the board the app named.
      if (!mo) continue;
      mcpServers[name] = {
        command: "node",
        args: [MO_MCP_SCRIPT],
        env: { MO_TOOLS_URL: `${mo.appUrl}/api/mo/tools`, MO_TOKEN: RELAY_SHARED_SECRET, MO_USER: mo.userId, MO_BOARD: mo.boardId },
      };
      kept.push(name);
      continue;
    }
    if (name === PHOTOCRAFT_SERVER) {
      // Headless PhotoCraft on the conversation's workspace (uploads/ read, out/ written).
      if (!photocraft || !workspaceDir) continue;
      mcpServers[name] = {
        command: "node",
        args: [PHOTOCRAFT_MCP_SCRIPT],
        env: { PHOTOCRAFT_CLI, WORKSPACE_DIR: workspaceDir },
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
      // A client bot is pinned to its one key; a staff chat to the closed list
      // of clients whose warehouse is fed (the server then asks `client`).
      const keys = Array.isArray(clientKeys) && clientKeys.length ? clientKeys : clientKey ? [clientKey] : [];
      if (!keys.length || !dataUrl) {
        console.error("[chat] client-data désactivé (clientKey ou DATA_DATABASE_URL absent)");
        continue;
      }
      mcpServers[name] = {
        command: "node",
        args: [CLIENT_DATA_MCP_SCRIPT],
        // Tool families the bot may use (orders = e-commerce warehouse, datasets =
        // files of its Drive folder); the server exposes only those.
        env: { CLIENT_KEY: keys[0], CLIENT_KEYS: keys.join(","), DATA_DATABASE_URL: dataUrl, ...(dataTools ? { CLIENT_DATA_TOOLS: dataTools } : {}) },
      };
      kept.push(name);
      continue;
    }

    const pick = SCOPED_ADS_SERVERS[name];
    const upstream = baseServers[name];
    if (!pick || !upstream) {
      // Not a scopable server and not in the base config: nothing to serve.
      if (upstream) { mcpServers[name] = withN8nAuth(upstream); kept.push(name); }
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
        ...(N8N_TOOLS_TOKEN && isN8nToolsUrl(upstream.url) ? { SCOPED_UPSTREAM_TOKEN: N8N_TOOLS_TOKEN } : {}),
        SCOPED_ACCOUNTS: ids.join(","),
        ...(PROXY_PINNED_TOOLS.has(name) ? { SCOPED_TOOLS: (chatToolsOf(name, clientBot) || []).join(",") } : {}),
      },
    };
    kept.push(name);
  }

  const summary = kept.map((n) => {
    const e = mcpServers[n];
    if (e.args?.[0] === SCOPED_ADS_MCP_SCRIPT) return `${n}[${e.env.SCOPED_ACCOUNTS}]`;
    if (n === CLIENT_DATA_SERVER) return `${n}[${e.env.CLIENT_KEYS}]`;
    if (n === MO_SERVER) return `${n}[${e.env.MO_USER.slice(-6)}]`;
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
// How many CLI processes may run at once on this host (each one is a model
// call of several hundred MB): beyond, a new turn is refused at once rather
// than taking the whole relay down with it.
// Client questions (names, figures) stay out of journald unless asked for.
const RELAY_LOG_PROMPTS = process.env.RELAY_LOG_PROMPTS === "1";
const MAX_CONCURRENT_TURNS = Number(process.env.RELAY_MAX_CONCURRENT_TURNS || 6);
let activeTurns = 0;
const RELAY_BUSY_MESSAGE = "Le service IA est très sollicité en ce moment. Réessayez dans quelques instants.";

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
  // A relaunch (options.lock) replaces a turn that just ended: it is not a new one.
  if (!options.lock && activeTurns >= MAX_CONCURRENT_TURNS) {
    console.error(`[chat] tour refusé — ${activeTurns} tours déjà en cours (RELAY_MAX_CONCURRENT_TURNS=${MAX_CONCURRENT_TURNS})`);
    failChat(res, RELAY_BUSY_MESSAGE);
    return;
  }
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

/** The per-turn options a /api/chat body carries (shared with /api/chat/warm). */
function chatOptionsOf(body) {
  return {
    model: body.model,
    effort: body.effort,
    maxTurns: body.maxTurns,
    sessionKey: body.sessionKey,
    account: body.account,
    clientBot: body.clientBot === true,
    turnContext: body.turnContext,
    hqGuidance: body.hqGuidance,
    // Design conversation: { link } = the edit link of its FigCraft file.
    figcraft: body.figcraft,
    // Mo: { userId, boardId } = who speaks and on which board (server "mo").
    mo: body.mo,
  };
}

// ── Warm-up of a persistent conversation ────────────────────────────────────
// POST /api/chat/warm (or /api/chat with warmOnly: true): the same body as a
// turn without its messages. The process of the conversation is started now
// (scoped MCP config, system prompt, Max account chosen like for a turn) so
// the first turn finds it warm. Nothing is sent to the model.
async function handleWarm(body) {
  const sessionKey = typeof body.sessionKey === "string" && SESSION_KEY_RE.test(body.sessionKey) ? body.sessionKey : null;
  if (!sessionKey) return { status: 400, warm: false, created: false, reason: "sessionKey requise" };
  if (body.provider === "bedrock" || !sessionPool.persistentEnabled(sessionKey)) return { status: 200, warm: false, created: false, reason: "conversation non persistante" };
  if (sessionLocks.has(sessionKey)) return { status: 200, warm: false, created: false, reason: "un tour est en cours" };
  const lock = await acquireSessionLock(sessionKey);
  if (!lock) return { status: 200, warm: false, created: false, reason: "un tour est en cours" };
  // runChat writes nothing on a warm-up but its early refusals (failChat): swallowed here.
  const sink = { headersSent: true, writableEnded: false, flushHeaders() {}, writeHead() {}, write() { return true; }, end() { this.writableEnded = true; }, on() { return this; }, once() { return this; } };
  try {
    const out = await runChat([], body.allowedServers, body.accountScope, sink, body.systemPrompt, body.budgetMs, body.dataScope, body.provider, { ...chatOptionsOf(body), warmOnly: true });
    if (!out || typeof out !== "object") return { status: 200, warm: false, created: false, reason: "préparation refusée (voir le journal du relay)" };
    return { status: out.warm ? 202 : 200, ...out };
  } catch (err) {
    console.error(`[mo-session] ${sessionKey} : préchauffage en échec — ${err.message || err}`);
    return { status: 200, warm: false, created: false, reason: "erreur interne du relay" };
  } finally {
    lock.release();
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
  let accountMonitor = account ? maxAccounts.monitor(account) : null;
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
  // Staff chats (console, copilots) read the warehouses of several clients:
  // a closed list of keys set by the app, never by the model.
  const staffData = !!dataScope && typeof dataScope === "object" && dataScope.staff === true;
  const clientKeys = staffData && Array.isArray(dataScope.clientKeys)
    ? [...new Set(dataScope.clientKeys.filter((k) => typeof k === "string" && CLIENT_KEY_RE.test(k)))].slice(0, 50)
    : null;
  // Closed list of client-data tool families; absent → the server's default (both).
  const dataTools =
    dataScope && typeof dataScope === "object" && Array.isArray(dataScope.tools)
      ? dataScope.tools.filter((t) => t === "orders" || t === "datasets").join(",") || null
      : null;
  // HQ carries the agency owner's identity: never for a client bot (dataScope,
  // or an explicit `provider: "bedrock"` caller). A staff chat pushed onto
  // Bedrock by the quota fallback keeps HQ, through the host's local "hq"
  // server instead of the claude.ai connector. Pulled out of `servers` either
  // way — it has no entry in the mcp-config, the CLI gets it from the host.
  // `dataScope.staff` is set by the app's staff-only routes: it keeps HQ,
  // Notion, Magento and the web while still mounting the warehouse.
  const clientBot = (!!dataScope && !staffData) || provider === "bedrock" || options.clientBot === true;
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
  // Merchant Center: staff only too (one access reads every merchant of the agency).
  if (servers.includes(MERCHANT_SERVER) && clientBot) {
    servers = servers.filter((s) => s !== MERCHANT_SERVER);
    console.error("[chat] merchant center refusé — requête de bot client");
  }
  // Magento LPEV: staff only (orders of a client shop, read by the agency's access).
  if (servers.includes(MAGENTO_SERVER) && clientBot) {
    servers = servers.filter((s) => s !== MAGENTO_SERVER);
    console.error("[chat] magento lpev refusé — requête de bot client");
  }
  // n8n: staff only, and only with the instance token in the service env.
  let n8nToken = null;
  if (servers.includes(N8N_SERVER)) {
    if (clientBot) console.error("[chat] n8n refusé — requête de bot client");
    else if (!N8N_MCP_TOKEN) console.error("[chat] n8n indisponible — N8N_MCP_TOKEN absent de l'environnement du relay");
    else n8nToken = N8N_MCP_TOKEN;
    servers = servers.filter((s) => s !== N8N_SERVER);
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
  // FigCraft: staff only, for a named conversation whose request carries the
  // edit link of its design file (the app owns the link; the model never sees
  // the server key). The AI's files live in the same workspace as the sandbox.
  let figcraftLink = null;
  if (servers.includes(FIGCRAFT_SERVER)) {
    const link = options.figcraft && typeof options.figcraft === "object" && typeof options.figcraft.link === "string" ? figcraft.loopbackLink(options.figcraft.link) : null;
    if (clientBot || !sessionKey || !link || !figcraft.figcraftConfigured()) {
      servers = servers.filter((s) => s !== FIGCRAFT_SERVER);
      console.error(`[chat] figcraft retiré — ${clientBot ? "requête de bot client" : !sessionKey ? "conversation sans nom" : !link ? "lien de design absent ou invalide" : "FigCraft non configuré sur le relay"}`);
    } else {
      figcraftLink = link;
      if (!workspaceDir) {
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
  // PhotoCraft: staff only, named conversation (its workspace holds the files).
  let photocraftOn = false;
  if (servers.includes(PHOTOCRAFT_SERVER)) {
    if (clientBot || !sessionKey || !photocraftConfigured()) {
      servers = servers.filter((s) => s !== PHOTOCRAFT_SERVER);
      console.error(`[chat] photocraft retiré — ${clientBot ? "requête de bot client" : !sessionKey ? "conversation sans nom" : "photocraft-cli absent du relay"}`);
    } else {
      photocraftOn = true;
      if (!workspaceDir) {
        const wsId = workspaceIdFor(sessionKey);
        workspaceDir = path.join(WORKSPACES_DIR, wsId);
        try { for (const sub of ["uploads", "out"]) ensureWorkspaceDir(wsId, sub); } catch (e) { console.error(`[chat] workspace photocraft : ${e instanceof Error ? e.message : e}`); }
      }
    }
  }
  // Mo: staff only, and only when the app pinned the consultant and the board in the request.
  let moCtx = null;
  if (servers.includes(MO_SERVER)) {
    const m = options.mo;
    const idOk = (v) => typeof v === "string" && /^[A-Za-z0-9_-]{6,60}$/.test(v);
    const appUrl = (RELAY_APP_URL || process.env.APP_URL || "").replace(/\/$/, "");
    if (clientBot || !m || !idOk(m.userId) || !idOk(m.boardId) || !/^https?:\/\//.test(appUrl) || RELAY_SHARED_SECRET.length < 16) {
      servers = servers.filter((s) => s !== MO_SERVER);
      console.error(`[chat] mo retiré — ${clientBot ? "requête de bot client" : !m ? "contexte mo absent" : !appUrl ? "RELAY_APP_URL absent" : "contexte mo invalide"}`);
    } else moCtx = { userId: m.userId, boardId: m.boardId, appUrl };
  }
  const scopedMcp = buildScopedMcpConfig({ servers, clientKey, clientKeys, accountScope, ga4PropertyId, hqToken, n8nToken, workspaceDir, gwsAuthState, clientBot, dataTools, figcraftLink, photocraft: photocraftOn, mo: moCtx });
  if (scopedMcp) servers = scopedMcp.servers;
  const mcpConfigPath = scopedMcp ? scopedMcp.path : MCP_CONFIG;
  // A persistent process takes the file over for its whole life (below).
  let cleanupScopedMcp = () => scopedMcp?.cleanup();

  // Read-only tool allowlists: the GA4 MCP also exposes mutations
  // (create/update/archive custom dimensions, key events, retention…). No chat
  // caller — client bot or staff — may ever mutate a client property.
  const toolPatterns = servers.flatMap((s) => {
    const tools = chatToolsOf(s, clientBot);
    return tools ? tools.map((t) => `mcp__${s}__${t}`) : [`mcp__${s}__*`];
  });
  if (useHq) toolPatterns.push(...HQ_READ_TOOLS.map((t) => `${hqToolPrefix}${t}`));
  // n8n: everything the instance exposes, minus what breaks or erases existing flows (deny wins over allow).
  const deniedPatterns = n8nToken ? [...N8N_DENIED_TOOL_PATTERNS] : [];
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
    useN8n: !!n8nToken,
  });

  // Resume when the caller named a conversation that we already hold, whose
  // scope fingerprint is unchanged, and which is not being restarted (a
  // single-message thread = "nouvelle conversation"). Anything else starts a
  // fresh session, replaying whatever history the caller sent.
  const fingerprint = scopeFingerprint({ servers, toolPatterns, accountScope: accountScope ?? null, clientKey, ga4PropertyId, dataTools, useBedrock, model });
  // Persistent process (server/sessions.mjs): Mo's conversations keep their
  // CLI alive between turns; the user message then always travels on stdin.
  const persistent = !!sessionKey && !useBedrock && sessionPool.persistentEnabled(sessionKey);
  // Everything a warm process must share with this turn besides the session
  // id: the scope fingerprint, the system prompt, and the run parameters.
  const poolSignature = persistent ? scopeFingerprint({ fingerprint, systemPrompt: crypto.createHash("sha256").update(scopedSystemPrompt).digest("hex"), effort, maxTurns, useWeb }) : null;
  // Warm-up only (POST /api/chat/warm): the process is started for the next
  // turn, nothing is sent, and the stored session is left as it is.
  const warmOnly = options.warmOnly === true;
  const existing = sessionKey ? sessions[sessionKey] : null;
  const resumable = !!existing && existing.fingerprint === fingerprint && fs.existsSync(transcriptPath(existing.id));
  const canResume = resumable && messages.length > 1;
  if (sessionKey && existing && !canResume && !warmOnly) forgetSession(sessionKey);
  // A process pre-warmed for this conversation was started on a fresh id: the
  // first turn adopts that id instead of drawing one (else the warm-up is lost).
  const prewarmedId = persistent && !canResume ? sessionPool.freshSessionId(sessionKey, poolSignature) : null;
  const sessionId = warmOnly
    ? (resumable ? existing.id : (prewarmedId ?? crypto.randomUUID()))
    : canResume ? existing.id : (sessionKey ? (prewarmedId ?? crypto.randomUUID()) : null);
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
  if (sessionKey && !warmOnly) {
    sessions[sessionKey] = { id: sessionId, fingerprint, updatedAt: Date.now(), ...(turn.contextHash ? { contextHash: turn.contextHash } : {}), ...meter.sessionFields() };
    saveSessions();
  }

  const accountOk = (id) => !excludedAccounts.includes(id) && !!maxAccounts.monitor(id) && !maxAccounts.monitor(id).exhausted();
  if (persistent) {
    // A warm process answers with the account it was started on.
    const warm = sessionPool.warmAccount({ key: sessionKey, sessionId, signature: poolSignature, accountOk });
    if (warm && warm !== account) { account = warm; accountMonitor = maxAccounts.monitor(account); }
  }
  const promptOnStdin = persistent || promptImages.length > 0;
  // One-shot calls leave nothing on disk; named conversations persist so
  // the next turn can --resume them.
  const sessionArgs = sessionKey ? (canResume ? ["--resume", sessionId] : ["--session-id", sessionId]) : ["--no-session-persistence"];

  const args = [
    // With images (or a persistent process) the prompt travels on stdin as content blocks instead.
    ...(promptOnStdin ? ["--print", "--input-format", "stream-json"] : ["--print", prompt]),
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
    if (deniedPatterns.length > 0) args.push("--disallowedTools", ...deniedPatterns);
  } else {
    args.push("--disallowedTools", "mcp__*");
  }

  // Dedicated empty cwd: keeps the spawned CLI away from any project
  // CLAUDE.md/hooks that would inject non-deterministic context.
  const spawnOptions = {
    cwd: RELAY_CLAUDE_CWD,
    env: {
      ...childBaseEnv(),
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
  };
  // Persistent conversation: the turn runs on the warm process of this key
  // (or starts it); the handle reads like a ChildProcess. A full pool means
  // this turn runs one-shot, as before.
  if (warmOnly) {
    if (!persistent) { scopedMcp?.cleanup(); return { warm: false, created: false, reason: "conversation non persistante" }; }
    return sessionPool.warm({ key: sessionKey, sessionId, signature: poolSignature, account, accountOk, args, spawnOptions, transcriptPath: transcriptPath(sessionId), mcpCleanup: () => scopedMcp?.cleanup() });
  }
  const pooled = persistent
    ? sessionPool.acquire({ key: sessionKey, sessionId, signature: poolSignature, account, accountOk, args, spawnOptions, transcriptPath: transcriptPath(sessionId), mcpCleanup: () => scopedMcp?.cleanup() })
    : null;
  if (pooled) cleanupScopedMcp = () => {};
  const child = pooled ? pooled.child : spawn("claude", [...args, ...sessionArgs], spawnOptions);
  console.log(`[chat] Prompt: "${RELAY_LOG_PROMPTS ? promptLogExcerpt(lastUser?.content ?? prompt) : `${String(lastUser?.content ?? prompt).length} car.`}"${turn.contextSent ? ` | contexte=${turn.contextChars}c${turn.contextTruncated ? " (tronqué)" : ""}` : ""} | model=${model}${effort ? `/${effort}` : ""}${sessionKey ? ` | session=${canResume ? "resume" : "new"}${pooled ? (pooled.warm ? " (warm)" : " (persistant, démarrage)") : ""}` : ""}${useHq ? " | hq" : ""}${servers.includes(NOTION_SERVER) ? " | notion" : ""}${servers.includes(MERCHANT_SERVER) ? " | merchant" : ""}${servers.includes(MAGENTO_SERVER) ? " | magento" : ""}${n8nToken ? " | n8n" : ""}${useWeb ? " | web" : ""}${gwsAuthState ? ` | gws${gwsAuthState.token ? "" : " (sans jeton)"}` : ""}${scopedMcp && (clientKeys?.length || clientKey) ? ` | client-data=${clientKeys?.length ? clientKeys.join(",") : clientKey}` : ""}${useBedrock ? ` | bedrock@${BEDROCK_REGION}${fallback ? " (fallback quota)" : ""}` : ` | compte=${account}`}`);
  if (promptImages.length) {
    const content = [{ type: "text", text: prompt }];
    for (const im of promptImages) {
      content.push({ type: "text", text: `[Image jointe par le consultant au message ${im.index}${im.name ? ` : ${String(im.name).slice(0, 80)}` : ""}]` });
      content.push({ type: "image", source: { type: "base64", media_type: im.mediaType, data: im.data } });
    }
    child.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n");
  } else if (promptOnStdin) {
    child.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: prompt } }) + "\n");
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
  // A detached turn (job) is read from its log, not from a response the
  // app's serverless function holds open: it may run up to DETACHED_MAX_BUDGET_MS.
  const MAX_BUDGET_MS = options.detached ? DETACHED_MAX_BUDGET_MS : Number(process.env.RELAY_CHAT_MAX_BUDGET_MS || 280_000);
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

  activeTurns += 1;
  let counted = true;
  const uncount = () => { if (counted) { counted = false; activeTurns -= 1; } };
  child.on("close", (code) => {
    uncount();
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
    uncount();
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

// RELAY_SHARED_SECRET_PREVIOUS: accepted only while a new secret is rolled out (Vercel redeploying), then removed.
const PREVIOUS_SECRET = process.env.RELAY_SHARED_SECRET_PREVIOUS || "";
const ACCEPTED_SECRETS = [RELAY_SHARED_SECRET, ...(PREVIOUS_SECRET.length >= 16 ? [PREVIOUS_SECRET] : [])].map((s) => Buffer.from(s));

// A detached turn is over: logged, and the app is told (when RELAY_APP_URL is set).
const jobFinished = (() => {
  const notify = jobs.makeFinishedNotifier({ appUrl: RELAY_APP_URL, secret: RELAY_SHARED_SECRET });
  if (!notify) console.log("[jobs] RELAY_APP_URL absent : l'app relira les tâches elle-même");
  return (job) => {
    console.log(`[jobs] ${job.id} ${job.status} en ${Math.round(((job.finishedAt ?? Date.now()) - job.createdAt) / 1000)} s, ${job.text.length} car.${job.error ? ` — ${job.error.slice(0, 120)}` : ""}`);
    if (notify) void notify(job);
  };
})();

function authorized(req) {
  const h = req.headers.authorization || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) return false;
  const given = Buffer.from(m[1]);
  // Constant-time comparison: the secret cannot be guessed byte by byte from response times.
  return ACCEPTED_SECRETS.some((s) => s.length === given.length && timingSafeEqual(s, given));
}

// A JSON body is read whole into memory: bounded, so a caller holding the
// secret (or a looping cron) cannot fill the host. Uploads get a larger cap.
const BODY_MAX_BYTES = Number(process.env.RELAY_MAX_BODY_BYTES || 16 * 1024 * 1024);
const UPLOAD_BODY_MAX_BYTES = Math.ceil(UPLOAD_MAX_BYTES * 4 / 3) + 64 * 1024; // base64 of a full upload
class BodyTooLarge extends Error { constructor() { super("body too large"); this.status = 413; } }
/** Raw bytes of a request (audio uploads), capped. */
function readRawBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"] || 0);
    if (declared > maxBytes) { req.resume(); reject(new BodyTooLarge()); return; }
    const chunks = [];
    let total = 0;
    req.on("data", (c) => { total += c.length; if (total > maxBytes) { req.destroy(); reject(new BodyTooLarge()); return; } chunks.push(c); });
    req.on("end", () => { if (total <= maxBytes) resolve(Buffer.concat(chunks)); });
    req.on("error", reject);
  });
}

function readBody(req, maxBytes = BODY_MAX_BYTES) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"] || 0);
    if (declared > maxBytes) { req.resume(); reject(new BodyTooLarge()); return; }
    const chunks = [];
    let total = 0;
    req.on("data", (c) => {
      total += c.length;
      if (total > maxBytes) { req.destroy(); reject(new BodyTooLarge()); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      if (total > maxBytes) return;
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
            console.error(`[tool] ${body.tool} attempt ${attempt} failed: ${toolError.slice(0, 200)}${toolTarget(body.tool, toolInput)}`);
            // A refused access will not change on retry: answer at once.
            if (/does not have permission|Forbidden|PERMISSION_DENIED|USER_PERMISSION_DENIED/i.test(toolError)) break;
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

    if ((url.pathname === "/api/chat/warm" || url.pathname === "/api/chat") && req.method === "POST") {
      if (!authorized(req)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      const body = await readBody(req);
      if (url.pathname === "/api/chat/warm" || body.warmOnly === true) {
        const { status, ...out } = await handleWarm(body);
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(out));
        return;
      }
      if (!body.messages?.length) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "messages required" }));
        return;
      }
      const chatOptions = chatOptionsOf(body);
      // Detached turn: the CLI writes into a job log the caller reads back
      // (GET /api/jobs/:id); the answer here is only the job id. Closing a
      // reader never stops the turn — only POST /api/jobs/:id/stop does.
      if (body.detach === true) {
        const job = jobs.createJob({
          meta: { sessionKey: typeof body.sessionKey === "string" ? body.sessionKey.slice(0, 200) : null, ...(body.jobMeta && typeof body.jobMeta === "object" ? { app: body.jobMeta } : {}) },
          onFinished: jobFinished,
        });
        res.writeHead(202, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jobId: job.id }));
        console.log(`[jobs] ${job.id} lancé (${job.meta.sessionKey ?? "sans session"})`);
        handleChat(body.messages, body.allowedServers, body.accountScope, job.sink, body.systemPrompt, body.budgetMs, body.dataScope, body.provider, { ...chatOptions, detached: true })
          .catch((err) => {
            console.error(`[jobs] ${job.id} échec avant lancement:`, err.message || err);
            failChat(job.sink, "La demande n'a pas pu être lancée (erreur interne du relay). Réessayez ; si l'erreur persiste, prévenez un administrateur.");
          });
        return;
      }
      handleChat(body.messages, body.allowedServers, body.accountScope, res, body.systemPrompt, body.budgetMs, body.dataScope, body.provider, chatOptions).catch((err) => {
        console.error("[chat] échec avant lancement:", err.message || err);
        failChat(res, "La demande n'a pas pu être lancée (erreur interne du relay). Réessayez ; si l'erreur persiste, prévenez un administrateur.");
      });
      return;
    }

    // Detached turns: GET /api/jobs/:id?after=N replays the log past N then
    // follows it (SSE, same events as /api/chat, each with a `seq`); GET
    // /api/jobs/:id/state is the summary; POST /api/jobs/:id/stop ends it.
    const jobMatch = url.pathname.match(/^\/api\/jobs\/([a-f0-9]{32})(?:\/(state|stop))?$/);
    if (jobMatch) {
      if (!authorized(req)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      const job = jobs.getJob(jobMatch[1]);
      if (!job) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "job not found" }));
        return;
      }
      const sub = jobMatch[2];
      if (sub === "state" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ job: job.state() }));
        return;
      }
      if (sub === "stop" && req.method === "POST") {
        const stopped = job.stop();
        console.log(`[jobs] ${job.id} : arrêt demandé${stopped ? "" : " (déjà terminé)"}`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, stopped, status: job.status }));
        return;
      }
      if (!sub && req.method === "GET") {
        const after = Number(url.searchParams.get("after") || 0);
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.flushHeaders?.();
        res.write(`: job ${job.id} ${job.status}\n\n`);
        const heartbeat = setInterval(() => { try { res.write(": hb\n\n"); } catch { /* closed */ } }, 15_000);
        const unsubscribe = job.subscribe(after, (seq, line) => {
          if (seq === null) { clearInterval(heartbeat); res.end(); return; }
          res.write(`data: ${line}\n\n`);
        });
        res.on("close", () => { clearInterval(heartbeat); unsubscribe(); });
        return;
      }
      res.writeHead(405); res.end();
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
        const body = await readBody(req, UPLOAD_BODY_MAX_BYTES);
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
    // ── Studio créa : génération d'images et de vidéos (Agnes AI, server/agnes.mjs) ──
    // Signed, short-lived links to relay media (no bearer: Agnes and the app fetch them).
    if (url.pathname.startsWith("/media/") && req.method === "GET") {
      agnes.serveMedia(req, res, url);
      return;
    }
    // ── Bibliothèque publicitaire Meta (server/adlib.mjs) : pubs des concurrents lues sur la page publique ──
    if (url.pathname === "/api/adlib/search" && req.method === "GET") {
      const reply = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
      if (!authorized(req)) return reply(401, { error: "unauthorized" });
      if (!adlib.adLibraryConfigured()) return reply(503, { error: "bibliothèque Meta non configurée sur le relay" });
      try {
        const out = await adlib.searchAdLibrary({ q: url.searchParams.get("q") || "", country: (url.searchParams.get("country") || "FR").toUpperCase().slice(0, 2), limit: Math.min(60, Math.max(1, Number(url.searchParams.get("limit")) || 24)), active: url.searchParams.get("all") !== "1", brandOnly: url.searchParams.get("brand") !== "0" });
        return reply(200, out);
      } catch (e) {
        console.error("[adlib]", e.message || e);
        return reply(502, { error: `bibliothèque Meta indisponible : ${String(e.message || e).slice(0, 200)}` });
      }
    }
    // ── Mo : voix locale (server/voice.mjs) — STT (audio du navigateur) et TTS (WAV) ──
    if (url.pathname.startsWith("/api/voice/")) {
      const send = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
      if (!authorized(req)) return send(401, { error: "unauthorized" });
      if (url.pathname === "/api/voice/status" && req.method === "GET") return send(200, { configured: voice.voiceConfigured() });
      try {
        if (url.pathname === "/api/voice/stt" && req.method === "POST") {
          const audio = await readRawBody(req, 8 * 1024 * 1024);
          const out = await voice.transcribe(audio);
          console.log(`[voice] stt ${out.seconds.toFixed(1)} s d'audio en ${out.ms} ms → « ${out.text.slice(0, 80)} »`);
          return send(200, out);
        }
        if (url.pathname === "/api/voice/tts" && req.method === "POST") {
          const body = await readBody(req);
          const out = await voice.synthesize(body?.text, body?.speaker);
          console.log(`[voice] tts ${out.seconds.toFixed(1)} s en ${out.ms} ms`);
          res.writeHead(200, { "Content-Type": "audio/wav", "Content-Length": String(out.wav.length), "X-Voice-Seconds": out.seconds.toFixed(2), "Cache-Control": "no-store" });
          res.end(out.wav);
          return;
        }
      } catch (e) {
        return send(e instanceof BodyTooLarge ? 413 : 500, { error: e instanceof Error ? e.message : String(e) });
      }
      return send(404, { error: "not found" });
    }
    // ── Studio créa : images fal.ai (server/fal.mjs) ──
    if (url.pathname.startsWith("/api/fal/")) {
      const send = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
      if (!authorized(req)) return send(401, { error: "unauthorized" });
      if (url.pathname === "/api/fal/models" && req.method === "GET") return send(200, { configured: fal.falConfigured(), models: Object.entries(fal.FAL_MODELS).map(([id, m]) => ({ id, ...m })), defaultModel: fal.DEFAULT_MODEL });
      if (!fal.falConfigured()) return send(503, { error: "fal.ai n'est pas configuré sur le relay (FAL_KEY)." });
      try {
        if (url.pathname === "/api/fal/image" && req.method === "POST") {
          const out = await fal.generateImage(await readBody(req));
          console.log(`[fal] image ${out.model} ${out.ratio} ×${out.urls.length} ${out.seconds}s ≈ $${out.usd}`);
          return send(200, out);
        }
      } catch (e) {
        return send(e?.status && e.status >= 400 && e.status < 500 ? e.status : 502, { error: e instanceof Error ? e.message : String(e) });
      }
      return send(404, { error: "not found" });
    }
    if (url.pathname.startsWith("/api/agnes/")) {
      if (!authorized(req)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      const send = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
      if (!agnes.agnesConfigured()) return send(503, { error: "Agnes AI n'est pas configuré sur le relay (AGNES_API_KEY)." });
      try {
        if (url.pathname === "/api/agnes/image" && req.method === "POST") {
          const out = await agnes.generateImage(await readBody(req));
          console.log(`[agnes] image ${out.model} ${out.size} ${out.ratio} → ${out.file ?? "sans copie"}`);
          return send(200, out);
        }
        if (url.pathname === "/api/agnes/video" && req.method === "POST") {
          const out = await agnes.createVideo(await readBody(req));
          console.log(`[agnes] vidéo ${out.model} ${out.seconds}s ${out.size} ${out.aspect_ratio} → ${out.videoId}`);
          return send(200, out);
        }
        if (url.pathname === "/api/agnes/video" && req.method === "GET") {
          return send(200, await agnes.pollVideo(url.searchParams.get("id"), url.searchParams.get("model")));
        }
        if (url.pathname === "/api/agnes/enhance" && req.method === "POST") {
          const out = await agnes.enhancePrompt(await readBody(req));
          console.log(`[agnes] consigne ${out.enhanced ? "réécrite" : "d'origine"} (${out.prompt.length} car.)`);
          return send(200, out);
        }
        if (url.pathname === "/api/agnes/upload" && req.method === "POST") {
          const body = await readBody(req);
          return send(200, { file: agnes.saveUpload(body?.image) });
        }
        return send(404, { error: "not found" });
      } catch (e) {
        console.error("[agnes] échec:", e.message);
        return send(e.status && e.status < 500 ? (e.status === 400 ? 400 : 422) : 502, { error: e.message });
      }
    }

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

    // Lecture déterministe d'un fichier d'un dossier client HQ (projects/…),
    // depuis le code de l'app, jamais depuis le modèle : contenu + ETag.
    if (url.pathname === "/api/hq/file" && req.method === "GET") {
      if (!authorized(req)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      const path = url.searchParams.get("path") || "";
      if (!HQ_PROJECT_FILE_RE.test(path)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "chemin HQ non autorisé (projects/{slug}/… attendu)" }));
        return;
      }
      const company = process.env.HQ_COMPANY || "impulse-analytics";
      try {
        const stat = parseHqJson(await hqToolCall("hq_files_stat", { company, path }));
        if (!stat || stat.found === false) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ found: false }));
          return;
        }
        const content = hqFileText(await hqToolCall("hq_files_read", { company, path }));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ found: true, path, content, etag: stat.etag ?? null, lastModified: stat.lastModified ?? null, size: stat.size ?? content.length }));
      } catch (e) {
        console.error("[hq] lecture échec:", path, e.message);
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    // Écriture du persona d'un client dans HQ (le seul fichier que l'app écrit
    // en place) : création si absent, sinon mise à jour sous verrou ETag, pour
    // ne jamais écraser ce qu'un consultant a changé dans HQ entre-temps.
    if (url.pathname === "/api/hq/persona" && req.method === "PUT") {
      if (!authorized(req)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      const body = await readBody(req);
      const project = typeof body?.project === "string" && /^[a-z0-9][a-z0-9-]{0,79}$/.test(body.project) ? body.project : null;
      const content = typeof body?.content === "string" ? body.content.slice(0, 120_000) : "";
      const etag = typeof body?.etag === "string" && body.etag ? body.etag : null;
      if (!project || !content.trim()) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "project et content requis" }));
        return;
      }
      // Deux fichiers seulement, jamais un chemin libre : le persona et le contexte de la fabrique de statics.
      const file = body?.file === undefined || body?.file === null ? "brain/recherche/personas.md" : body.file;
      if (!HQ_WRITABLE_FILES.includes(file)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "fichier HQ non autorisé" }));
        return;
      }
      const company = process.env.HQ_COMPANY || "impulse-analytics";
      const path = `projects/${project}/${file}`;
      try {
        const stat = parseHqJson(await hqToolCall("hq_files_stat", { company, path }));
        const exists = !!stat && stat.found !== false;
        if (exists && !etag) {
          res.writeHead(409, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Le fichier existe déjà dans HQ : relisez-le avant d'écrire.", etag: stat.etag ?? null }));
          return;
        }
        if (exists && stat.etag && stat.etag !== etag) {
          res.writeHead(409, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Le fichier a changé dans HQ depuis votre lecture : relisez-le puis réessayez.", etag: stat.etag }));
          return;
        }
        const result = exists
          ? await hqToolCall("hq_files_update", { company, path, content, expectedEtag: etag })
          : await hqToolCall("hq_files_create", { company, path, content });
        const after = parseHqJson(await hqToolCall("hq_files_stat", { company, path }));
        console.log(`[hq] ${file} ${company}/${project} ${exists ? "mis à jour" : "créé"} (${content.length} car.)`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, created: !exists, file, etag: after?.etag ?? null, result: String(result).slice(0, 300) }));
      } catch (e) {
        console.error("[hq] persona échec:", project, e.message);
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

    // ── Dossiers Drive des clients (server/drive-direct.mjs, identité data@) :
    // un dossier par client sous « ImpulseMotion – Clients », listé et alimenté
    // par l'app (designs, exports). Jamais de suppression ici.
    if (url.pathname.startsWith("/api/drive/")) {
      if (!authorized(req)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      const send = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
      if (!gwsAuth.configured()) return send(503, { error: "Google Workspace n'est pas configuré sur le relay (gws-auth)." });
      const getToken = async () => (await gwsAuth.getAccessToken()).token;
      try {
        if (url.pathname === "/api/drive/root" && req.method === "GET") return send(200, await drive.ensureRoot(getToken));
        // A folder directly under the root (« Mo – Tableaux » for tables without a client), created when missing.
        if (url.pathname === "/api/drive/root-subfolder" && req.method === "GET") {
          const root = await drive.ensureRoot(getToken);
          return send(200, await drive.ensureFolder(getToken, root.id, url.searchParams.get("name") || "", url.searchParams.get("description") || ""));
        }
        if (url.pathname === "/api/drive/client-folder" && req.method === "POST") {
          const body = await readBody(req);
          const out = await drive.ensureClientFolder(getToken, { name: body?.name, description: body?.description });
          console.log(`[drive] dossier client « ${drive.cleanName(body?.name)} » ${out.created ? "créé" : "trouvé"} (${out.id})`);
          return send(200, out);
        }
        if (url.pathname === "/api/drive/folder" && req.method === "POST") {
          const body = await readBody(req);
          const out = await drive.ensureFolder(getToken, body?.parentId, body?.name, body?.description);
          return send(200, out);
        }
        if (url.pathname === "/api/drive/folder" && req.method === "GET") {
          const f = await drive.getFolder(getToken, url.searchParams.get("id") || "");
          return f ? send(200, f) : send(404, { error: "dossier introuvable" });
        }
        if (url.pathname === "/api/drive/list" && req.method === "GET") {
          return send(200, { files: await drive.listFolder(getToken, url.searchParams.get("folderId") || "", { limit: Number(url.searchParams.get("limit")) || 100 }) });
        }
        if (url.pathname === "/api/drive/upload" && req.method === "POST") {
          const body = await readBody(req, UPLOAD_BODY_MAX_BYTES);
          const out = await drive.uploadFile(getToken, body?.folderId || "", { name: body?.name, mimeType: body?.mimeType, data: body?.data, convertTo: body?.convertTo });
          console.log(`[drive] ${out.replaced ? "remplacé" : "déposé"} « ${out.name} » (${out.bytes} o${body?.convertTo ? ` → ${out.mimeType}` : ""}) dans ${body?.folderId}`);
          return send(200, out);
        }
        return send(404, { error: "not found" });
      } catch (e) {
        console.error("[drive] échec:", e.message);
        return send(e.status && e.status >= 400 && e.status < 500 ? e.status : 502, { error: e.message });
      }
    }

    // ── Design (FigCraft, server/figcraft.mjs) : fichiers créés, exportés et
    // supprimés par le relay, qui seul tient la clé du serveur de collaboration.
    if (url.pathname.startsWith("/api/figcraft/")) {
      if (!authorized(req)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      const send = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
      if (url.pathname === "/api/figcraft/status" && req.method === "GET") {
        return send(200, { configured: figcraft.figcraftConfigured(), server: figcraft.figcraftConfigured() ? await figcraft.serverHealth() : null });
      }
      if (!figcraft.figcraftConfigured()) return send(503, { error: "FigCraft n'est pas configuré sur le relay (FIGCRAFT_SERVER_URL, figcraft-cli)." });
      try {
        if (url.pathname === "/api/figcraft/files" && req.method === "POST") {
          const body = await readBody(req);
          const out = await figcraft.createDesign({ name: body?.name, width: body?.width, height: body?.height, frameName: body?.frameName });
          console.log(`[figcraft] fichier créé ${out.fileId} « ${out.name} »`);
          return send(200, out);
        }
        const fileMatch = url.pathname.match(/^\/api\/figcraft\/files\/([a-f0-9]{8,32})$/);
        if (fileMatch && req.method === "DELETE") {
          const out = await figcraft.removeDesign(fileMatch[1]);
          console.log(`[figcraft] fichier ${fileMatch[1]} ${out.removed ? "supprimé" : "déjà absent"}`);
          return send(200, out);
        }
        if (url.pathname === "/api/figcraft/export" && req.method === "POST") {
          const body = await readBody(req);
          if (!figcraft.parseShareLink(body?.link)) return send(400, { error: "lien de partage invalide" });
          const out = await figcraft.exportDesign({ link: body.link, format: body.format, scale: body.scale, ids: body.ids });
          console.log(`[figcraft] export ${out.format} ${out.bytes} o`);
          return send(200, out);
        }
        if (url.pathname === "/api/figcraft/preview" && req.method === "POST") {
          const body = await readBody(req);
          if (!figcraft.parseShareLink(body?.link)) return send(400, { error: "lien de partage invalide" });
          return send(200, await figcraft.previewDesign({ link: body.link, maxSize: body.maxSize }));
        }
        return send(404, { error: "not found" });
      } catch (e) {
        console.error("[figcraft] échec:", e.message);
        return send(e.status === 413 ? 413 : 502, { error: e.message });
      }
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
      res.end(JSON.stringify({ status: "ok", capabilities: CAPABILITIES, jobsRunning: jobs.runningJobs().length, persistentSessions: sessionPool.snapshot() }));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  } catch (err) {
    console.error("[server]", err);
    if (!res.headersSent) res.writeHead(err?.status === 413 ? 413 : 500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err.message }));
  }
});

// A promise rejected without a handler, somewhere in a tool or a stream, must not take down every session:
// it is logged and the relay goes on. A real uncaught exception leaves the process in an unknown state:
// logged, then exit — systemd restarts the relay (Restart=always).
process.on("unhandledRejection", (reason) => {
  console.error("[relay] promesse rejetée non gérée (ignorée):", reason instanceof Error ? reason.stack || reason.message : reason);
});
process.on("uncaughtException", (err) => {
  console.error("[relay] exception non gérée, redémarrage:", err?.stack || err);
  process.exit(1);
});

// RELAY_HOST=127.0.0.1 once Caddy serves the relay in HTTPS (/etc/caddy/Caddyfile): nothing in clear on the network.
server.listen(PORT, process.env.RELAY_HOST || undefined, () => {
  // Mo's voice: the speech models (~1.1 GB, 20 s) load in the background so the first word is not kept waiting.
  if (process.env.VOICE_PRELOAD !== "0") setTimeout(() => voice.preload(), 3000);
  console.log(`[relay] Running on :${PORT} | Model: ${CLAUDE_MODEL}`);
  getToolsList().then(t => console.log(`[relay] ${t.length} MCP tools ready`));
});
