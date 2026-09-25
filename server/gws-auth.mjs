/**
 * Google Workspace access token for the relay's "gws" MCP server
 * (server/mcp-gws.mjs) — identité partagée data@impulse-analytics.com.
 *
 * Reprend le lanceur du kit HQ (companies/impulse-analytics/connectors/
 * google-workspace/run.mjs) : un refresh_token OAuth Google mint un jeton
 * d'accès d'une heure, seul ce jeton court est passé au CLI gws. Les trois
 * secrets ne quittent jamais ce processus, le modèle ne les voit pas.
 *
 * Deux sources, choisies par GWS_AUTH_SOURCE (défaut "env") :
 *   env — GWS_CLIENT_ID, GWS_CLIENT_SECRET, GWS_REFRESH_TOKEN dans
 *         /etc/impulsemotion-relay.env (valeurs des secrets HQ
 *         GOOGLE_WORKSPACE/CLIENT_ID|CLIENT_SECRET|REFRESH_TOKEN) ;
 *   hq  — pas de copie locale : le relay demande au bac à sable hébergé
 *         de HQ (hq_secrets_sandbox, bearer server/hq-oauth.mjs) de minter
 *         le jeton avec les secrets injectés côté HQ et ne récupère que le
 *         jeton d'accès. Chemin non validé à ce jour (voir README de la
 *         mémoire projet) — à activer sciemment.
 *
 * getAccessToken() renvoie { token, expiresAt } (cache, renouvelé 10 min
 * avant expiration) ou lève une erreur au message affichable (sans secret).
 * Un échec est mémorisé 2 min pour ne pas marteler Google ou HQ à chaque chat.
 */
import { hqToolCall } from "./hq-client.mjs";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SOURCE = (process.env.GWS_AUTH_SOURCE || "env").trim().toLowerCase();
const HQ_COMPANY = process.env.HQ_COMPANY || "impulse-analytics";
const HQ_SECRET_KEYS = ["GOOGLE_WORKSPACE/CLIENT_ID", "GOOGLE_WORKSPACE/CLIENT_SECRET", "GOOGLE_WORKSPACE/REFRESH_TOKEN"];
const ENV_KEYS = ["GWS_CLIENT_ID", "GWS_CLIENT_SECRET", "GWS_REFRESH_TOKEN"];
const REFRESH_MARGIN_MS = 10 * 60 * 1000;
const FAILURE_BACKOFF_MS = 2 * 60 * 1000;
const HQ_JOB_TIMEOUT_MS = 60_000;

let cache = null;      // { token, expiresAt }
let lastFailure = null; // { at, message }
let inflight = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function source() { return SOURCE; }
export function envConfigured() { return ENV_KEYS.every((k) => typeof process.env[k] === "string" && process.env[k].trim()); }
/** Whether some token source is set up at all (used for logs / status). */
export function configured() { return SOURCE === "hq" || envConfigured(); }

function expiry(expiresIn) {
  const n = Number(expiresIn);
  return Date.now() + (n > 0 ? n : 3600) * 1000;
}

async function mintFromEnv() {
  if (!envConfigured()) throw new Error("Secrets Google Workspace non configurés sur le relay (GWS_CLIENT_ID / GWS_CLIENT_SECRET / GWS_REFRESH_TOKEN) : action d'un administrateur.");
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GWS_CLIENT_ID.trim(),
      client_secret: process.env.GWS_CLIENT_SECRET.trim(),
      refresh_token: process.env.GWS_REFRESH_TOKEN.trim(),
      grant_type: "refresh_token",
    }),
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`OAuth Google refusé (HTTP ${res.status}) : vérifier les secrets Workspace du coffre.`);
  const j = await res.json().catch(() => ({}));
  if (typeof j.access_token !== "string" || !j.access_token) throw new Error("OAuth Google : jeton d'accès absent de la réponse.");
  return { token: j.access_token, expiresAt: expiry(j.expires_in) };
}

function parseJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

/** Pulls the first JSON-looking value of `key` out of a tool's text answer (escaped quotes tolerated). */
function grab(text, key) {
  const m = new RegExp(`\\\\?"${key}\\\\?"\\s*:\\s*\\\\?"?([^",}\\s\\\\]+)`).exec(text || "");
  return m ? m[1] : null;
}

async function mintFromHq() {
  // The secret names carry a slash, so their env names in the sandbox are not
  // known in advance: pick each one by suffix, then mint with curl. Only the
  // short-lived access token comes back in the job output.
  const cmd =
    `set -e; pick() { for n in $(env | cut -d= -f1); do case "$n" in *"$1") printenv "$n"; return 0;; esac; done; echo "secret $1 absent" >&2; exit 3; }; ` +
    `CID=$(pick CLIENT_ID); CS=$(pick CLIENT_SECRET); RT=$(pick REFRESH_TOKEN); ` +
    `curl -sS -X POST ${TOKEN_URL} -d grant_type=refresh_token --data-urlencode "client_id=$CID" --data-urlencode "client_secret=$CS" --data-urlencode "refresh_token=$RT"`;
  const started = await hqToolCall("hq_secrets_sandbox", { company: HQ_COMPANY, only: HQ_SECRET_KEYS, command: cmd, maxExecMs: 25_000 });
  const jobId = grab(started, "jobId") || grab(started, "job_id") || grab(started, "id");
  if (!jobId) throw new Error(`HQ sandbox : identifiant de tâche introuvable (${String(started).slice(0, 120)})`);
  const deadline = Date.now() + HQ_JOB_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(1500);
    const status = await hqToolCall("hq_secrets_sandbox_status", { jobId });
    // { jobId, status: queued|running|succeeded|failed, output: "<stdout as text>" }
    const st = parseJson(status);
    const output = typeof st?.output === "string" ? st.output : status;
    const payload = parseJson(output);
    const token = typeof payload?.access_token === "string" ? payload.access_token : grab(output, "access_token");
    if (token) return { token, expiresAt: expiry(payload?.expires_in ?? grab(output, "expires_in")) };
    const state = st?.status || st?.state || grab(status, "status");
    if (state === "failed" || state === "succeeded") {
      // The output may hold an OAuth error body; never a secret, but keep it short.
      const hint = payload?.error ? ` (${payload.error}${payload.error_description ? ` : ${payload.error_description}` : ""})` : "";
      throw new Error(`HQ sandbox : tâche ${state} sans jeton${hint.slice(0, 200)}`);
    }
  }
  throw new Error("HQ sandbox : délai dépassé en attendant le jeton.");
}

/** { token, expiresAt } for gws, minted through the configured source; throws with a safe message. */
export async function getAccessToken() {
  if (cache && cache.expiresAt - Date.now() > REFRESH_MARGIN_MS) return cache;
  if (lastFailure && Date.now() - lastFailure.at < FAILURE_BACKOFF_MS) throw new Error(lastFailure.message);
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const next = SOURCE === "hq" ? await mintFromHq() : await mintFromEnv();
      cache = next;
      lastFailure = null;
      console.log(`[gws-auth] jeton Google Workspace minté (${SOURCE}), expire ${new Date(next.expiresAt).toISOString()}`);
      return next;
    } catch (err) {
      const message = String(err?.message || err).replace(/[A-Za-z0-9_-]{40,}/g, "[…]");
      lastFailure = { at: Date.now(), message };
      console.error(`[gws-auth] échec (${SOURCE}) :`, message);
      throw new Error(message);
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}
