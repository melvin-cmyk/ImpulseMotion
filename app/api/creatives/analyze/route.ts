/**
 * POST /api/creatives/analyze  { accountId, since, until, refresh? }
 *
 * AI creative analysis on REAL Meta data: loads the same creatives as
 * /api/meta/creatives (shared loader), keeps the top 40 by spend, renders a
 * compact text table and asks the relay for a strict JSON verdict
 * (summary / winners / losers / patterns / hooks / recommendations).
 * The model reasons only from the table — no invented numbers.
 * Cached 1 h in KpiCache (bypass with `refresh`).
 */

import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-helpers";
import { assertAccountAllowed } from "@/lib/acl";
import { cached } from "@/lib/kpi-cache";
import { relayComplete, parseLooseJson } from "@/lib/relay-chat";
import { loadCreatives } from "@/lib/creatives-server";
import { validateRange } from "@/lib/date-ranges";
import type { Creative } from "@/lib/creative-types";

// Measured against the relay (claude CLI + MCP warm-up ≈ 30 s, then a long
// reasoning pass on 40 rows): a full analysis takes 2–4 min. 100 s was cutting
// the stream before the first token, so the budget follows the report generator.
export const maxDuration = 300;

const TOP_N = 40;
const TTL_MS = 60 * 60 * 1000;

// ── Result shape ──────────────────────────────────────────────────────────────

export interface CreativeAnalysis {
  summary: string[];
  winners: { adId: string; name: string; why: string }[];
  losers: { adId: string; name: string; why: string; action: "cut" | "iterate" | "watch" }[];
  patterns: { title: string; evidence: string; impact: "positive" | "negative" }[];
  hooks: { hook: string; verdict: string }[];
  recommendations: { title: string; detail: string; priority: "high" | "medium" | "low" }[];
  /** Ads actually sent to the model (top by spend). */
  analyzedCount: number;
  generatedAt: string;
}

// ── Prompt ────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `Tu es un(e) creative strategist senior chez Impulse Analytics, spécialiste Meta Ads (e-commerce et lead gen).
On te fournit un tableau de créas publicitaires avec leurs métriques réelles sur la période.

Règles absolues :
- Tu raisonnes UNIQUEMENT à partir des données du tableau. N'invente jamais un chiffre, un nom de créa ou un fait absent du tableau.
- Quand tu cites une métrique, reprends la valeur exacte du tableau.
- "ROAS est." signifie que le ROAS est estimé (achats × panier moyen) : mentionne-le comme estimé si tu t'appuies dessus.
- Le hook rate (vues 3 s / impressions) et le hold rate (ThruPlay / impressions) n'existent que pour les vidéos ("—" = non applicable).
- Une créa avec peu de dépense n'est pas concluante : dis-le plutôt que de trancher.
- Français, ton direct et professionnel, pas d'emoji, pas de markdown.

Tu réponds avec UN SEUL objet JSON strict (aucun texte avant ou après), de la forme :
{
  "summary": ["3 à 5 phrases clés sur la performance créative du compte"],
  "winners": [{ "adId": "id du tableau", "name": "nom du tableau", "why": "pourquoi, avec chiffres" }],
  "losers": [{ "adId": "id", "name": "nom", "why": "pourquoi, avec chiffres", "action": "cut" | "iterate" | "watch" }],
  "patterns": [{ "title": "pattern (angle, hook, format, copy, landing…)", "evidence": "preuves chiffrées issues du tableau", "impact": "positive" | "negative" }],
  "hooks": [{ "hook": "type de hook ou nom de la vidéo", "verdict": "analyse du hook rate / hold rate" }],
  "recommendations": [{ "title": "action", "detail": "plan de production concret", "priority": "high" | "medium" | "low" }]
}
Contraintes : 3 à 5 winners, 3 à 5 losers, 3 à 5 patterns, 0 à 4 hooks (uniquement s'il y a des vidéos), 4 à 5 recommendations. Les adId doivent exister dans le tableau.
Sois dense et concis : chaque champ texte fait au maximum 250 caractères. Va directement à la réponse JSON.`;

const fmt = (n: number, d = 2) => (Number.isFinite(n) ? n.toFixed(d) : "—");
const clean = (s?: string) => (s ?? "").replace(/\s+/g, " ").trim();

function landingPath(url?: string): string {
  if (!url) return "—";
  try {
    const u = new URL(url);
    return (u.pathname === "/" ? u.host : u.pathname).slice(0, 60);
  } catch {
    return url.slice(0, 60);
  }
}

function renderTable(creatives: Creative[]): string {
  const header = [
    "id", "nom", "format", "statut Meta", "adset", "campagne", "spend", "impr", "CTR%", "hook%", "hold%",
    "CPA", "ROAS", "achats", "headline", "texte", "landing",
  ].join(" | ");
  const rows = creatives.map((c) => {
    const isVideo = c.format === "Video";
    return [
      c.id,
      clean(c.name).slice(0, 60),
      c.format,
      c.effectiveStatus ?? "—",
      clean(c.adsetName).slice(0, 40) || "—",
      clean(c.campaignName).slice(0, 40) || "—",
      Math.round(c.spend),
      c.impressions,
      fmt(c.ctr),
      isVideo ? fmt(c.hookRate, 1) : "—",
      isVideo ? fmt(c.holdRate, 1) : "—",
      c.cpa > 0 ? fmt(c.cpa) : "—",
      c.roas !== null && !c.roasUnavailable ? `${fmt(c.roas)}${c.roasEstimated ? " est." : ""}` : "—",
      c.conversions,
      clean(c.headline).slice(0, 80) || "—",
      clean(c.body).slice(0, 160) || "—",
      landingPath(c.landingUrl),
    ].join(" | ");
  });
  return [header, ...rows].join("\n");
}

function buildUserPrompt(creatives: Creative[], since: string, until: string, totalCount: number, meta: { currency: string | null; conversionEvent: string }): string {
  const totalSpend = creatives.reduce((s, c) => s + c.spend, 0);
  const videos = creatives.filter((c) => c.format === "Video").length;
  const estimated = creatives.some((c) => c.roasEstimated && !c.roasUnavailable);
  const unavailable = creatives.some((c) => c.roasUnavailable);
  const conv = meta.conversionEvent === "purchase" ? "achats" : meta.conversionEvent === "lead" ? "leads" : `conversions (${meta.conversionEvent})`;
  return [
    `Période : ${since} → ${until}. ${creatives.length} créas analysées (top par dépense sur ${totalCount} actives), dépense cumulée ${Math.round(totalSpend)} ${meta.currency ?? ""}, ${videos} vidéos. Les "achats" du tableau sont des ${conv}.`,
    estimated ? "Note : le compte ne remonte pas la valeur d'achat, les ROAS marqués \"est.\" sont estimés via le panier moyen." : "",
    unavailable ? "Note : aucun revenu n'est disponible pour ce compte (pas de valeur trackée ni de panier moyen) : raisonne sur le CPA, pas sur le ROAS." : "",
    "Colonnes : id | nom | format | statut Meta | adset | campagne | spend | impressions | CTR% | hook% | hold% | CPA | ROAS | achats | headline | texte (160 premiers caractères) | landing.",
    "",
    renderTable(creatives),
    "",
    "Analyse ces créas et renvoie le JSON demandé.",
  ].filter(Boolean).join("\n");
}

// ── Defensive validation ──────────────────────────────────────────────────────

const str = (v: unknown, max = 600): string => (typeof v === "string" ? v.trim().slice(0, max) : "");
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
  typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;

function normalize(raw: unknown, byId: Map<string, Creative>): Omit<CreativeAnalysis, "analyzedCount" | "generatedAt"> {
  const r = obj(raw);
  const resolveAd = (o: Record<string, unknown>) => {
    const id = str(o.adId, 40);
    const c = byId.get(id) ?? [...byId.values()].find((x) => x.name === str(o.name, 200));
    return { adId: c?.id ?? id, name: c?.name ?? str(o.name, 200) };
  };
  return {
    summary: arr(r.summary).map((s) => str(s)).filter(Boolean).slice(0, 6),
    winners: arr(r.winners).map(obj).map((o) => ({ ...resolveAd(o), why: str(o.why) })).filter((w) => w.adId && w.why).slice(0, 8),
    losers: arr(r.losers).map(obj).map((o) => ({
      ...resolveAd(o),
      why: str(o.why),
      action: oneOf(o.action, ["cut", "iterate", "watch"] as const, "watch"),
    })).filter((l) => l.adId && l.why).slice(0, 8),
    patterns: arr(r.patterns).map(obj).map((o) => ({
      title: str(o.title, 200),
      evidence: str(o.evidence),
      impact: oneOf(o.impact, ["positive", "negative"] as const, "positive"),
    })).filter((p) => p.title).slice(0, 8),
    hooks: arr(r.hooks).map(obj).map((o) => ({ hook: str(o.hook, 200), verdict: str(o.verdict) })).filter((h) => h.hook).slice(0, 6),
    recommendations: arr(r.recommendations).map(obj).map((o) => ({
      title: str(o.title, 200),
      detail: str(o.detail),
      priority: oneOf(o.priority, ["high", "medium", "low"] as const, "medium"),
    })).filter((x) => x.title).slice(0, 8),
  };
}

async function analyze(accountId: string, since: string, until: string, refresh: boolean): Promise<CreativeAnalysis> {
  const { creatives: all, meta } = await loadCreatives(accountId, { since, until }, refresh);
  const top = [...all].sort((a, b) => b.spend - a.spend).slice(0, TOP_N);
  if (top.length === 0) throw new Error("Aucune créa avec des impressions sur la période");

  const text = await relayComplete(
    {
      messages: [{ role: "user", content: buildUserPrompt(top, since, until, all.length, meta) }],
      systemPrompt: SYSTEM_PROMPT,
      allowedServers: [],
      accountScope: {},
    },
    { maxMs: 240_000 },
  );
  const parsed = parseLooseJson<unknown>(text);
  if (!parsed || typeof parsed !== "object") throw new Error("Réponse IA non exploitable (JSON invalide)");

  const byId = new Map(top.map((c) => [c.id, c]));
  const normalized = normalize(parsed, byId);
  if (normalized.summary.length === 0 && normalized.recommendations.length === 0) {
    throw new Error("Réponse IA vide");
  }
  return { ...normalized, analyzedCount: top.length, generatedAt: new Date().toISOString() };
}

export async function POST(request: NextRequest) {
  const guard = await requireSession();
  if ("error" in guard) return guard.error;

  let body: { accountId?: unknown; since?: unknown; until?: unknown; refresh?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "JSON invalide" }, { status: 400 });
  }
  const accountId = typeof body.accountId === "string" ? body.accountId : "";
  const since = typeof body.since === "string" ? body.since : "";
  const until = typeof body.until === "string" ? body.until : "";
  const refresh = body.refresh === true;
  if (!accountId) return NextResponse.json({ error: "accountId is required" }, { status: 400 });
  const validated = validateRange(since, until);
  if (!validated.ok) return NextResponse.json({ error: validated.error }, { status: 400 });

  if (guard.session.role !== "admin") {
    const allowed = await assertAccountAllowed(guard.session.userId, "meta", accountId);
    if (!allowed) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const key = `meta:creative-analysis:v1:${accountId.replace(/^act_/, "")}:${since}_${until}`;
  try {
    const result = refresh
      ? await analyze(accountId, since, until, true)
      : await cached(key, () => analyze(accountId, since, until, false), TTL_MS);
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[creatives/analyze] error:", err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
