#!/usr/bin/env node
/**
 * MCP stdio "sandbox" — exécution de Python isolée pour l'IA interne (staff).
 *
 * Lancé par le relay (server/relay.mjs) avec, en env :
 *   WORKSPACE_DIR   — dossier de travail de la conversation (monté en /work)
 *   SANDBOX_IMAGE   — image Docker (défaut impulsemotion-sandbox:latest,
 *                     voir server/sandbox/Dockerfile)
 *   SANDBOX_TIMEOUT_S, SANDBOX_MEMORY, SANDBOX_CPUS — limites (90 s, 768m, 0.8)
 *
 * Chaque run_python démarre un conteneur jetable : pas de réseau, système de
 * fichiers en lecture seule sauf /work (le workspace) et /tmp, utilisateur
 * non privilégié, toutes les capabilities retirées, limites CPU/RAM/PIDs,
 * tué au-delà du délai. Le code du modèle ne voit donc que le workspace de
 * sa conversation : les fichiers déposés par le consultant (/work/uploads)
 * et ses propres sorties (/work/out), que le relay sert ensuite au navigateur.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const WORKSPACE_DIR = process.env.WORKSPACE_DIR || "";
const IMAGE = process.env.SANDBOX_IMAGE || "impulsemotion-sandbox:latest";
const TIMEOUT_S = clampInt(process.env.SANDBOX_TIMEOUT_S, 10, 300, 90);
const MEMORY = process.env.SANDBOX_MEMORY || "768m";
const CPUS = process.env.SANDBOX_CPUS || "0.8";
// uid of the "sandbox" user baked into the image; the workspace is chowned to it.
const SANDBOX_UID = 1000;
const OUTPUT_CAP = 30_000;
const READ_CAP = 60_000;
const MAX_LIST = 300;

if (!WORKSPACE_DIR || !path.isAbsolute(WORKSPACE_DIR)) {
  console.error("[mcp-sandbox] WORKSPACE_DIR absente ou relative — refus de démarrer");
  process.exit(1);
}
for (const sub of ["uploads", "out", ".run"]) fs.mkdirSync(path.join(WORKSPACE_DIR, sub), { recursive: true });
try { chownTree(WORKSPACE_DIR); } catch (e) { console.error("[mcp-sandbox] chown:", e.message); }

function clampInt(v, min, max, dflt) {
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : dflt;
}

function chownTree(dir) {
  fs.chownSync(dir, SANDBOX_UID, SANDBOX_UID);
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) chownTree(p);
    else fs.chownSync(p, SANDBOX_UID, SANDBOX_UID);
  }
}

/** Resolve a /work-relative (or absolute /work/...) path inside the workspace, or throw. */
function inWorkspace(p) {
  const rel = String(p ?? "").replace(/^\/work\/?/, "").replace(/^\.\/+/, "");
  const abs = path.resolve(WORKSPACE_DIR, rel);
  if (abs !== WORKSPACE_DIR && !abs.startsWith(WORKSPACE_DIR + path.sep)) throw new Error(`Chemin hors du workspace : ${p}`);
  return abs;
}

function capText(text, cap = OUTPUT_CAP) {
  if (text.length <= cap) return text;
  const head = Math.floor(cap * 0.7);
  return `${text.slice(0, head)}\n…[${text.length - cap} caractères tronqués]…\n${text.slice(-(cap - head))}`;
}

function listFiles(root, prefix = "") {
  const out = [];
  const walk = (dir, rel) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === ".run" || e.name.startsWith(".")) continue;
      const abs = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(abs, r);
      else {
        try {
          const st = fs.statSync(abs);
          out.push({ path: r, bytes: st.size, mtime: st.mtimeMs });
        } catch { /* vanished */ }
      }
      if (out.length >= MAX_LIST) return;
    }
  };
  walk(root, prefix);
  return out;
}

function snapshot() {
  return new Map(listFiles(WORKSPACE_DIR).map((f) => [f.path, `${f.bytes}:${Math.round(f.mtime)}`]));
}

function fmtBytes(n) {
  if (n < 1024) return `${n} o`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} Ko`;
  return `${(n / 1024 / 1024).toFixed(1)} Mo`;
}

let running = false;

async function runPython(code, timeoutS) {
  if (running) throw new Error("Une exécution est déjà en cours dans ce bac à sable — attends son résultat.");
  running = true;
  const id = crypto.randomBytes(6).toString("hex");
  const scriptRel = path.posix.join(".run", `${id}.py`);
  const scriptAbs = path.join(WORKSPACE_DIR, scriptRel);
  const name = `im-sb-${id}`;
  const before = snapshot();
  fs.writeFileSync(scriptAbs, code, { mode: 0o644 });
  try { fs.chownSync(scriptAbs, SANDBOX_UID, SANDBOX_UID); } catch { /* best effort */ }

  const args = [
    "run", "--rm", "--name", name,
    "--network", "none",
    "--read-only",
    "--tmpfs", `/tmp:rw,noexec,nosuid,size=256m,uid=${SANDBOX_UID},gid=${SANDBOX_UID}`,
    "--memory", MEMORY, "--memory-swap", MEMORY,
    "--cpus", CPUS,
    "--pids-limit", "128",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--user", `${SANDBOX_UID}:${SANDBOX_UID}`,
    "-v", `${WORKSPACE_DIR}:/work`,
    "-w", "/work",
    "-e", "MPLBACKEND=Agg", "-e", "MPLCONFIGDIR=/tmp/mpl", "-e", "HOME=/tmp",
    IMAGE, "python3", `/work/${scriptRel}`,
  ];
  const started = Date.now();
  const result = await new Promise((resolve) => {
    let killed = false;
    const child = execFile("docker", args, { maxBuffer: 8 * 1024 * 1024, encoding: "utf8" }, (err, stdout, stderr) => {
      resolve({ err, stdout: stdout ?? "", stderr: stderr ?? "", killed });
    });
    const timer = setTimeout(() => {
      killed = true;
      execFile("docker", ["kill", name], () => {});
      setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } }, 3000);
    }, timeoutS * 1000);
    child.on("exit", () => clearTimeout(timer));
  });
  running = false;
  try { fs.unlinkSync(scriptAbs); } catch { /* ignore */ }

  const after = snapshot();
  const changed = [];
  for (const [p, sig] of after) if (before.get(p) !== sig) changed.push(p);
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  const parts = [];
  if (result.killed) parts.push(`⏱ Exécution interrompue après ${timeoutS} s (délai dépassé). Réduis le volume de données ou découpe le traitement.`);
  else if (result.err && typeof result.err.code === "number" && result.err.code !== 0) parts.push(`Code de sortie ${result.err.code} (${elapsed} s)`);
  else if (result.err) parts.push(`Erreur de lancement : ${result.err.message}`);
  else parts.push(`OK (${elapsed} s)`);
  if (result.stdout.trim()) parts.push(`--- stdout ---\n${capText(result.stdout)}`);
  if (result.stderr.trim()) parts.push(`--- stderr ---\n${capText(result.stderr, 8000)}`);
  if (changed.length) {
    parts.push(`--- fichiers écrits/modifiés ---\n${changed.map((p) => `/work/${p} (${fmtBytes(after.has(p) ? Number(after.get(p).split(":")[0]) : 0)})`).join("\n")}`);
  }
  return parts.join("\n\n");
}

// ── MCP ─────────────────────────────────────────────────────────────────────
const server = new McpServer({ name: "sandbox", version: "1.0.0" });

server.registerTool(
  "run_python",
  {
    title: "Exécuter du Python",
    description:
      "Exécute un script Python 3.12 dans un bac à sable isolé (sans réseau) avec pandas, numpy, scipy, matplotlib, openpyxl, xlsxwriter, pypdf, python-docx, python-pptx, pyarrow. " +
      "Dossier courant /work : les fichiers partagés par le consultant sont dans /work/uploads ; écris TOUTES tes sorties dans /work/out (graphiques PNG via plt.savefig, exports .xlsx/.csv). " +
      "Pour afficher un graphique ou proposer un fichier au consultant, référence-le ensuite dans ta réponse comme ![titre](sandbox:out/nom.png) ou [nom.xlsx](sandbox:out/nom.xlsx). " +
      "Imprime (print) ce que tu veux lire : seul stdout/stderr revient, tronqué au-delà de 30 000 caractères. Les variables ne persistent pas entre deux appels : relis tes fichiers.",
    inputSchema: {
      code: z.string().min(1).max(200_000).describe("Script Python complet à exécuter"),
      timeout_s: z.number().int().min(5).max(300).optional().describe(`Délai max en secondes (défaut ${TIMEOUT_S})`),
    },
  },
  async ({ code, timeout_s }) => {
    try {
      const text = await runPython(code, Math.min(timeout_s ?? TIMEOUT_S, TIMEOUT_S));
      return { content: [{ type: "text", text }] };
    } catch (e) {
      running = false;
      return { content: [{ type: "text", text: `Erreur : ${e.message}` }], isError: true };
    }
  },
);

server.registerTool(
  "list_files",
  {
    title: "Lister le workspace",
    description: "Liste les fichiers du workspace de la conversation (/work/uploads = fichiers partagés par le consultant, /work/out = tes sorties) avec leur taille.",
    inputSchema: {},
  },
  async () => {
    const files = listFiles(WORKSPACE_DIR);
    const text = files.length
      ? files.map((f) => `/work/${f.path} — ${fmtBytes(f.bytes)}`).join("\n")
      : "(workspace vide — aucun fichier partagé ni produit pour l'instant)";
    return { content: [{ type: "text", text }] };
  },
);

server.registerTool(
  "read_file",
  {
    title: "Lire un fichier texte",
    description: "Lit un fichier texte du workspace (CSV, TXT, MD, JSON…) et en renvoie le contenu, tronqué à max_chars. Pour un Excel, un PDF ou un Word, passe plutôt par run_python.",
    inputSchema: {
      path: z.string().min(1).max(500).describe("Chemin relatif à /work, ex. uploads/ventes.csv"),
      max_chars: z.number().int().min(200).max(READ_CAP).optional().describe(`Caractères max (défaut ${READ_CAP})`),
    },
  },
  async ({ path: p, max_chars }) => {
    try {
      const abs = inWorkspace(p);
      const st = fs.statSync(abs);
      if (!st.isFile()) throw new Error("Pas un fichier");
      const fd = fs.openSync(abs, "r");
      const cap = max_chars ?? READ_CAP;
      const buf = Buffer.alloc(Math.min(st.size, cap * 4));
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      let text = buf.subarray(0, n).toString("utf8");
      if (text.includes("�") && /[\x00-\x08]/.test(text)) throw new Error("Fichier binaire — utilise run_python pour le lire");
      const truncated = text.length > cap || st.size > buf.length;
      if (text.length > cap) text = text.slice(0, cap);
      return { content: [{ type: "text", text: text + (truncated ? `\n…[tronqué — ${fmtBytes(st.size)} au total]` : "") }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Erreur : ${e.message}` }], isError: true };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
