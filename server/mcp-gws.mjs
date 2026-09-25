#!/usr/bin/env node
/**
 * MCP stdio "gws" — Google Workspace pour l'IA interne (staff) via le CLI
 * officiel Google Workspace (`gws`, paquet @googleworkspace/cli épinglé en
 * 0.22.5 par le kit HQ companies/impulse-analytics/connectors/google-workspace),
 * installé sur l'hôte du relay. Identité partagée data@impulse-analytics.com.
 *
 * Lancé par le relay (server/relay.mjs) avec, en env :
 *   GWS_ACCESS_TOKEN       — jeton d'accès OAuth court minté par server/gws-auth.mjs
 *   GWS_TOKEN_EXPIRES_AT   — expiration (ms epoch), informatif
 *   GWS_AUTH_ERROR         — message si aucun jeton n'a pu être obtenu
 *   GWS_EXPECTED_EMAIL     — identité attendue (défaut data@impulse-analytics.com)
 *   GWS_RUN_UID            — uid sous lequel gws tourne quand le relay est root (défaut 1000)
 *
 * Lecture seule par construction : seules les méthodes get/list/batchGet/export…
 * passent, jamais `auth`, jamais de flag libre, jamais --json/--upload. Le CLI
 * tourne avec une configuration temporaire isolée et un environnement minimal ;
 * le jeton est redacté des sorties.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TOKEN = process.env.GWS_ACCESS_TOKEN || "";
const AUTH_ERROR = process.env.GWS_AUTH_ERROR || "";
const EXPECTED_EMAIL = process.env.GWS_EXPECTED_EMAIL || "data@impulse-analytics.com";
const RUN_UID = Number.isInteger(Number(process.env.GWS_RUN_UID)) ? Number(process.env.GWS_RUN_UID) : 1000;
const KIT_PATH = "companies/impulse-analytics/connectors/google-workspace";
const PINNED_VERSION = "0.22.5";
const INSTALL_HINT = `npm install -g @googleworkspace/cli@${PINNED_VERSION}`;
const TIMEOUT_MS = 60_000;
const OUTPUT_CAP = 30_000;
const MAX_PAGE_LIMIT = 5;
const READ_METHODS = new Set(["get", "list", "batchGet", "export", "search", "getMetadata"]);
const TOKEN_RE = /^[A-Za-z][A-Za-z0-9_]{0,40}$/;
const PATH_DIRS = (process.env.PATH || "/usr/local/bin:/usr/bin:/bin").split(":").filter(Boolean);
const IS_ROOT = typeof process.getuid === "function" && process.getuid() === 0;

function findGws() {
  for (const dir of [...PATH_DIRS, "/usr/local/bin", "/usr/bin"]) {
    const p = path.join(dir, "gws");
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* next */ }
  }
  return null;
}

function redact(text) {
  return TOKEN ? String(text || "").split(TOKEN).join("[REDACTED]") : String(text || "");
}

function capText(text, cap = OUTPUT_CAP) {
  if (text.length <= cap) return text;
  const head = Math.floor(cap * 0.7);
  return `${text.slice(0, head)}\n…[${text.length - cap} caractères tronqués]…\n${text.slice(-(cap - head))}`;
}

function exec(file, args, { env, cwd, timeoutMs = TIMEOUT_MS, dropPrivileges = false } = {}) {
  return new Promise((resolve) => {
    const opts = { env, cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, encoding: "utf8", killSignal: "SIGKILL" };
    if (dropPrivileges && IS_ROOT) { opts.uid = RUN_UID; opts.gid = RUN_UID; }
    execFile(file, args, opts, (err, stdout, stderr) => {
      resolve({
        code: err && typeof err.code === "number" ? err.code : (err ? -1 : 0),
        timedOut: !!(err && err.killed),
        launchError: err && typeof err.code !== "number" && !err.killed ? err.message : null,
        stdout: stdout ?? "",
        stderr: stderr ?? "",
      });
    });
  });
}

let running = false;

/** Runs `gws <args>` with the short-lived token, an isolated config dir and a minimal env. */
async function runGws(args, { needToken = true } = {}) {
  const gws = findGws();
  if (!gws) throw new Error(`gws est absent du serveur de l'IA — installation par un administrateur : ${INSTALL_HINT} (kit HQ ${KIT_PATH}/install.mjs).`);
  if (needToken && !TOKEN) throw new Error(AUTH_ERROR || "Aucun jeton Google Workspace disponible pour cette conversation.");
  if (running) throw new Error("Une commande Google Workspace est déjà en cours — attends son résultat.");
  running = true;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "im-gws-"));
  try {
    if (IS_ROOT) { try { fs.chownSync(tmp, RUN_UID, RUN_UID); } catch { /* best effort */ } }
    const env = {
      PATH: PATH_DIRS.join(":"),
      HOME: tmp,
      XDG_CONFIG_HOME: path.join(tmp, ".config"),
      GOOGLE_WORKSPACE_CLI_CONFIG_DIR: path.join(tmp, "gws"),
      LANG: "C.UTF-8",
      NO_COLOR: "1",
      ...(needToken ? { GOOGLE_WORKSPACE_CLI_TOKEN: TOKEN } : {}),
    };
    const r = await exec(gws, args, { env, cwd: tmp, dropPrivileges: true });
    return { ...r, stdout: redact(r.stdout), stderr: redact(r.stderr) };
  } finally {
    running = false;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

async function gwsVersion() {
  const gws = findGws();
  if (!gws) return { installed: false, path: null, version: null };
  const r = await runGws(["--version"], { needToken: false });
  const m = /(\d+\.\d+\.\d+)/.exec(r.stdout + r.stderr);
  const raw = (r.launchError || r.stdout + r.stderr).trim().slice(0, 200);
  return { installed: r.code === 0 && !!m, path: gws, version: m ? m[1] : null, raw };
}

/** `drive about get` restricted to the identity: the same probe as run.mjs --check in the HQ kit. */
async function checkConnection() {
  const r = await runGws(["drive", "about", "get", "--params", JSON.stringify({ fields: "user(displayName,emailAddress)" })]);
  if (r.timedOut) return { connected: false, error: "Délai dépassé en interrogeant Google Drive." };
  if (r.launchError) return { connected: false, error: `gws n'a pas pu démarrer : ${r.launchError}` };
  if (r.code !== 0) return { connected: false, error: `gws a répondu code ${r.code} : ${(r.stderr || r.stdout).trim().slice(0, 400)}` };
  let user = null;
  try { user = JSON.parse(r.stdout).user ?? null; } catch { /* not JSON */ }
  if (!user || typeof user.emailAddress !== "string") return { connected: false, error: `Réponse Drive inattendue : ${r.stdout.trim().slice(0, 300)}` };
  if (user.emailAddress.toLowerCase() !== EXPECTED_EMAIL.toLowerCase()) {
    return { connected: false, user, error: `Identité Workspace inattendue (${user.emailAddress} au lieu de ${EXPECTED_EMAIL}) ; vérifier le coffre Impulse.` };
  }
  return { connected: true, user };
}

/** "drive files list" → validated argv tokens (service, resource path, read method). */
function parseCommand(command) {
  const tokens = String(command || "").trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 2) throw new Error("command attendu sous la forme « <service> <ressource> <méthode> », ex. « drive files list ».");
  if (tokens.length > 6) throw new Error("Commande trop longue.");
  for (const t of tokens) {
    if (!TOKEN_RE.test(t)) throw new Error(`Jeton de commande invalide : « ${t.slice(0, 40)} » (lettres, chiffres, _ ; pas de flags ni de +helpers).`);
  }
  if (tokens[0].toLowerCase() === "auth") throw new Error("Les commandes auth sont interdites : l'authentification est gérée par le relay.");
  const method = tokens[tokens.length - 1];
  if (!READ_METHODS.has(method)) {
    throw new Error(`Méthode « ${method} » refusée : cet accès est en lecture seule (${[...READ_METHODS].join(", ")}).`);
  }
  return tokens;
}

function validateParams(params) {
  if (params === undefined || params === null) return null;
  if (typeof params !== "object" || Array.isArray(params)) throw new Error("params doit être un objet JSON.");
  const json = JSON.stringify(params);
  if (json.length > 8000) throw new Error("params trop volumineux (8 000 caractères max).");
  for (const k of Object.keys(params)) {
    if (/token|secret|credential|key$/i.test(k) && !/^pageToken$/.test(k)) throw new Error(`Paramètre refusé : ${k}.`);
  }
  return json;
}

// ── MCP ─────────────────────────────────────────────────────────────────────
const server = new McpServer({ name: "gws", version: "1.0.0" });

server.registerTool(
  "gws_status",
  {
    title: "État Google Workspace",
    description:
      "Déroule les vérifications du kit HQ Google Workspace sur le serveur de l'IA : Node/npm, présence et version du CLI gws (attendu " + PINNED_VERSION + "), " +
      "puis le test de connexion (équivalent de run.mjs --check : drive about get) qui confirme l'identité partagée " + EXPECTED_EMAIL + ". " +
      "À appeler quand un consultant demande de vérifier l'installation, la connexion, ou de lancer le parcours du kit (/hq-sync, node, npm, install.mjs, --check). " +
      "HQ est interrogé en direct par les outils hq_* : aucune synchronisation locale n'est nécessaire.",
    inputSchema: {},
  },
  async () => {
    const lines = [];
    lines.push(`1. Dossier HQ : interrogé en direct via les outils hq_* (kit : ${KIT_PATH}, lisible avec hq_files_read) — aucune synchronisation locale à faire.`);
    const npm = await exec("npm", ["--version"], { env: { PATH: PATH_DIRS.join(":") }, timeoutMs: 15_000 });
    const nodeMajor = Number(process.versions.node.split(".")[0]);
    lines.push(`2. Node.js ${process.version}${nodeMajor >= 18 ? " (≥ 18 OK)" : " (INSUFFISANT : Node 18 minimum)"} ; npm ${npm.code === 0 ? npm.stdout.trim() : "indisponible"}.`);
    let gws;
    try { gws = await gwsVersion(); } catch (e) { gws = { installed: false, error: e.message }; }
    if (gws.installed) {
      lines.push(`3. CLI gws installé : version ${gws.version}${gws.version === PINNED_VERSION ? " (version épinglée par le kit)" : ` (le kit épingle ${PINNED_VERSION})`} — ${gws.path}.`);
    } else if (gws.path) {
      lines.push(`3. CLI gws trouvé (${gws.path}) mais il ne démarre pas : ${gws.raw || gws.error || "erreur inconnue"} — à corriger par un administrateur du serveur.`);
    } else {
      lines.push(`3. CLI gws ABSENT du serveur de l'IA. Installation réservée à un administrateur du serveur : ${INSTALL_HINT} (c'est ce que fait ${KIT_PATH}/install.mjs). Rien à installer sur le poste du consultant.`);
    }
    let conn = null;
    if (!gws.installed) {
      lines.push("4. Connexion : non testable tant que gws n'est pas installé.");
    } else if (!TOKEN) {
      lines.push(`4. Connexion : impossible — ${AUTH_ERROR || "aucun jeton Google Workspace pour cette conversation"}.`);
    } else {
      conn = await checkConnection();
      lines.push(conn.connected
        ? `4. Connexion ACTIVE : ${JSON.stringify({ connected: true, user: conn.user })}`
        : `4. Connexion ÉCHOUÉE : ${conn.error}`);
    }
    const ok = !!(gws.installed && conn && conn.connected);
    lines.push(ok
      ? `Résumé : prêt — gws_run peut lister ou lire des ressources (lecture seule) sous l'identité ${EXPECTED_EMAIL}.`
      : "Résumé : NON prêt — rapporte l'étape bloquante telle quelle au consultant, sans annoncer de connexion.");
    return { content: [{ type: "text", text: lines.join("\n") }], isError: false };
  },
);

server.registerTool(
  "gws_run",
  {
    title: "Commande Google Workspace (lecture)",
    description:
      "Exécute une commande de LECTURE du CLI Google Workspace sous l'identité partagée " + EXPECTED_EMAIL + " : command = « <service> <ressource> <méthode> » " +
      "(ex. « drive files list », « drive files get », « drive about get », « sheets spreadsheets values get », « docs documents get », « gmail users messages list », « calendar events list »), " +
      "params = paramètres de l'API Google en JSON (ex. {\"pageSize\":5,\"fields\":\"files(id,name,mimeType,modifiedTime)\"} ; pour Sheets : {\"spreadsheetId\":\"…\",\"range\":\"Feuille1!A1:D20\"}). " +
      "Seules les méthodes get, list, batchGet, export, search passent : toute écriture, envoi ou commande auth est refusée. La sortie est le JSON du CLI (tronqué au-delà de 30 000 caractères) : " +
      "demande des champs précis (fields) et une pageSize raisonnable. Appelle gws_status d'abord si tu n'as pas encore confirmé la connexion dans cette conversation.",
    inputSchema: {
      command: z.string().min(3).max(120).describe("Service, ressource et méthode séparés par des espaces, ex. « drive files list »"),
      params: z.record(z.string(), z.any()).optional().describe("Paramètres de requête de l'API Google (objet JSON)"),
      page_all: z.boolean().optional().describe("Suivre la pagination (NDJSON), au plus page_limit pages"),
      page_limit: z.number().int().min(1).max(MAX_PAGE_LIMIT).optional().describe(`Pages max avec page_all (défaut 2, max ${MAX_PAGE_LIMIT})`),
    },
  },
  async ({ command, params, page_all, page_limit }) => {
    try {
      const tokens = parseCommand(command);
      const json = validateParams(params);
      const args = [...tokens];
      if (json) args.push("--params", json);
      if (page_all) args.push("--page-all", "--page-limit", String(Math.min(page_limit ?? 2, MAX_PAGE_LIMIT)));
      const started = Date.now();
      const r = await runGws(args);
      const elapsed = ((Date.now() - started) / 1000).toFixed(1);
      const parts = [`gws ${tokens.join(" ")}${json ? ` --params ${json.slice(0, 300)}` : ""}`];
      if (r.timedOut) parts.push(`⏱ Interrompu après ${TIMEOUT_MS / 1000} s (délai dépassé). Réduis pageSize ou précise fields.`);
      else if (r.launchError) parts.push(`Erreur de lancement : ${r.launchError}`);
      else if (r.code !== 0) parts.push(`Code de sortie ${r.code} (${elapsed} s)`);
      else parts.push(`OK (${elapsed} s)`);
      if (r.stdout.trim()) parts.push(`--- stdout ---\n${capText(r.stdout)}`);
      if (r.stderr.trim()) parts.push(`--- stderr ---\n${capText(r.stderr, 6000)}`);
      return { content: [{ type: "text", text: parts.join("\n\n") }], isError: r.timedOut || !!r.launchError || r.code !== 0 };
    } catch (e) {
      return { content: [{ type: "text", text: `Erreur : ${e.message}` }], isError: true };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
