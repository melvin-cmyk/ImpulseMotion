/**
 * Store of Analyse Ads opportunities (Motion's Opportunities): detection over
 * the last 14 days of the client's creatives, one row per (creative, type)
 * until it expires (30 days), status changes, and the AI suggestion
 * (Motion's aiSuggestion: what attracts today + concrete changes), generated
 * on demand through the relay and rated by the consultant.
 */

import { prisma } from "@/lib/prisma";
import { relayComplete, parseLooseJson } from "@/lib/relay-chat";
import { recordAiUsage } from "@/lib/ai-usage";
import { queryAds, type AdsQuery } from "./query";
import { metricsAtAssignment, opportunitiesOf, OPPORTUNITY_LABEL, OPPORTUNITY_TTL_DAYS, type MetricsAtAssignment, type OpportunityStatus, type OpportunityType } from "./opportunities";

export interface AiSuggestion { currentAttractionSummary: string; changes: Array<{ summary: string; actionableChange: string }> }

export interface OpportunityItem {
  id: string;
  platform: string;
  accountId: string;
  creativeKey: string;
  adId: string;
  title: string;
  type: OpportunityType;
  status: OpportunityStatus;
  description: string;
  strengths: string[];
  weaknesses: string[];
  metrics: MetricsAtAssignment;
  aiSuggestion: AiSuggestion | null;
  aiScore: number | null;
  assignedAt: string;
  statusByName: string;
  /** Visual and delivery state of the ad today. */
  ad: { format: string; status: string | null; imageUrl: string | null; thumbnailUrl: string | null; videoId: string | null; body: string | null; title: string | null; name: string } | null;
}

const ttlStart = () => new Date(Date.now() - OPPORTUNITY_TTL_DAYS * 86_400_000);
const parse = <T>(s: string | null | undefined, d: T): T => { try { return s ? (JSON.parse(s) as T) : d; } catch { return d; } };

/** Detects the opportunities of the last 14 days (ending at q.range.until) and stores the new ones. */
export async function refreshOpportunities(q: AdsQuery): Promise<number> {
  if (!q.accountIds.length) return 0;
  const until = q.range.until;
  const since = new Date(until + "T00:00:00Z"); since.setUTCDate(since.getUTCDate() - 13);
  const res = await queryAds({ ...q, groupBy: "creative", filters: {}, compare: null, range: { since: since.toISOString().slice(0, 10), until }, sort: { key: "spend", dir: "desc" }, limit: 200 });
  const found = opportunitiesOf(res.rows, res.spendThreshold);
  if (!found.size) return 0;
  const existing = await prisma.adOpportunity.findMany({
    where: { accountId: { in: q.accountIds }, creativeKey: { in: Array.from(found.keys()) }, assignedAt: { gte: ttlStart() } },
    select: { creativeKey: true, type: true },
  });
  const seen = new Set(existing.map((e) => `${e.creativeKey}|${e.type}`));
  let created = 0;
  for (const r of res.rows) {
    const o = found.get(r.key);
    if (!o || !r.sample || seen.has(`${r.key}|${o.type}`)) continue;
    await prisma.adOpportunity.create({
      data: {
        platform: r.sample.platform, accountId: r.sample.accountId, creativeKey: r.key, adId: r.sample.adId, title: r.label.slice(0, 300),
        type: o.type, description: o.description, strengthsJson: JSON.stringify(o.strengths), weaknessesJson: JSON.stringify(o.weaknesses),
        metricsJson: JSON.stringify(metricsAtAssignment(r.metrics)),
      },
    });
    created += 1;
  }
  return created;
}

export async function listOpportunities(q: AdsQuery, status: OpportunityStatus): Promise<OpportunityItem[]> {
  if (!q.accountIds.length) return [];
  const rows = await prisma.adOpportunity.findMany({
    where: { platform: { in: q.platforms }, accountId: { in: q.accountIds }, status, assignedAt: { gte: ttlStart() } },
    orderBy: { assignedAt: "desc" },
    take: 300,
  });
  const ads = await prisma.adCatalog.findMany({
    where: { id: { in: rows.map((r) => `${r.platform}:${r.adId}`) } },
    select: { id: true, format: true, status: true, imageUrl: true, thumbnailUrl: true, videoId: true, body: true, title: true, name: true },
  });
  const byId = new Map(ads.map((a) => [a.id, a]));
  return rows.map((r) => {
    const a = byId.get(`${r.platform}:${r.adId}`);
    return {
      id: r.id, platform: r.platform, accountId: r.accountId, creativeKey: r.creativeKey, adId: r.adId, title: r.title,
      type: r.type as OpportunityType, status: r.status as OpportunityStatus, description: r.description,
      strengths: parse<string[]>(r.strengthsJson, []), weaknesses: parse<string[]>(r.weaknessesJson, []),
      metrics: parse<MetricsAtAssignment>(r.metricsJson, {} as MetricsAtAssignment),
      aiSuggestion: parse<AiSuggestion | null>(r.aiSuggestionJson, null), aiScore: r.aiScore,
      assignedAt: r.assignedAt.toISOString(), statusByName: r.statusByName,
      ad: a ? { format: a.format, status: a.status, imageUrl: a.imageUrl, thumbnailUrl: a.thumbnailUrl, videoId: a.videoId, body: a.body, title: a.title, name: a.name } : null,
    };
  });
}

export async function opportunityAccount(id: string): Promise<{ platform: string; accountId: string } | null> {
  return prisma.adOpportunity.findUnique({ where: { id }, select: { platform: true, accountId: true } });
}

export async function updateOpportunity(id: string, patch: { status?: OpportunityStatus; aiScore?: number | null }, who: { id: string; name: string }) {
  return prisma.adOpportunity.update({
    where: { id },
    data: {
      ...(patch.status ? { status: patch.status, statusById: who.id, statusByName: who.name } : {}),
      ...(patch.aiScore !== undefined ? { aiScore: patch.aiScore } : {}),
    },
    select: { id: true, status: true, aiScore: true },
  });
}

const SYSTEM = `Tu es directeur de création en acquisition payante (Meta, Google, TikTok). On te donne UNE créa qui a déjà pris du budget et l'opportunité détectée sur ses scores (0-100, rang dans le compte). Réponds en français, concret, sans jargon inutile, UNIQUEMENT en JSON :
{"currentAttractionSummary": "ce qui attire aujourd'hui dans cette créa, en 2 phrases max", "changes": [{"summary": "titre court du changement", "actionableChange": "ce qu'il faut faire exactement (texte à écrire, plan à tourner, élément à modifier)"}]}
Donne 3 changements, tous centrés sur l'opportunité, et garde ce qui marche.`;

export async function generateSuggestion(id: string, user: { id: string; email: string | null; role: string }): Promise<AiSuggestion> {
  const o = await prisma.adOpportunity.findUnique({ where: { id } });
  if (!o) throw new Error("opportunité inconnue");
  const ad = await prisma.adCatalog.findUnique({ where: { id: `${o.platform}:${o.adId}` }, select: { name: true, format: true, title: true, body: true, landingUrl: true, tagsJson: true } });
  const m = parse<MetricsAtAssignment>(o.metricsJson, {} as MetricsAtAssignment);
  const lines = [
    `Opportunité : ${OPPORTUNITY_LABEL[o.type as OpportunityType] ?? o.type} — ${o.description}`,
    `Forces : ${parse<string[]>(o.strengthsJson, []).join(" ; ")}`,
    `Faiblesses : ${parse<string[]>(o.weaknessesJson, []).join(" ; ")}`,
    `Créa : ${ad?.name ?? o.title} · format ${ad?.format ?? "?"}`,
    ad?.title ? `Titre : ${ad.title.slice(0, 300)}` : "",
    ad?.body ? `Texte : ${ad.body.replace(/\s+/g, " ").slice(0, 800)}` : "",
    ad?.landingUrl ? `Landing : ${ad.landingUrl}` : "",
    ad?.tagsJson && ad.tagsJson !== "{}" ? `Tags : ${ad.tagsJson.slice(0, 600)}` : "",
    `Chiffres à la détection : dépenses ${m.spend}, CPA ${m.cpa}, ROAS ${m.roas}, CTR ${m.ctr} %, hook rate ${m.hookRate} %, hold rate ${m.holdRate} %, scores hook ${m.hookScore} / watch ${m.watchScore} / click ${m.clickScore} / convert ${m.convertScore}`,
  ].filter(Boolean);
  const text = await relayComplete(
    { messages: [{ role: "user", content: lines.join("\n") }], systemPrompt: SYSTEM, allowedServers: [], accountScope: {}, model: "sonnet", effort: "low", maxTurns: 1 },
    { maxMs: 90_000, onUsage: (usage) => void recordAiUsage(usage, { feature: "analyse_opportunity", clientName: `${o.platform}:${o.accountId}`, user: { id: user.id, email: user.email, role: user.role } }) },
  );
  const parsed = parseLooseJson<AiSuggestion>(text);
  if (!parsed?.changes?.length) throw new Error("Réponse de l'IA illisible, réessaie.");
  const suggestion: AiSuggestion = {
    currentAttractionSummary: String(parsed.currentAttractionSummary ?? "").slice(0, 600),
    changes: parsed.changes.slice(0, 5).map((c) => ({ summary: String(c.summary ?? "").slice(0, 160), actionableChange: String(c.actionableChange ?? "").slice(0, 800) })),
  };
  await prisma.adOpportunity.update({ where: { id }, data: { aiSuggestionJson: JSON.stringify(suggestion), aiScore: null } });
  return suggestion;
}
