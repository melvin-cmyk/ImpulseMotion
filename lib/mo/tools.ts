/**
 * Mo's hands — the tools the "mo" MCP server of the relay (server/mcp-mo.mjs)
 * asks the application to run, as the consultant who is speaking, under their
 * ACL. Called by POST /api/mo/tools (bearer = the relay's shared secret).
 *
 *   creatives          the ads of a client over a period, with their metrics and visuals (warehouse AdCatalog / AdDaily)
 *   metrics            the figures of a client over a period (vs the previous one), by campaign / ad set / format on demand
 *   creative_metrics   metrics of named ads over a period (to put the figures under visuals already on the board)
 *   generate_creatives new visuals with fal.ai (Agnes as fallback), kept as CreativeAsset (origin "mo") and filed in the client's Drive folder « Créas »
 *   meta_targets       campaigns and ad sets of the client's Meta account (to choose where an ad goes)
 *   meta_publish_ad    a new Meta ad from a generated visual: a Pilotage action, prepared then sent on an explicit « oui » (created PAUSED, journaled in HQ)
 *   competitor_ads     the ads a brand runs right now (Meta Ad Library, public page read by the relay), posted as a card
 *   keep_template      one of them kept as a template (swipe file) of the client, analysed by the AI
 *
 * Every tool takes `client` = a name said out loud or an id; it is resolved
 * against the registry the consultant may see. Nothing here trusts an account
 * id coming from the model: accounts come from the resolved client.
 */

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getAccountScope, type AccountScope } from "@/lib/scope";
import { effectiveRole } from "@/lib/roles";
import { listClientRegistry, type ClientRef } from "@/lib/clients/registry";
import { matchClientName, withClientAliases } from "@/lib/mo/intents";
import { brandBriefFromHq } from "@/lib/mo/brief";
import { isHqContextFresh } from "@/lib/hq-client-context";
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
import { mergeCreativeMetrics, postMoCards } from "@/lib/mo/thread";
import { searchAdLibrary } from "@/lib/creas/ad-library";
import { analyseTemplate } from "@/lib/creas/analysis";
import { ownAdTemplateSource } from "@/lib/creas/templates";
import { dataUriToRelayImage } from "@/lib/creas/media";
import { relayUpload } from "@/lib/studio";
import type { MoCardSpec } from "@/lib/mo/model";

export const MO_TOOL_NAMES = ["creatives", "metrics", "creative_metrics", "generate_creatives", "meta_targets", "meta_publish_ad", "competitor_ads", "keep_template"] as const;
export type MoToolName = (typeof MO_TOOL_NAMES)[number];

export interface MoToolContext {
  userId: string; boardId: string; role: string; email: string | null; name: string | null;
  /** The caller's registry when the route already read it (the quick path): no second read. */
  registry?: { scope: AccountScope; clients: ClientRef[] };
}

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
  // The role as the application applies it (a consultant works as an admin, lib/roles.ts): the stored role alone
  // narrowed the scope to the accounts assigned in UserAdAccount — none for a consultant — and every client was « introuvable ».
  return { userId: ctx.userId, role: effectiveRole(ctx.role), baseRole: ctx.role, user: { email: ctx.email, name: ctx.name } };
}

/** The client named (or its id) among the ones the consultant may see; a clear error when none or several. */
export async function resolveClient(ctx: MoToolContext, raw: unknown): Promise<Resolved> {
  const session = await sessionOf(ctx);
  const scope = ctx.registry?.scope ?? await getAccountScope(session);
  const clients = ctx.registry?.clients ?? await listClientRegistry(scope);
  const q = str(raw, 120);
  if (!q) throw new MoToolError("Dis-moi de quel client il s'agit (nom ou identifiant).");
  const byId = clients.find((c) => c.id === q || c.clientId === q || c.aliasIds.includes(q) || c.dashboardIds.includes(q));
  if (byId) return { client: byId, scope, session };
  const m = matchClientName(q, withClientAliases(clients.map((c) => ({ id: c.id, name: c.name }))));
  if (!m) {
    const near = clients.filter((c) => c.name.toLowerCase().includes(q.toLowerCase().slice(0, 4))).slice(0, 5).map((c) => c.name);
    throw new MoToolError(`Client « ${q} » introuvable parmi les clients autorisés${near.length ? ` (proches : ${near.join(", ")})` : ""}.`, 404);
  }
  return { client: clients.find((c) => c.id === m.id)!, scope, session };
}

/**
 * The accounts a tool looks at. Without a platform, « créas » means visuals:
 * Meta when the client has it (Google text ads are not what the consultant
 * pictures), else every platform of the client. "all" forces everything.
 */
function platformsOf(client: ClientRef, wanted: unknown): { platforms: WarehousePlatform[]; accountIds: string[]; accounts: Array<{ platform: WarehousePlatform; id: string }> } {
  let want = str(wanted, 20).toLowerCase();
  if (!want && client.accounts.some((a) => a.platform === "meta")) want = "meta";
  const all = client.accounts.filter((a) => !want || want === "all" || a.platform === want);
  const accounts = all.map((a) => ({ platform: a.platform as WarehousePlatform, id: a.id.replace(/^act_/, "").replace(/-/g, "") }));
  return { platforms: [...new Set(accounts.map((a) => a.platform))], accountIds: [...new Set(accounts.map((a) => a.id))], accounts };
}

const assetImage = (id: string) => `/api/studio/assets/${id}/file?inline=1`;
/** Short handle of a platform ad's picture (app/api/mo/ad-image): 40 characters instead of a 500-character CDN link the model would have to copy. */
const adImage = (platform: string, adId: string) => `/api/mo/ad-image/${platform}/${adId}`;

// ── Tools ──────────────────────────────────────────────────────────────────

export async function creatives(ctx: MoToolContext, a: Args): Promise<ToolResult> {
  const t0 = Date.now();
  const { client } = await resolveClient(ctx, a.client);
  const tClient = Date.now() - t0;
  const range = periodRange(a);
  const { platforms, accountIds, accounts } = platformsOf(client, a.platform);
  if (!accountIds.length) throw new MoToolError(`${client.name} n'a pas de compte ${str(a.platform) || "publicitaire"} rattaché.`, 404);
  let launched = a.launched_in_period === true;
  const sortKey = (SORT_KEYS as string[]).includes(str(a.sort)) ? (str(a.sort) as MetricKey | "launch") : "spend";
  const dir: "asc" | "desc" = a.order === "asc" || (a.order === undefined && (sortKey === "cpa" || sortKey === "launch")) ? "asc" : "desc";
  const limit = Math.min(24, Math.max(1, Math.round(num(a.limit) ?? 12)));
  const run = (withLaunch: boolean) => queryAds({
    platforms, accountIds, accounts, range: { since: range.since, until: range.until }, groupBy: "ad",
    filters: { ...(withLaunch ? { launchedAfter: range.since, launchedBefore: range.until } : {}), ...(num(a.min_spend) ? { minSpend: num(a.min_spend)! } : {}), ...(str(a.name_contains) ? { nameContains: str(a.name_contains, 80) } : {}) },
    sort: { key: sortKey === "launch" ? "launch" : sortKey, dir }, limit,
  });
  let res = await run(launched);
  const tQuery = Date.now() - t0 - tClient;
  let note = "";
  // « Les créas de cette semaine » with nothing launched this week: the ones that ran, said so — never an empty board.
  if (launched && !res.rows.length) { res = await run(false); launched = false; note = "Aucune créa lancée sur la période : voici celles qui ont diffusé (dis-le)."; }
  const cur = res.currency;
  const items = res.rows.map((r) => {
    const s = r.sample;
    return {
      adId: s?.adId ?? r.key, platform: s?.platform ?? platforms[0], name: s?.name ?? r.label, format: s?.format ?? "Unknown", status: s?.status ?? null,
      launched: s?.createdTime ? s.createdTime.slice(0, 10) : r.launch, campaign: s?.campaignName ?? null, adset: s?.adsetName ?? null,
      image: s?.imageUrl || s?.thumbnailUrl ? adImage(s?.platform ?? platforms[0], s?.adId ?? r.key) : null, title: s?.title ?? null, body: s?.body ? s.body.slice(0, 200) : null, landing: s?.landingUrl ?? null,
      metrics: frMetrics(r.metrics, cur),
      raw: { spend: r.metrics.spend, impressions: r.metrics.impressions, clicks: r.metrics.linkClicks || r.metrics.clicks, ctr: r.metrics.ctr, conversions: r.metrics.conversions, cpa: r.metrics.cpa, leads: r.metrics.leads, purchases: r.metrics.purchases, roas: r.metrics.roasUnavailable ? null : r.metrics.roas },
    };
  });
  const platformLabel = platforms.map((p) => p === "meta" ? "Meta" : p === "google" ? "Google" : p === "tiktok" ? "TikTok" : p).join(" + ");
  const full = a.with_metrics !== false;
  const card: MoCardSpec = {
    type: "creatives", clientId: client.id, clientName: client.name, title: str(a.title, 90) || (sortKey === "launch" && dir === "desc" ? `${items.length} dernières créas ${client.name}` : `Créas ${client.name} — ${range.label}`), subtitle: `${platformLabel} · ${client.name} · ${range.since} → ${range.until}${res.coverage.until && res.coverage.until < range.until ? ` · données jusqu'au ${res.coverage.until}` : ""}`,
    items: items.map((it) => ({ name: shortName(it.name), ...(it.image ? { image: it.image } : {}), adId: it.adId, metrics: full ? it.metrics : { Dépense: it.metrics.Dépense, ...(it.metrics.CPA ? { CPA: it.metrics.CPA } : it.metrics.CPL ? { CPL: it.metrics.CPL } : {}) } })),
  };
  // The card goes on the board now (the person sees it while the model is still writing its sentence).
  const tPost0 = Date.now();
  const posted = items.length && a.post !== false ? await postMoCards(ctx.boardId, [card]) : [];
  console.log(`[mo/tools] creatives phases: client ${tClient} ms · entrepôt ${tQuery} ms · carte ${Date.now() - tPost0} ms · total ${Date.now() - t0} ms`);
  const coverage = res.coverage.complete ? "complète" : res.coverage.loading ? "synchronisation en cours (chiffres partiels)" : res.coverage.missing ? `${res.coverage.missing} compte(s) jamais synchronisé(s)` : res.coverage.errors ? `données jusqu'au ${res.coverage.until ?? "?"} (la dernière synchronisation a échoué, elle reprend chaque heure)` : "partielle";
  return {
    client: { id: client.id, name: client.name }, period: { ...range }, platforms, currency: cur, launched_in_period: launched, ...(note ? { note } : {}),
    ...(posted.length ? { posted_card: posted[0], posted: "La carte est DÉJÀ sur le tableau : ne la recopie pas dans « cards », dis juste la phrase (et son id si on te demande de la modifier)." } : {}),
    ...(a.post === false && items.length ? { card_specs: [card] } : {}),
    count: items.length, total: res.total,
    items: items.map((it) => ({ adId: it.adId, name: shortName(it.name), format: it.format, status: it.status, launched: it.launched, campaign: it.campaign, metrics: it.metrics, ...(it.title ? { title: it.title } : {}), ...(it.landing ? { landing: it.landing } : {}) })),
    account_total: frMetrics(res.benchmark, cur),
    data_until: res.coverage.until, coverage,
  };
}

/**
 * Ad names of the agency follow a naming convention of 150 characters
 * ("SGL_IMG_S-Pulse_V-CAD_C-Parent_Visu-Fille_Co-Checklist_M-AiderMonEnfant"):
 * the readable part = the format tag and the three most descriptive values.
 */
export function shortName(name: string): string {
  const n = name.replace(/\s*-\s*Copie$/i, "").trim();
  if (n.length <= 60) return n;
  const parts = n.split("_").filter(Boolean);
  const format = parts.find((p) => /^(IMG|VID|UGC|CAR|CAROUSEL|STAT|STATIC|VIDEO|IMAGE)$/i.test(p));
  const values = parts.map((p) => p.replace(/^[A-Za-z]{1,4}-/, "")).filter((p) => p.length >= 4 && !/^(IMG|VID|UGC|CAR|SGL|NoCta|NoPersona)$/i.test(p));
  const best = [...values].sort((a, b) => b.length - a.length).slice(0, 3);
  const kept = values.filter((v) => best.includes(v)).map((v) => v.replace(/([a-z])([A-Z])/g, "$1 $2"));
  const out = [format ? format.toUpperCase() : null, ...kept].filter(Boolean).join(" · ");
  return (out.length > 60 ? out.slice(0, 57) + "…" : out) || n.slice(0, 57) + "…";
}

const GROUPS = { campaign: "campaign", adset: "adset", format: "format", platform: null } as const;

/** The client's figures over a period, against the previous period of the same length: a KPI card, and a table by campaign / ad set / format when asked. */
export async function metrics(ctx: MoToolContext, a: Args): Promise<ToolResult> {
  const { client } = await resolveClient(ctx, a.client);
  const range = periodRange(a);
  const { platforms, accountIds, accounts } = platformsOf(client, a.platform ?? "all");
  if (!accountIds.length) throw new MoToolError(`${client.name} n'a pas de compte publicitaire rattaché.`, 404);
  const days = Math.round((Date.parse(range.until) - Date.parse(range.since)) / 86_400_000) + 1;
  const compare = a.compare === false ? null : { since: shift(range.since, -days), until: shift(range.since, -1) };
  const byKey = str(a.by, 20) as keyof typeof GROUPS;
  const by = byKey in GROUPS ? byKey : null;
  const res = await queryAds({ platforms, accountIds, accounts, range: { since: range.since, until: range.until }, compare, groupBy: by && GROUPS[by] ? GROUPS[by]! : "campaign", sort: { key: "spend", dir: "desc" }, limit: by ? 12 : 1 });
  const cur = res.currency;
  const m = res.benchmark, p = res.benchmarkPrevious;
  const delta = (now: number, before: number | undefined, lowerIsBetter = false) => {
    if (!before || !now) return {};
    const d = Math.round(((now - before) / before) * 100);
    if (!Number.isFinite(d) || d === 0) return { delta: "= période préc." };
    const good = lowerIsBetter ? d < 0 : d > 0;
    return { delta: `${d > 0 ? "+" : ""}${d} % vs période préc.`, tone: good ? "good" as const : "bad" as const };
  };
  const main: Array<{ label: string; value: string; delta?: string; tone?: "good" | "bad" | "neutral" }> = [{ label: "Dépense", value: money(m.spend, cur), ...delta(m.spend, p?.spend) }];
  if (m.leads) main.push({ label: "Leads", value: int(m.leads), ...delta(m.leads, p?.leads) }, { label: "CPL", value: money(m.spend / m.leads, cur), ...delta(m.spend / m.leads, p?.leads ? p.spend / p.leads : undefined, true) });
  if (m.conversions) main.push({ label: m.purchases ? "Achats" : "Conversions", value: int(m.conversions), ...delta(m.conversions, p?.conversions) }, { label: "CPA", value: m.cpa ? money(m.cpa, cur) : "—", ...delta(m.cpa, p?.cpa, true) });
  if (m.roas && !m.roasUnavailable) main.push({ label: "ROAS", value: `${x(m.roas)}${m.estimated ? " (est.)" : ""}`, ...delta(m.roas, p?.roas) });
  if (m.ctr) main.push({ label: "CTR", value: pct(m.ctr), ...delta(m.ctr, p?.ctr) });
  if (m.cpm) main.push({ label: "CPM", value: money(m.cpm, cur), ...delta(m.cpm, p?.cpm, true) });
  if (m.impressions) main.push({ label: "Impressions", value: int(m.impressions), ...delta(m.impressions, p?.impressions) });
  const platformLabel = platforms.map((q) => q === "meta" ? "Meta" : q === "google" ? "Google" : q === "tiktok" ? "TikTok" : q).join(" + ");
  const subtitle = `${platformLabel} · ${client.name} · ${range.since} → ${range.until}${compare ? ` · vs ${compare.since} → ${compare.until}` : ""}`;
  const cards: MoCardSpec[] = [{ type: "kpis", clientId: client.id, clientName: client.name, title: str(a.title, 90) || `${client.name} — ${range.label}`, subtitle, items: main.slice(0, 8) }];
  let rows: Array<Record<string, string>> = [];
  if (by && res.rows.length) {
    const cols = ["Dépense", m.leads ? "Leads" : "Conv.", m.leads ? "CPL" : "CPA", "CTR", ...(m.roas && !m.roasUnavailable ? ["ROAS"] : [])];
    rows = res.rows.map((r) => ({ [by === "campaign" ? "Campagne" : by === "adset" ? "Ensemble" : "Format"]: r.label.slice(0, 60), Dépense: money(r.metrics.spend, cur), [m.leads ? "Leads" : "Conv."]: int(m.leads ? r.metrics.leads : r.metrics.conversions), [m.leads ? "CPL" : "CPA"]: m.leads ? (r.metrics.leads ? money(r.metrics.spend / r.metrics.leads, cur) : "—") : (r.metrics.cpa ? money(r.metrics.cpa, cur) : "—"), CTR: r.metrics.ctr ? pct(r.metrics.ctr) : "—", ...(m.roas && !m.roasUnavailable ? { ROAS: r.metrics.roas ? x(r.metrics.roas) : "—" } : {}) }));
    const first = Object.keys(rows[0])[0];
    cards.push({ type: "table", clientId: client.id, clientName: client.name, title: `Par ${by === "campaign" ? "campagne" : by === "adset" ? "ensemble" : "format"} — ${client.name}`, subtitle, columns: [first, ...cols], rows: rows.map((r) => [r[first], ...cols.map((c) => r[c] ?? "")]), align: ["left", ...cols.map(() => "right" as const)] });
  }
  const posted = a.post !== false ? await postMoCards(ctx.boardId, cards) : [];
  return {
    client: { id: client.id, name: client.name }, period: { ...range }, compare, platforms, currency: cur,
    ...(posted.length ? { posted_cards: posted, posted: "Les cartes sont DÉJÀ sur le tableau : ne les recopie pas, dis juste la phrase (la conclusion, un ou deux chiffres)." } : {}),
    ...(a.post === false ? { card_specs: cards } : {}),
    totals: Object.fromEntries(main.map((k) => [k.label, `${k.value}${k.delta ? ` (${k.delta})` : ""}`])),
    ...(rows.length ? { rows } : {}), data_until: res.coverage.until,
    coverage: res.coverage.complete ? "complète" : res.coverage.errors ? `données jusqu'au ${res.coverage.until ?? "?"} (dernière synchronisation en échec)` : res.coverage.loading ? "synchronisation en cours" : "partielle",
  };
}

export async function creativeMetrics(ctx: MoToolContext, a: Args): Promise<ToolResult> {
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
    return { adId: bare, name: c?.name ?? null, image: c?.imageUrl || c?.thumbnailUrl ? adImage(c?.platform ?? "meta", bare) : null, found: !!r, metrics: metrics ? frMetrics(metrics, cur) : { Dépense: "0 €" }, raw: metrics ? { spend: metrics.spend, impressions: metrics.impressions, ctr: metrics.ctr, conversions: metrics.conversions, cpa: metrics.cpa, leads: metrics.leads, roas: metrics.roasUnavailable ? null : metrics.roas } : null };
  });
  const merged = await mergeCreativeMetrics(ctx.boardId, new Map(items.filter((it) => it.found).map((it) => [it.adId, it.metrics])), undefined);
  return { client: { id: client.id, name: client.name }, period: { ...range }, currency: cur, ...(merged.length ? { updated_cards: merged, updated: "Les chiffres sont DÉJÀ sous les visuels sur le tableau : ne renvoie pas de carte, dis juste la phrase." } : {}), items: items.map((it) => ({ adId: it.adId, name: it.name ? shortName(it.name) : null, found: it.found, metrics: it.metrics })) };
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

/**
 * The brand brief of a client from the HQ context cached on its dashboard
 * (lib/hq-client-context.ts, 7 days; never a new HQ call here): what a
 * generated visual must respect. Empty when nothing is cached.
 */
export async function brandBriefOf(client: Pick<ClientRef, "dashboardId" | "dashboardIds">): Promise<string> {
  const ids = [client.dashboardId, ...client.dashboardIds].filter((v): v is string => !!v);
  if (!ids.length) return "";
  const rows = await prisma.dashboard.findMany({ where: { id: { in: ids }, hqContextMd: { not: null } }, select: { hqContextMd: true, hqContextAt: true }, orderBy: { hqContextAt: "desc" }, take: 3 });
  const fresh = rows.find((d) => isHqContextFresh(d));
  return brandBriefFromHq(fresh?.hqContextMd);
}

export async function generateCreatives(ctx: MoToolContext, a: Args): Promise<ToolResult> {
  const { client } = await resolveClient(ctx, a.client);
  const asked = str(a.prompt, 4000);
  if (asked.length < 3) throw new MoToolError("Décris le visuel à créer (prompt).");
  // The brand brief of HQ goes first, so the visual respects the brand (the model's or the person's prompt follows).
  const brief = a.brand_brief === false ? "" : await brandBriefOf(client);
  const prompt = brief ? `CONTEXTE DE MARQUE (mémoire HQ de l'agence, à respecter) :\n${brief}\n\nVISUEL DEMANDÉ :\n${asked}` : asked;
  const n = Math.min(4, Math.max(1, Math.round(num(a.n) ?? 1)));
  const ratio = (IMAGE_RATIOS as readonly string[]).includes(str(a.ratio)) ? str(a.ratio) : "4:5" === str(a.ratio) ? "3:4" : "1:1";
  // Nano Banana 2 (the model the agency's fal key opens): edit when references are given, text-to-image otherwise.
  const wantRefs = Array.isArray(a.references) && a.references.length > 0;
  const engine = isFalModel(a.engine) ? str(a.engine, 60) : (process.env.MO_FAL_MODEL || (wantRefs ? "fal-ai/nano-banana-2/edit" : "fal-ai/nano-banana-2"));
  // References: ads of the warehouse (their picture), assets of the Studio, or https pictures — at most 3.
  const refs: string[] = [];
  for (const r of (Array.isArray(a.references) ? a.references : []).map((v) => str(v, 500)).filter(Boolean).slice(0, 3)) {
    if (/^https:\/\//.test(r)) { const got = await fetchImageBytes(r); if (got) refs.push(toDataUri(got.buf, got.mediaType)); continue; }
    const asset = await prisma.creativeAsset.findFirst({ where: { id: r, deletedAt: null }, select: { file: true, url: true } });
    if (asset) { const d = asset.file ? await mediaFileDataUri(asset.file) : asset.url ? await fetchImageBytes(asset.url).then((g) => (g ? toDataUri(g.buf, g.mediaType) : null)) : null; if (d) refs.push(d); continue; }
    const template = await prisma.creativeTemplate.findFirst({ where: { id: r, deletedAt: null }, select: { file: true, imageUrl: true } });
    if (template) { const d = template.file ? await mediaFileDataUri(template.file) : template.imageUrl ? await fetchImageBytes(template.imageUrl).then((g) => (g ? toDataUri(g.buf, g.mediaType) : null)) : null; if (d) refs.push(d); continue; }
    const ad = await prisma.adCatalog.findFirst({ where: { adId: r.replace(/^(meta|google|tiktok|linkedin):/, "") }, select: { imageUrl: true, thumbnailUrl: true } });
    const pic = ad?.imageUrl ?? ad?.thumbnailUrl;
    if (pic) { const got = await fetchImageBytes(pic); if (got) refs.push(toDataUri(got.buf, got.mediaType)); }
  }
  // Daily caps (Admin → Quotas), the price of a fal batch counted before it is spent.
  const quotas = await readQuotas();
  const spent = await spentToday(ctx.userId);
  const unit = engine.includes("schnell") ? 0.003 : engine.includes("ultra") || engine.includes("ideogram") || engine.includes("banana-2") ? 0.06 : 0.039;
  const gate = checkGeneration(quotas, spent, unit * n, n);
  if (!gate.ok) throw new MoToolError(gate.reason ?? "Quota du jour atteint.", 429);

  const outs: Array<{ url: string | null; file: string | null; model: string; usd: number }> = [];
  let via = engine;
  let note = "";
  let falError = "";
  try {
    const out = await relayFalImage({ prompt, model: engine, ratio, images: refs, n });
    via = out.model;
    out.urls.forEach((url, i) => outs.push({ url, file: out.files[i] ?? null, model: out.model, usd: out.usd / Math.max(1, out.urls.length) }));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    falError = msg;
    // The key does not allow the model: another fal model first (schnell without references), Agnes (free, takes references) last.
    if (/n'autorise pas ce modele|n'autorise pas ce modèle|does not have access/i.test(msg) && !refs.length && !engine.includes("schnell")) {
      try {
        const out = await relayFalImage({ prompt, model: "fal-ai/flux/schnell", ratio, images: [], n });
        via = out.model; note = `${engine.replace("fal-ai/", "")} refusé par la clé fal → FLUX Schnell`;
        out.urls.forEach((url, i) => outs.push({ url, file: out.files[i] ?? null, model: out.model, usd: out.usd / Math.max(1, out.urls.length) }));
      } catch { /* Agnes below */ }
    }
  }
  if (!outs.length) {
    const msg = falError || "fal.ai indisponible";
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
  for (const out of outs) {
    const asset = await prisma.creativeAsset.create({ data: {
      createdById: ctx.userId, createdByName, alertClientId: client.clientId, clientName: client.name, prompt: asked, kind: "image", model: out.model, origin: "mo",
      paramsJson: JSON.stringify({ ratio, engine: via, references: refs.length, group, board: ctx.boardId, promptSent: prompt, briefHq: !!brief, note }), status: "completed", progress: 100, url: out.url, file: out.file, costUsd: out.usd,
    } });
    let drive: { id: string; webViewLink: string | null } | null = null;
    if (folder) {
      try {
        const bytes = out.file ? await relayFileBytes(out.file) : out.url ? await fetchImageBytes(out.url).then((g) => (g ? { buf: g.buf, mimeType: g.mediaType } : null)) : null;
        // The asset id in the name: two calls with the same prompt must not overwrite each other in Drive.
        if (bytes) drive = await uploadToFolder(folder.id, { name: `mo-${day}-${slug(prompt).slice(0, 28)}-${asset.id.slice(-6)}.${bytes.mimeType.includes("jpeg") ? "jpg" : bytes.mimeType.includes("webp") ? "webp" : "png"}`, mimeType: bytes.mimeType, data: bytes.buf });
      } catch (e) { driveError = e instanceof Error ? e.message : String(e); }
    }
    items.push({ assetId: asset.id, image: assetImage(asset.id), model: out.model, usd: Math.round(out.usd * 1000) / 1000, drive: drive?.webViewLink ?? null });
  }
  // « d'après « A », « B » » : the visuals the new ones are inspired by (names given by the caller), and the HQ brief when it was used.
  const inspired = (Array.isArray(a.inspired_by) ? a.inspired_by : []).map((v) => str(v, 60)).filter(Boolean).slice(0, 3);
  const subtitle = [`Générées par Mo · ${via.replace("fal-ai/", "")} · ${day}`, inspired.length ? `d'après ${inspired.map((n) => `« ${n} »`).join(", ")}` : "", brief ? "brief HQ utilisé" : "", folder?.webViewLink ? "dans le Drive du client" : ""].filter(Boolean).join(" · ");
  const card: MoCardSpec = { type: "creatives", clientId: client.id, clientName: client.name, title: str(a.title, 90) || `Nouvelles créas ${client.name}`, subtitle, items: items.map((it, k) => ({ name: str((Array.isArray(a.names) ? a.names[k] : null) ?? "", 60) || `Proposition ${k + 1}`, image: it.image, assetId: it.assetId, metrics: { Moteur: via.replace("fal-ai/", ""), Coût: it.usd ? `${it.usd} $` : "gratuit" }, ...(it.drive ? { link: it.drive } : {}) })) };
  const posted = a.post !== false ? await postMoCards(ctx.boardId, [card]) : [];
  return {
    client: { id: client.id, name: client.name }, generated: items.length, engine: via, ratio, references: refs.length, brief_hq: !!brief, ...(note ? { note } : {}),
    ...(posted.length ? { posted_card: posted[0], posted: "La carte est DÉJÀ sur le tableau : ne la recopie pas, dis juste la phrase." } : {}),
    ...(a.post === false ? { card_specs: [card] } : {}),
    drive_folder: folder?.webViewLink ?? null, ...(driveError ? { drive_error: driveError } : {}),
    items,
  };
}

/**
 * The texts of the client's best-performing Meta ad of the last 30 days
 * (the one that spent most and carries a body and a landing link): what a new
 * ad reuses when the person gave no copy. Null when the warehouse has none.
 */
export async function bestAdTexts(client: ClientRef): Promise<{ name: string; body: string; title: string; landing: string } | null> {
  const { platforms, accountIds, accounts } = platformsOf(client, "meta");
  if (!accountIds.length) return null;
  const range = periodRange({ period: "last_30d" });
  const res = await queryAds({ platforms, accountIds, accounts, range: { since: range.since, until: range.until }, groupBy: "ad", sort: { key: "spend", dir: "desc" }, limit: 24 }).catch(() => null);
  const hit = res?.rows.find((r) => r.sample?.body && r.sample.landingUrl && /^https:\/\//.test(r.sample.landingUrl));
  if (!hit?.sample) return null;
  return { name: shortName(hit.sample.name), body: hit.sample.body!.slice(0, 2000), title: (hit.sample.title ?? "").slice(0, 255), landing: hit.sample.landingUrl!.slice(0, 2000) };
}

export async function metaTargets(ctx: MoToolContext, a: Args): Promise<ToolResult> {
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

export async function metaPublishAd(ctx: MoToolContext, a: Args): Promise<ToolResult> {
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
  // Texts the person did not give are taken from the client's best-performing ad of the warehouse (and said so).
  let primaryText = str(a.primaryText, 2000); let headline = str(a.headline, 255); let linkUrl = str(a.linkUrl, 2000);
  let textsFrom: string | null = null;
  if (!primaryText || !/^https:\/\//.test(linkUrl)) {
    const best = await bestAdTexts(client);
    if (best) { textsFrom = best.name; primaryText = primaryText || best.body; headline = headline || best.title; linkUrl = /^https:\/\//.test(linkUrl) ? linkUrl : best.landing; }
  }
  const spec = {
    name: str(a.name, 255) || `Mo · ${slug(asset.prompt).slice(0, 30)} · ${isoParis(new Date())}`,
    primaryText, headline: headline || undefined, description: str(a.description, 255) || undefined,
    linkUrl, callToAction: (CALL_TO_ACTIONS as readonly string[]).includes(cta) ? cta : undefined, imageUrl, pageId, instagramUserId, studioAssetId: asset.id,
  };
  if (!spec.primaryText) throw new MoToolError("Il faut le texte principal de la publicité (primaryText) : aucune créa de l'entrepôt n'a de texte à reprendre.");
  if (!/^https:\/\//.test(spec.linkUrl)) throw new MoToolError("Il faut le lien de destination (linkUrl, https) : aucune créa de l'entrepôt n'a de lien à reprendre.");
  const prepared = await prepareAction(session, { alertClientId: client.clientId, accountId: account.id, platform: "meta", requests: [{ kind: "create_ad", objectType: "adset", objectId: adsetId, value: JSON.stringify(spec) }], why: str(a.why, 2000) || "Créa générée par Mo" });
  if (!prepared.ok) throw new MoToolError(prepared.error + (prepared.errors?.length ? ` ${prepared.errors.join(" ")}` : ""), prepared.status);
  const op = prepared.action.operations[0];
  return {
    prepared: true, actionId: prepared.action.id, needs_confirmation: true, writes_open: pilotWritesOpen("meta"),
    summary: { account: `${account.name} (act_${account.id.replace(/^act_/, "")})`, adset: op ? `${op.objectName ?? adsetId}` : adsetId, adsetId, page: identities?.pages.find((p) => p.id === pageId)?.name ?? pageId, pageId, instagram: instagramUserId ?? null, name: spec.name, primaryText: spec.primaryText, headline: spec.headline ?? null, link: spec.linkUrl, cta: spec.callToAction ?? "(bouton par défaut)", image: assetImage(asset.id), status_at_creation: "PAUSED (en pause : rien n'est dépensé avant activation dans le Gestionnaire)" },
    ...(textsFrom ? { texts_from: textsFrom, texts_note: `Textes et lien repris de la créa « ${textsFrom} » (la plus dépensée sur 30 jours) : dis-le à la personne.` } : {}),
    hq: (await hqProjectOf({ hqSlug: client.hqSlug, dashboardId: client.dashboardId })) ? "la publication sera consignée dans la fiche HQ du client" : "ATTENTION : ce client n'a pas de dossier HQ, l'envoi sera refusé tant qu'un dossier n'est pas rattaché (Admin → HQ).",
    next: "Lis le résumé à la personne et attends un « oui » explicite ; alors rappelle meta_publish_ad avec confirm=true et cet actionId. L'aperçu expire dans 30 minutes.",
  };
}

/** The ads a brand runs now, from the Meta Ad Library (public page through the relay, ~15-20 s): a creatives card, and the ids to keep one as template. */
export async function competitorAds(ctx: MoToolContext, a: Args): Promise<ToolResult> {
  const query = str(a.query ?? a.brand, 100);
  if (query.length < 2) throw new MoToolError("Dis-moi la marque ou le mot-clé à chercher (query).");
  const country = /^[A-Za-z]{2}$/.test(str(a.country, 2)) ? str(a.country, 2).toUpperCase() : "FR";
  const limit = Math.min(24, Math.max(1, Math.round(num(a.limit) ?? 12)));
  const res = await searchAdLibrary({ q: query, country, limit, active: a.all !== true });
  if (res.error && !res.ads.length) throw new MoToolError(res.error, 502);
  const ads = res.ads.slice(0, limit);
  const items = ads.map((ad, i) => ({ name: `${ad.pageName || query}${ad.startedAt ? ` · depuis le ${/^\d{4}-/.test(ad.startedAt) ? fmtDay(ad.startedAt.slice(0, 10)) : ad.startedAt}` : ""}`, ...(ad.imageUrl ? { image: ad.imageUrl } : {}), adId: `adlib:${ad.id}`, metrics: { ...(ad.videoUrl ? { Format: "vidéo" } : { Format: "image" }), ...(ad.platforms.length ? { Plateformes: ad.platforms.join(", ") } : {}), ...(ad.domain ? { Site: ad.domain } : {}) }, ...(ad.bodies[0] ? { note: ad.bodies[0].slice(0, 160) } : {}), link: ad.snapshotUrl ?? `https://www.facebook.com/ads/library/?id=${ad.id}`, n: i + 1 }));
  const onlyBrand = (res.brandAds ?? 0) > 0;
  const card: MoCardSpec = { type: "creatives", title: str(a.title, 90) || `Pubs ${query} en ce moment`, subtitle: `Bibliothèque publicitaire Meta · ${country} · ${onlyBrand ? `${ads.length} pubs de la marque affichées${res.total ? ` (${res.total} résultats au total)` : ""}` : `${res.total ? `${res.total} résultats, ` : ""}${ads.length} affichées (la marque n'apparaît pas comme annonceur : pubs qui la citent)`}`, items: items.map(({ n: _n, ...it }) => { void _n; return it; }) };
  const posted = ads.length && a.post !== false ? await postMoCards(ctx.boardId, [card]) : [];
  return {
    query, country, total: res.total ?? null, count: ads.length, brand_ads: res.brandAds ?? null, only_brand: onlyBrand,
    ...(posted.length ? { posted_card: posted[0], posted: "La carte est DÉJÀ sur le tableau : dis juste la phrase (combien de pubs, depuis quand, ce qui ressort)." } : {}),
    ...(a.post === false && ads.length ? { card_specs: [card] } : {}),
    ads: ads.map((ad, i) => ({ n: i + 1, libraryId: ad.id, page: ad.pageName, started: ad.startedAt, video: !!ad.videoUrl, image: ad.imageUrl ?? null, text: ad.bodies[0]?.slice(0, 200) ?? null, domain: ad.domain ?? null })),
    next: "Pour garder une pub comme template du client : keep_template avec son libraryId (et le client).",
  };
}

/** One ad of the library (or any https picture) kept as a template of the client: picture copied on the relay, analysed (hook, structure, text zones, brief). */
export async function keepTemplate(ctx: MoToolContext, a: Args): Promise<ToolResult> {
  const libraryId = str(a.libraryId, 40).replace(/^adlib:/, "");
  let imageUrl = /^https:\/\//.test(str(a.imageUrl, 2000)) ? str(a.imageUrl, 2000) : "";
  let brand = str(a.brand, 120);
  let text = str(a.body ?? a.text, 4000);
  let title = str(a.title, 500);
  let name = str(a.name, 120);
  let sourceUrl = libraryId ? `https://www.facebook.com/ads/library/?id=${libraryId}` : str(a.sourceUrl, 2000);
  // One of the client's OWN ads (warehouse, « meta:<id> ») kept as a template: source « own », texts and picture from the warehouse.
  const ownAdId = str(a.adId, 60);
  let own: Awaited<ReturnType<typeof ownAdTemplateSource>> = null;
  if (ownAdId) {
    own = await ownAdTemplateSource(ownAdId);
    if (!own) throw new MoToolError(`Annonce ${ownAdId} introuvable dans l'entrepôt.`, 404);
    imageUrl = imageUrl || own.imageUrl || ""; title = title || own.title; text = text || own.body; name = name || shortName(own.name);
  }
  if (libraryId && !imageUrl) {
    // The picture comes from the last search (cached on the relay for 10 min): the query is needed to find the ad again.
    const query = str(a.query ?? a.brand, 100);
    if (!query) throw new MoToolError("Donne imageUrl, ou query (la marque cherchée) pour retrouver la pub dans la bibliothèque.");
    const res = await searchAdLibrary({ q: query, country: /^[A-Za-z]{2}$/.test(str(a.country, 2)) ? str(a.country, 2).toUpperCase() : "FR", limit: 60, active: true });
    const ad = res.ads.find((x) => x.id === libraryId);
    if (!ad) throw new MoToolError(`Pub ${libraryId} introuvable dans la recherche « ${query} ».`, 404);
    imageUrl = ad.imageUrl ?? ""; brand = brand || ad.pageName; text = text || ad.bodies[0] || ""; sourceUrl = ad.snapshotUrl ?? sourceUrl;
  }
  if (!imageUrl && !text) throw new MoToolError("Il faut l'image (imageUrl) ou au moins le texte de la pub.");
  const client = a.client ? (await resolveClient(ctx, a.client)).client : own?.client ? (await resolveClient(ctx, own.client.id).catch(() => null))?.client ?? null : null;
  if (own) brand = brand || client?.name || own.client?.name || "";
  let dataUri: string | null = null;
  if (imageUrl) { const got = await fetchImageBytes(imageUrl); if (got) dataUri = toDataUri(got.buf, got.mediaType); }
  let file: string | null = null;
  if (dataUri) { try { file = (await relayUpload(dataUri)).file; } catch (e) { throw new MoToolError(`L'image n'a pas pu être enregistrée : ${e instanceof Error ? e.message : String(e)}`, 502); } }
  const author = await prisma.user.findUnique({ where: { id: ctx.userId }, select: { name: true, email: true } });
  const analysis = a.analyse === false ? null : await analyseTemplate({ image: dataUri ? dataUriToRelayImage(dataUri, "template") : null, title: title || null, body: text || null, brand: brand || null, user: { id: ctx.userId, email: ctx.email, role: ctx.role } });
  name = name || analysis?.hook || (brand ? `Pub ${brand}` : "Template");
  const row = await prisma.creativeTemplate.create({ data: {
    alertClientId: client?.clientId ?? own?.client?.id ?? null, clientName: client?.name ?? own?.client?.name ?? "", name, source: own ? "own" : "competitor", brand, sourceRef: own ? own.sourceRef : libraryId ? `adlib:${libraryId}` : null, sourceUrl: sourceUrl || null, imageUrl: imageUrl || null, file,
    title: title || null, body: text || null, analysisJson: JSON.stringify(analysis ?? {}), tags: str(a.tags, 300), createdById: ctx.userId, createdByName: (author?.name ?? "").trim() || author?.email || "Consultant",
  } });
  return { templateId: row.id, name: row.name, brand, source: row.source, client: client ? { id: client.id, name: client.name } : null, open: `/creas?${client ? `client=${client.id}&` : ""}tab=templates&template=${row.id}`, analysis: analysis ? { hook: analysis.hook, structure: analysis.structure, style: analysis.style, brief: analysis.brief } : null, note: "Template enregistré dans Créas › Templates & concurrents ; la personne peut dire « copie-le pour <client> » (generate_creatives avec references=[templateId] … ou ouvrir la page)." };
}

export async function runMoTool(ctx: MoToolContext, tool: string, args: unknown): Promise<ToolResult> {
  const a: Args = args && typeof args === "object" ? (args as Args) : {};
  switch (tool as MoToolName) {
    case "creatives": return creatives(ctx, a);
    case "metrics": return metrics(ctx, a);
    case "creative_metrics": return creativeMetrics(ctx, a);
    case "generate_creatives": return generateCreatives(ctx, a);
    case "meta_targets": return metaTargets(ctx, a);
    case "meta_publish_ad": return metaPublishAd(ctx, a);
    case "competitor_ads": return competitorAds(ctx, a);
    case "keep_template": return keepTemplate(ctx, a);
    default: throw new MoToolError(`Outil inconnu : ${tool}`, 404);
  }
}
