/**
 * Pool of Claude Max subscriptions for the relay's CLI.
 *
 * The host's own login (~/.claude/.credentials.json) is the account "host".
 * Extra accounts are long-lived OAuth tokens produced by `claude setup-token`
 * on a machine logged into that subscription, stored 0600 in
 * ~/.config/impulsemotion/max-accounts.json:
 *   { "accounts": [ { "id": "max-2", "label": "Max Sung-Min", "token": "sk-ant-oat01-…", "addedAt": "…" } ] }
 * Each account gets its own quota monitor (server/quota.mjs). pick() chooses
 * where a chat runs: the caller's explicit choice when it still has room,
 * otherwise the account with the most room; none left → Bedrock.
 *
 * Switching accounts between two turns of a conversation is transparent:
 * the CLI resumes from its local transcript, which is not tied to a login.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { createQuotaMonitor } from "./quota.mjs";

const FILE = process.env.MAX_ACCOUNTS_FILE || "/root/.config/impulsemotion/max-accounts.json";
export const HOST_ACCOUNT = "host";
const ID_RE = /^[a-z0-9][a-z0-9-]{1,30}$/;
const TOKEN_RE = /^sk-ant-oat01-[A-Za-z0-9_-]{20,}$/;

let accounts = [];      // [{ id, label, token, addedAt }]
const monitors = new Map(); // id → quota monitor
let deps = { warnPct: undefined, switchPct: undefined, notify: undefined, probeMs: 300_000 };

function load() {
  try {
    const j = JSON.parse(fs.readFileSync(FILE, "utf8"));
    accounts = (Array.isArray(j.accounts) ? j.accounts : []).filter((a) => a && ID_RE.test(String(a.id)) && TOKEN_RE.test(String(a.token)));
  } catch (err) {
    if (err.code !== "ENOENT") console.error("[max-accounts] fichier illisible:", err.message);
    accounts = [];
  }
}

function save() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true, mode: 0o700 });
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ accounts }, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, FILE);
}

function monitorFor(id) {
  let m = monitors.get(id);
  if (m) return m;
  const acc = id === HOST_ACCOUNT ? null : accounts.find((a) => a.id === id);
  if (id !== HOST_ACCOUNT && !acc) return null;
  m = createQuotaMonitor({
    warnPct: deps.warnPct,
    switchPct: deps.switchPct,
    notify: deps.notify,
    label: id === HOST_ACCOUNT ? "Claude Max (compte serveur)" : `Claude Max « ${acc.label} »`,
    ...(acc ? { readToken: () => accounts.find((a) => a.id === id)?.token ?? "" } : {}),
  });
  m.start(deps.probeMs);
  monitors.set(id, m);
  return m;
}

/** Boots the pool: host monitor + one per stored account. */
export function init(options) {
  deps = { ...deps, ...options };
  load();
  monitorFor(HOST_ACCOUNT);
  for (const a of accounts) monitorFor(a.id);
  console.log(`[max-accounts] ${1 + accounts.length} compte(s) Max : host${accounts.map((a) => `, ${a.id}`).join("")}`);
}

export function ids() {
  return [HOST_ACCOUNT, ...accounts.map((a) => a.id)];
}

export function isKnown(id) {
  return id === HOST_ACCOUNT || accounts.some((a) => a.id === id);
}

export function labelOf(id) {
  return id === HOST_ACCOUNT ? "Compte serveur" : accounts.find((a) => a.id === id)?.label ?? id;
}

/** Env for the spawned CLI: the host login needs nothing, others carry their token. */
export function envFor(id) {
  if (id === HOST_ACCOUNT) return {};
  const acc = accounts.find((a) => a.id === id);
  return acc ? { CLAUDE_CODE_OAUTH_TOKEN: acc.token } : {};
}

export function monitor(id) {
  return monitorFor(id);
}

/** The host monitor doubles as the legacy single-account `quota` object. */
export function hostMonitor() {
  return monitorFor(HOST_ACCOUNT);
}

/**
 * Chooses the account for a chat. `preferred` (an id) wins while it has
 * room; otherwise the account with the lowest utilisation that is not
 * exhausted; null when every account is dry (→ Bedrock).
 */
export function pick({ preferred = null, exclude = [] } = {}) {
  const candidates = ids().filter((id) => !exclude.includes(id));
  const room = (id) => { const m = monitorFor(id); return m && !m.fallbackActive(); };
  if (preferred && candidates.includes(preferred) && room(preferred)) return preferred;
  // Accounts whose usage is not visible (setup-token scope) rank as half used:
  // after a clearly fresh account, before a nearly dry one.
  const rank = (id) => { const m = monitorFor(id); return m.state.usageVisible === false ? 50 : m.level(); };
  const open = candidates.filter(room).sort((a, b) => rank(a) - rank(b));
  return open[0] ?? null;
}

/** Public snapshot (no tokens). */
export function snapshot() {
  return ids().map((id) => {
    const m = monitorFor(id);
    const s = m ? m.snapshot() : null;
    return {
      id,
      label: labelOf(id),
      level: s?.level ?? null,
      fiveHour: s?.fiveHour ?? null,
      sevenDay: s?.sevenDay ?? null,
      fallbackActive: s?.fallbackActive ?? true,
      exhaustedUntil: s?.exhaustedUntil ?? null,
      checkedAt: s?.checkedAt ?? null,
      usageVisible: s?.usageVisible ?? null,
      error: s?.error ?? null,
    };
  });
}

/** Adds an account after checking its token against the usage endpoint. */
export async function add({ label, token }) {
  const clean = String(label ?? "").trim().slice(0, 60);
  if (!clean) throw new Error("libellé requis");
  if (!TOKEN_RE.test(String(token ?? ""))) throw new Error("jeton invalide — attendu un jeton `claude setup-token` (sk-ant-oat01-…)");
  if (accounts.some((a) => a.token === token)) throw new Error("ce jeton est déjà enregistré");
  const probe = createQuotaMonitor({ readToken: () => token, label: clean, notify: async () => {} });
  const snap = await probe.probe();
  if (/usage endpoint 401/.test(snap.error || "")) throw new Error("jeton refusé par Anthropic (401)");
  // Usage not readable with this token (setup-token scope → 403, or a
  // transient 429/5xx): prove it works for inference instead.
  if (snap.usageVisible !== true) await pingCli(token);
  let id = clean.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "max";
  if (!ID_RE.test(id) || isKnown(id)) id = `${id}-${crypto.randomBytes(2).toString("hex")}`;
  accounts.push({ id, label: clean, token, addedAt: new Date().toISOString() });
  save();
  monitorFor(id);
  console.log(`[max-accounts] ajouté ${id} (${clean}) — ${snap.level}%`);
  return { id, label: clean, level: snap.level };
}

/** One minimal CLI turn with the token; throws when Anthropic refuses it. */
function pingCli(token) {
  return new Promise((resolve, reject) => {
    execFile("claude", ["--print", "Réponds OK.", "--output-format", "json", "--model", "sonnet", "--no-session-persistence", "--max-turns", "1", "--restricted", "--tools", "", "--strict-mcp-config", "--mcp-config", "/root/ImpulseMotion/config/mcp-claude.json"],
      { env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: token, TERM: "dumb" }, cwd: process.env.RELAY_CLAUDE_CWD || "/var/lib/impulsemotion-relay", timeout: 90_000, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        let d = null;
        try { const t = String(stdout || ""); d = JSON.parse(t.slice(t.indexOf("{"))); } catch { /* no JSON */ }
        if (d && d.is_error === false) return resolve();
        reject(new Error(`jeton refusé par le CLI (${(d?.result || err?.message || "réponse illisible").toString().slice(0, 120)})`));
      });
  });
}

export function remove(id) {
  if (id === HOST_ACCOUNT) throw new Error("le compte serveur ne se retire pas");
  const before = accounts.length;
  accounts = accounts.filter((a) => a.id !== id);
  if (accounts.length === before) throw new Error("compte inconnu");
  save();
  monitors.delete(id);
  console.log(`[max-accounts] retiré ${id}`);
}
