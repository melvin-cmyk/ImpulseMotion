/**
 * « Créas et performances » of a client bot — the Analyse Ads warehouse
 * (Motion-like) read for the bot's OWN accounts only, put in its system
 * prompt so the common questions (« mes meilleures pubs », « comment ça va
 * cette semaine », « montre-moi la créa qui marche ») are answered at once,
 * without a tool round trip.
 *
 * Scoping is server-side: the accounts come from the bot's dashboard (Meta
 * account, Google customer, TikTok advertisers attached to it), never from
 * the model. One block per platform (attribution differs: never summed).
 * Visuals go through /api/bot/[botId]/image, which checks the ad belongs to
 * the bot again. Cached 15 min per bot (one warm instance).
 */

import { queryAds, type AdsGroupRow, type AdsQuery, type AdsQueryResult, type Metrics } from "@/lib/ads-warehouse/query";
import type { WarehousePlatform } from "@/lib/ads-warehouse/types";
import { GLOSSARY_LABELS, type GlossaryKey } from "@/lib/ads-warehouse/glossary-labels";
import { fmtMetric } from "@/lib/ads-warehouse/metrics-ui";

export interface BotAdsAccounts { meta?: string | null; google?: string | null; tiktok?: string[] }

const TTL = 15 * 60_000;
const cache = new Map<string, { at: number; text: string }>();
const PLATFORM_LABEL: Record<string, string> = { meta: "Meta Ads", google: "Google Ads", tiktok: "TikTok Ads" };
const TREND_LABEL: Record<string, string> = { new: "nouvelle", scaling: "dépense en hausse", declining: "dépense en baisse", paused: "en pause", stable: "dépense stable", testing: "en test" };
const SHOWN_TAGS: GlossaryKey[] = ["ai:type", "ai:format", "ai:theme"];

const iso = (d: Date) => d.toISOString().slice(0, 10);
const frDate = (s: string) => `${s.slice(8, 10)}/${s.slice(5, 7)}`;

/** Last N complete days (yesterday included) and the N days before. */
export function window(days: number, now = new Date()) {
  const until = new Date(now); until.setUTCDate(until.getUTCDate() - 1);
  const since = new Date(until); since.setUTCDate(since.getUTCDate() - (days - 1));
  const pUntil = new Date(since); pUntil.setUTCDate(pUntil.getUTCDate() - 1);
  const pSince = new Date(pUntil); pSince.setUTCDate(pSince.getUTCDate() - (days - 1));
  return { range: { since: iso(since), until: iso(until) }, compare: { since: iso(pSince), until: iso(pUntil) } };
}

function money(v: number, cur: string | null): string {
  return new Intl.NumberFormat("fr-FR", { style: "currency", currency: cur || "EUR", maximumFractionDigits: v >= 100 ? 0 : 2 }).format(v);
}
const num = (v: number) => Math.round(v).toLocaleString("fr-FR");
function delta(cur: number, prev: number | undefined): string {
  if (!prev || !Number.isFinite(prev) || prev === 0) return "";
  const d = (cur - prev) / prev;
  if (Math.abs(d) < 0.03) return " (stable)";
  return ` (${d > 0 ? "+" : ""}${Math.round(d * 100)} %)`;
}

/** One line of account totals for a period. */
export function totalsLine(m: Metrics, prev: Metrics | null, cur: string | null): string {
  const f = (k: "ctr" | "cpm" | "hookRate") => fmtMetric(k, m[k], cur, m);
  const parts = [`dépense ${money(m.spend, cur)}${delta(m.spend, prev?.spend)}`, `impressions ${num(m.impressions)}`, `CTR ${f("ctr")}`, `CPM ${f("cpm")}`];
  if (m.conversions > 0) parts.push(`conversions ${num(m.conversions)}${delta(m.conversions, prev?.conversions)}`, `CPA ${money(m.cpa, cur)}${delta(m.cpa, prev?.cpa)}`);
  if (!m.roasUnavailable && m.conversionValue > 0) parts.push(`valeur ${money(m.conversionValue, cur)}`, `ROAS ${m.roas.toLocaleString("fr-FR", { maximumFractionDigits: 2 })}${m.estimated ? " (estimé)" : ""}${delta(m.roas, prev?.roas)}`);
  if (m.videoPlays > 0 && m.hookRate > 0) parts.push(`hook rate ${f("hookRate")}`);
  return parts.join(" · ");
}

export function imageUrl(botId: string, platform: string, adId: string, kind: "image" | "video" = "image"): string {
  return `/api/bot/${encodeURIComponent(botId)}/${kind}?ad=${encodeURIComponent(`${platform}:${adId}`)}`;
}

function creativeLine(botId: string, r: AdsGroupRow, i: number, cur: string | null): string {
  const a = r.sample!;
  const m = r.metrics;
  const tags = SHOWN_TAGS.map((k) => (a.tags[k] ? `${GLOSSARY_LABELS[k].split(" ")[0]} ${a.tags[k]}` : "")).filter(Boolean).join(" ; ");
  const kpis = [`dépense ${money(m.spend, cur)}`, `CTR ${fmtMetric("ctr", m.ctr, cur, m)}`];
  if (m.conversions > 0) kpis.push(`${num(m.conversions)} conv.`, `CPA ${money(m.cpa, cur)}`);
  if (!m.roasUnavailable && m.conversionValue > 0) kpis.push(`ROAS ${m.roas.toLocaleString("fr-FR", { maximumFractionDigits: 2 })}`);
  if (m.videoPlays > 0 && m.hookRate > 0) kpis.push(`hook ${fmtMetric("hookRate", m.hookRate, cur, m)}`);
  if (m.convertScore > 0) kpis.push(`score conversion ${Math.round(m.convertScore)}/100`);
  const trend = r.trend ? `, ${TREND_LABEL[r.trend.state] ?? "stable"}` : "";
  const text = [a.title, a.body].filter(Boolean).join(" — ").replace(/\s+/g, " ").slice(0, 90);
  const hasVisual = !!(a.imageUrl || a.thumbnailUrl || a.platform === "meta");
  return [
    `${i}. « ${r.label.slice(0, 60)} » — ${a.format}${a.dynamic ? " dynamique" : ""}${r.launch ? `, lancée le ${frDate(r.launch)}` : ""}${trend}`,
    `   ${kpis.join(" · ")}`,
    tags ? `   ${tags}` : "",
    text ? `   texte : ${text}` : "",
    a.platform === "meta" && a.videoId
      ? `   vidéo : ![${r.label.slice(0, 40).replace(/[[\]]/g, "")}](${imageUrl(botId, a.platform, a.adId, "video")})`
      : hasVisual ? `   visuel : ![${r.label.slice(0, 40).replace(/[[\]]/g, "")}](${imageUrl(botId, a.platform, a.adId)})` : "",
  ].filter(Boolean).join("\n");
}

async function platformBlock(botId: string, platform: WarehousePlatform, accountIds: string[], now: Date): Promise<string | null> {
  const base: Omit<AdsQuery, "range" | "compare"> = { platforms: [platform], accountIds, accounts: accountIds.map((id) => ({ platform, id })), groupBy: "creative", filters: {}, sort: { key: "spend", dir: "desc" } };
  const w30 = window(30, now), w7 = window(7, now);
  const [r30, r7]: AdsQueryResult[] = await Promise.all([
    queryAds({ ...base, ...w30, limit: 6 }),
    queryAds({ ...base, ...w7, limit: 3 }),
  ]);
  if (r30.benchmark.spend <= 0 && r7.benchmark.spend <= 0) return null;
  const cur = r30.currency;
  const rows30 = r30.rows.filter((r) => r.sample && r.metrics.spend > 0);
  const rows7 = r7.rows.filter((r) => r.sample && r.metrics.spend > 0);
  const best = [...rows30].filter((r) => r.metrics.conversions >= 3).sort((a, b) => (a.metrics.cpa || Infinity) - (b.metrics.cpa || Infinity)).slice(0, 3);
  return [
    `### ${PLATFORM_LABEL[platform]}`,
    `7 derniers jours (${frDate(w7.range.since)} → ${frDate(w7.range.until)}, écarts vs les 7 jours d'avant) : ${totalsLine(r7.benchmark, r7.benchmarkPrevious, cur)}`,
    `30 derniers jours (${frDate(w30.range.since)} → ${frDate(w30.range.until)}, écarts vs les 30 jours d'avant) : ${totalsLine(r30.benchmark, r30.benchmarkPrevious, cur)}`,
    rows7.length ? `Créas qui dépensent le plus sur 7 jours :\n${rows7.map((r, i) => creativeLine(botId, r, i + 1, cur)).join("\n")}` : "",
    rows30.length ? `Créas qui dépensent le plus sur 30 jours :\n${rows30.map((r, i) => creativeLine(botId, r, i + 1, cur)).join("\n")}` : "",
    best.length ? `Meilleur coût par conversion sur 30 jours (au moins 3 conversions) : ${best.map((r) => `« ${r.label.slice(0, 60)} » (${money(r.metrics.cpa, cur)})`).join(", ")}` : "",
  ].filter(Boolean).join("\n");
}

/** The block for the bot's prompt ("" when nothing is in the warehouse for its accounts). */
export async function buildBotAdsPack(botId: string, accounts: BotAdsAccounts, now = new Date()): Promise<string> {
  const plan: Array<[WarehousePlatform, string[]]> = [];
  if (accounts.meta) plan.push(["meta", [accounts.meta.replace(/^act_/, "")]]);
  if (accounts.google) plan.push(["google", [accounts.google.replace(/-/g, "")]]);
  if (accounts.tiktok?.length) plan.push(["tiktok", accounts.tiktok]);
  if (!plan.length) return "";
  const key = `${botId}|${JSON.stringify(plan)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.text;
  const blocks = (await Promise.all(plan.map(([p, ids]) => platformBlock(botId, p, ids, now).catch(() => null)))).filter(Boolean) as string[];
  const text = blocks.length ? [
    "CRÉAS ET PERFORMANCES PUBLICITAIRES (déjà calculées pour vous, comptes de ce client uniquement)",
    "- Ces chiffres viennent de l'entrepôt de l'agence, mis à jour plusieurs fois par jour ; données complètes jusqu'à hier. Pour les 7 ou 30 derniers jours, réponds DIRECTEMENT avec ce bloc, sans appeler d'outil. N'appelle un outil que pour une autre période, un autre niveau (campagne, ensemble) ou un indicateur absent d'ici.",
    "- Pour montrer une créa, recopie EXACTEMENT sa ligne « visuel » ou « vidéo » (syntaxe image Markdown ; une vidéo s'affiche en lecteur dans le chat) : ce sont les seules adresses que tu as le droit d'écrire. Mets le visuel juste au-dessus de ses chiffres. 3 visuels maximum par réponse sauf demande explicite.",
    "- Désigne les créas par leur nom entre guillemets, jamais par un identifiant. Chaque plateforme a sa propre attribution : ne les additionne jamais.",
    ...blocks,
  ].join("\n") : "";
  cache.set(key, { at: Date.now(), text });
  return text;
}
