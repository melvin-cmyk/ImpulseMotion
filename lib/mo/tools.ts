/**
 * Mo's hands — the tools the "mo" MCP server of the relay (server/mcp-mo.mjs)
 * asks the application to run, as the consultant who is speaking, under their
 * ACL. Called by POST /api/mo/tools (bearer = the relay's shared secret).
 *
 *   creatives          the ads of a client over a period, with their metrics and visuals (warehouse AdCatalog / AdDaily)
 *   creative_metrics   metrics of named ads over a period (to put the figures under visuals already on the board)
 *   generate_creatives new visuals with fal.ai (Agnes as fallback), kept as CreativeAsset (origin "mo") and filed in the client's Drive folder « Créas »
 *   meta_targets       campaigns and ad sets of the client's Meta account (to choose where an ad goes)
 *   meta_publish_ad    a new Meta ad from a generated visual: a Pilotage action, prepared then sent on an explicit « oui » (created PAUSED, journaled in HQ)
 *
 * Every tool takes `client` = a name said out loud or an id; it is resolved
 * against the registry the consultant may see. Nothing here trusts an account
 * id coming from the model: accounts come from the resolved client.
 */

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getAccountScope, type AccountScope } from "@/lib/scope";
import { listClientRegistry, type ClientRef } from "@/lib/clients/registry";
import { matchClientName } from "@/lib/mo/intents";
import { deriveMetrics, queryAds, type Metrics, type MetricKey } from "@/lib/ads-warehouse/query";
import type { WarehousePlatform } from "@/lib/ads-warehouse/types";
import { checkGeneration, readQuotas, spentToday } from "@/lib/quotas";
import { IMAGE_RATIOS, isFalModel, publicMediaUrl, relayFalImage, relayImage, mediaUrl } from "@/lib/studio";
import { RELAY_URLS } from "@/lib/relay-server";
import { fetchImageBytes, mediaFileDataUri, toDataUri } from "@/lib/creas/media";
import { ensureClientSubfolder, uploadToFolder } from "@/lib/clients/drive";
import { executeAction, hqProjectOf, pilotWritesOpen, prepareAction, type PilotSession } from "@/lib/pilot/service";
import { adIdentities } from "@/lib/pilot/new-ad";
import { CALL_TO_ACTIONS } from "@/lib/meta-write";

export const MO_TOOL_NAMES = ["creatives", "creative_metrics", "generate_creatives", "meta_targets", "meta_publish_ad"] as const;
export type MoToolName = (typeof MO_TOOL_NAMES)[number];

export interface MoToolContext { userId: string; boardId: string; role: string; email: string | null; name: string | null }

type Args = Record<string, unknown>;
type ToolResult = Record<string, unknown>;

export class MoToolError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

const str = (v: unknown, max = 200): string => (typeof v === "string" ? v.trim().slice(0, max) : typeof v === "number" ? String(v) : "");
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null);
const TZ = "Europe/Paris";

// ── Dates (said out loud → exact Paris dates) ──────────────────────────────

const isoParis = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
const shift = (iso: string, days: number) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
const dow = (iso: string) => new Date(`${iso}T12:00:00Z`).getUTCDay(); // 0 = Sunday

export type Period = "today" | "yesterday" | "this_week" | "last_week" | "last_7d" | "last_14d" | "last_30d" | "this_month" | "last_month";
export const PERIODS: Period[] = ["today", "yesterday", "this_week", "last_week", "last_7d", "last_14d", "last_30d", "this_month", "last_month"];

/** { since, until } (inclusive, YYYY-MM-DD, Paris) from a period word or explicit dates; weeks run Monday → Sunday. */
export function periodRange(args: { period?: unknown; since?: unknown; until?: unknown }, now = new Date()): { since: string; until: string; label: string } {
  const today = isoParis(now);
  const since = /^\d{4}-\d{2}-\d{2}$/.test(str(args.since)) ? str(args.since) : null;
  const until = /^\d{4}-\d{2}-\d{2}$/.test(str(args.until)) ? str(args.until) : null;
  if (since || until) {
    const s = since ?? shift(until!, -6); const u = until ?? today;
    return { since: s <= u ? s : u, until: s <= u ? u : s, label: `du ${fmtDay(s <= u ? s : u)} au ${fmtDay(s <= u ? u : s)}` };
  }
  const period = (PERIODS as string[]).includes(str(args.period)) ? (str(args.period) as Period) : "last_7d";
  const monday = shift(today, -((dow(today) + 6) % 7));
  switch (period) {
    case "today": return { since: today, until: today, label: `aujourd'hui (${fmtDay(today)})` };
    case "yesterday": { const y = shift(today, -1); return { since: y, until: y, label: `hier (${fmtDay(y)})` }; }
    case "this_week": return { since: monday, until: today, label: `cette semaine (du ${fmtDay(monday)} au ${fmtDay(today)})` };
    case "last_week": { const s = shift(monday, -7); const u = shift(monday, -1); return { since: s, until: u, label: `la semaine dernière (du ${fmtDay(s)} au ${fmtDay(u)})` }; }
    case "last_14d": { const s = shift(today, -13); return { since: s, until: today, label: `14 derniers jours (du ${fmtDay(s)} au ${fmtDay(today)})` }; }
    case "last_30d": { const s = shift(today, -29); return { since: s, until: today, label: `30 derniers jours (du ${fmtDay(s)} au ${fmtDay(today)})` }; }
    case "this_month": { const s = `${today.slice(0, 8)}01`; return { since: s, until: today, label: `ce mois-ci (du ${fmtDay(s)} au ${fmtDay(today)})` }; }
    case "last_month": { const first = `${today.slice(0, 8)}01`; const u = shift(first, -1); const s = `${u.slice(0, 8)}01`; return { since: s, until: u, label: `le mois dernier (du ${fmtDay(s)} au ${fmtDay(u)})` }; }
    default: { const s = shift(today, -6); return { since: s, until: today, label: `7 derniers jours (du ${fmtDay(s)} au ${fmtDay(today)})` }; }
  }
}

function fmtDay(iso: string): string {
  return new Intl.DateTimeFormat("fr-FR", { timeZone: "UTC", day: "numeric", month: "short" }).format(new Date(`${iso}T12:00:00Z`));
}

// ── French formatting (what goes on the cards) ───────────────────────────────

const money = (v: number, cur: string | null) => `${new Intl.NumberFormat("fr-FR", { maximumFractionDigits: v >= 100 ? 0 : 2, minimumFractionDigits: 0 }).format(v)} ${cur === "EUR" || !cur ? "€" : cur}`;
const pct = (v: number) => `${new Intl.NumberFormat("fr-FR", { maximumFractionDigits: v >= 10 ? 1 : 2 }).format(v)} %`;
const int = (v: number) => new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 }).format(v);
const x = (v: number) => `${new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 2 }).format(v)}×`;

/** Metrics as the model should print them, nothing invented: a zero ratio is « — ». */
export function frMetrics(m: Metrics, cur: string | null): Record<string, string> {
  const out: Record<string, string> = { Dépense: money(m.spend, cur) };
  if (m.impressions) out.Impressions = int(m.impressions);
  if (m.ctr) out.CTR = pct(m.ctr);
  if (m.cpm) out.CPM = money(m.cpm, cur);
  if (m.leads) { out.Leads = int(m.leads); out.CPL = m.leads > 0 ? money(m.spend / m.leads, cur) : "—"; }
  if (m.purchases) { out.Achats = int(m.purchases); }
  if (m.conversions) { out.Conversions = int(m.conversions); out.CPA = m.cpa ? money(m.cpa, cur) : "—"; }
  if (m.roas && !m.roasUnavailable) out.ROAS = `${x(m.roas)}${m.estimated ? " (est.)" : ""}`;
  if (m.hookRate) out["Hook rate"] = pct(m.hookRate);
  return out;
}

const SORT_KEYS: Array<MetricKey | "launch"> = ["spend", "cpa", "ctr", "roas", "conversions", "leads", "impressions", "hookRate", "launch"];

// ── Client resolution ──────────────────────────────────────────────────────

interface Resolved { client: ClientRef; scope: AccountScope; session: PilotSession }

async function sessionOf(ctx: MoToolContext): Promise<PilotSession> {
  return { userId: ctx.userId, role: ctx.role, user: { email: ctx.email, name: ctx.name } };
}

/** The client named (or its id) among the ones the consultant may see; a clear error when none or several. */
export async function resolveClient(ctx: MoToolContext, raw: unknown): Promise<Resolved> {
  const session = await sessionOf(ctx);
  const scope = await getAccountScope(session);
  const clients = await listClientRegistry(scope);
  const q = str(raw, 120);
  if (!q) throw new MoToolError("Dis-moi de quel client il s'agit (nom ou identifiant).");
  const byId = clients.find((c) => c.id === q || c.clientId === q || c.aliasIds.includes(q) || c.dashboardIds.includes(q));
  if (byId) return { client: byId, scope, session };
  const m = matchClientName(q, clients.map((c) => ({ id: c.id, name: c.name })));
  if (!m) {
    const near = clients.filter((c) => c.name.toLowerCase().includes(q.toLowerCase().slice(0, 4))).slice(0, 5).map((c) => c.name);
    throw new MoToolError(`Client « ${q} » introuvable parmi les clients autorisés${near.length ? ` (proches : ${near.join(", ")})` : ""}.`, 404);
  }
  return { client: clients.find((c) => c.id === m.id)!, scope, session };
}

function platformsOf(client: ClientRef, wanted: unknown): { platforms: WarehousePlatform[]; accountIds: string[]; accounts: Array<{ platform: WarehousePlatform; id: string }> } {
  const want = str(wanted, 20).toLowerCase();
  const all = client.accounts.filter((a) => !want || want === "all" || a.platform === want);
  const accounts = all.map((a) => ({ platform: a.platform as WarehousePlatform, id: a.id.replace(/^act_/, "").replace(/-/g, "") }));
  return { platforms: [...new Set(accounts.map((a) => a.platform))], accountIds: [...new Set(accounts.map((a) => a.id))], accounts };
}

const assetImage = (id: string) => `/api/studio/assets/${id}/file?inline=1`;

// ── Tools ──────────────────────────────────────────────────────────────────

async function creatives(ctx: MoToolContext, a: Args): Promise<ToolResult> {
  const { client } = await resolveClient(ctx, a.client);
  const range = periodRange(a);
  const { platforms, accountIds, accounts } = platformsOf(client, a.platform);
  if (!accountIds.length) throw new MoToolError(`${client.name} n'a pas de compte ${str(a.platform) || "publicitaire"} rattaché.`, 404);
  const launched = a.launched_in_period === true;
  const sortKey = (SORT_KEYS as string[]).includes(str(a.sort)) ? (str(a.sort) as MetricKey | "launch") : "spend";
  const dir: "asc" | "desc" = a.order === "asc" || (a.order === undefined && (sortKey === "cpa" || sortKey === "launch")) ? "asc" : "desc";
  const limit = Math.min(24, Math.max(1, Math.round(num(a.limit) ?? 12)));
  const res = await queryAds({
    platforms, accountIds, accounts, range: { since: range.since, until: range.until }, groupBy: "ad",
    filters: { ...(launched ? { launchedAfter: range.since, launchedBefore: range.until } : {}), ...(num(a.min_spend) ? { minSpend: num(a.min_spend)! } : {}), ...(str(a.name_contains) ? { nameContains: str(a.name_contains, 80) } : {}) },
    sort: { key: sortKey === "launch" ? "launch" : sortKey, dir }, limit,
  });
  const cur = res.currency;
  const items = res.rows.map((r) => {
    const s = r.sample;
    return {
      adId: s?.adId ?? r.key, platform: s?.platform ?? platforms[0], name: s?.name ?? r.label, format: s?.format ?? "Unknown", status: s?.status ?? null,
      launched: s?.createdTime ? s.createdTime.slice(0, 10) : r.launch, campaign: s?.campaignName ?? null, adset: s?.adsetName ?? null,
      image: s?.imageUrl ?? s?.thumbnailUrl ?? null, title: s?.title ?? null, body: s?.body ? s.body.slice(0, 200) : null, landing: s?.landingUrl ?? null,
      metrics: frMetrics(r.metrics, cur),
      raw: { spend: r.metrics.spend, impressions: r.metrics.impressions, clicks: r.metrics.linkClicks || r.metrics.clicks, ctr: r.metrics.ctr, conversions: r.metrics.conversions, cpa: r.metrics.cpa, leads: r.metrics.leads, purchases: r.metrics.purchases, roas: r.metrics.roasUnavailable ? null : r.metrics.roas },
    };
  });
  return {
    client: { id: client.id, name: client.name }, period: { ...range }, platforms, currency: cur, launched_in_period: launched,
    count: items.length, total: res.total, items,
    account_total: { metrics: frMetrics(res.benchmark, cur), spend: res.benchmark.spend },
    coverage: res.coverage.complete ? "complète" : res.coverage.loading ? "synchronisation en cours (chiffres partiels)" : res.coverage.missing ? `${res.coverage.missing} compte(s) jamais synchronisé(s)` : res.coverage.errors ? "dernière synchronisation en erreur" : "partielle",
    card_hint: { type: "creatives", title: `Créas ${client.name} — ${range.label}`, subtitle: `${platforms.map((p) => p === "meta" ? "Meta" : p === "google" ? "Google" : p === "tiktok" ? "TikTok" : p).join(" + ")} · ${client.name} · ${range.since} → ${range.until}`, items: items.map((it) => ({ name: it.name, image: it.image, adId: it.adId, metrics: { Dépense: it.metrics.Dépense, ...(it.metrics.CPA ? { CPA: it.metrics.CPA } : it.metrics.CPL ? { CPL: it.metrics.CPL } : {}) } })) },
  };
}

async function creativeMetrics(ctx: MoToolContext, a: Args): Promise<ToolResult> {
  const { client } = await resolveClient(ctx, a.client);
  const range = periodRange(a);
  const ids = (Array.isArray(a.adIds) ? a.adIds : []).map((v) => str(v, 40)).filter((v) => /^[\w:-]+$/.test(v)).slice(0, 40);
  if (!ids.length) throw new MoToolError("Donne les identifiants des annonces (adIds).");
  const { accountIds } = platformsOf(client, a.platform);
  const rows = await prisma.adDaily.groupBy({
    by: ["platform", "adId"],
    where: { adId: { in: ids.map((v) => v.replace(/^(meta|google|tiktok|linkedin):/, "")) }, accountId: { in: accountIds }, date: { gte: new Date(`${range.since}T00:00:00Z`), lte: new Date(`${range.until}T00:00:00Z`) } },
    _sum: { spend: true, impressions: true, reach: true, clicks: true, linkClicks: true, conversions: true, conversionValue: true, purchases: true, purchaseValue: true, leads: true, videoPlays: true, video3s: true, thruPlays: true, videoP25: true, videoP50: true, videoP75: true, videoP100: true },
  });
  const catalog = await prisma.adCatalog.findMany({ where: { adId: { in: ids.map((v) => v.replace(/^(meta|google|tiktok|linkedin):/, "")) }, accountId: { in: accountIds } }, select: { adId: true, name: true, imageUrl: true, thumbnailUrl: true, platform: true } });
  const cur = (await prisma.adDaily.findFirst({ where: { accountId: { in: accountIds }, currency: { not: null } }, select: { currency: true } }))?.currency ?? null;
  const items = ids.map((id) => {
    const bare = id.replace(/^(meta|google|tiktok|linkedin):/, "");
    const r = rows.find((x) => x.adId === bare);
    const c = catalog.find((x) => x.adId === bare);
    const s = r?._sum;
    const metrics = s ? deriveMetrics({ spend: s.spend ?? 0, impressions: s.impressions ?? 0, reach: s.reach ?? 0, clicks: s.clicks ?? 0, linkClicks: s.linkClicks ?? 0, conversions: s.conversions ?? 0, conversionValue: s.conversionValue ?? 0, purchases: s.purchases ?? 0, purchaseValue: s.purchaseValue ?? 0, leads: s.leads ?? 0, videoPlays: s.videoPlays ?? 0, video3s: s.video3s ?? 0, thruPlays: s.thruPlays ?? 0, p25: s.videoP25 ?? 0, p50: s.videoP50 ?? 0, p75: s.videoP75 ?? 0, p100: s.videoP100 ?? 0 }, null) : null;
    return { adId: bare, name: c?.name ?? null, image: c?.imageUrl ?? c?.thumbnailUrl ?? null, found: !!r, metrics: metrics ? frMetrics(metrics, cur) : { Dépense: "0 €" }, raw: metrics ? { spend: metrics.spend, impressions: metrics.impressions, ctr: metrics.ctr, conversions: metrics.conversions, cpa: metrics.cpa, leads: metrics.leads, roas: metrics.roasUnavailable ? null : metrics.roas } : null };
  });
  return { client: { id: client.id, name: client.name }, period: { ...range }, currency: cur, items };
}

const slug = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "crea";

/** The bytes of a relay media file (localhost first). */
async function relayFileBytes(file: string): Promise<{ buf: Buffer; mimeType: string } | null> {
  for (const base of RELAY_URLS) {
    try {
      const res = await fetch(mediaUrl(base, file, 600), { signal: AbortSignal.timeout(base.includes("localhost") ? 5000 : 20_000) });
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length) return { buf, mimeType: (res.headers.get("content-type") ?? "image/png").split(";")[0] };
    } catch { /* next */ }
  }
  return null;
}

async function generateCreatives(ctx: MoToolContext, a: Args): Promise<ToolResult> {
  const { client } = await resolveClient(ctx, a.client);
  const prompt = str(a.prompt, 4000);
  if (prompt.length < 3) throw new MoToolError("Décris le visuel à créer (prompt).");
  const n = Math.min(4, Math.max(1, Math.round(num(a.n) ?? 1)));
  const ratio = (IMAGE_RATIOS as readonly string[]).includes(str(a.ratio)) ? str(a.ratio) : "4:5" === str(a.ratio) ? "3:4" : "1:1";
  const engine = isFalModel(a.engine) ? str(a.engine, 60) : (process.env.MO_FAL_MODEL || "fal-ai/flux/schnell");
  // References: ads of the warehouse (their picture), assets of the Studio, or https pictures — at most 3.
  const refs: string[] = [];
  for (const r of (Array.isArray(a.references) ? a.references : []).map((v) => str(v, 500)).filter(Boolean).slice(0, 3)) {
    if (/^https:\/\//.test(r)) { const got = await fetchImageBytes(r); if (got) refs.push(toDataUri(got.buf, got.mediaType)); continue; }
    const asset = await prisma.creativeAsset.findFirst({ where: { id: r, deletedAt: null }, select: { file: true, url: true } });
    if (asset) { const d = asset.file ? await mediaFileDataUri(asset.file) : asset.url ? await fetchImageBytes(asset.url).then((g) => (g ? toDataUri(g.buf, g.mediaType) : null)) : null; if (d) refs.push(d); continue; }
    const ad = await prisma.adCatalog.findFirst({ where: { adId: r.replace(/^(meta|google|tiktok|linkedin):/, "") }, select: { imageUrl: true, thumbnailUrl: true } });
    const pic = ad?.imageUrl ?? ad?.thumbnailUrl;
    if (pic) { const got = await fetchImageBytes(pic); if (got) refs.push(toDataUri(got.buf, got.mediaType)); }
  }
  // Daily caps (Admin → Quotas), the price of a fal batch counted before it is spent.
  const quotas = await readQuotas();
  const spent = await spentToday(ctx.userId);
  const unit = engine.includes("schnell") ? 0.003 : engine.includes("ultra") || engine.includes("ideogram") ? 0.06 : 0.039;
  const gate = checkGeneration(quotas, spent, unit * n, n);
  if (!gate.ok) throw new MoToolError(gate.reason ?? "Quota du jour atteint.", 429);

  const outs: Array<{ url: string | null; file: string | null; model: string; usd: number }> = [];
  let via = engine;
  let note = "";
  try {
    const out = await relayFalImage({ prompt, model: engine, ratio, images: refs, n });
    via = out.model;
    out.urls.forEach((url, i) => outs.push({ url, file: out.files[i] ?? null, model: out.model, usd: out.usd / Math.max(1, out.urls.length) }));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // The key does not allow the model (or fal is down): Agnes (free, takes references) rather than nothing.
    note = `fal.ai indisponible (${msg.slice(0, 140)}) → Agnes 2.5 Flash`;
    const results = await Promise.allSettled(Array.from({ length: n }, () => relayImage({ prompt, ratio, size: "1K", images: refs })));
    for (const r of results) if (r.status === "fulfilled") outs.push({ url: r.value.url, file: r.value.file, model: r.value.model, usd: 0 });
    via = "agnes-image-2.5-flash";
    if (!outs.length) { const first = results.find((r) => r.status === "rejected") as PromiseRejectedResult | undefined; throw new MoToolError(`Aucun visuel généré : ${msg.slice(0, 160)} ; Agnes : ${first?.reason instanceof Error ? first.reason.message : String(first?.reason ?? "")}`.slice(0, 400), 502); }
  }

  // Filed: CreativeAsset rows (origin "mo") and the client's Drive folder « Créas ».
  const author = (await prisma.user.findUnique({ where: { id: ctx.userId }, select: { name: true, email: true } }));
  const createdByName = (author?.name ?? "").trim() || author?.email || ctx.name || "Consultant";
  const group = `mo_${Date.now().toString(36)}`;
  let folder: { id: string; webViewLink: string | null } | null = null;
  let driveError = "";
  if (client.dashboardId) {
    try { folder = await ensureClientSubfolder(client.dashboardId, "creas"); } catch (e) { driveError = e instanceof Error ? e.message : String(e); }
  } else driveError = "client sans dashboard : pas de dossier Drive";
  const day = isoParis(new Date());
  const items = [];
  let i = 0;
  for (const out of outs) {
    i++;
    const asset = await prisma.creativeAsset.create({ data: {
      createdById: ctx.userId, createdByName, alertClientId: client.clientId, clientName: client.name, prompt, kind: "image", model: out.model, origin: "mo",
      paramsJson: JSON.stringify({ ratio, engine: via, references: refs.length, group, board: ctx.boardId, promptSent: prompt, note }), status: "completed", progress: 100, url: out.url, file: out.file, costUsd: out.usd,
    } });
    let drive: { id: string; webViewLink: string | null } | null = null;
    if (folder) {
      try {
        const bytes = out.file ? await relayFileBytes(out.file) : out.url ? await fetchImageBytes(out.url).then((g) => (g ? { buf: g.buf, mimeType: g.mediaType } : null)) : null;
        if (bytes) drive = await uploadToFolder(folder.id, { name: `mo-${day}-${slug(prompt).slice(0, 28)}-${i}.${bytes.mimeType.includes("jpeg") ? "jpg" : bytes.mimeType.includes("webp") ? "webp" : "png"}`, mimeType: bytes.mimeType, data: bytes.buf });
      } catch (e) { driveError = e instanceof Error ? e.message : String(e); }
    }
    items.push({ assetId: asset.id, image: assetImage(asset.id), model: out.model, usd: Math.round(out.usd * 1000) / 1000, drive: drive?.webViewLink ?? null });
  }
  return {
    client: { id: client.id, name: client.name }, generated: items.length, engine: via, ratio, references: refs.length, ...(note ? { note } : {}),
    drive_folder: folder?.webViewLink ?? null, ...(driveError ? { drive_error: driveError } : {}),
    items,
    card_hint: { type: "creatives", title: `Nouvelles créas ${client.name}`, subtitle: `Générées par Mo · ${via.replace("fal-ai/", "")} · ${day}`, items: items.map((it, k) => ({ name: `Proposition ${k + 1}`, image: it.image, assetId: it.assetId, metrics: { Moteur: via.replace("fal-ai/", ""), Coût: it.usd ? `${it.usd} $` : "gratuit" }, ...(it.drive ? { link: it.drive } : {}) })) },
  };
}

async function metaTargets(ctx: MoToolContext, a: Args): Promise<ToolResult> {
  const { client } = await resolveClient(ctx, a.client);
  const accounts = client.accounts.filter((x) => x.platform === "meta").map((x) => x.id.replace(/^act_/, ""));
  if (!accounts.length) throw new MoToolError(`${client.name} n'a pas de compte Meta rattaché.`, 404);
  const q = str(a.query, 80).toLowerCase();
  const since = new Date(Date.now() - 30 * 86_400_000);
  const rows = await prisma.$queryRaw<Array<{ accountId: string; campaignId: string | null; campaignName: string | null; adsetId: string | null; adsetName: string | null; status: string | null; ads: bigint; spend30: number | null; lastSpend: Date | null }>>(Prisma.sql`
    SELECT c."accountId", c."campaignId", c."campaignName", c."adsetId", c."adsetName",
           max(c.status) AS status, count(*) AS ads, sum(d.spend) AS "spend30", max(d.date) AS "lastSpend"
    FROM "AdCatalog" c
    LEFT JOIN "AdDaily" d ON d.platform = c.platform AND d."adId" = c."adId" AND d.date >= ${since}
    WHERE c.platform = 'meta' AND c."accountId" IN (${Prisma.join(accounts)}) AND c."adsetId" IS NOT NULL
    GROUP BY 1, 2, 3, 4, 5
    ORDER BY "spend30" DESC NULLS LAST, "lastSpend" DESC NULLS LAST
    LIMIT 200`);
  const filtered = rows.filter((r) => !q || `${r.campaignName ?? ""} ${r.adsetName ?? ""}`.toLowerCase().includes(q)).slice(0, 40);
  return {
    client: { id: client.id, name: client.name }, accounts,
    targets: filtered.map((r) => ({ accountId: r.accountId, campaignId: r.campaignId, campaign: r.campaignName, adsetId: r.adsetId, adset: r.adsetName, status: r.status, ads: Number(r.ads), spend_30d: r.spend30 ? Math.round(r.spend30) : 0, last_spend: r.lastSpend ? r.lastSpend.toISOString().slice(0, 10) : null })),
    note: "Choisis l'ensemble (adsetId) qui dépense encore et dont le nom correspond ; demande confirmation à la personne avant de publier.",
  };
}

async function metaPublishAd(ctx: MoToolContext, a: Args): Promise<ToolResult> {
  const { client, session } = await resolveClient(ctx, a.client);
  const metaAccounts = client.accounts.filter((x) => x.platform === "meta");
  if (!metaAccounts.length) throw new MoToolError(`${client.name} n'a pas de compte Meta rattaché.`, 404);
  const wantedAccount = str(a.accountId, 40).replace(/^act_/, "");
  const account = metaAccounts.length === 1 ? metaAccounts[0] : metaAccounts.find((x) => x.id.replace(/^act_/, "") === wantedAccount);
  if (!account) throw new MoToolError(`${client.name} a plusieurs comptes Meta : précise accountId (${metaAccounts.map((x) => `${x.name} = ${x.id}`).join(", ")}).`);

  // Second phase: the person said yes → the prepared action is sent (created PAUSED).
  if (a.confirm === true) {
    const actionId = str(a.actionId, 40);
    if (!actionId) throw new MoToolError("Il manque l'identifiant de la publication préparée (actionId).");
    if (!pilotWritesOpen("meta")) throw new MoToolError("Les écritures Meta ne sont pas ouvertes sur cette application (PILOT_WRITES). La publicité n'a pas été créée.", 403);
    const hqProject = await hqProjectOf({ hqSlug: client.hqSlug, dashboardId: client.dashboardId });
    const done = await executeAction(session, actionId, { why: str(a.why, 2000) || `Créa générée par Mo et publiée à la demande de ${ctx.name ?? "la personne"}`, hqProject: hqProject ?? undefined });
    if (!done.ok) throw new MoToolError(done.error, done.status);
    const op = done.action.operations[0];
    const adId = op?.readBack && /^\d+$/.test(String(op.readBack).replace(/"/g, "")) ? String(op.readBack).replace(/"/g, "") : null;
    return { status: op?.status ?? done.action.status, adId, error: op?.error ?? null, paused: !!adId, journal: done.action.hqProject ? `consigné dans HQ projects/${done.action.hqProject}` : "non consigné (pas de dossier HQ)", pilotage: `/pilotage?dashboardId=${client.dashboardId ?? client.id}` };
  }

  // First phase: everything checked, nothing sent — the person must say yes.
  const assetId = str(a.assetId, 40);
  const asset = assetId ? await prisma.creativeAsset.findFirst({ where: { id: assetId, deletedAt: null, status: "completed", kind: "image" } }) : null;
  if (!asset) throw new MoToolError("Le visuel (assetId) est introuvable ou n'est pas une image terminée.", 404);
  const imageUrl = asset.file ? publicMediaUrl(asset.file, 6 * 3600) : asset.url && /^https:\/\//.test(asset.url) ? asset.url : null;
  if (!imageUrl) throw new MoToolError("Ce visuel n'a pas d'adresse publique que Meta puisse télécharger.", 503);
  const adsetId = str(a.adsetId, 30);
  if (!/^\d{5,25}$/.test(adsetId)) throw new MoToolError("Donne l'ensemble de publicités (adsetId, chiffres) — vois meta_targets.");
  let pageId = str(a.pageId, 30);
  const identities = await adIdentities(account.id.replace(/^act_/, "")).catch(() => null);
  if (!/^\d{5,25}$/.test(pageId)) {
    if (identities?.pages.length === 1) pageId = identities.pages[0].id;
    else throw new MoToolError(identities?.pages.length ? `Précise la Page Facebook (pageId) : ${identities.pages.map((p) => `${p.name} = ${p.id}`).join(", ")}.` : "Aucune Page Facebook promouvable trouvée sur ce compte : la publicité ne peut pas être créée par ici.", identities?.pages.length ? 400 : 503);
  }
  const instagramUserId = str(a.instagramUserId, 30) || (identities?.instagram.length === 1 ? identities.instagram[0].id : undefined);
  const cta = str(a.callToAction, 40).toUpperCase();
  const spec = {
    name: str(a.name, 255) || `Mo · ${slug(asset.prompt).slice(0, 30)} · ${isoParis(new Date())}`,
    primaryText: str(a.primaryText, 2000), headline: str(a.headline, 255) || undefined, description: str(a.description, 255) || undefined,
    linkUrl: str(a.linkUrl, 2000), callToAction: (CALL_TO_ACTIONS as readonly string[]).includes(cta) ? cta : undefined, imageUrl, pageId, instagramUserId, studioAssetId: asset.id,
  };
  if (!spec.primaryText) throw new MoToolError("Il faut le texte principal de la publicité (primaryText).");
  if (!/^https:\/\//.test(spec.linkUrl)) throw new MoToolError("Il faut le lien de destination (linkUrl, https).");
  const prepared = await prepareAction(session, { alertClientId: client.clientId, accountId: account.id, platform: "meta", requests: [{ kind: "create_ad", objectType: "adset", objectId: adsetId, value: JSON.stringify(spec) }], why: str(a.why, 2000) || "Créa générée par Mo" });
  if (!prepared.ok) throw new MoToolError(prepared.error + (prepared.errors?.length ? ` ${prepared.errors.join(" ")}` : ""), prepared.status);
  const op = prepared.action.operations[0];
  return {
    prepared: true, actionId: prepared.action.id, needs_confirmation: true, writes_open: pilotWritesOpen("meta"),
    summary: { account: `${account.name} (act_${account.id.replace(/^act_/, "")})`, adset: op ? `${op.objectName ?? adsetId}` : adsetId, page: identities?.pages.find((p) => p.id === pageId)?.name ?? pageId, instagram: instagramUserId ?? null, name: spec.name, primaryText: spec.primaryText, headline: spec.headline ?? null, link: spec.linkUrl, cta: spec.callToAction ?? "(bouton par défaut)", image: assetImage(asset.id), status_at_creation: "PAUSED (en pause : rien n'est dépensé avant activation dans le Gestionnaire)" },
    hq: (await hqProjectOf({ hqSlug: client.hqSlug, dashboardId: client.dashboardId })) ? "la publication sera consignée dans la fiche HQ du client" : "ATTENTION : ce client n'a pas de dossier HQ, l'envoi sera refusé tant qu'un dossier n'est pas rattaché (Admin → HQ).",
    next: "Lis le résumé à la personne et attends un « oui » explicite ; alors rappelle meta_publish_ad avec confirm=true et cet actionId. L'aperçu expire dans 30 minutes.",
  };
}

export async function runMoTool(ctx: MoToolContext, tool: string, args: unknown): Promise<ToolResult> {
  const a: Args = args && typeof args === "object" ? (args as Args) : {};
  switch (tool as MoToolName) {
    case "creatives": return creatives(ctx, a);
    case "creative_metrics": return creativeMetrics(ctx, a);
    case "generate_creatives": return generateCreatives(ctx, a);
    case "meta_targets": return metaTargets(ctx, a);
    case "meta_publish_ad": return metaPublishAd(ctx, a);
    default: throw new MoToolError(`Outil inconnu : ${tool}`, 404);
  }
}
