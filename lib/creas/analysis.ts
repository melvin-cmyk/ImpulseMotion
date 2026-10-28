/**
 * The AI reading of a template: hook, structure, text zones, style, palette,
 * CTA, why it works, and a brief to reproduce it for another brand. One
 * vision call through the relay (Sonnet, low), no tool. Never throws: an
 * empty analysis when the model or the relay fails.
 */

import { parseLooseJson, relayComplete, type RelayImage } from "@/lib/relay-chat";
import { recordAiUsage } from "@/lib/ai-usage";
import { parseAnalysis, type TemplateAnalysis } from "@/lib/creas/model";

const MODEL = (process.env.AI_CREAS_MODEL as "sonnet" | "opus" | undefined) ?? "sonnet";

const SYSTEM = `Tu es directeur artistique dans une agence de publicité digitale. On te montre une publicité (image, parfois son titre et son texte). Tu la décris comme un TEMPLATE réutilisable pour une autre marque.
Réponds UNIQUEMENT par un objet JSON, sans texte autour :
{
  "hook": "l'accroche visuelle en une ligne (ex. « avant / après », « produit géant sur fond uni », « témoignage client en UGC »)",
  "structure": "la mise en page dans l'ordre de lecture, en une à trois phrases (où sont le titre, le visuel, le prix, le bouton…)",
  "textZones": [{ "role": "titre | sous-titre | prix | promo | bouton | mention | badge", "text": "le texte lu dans l'image" }],
  "style": "photo / 3D / flat / UGC / typographique…, l'ambiance, la lumière, le cadrage",
  "palette": ["#hex ou nom", "…"],
  "cta": "le bouton ou l'appel à l'action, s'il y en a un",
  "whyItWorks": "pourquoi cette pub fonctionne, en 2 ou 3 lignes (mécanique d'attention, promesse, preuve)",
  "brief": "un brief de 5 à 8 lignes pour REPRODUIRE ce template pour une autre marque : ce qu'on garde (composition, hiérarchie, style), ce qu'on remplace (produit, couleurs de marque, textes), les zones de texte à prévoir"
}
Écris en français. Si un élément est absent, mets une chaîne vide ou une liste vide. N'invente pas de texte que l'image ne montre pas.`;

export async function analyseTemplate(input: { image: RelayImage | null; title?: string | null; body?: string | null; brand?: string | null; user: { id: string; email: string | null; role: string } | null }): Promise<TemplateAnalysis> {
  const lines = [
    input.brand ? `Marque / annonceur : ${input.brand}` : "",
    input.title ? `Titre de l'annonce : ${input.title.slice(0, 200)}` : "",
    input.body ? `Texte de l'annonce : ${input.body.replace(/\s+/g, " ").slice(0, 600)}` : "",
    input.image ? "L'image de la publicité est jointe." : "Pas d'image : décris le template d'après le texte seulement.",
  ].filter(Boolean);
  try {
    const text = await relayComplete(
      { messages: [{ role: "user", content: `Décris ce template.\n${lines.join("\n")}`, ...(input.image ? { images: [input.image] } : {}) }], systemPrompt: SYSTEM, allowedServers: [], accountScope: {}, model: MODEL, effort: "low", maxTurns: 1 },
      { maxMs: 90_000, onUsage: (usage) => void recordAiUsage(usage, { feature: "creas_template", clientName: input.brand ?? "—", user: input.user }) },
    );
    const parsed = parseLooseJson<Record<string, unknown>>(text);
    return parseAnalysis(parsed ? JSON.stringify(parsed) : null);
  } catch (e) {
    console.error("[creas] analyse du template impossible", e instanceof Error ? e.message : e);
    return parseAnalysis(null);
  }
}
