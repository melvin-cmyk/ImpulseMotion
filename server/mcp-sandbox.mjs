#!/usr/bin/env node
/**
 * MCP stdio "sandbox" — exécution de Python isolée pour l'IA interne (staff).
 *
 * Lancé par le relay (server/relay.mjs) avec, en env :
 *   WORKSPACE_DIR   — dossier de travail de la conversation (monté en /work)
 *   SANDBOX_IMAGE   — image Docker (défaut impulsemotion-sandbox:latest,
 *                     voir server/sandbox/Dockerfile)
 *   SANDBOX_TIMEOUT_S, SANDBOX_MEMORY, SANDBOX_CPUS — limites (90 s, 768m, 0.8)
 *   SKILLS_DIR      — dossier des skills HQ synchronisées (SKILL.md + assets),
 *                     monté en lecture seule sur /skills (optionnel)
 *   SANDBOX_STATE_DIR — racine des dossiers d'état de l'hôte ; chaque workspace
 *                     y a son propre sous-dossier
 *                     (défaut : <dossier des workspaces>-etat/<id du workspace>)
 *
 * Chaque run_python / run_node / render_pptx démarre un conteneur jetable : pas de réseau, système de
 * fichiers en lecture seule sauf /work (le workspace) et /tmp, utilisateur
 * non privilégié, toutes les capabilities retirées, limites CPU/RAM/PIDs,
 * arrêté au-delà du délai. Le code du modèle ne voit donc que le workspace de
 * sa conversation : les fichiers déposés par le consultant (/work/uploads)
 * et ses propres sorties (/work/out), que le relay sert ensuite au navigateur.
 *
 * Le délai est porté par le conteneur lui-même (commande lancée sous
 * `timeout`) : il s'arrête même si ce serveur disparaît, ce qui arrive chaque
 * fois que le relay coupe le CLI. Ce serveur arrête en plus le conteneur en
 * cours quand il s'arrête, et balaie à son démarrage ce qu'un prédécesseur
 * aurait laissé pour ce workspace.
 *
 * Ce serveur tourne sur l'hôte, en root, et le conteneur exécute du code qui
 * peut avoir été dicté par une injection : tout ce que contient le workspace
 * est hostile. Deux règles en découlent.
 *  - L'hôte n'écrit rien de son cru dans le workspace : le script à exécuter
 *    et les sorties complètes vivent dans le dossier d'état, que le conteneur
 *    ne monte pas (le script lui est montré en lecture seule sur /script).
 *  - Ce que l'hôte fait quand même dans le workspace (lire, lister, rendre les
 *    fichiers au conteneur, ranger les aperçus) passe par openDir : descente
 *    composant par composant, jamais à travers un lien symbolique.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execFile, execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { capMiddle, createReadLedger, fmtBytes, foldOutput, renderFileList, renderSkillList, renderJson, sliceNote, sliceText } from "./mcp-compact-generic.mjs";

const WORKSPACE_DIR = process.env.WORKSPACE_DIR || "";
const IMAGE = process.env.SANDBOX_IMAGE || "impulsemotion-sandbox:latest";
const TIMEOUT_S = clampInt(process.env.SANDBOX_TIMEOUT_S, 10, 300, 90);
const MEMORY = process.env.SANDBOX_MEMORY || "768m";
const CPUS = process.env.SANDBOX_CPUS || "0.8";
const SKILLS_DIR = process.env.SKILLS_DIR && path.isAbsolute(process.env.SKILLS_DIR) && fs.existsSync(process.env.SKILLS_DIR)
  ? process.env.SKILLS_DIR : "";
// LibreOffice cold start on one core is slow: rendering gets its own budget.
const RENDER_TIMEOUT_S = clampInt(process.env.SANDBOX_RENDER_TIMEOUT_S, 30, 600, 180);
const RENDER_MAX_PAGES = 8;
// Une page rendue pèse 100 à 300 ko ; au-delà du plafond elle n'est pas renvoyée.
const RENDER_MAX_IMAGE_BYTES = 3 * 1024 * 1024;
// Délai dépassé : `timeout` envoie SIGTERM dans le conteneur, puis SIGKILL après
// KILL_AFTER_S. L'hôte ne tue lui-même (docker kill) qu'au-delà de HOST_GRACE_S,
// et un conteneur n'est tenu pour abandonné qu'après SWEEP_GRACE_S.
const KILL_AFTER_S = 5;
const HOST_GRACE_S = 15;
const SWEEP_GRACE_S = 30;
const CONTAINER_PREFIX = "im-sb-";
const CONTAINER_NAME_RE = /^im-sb-[a-f0-9]{12}$/;
const SCRIPT_DIR_RE = /^script-([a-f0-9]{12})$/;
const LABEL_WORKSPACE = "im.sandbox.workspace";
const LABEL_DEADLINE = "im.sandbox.deadline";
// uid of the "sandbox" user baked into the image; the workspace is chowned to it.
const SANDBOX_UID = 1000;
// Plafonds par défaut bas (le résultat est relu à chaque tour de la conversation) ;
// le modèle peut remonter jusqu'aux anciens plafonds par paramètre.
const OUTPUT_CAP = 12_000;
const OUTPUT_CAP_MAX = 30_000;
const STDERR_CAP = 8000;
const READ_CAP = 20_000;
// Maximum accepté par le schéma ; le plafond réel est RESULT_TOKEN_BUDGET.
const READ_CAP_MAX = 60_000;
const READ_MAX_BYTES = 8 * 1024 * 1024;
const MAX_LIST = 300;
// Le CLI rejette un résultat d'outil au-delà de MAX_MCP_OUTPUT_TOKENS (20 000) et,
// sous le mode restreint du relay, le modèle n'en voit alors rien. Le budget
// garde 10 % de marge ; l'estimation prend le cas dense (chiffres, ponctuation :
// 0,52 token par caractère) et compte large ce qui sort de l'ASCII.
const RESULT_TOKEN_BUDGET = 18_000;
const TOKENS_PER_CHAR = 0.52;
const TOKENS_PER_WIDE_CHAR = 1.5;
const NOTES_TOKEN_RESERVE = 300;
// Sorties complètes des scripts coupés : dans le dossier d'état, une par
// exécution, relues par read_file sous le nom sortie:<id>. L'ancien chemin
// reste compris et désigne la dernière exécution, elle seule.
const OUTPUT_PATH_RE = /^sortie:([a-f0-9]{12})$/;
const LAST_OUTPUT_ALIAS = ".run/derniere-sortie.txt";
const KEPT_OUTPUTS = 5;
const { O_RDONLY, O_DIRECTORY, O_NOFOLLOW, O_NONBLOCK } = fs.constants;

if (!WORKSPACE_DIR || !path.isAbsolute(WORKSPACE_DIR)) {
  console.error("[mcp-sandbox] WORKSPACE_DIR absente ou relative — refus de démarrer");
  process.exit(1);
}
fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
const STATE = hostStateDir();
const STATE_DIR = STATE.dir;
// Dossiers de script présents avant que ce processus n'en crée : candidats au balayage.
const LEFTOVER_SCRIPT_DIRS = fs.readdirSync(STATE_DIR).filter((f) => SCRIPT_DIR_RE.test(f));
// Un dossier d'état temporaire ne sert qu'à ce processus : il part avec lui.
process.on("exit", () => { if (STATE.temporary) { try { fs.rmSync(STATE_DIR, { recursive: true, force: true }); } catch { /* ignore */ } } });

function clampInt(v, min, max, dflt) {
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : dflt;
}

/** Vrai si le chemin réel `real` est `dir` ou s'y trouve. */
function inside(real, dir) {
  return real === dir || real.startsWith(dir + path.sep);
}

/**
 * Emplacement réel qu'aurait un chemin, sans rien créer : le plus proche
 * ancêtre existant est résolu, liens compris, le reste du chemin suit.
 */
function realTarget(p) {
  const rest = [];
  for (let cur = path.resolve(p); ; cur = path.dirname(cur)) {
    try { return path.join(fs.realpathSync(cur), ...rest); } catch (e) { if (cur === path.dirname(cur)) throw e; }
    rest.unshift(path.basename(cur));
  }
}

/** Dossier temporaire propre à ce processus, jamais dans le workspace (TMPDIR peut y pointer). */
function tempDirOutside(ws, prefix) {
  for (const base of new Set([os.tmpdir(), "/tmp"])) {
    let real;
    try { real = fs.realpathSync(base); } catch { continue; }
    if (inside(real, ws)) continue;
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(real, prefix)));
    if (!inside(dir, ws)) return dir;
    fs.rmSync(dir, { recursive: true, force: true });
  }
  throw new Error("aucun dossier temporaire hors du workspace");
}

/**
 * Dossier d'état de l'hôte pour cette conversation : hors du workspace, donc
 * hors de ce que le conteneur monte, et fermé aux autres utilisateurs. Sous
 * une racine imposée (SANDBOX_STATE_DIR), chaque workspace a son sous-dossier :
 * la sortie d'une conversation n'est jamais lisible par une autre.
 * L'emplacement est contrôlé avant d'être créé, puis une fois créé. À défaut
 * (dossier refusé ou impossible à créer), un dossier temporaire propre à ce
 * processus : les sorties ne survivent alors pas au tour en cours.
 */
function hostStateDir() {
  const ws = fs.realpathSync(WORKSPACE_DIR);
  const forced = process.env.SANDBOX_STATE_DIR && path.isAbsolute(process.env.SANDBOX_STATE_DIR) ? process.env.SANDBOX_STATE_DIR : "";
  const root = `${path.dirname(WORKSPACE_DIR)}-etat`;
  const own = `${path.basename(ws)}-${crypto.createHash("sha256").update(ws).digest("hex").slice(0, 12)}`;
  const wanted = forced ? path.join(forced, own) : path.join(root, path.basename(WORKSPACE_DIR));
  try {
    if (inside(realTarget(wanted), ws)) throw new Error("il est dans le workspace");
    fs.mkdirSync(wanted, { recursive: true, mode: 0o700 });
    const real = fs.realpathSync(wanted);
    if (inside(real, ws)) throw new Error("il est dans le workspace");
    if (typeof process.getuid === "function" && fs.statSync(real).uid !== process.getuid()) throw new Error("il appartient à un autre utilisateur");
    fs.chmodSync(real, 0o700);
    // L'état d'un workspace purgé par le relay part avec lui.
    if (!forced) {
      for (const d of fs.readdirSync(root)) {
        if (!fs.existsSync(path.join(path.dirname(WORKSPACE_DIR), d))) fs.rmSync(path.join(root, d), { recursive: true, force: true });
      }
    }
    return { dir: real, temporary: false };
  } catch (e) {
    console.error(`[mcp-sandbox] dossier d'état ${wanted} inutilisable (${e.message}) — dossier temporaire`);
  }
  try { return { dir: tempDirOutside(ws, "im-sb-etat-"), temporary: true }; } catch (e) {
    console.error(`[mcp-sandbox] ${e.message} — refus de démarrer`);
    process.exit(1);
  }
}

// ── Accès de l'hôte au workspace ────────────────────────────────────────────

/** Nom d'une entrée relativement à un dossier déjà ouvert (l'équivalent d'openat). */
const viaFd = (dirFd, name) => `/proc/self/fd/${dirFd}/${name}`;

/** Erreur d'ouverture dite avec le chemin côté modèle, lien symbolique nommé comme tel. */
function openError(e, dirFd, name, shown) {
  let link = e.code === "ELOOP";
  try { link = link || fs.lstatSync(viaFd(dirFd, name)).isSymbolicLink(); } catch { /* absent */ }
  if (link) return new Error(`Lien symbolique refusé : ${shown} — l'hôte ne suit aucun lien du workspace ; vise le vrai fichier, ou lis-le avec run_python`);
  return new Error(String(e.message).replace(/'\/proc\/self\/fd\/\d+\/[^']*'/, `'${shown}'`));
}

/**
 * Ouvre un dossier du workspace et rend son descripteur. La descente se fait
 * composant par composant, chaque ouverture relative au descripteur du parent
 * et en O_NOFOLLOW : un lien posé par le conteneur, à n'importe quel niveau,
 * fait échouer l'ouverture au lieu d'emmener l'hôte ailleurs. Il n'y a pas de
 * fenêtre entre vérification et usage : ce qui est vérifié est ce qui est ouvert.
 */
function openDir(parts = []) {
  let fd = fs.openSync(WORKSPACE_DIR, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  try {
    parts.forEach((part, i) => {
      let next;
      try { next = fs.openSync(viaFd(fd, part), O_RDONLY | O_DIRECTORY | O_NOFOLLOW); }
      catch (e) { throw openError(e, fd, part, `/work/${parts.slice(0, i + 1).join("/")}`); }
      fs.closeSync(fd);
      fd = next;
    });
    return fd;
  } catch (e) {
    fs.closeSync(fd);
    throw e;
  }
}

/**
 * Ouvre en lecture un fichier ordinaire d'un dossier déjà ouvert, sans suivre
 * de lien. Un fichier qui a plusieurs noms (lien dur) est refusé : l'autre nom
 * peut être hors du workspace.
 */
function openFileAt(dirFd, name, shown) {
  let fd;
  // O_NONBLOCK : un tube nommé posé là ne doit pas bloquer le serveur.
  try { fd = fs.openSync(viaFd(dirFd, name), O_RDONLY | O_NOFOLLOW | O_NONBLOCK); }
  catch (e) { throw openError(e, dirFd, name, shown); }
  const st = fs.fstatSync(fd);
  if (!st.isFile()) { fs.closeSync(fd); throw new Error(`Pas un fichier : ${shown}`); }
  if (st.nlink > 1) { fs.closeSync(fd); throw new Error(`Lien dur refusé : ${shown} — ce fichier a ${st.nlink} noms, l'hôte ne lit que les fichiers qui n'en ont qu'un ; copie-le avec run_python (shutil.copyfile) puis vise la copie`); }
  return fd;
}

/** Chemin relatif à /work (ou absolu /work/...) → composants dans le workspace, ou erreur. */
function workspaceParts(p) {
  const rel = String(p ?? "").replace(/^\/work\/?/, "").replace(/^\.\/+/, "");
  const abs = path.resolve(WORKSPACE_DIR, rel);
  if (abs !== WORKSPACE_DIR && !abs.startsWith(WORKSPACE_DIR + path.sep)) throw new Error(`Chemin hors du workspace : ${p}`);
  return path.relative(WORKSPACE_DIR, abs).split(path.sep).filter(Boolean);
}

/** Ouvre en lecture un fichier du workspace. Rend { fd, rel } ; à l'appelant de fermer fd. */
function openWorkspaceFile(p) {
  const parts = workspaceParts(p);
  if (!parts.length) throw new Error("Pas un fichier");
  const rel = parts.join("/");
  const dirFd = openDir(parts.slice(0, -1));
  try { return { fd: openFileAt(dirFd, parts[parts.length - 1], `/work/${rel}`), rel }; }
  finally { fs.closeSync(dirFd); }
}

/**
 * Ouvre en lecture un fichier d'une skill montée. Le conteneur ne peut pas
 * écrire dans /skills (montage en lecture seule, dossier synchronisé par
 * l'hôte) : le chemin réel suffit, revérifié une fois les liens résolus.
 */
function openSkillFile(p) {
  const root = fs.realpathSync(SKILLS_DIR);
  const abs = path.resolve(SKILLS_DIR, String(p).replace(/^\/?skills\//, ""));
  if (!abs.startsWith(SKILLS_DIR + path.sep)) throw new Error(`Chemin hors des skills : ${p}`);
  const real = fs.realpathSync(abs);
  if (!real.startsWith(root + path.sep)) throw new Error(`Chemin hors des skills : ${p}`);
  const fd = fs.openSync(real, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  if (!fs.fstatSync(fd).isFile()) { fs.closeSync(fd); throw new Error("Pas un fichier"); }
  return { fd, key: real };
}

/**
 * Parcourt le workspace par descripteurs. `onDir(fd, rel)` reçoit chaque
 * dossier ouvert, `onEntry(dirFd, name, rel, st)` chaque autre entrée avec son
 * lstat ; rendre false arrête le parcours. Un lien n'est jamais traversé.
 */
function walkWorkspace({ onDir = null, onEntry, skipHidden = false }) {
  const walk = (dirFd, rel) => {
    if (onDir) onDir(dirFd, rel);
    let entries;
    try { entries = fs.readdirSync(`/proc/self/fd/${dirFd}`, { withFileTypes: true }); } catch { return true; }
    for (const e of entries) {
      if (skipHidden && e.name.startsWith(".")) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        let fd;
        try { fd = fs.openSync(viaFd(dirFd, e.name), O_RDONLY | O_DIRECTORY | O_NOFOLLOW); } catch { continue; }
        try { if (!walk(fd, r)) return false; } finally { fs.closeSync(fd); }
      } else {
        let st;
        try { st = fs.lstatSync(viaFd(dirFd, e.name)); } catch { continue; /* vanished */ }
        if (onEntry(dirFd, e.name, r, st) === false) return false;
      }
    }
    return true;
  };
  const root = openDir();
  try { walk(root, ""); } finally { fs.closeSync(root); }
}

/**
 * Rend un fichier ordinaire au conteneur, par son descripteur : ce qui est
 * vérifié est ce qui est rendu. Ni lien symbolique, ni lien dur.
 */
function giveFile(dirFd, name, rel) {
  let fd;
  try { fd = fs.openSync(viaFd(dirFd, name), O_RDONLY | O_NOFOLLOW | O_NONBLOCK); } catch { return; }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.uid === SANDBOX_UID) return;
    if (st.nlink > 1) { console.error(`[mcp-sandbox] lien dur laissé tel quel (${st.nlink} noms) : /work/${rel}`); return; }
    fs.fchownSync(fd, SANDBOX_UID, SANDBOX_UID);
  } finally { fs.closeSync(fd); }
}

/**
 * Dossiers attendus, puis tout le workspace rendu au conteneur (les dépôts du
 * consultant sont écrits par le relay, en root). fchown sur le dossier ou le
 * fichier ouvert sans suivre de lien : un lien n'est pas touché, un fichier
 * qui a un autre nom ailleurs (lien dur) non plus.
 */
function prepareWorkspace() {
  const root = openDir();
  try {
    for (const sub of ["uploads", "out"]) {
      try { fs.mkdirSync(viaFd(root, sub)); } catch (e) { if (e.code !== "EEXIST") throw e; }
    }
  } finally { fs.closeSync(root); }
  walkWorkspace({
    onDir: (fd) => { if (fs.fstatSync(fd).uid !== SANDBOX_UID) fs.fchownSync(fd, SANDBOX_UID, SANDBOX_UID); },
    onEntry: (dirFd, name, rel, st) => { if (st.isFile() && st.uid !== SANDBOX_UID) giveFile(dirFd, name, rel); },
  });
}

try { prepareWorkspace(); } catch (e) { console.error("[mcp-sandbox] préparation du workspace :", e.message); }

function listFiles() {
  const out = [];
  walkWorkspace({
    skipHidden: true,
    onEntry: (_dirFd, _name, rel, st) => {
      if (st.isFile()) out.push({ path: rel, bytes: st.size, mtime: st.mtimeMs });
      return out.length < MAX_LIST;
    },
  });
  return out;
}

// ── Plafond d'un résultat ───────────────────────────────────────────────────

const charCost = (code) => (code < 128 ? TOKENS_PER_CHAR : TOKENS_PER_WIDE_CHAR);

/** Estimation haute du poids d'un texte en tokens. */
function estimateTokens(text) {
  let n = 0;
  for (let i = 0; i < text.length; i++) n += charCost(text.charCodeAt(i));
  return Math.ceil(n);
}

/** Nombre de caractères de `text`, à partir de `from`, qui tiennent dans `budget` tokens. */
function charsWithin(text, from, budget) {
  let n = 0;
  let i = from;
  for (; i < text.length; i++) {
    n += charCost(text.charCodeAt(i));
    if (n > budget) break;
  }
  return i - from;
}

function snapshot() {
  return new Map(listFiles().map((f) => [f.path, `${f.bytes}:${Math.round(f.mtime)}`]));
}

const outputFile = (id) => path.join(STATE_DIR, `sortie-${id}.txt`);
const lastOutputFile = () => path.join(STATE_DIR, "derniere");

/**
 * Note la sortie complète d'une exécution coupée (`text`) ou le fait que la
 * dernière exécution n'a pas été coupée (`text` null). Tout est dans le dossier
 * d'état : le conteneur ne peut ni lire ces fichiers, ni les remplacer.
 */
function keepOutput(id, text) {
  if (text !== null) fs.writeFileSync(outputFile(id), text, { mode: 0o600, flag: "wx" });
  fs.writeFileSync(lastOutputFile(), text !== null ? id : "", { mode: 0o600 });
  const kept = fs.readdirSync(STATE_DIR).filter((f) => /^sortie-[a-f0-9]{12}\.txt$/.test(f))
    .map((f) => ({ f, mtime: fs.statSync(path.join(STATE_DIR, f)).mtimeMs })).sort((a, b) => b.mtime - a.mtime);
  for (const { f } of kept.slice(KEPT_OUTPUTS)) fs.unlinkSync(path.join(STATE_DIR, f));
}

/**
 * stdout/stderr d'un script → texte pour le modèle : répétitions repliées, puis
 * plafond avec début et fin. Quand le plafond coupe, la sortie complète est
 * gardée dans le dossier d'état sous l'identifiant de l'exécution, pour être
 * relue par plages sans relancer le script.
 */
function shapeOutput(stdout, stderr, outputCap, id) {
  const hint = `sortie complète : read_file sortie:${id}`;
  const out = stdout.trim() ? foldOutput(stdout).text : "";
  const err = stderr.trim() ? foldOutput(stderr).text : "";
  const full = [...(out ? [`--- stdout ---\n${out}`] : []), ...(err ? [`--- stderr ---\n${err}`] : [])];
  let parts = [];
  let cut = false;
  // Le plafond demandé est resserré tant que le résultat dépasserait celui du CLI.
  for (let cap = outputCap, errCap = STDERR_CAP; ; cap = Math.floor(cap * 0.8), errCap = Math.floor(errCap * 0.8)) {
    const o = capMiddle(out, cap, { hint });
    // La fin d'une trace d'erreur est ce qui se lit : elle garde la plus grande part.
    const e = capMiddle(err, errCap, { headRatio: 0.3, hint });
    parts = [...(out ? [`--- stdout ---\n${o.text}`] : []), ...(err ? [`--- stderr ---\n${e.text}`] : [])];
    cut = o.cut > 0 || e.cut > 0;
    if (estimateTokens(parts.join("\n\n")) <= RESULT_TOKEN_BUDGET - NOTES_TOKEN_RESERVE || cap < 1000) break;
  }
  try { keepOutput(id, cut ? full.join("\n\n") : null); } catch (e) {
    if (cut) parts.push(`(sortie complète non conservée : ${e.message} — relance avec max_output_chars=${OUTPUT_CAP_MAX} ou écris dans /work/out)`);
  }
  return parts;
}

let running = false;
// Conteneur en cours : ce que ce serveur doit arrêter s'il s'arrête lui-même.
let current = null;

const dockerKill = (name) => { try { execFileSync("docker", ["kill", name], { stdio: "ignore", timeout: 10_000 }); return true; } catch { return false; } };

/**
 * Arrêt du serveur (signal du relay, stdin fermé par le CLI) : le conteneur en
 * cours est arrêté avant de sortir, son dossier de script retiré. S'il n'est
 * pas encore né, son propre délai le bornera.
 */
let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  if (current) {
    dockerKill(current.name);
    try { current.child?.kill("SIGKILL"); } catch { /* gone */ }
    if (current.scriptDir) { try { fs.rmSync(current.scriptDir, { recursive: true, force: true }); } catch { /* ignore */ } }
  }
  process.exit(0);
}
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, shutdown);
process.stdin.on("end", shutdown);
process.stdin.on("close", shutdown);

/**
 * Au démarrage : ce qu'un serveur précédent de CE workspace a laissé. Un
 * conteneur n'est arrêté que s'il porte le nom du bac à sable, l'étiquette de
 * ce workspace et une échéance dépassée ; ceux des autres conversations, et
 * ceux de ce workspace encore dans leur délai, ne sont pas touchés. Un dossier
 * de script n'est retiré que si son conteneur ne tourne plus.
 */
function sweepLeftovers() {
  const format = `{{.Names}}\t{{.Label "${LABEL_WORKSPACE}"}}\t{{.Label "${LABEL_DEADLINE}"}}`;
  const args = ["ps", "--no-trunc", "--filter", `name=${CONTAINER_PREFIX}`, "--filter", `label=${LABEL_WORKSPACE}=${WORKSPACE_DIR}`, "--format", format];
  execFile("docker", args, { encoding: "utf8", timeout: 15_000 }, (err, stdout) => {
    const alive = new Set();
    const now = Date.now() / 1000;
    for (const line of String(stdout ?? "").split("\n")) {
      const [name, ws, deadline] = line.split("\t");
      if (!CONTAINER_NAME_RE.test(name ?? "") || ws !== WORKSPACE_DIR) continue;
      const late = /^\d+$/.test(deadline ?? "") && Number(deadline) < now;
      if (late && dockerKill(name)) console.error(`[mcp-sandbox] conteneur abandonné arrêté : ${name}`);
      else alive.add(name);
    }
    for (const d of LEFTOVER_SCRIPT_DIRS) {
      const dir = path.join(STATE_DIR, d);
      const name = `${CONTAINER_PREFIX}${SCRIPT_DIR_RE.exec(d)[1]}`;
      try {
        // Sans réponse de docker, ne part que ce qui a dépassé la plus longue durée permise.
        const old = Date.now() - fs.statSync(dir).mtimeMs > (RENDER_TIMEOUT_S + SWEEP_GRACE_S) * 1000;
        if (err ? old : !alive.has(name)) fs.rmSync(dir, { recursive: true, force: true });
      } catch { /* déjà parti */ }
    }
  });
}

/**
 * Run one command in a throwaway container. `script` (if given) is written to
 * the host state directory and shown to the container read-only on /script.
 * Seul l'appel qui a pris le verrou le rend : un appel refusé n'y touche pas.
 */
async function runInContainer(opts) {
  if (running) throw new Error("Une exécution est déjà en cours dans ce bac à sable — attends son résultat.");
  running = true;
  try { return await runLocked(opts); } finally { running = false; current = null; }
}

async function runLocked({ script = null, ext = "py", cmd, timeoutS, label = "Exécution", outputCap = OUTPUT_CAP }) {
  const id = crypto.randomBytes(6).toString("hex");
  const scriptDir = path.join(STATE_DIR, `script-${id}`);
  const scriptFile = `${id}.${ext}`;
  const name = `${CONTAINER_PREFIX}${id}`;
  const before = snapshot();
  current = { name, scriptDir: script !== null ? scriptDir : null, child: null };
  if (script !== null) {
    // Lisible par l'utilisateur du conteneur, que l'hôte soit root ou non.
    fs.mkdirSync(scriptDir, { mode: 0o755 });
    fs.chmodSync(scriptDir, 0o755);
    fs.writeFileSync(path.join(scriptDir, scriptFile), script, { mode: 0o644, flag: "wx" });
  }

  const started = Date.now();
  const args = [
    "run", "--rm", "--name", name,
    "--label", `${LABEL_WORKSPACE}=${WORKSPACE_DIR}`,
    "--label", `${LABEL_DEADLINE}=${Math.ceil(started / 1000) + timeoutS + SWEEP_GRACE_S}`,
    "--network", "none",
    "--read-only",
    "--tmpfs", `/tmp:rw,noexec,nosuid,size=512m,uid=${SANDBOX_UID},gid=${SANDBOX_UID}`,
    "--memory", MEMORY, "--memory-swap", MEMORY,
    "--cpus", CPUS,
    "--pids-limit", "256",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--user", `${SANDBOX_UID}:${SANDBOX_UID}`,
    "-v", `${WORKSPACE_DIR}:/work`,
    ...(SKILLS_DIR ? ["-v", `${SKILLS_DIR}:/skills:ro`] : []),
    ...(script !== null ? ["-v", `${scriptDir}:/script:ro`] : []),
    "-w", "/work",
    "-e", "MPLBACKEND=Agg", "-e", "MPLCONFIGDIR=/tmp/mpl", "-e", "HOME=/tmp", "-e", "XDG_CONFIG_HOME=/tmp/.config",
    // Le délai vit dans le conteneur : il vaut même si ce serveur n'est plus là.
    IMAGE, "timeout", "--signal=TERM", `--kill-after=${KILL_AFTER_S}`, String(timeoutS), ...cmd(`/script/${scriptFile}`),
  ];
  const result = await new Promise((resolve) => {
    let killed = false;
    const child = execFile("docker", args, { maxBuffer: 8 * 1024 * 1024, encoding: "utf8" }, (err, stdout, stderr) => {
      resolve({ err, stdout: stdout ?? "", stderr: stderr ?? "", killed });
    });
    current.child = child;
    // Filet de l'hôte, pour un conteneur qui ne démarre pas ou ne s'arrête pas seul.
    const timer = setTimeout(() => {
      killed = true;
      execFile("docker", ["kill", name], () => {});
      setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } }, 3000);
    }, (timeoutS + HOST_GRACE_S) * 1000);
    child.on("exit", () => clearTimeout(timer));
  });
  if (script !== null) { try { fs.rmSync(scriptDir, { recursive: true, force: true }); } catch { /* ignore */ } }

  const after = snapshot();
  const changed = [];
  for (const [p, sig] of after) if (before.get(p) !== sig) changed.push(p);
  const elapsedMs = Date.now() - started;
  const elapsed = (elapsedMs / 1000).toFixed(1);
  const parts = [];
  const exitCode = result.err && typeof result.err.code === "number" ? result.err.code : (result.err ? -1 : 0);
  // `timeout` sort en 124 quand SIGTERM a suffi, en 137 quand il a fallu SIGKILL.
  const timedOut = result.killed || ((exitCode === 124 || exitCode === 137) && elapsedMs >= timeoutS * 1000);
  if (timedOut) parts.push(`⏱ ${label} interrompue après ${timeoutS} s (délai dépassé). Réduis le volume de données ou découpe le traitement.`);
  else if (exitCode > 0) parts.push(`Code de sortie ${exitCode} (${elapsed} s)`);
  else if (result.err) parts.push(`Erreur de lancement : ${result.err.message}`);
  else parts.push(`OK (${elapsed} s)`);
  parts.push(...shapeOutput(result.stdout, result.stderr, outputCap, id));
  if (changed.length) {
    parts.push(`--- fichiers écrits/modifiés ---\n${changed.map((p) => `/work/${p} (${fmtBytes(after.has(p) ? Number(after.get(p).split(":")[0]) : 0)})`).join("\n")}`);
  }
  return { text: parts.join("\n\n"), ok: !timedOut && exitCode === 0, changed };
}

const runPython = (code, timeoutS, outputCap) =>
  runInContainer({ script: code, ext: "py", cmd: (file) => ["python3", file], timeoutS, outputCap }).then((r) => r.text);
const runNode = (code, timeoutS, outputCap) =>
  runInContainer({ script: code, ext: "js", cmd: (file) => ["node", file], timeoutS, outputCap }).then((r) => r.text);

const OUTPUT_RULES = `seul stdout/stderr revient, répétitions repliées, coupé au milieu au-delà de ${OUTPUT_CAP} caractères (max_output_chars pour plus ; la sortie coupée reste lisible en entier par read_file, sous le nom sortie:<id> donné à l'endroit de la coupe)`;
const outputCapShape = z.number().int().min(1000).max(OUTPUT_CAP_MAX).optional().describe(`Caractères max de stdout renvoyés (défaut ${OUTPUT_CAP})`);

/**
 * PPTX/DOCX/XLSX → PDF (LibreOffice) → JPEG pages (pdftoppm) written next to the
 * source as out/<base>-p01.jpg…, and returned as images so the model can do its
 * visual QA. `pages` limits which pages come back (1-based, inclusive).
 */
async function renderDocument(relPath, firstPage, lastPage) {
  let rel;
  try {
    const f = openWorkspaceFile(relPath);
    fs.closeSync(f.fd);
    rel = f.rel;
  } catch (e) {
    throw new Error(e.code === "ENOENT" || /^ENOENT/.test(e.message) ? `Fichier introuvable : ${relPath}` : e.message);
  }
  if (!/\.(pptx|docx|xlsx|odp|odt|pdf)$/i.test(rel)) throw new Error("Formats acceptés : .pptx, .docx, .xlsx, .pdf");
  const base = path.posix.basename(rel).replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 60);
  const isPdf = /\.pdf$/i.test(rel);
  const first = Math.max(1, firstPage ?? 1);
  const last = Math.min(first + RENDER_MAX_PAGES - 1, lastPage ?? first + RENDER_MAX_PAGES - 1);
  const prefix = `/work/out/${base}-p`;
  // Old previews of the same document go away so the model never reads stale pages.
  // unlink ne suit pas un lien, et le dossier est tenu par son descripteur.
  const stale = openDir(["out"]);
  try { for (const f of fs.readdirSync(`/proc/self/fd/${stale}`)) if (f.startsWith(`${base}-p`) && f.endsWith(".jpg")) fs.unlinkSync(viaFd(stale, f)); } catch { /* none */ } finally { fs.closeSync(stale); }
  // Le nom du document et le préfixe des pages sont des arguments ($1, $2) : le
  // shell du conteneur ne les interprète pas, quels que soient leurs caractères.
  const sh = isPdf
    ? `pdftoppm -jpeg -jpegopt quality=72 -r 50 -scale-to 1100 -f "$3" -l "$4" "$1" "$2" && pdfinfo "$1" | grep -i '^Pages'`
    : `mkdir -p /tmp/render && cd /tmp/render && soffice --headless --norestore --convert-to pdf --outdir /tmp/render "$1" >/tmp/render/soffice.log 2>&1; ` +
      `PDF=$(ls /tmp/render/*.pdf 2>/dev/null | head -1); if [ -z "$PDF" ]; then echo "Conversion PDF échouée"; cat /tmp/render/soffice.log; exit 2; fi; ` +
      `pdfinfo "$PDF" | grep -i '^Pages'; pdftoppm -jpeg -jpegopt quality=72 -r 50 -scale-to 1100 -f "$3" -l "$4" "$PDF" "$2"`;
  const r = await runInContainer({ cmd: () => ["sh", "-c", sh, "rendu", `/work/${rel}`, prefix, String(first), String(last)], timeoutS: RENDER_TIMEOUT_S, label: "Rendu" });
  const images = [];
  const skipped = [];
  let lastSeen = 0;
  let outDir = -1;
  try {
    // pdftoppm pads page numbers according to the page count: normalise to -pNN.
    // Le conteneur vient de tourner : out est rouvert, et vérifié, après lui.
    outDir = openDir(["out"]);
    const files = fs.readdirSync(`/proc/self/fd/${outDir}`).filter((f) => f.startsWith(`${base}-p`) && f.endsWith(".jpg"));
    const numbered = files.map((f) => ({ f, n: Number(/-p-?(\d+)\.jpg$/.exec(f)?.[1] ?? 0) })).filter((x) => x.n > 0).sort((a, b) => a.n - b.n);
    for (const { f, n } of numbered) {
      lastSeen = n;
      // Une page fautive (lien, image démesurée) est écartée, les autres restent.
      try {
        const name = `${base}-p${String(n).padStart(2, "0")}.jpg`;
        if (name !== f) fs.renameSync(viaFd(outDir, f), viaFd(outDir, name));
        const fd = openFileAt(outDir, name, `/work/out/${name}`);
        try {
          const size = fs.fstatSync(fd).size;
          if (size > RENDER_MAX_IMAGE_BYTES) throw new Error(`image de ${fmtBytes(size)}, au-delà des ${fmtBytes(RENDER_MAX_IMAGE_BYTES)} renvoyés par page`);
          // Lecture bornée à la taille constatée : un fichier qui grossit n'est pas suivi.
          const buf = Buffer.alloc(size);
          images.push({ name, page: n, data: buf.subarray(0, fs.readSync(fd, buf, 0, size, 0)) });
        } finally { fs.closeSync(fd); }
      } catch (e) { skipped.push(`page ${n} ignorée : ${e.message}`); }
    }
  } catch (e) { skipped.push(`dossier /work/out illisible : ${e.message}`); } finally { if (outDir !== -1) fs.closeSync(outDir); }
  const pagesMatch = /Pages:\s+(\d+)/.exec(r.text);
  const total = pagesMatch ? Number(pagesMatch[1]) : null;
  const lastShown = images.length ? images[images.length - 1].page : 0;
  const nextPage = lastSeen + 1;
  const pagesShown = skipped.length ? `pages ${images.map((i) => i.page).join(", ")}` : `pages ${first}–${lastShown}`;
  const notes = skipped.length ? `\n${skipped.join("\n")}` : "";
  const header = images.length
    ? `Rendu de /work/${rel}${total ? ` — ${total} page(s) au total` : ""}, ${pagesShown} ci-dessous (fichiers ${images.map((i) => `/work/out/${i.name}`).join(", ")}).` +
      (total && total >= nextPage ? ` Pour la suite : render_pptx avec first_page=${nextPage}.` : "") +
      " Inspecte chaque page : débordements de texte, chevauchements, logos déformés, titres qui racontent l'histoire." + notes
    : `Aucune page rendue.${notes}\n${r.text}`;
  return { header, images, log: r.text };
}

// ── MCP ─────────────────────────────────────────────────────────────────────
const server = new McpServer({ name: "sandbox", version: "1.0.0" });

server.registerTool(
  "run_python",
  {
    title: "Exécuter du Python",
    description:
      "Exécute un script Python 3.12 dans un bac à sable isolé (sans réseau) avec pandas, numpy, scipy, matplotlib, openpyxl, xlsxwriter, pypdf, python-docx, python-pptx, pyarrow, pillow. " +
      (SKILLS_DIR ? "Les skills HQ de l'agence sont montées en lecture seule sous /skills/<slug>/ (SKILL.md + dossier assets/ : logos, fonds, barres dégradées de la DA Impulse) — utilise ces fichiers tels quels, ne les recrée jamais en formes. " : "") +
      "Dossier courant /work : les fichiers partagés par le consultant sont dans /work/uploads ; écris TOUTES tes sorties dans /work/out (graphiques PNG via plt.savefig, exports .xlsx/.csv). " +
      "Pour afficher un graphique ou proposer un fichier au consultant, référence-le ensuite dans ta réponse comme ![titre](sandbox:out/nom.png) ou [nom.xlsx](sandbox:out/nom.xlsx). " +
      `Imprime (print) ce que tu veux lire, sans verbiage : ${OUTPUT_RULES}. Les variables ne persistent pas entre deux appels : relis tes fichiers.`,
    inputSchema: {
      code: z.string().min(1).max(200_000).describe("Script Python complet à exécuter"),
      timeout_s: z.number().int().min(5).max(300).optional().describe(`Délai max en secondes (défaut ${TIMEOUT_S})`),
      max_output_chars: outputCapShape,
    },
  },
  async ({ code, timeout_s, max_output_chars }) => {
    try {
      const text = await runPython(code, Math.min(timeout_s ?? TIMEOUT_S, TIMEOUT_S), max_output_chars);
      return { content: [{ type: "text", text }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Erreur : ${e.message}` }], isError: true };
    }
  },
);

server.registerTool(
  "run_node",
  {
    title: "Exécuter du Node.js",
    description:
      "Exécute un script Node.js 20 (CommonJS : require) dans le même bac à sable isolé que run_python, avec pptxgenjs préinstallé (require('pptxgenjs')). " +
      "C'est l'outil pour produire un deck PowerPoint à la DA Impulse : suis la skill HQ slides-impulse (hq_skill_get) en réutilisant ses helpers tels quels, " +
      (SKILLS_DIR ? "avec ASSETS = '/skills/slides-impulse/assets' (fonds, logos, badges, barres dégradées officiels, montés en lecture seule). " : "") +
      "Écris le .pptx dans /work/out (pres.writeFile({ fileName: '/work/out/nom.pptx' })), puis appelle render_pptx pour le QA visuel avant de proposer le fichier au consultant avec [nom.pptx](sandbox:out/nom.pptx). " +
      `Mêmes règles que run_python : sans réseau (pas de npm install), ${OUTPUT_RULES}, rien ne persiste entre deux appels sauf les fichiers.`,
    inputSchema: {
      code: z.string().min(1).max(200_000).describe("Script Node.js complet à exécuter"),
      timeout_s: z.number().int().min(5).max(300).optional().describe(`Délai max en secondes (défaut ${TIMEOUT_S})`),
      max_output_chars: outputCapShape,
    },
  },
  async ({ code, timeout_s, max_output_chars }) => {
    try {
      const text = await runNode(code, Math.min(timeout_s ?? TIMEOUT_S, TIMEOUT_S), max_output_chars);
      return { content: [{ type: "text", text }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Erreur : ${e.message}` }], isError: true };
    }
  },
);

server.registerTool(
  "render_pptx",
  {
    title: "Rendre un document en images",
    description:
      "Convertit un .pptx (ou .docx/.xlsx/.pdf) du workspace en images de pages via LibreOffice et te les RENVOIE pour inspection visuelle (polices Mulish et Open Sans installées). " +
      `Jusqu'à ${RENDER_MAX_PAGES} pages par appel (first_page/last_page pour la suite). Les images sont aussi écrites dans /work/out/<nom>-pNN.jpg : tu peux en montrer une au consultant avec ![Slide 3](sandbox:out/<nom>-p03.jpg). ` +
      "QA visuel obligatoire avant de livrer un deck : regarde chaque page, corrige le script (débordements, chevauchements, logos déformés, titres = messages), régénère, re-rends.",
    inputSchema: {
      path: z.string().min(1).max(500).describe("Chemin relatif à /work, ex. out/monthly-octobre.pptx"),
      first_page: z.number().int().min(1).optional().describe("Première page à renvoyer (défaut 1)"),
      last_page: z.number().int().min(1).optional().describe(`Dernière page (défaut first_page + ${RENDER_MAX_PAGES - 1})`),
    },
  },
  async ({ path: p, first_page, last_page }) => {
    try {
      const r = await renderDocument(p, first_page, last_page);
      const content = [{ type: "text", text: r.header }];
      for (const im of r.images) {
        content.push({ type: "text", text: `Page ${im.page} :` });
        content.push({ type: "image", data: im.data.toString("base64"), mimeType: "image/jpeg" });
      }
      if (!r.images.length) return { content, isError: true };
      return { content };
    } catch (e) {
      return { content: [{ type: "text", text: `Erreur : ${e.message}` }], isError: true };
    }
  },
);

// Ce que ce processus a déjà renvoyé au modèle : plages de fichiers, liste des skills.
const readLedger = createReadLedger();
let skillsShown = "";

function mountedSkills() {
  const skills = [];
  try {
    for (const e of fs.readdirSync(SKILLS_DIR, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith(".")) continue;
      skills.push({ name: e.name, assets: fs.existsSync(path.join(SKILLS_DIR, e.name, "assets")) });
    }
  } catch { /* none */ }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

server.registerTool(
  "list_files",
  {
    title: "Lister le workspace",
    description: "Liste les fichiers du workspace de la conversation, groupés par dossier avec leur taille (/work/uploads = fichiers partagés par le consultant, /work/out = tes sorties)" +
      (SKILLS_DIR ? ", puis le nom des skills HQ montées sous /skills (déjà listées et inchangées : une mention courte, skills=true pour les revoir ; skills=false pour ne pas les lister)." : "."),
    inputSchema: {
      skills: z.boolean().optional().describe("true : relister les skills même si déjà listées ; false : fichiers du workspace seulement"),
    },
  },
  async ({ skills }) => {
    const files = listFiles();
    let text = files.length
      ? renderFileList(files, { root: "/work", truncatedAt: MAX_LIST })
      : "(workspace vide — aucun fichier partagé ni produit pour l'instant)";
    if (SKILLS_DIR && skills !== false) {
      const mounted = mountedSkills();
      if (mounted.length) {
        const rendered = renderSkillList(mounted);
        text += skills !== true && rendered === skillsShown
          ? `\n\n--- ${mounted.length} skills HQ sous /skills : liste inchangée, déjà donnée plus haut (skills=true pour la revoir) ---`
          : `\n\n${rendered}`;
        skillsShown = rendered;
      }
    }
    return { content: [{ type: "text", text }] };
  },
);

/** Lit un fichier texte déjà ouvert (8 Mo au plus) ; refuse le binaire. */
function readTextFile(fd, st) {
  let buf = Buffer.alloc(Math.min(st.size, READ_MAX_BYTES));
  const n = fs.readSync(fd, buf, 0, buf.length, 0);
  buf = buf.subarray(0, n);
  const text = buf.toString("utf8");
  if (text.includes("�") && /[\x00-\x08]/.test(text)) throw new Error("Fichier binaire — utilise run_python pour le lire");
  return text;
}

/**
 * Chemin demandé → fichier ouvert en lecture : sortie conservée d'une
 * exécution, skill montée ou fichier du workspace. `key` l'identifie dans le
 * registre des lectures, `json` dit s'il peut être minifié. `notice` remplace
 * le fichier quand il n'y a rien à ouvrir.
 */
function openForRead(p) {
  const raw = String(p ?? "");
  const named = OUTPUT_PATH_RE.exec(raw.trim());
  const isAlias = !named && raw.replace(/^\/work\/?/, "").replace(/^\.\/+/, "") === LAST_OUTPUT_ALIAS;
  if (named || isAlias) {
    let id = named ? named[1] : "";
    if (isAlias) { try { id = fs.readFileSync(lastOutputFile(), "utf8").trim(); } catch { /* aucune exécution */ } }
    if (isAlias && !id) return { notice: "La dernière exécution n'a pas été coupée : sa sortie est en entier dans son résultat, plus haut. La sortie complète d'une exécution coupée se relit sous le nom sortie:<id> donné à l'endroit de la coupe." };
    try { return { fd: fs.openSync(outputFile(id), O_RDONLY | O_NOFOLLOW), key: `sortie:${id}`, json: false }; }
    catch { throw new Error(`Sortie sortie:${id} introuvable : seules les ${KEPT_OUTPUTS} dernières sorties coupées sont gardées — relance le script`); }
  }
  if (SKILLS_DIR && /^\/?skills\//.test(raw)) {
    const f = openSkillFile(raw);
    return { ...f, json: /\.json$/i.test(f.key) };
  }
  const f = openWorkspaceFile(raw);
  return { fd: f.fd, key: path.join(WORKSPACE_DIR, f.rel), json: /\.json$/i.test(f.rel) };
}

server.registerTool(
  "read_file",
  {
    title: "Lire un fichier texte",
    description: "Lit un fichier texte du workspace (CSV, TXT, MD, JSON…)" + (SKILLS_DIR ? " ou d'une skill montée (/skills/<slug>/SKILL.md)" : "") +
      ` par plage : ${READ_CAP} caractères par défaut depuis le début, coupés en fin de ligne ; la réponse indique la taille totale et le paramètre à passer pour la suite (start_line ou start_char). ` +
      `Une plage ne dépasse jamais ce qu'un résultat peut porter (environ ${Math.floor((RESULT_TOKEN_BUDGET - NOTES_TOKEN_RESERVE) / TOKENS_PER_CHAR / 1000)} 000 caractères, moins pour un texte non latin), quel que soit max_chars. ` +
      "Le chemin sortie:<id> relit la sortie complète d'un script coupé. Les liens symboliques ne sont pas suivis. " +
      "Pour un gros CSV, lis l'en-tête et quelques lignes (max_lines) puis calcule avec run_python. Un fichier JSON indenté lu en entier est renvoyé minifié (mêmes données). " +
      "Une plage déjà lue d'un fichier inchangé n'est pas renvoyée une seconde fois : force=true si tu n'as plus son contenu sous les yeux. Pour un Excel, un PDF ou un Word, passe plutôt par run_python.",
    inputSchema: {
      path: z.string().min(1).max(500).describe("Chemin relatif à /work, ex. uploads/ventes.csv" + (SKILLS_DIR ? ", ou /skills/<slug>/SKILL.md" : "")),
      max_chars: z.number().int().min(200).max(READ_CAP_MAX).optional().describe(`Caractères max (défaut ${READ_CAP} ; ramené à ce qu'un résultat peut porter)`),
      start_line: z.number().int().min(1).optional().describe("Première ligne à lire (1 = début)"),
      max_lines: z.number().int().min(1).optional().describe("Nombre de lignes max"),
      start_char: z.number().int().min(0).optional().describe("Départ en caractères, à la place de start_line (donné par la réponse quand une ligne est très longue)"),
      force: z.boolean().optional().describe("true : renvoyer le contenu même s'il a déjà été lu"),
    },
  },
  async ({ path: p, max_chars, start_line, max_lines, start_char, force }) => {
    try {
      const target = openForRead(p);
      if (target.notice) return { content: [{ type: "text", text: target.notice }] };
      let st;
      let raw;
      // Taille, date et contenu viennent du même descripteur : celui qui a été vérifié.
      try {
        st = fs.fstatSync(target.fd);
        raw = readTextFile(target.fd, st);
      } finally { fs.closeSync(target.fd); }
      const signature = `${st.size}:${Math.round(st.mtimeMs)}`;
      const budget = RESULT_TOKEN_BUDGET - NOTES_TOKEN_RESERVE;
      const asked = max_chars ?? READ_CAP;
      const fromStart = !start_line && !start_char && !max_lines;

      // JSON indenté lu depuis le début : la version minifiée, si elle tient dans le plafond.
      let view = "brut";
      let text = raw;
      const notes = [];
      if (fromStart && target.json && st.size <= READ_MAX_BYTES) {
        const min = renderJson(raw, { table: false });
        if (min.stats.mode === "minified" && min.text.length < raw.length && min.text.length <= asked && estimateTokens(min.text) <= budget) {
          view = "json";
          text = min.text;
          notes.push(`[JSON minifié : ${raw.length} caractères indentés sur le disque]`);
        }
      }
      // Le plafond en caractères dépend de ce que pèse la plage demandée : une
      // première découpe dit où elle commence, la seconde la ramène au budget.
      const req = { startLine: start_line, startChar: start_char, maxLines: max_lines };
      const probe = sliceText(text, { ...req, maxChars: asked });
      const fits = charsWithin(text, probe.from, budget);
      const s = fits < probe.to - probe.from ? sliceText(text, { ...req, maxChars: fits }) : probe;
      const key = `${target.key}#${view}`;
      if (!force && readLedger.covers(key, signature, s.from, s.to)) {
        const what = s.complete ? `en entier (${s.totalLines} lignes, ${s.totalChars} caractères)` : `lignes ${s.firstLine}–${s.lastLine} sur ${s.totalLines}`;
        return { content: [{ type: "text", text: `Déjà lu plus haut dans cette conversation, ${what}, et le fichier n'a pas changé depuis : reprends ce contenu. S'il n'est plus sous tes yeux, rappelle avec force=true.` }] };
      }
      const note = sliceNote(s);
      if (note) notes.push(note);
      if (st.size > READ_MAX_BYTES) notes.push(`[fichier de ${fmtBytes(st.size)} : seuls les ${fmtBytes(READ_MAX_BYTES)} du début sont lisibles ici — au-delà, run_python]`);
      const body = s.text + (notes.length ? `${s.text && !s.text.endsWith("\n") ? "\n" : ""}${notes.join("\n")}` : "");
      // N'est tenu pour lu que ce qui a pu être rendu : un résultat au-delà du
      // plafond du CLI n'arrive pas au modèle.
      if (s.to > s.from && estimateTokens(body) <= RESULT_TOKEN_BUDGET) readLedger.record(key, signature, s.from, s.to);
      return { content: [{ type: "text", text: body }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Erreur : ${e.message}` }], isError: true };
    }
  },
);

sweepLeftovers();

const transport = new StdioServerTransport();
await server.connect(transport);
