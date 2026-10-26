/**
 * FigCraft for the relay: design files that consultants edit in the browser
 * (the FigCraft web build, served by Caddy under /figcraft/) and that the AI
 * edits with them, live, through server/mcp-figcraft.mjs.
 *
 * Every file lives on the agency's figcraft-server (systemd `figcraft-server`,
 * loopback :47900, data /var/lib/figcraft-server). This module is the only
 * place that holds the server's publish key (FIGCRAFT_SERVER_URL, with ?key=):
 * it creates files, exports and previews them, and removes them. The browser
 * and the AI only ever get a file's share link (an edit or view token).
 *
 * A "headless session" is one `figcraft-cli mcp` process (FigCraft without a
 * window, MCP over stdio) that joins or publishes one file, does its work and
 * exits. At most FIGCRAFT_MAX_SESSIONS run at once (each is a full engine).
 */

import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const FIGCRAFT_CLI = process.env.FIGCRAFT_CLI || "/usr/local/bin/figcraft-cli";
const SERVER_BIN = process.env.FIGCRAFT_SERVER_BIN || "/usr/local/bin/figcraft-server";
const SERVER_CONFIG = process.env.FIGCRAFT_SERVER_CONFIG || "/etc/figcraft-server/server.toml";
/** ws://127.0.0.1:47900/?key=… — publish address with the server key (relay only). */
const SERVER_URL = (process.env.FIGCRAFT_SERVER_URL || "").trim();
const MAX_SESSIONS = Math.max(1, Number(process.env.FIGCRAFT_MAX_SESSIONS || 2));
const SESSION_START_TIMEOUT_MS = 20_000;
const JOIN_TIMEOUT_MS = 20_000;
const CALL_TIMEOUT_MS = 60_000;
const QUEUE_TIMEOUT_MS = 90_000;

export function figcraftConfigured() {
  return !!SERVER_URL && fs.existsSync(FIGCRAFT_CLI);
}

/** The server's loopback origin (ws://127.0.0.1:47900/), without the key. */
export function serverOrigin() {
  if (!SERVER_URL) return null;
  try { const u = new URL(SERVER_URL); return `${u.protocol}//${u.host}${u.pathname || "/"}`; } catch { return null; }
}

const TOKEN_RE = /^[A-Za-z0-9_-]{8,256}$/;
const FILE_RE = /^[a-f0-9]{8,32}$/;

/**
 * A share link in any of FigCraft's forms →  { file, token, server } or null:
 *   figcraft://join?server=wss://host/path/&file=…&token=…
 *   figcraft://join?host=host:port&file=…&token=…
 *   ws(s)://host[:port]/path/?file=…&token=…
 */
export function parseShareLink(link) {
  if (typeof link !== "string" || link.length > 2048) return null;
  let u;
  try { u = new URL(link.trim()); } catch { return null; }
  const file = u.searchParams.get("file") || "";
  const token = u.searchParams.get("token") || "";
  if (!FILE_RE.test(file) || !TOKEN_RE.test(token)) return null;
  let server = null;
  if (u.protocol === "figcraft:") {
    server = u.searchParams.get("server") || (u.searchParams.get("host") ? `ws://${u.searchParams.get("host")}/` : null);
  } else if (u.protocol === "ws:" || u.protocol === "wss:") {
    server = `${u.protocol}//${u.host}${u.pathname || "/"}`;
  } else return null;
  if (!server) return null;
  return { file, token, server };
}

/** The same file reached on the loopback address (server-side sessions never go through Caddy). */
export function loopbackLink(link) {
  const parsed = parseShareLink(link);
  const origin = serverOrigin();
  if (!parsed || !origin) return null;
  return `${origin}?file=${parsed.file}&token=${parsed.token}`;
}

/** wss://host/figcraft-collab/ — how browsers reach the server (through Caddy). */
const COLLAB_PUBLIC_URL = (process.env.FIGCRAFT_COLLAB_PUBLIC_URL || "").trim();

/**
 * The same file as a link the browser can open: the CLI composes its links
 * from the address it connected to (loopback), so they are renamed here to
 * the public WebSocket address. Without one, the link is returned as is.
 */
export function publicLink(link) {
  const parsed = parseShareLink(link);
  if (!parsed) return null;
  if (!COLLAB_PUBLIC_URL) return link;
  return `figcraft://join?server=${encodeURIComponent(COLLAB_PUBLIC_URL)}&file=${parsed.file}&token=${parsed.token}`;
}

// ── Headless session (figcraft-cli mcp over stdio) ──────────────────────────

let running = 0;
const queue = [];
function acquire() {
  if (running < MAX_SESSIONS) { running += 1; return Promise.resolve(); }
  return new Promise((resolve, reject) => {
    const entry = { resolve, reject, timer: null };
    entry.timer = setTimeout(() => {
      const i = queue.indexOf(entry);
      if (i >= 0) queue.splice(i, 1);
      reject(new Error("FigCraft est occupé (trop de sessions en même temps) : réessayez dans un instant."));
    }, QUEUE_TIMEOUT_MS);
    queue.push(entry);
  });
}
function release() {
  const next = queue.shift();
  if (next) { clearTimeout(next.timer); next.resolve(); }
  else running = Math.max(0, running - 1);
}

export class HeadlessSession {
  /**
   * @param {{ readRoots?: string[], writeRoots?: string[], cwd?: string, label?: string }} opts
   */
  constructor(opts = {}) {
    this.readRoots = opts.readRoots || [];
    this.writeRoots = opts.writeRoots || [];
    this.cwd = opts.cwd || os.tmpdir();
    this.label = opts.label || "figcraft";
    this.child = null;
    this.pending = new Map();
    this.nextId = 1;
    this.buffer = "";
    this.closed = false;
    this.stderr = "";
  }

  async start() {
    if (!fs.existsSync(FIGCRAFT_CLI)) throw new Error(`figcraft-cli introuvable (${FIGCRAFT_CLI})`);
    const args = ["mcp"];
    for (const r of this.readRoots) args.push("--automation-read-root", r);
    for (const r of this.writeRoots) args.push("--automation-write-root", r);
    this.child = spawn(FIGCRAFT_CLI, args, {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin", HOME: os.tmpdir(), LANG: "C.UTF-8" },
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this.onData(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => { this.stderr = (this.stderr + chunk).slice(-4000); });
    this.child.on("exit", (code, signal) => {
      this.closed = true;
      const err = new Error(`figcraft-cli terminé (${signal || code})${this.stderr ? ` : ${this.stderr.trim().split("\n").pop()}` : ""}`);
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(err); }
      this.pending.clear();
    });
    await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "impulsemotion-relay", version: "1.0.0" },
    }, SESSION_START_TIMEOUT_MS);
    this.notify("notifications/initialized", {});
  }

  onData(chunk) {
    this.buffer += chunk;
    let i;
    while ((i = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, i);
      this.buffer = this.buffer.slice(i + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id == null || !this.pending.has(msg.id)) continue;
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error.message || "erreur FigCraft"));
      else p.resolve(msg.result);
    }
  }

  notify(method, params) {
    if (this.closed || !this.child) return;
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  request(method, params, timeoutMs = CALL_TIMEOUT_MS) {
    if (this.closed || !this.child) return Promise.reject(new Error("session FigCraft fermée"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`FigCraft ne répond pas (${method})`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  /** Calls an MCP tool; returns the parsed JSON of its text content when it is JSON, else the raw content list. */
  async call(name, args = {}, timeoutMs = CALL_TIMEOUT_MS) {
    const result = await this.request("tools/call", { name, arguments: args }, timeoutMs);
    const content = Array.isArray(result?.content) ? result.content : [];
    const text = content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
    if (result?.isError) throw new Error(text || `échec de ${name}`);
    if (text) { try { return JSON.parse(text); } catch { return text; } }
    return content;
  }

  command(command, params = {}) {
    return this.call("run_command", { command, params });
  }

  async peers() {
    return this.command("collab.peers", {});
  }

  /** Waits until the file's session is live (or fails). */
  async waitLive(timeoutMs = JOIN_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
      last = await this.peers();
      if (last?.status === "live") return last;
      if (last?.status === "failed") throw new Error(`connexion au fichier refusée${last.reason ? ` : ${last.reason}` : ""}`);
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`le fichier n'a pas répondu à temps (${last?.status ?? "inconnu"})`);
  }

  /** Joins a shared file with its link (edit or view). */
  async join(link) {
    const local = loopbackLink(link);
    if (!local) throw new Error("lien de partage invalide");
    await this.command("collab.join", { link: local });
    return this.waitLive();
  }

  /** Publishes the open document to the server; returns { file, edit, view, name }. */
  async publish(name) {
    if (!SERVER_URL) throw new Error("FIGCRAFT_SERVER_URL absent");
    await this.command("collab.publish", { server: SERVER_URL, name });
    const deadline = Date.now() + JOIN_TIMEOUT_MS;
    let last = null;
    while (Date.now() < deadline) {
      last = await this.peers();
      if (last?.published?.file && last?.status === "live") {
        const p = last.published;
        return { file: p.file, edit: p.edit, view: p.view, name: p.name };
      }
      if (last?.status === "failed") throw new Error(`publication refusée${last.reason ? ` : ${last.reason}` : ""}`);
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`publication non confirmée (${last?.status ?? "inconnu"})`);
  }

  close() {
    if (!this.child || this.closed) return;
    try { this.child.stdin.end(); } catch { /* gone */ }
    const child = this.child;
    setTimeout(() => { if (!this.closed) { try { child.kill("SIGKILL"); } catch { /* gone */ } } }, 3000).unref();
  }
}

/** Runs `fn(session)` in a fresh headless session, under the concurrency cap. */
export async function withSession(opts, fn) {
  await acquire();
  const session = new HeadlessSession(opts);
  try {
    await session.start();
    return await fn(session);
  } finally {
    session.close();
    release();
  }
}

// ── Operations used by the relay's routes ───────────────────────────────────

const NAME_MAX = 120;
function cleanName(name) {
  const s = typeof name === "string" ? name.replace(/[\u0000-\u001f]/g, " ").trim().slice(0, NAME_MAX) : "";
  return s || "Sans titre";
}

/**
 * Creates a design file on the server. An optional first frame (artboard)
 * gives the consultant a canvas to start from.
 * → { fileId, name, editLink, viewLink }
 */
export async function createDesign({ name, width, height, frameName } = {}) {
  const title = cleanName(name);
  const w = Number(width), h = Number(height);
  const withFrame = Number.isFinite(w) && Number.isFinite(h) && w >= 16 && h >= 16 && w <= 16384 && h <= 16384;
  return withSession({ label: `create:${title}` }, async (s) => {
    if (withFrame) {
      await s.call("create_node", { type: "frame", x: 0, y: 0, width: Math.round(w), height: Math.round(h), name: cleanName(frameName || title) });
      // A white artboard reads better than the page's grey when nothing is drawn yet.
      await s.command("select.none", {}).catch(() => undefined);
    }
    const p = await s.publish(title);
    const editLink = publicLink(p.edit);
    const viewLink = publicLink(p.view);
    if (!editLink || !viewLink) throw new Error("liens de partage inattendus");
    return { fileId: p.file, name: p.name || title, editLink, viewLink };
  });
}

const EXPORT_FORMATS = new Set(["png", "jpg", "svg", "webp", "pdf"]);
const MIME = { png: "image/png", jpg: "image/jpeg", svg: "image/svg+xml", webp: "image/webp", pdf: "application/pdf" };

/**
 * Exports the page (or given layers) of a shared file.
 * → { data (base64), mimeType, bytes, format }
 */
export async function exportDesign({ link, format = "png", scale = 1, ids = null } = {}) {
  const fmt = EXPORT_FORMATS.has(format) ? format : "png";
  const sc = Math.min(4, Math.max(0.25, Number(scale) || 1));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "figcraft-export-"));
  try {
    return await withSession({ writeRoots: [dir], cwd: dir, label: "export" }, async (s) => {
      await s.join(link);
      const out = path.join(dir, `export.${fmt}`);
      const args = { format: fmt, scale: sc, path: out };
      if (Array.isArray(ids) && ids.length) args.ids = ids.map((v) => Number(v)).filter((v) => Number.isInteger(v));
      await s.call("export", args, 120_000);
      const buf = fs.readFileSync(out);
      return { data: buf.toString("base64"), mimeType: MIME[fmt], bytes: buf.length, format: fmt };
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** A PNG screenshot of the page (thumbnails, previews). → { data (base64), mimeType } */
export async function previewDesign({ link, maxSize = 800 } = {}) {
  const size = Math.min(2000, Math.max(64, Number(maxSize) || 800));
  return withSession({ label: "preview" }, async (s) => {
    await s.join(link);
    const result = await s.request("tools/call", { name: "screenshot", arguments: { maxSize: size } }, 60_000);
    const img = (result?.content || []).find((c) => c.type === "image" && c.data);
    if (!img) throw new Error("aucune image rendue");
    return { data: img.data, mimeType: img.mimeType || "image/png" };
  });
}

/** Deletes a file from the server (its links stop working at once). */
export function removeDesign(fileId) {
  if (!FILE_RE.test(String(fileId))) return Promise.reject(new Error("identifiant de fichier invalide"));
  return new Promise((resolve, reject) => {
    execFile(SERVER_BIN, ["--config", SERVER_CONFIG, "files", "remove", String(fileId)], { timeout: 20_000 }, (err, stdout, stderr) => {
      if (err) {
        const msg = `${stderr || stdout || err.message}`.trim();
        // Already gone counts as done: the row can be dropped.
        if (/no such file|not found|introuvable|unknown file/i.test(msg)) return resolve({ removed: false, missing: true });
        return reject(new Error(msg.split("\n").pop() || "suppression refusée"));
      }
      resolve({ removed: true, missing: false });
    });
  });
}

/** Health of the collaboration server, for /api/figcraft/status. */
export async function serverHealth() {
  const origin = serverOrigin();
  if (!origin) return { ok: false, reason: "FIGCRAFT_SERVER_URL absent" };
  try {
    const u = new URL(origin);
    const res = await fetch(`http://${u.host}${u.pathname.replace(/\/?$/, "/")}healthz`, { signal: AbortSignal.timeout(3000) });
    return { ok: res.ok, status: res.status };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}
