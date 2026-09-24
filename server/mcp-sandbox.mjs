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
 *
 * Chaque run_python / run_node / render_pptx démarre un conteneur jetable : pas de réseau, système de
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
const SKILLS_DIR = process.env.SKILLS_DIR && path.isAbsolute(process.env.SKILLS_DIR) && fs.existsSync(process.env.SKILLS_DIR)
  ? process.env.SKILLS_DIR : "";
// LibreOffice cold start on one core is slow: rendering gets its own budget.
const RENDER_TIMEOUT_S = clampInt(process.env.SANDBOX_RENDER_TIMEOUT_S, 30, 600, 180);
const RENDER_MAX_PAGES = 8;
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
  const raw = String(p ?? "");
  if (SKILLS_DIR && /^\/?skills\//.test(raw)) {
    const abs = path.resolve(SKILLS_DIR, raw.replace(/^\/?skills\//, ""));
    if (!abs.startsWith(SKILLS_DIR + path.sep)) throw new Error(`Chemin hors des skills : ${p}`);
    return abs;
  }
  const rel = raw.replace(/^\/work\/?/, "").replace(/^\.\/+/, "");
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

/** Run one command in a throwaway container; `script` (if given) is written to /work/.run first. */
async function runInContainer({ script = null, ext = "py", cmd, timeoutS, label = "Exécution" }) {
  if (running) throw new Error("Une exécution est déjà en cours dans ce bac à sable — attends son résultat.");
  running = true;
  const id = crypto.randomBytes(6).toString("hex");
  const scriptRel = path.posix.join(".run", `${id}.${ext}`);
  const scriptAbs = path.join(WORKSPACE_DIR, scriptRel);
  const name = `im-sb-${id}`;
  const before = snapshot();
  if (script !== null) {
    fs.writeFileSync(scriptAbs, script, { mode: 0o644 });
    try { fs.chownSync(scriptAbs, SANDBOX_UID, SANDBOX_UID); } catch { /* best effort */ }
  }

  const args = [
    "run", "--rm", "--name", name,
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
    "-w", "/work",
    "-e", "MPLBACKEND=Agg", "-e", "MPLCONFIGDIR=/tmp/mpl", "-e", "HOME=/tmp", "-e", "XDG_CONFIG_HOME=/tmp/.config",
    IMAGE, ...cmd(scriptRel),
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
  if (script !== null) { try { fs.unlinkSync(scriptAbs); } catch { /* ignore */ } }

  const after = snapshot();
  const changed = [];
  for (const [p, sig] of after) if (before.get(p) !== sig) changed.push(p);
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  const parts = [];
  const exitCode = result.err && typeof result.err.code === "number" ? result.err.code : (result.err ? -1 : 0);
  if (result.killed) parts.push(`⏱ ${label} interrompue après ${timeoutS} s (délai dépassé). Réduis le volume de données ou découpe le traitement.`);
  else if (exitCode > 0) parts.push(`Code de sortie ${exitCode} (${elapsed} s)`);
  else if (result.err) parts.push(`Erreur de lancement : ${result.err.message}`);
  else parts.push(`OK (${elapsed} s)`);
  if (result.stdout.trim()) parts.push(`--- stdout ---\n${capText(result.stdout)}`);
  if (result.stderr.trim()) parts.push(`--- stderr ---\n${capText(result.stderr, 8000)}`);
  if (changed.length) {
    parts.push(`--- fichiers écrits/modifiés ---\n${changed.map((p) => `/work/${p} (${fmtBytes(after.has(p) ? Number(after.get(p).split(":")[0]) : 0)})`).join("\n")}`);
  }
  return { text: parts.join("\n\n"), ok: !result.killed && exitCode === 0, changed };
}

const runPython = (code, timeoutS) =>
  runInContainer({ script: code, ext: "py", cmd: (rel) => ["python3", `/work/${rel}`], timeoutS }).then((r) => r.text);
const runNode = (code, timeoutS) =>
  runInContainer({ script: code, ext: "js", cmd: (rel) => ["node", `/work/${rel}`], timeoutS }).then((r) => r.text);

/**
 * PPTX/DOCX/XLSX → PDF (LibreOffice) → JPEG pages (pdftoppm) written next to the
 * source as out/<base>-p01.jpg…, and returned as images so the model can do its
 * visual QA. `pages` limits which pages come back (1-based, inclusive).
 */
async function renderDocument(relPath, firstPage, lastPage) {
  const abs = inWorkspace(relPath);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new Error(`Fichier introuvable : ${relPath}`);
  const rel = path.relative(WORKSPACE_DIR, abs).split(path.sep).join("/");
  if (!/\.(pptx|docx|xlsx|odp|odt|pdf)$/i.test(rel)) throw new Error("Formats acceptés : .pptx, .docx, .xlsx, .pdf");
  const base = path.posix.basename(rel).replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 60);
  const isPdf = /\.pdf$/i.test(rel);
  const first = Math.max(1, firstPage ?? 1);
  const last = Math.min(first + RENDER_MAX_PAGES - 1, lastPage ?? first + RENDER_MAX_PAGES - 1);
  const prefix = `/work/out/${base}-p`;
  // Old previews of the same document go away so the model never reads stale pages.
  try { for (const f of fs.readdirSync(path.join(WORKSPACE_DIR, "out"))) if (f.startsWith(`${base}-p`) && f.endsWith(".jpg")) fs.unlinkSync(path.join(WORKSPACE_DIR, "out", f)); } catch { /* none */ }
  const sh = isPdf
    ? `pdftoppm -jpeg -jpegopt quality=72 -r 50 -scale-to 1100 -f ${first} -l ${last} "/work/${rel}" "${prefix}" && pdfinfo "/work/${rel}" | grep -i '^Pages'`
    : `mkdir -p /tmp/render && cd /tmp/render && soffice --headless --norestore --convert-to pdf --outdir /tmp/render "/work/${rel}" >/tmp/render/soffice.log 2>&1; ` +
      `PDF=$(ls /tmp/render/*.pdf 2>/dev/null | head -1); if [ -z "$PDF" ]; then echo "Conversion PDF échouée"; cat /tmp/render/soffice.log; exit 2; fi; ` +
      `pdfinfo "$PDF" | grep -i '^Pages'; pdftoppm -jpeg -jpegopt quality=72 -r 50 -scale-to 1100 -f ${first} -l ${last} "$PDF" "${prefix}"`;
  const r = await runInContainer({ cmd: () => ["sh", "-c", sh], timeoutS: RENDER_TIMEOUT_S, label: "Rendu" });
  const images = [];
  try {
    // pdftoppm pads page numbers according to the page count: normalise to -pNN.
    const outDir = path.join(WORKSPACE_DIR, "out");
    const files = fs.readdirSync(outDir).filter((f) => f.startsWith(`${base}-p`) && f.endsWith(".jpg"));
    const numbered = files.map((f) => ({ f, n: Number(/-p-?(\d+)\.jpg$/.exec(f)?.[1] ?? 0) })).filter((x) => x.n > 0).sort((a, b) => a.n - b.n);
    for (const { f, n } of numbered) {
      const name = `${base}-p${String(n).padStart(2, "0")}.jpg`;
      if (name !== f) fs.renameSync(path.join(outDir, f), path.join(outDir, name));
      images.push({ name, page: n, data: fs.readFileSync(path.join(outDir, name)) });
    }
  } catch { /* none */ }
  const pagesMatch = /Pages:\s+(\d+)/.exec(r.text);
  const total = pagesMatch ? Number(pagesMatch[1]) : null;
  const header = images.length
    ? `Rendu de /work/${rel}${total ? ` — ${total} page(s) au total` : ""}, pages ${first}–${first + images.length - 1} ci-dessous (fichiers ${images.map((i) => `/work/out/${i.name}`).join(", ")}).` +
      (total && total > first + images.length - 1 ? ` Pour la suite : render_pptx avec first_page=${first + images.length}.` : "") +
      " Inspecte chaque page : débordements de texte, chevauchements, logos déformés, titres qui racontent l'histoire."
    : `Aucune page rendue.\n${r.text}`;
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
  "run_node",
  {
    title: "Exécuter du Node.js",
    description:
      "Exécute un script Node.js 20 (CommonJS : require) dans le même bac à sable isolé que run_python, avec pptxgenjs préinstallé (require('pptxgenjs')). " +
      "C'est l'outil pour produire un deck PowerPoint à la DA Impulse : suis la skill HQ slides-impulse (hq_skill_get) en réutilisant ses helpers tels quels, " +
      (SKILLS_DIR ? "avec ASSETS = '/skills/slides-impulse/assets' (fonds, logos, badges, barres dégradées officiels, montés en lecture seule). " : "") +
      "Écris le .pptx dans /work/out (pres.writeFile({ fileName: '/work/out/nom.pptx' })), puis appelle render_pptx pour le QA visuel avant de proposer le fichier au consultant avec [nom.pptx](sandbox:out/nom.pptx). " +
      "Mêmes règles que run_python : sans réseau (pas de npm install), seul stdout/stderr revient, rien ne persiste entre deux appels sauf les fichiers.",
    inputSchema: {
      code: z.string().min(1).max(200_000).describe("Script Node.js complet à exécuter"),
      timeout_s: z.number().int().min(5).max(300).optional().describe(`Délai max en secondes (défaut ${TIMEOUT_S})`),
    },
  },
  async ({ code, timeout_s }) => {
    try {
      const text = await runNode(code, Math.min(timeout_s ?? TIMEOUT_S, TIMEOUT_S));
      return { content: [{ type: "text", text }] };
    } catch (e) {
      running = false;
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
      running = false;
      return { content: [{ type: "text", text: `Erreur : ${e.message}` }], isError: true };
    }
  },
);

server.registerTool(
  "list_files",
  {
    title: "Lister le workspace",
    description: "Liste les fichiers du workspace de la conversation (/work/uploads = fichiers partagés par le consultant, /work/out = tes sorties) avec leur taille" + (SKILLS_DIR ? ", puis les skills HQ montées sous /skills (avec leurs assets)." : "."),
    inputSchema: {},
  },
  async () => {
    const files = listFiles(WORKSPACE_DIR);
    let text = files.length
      ? files.map((f) => `/work/${f.path} — ${fmtBytes(f.bytes)}`).join("\n")
      : "(workspace vide — aucun fichier partagé ni produit pour l'instant)";
    if (SKILLS_DIR) {
      const skills = [];
      try {
        for (const e of fs.readdirSync(SKILLS_DIR, { withFileTypes: true })) {
          if (!e.isDirectory() || e.name.startsWith(".")) continue;
          const hasAssets = fs.existsSync(path.join(SKILLS_DIR, e.name, "assets"));
          skills.push(`/skills/${e.name}/${hasAssets ? " (SKILL.md + assets/)" : ""}`);
        }
      } catch { /* none */ }
      if (skills.length) text += `\n\n--- skills HQ (lecture seule) ---\n${skills.join("\n")}`;
    }
    return { content: [{ type: "text", text }] };
  },
);

server.registerTool(
  "read_file",
  {
    title: "Lire un fichier texte",
    description: "Lit un fichier texte du workspace (CSV, TXT, MD, JSON…)" + (SKILLS_DIR ? " ou d'une skill montée (/skills/<slug>/SKILL.md)" : "") + " et en renvoie le contenu, tronqué à max_chars. Pour un Excel, un PDF ou un Word, passe plutôt par run_python.",
    inputSchema: {
      path: z.string().min(1).max(500).describe("Chemin relatif à /work, ex. uploads/ventes.csv" + (SKILLS_DIR ? ", ou /skills/<slug>/SKILL.md" : "")),
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
