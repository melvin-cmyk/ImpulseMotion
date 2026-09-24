/**
 * HQ (hq-mcp.hq.computer) OAuth token holder for the relay.
 *
 * The Claude CLI only loads the host's claude.ai connectors (HQ included) when
 * it authenticates with the Claude subscription. On Bedrock those connectors
 * are absent, so the relay reaches HQ through a plain HTTP MCP entry and
 * supplies the bearer token itself.
 *
 * The token file is written once by hand after a browser OAuth flow (PKCE,
 * dynamically registered public client — HQ offers no static API key):
 *   { client_id, token_endpoint, resource, access_token, refresh_token, expires_at }
 * expires_at in ms. Access tokens last an hour; this module refreshes them
 * with the refresh_token (rotated when HQ returns a new one) and rewrites the
 * file, mode 0600. If the refresh token itself dies, getAccessToken() returns
 * null and the caller drops HQ for that chat, with a log line.
 */
import fs from "node:fs";
import path from "node:path";

const TOKEN_FILE = process.env.HQ_OAUTH_FILE || "/root/.config/impulsemotion/hq-oauth.json";
// Refresh this long before expiry so a token handed to a spawned CLI outlives the turn.
const REFRESH_MARGIN_MS = 10 * 60 * 1000;

let cache = null;
let inflight = null;

function load() {
  try {
    const t = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
    if (typeof t.access_token === "string" && typeof t.refresh_token === "string") return t;
    console.error("[hq-oauth] fichier de jeton incomplet");
  } catch (err) {
    if (err.code !== "ENOENT") console.error("[hq-oauth] fichier de jeton illisible:", err.message);
  }
  return null;
}

function save(t) {
  const tmp = path.join(path.dirname(TOKEN_FILE), `.hq-oauth.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(t, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, TOKEN_FILE);
}

async function refresh(t) {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: t.refresh_token,
    client_id: t.client_id,
    ...(t.resource ? { resource: t.resource } : {}),
  });
  const res = await fetch(t.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`refresh ${res.status} ${text.slice(0, 200)}`);
  }
  const j = await res.json();
  if (typeof j.access_token !== "string") throw new Error("refresh: pas d'access_token");
  const next = {
    ...t,
    access_token: j.access_token,
    refresh_token: typeof j.refresh_token === "string" ? j.refresh_token : t.refresh_token,
    expires_at: Date.now() + (Number(j.expires_in) > 0 ? Number(j.expires_in) : 3600) * 1000,
  };
  save(next);
  console.log(`[hq-oauth] jeton renouvelé, expire ${new Date(next.expires_at).toISOString()}`);
  return next;
}

/** Whether a token file exists at all (used to decide if HQ can be offered on Bedrock). */
export function configured() {
  return fs.existsSync(TOKEN_FILE);
}

/** Current HQ access token, refreshed when close to expiry; null when unavailable. */
export async function getAccessToken() {
  if (!cache) cache = load();
  if (!cache) return null;
  if (cache.expires_at - REFRESH_MARGIN_MS > Date.now()) return cache.access_token;
  if (!inflight) {
    inflight = refresh(cache)
      .then((t) => { cache = t; return t.access_token; })
      .catch((err) => {
        console.error("[hq-oauth] renouvellement impossible:", err.message);
        // Keep the old token if it has not actually expired yet.
        return cache.expires_at > Date.now() ? cache.access_token : null;
      })
      .finally(() => { inflight = null; });
  }
  return inflight;
}
