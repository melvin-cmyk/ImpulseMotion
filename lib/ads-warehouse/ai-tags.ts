/**
 * AI tagging of creatives (Motion's 8 categories), stored in AdCatalog.tagsJson
 * under "ai:…" keys so the existing group-by / filters / facets pick them up:
 *   ai:type (type d'asset), ai:format (format visuel), ai:audience (persona),
 *   ai:theme (thème du message), ai:season (saisonnalité), ai:offer (type
 *   d'offre), ai:hook (tactique d'accroche), ai:headline (tactique de titre).
 * The model sees the sharp thumbnail (when there is one) plus the title and
 * text; text-only ads are tagged from their copy. Runs nightly on the ads
 * that delivered recently and are not tagged yet (top spenders first), in
 * batches of a few creatives per call through the relay (vision model).
 */

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { relayComplete, parseLooseJson, type RelayMessage } from "@/lib/relay-chat";
import { recordAiUsage } from "@/lib/ai-usage";
import { upgradeImageUrl } from "@/lib/image-upgrade";

export { AI_TAG_KEYS, AI_TAG_LABELS } from "./ai-tags-labels";

const BATCH = 5;
const MAX_IMAGE_BYTES = 900_000;
const MODEL = (process.env.AI_TAGS_MODEL as "sonnet" | "opus" | "fable" | undefined) ?? "sonnet";

const SYSTEM = `Tu étiquettes des publicités (Meta, Google, TikTok) pour une agence média. Pour chaque créa, à partir du visuel et du texte, donne 8 étiquettes courtes en français (1 à 3 mots, sans ponctuation), toujours les mêmes valeurs pour les mêmes idées :
- type : UGC | Lifestyle avec texte | Lifestyle sans texte | Packshot produit | Haute production | Capture d'écran | Illustration | Texte seul | Collage | Carrousel
- format : Titre en gros | Split screen | Avant / après | Témoignage | Liste de bénéfices | Comparatif | Démo produit | Face caméra | Meme | Offre encadrée | Sans texte
- audience : la cible visible ou implicite (ex. Parents, Étudiants, Seniors, Femmes 25-34, Entreprises, Sportifs, Grand public)
- theme : le message principal (ex. Prix, Gain de temps, Réassurance, Résultats, Urgence, Nouveauté, Communauté, Qualité, Praticité)
- season : Aucune | Rentrée | Toussaint | Noël | Nouvel an | Saint-Valentin | Printemps | Été | Black Friday | Soldes | Fête des mères | Autre saison
- offer : Aucune | Remise | Code promo | Essai gratuit | Livraison offerte | Lot | Offre limitée | Inscription gratuite | Devis gratuit
- hook : Question | Affirmation forte | Problème | Preuve sociale | Curiosité | Chiffre | Avant / après | Injonction | Humour | Histoire
- headline : Bénéfice | Offre | Question | Urgence | Preuve | Nouveauté | Marque | Aucun titre
Réponds UNIQUEMENT en JSON : {"items":[{"id":"<id>","type":"…","format":"…","audience":"…","theme":"…","season":"…","offer":"…","hook":"…","headline":"…"}]}. Si une image est illisible, déduis du texte ; ne laisse jamais une valeur vide (mets "Indéterminé").`;

interface Candidate { id: string; platform: string; adId: string; thumbnailUrl: string | null; imageUrl: string | null; title: string | null; body: string | null; format: string; tagsJson: string }

async function fetchImage(url: string): Promise<{ data: string; mediaType: "image/jpeg" | "image/png" | "image/webp" } | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") ?? "";
    const mediaType = ct.includes("png") ? "image/png" : ct.includes("webp") ? "image/webp" : "image/jpeg";
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > MAX_IMAGE_BYTES) return null;
    return { data: buf.toString("base64"), mediaType };
  } catch { return null; }
}

/** Ads worth tagging: delivered in the last 30 days, not tagged yet, biggest spenders first. */
export async function aiTagCandidates(limit: number, accountIds?: string[]): Promise<Candidate[]> {
  const acc = accountIds?.length ? Prisma.sql`AND c."accountId" IN (${Prisma.join(accountIds)})` : Prisma.empty;
  return prisma.$queryRaw<Candidate[]>(Prisma.sql`
    SELECT c.id, c.platform, c."adId", c."thumbnailUrl", c."imageUrl", c.title, c.body, c.format, c."tagsJson"
    FROM "AdCatalog" c
    JOIN (SELECT platform, "adId", SUM(spend) AS spend FROM "AdDaily" WHERE date >= CURRENT_DATE - INTERVAL '30 days' GROUP BY 1, 2) d ON d.platform = c.platform AND d."adId" = c."adId"
    WHERE d.spend > 0 AND NOT (c."tagsJson"::jsonb ? 'ai:type') AND (c."thumbnailUrl" IS NOT NULL OR c."imageUrl" IS NOT NULL OR c.title IS NOT NULL OR c.body IS NOT NULL) ${acc}
    ORDER BY d.spend DESC
    LIMIT ${limit}`);
}

export interface AiTagReport { tagged: number; skipped: number; calls: number; imagesSent: number; errors: string[] }

export async function runAiTagging(opts: { limit?: number; accountIds?: string[]; deadline: number }): Promise<AiTagReport> {
  const report: AiTagReport = { tagged: 0, skipped: 0, calls: 0, imagesSent: 0, errors: [] };
  const candidates = await aiTagCandidates(opts.limit ?? 150, opts.accountIds);
  for (let i = 0; i < candidates.length; i += BATCH) {
    if (Date.now() > opts.deadline) break;
    const batch = candidates.slice(i, i + BATCH);
    const images: NonNullable<RelayMessage["images"]> = [];
    const lines: string[] = [];
    for (const c of batch) {
      const url = upgradeImageUrl(c.imageUrl ?? c.thumbnailUrl ?? undefined);
      const img = url ? await fetchImage(url) : null;
      if (img) { images.push({ ...img, name: c.id }); report.imagesSent += 1; }
      lines.push(`- id=${c.id} · format=${c.format}${img ? ` · image jointe « ${c.id} »` : " · pas d'image"}${c.title ? ` · titre: ${c.title.slice(0, 120)}` : ""}${c.body ? ` · texte: ${c.body.replace(/\s+/g, " ").slice(0, 300)}` : ""}`);
    }
    try {
      report.calls += 1;
      const text = await relayComplete(
        { messages: [{ role: "user", content: `Étiquette ces ${batch.length} créas :\n${lines.join("\n")}`, ...(images.length ? { images } : {}) }], systemPrompt: SYSTEM, allowedServers: [], accountScope: {}, model: MODEL, effort: "low", maxTurns: 1 },
        { maxMs: 90_000, onUsage: (usage) => void recordAiUsage(usage, { feature: "ai_tagging", clientName: `warehouse:${batch[0].platform}`, user: null }) },
      );
      const parsed = parseLooseJson<{ items?: Array<Record<string, string>> }>(text);
      const byId = new Map((parsed?.items ?? []).map((it) => [String(it.id), it]));
      for (const c of batch) {
        const it = byId.get(c.id);
        if (!it) { report.skipped += 1; continue; }
        let tags: Record<string, string> = {};
        try { tags = JSON.parse(c.tagsJson || "{}"); } catch { tags = {}; }
        const pick = (k: string) => String(it[k] ?? "").trim().slice(0, 40) || "Indéterminé";
        tags["ai:type"] = pick("type"); tags["ai:format"] = pick("format"); tags["ai:audience"] = pick("audience"); tags["ai:theme"] = pick("theme");
        tags["ai:season"] = pick("season"); tags["ai:offer"] = pick("offer"); tags["ai:hook"] = pick("hook"); tags["ai:headline"] = pick("headline");
        await prisma.adCatalog.update({ where: { id: c.id }, data: { tagsJson: JSON.stringify(tags) } });
        report.tagged += 1;
      }
    } catch (e) {
      report.errors.push(e instanceof Error ? e.message.slice(0, 200) : String(e));
      if (report.errors.length >= 3) break;
    }
  }
  return report;
}
