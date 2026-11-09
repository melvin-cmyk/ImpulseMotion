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
import { stateId, type WarehousePlatform } from "@/lib/ads-warehouse/types";
import { prisma } from "@/lib/prisma";
import { GLOSSARY_LABELS, type GlossaryKey } from "@/lib/ads-warehouse/glossary-labels";
import { fmtMetric } from "@/lib/ads-warehouse/metrics-ui";

export interface BotAdsAccounts { meta?: string | null; google?: string | null; tiktok?: string[] }

const TTL = 15 * 60_000;
const cache = new Map<string, { at: number; text: string }>();
const PLATFORM_LABEL: Record<string, string> = { meta: "Meta Ads", google: "Google Ads", tiktok: "TikTok Ads" };
/** Live tools of each platform (relay MCP servers), named in the « go and fetch it » notes. */
const LIVE_TOOLS: Record<string, string> = { meta: "mcp__meta-ads-impulse__*", google: "mcp__mcp-google-ads__*", tiktok: "mcp__mcp-tiktok-ads__*" };

/** Note put in place of / under a platform block when the warehouse cannot answer on its own. */
export function liveNote(platform: string, reason: string): string {
  return `⚠ ${PLATFORM_LABEL[platform] ?? platform} : ${reason} → pour toute question chiffrée sur cette plateforme, interroge D'ABORD l'outil en direct (${LIVE_TOOLS[platform] ?? "outil de la plateforme"}) avec la période demandée, puis réponds avec ses chiffres. Ne réponds jamais « pas de données » sans avoir fait cet appel.`;
}

/** Last day fully synced for these accounts (the oldest of them), null when never synced. */
async function syncedTo(platform: WarehousePlatform, accountIds: string[]): Promise<string | null> {
  const states = await prisma.adSyncState.findMany({ where: { id: { in: accountIds.map((id) => stateId(platform, id)) } }, select: { syncedTo: true } });
  if (states.length < accountIds.length || states.some((s) => !s.syncedTo)) return null;
  return states.map((s) => iso(s.syncedTo as Date)).sort()[0];
}
const TREND_LABEL: Record<string, string> = { new: "nouvelle", scaling: "dépense en hausse", declining: "dépense en baisse", paused: "en pause", stable: "dépense stable", testing: "en test" };
const SHOWN_TAGS: GlossaryKey[] = ["ai:type", "ai:format", "ai:theme"];
const FORMAT_FR: Record<string, string> = { Video: "Vidéo", Image: "Image", Carousel: "Carrousel", Text: "Texte", Unknown: "Créa" };

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
  if (m.conversions > 0) kpis.push(`conversions ${num(m.conversions)}`, `CPA ${money(m.cpa, cur)}`);
  if (!m.roasUnavailable && m.conversionValue > 0) kpis.push(`ROAS ${m.roas.toLocaleString("fr-FR", { maximumFractionDigits: 2 })}`);
  if (m.videoPlays > 0 && m.hookRate > 0) kpis.push(`hook ${fmtMetric("hookRate", m.hookRate, cur, m)}`);
  if (m.convertScore > 0) kpis.push(`score conversion ${Math.round(m.convertScore)}/100`);
  const trend = r.trend ? `, ${TREND_LABEL[r.trend.state] ?? "stable"}` : "";
  const text = [a.title, a.body].filter(Boolean).join(" — ").replace(/\s+/g, " ").slice(0, 90);
  const hasVisual = !!(a.imageUrl || a.thumbnailUrl || a.platform === "meta");
  // Dynamic product ad (catalogue): no fixed visual, Meta's thumbnail is a placeholder → products of its catalogue.
  const dpa = a.platform === "meta" && /\{\{\s*product\./.test(`${a.title ?? ""} ${a.body ?? ""}`);
  const alt = r.label.slice(0, 40).replace(/[[\]]/g, "");
  const name = r.label.slice(0, 60).replace(/[[\]|]/g, " ").trim();
  const caption = [
    dpa ? "Catalogue dynamique (exemple de produit)" : `${FORMAT_FR[a.format] ?? a.format}${a.dynamic ? " dynamique" : ""}`,
    r.launch ? `lancée le ${frDate(r.launch)}` : "",
  ].filter(Boolean).join(" · ");
  const src = dpa ? `${imageUrl(botId, a.platform, a.adId)}&product=0`
    : a.platform === "meta" && a.videoId ? imageUrl(botId, a.platform, a.adId, "video")
    : hasVisual ? imageUrl(botId, a.platform, a.adId) : "";
  return [
    `${i}. « ${r.label.slice(0, 60)} » — ${a.format}${a.dynamic ? " dynamique" : ""}${r.launch ? `, lancée le ${frDate(r.launch)}` : ""}${trend}`,
    tags ? `   ${tags}` : "",
    text ? `   texte : ${text}` : "",
    dpa ? `   publicité dynamique du catalogue : chaque personne voit un produit différent ; autres exemples de produits : &product=1 et &product=2` : "",
    src ? `   carte : ![${name}](${src}) | ${caption} | ${kpis.join(" · ")}` : `   chiffres : ${kpis.join(" · ")}`,
  ].filter(Boolean).join("\n");
}

async function platformBlock(botId: string, platform: WarehousePlatform, accountIds: string[], now: Date): Promise<string> {
  const base: Omit<AdsQuery, "range" | "compare"> = { platforms: [platform], accountIds, accounts: accountIds.map((id) => ({ platform, id })), groupBy: "creative", filters: {}, sort: { key: "spend", dir: "desc" } };
  const w30 = window(30, now), w7 = window(7, now);
  const [r30, r7, lastDay] = await Promise.all([
    // 40 groups: the top 6 of the month plus the recent launches below.
    queryAds({ ...base, ...w30, limit: 40 }),
    queryAds({ ...base, ...w7, limit: 3 }),
    syncedTo(platform, accountIds).catch(() => null),
  ]) as [AdsQueryResult, AdsQueryResult, string | null];
  // Nothing in the warehouse: say so, so the model fetches live instead of answering « no data ».
  if (r30.benchmark.spend <= 0 && r7.benchmark.spend <= 0) {
    return `### ${PLATFORM_LABEL[platform]}\n${liveNote(platform, "aucune donnée dans l'entrepôt de l'agence pour ce compte (pas encore synchronisé, ou pas de dépense récente)")}`;
  }
  // Behind: the last days of the windows are missing or partial.
  const gaps: string[] = [];
  if (!lastDay || lastDay < w7.range.until) gaps.push(lastDay ? `l'entrepôt n'est à jour que jusqu'au ${frDate(lastDay)} (les chiffres ci-dessous sont incomplets)` : "synchronisation de l'entrepôt inachevée (chiffres possiblement incomplets)");
  if (r7.benchmark.spend > 0 && r7.benchmark.impressions <= 0) gaps.push("impressions absentes de l'entrepôt sur 7 jours");
  const cur = r30.currency;
  const all30 = r30.rows.filter((r) => r.sample && r.metrics.spend > 0);
  const rows30 = all30.slice(0, 6);
  // Launched in the last 14 days (« les nouvelles créas », « S44-S45 »): with their visual, by spend.
  const since14 = iso(new Date(now.getTime() - 14 * 86400_000));
  const shownIds = new Set([...rows30, ...r7.rows].map((r) => r.sample?.adId));
  const recent = all30.filter((r) => r.launch && r.launch >= since14 && !shownIds.has(r.sample?.adId)).slice(0, 6);
  const rows7 = r7.rows.filter((r) => r.sample && r.metrics.spend > 0);
  // « Mes meilleures créas » = efficiency, not spend: ranked here so the bot
  // answers at once instead of fetching and sorting live (87 s → one turn).
  // Creatives with too little spend are left out (a lucky 5 € ad is no « best »).
  const minSpend = Math.max(20, r30.benchmark.spend * 0.01);
  const ranked = all30.filter((r) => r.metrics.spend >= minSpend);
  const byRoas = ranked.filter((r) => !r.metrics.roasUnavailable && r.metrics.conversionValue > 0 && r.metrics.roas > 0).sort((a, b) => b.metrics.roas - a.metrics.roas).slice(0, 6);
  const byCpa = ranked.filter((r) => r.metrics.conversions >= 3 && r.metrics.cpa > 0).sort((a, b) => a.metrics.cpa - b.metrics.cpa).slice(0, 6);
  // A creative already listed above is not repeated in full: its number points to it.
  const listed = new Map<string | undefined, string>();
  rows7.forEach((r, i) => { if (!listed.has(r.sample?.adId)) listed.set(r.sample?.adId, `n°${i + 1} des 7 jours`); });
  rows30.forEach((r, i) => { if (!listed.has(r.sample?.adId)) listed.set(r.sample?.adId, `n°${i + 1} des 30 jours`); });
  recent.forEach((r, i) => { if (!listed.has(r.sample?.adId)) listed.set(r.sample?.adId, `n°${i + 1} des lancées récemment`); });
  const rankedLines = (rows: AdsGroupRow[], what: (r: AdsGroupRow) => string) => rows.map((r, i) => {
    const seen = listed.get(r.sample?.adId);
    if (seen) return `${i + 1}. « ${r.label.slice(0, 60)} » — ${what(r)} — déjà détaillée plus haut (${seen}) : reprends sa ligne « carte : »`;
    listed.set(r.sample?.adId, `n°${i + 1} du classement`);
    return creativeLine(botId, r, i + 1, cur);
  }).join("\n");
  const roasOf = (r: AdsGroupRow) => `ROAS ${r.metrics.roas.toLocaleString("fr-FR", { maximumFractionDigits: 2 })}`;
  const cpaOf = (r: AdsGroupRow) => `CPA ${money(r.metrics.cpa, cur)}`;
  return [
    `### ${PLATFORM_LABEL[platform]}`,
    gaps.length ? liveNote(platform, gaps.join(" ; ")) : "",
    `7 derniers jours (${frDate(w7.range.since)} → ${frDate(w7.range.until)}, écarts vs les 7 jours d'avant) : ${totalsLine(r7.benchmark, r7.benchmarkPrevious, cur)}`,
    `30 derniers jours (${frDate(w30.range.since)} → ${frDate(w30.range.until)}, écarts vs les 30 jours d'avant) : ${totalsLine(r30.benchmark, r30.benchmarkPrevious, cur)}`,
    rows7.length ? `Créas qui dépensent le plus sur 7 jours :\n${rows7.map((r, i) => creativeLine(botId, r, i + 1, cur)).join("\n")}` : "",
    rows30.length ? `Créas qui dépensent le plus sur 30 jours :\n${rows30.map((r, i) => creativeLine(botId, r, i + 1, cur)).join("\n")}` : "",
    recent.length ? `Créas lancées ces 14 derniers jours (hors celles ci-dessus) :\n${recent.map((r, i) => creativeLine(botId, r, i + 1, cur)).join("\n")}` : "",
    byRoas.length ? `Meilleures créas sur 30 jours au ROAS (dépense d'au moins ${money(minSpend, cur)}) :\n${rankedLines(byRoas, roasOf)}` : "",
    byCpa.length ? `Meilleures créas sur 30 jours au coût par conversion (au moins 3 conversions, dépense d'au moins ${money(minSpend, cur)}) :\n${rankedLines(byCpa, cpaOf)}` : "",
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
  const blocks = await Promise.all(plan.map(([p, ids]) => platformBlock(botId, p, ids, now).catch(() => `### ${PLATFORM_LABEL[p]}\n${liveNote(p, "entrepôt de l'agence momentanément illisible")}`)));
  const text = blocks.length ? [
    "CRÉAS ET PERFORMANCES PUBLICITAIRES (déjà calculées pour vous, comptes de ce client uniquement)",
    "- Ces chiffres viennent de l'entrepôt de l'agence, mis à jour plusieurs fois par jour ; données complètes jusqu'à hier. Pour les 7 ou 30 derniers jours, réponds DIRECTEMENT avec ce bloc, sans appeler d'outil. N'appelle un outil que pour une autre période, un autre niveau (campagne, ensemble), un indicateur absent d'ici, ou une plateforme marquée ⚠ : là, va chercher les chiffres en direct.",
    "- LES CLIENTS VEULENT VOIR LEURS CRÉAS, pas seulement des chiffres. Dès qu'une réponse porte sur les performances publicitaires (période, plateforme, campagne, meilleures pubs), termine-la par les cartes des créas qui pèsent le plus sur cette période, même si le client n'a demandé que des chiffres. Pas de limite de nombre : autant de cartes que la question en appelle (toutes celles demandées si le client en veut plus).",
    "- Une carte seulement pour une créa qui a un visuel (une ligne « carte : » ici, ou une vidéo / image d'un outil en direct). Les annonces texte (Google Recherche) et les créas marquées « chiffres : » n'ont pas de visuel : cite-les dans le texte ou dans un tableau, pas en carte.",
    "- Les créas s'affichent en CARTES dans le chat : écris UN bloc de code ```creas puis une ligne par créa, et ferme le bloc. Pour une créa de ce bloc, recopie EXACTEMENT ce qui suit « carte : » (visuel | format · lancement | chiffres). N'écris jamais de visuel de créa hors d'un bloc creas, et ne répète pas sous le bloc les chiffres déjà dans les cartes.",
    `- Pour une créa obtenue par un outil en direct (autre période, campagne précise…), écris sa ligne de carte ainsi, avec l'identifiant d'annonce renvoyé par l'outil : ![nom de la créa](${imageUrl(botId, "PLATEFORME", "ID")}) | format · lancement | dépense … · CTR … · ROAS … en remplaçant PLATEFORME par meta, google ou tiktok et ID par l'identifiant de l'annonce (ad id) ; pour une vidéo Meta, remplace « /image? » par « /video? ». Sans identifiant, utilise le nom exact de l'annonce : ![nom](/api/bot/${encodeURIComponent(botId)}/image?name=NOM) avec NOM = le nom de l'annonce encodé pour une adresse (espaces en %20). Ce sont les SEULES adresses que tu as le droit d'écrire ; l'identifiant reste dans l'adresse de l'image, jamais dans le texte.`,
    "- Publicité dynamique du catalogue (DPA, texte avec {{product.…}}) trouvée en direct : elle n'a pas de visuel fixe ; montre 3 produits de son catalogue en ajoutant &product=0, &product=1 et &product=2 à l'adresse image, présentés comme des exemples de produits diffusés.",
    "- Toutes les créas des comptes de ce client, même lancées hier, ont leur visuel côté serveur : ne dis JAMAIS qu'une créa n'est « pas indexée » ou que son visuel est indisponible, écris l'adresse du visuel ; si l'image ne se charge pas, le chat l'indique lui-même.",
    "- « Meilleures créas », « celles qui marchent le mieux », « les plus rentables » : sur 30 jours, utilise DIRECTEMENT les classements « Meilleures créas … au ROAS » (e-commerce) ou « … au coût par conversion » (sans ROAS), sans appeler d'outil. Les créas « qui dépensent le plus » ne sont pas les meilleures. N'appelle un outil que pour une autre période ou plus de 6 créas.",
    "- Désigne les créas par leur nom entre guillemets, jamais par un identifiant. Chaque plateforme a sa propre attribution : ne les additionne jamais.",
    ...blocks,
  ].join("\n") : "";
  cache.set(key, { at: Date.now(), text });
  return text;
}
