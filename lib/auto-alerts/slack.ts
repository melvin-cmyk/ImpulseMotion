/**
 * Automatic alerting — Slack side, through n8n (the app holds no Slack token).
 *
 * One n8n workflow, one webhook, two kinds of request:
 *   { kind: "digest", channel, text }  → posts `text` in the client's channel
 *   { kind: "channels", prefix }       → lists the workspace channels `c_…`
 *   { kind: "join", channel }          → the bot joins a public channel
 * Same shared secret as the consultant alerts (X-Alert-Secret).
 */

export interface SlackChannel { id: string; name: string; isPrivate: boolean; isMember: boolean }

const CHANNEL_RE = /^(#?[a-z0-9][a-z0-9._-]{0,79}|[CG][A-Z0-9]{8,})$/;

/** "#c_client", "c_client" or a channel id → stored form; null when invalid. */
export function cleanChannel(input: unknown): string | null {
  const raw = String(input ?? "").trim();
  if (!raw || !CHANNEL_RE.test(raw)) return null;
  if (/^[CG][A-Z0-9]{8,}$/.test(raw)) return raw;
  return raw.startsWith("#") ? raw : `#${raw}`;
}

export function autoAlertWebhook(): { url: string; secret: string } | null {
  const explicit = process.env.N8N_AUTO_ALERT_WEBHOOK_URL?.trim();
  const legacy = process.env.N8N_ALERT_WEBHOOK_URL?.trim();
  // Same n8n instance as the consultant alerts: only the path differs.
  const url = explicit || (legacy ? legacy.replace(/\/impulsemotion-alerts\/?$/, "/impulsemotion-auto-alerts") : "");
  if (!url || url === legacy) return null;
  return { url, secret: process.env.N8N_ALERT_WEBHOOK_SECRET?.trim() ?? "" };
}

async function call<T>(body: Record<string, unknown>, timeoutMs: number): Promise<T> {
  const cfg = autoAlertWebhook();
  if (!cfg) throw new Error("webhook n8n des alertes automatiques non configuré");
  const res = await fetch(cfg.url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(cfg.secret ? { "X-Alert-Secret": cfg.secret } : {}) },
    body: JSON.stringify({ version: 1, ...body }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text().catch(() => "");
  let json: Record<string, unknown> = {};
  try { json = text ? (JSON.parse(text) as Record<string, unknown>) : {}; } catch { /* plain text answer */ }
  if (!res.ok || json.ok === false) throw new Error(String(json.error ?? `n8n ${res.status}`).slice(0, 200));
  return json as T;
}

export async function postDigest(channel: string, text: string, client: { id: string; name: string }): Promise<void> {
  await call({ kind: "digest", channel, text, client }, 15_000);
}

/** Public channels only: Slack never lets a bot enter a private channel by itself. */
export async function joinChannel(channelId: string): Promise<void> {
  await call({ kind: "join", channel: channelId }, 15_000);
}

export type SlackLink = "connected" | "public" | "absent" | "none";

/**
 * connected = the bot is a member; public = not a member but the channel is
 * public, so it can post anyway; absent = the channel is not visible to the
 * bot (private without the bot, renamed, archived); none = no channel set.
 */
export function linkStatus(d: { slackChannel: string | null; slackChannelId: string | null }, channels: SlackChannel[]): { status: SlackLink; channel: SlackChannel | null } {
  if (!d.slackChannel && !d.slackChannelId) return { status: "none", channel: null };
  const name = (d.slackChannel ?? "").replace(/^#/, "");
  const ch = channels.find((c) => c.id === d.slackChannelId) ?? channels.find((c) => c.name === name) ?? null;
  if (!ch) return { status: "absent", channel: null };
  return { status: ch.isMember ? "connected" : ch.isPrivate ? "absent" : "public", channel: ch };
}

export async function listClientChannels(prefix = "c_"): Promise<SlackChannel[]> {
  const res = await call<{ channels?: Array<Record<string, unknown>> }>({ kind: "channels", prefix }, 30_000);
  return (res.channels ?? [])
    .map((c) => ({ id: String(c.id ?? ""), name: String(c.name ?? ""), isPrivate: c.isPrivate === true, isMember: c.isMember === true }))
    .filter((c) => c.id && c.name.startsWith(prefix))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ── Matching clients and channels ────────────────────────────────────────────

/** "Saveurs & Vie" → "saveursvie", "c_saveurs-et-vie" → "saveursetvie". */
export function slug(name: string): string {
  return name.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/^c_/, "").replace(/[^a-z0-9]+/g, "");
}

const STOP = /\b(et|and|the|le|la|les|de|du|des|sas|sarl|groupe|group|france|fr|ads|meta|google|tiktok|pilotage|dashboard)\b/g;
const loose = (name: string) => slug(name.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/^c_/, "").replace(/[^a-z0-9]+/g, " ").replace(STOP, " "));

export interface ChannelMatch { clientId: string; channel: SlackChannel; confidence: "exact" | "close" }

/**
 * Free matching, no AI: same name once punctuation is removed, then same name
 * without filler words, then one name contained in the other (≥ 4 letters).
 * A channel claimed by two clients, or a client claiming two channels, is left
 * for the AI or the admin.
 */
export function matchChannels(clients: Array<{ id: string; name: string }>, channels: SlackChannel[]): { matches: ChannelMatch[]; unmatched: Array<{ id: string; name: string }> } {
  const pairs: ChannelMatch[] = [];
  for (const c of clients) {
    const s = slug(c.name);
    const l = loose(c.name);
    if (!s) continue;
    const exact = channels.filter((ch) => slug(ch.name) === s);
    if (exact.length === 1) { pairs.push({ clientId: c.id, channel: exact[0], confidence: "exact" }); continue; }
    if (exact.length > 1) continue;
    const close = channels.filter((ch) => {
      const cl = loose(ch.name);
      if (!cl || !l) return false;
      if (cl === l) return true;
      const [short, long] = cl.length <= l.length ? [cl, l] : [l, cl];
      return short.length >= 4 && long.includes(short);
    });
    if (close.length === 1) pairs.push({ clientId: c.id, channel: close[0], confidence: "close" });
  }
  const uses = new Map<string, number>();
  for (const p of pairs) uses.set(p.channel.id, (uses.get(p.channel.id) ?? 0) + 1);
  const matches = pairs.filter((p) => uses.get(p.channel.id) === 1);
  const done = new Set(matches.map((m) => m.clientId));
  return { matches, unmatched: clients.filter((c) => !done.has(c.id)) };
}
