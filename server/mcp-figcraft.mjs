#!/usr/bin/env node
/**
 * MCP server "figcraft" for the AI of a design conversation (server/relay.mjs).
 *
 * One `figcraft-cli mcp` child (FigCraft without a window) joins the shared
 * design file of the conversation (FIGCRAFT_JOIN_LINK) before the model's first
 * tool call; every edit the model makes then shows live in the consultant's
 * browser, and the consultant's edits are read by the model (inspect_document).
 *
 * The child's own MCP tools are exposed as they are (list_commands,
 * run_command, batch, create_node, set_properties, inspect_document, get_node,
 * select, export, screenshot, undo, redo, pointer, key, type_text, inspect_ui,
 * save_file…), with two guards the relay relies on:
 *   - commands that would leave, stop or re-share the session, open another
 *     document or touch the app's preferences are refused here (DENIED_COMMANDS):
 *     the model stays in the consultant's file, and cannot revoke the links;
 *   - `open_file` is refused (it opens another document); files are read and
 *     written only inside the conversation's workspace (uploads/ read, out/
 *     written), enforced by figcraft-cli's automation roots.
 *
 * Env: FIGCRAFT_JOIN_LINK (loopback ws:// link with the edit token),
 *      WORKSPACE_DIR (the conversation's workspace: uploads/ and out/),
 *      FIGCRAFT_CLI (binary; default /usr/local/bin/figcraft-cli).
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CLI = process.env.FIGCRAFT_CLI || "/usr/local/bin/figcraft-cli";
const JOIN_LINK = (process.env.FIGCRAFT_JOIN_LINK || "").trim();
const WORKSPACE_DIR = (process.env.WORKSPACE_DIR || "").trim();
const JOIN_TIMEOUT_MS = 25_000;

const DENIED_COMMANDS = /^(collab\.(stop|leave|publish|share|host|manageFile|removePerson|forgetFile|recoverFile|report|openFile|files|serverInfo)|file\.(open|openRecent|new|newBoard|newFromTemplate|close|closeAll|closeOthers|quit|revert|publish)|plugin|pref\.|app\.|window\.|update\.|account\.|library\.publish)/i;
const DENIED_TOOLS = new Set(["open_file"]);

function log(msg) { process.stderr.write(`[mcp-figcraft] ${msg}\n`); }

// ── Child ───────────────────────────────────────────────────────────────────

const args = ["mcp"];
let cwd = os.tmpdir();
if (WORKSPACE_DIR) {
  const uploads = path.join(WORKSPACE_DIR, "uploads");
  const out = path.join(WORKSPACE_DIR, "out");
  for (const d of [uploads, out]) { try { fs.mkdirSync(d, { recursive: true }); } catch { /* checked below */ } }
  if (fs.existsSync(uploads)) args.push("--automation-read-root", uploads);
  if (fs.existsSync(out)) { args.push("--automation-read-root", out, "--automation-write-root", out); cwd = WORKSPACE_DIR; }
} else {
  // No workspace: nothing may be read or written (exports come back inline).
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "figcraft-none-"));
  args.push("--automation-read-root", empty);
}

const child = spawn(CLI, args, { cwd, stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin", HOME: os.tmpdir(), LANG: "C.UTF-8" } });
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stderr.on("data", (d) => { for (const line of String(d).split("\n")) if (line.trim()) log(`cli: ${line.trim().slice(0, 300)}`); });
child.on("exit", (code, signal) => { log(`figcraft-cli terminé (${signal || code})`); process.exit(0); });

let childBuf = "";
const internal = new Map(); // id → resolve (our own requests during the join phase)
let forwarding = false;
let initResult = null;

child.stdout.on("data", (chunk) => {
  childBuf += chunk;
  let i;
  while ((i = childBuf.indexOf("\n")) >= 0) {
    const line = childBuf.slice(0, i);
    childBuf = childBuf.slice(i + 1);
    if (!line.trim()) continue;
    let msg = null;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg && msg.id != null && internal.has(msg.id)) {
      const r = internal.get(msg.id);
      internal.delete(msg.id);
      r(msg);
      continue;
    }
    if (forwarding) process.stdout.write(line + "\n");
  }
});

let nextInternal = 1;
function internalRequest(method, params, timeoutMs = 30_000) {
  const id = `relay-${nextInternal++}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { internal.delete(id); reject(new Error(`${method} sans réponse`)); }, timeoutMs);
    internal.set(id, (msg) => { clearTimeout(timer); if (msg.error) reject(new Error(msg.error.message || method)); else resolve(msg.result); });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}
function textOf(result) {
  const content = Array.isArray(result?.content) ? result.content : [];
  return content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
}
async function runCommand(command, params = {}) {
  const result = await internalRequest("tools/call", { name: "run_command", arguments: { command, params } });
  const text = textOf(result);
  if (result?.isError) throw new Error(text || command);
  try { return JSON.parse(text); } catch { return text; }
}

// ── Join the conversation's file before serving the model ───────────────────

let joinError = null;
async function joinFile() {
  initResult = await internalRequest("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "impulsemotion-relay", version: "1.0.0" } });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  if (!JOIN_LINK) { joinError = "aucun fichier de design n'est attaché à cette conversation"; return; }
  await runCommand("collab.join", { link: JOIN_LINK });
  const deadline = Date.now() + JOIN_TIMEOUT_MS;
  let last = null;
  while (Date.now() < deadline) {
    last = await runCommand("collab.peers", {});
    if (last?.status === "live") { log(`fichier rejoint : ${last.fileName ?? "?"} (${last.access ?? "?"}, ${(last.peers || []).length} autre(s) connecté(s))`); return; }
    if (last?.status === "failed") { joinError = `connexion au fichier refusée${last.reason ? ` : ${last.reason}` : ""}`; return; }
    await new Promise((r) => setTimeout(r, 250));
  }
  joinError = `le fichier n'a pas répondu à temps (${last?.status ?? "inconnu"})`;
}

// ── Serve the model (stdin → child, child → stdout) ─────────────────────────

function reply(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n"); }
function refuse(id, text) { reply(id, { content: [{ type: "text", text }], isError: true }); }

function deniedReason(name, a) {
  if (DENIED_TOOLS.has(name)) return `Outil ${name} refusé : cette conversation travaille dans le fichier partagé avec le consultant. Les fichiers déposés se lisent avec file.import / image.place (chemin uploads/…).`;
  if (name === "run_command" && typeof a?.command === "string" && DENIED_COMMANDS.test(a.command)) return `Commande ${a.command} refusée : la session partagée avec le consultant est gérée par ImpulseMotion (pas de changement de fichier, de partage ni de préférences).`;
  if (name === "batch" && Array.isArray(a?.commands)) {
    const bad = a.commands.find((c) => typeof c?.command === "string" && DENIED_COMMANDS.test(c.command));
    if (bad) return `Commande ${bad.command} refusée dans le lot : la session partagée est gérée par ImpulseMotion.`;
  }
  return null;
}

let inBuf = "";
const ready = joinFile().catch((e) => { joinError = e.message; });

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  inBuf += chunk;
  let i;
  while ((i = inBuf.indexOf("\n")) >= 0) {
    const line = inBuf.slice(0, i);
    inBuf = inBuf.slice(i + 1);
    if (!line.trim()) continue;
    void handleLine(line);
  }
});
process.stdin.on("end", () => { try { child.stdin.end(); } catch { /* gone */ } setTimeout(() => process.exit(0), 1500).unref(); });

async function handleLine(line) {
  let msg = null;
  try { msg = JSON.parse(line); } catch { return; }
  if (!msg || typeof msg !== "object") return;
  await ready;
  forwarding = true;
  if (msg.method === "initialize") {
    const result = initResult || { protocolVersion: msg.params?.protocolVersion || "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "figcraft", version: "1.0.0" } };
    reply(msg.id, { ...result, serverInfo: { name: "figcraft", version: result.serverInfo?.version || "1.0.0" }, ...(joinError ? { instructions: `Fichier de design indisponible : ${joinError}` } : {}) });
    return;
  }
  if (msg.method === "notifications/initialized") return;
  if (msg.method === "tools/call") {
    const name = msg.params?.name;
    const a = msg.params?.arguments || {};
    if (joinError && name !== "list_commands") return refuse(msg.id, `Le fichier de design de cette conversation est inaccessible (${joinError}). Dites-le au consultant : il peut rouvrir la page du design ou en créer un nouveau.`);
    const denied = deniedReason(name, a);
    if (denied) return refuse(msg.id, denied);
  }
  child.stdin.write(line + "\n");
}
