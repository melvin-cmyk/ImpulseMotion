/**
 * « Thèmes de message » — Motion's Messaging themes, per client:
 * - analyse: the AI reads the copy of the client's creatives that spent over
 *   the last 90 days, proposes 6–12 themes specific to the client (name + one
 *   sentence) and files every creative under one; stored in AdMessageTheme
 *   and on each ad (AdCatalog.tagsJson "ai:msg");
 * - list: per theme, spend over the period, active creatives, hit rate
 *   (creatives that reached the goal once significant ÷ creatives), and
 *   Motion's badge: Prouvé / En test.
 */

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { relayComplete, parseLooseJson } from "@/lib/relay-chat";
import { recordAiUsage } from "@/lib/ai-usage";
import { queryAds, type AdSample, type AdsGroupRow, type AdsQuery, type Metrics } from "./query";

export const THEME_TAG = "ai:msg";

export type ThemeStatus = "proven" | "testing" | null;

export interface ThemeStat {
  name: string;
  description: string;
  spend: number;
  creatives: number;
  active: number;
  winners: number;
  /** winners ÷ creatives, 0–1. */
  hitRate: number;
  status: ThemeStatus;
  sample: AdSample | null;
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

function isWinner(m: Metrics, bench: Metrics, bar: number, goal: "roas" | "cpa" | "cvr"): boolean {
  if (m.spend < bar) return false;
  if (goal === "roas") return m.roas > 0 && m.roas >= bench.roas;
  if (goal === "cpa") return m.cpa > 0 && m.cpa <= bench.cpa;
  return m.cvr > 0 && m.cvr >= bench.cvr;
}

const SYSTEM = `Tu es stratège créatif en acquisition payante. On te donne les annonces d'UN annonceur (texte principal, titre, nom interne). Trouve les THÈMES DE MESSAGE propres à cet annonceur : la promesse ou la motivation principale que chaque annonce met en avant (ex. pour du soutien scolaire : « Réassurance des parents », « Professeurs qualifiés », « Résultats concrets », « Crédit d'impôt »). Règles :
- 6 à 12 thèmes, noms en français de 2 à 4 mots, précis et propres à cet annonceur (pas « Bénéfice » ou « Qualité » seuls) ;
- une phrase de description par thème (ce que disent les annonces, avec leurs mots) ;
- chaque annonce reçoit exactement UN thème de la liste.
Réponds UNIQUEMENT en JSON : {"themes":[{"name":"…","description":"…"}],"assign":{"1":"nom du thème","2":"…"}}`;

/** Analyses the client's copy and files its creatives under AI themes; returns the themes. */
export async function analyzeThemes(q: AdsQuery, accountKey: string, user: { id: string; email: string | null; role: string }): Promise<Array<{ name: string; description: string }>> {
  const until = new Date(); until.setUTCDate(until.getUTCDate() - 1);
  const since = new Date(until); since.setUTCDate(since.getUTCDate() - 89);
  const res = await queryAds({ ...q, groupBy: "creative", filters: {}, compare: null, range: { since: iso(since), until: iso(until) }, sort: { key: "spend", dir: "desc" }, limit: 150 });
  const rows = res.rows.filter((r) => r.sample && (r.sample.body || r.sample.title || r.sample.name));
  if (rows.length < 3) throw new Error("Pas assez d'annonces avec du texte sur 90 jours pour dégager des thèmes.");
  const lines = rows.map((r, i) => {
    const a = r.sample!;
    const txt = [a.title, a.body].filter(Boolean).join(" — ").replace(/\s+/g, " ").slice(0, 320);
    return `${i + 1} | ${txt || "(pas de texte)"} | nom : ${a.name.slice(0, 120)}`;
  });
  const text = await relayComplete(
    { messages: [{ role: "user", content: `Annonces (n° | texte | nom interne) :\n${lines.join("\n")}` }], systemPrompt: SYSTEM, allowedServers: [], accountScope: {}, model: "sonnet", effort: "low", maxTurns: 1 },
    { maxMs: 170_000, onUsage: (usage) => void recordAiUsage(usage, { feature: "analyse_themes", clientName: accountKey, user }) },
  );
  const parsed = parseLooseJson<{ themes?: Array<{ name?: string; description?: string }>; assign?: Record<string, string> }>(text);
  const themes = (parsed?.themes ?? []).map((t) => ({ name: String(t.name ?? "").trim().slice(0, 60), description: String(t.description ?? "").trim().slice(0, 400) })).filter((t) => t.name).slice(0, 12);
  if (themes.length < 2) throw new Error("Réponse de l'IA illisible, réessaie.");
  const names = new Set(themes.map((t) => t.name));

  const byTheme = new Map<string, string[]>();
  rows.forEach((r, i) => {
    const t = parsed?.assign?.[String(i + 1)]?.trim();
    if (!t || !names.has(t)) return;
    const ids = [r.sample!, ...r.ads].map((a) => `${a.platform}:${a.adId}`);
    byTheme.set(t, [...(byTheme.get(t) ?? []), ...ids]);
  });

  await prisma.$transaction(async (tx) => {
    await tx.adMessageTheme.deleteMany({ where: { accountKey } });
    await tx.adMessageTheme.createMany({ data: themes.map((t, i) => ({ accountKey, name: t.name, description: t.description, position: i })) });
    await tx.$executeRaw(Prisma.sql`UPDATE "AdCatalog" SET "tagsJson" = ("tagsJson"::jsonb - ${THEME_TAG})::text WHERE platform IN (${Prisma.join(q.platforms)}) AND "accountId" IN (${Prisma.join(q.accountIds)}) AND "tagsJson"::jsonb ? ${THEME_TAG}`);
    for (const [name, ids] of byTheme) {
      const unique = Array.from(new Set(ids));
      await tx.$executeRaw(Prisma.sql`UPDATE "AdCatalog" SET "tagsJson" = jsonb_set(COALESCE(NULLIF("tagsJson", ''), '{}')::jsonb, ${`{${THEME_TAG}}`}::text[], to_jsonb(${name}::text))::text WHERE id IN (${Prisma.join(unique)})`);
    }
  }, { timeout: 60_000 });
  return themes;
}

/** Themes of the client with their numbers over q.range (Motion's Messaging themes list). */
export async function listThemes(q: AdsQuery, accountKey: string): Promise<{ themes: ThemeStat[]; analyzedAt: string | null; currency: string | null; spendThreshold: number }> {
  const stored = await prisma.adMessageTheme.findMany({ where: { accountKey }, orderBy: { position: "asc" } });
  if (!stored.length) return { themes: [], analyzedAt: null, currency: null, spendThreshold: 0 };
  const res = await queryAds({ ...q, groupBy: "creative", filters: {}, compare: null, sort: { key: "spend", dir: "desc" }, limit: 200 });
  const groups = new Map<string, AdsGroupRow[]>();
  for (const r of res.rows) {
    const t = r.sample?.tags?.[THEME_TAG];
    if (t) groups.set(t, [...(groups.get(t) ?? []), r]);
  }
  const bar = res.spendThreshold;
  const themes: ThemeStat[] = stored.map((t) => {
    const rows = groups.get(t.name) ?? [];
    const spend = rows.reduce((s, r) => s + r.metrics.spend, 0);
    const winners = rows.filter((r) => isWinner(r.metrics, res.benchmark, bar, res.goal)).length;
    const active = rows.filter((r) => (r.trend?.last7 ?? 0) > 0).length;
    const recent = rows.length > 0 && rows.every((r) => r.trend?.state === "new" || (r.launch && Date.now() - Date.parse(r.launch + "T00:00:00Z") < 30 * 86_400_000));
    const hitRate = rows.length ? winners / rows.length : 0;
    const status: ThemeStatus = winners > 0 && hitRate >= 0.15 && spend >= bar * 2 ? "proven" : rows.length > 0 && (recent || spend < bar) ? "testing" : null;
    return { name: t.name, description: t.description, spend: Math.round(spend * 100) / 100, creatives: rows.length, active, winners, hitRate, status, sample: rows[0]?.sample ?? null };
  });
  return { themes, analyzedAt: stored[0].createdAt.toISOString(), currency: res.currency, spendThreshold: bar };
}
