/**
 * Sorties réelles des serveurs MCP maison, lancés en stdio comme le fait le
 * relay : bac à sable (Docker remplacé par un faux binaire qui joue le
 * conteneur) et gws (CLI remplacé par un faux binaire qui ne parle à personne).
 *
 * Chaque essai a son propre dossier temporaire, son propre workspace et son
 * propre serveur : aucun ne dépend de ce qu'un autre a lu ou écrit. Les liens
 * symboliques ne visent que des fichiers créés ici, sous le dossier temporaire.
 */
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../..");
const IS_ROOT = typeof process.getuid === "function" && process.getuid() === 0;
// Plafond du CLI (MAX_MCP_OUTPUT_TOKENS) et densité d'un texte chiffré.
const CLI_TOKEN_CAP = 20_000;
const TOKENS_PER_CHAR = 0.52;

const opened: Client[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const c of opened.splice(0)) await c.close().catch(() => undefined);
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** Dossier temporaire de l'essai, traversable par l'utilisateur non privilégié. */
function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "im-mcp-test-"));
  fs.chmodSync(d, 0o755);
  dirs.push(d);
  return d;
}

const pids = new WeakMap<Client, number>();

/** Lance un serveur ; `wrap` le place sous une autre commande (strace). */
async function start(script: string, env: Record<string, string>, wrap: string[] = []) {
  const client = new Client({ name: "test", version: "1.0.0" });
  const argv = [...wrap, process.execPath, path.join(ROOT, "server", script)];
  const transport = new StdioClientTransport({
    command: argv[0],
    args: argv.slice(1),
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env },
    stderr: "ignore",
  });
  await client.connect(transport);
  pids.set(client, transport.pid ?? 0);
  opened.push(client);
  return client;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Attend qu'une condition devienne vraie ; rend faux si elle ne l'est pas devenue à temps. */
async function waitFor(cond: () => boolean, ms: number) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(25)) if (cond()) return true;
  return cond();
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const readLines = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean) : []);

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const r = await client.callTool({ name, arguments: args });
  const content = r.content as { type: string; text?: string }[];
  return { text: content.map((c) => c.text ?? "").join("\n"), isError: !!r.isError };
}

// ── Bac à sable ─────────────────────────────────────────────────────────────

/**
 * Faux docker : joue le conteneur. Les montages -v donnent la correspondance
 * conteneur → hôte ; le « script Python » reçu est exécuté par sh dans le
 * workspace, avec les droits du serveur — le pire cas pour l'hôte. La commande
 * `timeout` qui précède le script est exécutée pour de bon : le délai est celui
 * du « conteneur », pas celui du serveur. `run` note son pid sous le nom du
 * conteneur, `kill` l'arrête, `ps` rend le fichier DOCKER_PS ; tout est
 * consigné dans DOCKER_LOG. Un rendu (sh -c …) tourne avec les faux outils.
 */
const FAKE_DOCKER = [
  "#!/bin/sh",
  'echo "docker $*" >> "$DOCKER_LOG"',
  'case "$1" in',
  '  ps) [ -f "$DOCKER_PS" ] && cat "$DOCKER_PS"; exit 0 ;;',
  '  kill) [ -f "$DOCKER_RUN_DIR/$2.pid" ] && kill -TERM "$(cat "$DOCKER_RUN_DIR/$2.pid")"; exit 0 ;;',
  "  run) ;;",
  "  *) exit 0 ;;",
  "esac",
  "shift",
  'MOUNTS=""; NAME=""',
  "while [ $# -gt 0 ]; do",
  '  case "$1" in',
  '    -v) MOUNTS="$MOUNTS $2"; shift 2 ;;',
  '    --name) NAME="$2"; shift 2 ;;',
  "    --rm|--read-only) shift ;;",
  "    -*) shift 2 ;;",
  "    *) break ;;",
  "  esac",
  "done",
  "shift # image",
  'LIMIT=""',
  'if [ "$1" = "timeout" ]; then LIMIT="$1 $2 $3 $4"; shift 4; fi',
  'SCRIPT="$2"',
  'WORK=""; HOST_SCRIPT=""',
  "for m in $MOUNTS; do",
  '  host="${m%%:*}"; rest="${m#*:}"; cont="${rest%%:*}"',
  '  [ "$cont" = "/work" ] && WORK="$host"',
  '  case "$SCRIPT" in "$cont"/*) HOST_SCRIPT="$host${SCRIPT#"$cont"}" ;; esac',
  "done",
  'echo $$ > "$DOCKER_RUN_DIR/$NAME.pid"',
  'cd "$WORK" || exit 1',
  'if [ -n "$HOST_SCRIPT" ]; then exec $LIMIT sh "$HOST_SCRIPT"; fi',
  'export WORK; PATH="$(dirname "$0")/outils:$PATH"; export PATH',
  'exec $LIMIT "$@"',
  "",
].join("\n");

/**
 * Faux pdftoppm : le document et le préfixe des pages sont ses deux derniers
 * arguments, en chemins du conteneur. Il écrit une page, ou joue RENDER_HOOK
 * (ce qu'un conteneur hostile laisserait dans out/).
 */
const FAKE_PDFTOPPM = [
  "#!/bin/sh",
  'while [ $# -gt 2 ]; do shift; done',
  '[ -f "$WORK${1#/work}" ] || { echo "document introuvable : $1" >&2; exit 1; }',
  'if [ -n "$RENDER_HOOK" ]; then cd "$WORK" && exec sh "$RENDER_HOOK"; fi',
  'printf JPEG1 > "$WORK${2#/work}1.jpg"',
  "",
].join("\n");

const SKILL_TEXT = Array.from({ length: 600 }, (_, i) => `Règle ${i + 1} : ${"mot ".repeat(12)}`).join("\n") + "\n";
const LONG_OUTPUT = 'i=0; while [ $i -lt 900 ]; do echo "ligne $i abcdefghijklmnopqrstuvwxyz"; i=$((i+1)); done';

/** Sous-dossier d'état d'un workspace sous une racine imposée (SANDBOX_STATE_DIR). */
function stateOf(root: string, work: string) {
  const real = fs.realpathSync(work);
  return path.join(root, `${path.basename(real)}-${crypto.createHash("sha256").update(real).digest("hex").slice(0, 12)}`);
}

type SandboxPrepare = (f: { tmp: string; work: string; outside: string; state: string; ps: string }) => void;

async function sandboxFixture({ prepare, env = {} }: { prepare?: SandboxPrepare; env?: Record<string, string> } = {}) {
  const tmp = tmpDir();
  const work = path.join(tmp, "work");
  const skills = path.join(tmp, "skills");
  const outside = path.join(tmp, "outside");
  const state = path.join(tmp, "etat");
  const bin = path.join(tmp, "bin");
  const runDir = path.join(tmp, "conteneurs");
  const log = path.join(tmp, "docker.log");
  const ps = path.join(tmp, "docker-ps.txt");
  for (const d of [path.join(work, "uploads"), path.join(work, "out"), path.join(skills, "slides-impulse", "assets"), path.join(skills, "docx"), outside, path.join(bin, "outils"), runDir]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(bin, "docker"), FAKE_DOCKER, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "outils", "pdftoppm"), FAKE_PDFTOPPM, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "outils", "pdfinfo"), '#!/bin/sh\necho "Pages:           3"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(skills, "slides-impulse", "SKILL.md"), SKILL_TEXT);
  fs.writeFileSync(path.join(work, "uploads", "ventes.csv"), "date;ca\n2026-09-01;120\n2026-09-02;80\n");
  fs.writeFileSync(path.join(work, "data.json"), JSON.stringify({ fam: [{ fam: "SEA Brand", cost: 475.08 }], cpm: 5.08 }, null, 1));
  fs.writeFileSync(path.join(outside, "secret.txt"), "SECRET-HORS-WORKSPACE\n");
  fs.writeFileSync(path.join(outside, "cible.txt"), "contenu intact\n");
  prepare?.({ tmp, work, outside, state, ps });
  const sandbox = await start("mcp-sandbox.mjs", {
    PATH: `${bin}:/usr/bin:/bin`, WORKSPACE_DIR: work, SKILLS_DIR: skills, SANDBOX_STATE_DIR: state,
    DOCKER_LOG: log, DOCKER_RUN_DIR: runDir, DOCKER_PS: ps, ...env,
  });
  /** Pid du « conteneur » en cours, une fois qu'il a démarré. */
  const containerPid = async () => {
    await waitFor(() => fs.readdirSync(runDir).length > 0, 3000);
    return Number(fs.readFileSync(path.join(runDir, fs.readdirSync(runDir)[0]), "utf8"));
  };
  return { sandbox, tmp, work, skills, outside, state, log, runDir, containerPid };
}

/** Résultat brut d'un rendu : le texte, et les images telles qu'elles reviennent. */
async function render(client: Client, args: Record<string, unknown>) {
  const r = await client.callTool({ name: "render_pptx", arguments: args });
  const content = r.content as { type: string; text?: string; data?: string }[];
  return {
    text: content.map((c) => c.text ?? "").join("\n"),
    images: content.filter((c) => c.type === "image").map((c) => Buffer.from(c.data ?? "", "base64").toString("utf8")),
    isError: !!r.isError,
  };
}

/** Tout ce que contient un dossier, liens compris (chemins relatifs). */
function tree(dir: string, rel = ""): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    out.push(r);
    if (e.isDirectory()) out.push(...tree(dir, r));
  }
  return out.sort();
}

describe("mcp-sandbox — list_files et read_file", () => {
  it("garde des schémas compatibles : tout paramètre ajouté est optionnel", async () => {
    const { sandbox } = await sandboxFixture();
    const { tools } = await sandbox.listTools();
    const required = Object.fromEntries(tools.map((t) => [t.name, (t.inputSchema.required ?? []) as string[]]));
    expect(required.read_file).toEqual(["path"]);
    expect(required.run_python).toEqual(["code"]);
    expect(required.run_node).toEqual(["code"]);
    expect(required.list_files).toEqual([]);
    const props = (name: string) => Object.keys(tools.find((t) => t.name === name)?.inputSchema.properties ?? {});
    expect(props("read_file")).toEqual(expect.arrayContaining(["path", "max_chars", "start_line", "max_lines", "start_char", "force"]));
    expect(props("run_python")).toEqual(expect.arrayContaining(["code", "timeout_s", "max_output_chars"]));
  });

  it("liste par dossier, puis ne répète pas les skills inchangées", async () => {
    const { sandbox } = await sandboxFixture();
    const first = (await call(sandbox, "list_files")).text;
    expect(first.split("\n")).toEqual([
      "/work/ : data.json (79 o)",
      "/work/uploads/ : ventes.csv (37 o)",
      "",
      "--- 2 skills HQ, lecture seule : /skills/<nom>/SKILL.md ; * = a aussi un dossier assets/ ---",
      "docx, slides-impulse*",
    ]);
    const second = (await call(sandbox, "list_files")).text;
    expect(second).toContain("/work/uploads/ : ventes.csv (37 o)");
    expect(second).toContain("--- 2 skills HQ sous /skills : liste inchangée, déjà donnée plus haut (skills=true pour la revoir) ---");
    expect(second).not.toContain("slides-impulse*");
    expect((await call(sandbox, "list_files", { skills: true })).text).toContain("docx, slides-impulse*");
    expect((await call(sandbox, "list_files", { skills: false })).text).not.toContain("skills");
  });

  it("lit un petit fichier en entier, sans mention ajoutée", async () => {
    const { sandbox } = await sandboxFixture();
    const r = await call(sandbox, "read_file", { path: "uploads/ventes.csv" });
    expect(r.text).toBe("date;ca\n2026-09-01;120\n2026-09-02;80\n");
    expect((await call(sandbox, "read_file", { path: "/work/uploads/ventes.csv", force: true })).text).toBe(r.text);
  });

  it("lit une skill par plages, jusqu'au bout, sans rien perdre", async () => {
    const { sandbox } = await sandboxFixture();
    const a = await call(sandbox, "read_file", { path: "/skills/slides-impulse/SKILL.md" });
    const noteA = /\n\[lignes 1–(\d+) sur 600, caractères 0–(\d+) sur (\d+) — suite : start_line=(\d+)\]$/.exec(a.text);
    expect(noteA).not.toBeNull();
    expect(Number(noteA![3])).toBe(SKILL_TEXT.length);
    expect(Number(noteA![2])).toBeLessThanOrEqual(20_000);
    let got = a.text.slice(0, noteA!.index + 1);
    let next = Number(noteA![4]);
    for (let i = 0; i < 5 && next; i++) {
      const r = await call(sandbox, "read_file", { path: "/skills/slides-impulse/SKILL.md", start_line: next });
      const note = /\[lignes \d+–\d+ sur 600, [^\]]*\]$/.exec(r.text)!;
      got += r.text.slice(0, note.index);
      next = Number(/start_line=(\d+)/.exec(note[0])?.[1] ?? 0);
    }
    expect(got).toBe(SKILL_TEXT);
  });

  it("ne renvoie pas deux fois un fichier inchangé, sauf force ou modification", async () => {
    const { sandbox, work } = await sandboxFixture();
    const p = { path: "/skills/slides-impulse/SKILL.md", max_lines: 300 };
    const half = SKILL_TEXT.split("\n").slice(0, 300).join("\n") + "\n";
    expect((await call(sandbox, "read_file", p)).text.startsWith(half)).toBe(true);
    const again = await call(sandbox, "read_file", p);
    expect(again.text).toBe("Déjà lu plus haut dans cette conversation, lignes 1–300 sur 600, et le fichier n'a pas changé depuis : reprends ce contenu. S'il n'est plus sous tes yeux, rappelle avec force=true.");
    expect(again.isError).toBe(false);
    expect((await call(sandbox, "read_file", { ...p, force: true })).text.startsWith(half)).toBe(true);

    const csv = path.join(work, "uploads", "ventes.csv");
    expect((await call(sandbox, "read_file", { path: "uploads/ventes.csv" })).text).toMatch(/^date;ca/);
    expect((await call(sandbox, "read_file", { path: "uploads/ventes.csv" })).text).toMatch(/^Déjà lu/);
    fs.writeFileSync(csv, "date;ca\n2026-09-03;95\n");
    fs.utimesSync(csv, new Date(), new Date(Date.now() + 5000));
    expect((await call(sandbox, "read_file", { path: "uploads/ventes.csv" })).text).toBe("date;ca\n2026-09-03;95\n");
  });

  it("minifie un JSON indenté lu en entier et le dit", async () => {
    const { sandbox } = await sandboxFixture();
    const r = await call(sandbox, "read_file", { path: "data.json" });
    expect(r.text).toBe('{"fam":[{"fam":"SEA Brand","cost":475.08}],"cpm":5.08}\n[JSON minifié : 79 caractères indentés sur le disque]');
    // Par lignes, c'est le fichier tel qu'il est sur le disque.
    expect((await call(sandbox, "read_file", { path: "data.json", start_line: 1, max_lines: 2 })).text).toMatch(/^\{\n "fam": \[\n\[lignes 1–2 sur /);
  });

  it("garde des erreurs entières et lisibles", async () => {
    const { sandbox } = await sandboxFixture();
    const miss = await call(sandbox, "read_file", { path: "uploads/absent.csv" });
    expect(miss.isError).toBe(true);
    expect(miss.text).toMatch(/^Erreur : ENOENT: no such file or directory/);
    expect(miss.text).not.toContain("/proc/");
    const out = await call(sandbox, "read_file", { path: "../../etc/passwd" });
    expect(out.text).toBe("Erreur : Chemin hors du workspace : ../../etc/passwd");
  });
});

describe("mcp-sandbox — plafond du CLI (read_file)", () => {
  const dense = Array.from({ length: 6000 }, (_, i) => `${String(i).padStart(6, "0")};1234`).join("\n") + "\n"; // 72 000 caractères

  it("ne rend jamais plus que le plafond, même avec max_chars=60000, et ne tient pour lu que ce qui a été rendu", async () => {
    const { sandbox, work } = await sandboxFixture();
    fs.writeFileSync(path.join(work, "uploads", "dense.csv"), dense);
    const a = await call(sandbox, "read_file", { path: "uploads/dense.csv", max_chars: 60_000 });
    expect(a.isError).toBe(false);
    expect(a.text.length * TOKENS_PER_CHAR).toBeLessThan(CLI_TOKEN_CAP);
    const note = /\[lignes 1–(\d+) sur 6000, caractères 0–(\d+) sur 72000 — suite : start_line=(\d+)\]$/.exec(a.text);
    expect(note).not.toBeNull();
    const to = Number(note![2]);
    expect(a.text.startsWith(dense.slice(0, to))).toBe(true);

    // La suite annoncée n'a jamais été rendue : elle se lit, sans force.
    const b = await call(sandbox, "read_file", { path: "uploads/dense.csv", start_line: Number(note![3]), max_chars: 60_000 });
    expect(b.text).not.toMatch(/^Déjà lu/);
    expect(b.text.startsWith(dense.slice(to, to + 1000))).toBe(true);
    expect(b.text.length * TOKENS_PER_CHAR).toBeLessThan(CLI_TOKEN_CAP);
    // Ce qui a été rendu, lui, n'est pas renvoyé deux fois.
    expect((await call(sandbox, "read_file", { path: "uploads/dense.csv", max_chars: 60_000 })).text).toMatch(/^Déjà lu/);
  });

  it("compte plus large pour un texte hors ASCII, qui pèse plus par caractère", async () => {
    const { sandbox, work } = await sandboxFixture();
    const wide = `${"數據分析報告".repeat(10)}\n`.repeat(900); // 54 900 caractères, environ un token ou plus chacun
    fs.writeFileSync(path.join(work, "uploads", "wide.txt"), wide);
    const r = await call(sandbox, "read_file", { path: "uploads/wide.txt", max_chars: 60_000 });
    const to = Number(/caractères 0–(\d+) sur/.exec(r.text)?.[1]);
    expect(to).toBeGreaterThan(0);
    expect(to).toBeLessThan(CLI_TOKEN_CAP / 1.5);
  });
});

describe("mcp-sandbox — liens symboliques posés par le conteneur (lecture)", () => {
  it("refuse de lire à travers un lien vers un fichier hors du workspace", async () => {
    const { sandbox, work, outside } = await sandboxFixture();
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(work, "out", "lien.txt"));
    const r = await call(sandbox, "read_file", { path: "out/lien.txt" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/lien symbolique/i);
    expect(r.text).not.toContain("SECRET");
  });

  it("refuse de lire à travers un dossier remplacé par un lien", async () => {
    const { sandbox, work, outside } = await sandboxFixture();
    fs.symlinkSync(outside, path.join(work, "out", "dossier"));
    const r = await call(sandbox, "read_file", { path: "out/dossier/secret.txt" });
    expect(r.isError).toBe(true);
    expect(r.text).not.toContain("SECRET");
  });

  it("ne liste ni ne mesure ce qui est derrière un lien", async () => {
    const { sandbox, work, outside } = await sandboxFixture();
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(work, "out", "lien.txt"));
    fs.symlinkSync(outside, path.join(work, "out", "dossier"));
    const r = await call(sandbox, "list_files", { skills: false });
    expect(r.text).not.toContain("secret.txt");
    expect(r.text).not.toContain("lien.txt (22 o)");
  });

  it("continue de lire une skill montée, et refuse d'en sortir", async () => {
    const { sandbox, skills, outside } = await sandboxFixture();
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(skills, "docx", "lien.md"));
    expect((await call(sandbox, "read_file", { path: "/skills/slides-impulse/SKILL.md", max_lines: 1 })).text).toMatch(/^Règle 1 : /);
    expect((await call(sandbox, "read_file", { path: "skills/slides-impulse/SKILL.md", max_lines: 1, force: true })).text).toMatch(/^Règle 1 : /);
    const r = await call(sandbox, "read_file", { path: "/skills/docx/lien.md" });
    expect(r.isError).toBe(true);
    expect(r.text).not.toContain("SECRET");
    expect((await call(sandbox, "read_file", { path: "/skills/../outside/secret.txt" })).text).not.toContain("SECRET");
  });
});

describe("mcp-sandbox — run_python, écritures de l'hôte", () => {
  it("rend stdout, le code de sortie et les fichiers écrits", async () => {
    const { sandbox, work } = await sandboxFixture();
    const r = await call(sandbox, "run_python", { code: 'echo "total 42"; echo "a;b" > out/export.csv' });
    expect(r.isError).toBe(false);
    const lines = r.text.split("\n");
    expect(lines[0]).toMatch(/^OK \(\d+\.\d s\)$/);
    expect(r.text).toContain("--- stdout ---\ntotal 42");
    expect(r.text).toContain("--- fichiers écrits/modifiés ---\n/work/out/export.csv (4 o)");
    expect(fs.readFileSync(path.join(work, "out", "export.csv"), "utf8")).toBe("a;b\n");
    const ko = await call(sandbox, "run_python", { code: 'echo "ValueError: colonne absente" >&2; exit 3' });
    expect(ko.text).toMatch(/^Code de sortie 3 \(\d+\.\d s\)\n\n--- stderr ---\nValueError: colonne absente/);
  });

  it("ne laisse aucun script ni aucune sortie de l'hôte dans le workspace", async () => {
    const { sandbox, work } = await sandboxFixture();
    const before = tree(work);
    const r = await call(sandbox, "run_python", { code: `ls -A .run 2>/dev/null; ${LONG_OUTPUT}` });
    expect(r.text).toContain("coupés ici");
    expect(r.text).not.toMatch(/\.py$/m);
    expect(tree(work).filter((f) => !before.includes(f) && f !== ".run")).toEqual([]);
    expect(fs.existsSync(path.join(work, ".run", "derniere-sortie.txt"))).toBe(false);
  });

  it("coupe une longue sortie et la laisse relire en entier, par plages", async () => {
    const { sandbox } = await sandboxFixture();
    const r = await call(sandbox, "run_python", { code: LONG_OUTPUT });
    const id = /sortie complète : read_file (sortie:[a-f0-9]+)\]/.exec(r.text)?.[1];
    expect(id).toBeTruthy();
    expect(r.text.length).toBeLessThan(13_000);
    const full = await call(sandbox, "read_file", { path: id });
    expect(full.text).toMatch(/^--- stdout ---\nligne 0 abcdefghijklmnopqrstuvwxyz\nligne 1 /);
    expect(full.text).toMatch(/suite : start_line=\d+\]$/);
    const tail = await call(sandbox, "read_file", { path: id, start_line: 899, max_lines: 5 });
    expect(tail.text).toContain("ligne 899 abcdefghijklmnopqrstuvwxyz");
  });

  it("n'écrit pas à travers un lien posé à la place du fichier de sortie", async () => {
    const { sandbox, outside } = await sandboxFixture();
    const cible = path.join(outside, "cible.txt");
    const plant = `mkdir -p .run; rm -f .run/derniere-sortie.txt; ln -s ${cible} .run/derniere-sortie.txt; ${LONG_OUTPUT}`;
    const r = await call(sandbox, "run_python", { code: plant });
    expect(r.text).toContain("coupés ici");
    // Second passage : le lien est en place avant même l'écriture du script.
    await call(sandbox, "run_python", { code: LONG_OUTPUT });
    expect(fs.readFileSync(cible, "utf8")).toBe("contenu intact\n");
    if (IS_ROOT) expect(fs.statSync(cible).uid).toBe(0);
  });

  it("n'écrit ni script ni sortie à travers un dossier .run remplacé par un lien", async () => {
    const { sandbox, outside } = await sandboxFixture();
    const dir = path.join(outside, "dossier");
    fs.mkdirSync(dir);
    await call(sandbox, "run_python", { code: `rm -rf .run; ln -s ${dir} .run; echo ok` });
    // Le script du second passage serait écrit par l'hôte dans le dossier visé.
    const r = await call(sandbox, "run_python", { code: `ls -A ${dir}; ${LONG_OUTPUT}` });
    expect(r.text).toContain("coupés ici");
    expect(r.text).not.toMatch(/^[a-f0-9]{12}\.py$/m);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it.runIf(IS_ROOT)("ne donne pas au conteneur un fichier de l'hôte visé par un lien (chown au démarrage)", async () => {
    const f = await sandboxFixture({
      prepare: ({ work, outside }) => {
        fs.symlinkSync(path.join(outside, "cible.txt"), path.join(work, "uploads", "lien.txt"));
        fs.mkdirSync(path.join(outside, "dossier"));
        fs.writeFileSync(path.join(outside, "dossier", "f.txt"), "x");
        fs.symlinkSync(path.join(outside, "dossier"), path.join(work, "out", "dossier"));
      },
    });
    await call(f.sandbox, "list_files");
    expect(fs.statSync(path.join(f.outside, "cible.txt")).uid).toBe(0);
    expect(fs.statSync(path.join(f.outside, "dossier", "f.txt")).uid).toBe(0);
    expect(fs.statSync(path.join(f.outside, "dossier")).uid).toBe(0);
    // Les vrais fichiers du workspace, eux, sont bien remis au conteneur.
    expect(fs.statSync(path.join(f.work, "uploads", "ventes.csv")).uid).toBe(1000);
  });

  it("ne supprime ni ne renomme rien à travers un dossier out remplacé par un lien (render_pptx)", async () => {
    const f = await sandboxFixture({
      prepare: ({ work, outside }) => {
        const dir = path.join(outside, "rendus");
        fs.mkdirSync(dir);
        fs.writeFileSync(path.join(dir, "deck.pdf"), "%PDF-1.4\n");
        fs.writeFileSync(path.join(dir, "deck-p1.jpg"), "image de l'hôte");
        fs.rmSync(path.join(work, "out"), { recursive: true });
        fs.symlinkSync(dir, path.join(work, "out"));
      },
    });
    const r = await call(f.sandbox, "render_pptx", { path: "out/deck.pdf" });
    expect(r.isError).toBe(true);
    expect(fs.readdirSync(path.join(f.outside, "rendus")).sort()).toEqual(["deck-p1.jpg", "deck.pdf"]);
  });
});

describe("mcp-sandbox — la sortie relue est bien celle qu'on croit", () => {
  it("ne sert pas la sortie d'une exécution précédente comme la dernière", async () => {
    const { sandbox } = await sandboxFixture();
    const first = await call(sandbox, "run_python", { code: LONG_OUTPUT });
    expect(first.text).toContain("coupés ici");
    const second = await call(sandbox, "run_python", { code: "echo court" });
    expect(second.text).toContain("--- stdout ---\ncourt");
    const last = await call(sandbox, "read_file", { path: ".run/derniere-sortie.txt" });
    expect(last.text).not.toContain("ligne 0 abcdefghijklmnopqrstuvwxyz");
    expect(last.text).toMatch(/dernière exécution/);
  });

  it("donne à chaque sortie coupée son propre identifiant", async () => {
    const { sandbox } = await sandboxFixture();
    const idOf = (t: string) => /read_file (sortie:[a-f0-9]+)\]/.exec(t)?.[1] ?? "";
    const a = idOf((await call(sandbox, "run_python", { code: LONG_OUTPUT })).text);
    const b = idOf((await call(sandbox, "run_python", { code: LONG_OUTPUT.replace("ligne", "rang") })).text);
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(a).not.toBe(b);
    expect((await call(sandbox, "read_file", { path: a, max_lines: 2 })).text).toContain("ligne 0 ");
    expect((await call(sandbox, "read_file", { path: b, max_lines: 2 })).text).toContain("rang 0 ");
    // L'ancien chemin désigne la dernière exécution, et elle seule.
    expect((await call(sandbox, "read_file", { path: ".run/derniere-sortie.txt", max_lines: 2, force: true })).text).toContain("rang 0 ");
    const unknown = await call(sandbox, "read_file", { path: "sortie:000000000000" });
    expect(unknown.isError).toBe(true);
  });
});

describe("mcp-sandbox — durée d'un conteneur, arrêt et balayage", () => {
  it("borne le conteneur par lui-même : il s'arrête à son délai même si le serveur a été tué", async () => {
    const f = await sandboxFixture();
    const started = Date.now();
    call(f.sandbox, "run_python", { code: "sleep 20; echo x > out/survivant.txt", timeout_s: 5 }).catch(() => undefined);
    const pid = await f.containerPid();
    process.kill(pids.get(f.sandbox)!, "SIGKILL");
    expect(alive(pid)).toBe(true);
    expect(await waitFor(() => !alive(pid), 9000)).toBe(true);
    const lasted = Date.now() - started;
    expect(lasted).toBeGreaterThan(4500);
    expect(lasted).toBeLessThan(8000);
    expect(fs.existsSync(path.join(f.work, "out", "survivant.txt"))).toBe(false);
    expect(readLines(f.log).find((l) => l.startsWith("docker run"))).toMatch(/ timeout --signal=TERM --kill-after=5 5 python3 \/script\/[a-f0-9]{12}\.py$/);
  }, 20_000);

  it("dit qu'un script a dépassé son délai, et garde le code de sortie des autres", async () => {
    const { sandbox } = await sandboxFixture();
    const r = await call(sandbox, "run_python", { code: "echo debut; sleep 20", timeout_s: 5 });
    expect(r.text).toMatch(/^⏱ Exécution interrompue après 5 s \(délai dépassé\)/);
    expect(r.text).toContain("--- stdout ---\ndebut");
    // 124 est aussi un code de sortie ordinaire : seul un script arrivé à son délai est dit interrompu.
    expect((await call(sandbox, "run_python", { code: "exit 124" })).text).toMatch(/^Code de sortie 124 /);
  }, 20_000);

  it.each([
    ["SIGTERM", (f: { sandbox: Client }) => { process.kill(pids.get(f.sandbox)!, "SIGTERM"); }],
    ["SIGINT", (f: { sandbox: Client }) => { process.kill(pids.get(f.sandbox)!, "SIGINT"); }],
    ["la fermeture de stdin", (f: { sandbox: Client }) => { void f.sandbox.close(); }],
  ])("arrête le conteneur en cours et retire son script quand le serveur s'arrête (%s)", async (_how, stop) => {
    const f = await sandboxFixture();
    call(f.sandbox, "run_python", { code: "sleep 20; echo x > out/survivant.txt", timeout_s: 60 }).catch(() => undefined);
    const pid = await f.containerPid();
    const dir = stateOf(f.state, f.work);
    expect(fs.readdirSync(dir).filter((d) => d.startsWith("script-"))).toHaveLength(1);
    stop(f);
    // Moins que les 2 s après lesquelles le client passe de stdin fermé à SIGTERM.
    expect(await waitFor(() => !alive(pid), 1500)).toBe(true);
    expect(readLines(f.log).filter((l) => l.startsWith("docker kill"))).toEqual([expect.stringMatching(/^docker kill im-sb-[a-f0-9]{12}$/)]);
    expect(await waitFor(() => fs.readdirSync(dir).every((d) => !d.startsWith("script-")), 1500)).toBe(true);
    expect(fs.existsSync(path.join(f.work, "out", "survivant.txt"))).toBe(false);
  }, 20_000);

  it("balaie au démarrage les conteneurs abandonnés de ce workspace, et eux seuls", async () => {
    const past = Math.floor(Date.now() / 1000) - 60;
    const future = Math.floor(Date.now() / 1000) + 60;
    const f = await sandboxFixture({
      prepare: ({ tmp, work, state, ps }) => {
        fs.writeFileSync(ps, [
          `im-sb-aaaaaaaaaaaa\t${work}\t${past}`, // abandonné : arrêté
          `im-sb-bbbbbbbbbbbb\t${work}\t${future}`, // ce workspace, encore dans son délai
          `im-sb-cccccccccccc\t${path.join(tmp, "autre")}\t${past}`, // autre conversation
          `impulsemotion-sandbox-keep\t${work}\t${past}`, // pas un conteneur du bac à sable
          `xim-sb-dddddddddddd\t${work}\t${past}`,
          `im-sb-eeeeeeeeeeee\t${work}\t`, // sans échéance connue
          "",
        ].join("\n"));
        for (const id of ["aaaaaaaaaaaa", "bbbbbbbbbbbb", "ffffffffffff"]) {
          fs.mkdirSync(path.join(stateOf(state, work), `script-${id}`), { recursive: true });
          fs.writeFileSync(path.join(stateOf(state, work), `script-${id}`, `${id}.py`), "print(1)\n");
        }
        fs.writeFileSync(path.join(stateOf(state, work), "sortie-aaaaaaaaaaaa.txt"), "sortie gardée\n");
      },
    });
    const dir = stateOf(f.state, f.work);
    expect(await waitFor(() => !fs.existsSync(path.join(dir, "script-ffffffffffff")), 3000)).toBe(true);
    expect(readLines(f.log).filter((l) => l.startsWith("docker kill"))).toEqual(["docker kill im-sb-aaaaaaaaaaaa"]);
    expect(fs.readdirSync(dir).sort()).toEqual(["script-bbbbbbbbbbbb", "sortie-aaaaaaaaaaaa.txt"]);
    // Le balayage n'emporte pas le script d'une exécution lancée entre-temps.
    expect((await call(f.sandbox, "run_python", { code: "echo ok" })).text).toContain("--- stdout ---\nok");
  });

  it("ne rend le verrou que par l'appel qui l'a pris : un appel refusé ne libère rien", async () => {
    const { sandbox, work } = await sandboxFixture();
    const first = call(sandbox, "run_python", { code: "sleep 2; echo fin1" });
    await sleep(400);
    const second = await call(sandbox, "run_python", { code: "echo deux > out/deux.txt" });
    expect(second.text).toBe("Erreur : Une exécution est déjà en cours dans ce bac à sable — attends son résultat.");
    const third = await call(sandbox, "run_node", { code: "echo trois > out/trois.txt" });
    expect(third.text).toBe(second.text);
    const pdf = await call(sandbox, "render_pptx", { path: "uploads/ventes.csv" });
    expect(pdf.isError).toBe(true);
    const fourth = await call(sandbox, "run_python", { code: "echo quatre > out/quatre.txt" });
    expect(fourth.text).toBe(second.text);
    expect((await first).text).toContain("--- stdout ---\nfin1");
    expect(fs.readdirSync(path.join(work, "out"))).toEqual([]);
    // Le verrou est rendu par le premier appel : le suivant s'exécute.
    expect((await call(sandbox, "run_python", { code: "echo cinq" })).text).toContain("--- stdout ---\ncinq");
  }, 20_000);
});

describe("mcp-sandbox — dossier d'état", () => {
  it("sépare les conversations sous une même racine imposée", async () => {
    const a = await sandboxFixture();
    const b = await sandboxFixture({ env: { SANDBOX_STATE_DIR: a.state } });
    const r = await call(a.sandbox, "run_python", { code: LONG_OUTPUT });
    const id = /read_file (sortie:[a-f0-9]+)\]/.exec(r.text)?.[1] ?? "";
    expect(id).toBeTruthy();
    expect((await call(a.sandbox, "read_file", { path: id, max_lines: 2 })).text).toContain("ligne 0 ");
    const named = await call(b.sandbox, "read_file", { path: id, max_lines: 2 });
    expect(named.isError).toBe(true);
    expect(named.text).not.toContain("ligne 0 ");
    const last = await call(b.sandbox, "read_file", { path: ".run/derniere-sortie.txt", max_lines: 2 });
    expect(last.text).not.toContain("ligne 0 ");
    expect(stateOf(a.state, a.work)).not.toBe(stateOf(a.state, b.work));
    expect(fs.readdirSync(a.state).sort()).toEqual([stateOf(a.state, a.work), stateOf(a.state, b.work)].map((d) => path.basename(d)).sort());
    expect((fs.statSync(stateOf(a.state, a.work)).mode & 0o777).toString(8)).toBe("700");
  });

  it("contrôle l'emplacement avant de créer : rien n'est créé dans le workspace", async () => {
    const tmp = tmpDir();
    const tmpdir = path.join(tmp, "tmpdir");
    fs.mkdirSync(tmpdir);
    let before: string[] = [];
    // Par un lien : c'est l'emplacement réel qui compte, pas le chemin donné.
    const f = await sandboxFixture({ env: { SANDBOX_STATE_DIR: path.join(tmp, "lien", "etat"), TMPDIR: tmpdir },
      prepare: ({ work }) => { fs.symlinkSync(path.join(work, "out"), path.join(tmp, "lien")); before = tree(work); } });
    const r = await call(f.sandbox, "run_python", { code: LONG_OUTPUT });
    expect(r.text).toContain("coupés ici");
    expect(tree(f.work)).toEqual(before);
    // Le repli est propre à ce processus, fermé aux autres, et part avec lui.
    const made = fs.readdirSync(tmpdir);
    expect(made).toEqual([expect.stringMatching(/^im-sb-etat-/)]);
    expect((fs.statSync(path.join(tmpdir, made[0])).mode & 0o777).toString(8)).toBe("700");
    await f.sandbox.close();
    expect(await waitFor(() => fs.readdirSync(tmpdir).length === 0, 3000)).toBe(true);
  });

  it("ne pose pas son repli dans le workspace quand TMPDIR y pointe", async () => {
    let before: string[] = [];
    const f = await sandboxFixture({ prepare: ({ work }) => { fs.mkdirSync(path.join(work, "out", "tmp")); before = tree(work); } });
    await f.sandbox.close();
    const g = await start("mcp-sandbox.mjs", {
      PATH: `${path.join(f.tmp, "bin")}:/usr/bin:/bin`, WORKSPACE_DIR: f.work, SANDBOX_STATE_DIR: path.join(f.work, "etat"),
      TMPDIR: path.join(f.work, "out", "tmp"), DOCKER_LOG: f.log, DOCKER_RUN_DIR: f.runDir, DOCKER_PS: path.join(f.tmp, "docker-ps.txt"),
    });
    expect((await call(g, "run_python", { code: LONG_OUTPUT })).text).toContain("coupés ici");
    expect(tree(f.work)).toEqual(before);
    expect(fs.readdirSync(path.join(f.work, "out", "tmp"))).toEqual([]);
  });
});

describe("mcp-sandbox — liens durs", () => {
  it("refuse de lire un fichier qui a un autre nom hors du workspace", async () => {
    const { sandbox, work, outside } = await sandboxFixture();
    fs.linkSync(path.join(outside, "secret.txt"), path.join(work, "out", "dur.txt"));
    const r = await call(sandbox, "read_file", { path: "out/dur.txt" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^Erreur : Lien dur refusé : \/work\/out\/dur\.txt — ce fichier a 2 noms/);
    expect(r.text).not.toContain("SECRET");
  });

  it.runIf(IS_ROOT)("ne donne pas au conteneur un fichier de l'hôte qui a un nom dans le workspace (chown au démarrage)", async () => {
    const f = await sandboxFixture({ prepare: ({ work, outside }) => fs.linkSync(path.join(outside, "cible.txt"), path.join(work, "uploads", "dur.txt")) });
    await call(f.sandbox, "list_files");
    expect(fs.statSync(path.join(f.outside, "cible.txt")).uid).toBe(0);
    expect(fs.statSync(path.join(f.work, "uploads", "ventes.csv")).uid).toBe(1000);
  });
});

describe("mcp-sandbox — render_pptx", () => {
  it("écarte la page fautive en le disant, et garde les autres", async () => {
    const tmp = tmpDir();
    const hook = path.join(tmp, "hook.sh");
    const f = await sandboxFixture({
      env: { RENDER_HOOK: hook },
      prepare: ({ work, outside }) => {
        fs.writeFileSync(path.join(work, "out", "deck.pdf"), "%PDF-1.4\n");
        // Le « conteneur » pose un lien à la place de la page 1, une vraie page 2, une page 3 démesurée.
        fs.writeFileSync(hook, `ln -s ${path.join(outside, "secret.txt")} out/deck-p1.jpg; printf JPEG2 > out/deck-p2.jpg; truncate -s 4M out/deck-p3.jpg\n`);
      },
    });
    const r = await render(f.sandbox, { path: "out/deck.pdf" });
    expect(r.isError).toBe(false);
    expect(r.images).toEqual(["JPEG2"]);
    expect(r.text).toContain("pages 2 ci-dessous (fichiers /work/out/deck-p02.jpg)");
    expect(r.text).toContain("page 1 ignorée : Lien symbolique refusé : /work/out/deck-p01.jpg");
    expect(r.text).toContain("page 3 ignorée : image de 4.0 Mo, au-delà des 3.0 Mo renvoyés par page");
    expect(r.text).not.toContain("SECRET");
    expect(fs.readFileSync(path.join(f.outside, "secret.txt"), "utf8")).toBe("SECRET-HORS-WORKSPACE\n");
  });

  it("passe le nom du document en argument : le shell du conteneur ne l'interprète pas", async () => {
    const name = 'a"$(touch PIRATE)".pdf';
    const f = await sandboxFixture({ prepare: ({ work }) => fs.writeFileSync(path.join(work, "out", name), "%PDF-1.4\n") });
    const r = await render(f.sandbox, { path: `out/${name}` });
    expect(tree(f.work).filter((p) => p.includes("PIRATE") && !p.endsWith(".pdf") && !p.endsWith(".jpg"))).toEqual([]);
    expect(r.isError).toBe(false);
    expect(r.images).toEqual(["JPEG1"]);
    const run = readLines(f.log).find((l) => l.startsWith("docker run")) ?? "";
    expect(run).toContain(` rendu /work/out/${name} /work/out/a_touch_PIRATE_-p 1 8`);
  });
});

// ── Google Workspace ────────────────────────────────────────────────────────

async function gwsFixture({ env = {}, wrap = [] }: { env?: Record<string, string>; wrap?: string[] } = {}) {
  const tmp = tmpDir();
  const bin = path.join(tmp, "bin");
  const work = path.join(tmp, "gws-work");
  const outside = path.join(tmp, "outside");
  for (const d of [bin, path.join(work, "out"), path.join(work, "uploads"), outside]) fs.mkdirSync(d, { recursive: true });
  fs.chmodSync(bin, 0o755);
  const files = [1, 2, 3].map((i) => ({ kind: "drive#file", id: `id-${i}`, name: `Monthly ${i}`, size: `00${i}` }));
  fs.writeFileSync(path.join(bin, "files.json"), JSON.stringify({ files, nextPageToken: "tok-2" }, null, 2));
  fs.writeFileSync(path.join(bin, "error.json"), JSON.stringify({ error: { code: 404, message: "File not found: zzz.", reason: "notFound" } }, null, 2));
  fs.writeFileSync(path.join(outside, "secret.txt"), "SECRET-HORS-WORKSPACE\n", { mode: 0o644 });
  fs.writeFileSync(path.join(work, "uploads", "note.txt"), "contenu du consultant\n", { mode: 0o644 });
  // Journal du faux CLI (arguments, dossier courant), écrit en utilisateur non privilégié.
  const log = path.join(bin, "gws.log");
  fs.writeFileSync(log, "");
  fs.chmodSync(log, 0o666);
  // Dossier temporaire de l'essai, ouvert à tous comme /tmp.
  const tmpdir = path.join(tmp, "tmpdir");
  fs.mkdirSync(tmpdir);
  fs.chmodSync(tmpdir, 0o1777);
  // Faux CLI : répond selon la méthode, sans réseau. --upload : montre ce qu'il
  // aurait envoyé ; --output : écrit le fichier là où on le lui dit, comme le vrai.
  fs.writeFileSync(path.join(bin, "gws"), [
    "#!/bin/sh",
    `D=${bin}`,
    'ALL="$*"; UP=""; OUT=""',
    'echo "ARGS: $ALL" >> "$D/gws.log"; echo "CWD: $PWD" >> "$D/gws.log"',
    "while [ $# -gt 0 ]; do",
    '  case "$1" in',
    '    --upload|--attach) UP="$UP $2"; shift 2 ;;',
    '    --output) OUT="$2"; shift 2 ;;',
    "    *) shift ;;",
    "  esac",
    "done",
    'case "$ALL" in',
    '  *"files list"*) cat "$D/files.json" ;;',
    '  *"files export"*) printf "%%PDF-1.4 x\\n" > "$OUT"; echo "{\\"bytes\\": 12, \\"saved_file\\": \\"$PWD/$OUT\\", \\"status\\": \\"success\\"}"; echo "wrote $PWD/$OUT" >&2 ;;',
    '  *"files create"*|*"+send"*) for f in $UP; do echo "envoi de $f :"; cat "$f"; done ;;',
    '  *"files get"*) cat "$D/error.json"; echo "error[api]: File not found: zzz." >&2; exit 1 ;;',
    '  *"files copy"*) sleep 5 ;;',
    '  *) echo "gws 0.22.5" ;;',
    "esac",
    "",
  ].join("\n"), { mode: 0o755 });
  const gws = await start("mcp-gws.mjs", { PATH: `${bin}:/usr/bin:/bin`, GWS_ACCESS_TOKEN: "jeton-de-test", WORKSPACE_DIR: work, TMPDIR: tmpdir, ...env }, wrap);
  return { gws, tmp, work, outside, log, tmpdir };
}

describe("mcp-gws — gws_run", () => {
  it("garde un schéma inchangé", async () => {
    const { gws } = await gwsFixture();
    const { tools } = await gws.listTools();
    expect(tools.find((t) => t.name === "gws_run")?.inputSchema.required).toEqual(["command"]);
  });

  it("rend une liste en tableau, sans écho des paramètres", async () => {
    const { gws } = await gwsFixture();
    const params = { q: "name contains 'monthly' and trashed = false", pageSize: 20, fields: "files(kind,id,name,size)" };
    const r = await call(gws, "gws_run", { command: "drive files list", params });
    expect(r.isError).toBe(false);
    const lines = r.text.split("\n");
    expect(lines[0]).toMatch(/^gws drive files list : OK \(\d+\.\d s\)$/);
    expect(lines.slice(1)).toEqual([
      "nextPageToken=tok-2",
      "# files : 3 lignes ; valeur identique sur chaque ligne : kind=drive#file",
      "id\tname\tsize",
      "id-1\tMonthly 1\t001",
      "id-2\tMonthly 2\t002",
      "id-3\tMonthly 3\t003",
    ]);
    expect(r.text).not.toContain("trashed");
    expect(r.text).not.toContain("--params");
  });

  it("télécharge dans out/ et montre le chemin côté modèle, pas celui de l'hôte, stderr compris", async () => {
    const { gws, work } = await gwsFixture();
    const r = await call(gws, "gws_run", { command: "drive files export", params: { fileId: "id-1", mimeType: "application/pdf" }, output: "out/brief.pdf" });
    expect(r.isError).toBe(false);
    expect(r.text).toContain('{"bytes":12,"saved_file":"/work/out/brief.pdf","status":"success"}');
    expect(r.text).toContain("--- stderr ---\nwrote /work/out/brief.pdf");
    expect(r.text).toContain("Écrit dans le workspace : /work/out/brief.pdf (11 o)");
    expect(r.text).not.toContain(os.tmpdir());
    expect(r.text).not.toContain("/work/./");
    const abs = path.join(work, "out", "brief.pdf");
    expect(fs.readFileSync(abs, "utf8")).toBe("%PDF-1.4 x\n");
    expect(fs.lstatSync(abs).isFile()).toBe(true);
    if (IS_ROOT) expect(fs.statSync(abs).uid).toBe(1000);
  });

  it("garde l'erreur de l'API entière, avec la commande et le code de sortie", async () => {
    const { gws } = await gwsFixture();
    const r = await call(gws, "gws_run", { command: "drive files get", params: { fileId: "zzz" } });
    expect(r.isError).toBe(true);
    expect(r.text.split("\n")).toEqual([
      expect.stringMatching(/^gws drive files get : code de sortie 1 \(\d+\.\d s\) — erreur API Google$/),
      '{"error":{"code":404,"message":"File not found: zzz.","reason":"notFound"}}',
      "--- stderr ---",
      "error[api]: File not found: zzz.",
    ]);
  });

  it("refuse toujours une écriture sans confirm_write", async () => {
    const { gws } = await gwsFixture();
    const r = await call(gws, "gws_run", { command: "drive files create", body: { name: "x" } });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^Refusé : « create » modifie/);
  });

  it("envoie un vrai fichier du workspace", async () => {
    const { gws } = await gwsFixture();
    const r = await call(gws, "gws_run", { command: "drive files create", body: { name: "note.txt" }, upload: "uploads/note.txt", confirm_write: true });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("envoi de ./uploads/note.txt :\ncontenu du consultant");
  });
});

describe("mcp-gws — liens symboliques posés par le conteneur", () => {
  it("n'envoie pas vers Drive un fichier de l'hôte visé par un lien (upload, pièce jointe)", async () => {
    const { gws, work, outside } = await gwsFixture();
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(work, "out", "lien.txt"));
    fs.symlinkSync(outside, path.join(work, "out", "dossier"));
    for (const p of ["out/lien.txt", "out/dossier/secret.txt"]) {
      const up = await call(gws, "gws_run", { command: "drive files create", body: { name: "x" }, upload: p, confirm_write: true });
      expect(up.isError).toBe(true);
      expect(up.text).not.toContain("SECRET");
      const att = await call(gws, "gws_run", { command: "gmail +send", flags: { to: "a@example.test", subject: "s", body: "b" }, attach: [p], confirm_write: true });
      expect(att.isError).toBe(true);
      expect(att.text).not.toContain("SECRET");
    }
  });

  it("ne crée ni dossier ni fichier à travers un dossier out remplacé par un lien (output)", async () => {
    const { gws, work, outside } = await gwsFixture();
    const dir = path.join(outside, "dossier");
    fs.mkdirSync(dir, { mode: 0o777 });
    fs.chmodSync(dir, 0o777);
    fs.rmSync(path.join(work, "out"), { recursive: true });
    fs.symlinkSync(dir, path.join(work, "out"));
    const r = await call(gws, "gws_run", { command: "drive files export", params: { fileId: "id-1" }, output: "out/sous/brief.pdf" });
    expect(r.isError).toBe(true);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("n'écrit pas à travers un lien posé à la place du fichier de sortie", async () => {
    const { gws, work, outside } = await gwsFixture();
    const cible = path.join(outside, "cible.txt");
    fs.writeFileSync(cible, "contenu intact\n", { mode: 0o666 });
    fs.chmodSync(cible, 0o666);
    fs.symlinkSync(cible, path.join(work, "out", "brief.pdf"));
    await call(gws, "gws_run", { command: "drive files export", params: { fileId: "id-1" }, output: "out/brief.pdf" });
    expect(fs.readFileSync(cible, "utf8")).toBe("contenu intact\n");
    // Le lien est remplacé par le vrai fichier téléchargé.
    expect(fs.lstatSync(path.join(work, "out", "brief.pdf")).isFile()).toBe(true);
  });
});

describe("mcp-gws — noms pièges, doublons, liens durs", () => {
  const argsOf = (log: string) => readLines(log).filter((l) => l.startsWith("ARGS: "));

  it("passe les chemins en ./ : un fichier nommé comme une option reste un fichier", async () => {
    const { gws, work, log } = await gwsFixture();
    fs.writeFileSync(path.join(work, "-x"), "fichier tiret\n", { mode: 0o644 });
    fs.writeFileSync(path.join(work, "--dry-run"), "fichier deux tirets\n", { mode: 0o644 });
    const up = await call(gws, "gws_run", { command: "drive files create", body: { name: "x" }, upload: "-x", confirm_write: true });
    expect(up.text).toContain("envoi de ./-x :\nfichier tiret");
    expect(argsOf(log).at(-1)).toMatch(/ --upload \.\/-x$/);
    await call(gws, "gws_run", { command: "gmail +send", flags: { to: "a@example.test", subject: "s", body: "b" }, attach: ["./--dry-run"], confirm_write: true });
    expect(argsOf(log).at(-1)).toMatch(/ --attach \.\/--dry-run$/);
    expect(argsOf(log).at(-1)).not.toMatch(/ --dry-run( |$)/);
    await call(gws, "gws_run", { command: "drive files export", params: { fileId: "id-1" }, output: "out/-o.pdf" });
    expect(argsOf(log).at(-1)).toMatch(/ --output \.\/out\/-o\.pdf$/);
    expect(fs.readFileSync(path.join(work, "out", "-o.pdf"), "utf8")).toBe("%PDF-1.4 x\n");
  });

  it("n'échoue pas sur un fichier demandé deux fois, et ne le joint qu'une fois", async () => {
    const { gws, log } = await gwsFixture();
    const flags = { to: "a@example.test", subject: "s", body: "b" };
    const twice = await call(gws, "gws_run", { command: "gmail +send", flags, attach: ["uploads/note.txt", "/work/uploads/note.txt"], confirm_write: true });
    expect(twice.isError).toBe(false);
    expect(twice.text).not.toContain("EEXIST");
    expect(argsOf(log).at(-1)!.split(" --attach ")).toHaveLength(2);
    const both = await call(gws, "gws_run", { command: "gmail +send", flags, upload: "uploads/note.txt", attach: ["uploads/note.txt"], confirm_write: true });
    expect(both.isError).toBe(false);
    expect(argsOf(log).at(-1)).toMatch(/ --upload \.\/uploads\/note\.txt --attach \.\/uploads\/note\.txt$/);
  });

  it("n'envoie pas un fichier qui a un autre nom hors du workspace (lien dur)", async () => {
    const { gws, work, outside, log } = await gwsFixture();
    fs.linkSync(path.join(outside, "secret.txt"), path.join(work, "out", "dur.txt"));
    const up = await call(gws, "gws_run", { command: "drive files create", body: { name: "x" }, upload: "out/dur.txt", confirm_write: true });
    expect(up.isError).toBe(true);
    expect(up.text).toMatch(/^Erreur : Lien dur refusé : \/work\/out\/dur\.txt — ce fichier a 2 noms/);
    const att = await call(gws, "gws_run", { command: "gmail +send", flags: { to: "a@example.test", subject: "s", body: "b" }, attach: ["out/dur.txt"], confirm_write: true });
    expect(att.isError).toBe(true);
    expect(`${up.text}${att.text}`).not.toContain("SECRET");
    expect(argsOf(log)).toEqual([]);
  });
});

describe("mcp-gws — dossiers temporaires", () => {
  it("ne travaille jamais dans le workspace, même quand TMPDIR y pointe", async () => {
    const tmp = tmpDir();
    const work = path.join(tmp, "w");
    fs.mkdirSync(path.join(work, "tmp"), { recursive: true });
    fs.chmodSync(path.join(work, "tmp"), 0o1777);
    fs.mkdirSync(path.join(work, "uploads"));
    fs.writeFileSync(path.join(work, "uploads", "note.txt"), "contenu du consultant\n", { mode: 0o644 });
    const { gws, log } = await gwsFixture({ env: { WORKSPACE_DIR: work, TMPDIR: path.join(work, "tmp") } });
    const r = await call(gws, "gws_run", { command: "drive files create", body: { name: "x" }, upload: "uploads/note.txt", confirm_write: true });
    expect(r.text).toContain("envoi de ./uploads/note.txt :\ncontenu du consultant");
    const cwd = readLines(log).filter((l) => l.startsWith("CWD: ")).at(-1)!.slice(5);
    expect(cwd).toMatch(/im-gws-transit-/);
    expect(cwd.startsWith(work)).toBe(false);
    expect(fs.readdirSync(path.join(work, "tmp"))).toEqual([]);
  });

  it("retire ses dossiers temporaires quand le serveur est coupé en pleine commande", async () => {
    const { gws, log, tmpdir } = await gwsFixture();
    call(gws, "gws_run", { command: "drive files copy", params: { fileId: "id-1" }, upload: "uploads/note.txt", confirm_write: true }).catch(() => undefined);
    expect(await waitFor(() => readLines(log).some((l) => l.startsWith("CWD: ")), 3000)).toBe(true);
    expect(fs.readdirSync(tmpdir).map((d) => d.replace(/-[^-]*$/, "")).sort()).toEqual(["im-gws", "im-gws-transit"]);
    process.kill(pids.get(gws)!, "SIGTERM");
    expect(await waitFor(() => fs.readdirSync(tmpdir).length === 0, 1500)).toBe(true);
  });
});

/**
 * Rangement d'un téléchargement : entre le retrait de l'ancien nom et la
 * création du fichier, le bac à sable peut reposer quelque chose sous ce nom.
 * strace retient le serveur 0,6 s à la sortie de chaque unlink : l'essai pose
 * son piège dans cette fenêtre, à coup sûr.
 */
const STRACE = ["/usr/bin/strace", "/bin/strace"].find((p) => fs.existsSync(p)) ?? "";

describe.runIf(STRACE)("mcp-gws — rangement d'un téléchargement (O_EXCL, O_NOFOLLOW)", () => {
  const wrap = [STRACE, "-f", "-qq", "-o", "/dev/null", "-e", "trace=unlink,unlinkat", "-e", "inject=unlink,unlinkat:delay_exit=600000"];

  /** Télécharge sur un ancien fichier ; `plant` est joué dès que l'ancien nom a été retiré. */
  async function exportWhile(plant: (f: { work: string; outside: string; dest: string }) => void) {
    const f = await gwsFixture({ wrap });
    const dest = path.join(f.work, "out", "brief.pdf");
    fs.writeFileSync(dest, "ancienne version\n");
    let planted = false;
    const racer = setInterval(() => {
      if (planted || fs.existsSync(dest) || fs.lstatSync(dest, { throwIfNoEntry: false })) return;
      planted = true;
      plant({ ...f, dest });
    }, 5);
    try {
      const r = await call(f.gws, "gws_run", { command: "drive files export", params: { fileId: "id-1" }, output: "out/brief.pdf" });
      return { ...f, r, dest, planted };
    } finally { clearInterval(racer); }
  }

  it("n'écrit pas à travers un lien reposé entre le retrait et la création", async () => {
    const cible = (outside: string) => path.join(outside, "cible.txt");
    const f = await exportWhile(({ outside, dest }) => {
      fs.writeFileSync(cible(outside), "contenu intact\n", { mode: 0o666 });
      fs.symlinkSync(cible(outside), dest);
    });
    expect(f.planted).toBe(true);
    expect(fs.readFileSync(cible(f.outside), "utf8")).toBe("contenu intact\n");
    if (IS_ROOT) expect(fs.statSync(cible(f.outside)).uid).toBe(0);
    expect(f.r.text).toContain("Téléchargé mais non rangé dans le workspace : /work/out/brief.pdf");
    expect(f.r.text).not.toContain("Écrit dans le workspace");
  }, 30_000);

  it("n'écrit pas dans un fichier reposé entre le retrait et la création", async () => {
    const f = await exportWhile(({ dest }) => fs.writeFileSync(dest, "fichier du bac à sable, plus long que le téléchargement\n"));
    expect(f.planted).toBe(true);
    expect(fs.readFileSync(f.dest, "utf8")).toBe("fichier du bac à sable, plus long que le téléchargement\n");
    if (IS_ROOT) expect(fs.statSync(f.dest).uid).toBe(0);
    expect(f.r.text).toContain("Téléchargé mais non rangé dans le workspace : /work/out/brief.pdf");
  }, 30_000);
});
