import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-helpers";
import { relayHeaders } from "@/lib/relay-headers";

export const maxDuration = 120;

import { RELAY_URLS } from "@/lib/relay-server";

const SYSTEM_PROMPT = `Tu es un consultant média senior expert en performance cross-platform (Meta Ads + Google Ads). À partir d'un snapshot JSON des données client sur les 30 derniers jours, identifie le ROAS potentiel atteignable et les leviers concrets pour y arriver.

Contraintes STRICTES :
- En français
- Réponds en JSON valide uniquement (pas de markdown, pas de prose autour), schéma :
  {
    "currentRoas": number,        // ROAS combiné actuel (Meta + Google), tiré directement de la donnée
    "potentialRoas": number,      // ROAS atteignable réaliste à 30j si on applique les leviers
    "rationale": string,          // 1-2 phrases qui expliquent comment on passe de current à potential
    "levers": [                   // 3 à 6 leviers, ordonnés du plus impactant au moins
      {
        "title": string,          // verbe à l'impératif + objet précis, ex: "Pause keyword 'meal delivery'"
        "platform": "meta" | "google" | "cross",
        "impactEur": number,      // gain mensuel estimé en € (positif = revenue, négatif = saving)
        "effort": "low" | "medium" | "high",
        "detail": string          // 1-2 phrases : pourquoi, et quoi faire précisément
      }
    ]
  }
- Cite TOUJOURS un nom (créa, keyword, campagne, search term) si pertinent — pas de "optimiser les enchères" générique
- Si une plateforme manque dans les données, n'invente pas — produis quand même un plan sur ce que tu as
- Si la donnée est trop maigre pour conclure, mets currentRoas/potentialRoas à 0 et explique dans rationale
- N'appelle aucun tool — toutes les infos sont dans le message utilisateur`;

interface PlanLever {
  title: string;
  platform: "meta" | "google" | "cross";
  impactEur: number;
  effort: "low" | "medium" | "high";
  detail: string;
}
interface PlanResponse {
  currentRoas: number;
  potentialRoas: number;
  rationale: string;
  levers: PlanLever[];
}

interface RelayStreamEvent { type: string; text?: string; message?: string }

async function callRelayJson(userMessage: string): Promise<PlanResponse> {
  const headers = relayHeaders();
  const body = JSON.stringify({
    messages: [{ role: "user", content: userMessage }],
    systemPrompt: SYSTEM_PROMPT,
    allowedServers: [],
    accountScope: {},
  });

  const errors: string[] = [];
  for (const url of RELAY_URLS) {
    const isLocalhost = url.includes("localhost");
    const timeout = isLocalhost ? 3000 : 100000;
    try {
      const res = await fetch(`${url}/api/chat`, {
        method: "POST", headers, body, signal: AbortSignal.timeout(timeout),
      });
      if (!res.ok) { errors.push(`${url}: HTTP ${res.status}`); continue; }
      if (!res.body) { errors.push(`${url}: empty body`); continue; }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let fullText = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const t = line.trim();
          if (!t.startsWith("data:")) continue;
          const payload = t.slice(5).trim();
          if (!payload) continue;
          try {
            const evt = JSON.parse(payload) as RelayStreamEvent;
            if (evt.type === "delta" && evt.text) fullText += evt.text;
            else if (evt.type === "content" && evt.text && !fullText) fullText = evt.text;
          } catch { /* ignore parse errors on event boundary */ }
        }
      }

      // Strip code fences if present
      const cleaned = fullText.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
      try {
        return JSON.parse(cleaned) as PlanResponse;
      } catch {
        // Try to find a JSON object in the response
        const m = cleaned.match(/\{[\s\S]*\}/);
        if (m) return JSON.parse(m[0]) as PlanResponse;
        errors.push(`${url}: non-JSON response`);
        continue;
      }
    } catch (e) {
      errors.push(`${url}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  throw new Error(`Relay unreachable — ${errors.join(" · ")}`);
}

export async function POST(req: NextRequest) {
  const guard = await requireSession();
  if ("error" in guard) return guard.error;

  const body = (await req.json().catch(() => null)) as { context?: unknown } | null;
  if (!body?.context) {
    return NextResponse.json({ error: "context required" }, { status: 400 });
  }

  try {
    const plan = await callRelayJson(
      `Voici le snapshot client (JSON, 30 derniers jours) :\n${JSON.stringify(body.context, null, 2)}`,
    );
    return NextResponse.json(plan);
  } catch (e) {
    const message = e instanceof Error ? e.message : "plan generation failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
