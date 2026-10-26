/**
 * Watches the credentials the relay depends on and tells the team (Slack,
 * through the n8n alert webhook) BEFORE they expire, and when they are dead:
 *
 *   - the Claude Max logins (host ~/.claude + each `login` account of the pool):
 *     the CLI's refresh token has a fixed lifetime (`refreshTokenExpiresAt`,
 *     about four weeks); past it, `claude auth login` is the only way back;
 *   - the HQ OAuth token (server/hq-oauth.mjs): its refresh token dies after
 *     roughly a day without use, so it is refreshed here on a timer whether or
 *     not anyone talks to HQ (keep-alive), and a dead one is reported.
 *
 * One notice per account, per state, per day; the dedup lives in a file so a
 * relay restart does not repeat it.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import * as hqOauth from "./hq-oauth.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;
const WARN_BEFORE_MS = 5 * DAY_MS;
const STATE_FILE = process.env.AUTH_WATCH_STATE_FILE || "/root/.config/impulsemotion/auth-notified.json";

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) || {}; } catch { return {}; }
}
function saveState(all) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true, mode: 0o700 });
    const tmp = `${STATE_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(all, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, STATE_FILE);
  } catch (e) { console.error("[auth-watch] état non sauvegardé:", e.message); }
}

const fmtDate = (ms) => new Date(ms).toLocaleString("fr-FR", { timeZone: "Europe/Paris", dateStyle: "short", timeStyle: "short" });
const daysLeft = (ms) => Math.max(0, Math.round((ms - Date.now()) / DAY_MS));

/** The state of one Claude login: { ok, dead, expiresAt, refreshExpiresAt, reason }. */
export function readClaudeLogin(credentialsPath, now = Date.now()) {
  let o;
  try { o = JSON.parse(fs.readFileSync(credentialsPath, "utf8"))?.claudeAiOauth; }
  catch (e) { return { ok: false, dead: true, reason: e.code === "ENOENT" ? "aucune connexion enregistrée" : "fichier illisible" }; }
  if (!o?.accessToken || !o?.refreshToken) return { ok: false, dead: true, reason: "aucun jeton" };
  const expiresAt = Number(o.expiresAt) || 0;
  const refreshExpiresAt = Number(o.refreshTokenExpiresAt) || 0;
  // expiresAt 0 is what the CLI leaves behind when a refresh is refused for good.
  if (!expiresAt) return { ok: false, dead: true, expiresAt, refreshExpiresAt, reason: "session OAuth expirée, renouvellement refusé" };
  if (refreshExpiresAt && refreshExpiresAt < now) return { ok: false, dead: true, expiresAt, refreshExpiresAt, reason: "jeton de renouvellement expiré" };
  return { ok: true, dead: false, expiresAt, refreshExpiresAt };
}

/**
 * Starts the watch. `accounts()` lists the Claude logins to watch
 * ({ id, label, credentialsPath }); `notify` is the webhook notifier
 * (server/quota.mjs, kind "auth").
 */
export function startAuthWatch({ accounts, notify, intervalMs = 6 * 60 * 60 * 1000, hqKeepaliveMs = 20 * 60 * 1000, log = (...a) => console.log("[auth-watch]", ...a) }) {
  const state = loadState();

  async function once(key, text) {
    const today = new Date().toISOString().slice(0, 10);
    if (state[key] === today) return;
    state[key] = today;
    saveState(state);
    log(text);
    try { await notify({ kind: "auth", message: text, value: 0, threshold: 0, window: "5h" }); }
    catch (e) { console.error("[auth-watch] notify failed:", e.message); }
  }

  async function checkClaude() {
    for (const acc of accounts()) {
      const s = readClaudeLogin(acc.credentialsPath);
      if (s.dead) {
        await once(`claude:${acc.id}:dead`, `Compte Claude Max « ${acc.label} » déconnecté (${s.reason}). Les chats de l'équipe tournent sur les comptes restants. À refaire : \`claude auth login\` pour ce compte (procédure dans la mémoire « Pool Max »).`);
        continue;
      }
      if (s.refreshExpiresAt && s.refreshExpiresAt - Date.now() < WARN_BEFORE_MS) {
        await once(`claude:${acc.id}:soon`, `Compte Claude Max « ${acc.label} » : la connexion expire le ${fmtDate(s.refreshExpiresAt)} (dans ${daysLeft(s.refreshExpiresAt)} j). Le reconnecter avant, sinon il sortira du pool.`);
      }
    }
  }

  async function checkHq() {
    if (!hqOauth.configured()) return;
    // The call itself refreshes the token when it is within ten minutes of
    // expiry: calling it every twenty minutes keeps the refresh token rotating.
    const token = await hqOauth.getAccessToken();
    if (!token) {
      await once("hq:dead", "HQ déconnecté du relay : le jeton de renouvellement est mort (invalid_grant). Les consultants perdent HQ dans leurs chats et les écritures HQ (journal, persona) échouent. À refaire : la procédure OAuth HQ (mémoire « HQ sur Bedrock »).");
    }
  }

  const tick = async () => { try { await checkClaude(); } catch (e) { console.error("[auth-watch] claude:", e.message); } };
  const hqTick = async () => { try { await checkHq(); } catch (e) { console.error("[auth-watch] hq:", e.message); } };
  setTimeout(() => { void tick(); void hqTick(); }, 30_000).unref?.();
  const t1 = setInterval(() => void tick(), intervalMs); t1.unref?.();
  const t2 = setInterval(() => void hqTick(), hqKeepaliveMs); t2.unref?.();
  return { checkClaude, checkHq, stop: () => { clearInterval(t1); clearInterval(t2); } };
}

/** The host login's credentials file (what `claude` uses without CLAUDE_CONFIG_DIR). */
export const HOST_CREDENTIALS = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), ".credentials.json");
