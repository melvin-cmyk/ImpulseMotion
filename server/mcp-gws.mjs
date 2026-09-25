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
 *   WORKSPACE_DIR          — workspace de la conversation (le même que le bac à
 *                            sable, monté en /work) : source des uploads et
 *                            pièces jointes, destination des téléchargements
 *
 * Accès complet au CLI, comme un consultant sur Claude Code : lecture, création,
 * modification, envoi, upload et download. Garde-fous : jamais `auth` ni de
 * flag d'identité/config ; une écriture exige confirm_write=true (le modèle
 * n'y a droit que sur demande explicite du consultant) ; fichiers uniquement
 * dans le workspace de la conversation ; CLI lancé en utilisateur non
 * privilégié avec une configuration temporaire isolée ; jeton redacté.
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
const WORKSPACE_DIR = process.env.WORKSPACE_DIR && path.isAbsolute(process.env.WORKSPACE_DIR) && fs.existsSync(process.env.WORKSPACE_DIR)
  ? process.env.WORKSPACE_DIR : "";
const KIT_PATH = "companies/impulse-analytics/connectors/google-workspace";
const PINNED_VERSION = "0.22.5";
const INSTALL_HINT = `npm install -g @googleworkspace/cli@${PINNED_VERSION}`;
const TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_S = 300;
const OUTPUT_CAP = 30_000;
const MAX_PAGE_LIMIT = 10;
// Methods and helpers that never change anything: everything else is a write.
const READ_METHODS = new Set(["get", "list", "batchGet", "export", "download", "search", "getMetadata", "listLabels", "generateIds", "about"]);
const READ_HELPERS = new Set(["+triage", "+read"]);
const READ_SERVICES = new Set(["schema"]);
const WORD_RE = /^[A-Za-z][A-Za-z0-9_-]{0,40}$/;
const HELPER_RE = /^\+[a-z][a-z0-9-]{0,30}$/;
const DOTTED_RE = /^[A-Za-z][A-Za-z0-9_-]*(\.[A-Za-z][A-Za-z0-9_-]*){0,4}$/;
const FLAG_NAME_RE = /^[a-z][a-z0-9-]{0,30}$/;
// Flags that carry identity/config or are handled through dedicated fields.
const FLAG_DENY = new Set(["params", "json", "upload", "upload-content-type", "output", "o", "attach", "a", "sanitize", "page-all", "page-limit", "page-delay", "dry-run", "format", "help", "h", "version"]);
const FLAG_DENY_RE = /token|credential|secret|config|log|keyring|project/i;
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

function fmtBytes(n) {
  if (n < 1024) return `${n} o`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} Ko`;
  return `${(n / 1024 / 1024).toFixed(1)} Mo`;
}

/** Resolve a /work-relative path inside the conversation workspace, or throw. */
function inWorkspace(p, { mustExist = false, underOut = false } = {}) {
  if (!WORKSPACE_DIR) throw new Error("Pas de workspace dans cette conversation : les fichiers (upload, pièces jointes, téléchargements) ne sont disponibles que dans une conversation nommée avec le bac à sable.");
  const rel = String(p ?? "").replace(/^\/work\/?/, "").replace(/^\.\/+/, "");
  if (!rel) throw new Error("Chemin de fichier vide.");
  const abs = path.resolve(WORKSPACE_DIR, rel);
  if (!abs.startsWith(WORKSPACE_DIR + path.sep)) throw new Error(`Chemin hors du workspace : ${p}`);
  if (underOut && !abs.startsWith(path.join(WORKSPACE_DIR, "out") + path.sep)) throw new Error(`Les téléchargements vont dans /work/out : ${p}`);
  if (mustExist && !(fs.existsSync(abs) && fs.statSync(abs).isFile())) throw new Error(`Fichier introuvable dans le workspace : ${p} (list_files pour voir ce qui existe)`);
  return abs;
}

function snapshotOut() {
  const m = new Map();
  try {
    for (const f of fs.readdirSync(path.join(WORKSPACE_DIR, "out"))) {
      try { const st = fs.statSync(path.join(WORKSPACE_DIR, "out", f)); if (st.isFile()) m.set(f, `${st.size}:${Math.round(st.mtimeMs)}`); } catch { /* vanished */ }
    }
  } catch { /* none */ }
  return m;
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
async function runGws(args, { needToken = true, timeoutMs = TIMEOUT_MS, cwd = null } = {}) {
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
    // gws only accepts --upload/--attach/--output paths under its cwd: file
    // commands run from the workspace (owned by RUN_UID) with relative paths.
    const r = await exec(gws, args, { env, cwd: cwd || tmp, timeoutMs, dropPrivileges: true });
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

/** "drive files list" / "gmail +send" / "schema drive.files.create" → validated argv tokens + write flag. */
function parseCommand(command) {
  const tokens = String(command || "").trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 2) throw new Error("command attendu sous la forme « <service> <ressource> <méthode> » (ex. « drive files list »), « <service> +helper » (ex. « gmail +send ») ou « schema <service.ressource.méthode> ».");
  if (tokens.length > 6) throw new Error("Commande trop longue.");
  tokens.forEach((t, i) => {
    const ok = HELPER_RE.test(t) || (i === 1 && tokens[0] === "schema" ? DOTTED_RE.test(t) : WORD_RE.test(t));
    if (!ok) throw new Error(`Jeton de commande invalide : « ${t.slice(0, 40)} » — pas de flags ici (utilise params, body, flags, upload, output, attach).`);
  });
  const service = tokens[0].toLowerCase();
  if (service === "auth") throw new Error("Les commandes auth sont interdites : l'authentification est gérée par le relay (identité data@ garantie).");
  const last = tokens[tokens.length - 1];
  const helper = tokens.find((t) => t.startsWith("+"));
  const isWrite = !(READ_SERVICES.has(service) || (helper ? READ_HELPERS.has(helper) : READ_METHODS.has(last)));
  return { tokens, isWrite, method: helper || last };
}

function jsonArg(value, label, cap = 200_000) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object") throw new Error(`${label} doit être un objet ou un tableau JSON.`);
  const json = JSON.stringify(value);
  if (json.length > cap) throw new Error(`${label} trop volumineux (${cap} caractères max).`);
  return json;
}

function flagArgs(flags) {
  const out = [];
  if (!flags) return out;
  if (typeof flags !== "object" || Array.isArray(flags)) throw new Error("flags doit être un objet { nom: valeur }.");
  for (const [rawName, value] of Object.entries(flags)) {
    const name = String(rawName).replace(/^-+/, "");
    if (!FLAG_NAME_RE.test(name)) throw new Error(`Nom de flag invalide : ${rawName}`);
    if (FLAG_DENY.has(name)) throw new Error(`Flag --${name} refusé : passe par le champ dédié (params, body, upload, output, attach, dry_run, format, page_all).`);
    if (FLAG_DENY_RE.test(name)) throw new Error(`Flag --${name} refusé (identité/config gérées par le relay).`);
    if (value === true) out.push(`--${name}`);
    else if (value === false || value === null || value === undefined) continue;
    else if (Array.isArray(value)) for (const v of value) out.push(`--${name}`, String(v).slice(0, 20_000));
    else out.push(`--${name}`, String(value).slice(0, 100_000));
  }
  return out;
}

// ── MCP ─────────────────────────────────────────────────────────────────────
const server = new McpServer({ name: "gws", version: "2.0.0" });

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
      ? `Résumé : prêt — gws_run peut lire et, sur demande explicite du consultant, créer/modifier/envoyer sous l'identité ${EXPECTED_EMAIL}. Workspace fichiers : ${WORKSPACE_DIR ? "disponible (/work)" : "absent dans cette conversation"}.`
      : "Résumé : NON prêt — rapporte l'étape bloquante telle quelle au consultant, sans annoncer de connexion.");
    return { content: [{ type: "text", text: lines.join("\n") }], isError: false };
  },
);

server.registerTool(
  "gws_help",
  {
    title: "Aide du CLI Google Workspace",
    description:
      "Aide intégrée de gws, sans jeton : command = « <service> » (liste des ressources et +helpers), « <service> <ressource> » (méthodes), « <service> <ressource> <méthode> » ou « <service> +helper » (flags), " +
      "ou « schema <service.ressource.méthode> » (schéma exact des paramètres et du corps, ex. « schema drive.files.create »). À consulter avant une commande dont tu n'es pas sûr de la syntaxe.",
    inputSchema: {
      command: z.string().min(2).max(120).describe("Ex. « gmail », « drive files », « gmail +send », « schema sheets.spreadsheets.values.update »"),
    },
  },
  async ({ command }) => {
    try {
      const tokens = String(command).trim().split(/\s+/).filter(Boolean).slice(0, 6);
      tokens.forEach((t, i) => {
        const ok = HELPER_RE.test(t) || (i === 1 && tokens[0] === "schema" ? DOTTED_RE.test(t) : WORD_RE.test(t));
        if (!ok) throw new Error(`Jeton invalide : « ${t.slice(0, 40)} »`);
      });
      if (tokens[0] === "auth") throw new Error("Les commandes auth sont interdites.");
      const args = tokens[0] === "schema" ? tokens : [...tokens, "--help"];
      const r = await runGws(args, { needToken: tokens[0] === "schema" && !!TOKEN });
      const text = (r.stdout + (r.stderr ? `\n${r.stderr}` : "")).trim();
      return { content: [{ type: "text", text: capText(text || "(pas de sortie)", 20_000) }], isError: r.code !== 0 && !text };
    } catch (e) {
      return { content: [{ type: "text", text: `Erreur : ${e.message}` }], isError: true };
    }
  },
);

server.registerTool(
  "gws_run",
  {
    title: "Commande Google Workspace",
    description:
      "Exécute une commande du CLI Google Workspace sous l'identité partagée " + EXPECTED_EMAIL + " — lecture ET écriture, comme sur Claude Code. " +
      "command = « <service> <ressource> <méthode> » (ex. « drive files list », « drive files create », « sheets spreadsheets values update », « docs documents batchUpdate », « calendar events insert », « gmail users messages list ») " +
      "ou « <service> +helper » (ex. « gmail +send », « gmail +reply », « gmail +triage »). params = paramètres d'URL/requête (ex. {\"pageSize\":5,\"fields\":\"files(id,name)\"} ; Sheets : {\"spreadsheetId\":\"…\",\"range\":\"Feuille1!A1:D20\",\"valueInputOption\":\"USER_ENTERED\"}). " +
      "body = corps JSON de la requête (POST/PATCH/PUT, ex. {\"name\":\"Rapport\",\"mimeType\":\"application/vnd.google-apps.folder\"}). flags = options d'un +helper ({\"to\":\"a@b.fr\",\"subject\":\"…\",\"body\":\"…\",\"cc\":\"…\",\"html\":true}). " +
      "Fichiers du workspace de la conversation (/work, celui du bac à sable) : upload = fichier à envoyer comme contenu (ex. « out/deck.pptx » avec drive files create + body {\"name\":\"deck.pptx\",\"parents\":[\"<folderId>\"]}), " +
      "attach = pièces jointes d'un mail, output = destination d'un téléchargement (sous out/, ex. « out/brief.pdf » avec drive files download ou export ; propose-le ensuite avec [nom](sandbox:out/nom)). " +
      "ÉCRITURE (create, update, delete, insert, batchUpdate, +send, +reply, upload…) : confirm_write=true OBLIGATOIRE, et tu ne le passes que si le consultant a demandé explicitement cette action dans la conversation ; " +
      "pour un envoi de mail ou une suppression, récapitule d'abord (destinataires, objet, contenu / fichier visé) et attends son accord ; dry_run=true permet de prévisualiser sans exécuter. " +
      "La sortie est le JSON du CLI (tronqué au-delà de 30 000 caractères) : demande des champs précis (fields) et une pageSize raisonnable. gws_help / « schema … » pour la syntaxe exacte. " +
      "Appelle gws_status d'abord si tu n'as pas encore confirmé la connexion dans cette conversation.",
    inputSchema: {
      command: z.string().min(3).max(120).describe("Service, ressource et méthode (ou +helper) séparés par des espaces"),
      params: z.record(z.string(), z.any()).optional().describe("Paramètres d'URL/requête de l'API Google (--params)"),
      body: z.union([z.record(z.string(), z.any()), z.array(z.any())]).optional().describe("Corps JSON de la requête (--json)"),
      flags: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string())])).optional().describe("Options d'un +helper : { to, subject, body, cc, bcc, html, draft, from, \"message-id\"… }"),
      upload: z.string().max(300).optional().describe("Fichier du workspace à envoyer comme contenu (--upload), ex. out/deck.pptx"),
      upload_content_type: z.string().max(120).optional().describe("Type MIME du fichier envoyé (auto par défaut)"),
      attach: z.array(z.string().max(300)).max(10).optional().describe("Pièces jointes (gmail +send) : chemins du workspace"),
      output: z.string().max(300).optional().describe("Fichier de sortie pour un téléchargement/export, sous out/ (--output)"),
      confirm_write: z.boolean().optional().describe("true UNIQUEMENT si le consultant a explicitement demandé cette écriture/envoi"),
      dry_run: z.boolean().optional().describe("Valider sans exécuter (--dry-run)"),
      format: z.enum(["json", "table", "yaml", "csv"]).optional().describe("Format de sortie (json par défaut)"),
      page_all: z.boolean().optional().describe("Suivre la pagination (NDJSON), au plus page_limit pages"),
      page_limit: z.number().int().min(1).max(MAX_PAGE_LIMIT).optional().describe(`Pages max avec page_all (défaut 2, max ${MAX_PAGE_LIMIT})`),
      timeout_s: z.number().int().min(5).max(MAX_TIMEOUT_S).optional().describe(`Délai max en secondes (défaut ${TIMEOUT_MS / 1000}, uploads volumineux : plus)`),
    },
  },
  async ({ command, params, body, flags, upload, upload_content_type, attach, output, confirm_write, dry_run, format, page_all, page_limit, timeout_s }) => {
    try {
      const { tokens, isWrite, method } = parseCommand(command);
      const paramsJson = jsonArg(params, "params", 8000);
      const bodyJson = jsonArg(body, "body");
      const extra = flagArgs(flags);
      const args = [...tokens];
      if (paramsJson) args.push("--params", paramsJson);
      if (bodyJson) args.push("--json", bodyJson);
      args.push(...extra);
      const describedFiles = [];
      const relWs = (abs) => path.relative(WORKSPACE_DIR, abs).split(path.sep).join("/");
      if (upload) { const abs = inWorkspace(upload, { mustExist: true }); args.push("--upload", relWs(abs)); describedFiles.push(`upload ${upload}`); if (upload_content_type) args.push("--upload-content-type", String(upload_content_type)); }
      for (const a of attach || []) { const abs = inWorkspace(a, { mustExist: true }); args.push("--attach", relWs(abs)); describedFiles.push(`pièce jointe ${a}`); }
      if (output) { const abs = inWorkspace(output, { underOut: true }); fs.mkdirSync(path.dirname(abs), { recursive: true }); args.push("--output", relWs(abs)); describedFiles.push(`sortie ${output}`); }
      const cwd = describedFiles.length ? WORKSPACE_DIR : null;
      if (dry_run) args.push("--dry-run");
      if (format) args.push("--format", format);
      if (page_all) args.push("--page-all", "--page-limit", String(Math.min(page_limit ?? 2, MAX_PAGE_LIMIT)));
      const effectiveWrite = isWrite || !!upload || !!(attach && attach.length);
      if (effectiveWrite && !dry_run && confirm_write !== true) {
        return {
          content: [{ type: "text", text: `Refusé : « ${method} » modifie, crée ou envoie quelque chose. Passe confirm_write=true seulement si le consultant a explicitement demandé cette action dans la conversation (pour un mail ou une suppression : récapitule d'abord et attends son accord). dry_run=true pour prévisualiser.` }],
          isError: true,
        };
      }
      const before = WORKSPACE_DIR ? snapshotOut() : new Map();
      const started = Date.now();
      const timeoutMs = Math.min(timeout_s ?? TIMEOUT_MS / 1000, MAX_TIMEOUT_S) * 1000;
      const r = await runGws(args, { timeoutMs, cwd });
      const elapsed = ((Date.now() - started) / 1000).toFixed(1);
      const shown = [`gws ${tokens.join(" ")}`, paramsJson ? `--params ${paramsJson.slice(0, 300)}` : "", bodyJson ? `--json ${bodyJson.slice(0, 300)}${bodyJson.length > 300 ? "…" : ""}` : "", extra.length ? extra.map((x) => x.length > 80 ? `${x.slice(0, 80)}…` : x).join(" ") : "", describedFiles.join(", "), dry_run ? "--dry-run" : ""].filter(Boolean).join(" ");
      const parts = [shown + (effectiveWrite && !dry_run ? "  [ÉCRITURE]" : "")];
      if (r.timedOut) parts.push(`⏱ Interrompu après ${timeoutMs / 1000} s (délai dépassé). Réduis le volume ou augmente timeout_s.`);
      else if (r.launchError) parts.push(`Erreur de lancement : ${r.launchError}`);
      else if (r.code !== 0) parts.push(`Code de sortie ${r.code} (${elapsed} s)${r.code === 1 ? " — erreur API Google" : r.code === 2 ? " — authentification" : r.code === 3 ? " — arguments invalides (gws_help / schema)" : ""}`);
      else parts.push(`OK (${elapsed} s)`);
      if (r.stdout.trim()) parts.push(`--- stdout ---\n${capText(r.stdout)}`);
      if (r.stderr.trim()) parts.push(`--- stderr ---\n${capText(r.stderr, 6000)}`);
      if (WORKSPACE_DIR) {
        const after = snapshotOut();
        const changed = [...after].filter(([f, sig]) => before.get(f) !== sig).map(([f]) => `/work/out/${f} (${fmtBytes(Number(after.get(f).split(":")[0]))})`);
        if (changed.length) parts.push(`--- fichiers écrits dans le workspace ---\n${changed.join("\n")}\nPropose-les au consultant avec [nom](sandbox:out/nom).`);
      }
      return { content: [{ type: "text", text: parts.join("\n\n") }], isError: r.timedOut || !!r.launchError || r.code !== 0 };
    } catch (e) {
      return { content: [{ type: "text", text: `Erreur : ${e.message}` }], isError: true };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
