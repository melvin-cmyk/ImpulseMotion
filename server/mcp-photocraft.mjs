#!/usr/bin/env node
/**
 * MCP server "photocraft" for the AI of a retouching conversation (server/relay.mjs).
 *
 * One headless `photocraft-cli mcp` child (PhotoCraft — the open-source
 * Photoshop of the FigCraft team — without a window). PhotoCraft has no shared
 * live file: the model opens the files the consultant dropped (uploads/),
 * edits them with PhotoCraft's commands (layers, masks, adjustments, text,
 * crop, resize, select subject…) and saves its results in out/, which the app
 * lists for download and the consultant opens in the web editor. File access
 * is confined by PhotoCraft's own automation roots (the workspace read, out/
 * written) — nothing else on the host is reachable.
 *
 * Env: WORKSPACE_DIR (the conversation's workspace: uploads/ and out/),
 *      PHOTOCRAFT_CLI (binary; default /usr/local/bin/photocraft-cli).
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CLI = process.env.PHOTOCRAFT_CLI || "/usr/local/bin/photocraft-cli";
const WORKSPACE_DIR = (process.env.WORKSPACE_DIR || "").trim();

const LOG_FILE = process.env.PHOTOCRAFT_MCP_LOG || "/var/log/impulsemotion-photocraft.log";
function log(msg) {
  const line = `[mcp-photocraft] ${new Date().toISOString()} ${msg}\n`;
  process.stderr.write(line);
  try { fs.appendFileSync(LOG_FILE, line); } catch { /* no log file: stderr only */ }
}

const args = ["mcp"];
let cwd = os.tmpdir();
if (WORKSPACE_DIR) {
  const uploads = path.join(WORKSPACE_DIR, "uploads");
  const out = path.join(WORKSPACE_DIR, "out");
  for (const d of [uploads, out]) { try { fs.mkdirSync(d, { recursive: true }); } catch { /* checked below */ } }
  // One read root only (the CLI refuses the flag twice): the workspace itself, which holds uploads/ and out/.
  args.push("--automation-read-root", WORKSPACE_DIR);
  if (fs.existsSync(out)) { args.push("--automation-write-root", out); cwd = WORKSPACE_DIR; }
} else {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "photocraft-none-"));
  args.push("--automation-read-root", empty);
}
if (!fs.existsSync(CLI)) { log(`binaire absent : ${CLI}`); process.exit(1); }

// Transparent stdio proxy: the model talks MCP to photocraft-cli directly; we
// only pin the working directory, the roots and a clean environment (CPU
// rendering, no GPU on the host, temporary HOME so nothing persists).
log(`démarrage ${CLI} ${args.join(" ")} (cwd ${cwd})`);
const child = spawn(CLI, args, {
  cwd,
  stdio: ["pipe", "pipe", "pipe"],
  env: { PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin", HOME: fs.mkdtempSync(path.join(os.tmpdir(), "photocraft-home-")), LANG: "C.UTF-8", WGPU_BACKEND: "noop", PHOTOCRAFT_FORCE_CPU: "1" },
});
child.stderr.setEncoding("utf8");
child.stderr.on("data", (d) => { for (const line of String(d).split("\n")) if (line.trim()) log(`cli: ${line.trim().slice(0, 300)}`); });
process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout);
child.on("error", (e) => { log(`spawn impossible : ${e.message}`); process.exit(1); });
child.on("exit", (code, signal) => { log(`photocraft-cli terminé (${signal ?? code})`); process.exit(code ?? 0); });
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => { try { child.kill(sig); } catch { /* gone */ } });
process.stdin.on("end", () => { try { child.stdin.end(); } catch { /* gone */ } });
