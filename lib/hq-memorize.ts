/**
 * « Mémoriser dans HQ » : résume une conversation staff ↔ IA en une note datée
 * (constats, décisions, questions ouvertes) et l'ajoute au journal du projet
 * HQ du client. Deux étapes déterministes :
 *   1. un appel IA one-shot sans outil produit la note (Markdown) ;
 *   2. le relay l'écrit dans HQ avec son propre jeton (POST /api/hq/journal).
 * Les briefs HQ mis en cache sur les dashboards du client sont invalidés pour
 * que la prochaine lecture (rapport, copilote) tienne compte de la note.
 */

import { prisma } from "@/lib/prisma";
import { relayComplete } from "@/lib/relay-chat";
import { RELAY_URLS } from "@/lib/relay-server";
import { relayHeaders } from "@/lib/relay-headers";
import { HQ_CONTEXT_PROFILE } from "@/lib/ai-profiles";
import { recordAiUsage, type UsageContext } from "@/lib/ai-usage";

const MAX_MESSAGES = 40;
const MAX_CHARS = 12_000;
export const HQ_PROJECT_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;

const SUMMARY_PROMPT = `Tu rédiges une note de journal pour la mémoire de l'agence (HQ) à partir d'une conversation entre un consultant et son assistant IA au sujet d'un client.
Écris en français, en Markdown, 250 mots maximum, avec exactement ces sections (omets une section vide) :
## Constats
(faits et chiffres établis dans la conversation, avec périodes et sources ; pas d'hypothèses)
## Décisions et actions
(ce qui a été décidé, appliqué ou planifié — qui, quoi, quand si connu)
## Questions ouvertes
(ce qui reste à vérifier ou à arbitrer)
Ne reformule pas la conversation, ne mentionne pas l'outil ni l'assistant, n'invente rien. Réponds avec la note seule, sans préambule.`;

export function buildTranscript(raw: unknown): string {
  const list: unknown[] = Array.isArray(raw) ? raw.slice(-MAX_MESSAGES) : [];
  return list
    .map((m) => {
      const role = (m as Record<string, unknown>)?.role;
      const content = (m as Record<string, unknown>)?.content;
      if ((role !== "user" && role !== "assistant") || typeof content !== "string") return null;
      const clean = content
        .replace(/```action[\s\S]*?```/g, "[proposition de widget]")
        .replace(/^\[Résultat des propositions précédentes[^\]]*\]\n\n/, "")
        .replace(/\n\n\[Fichiers déposés dans [^\]]*\]$/, "")
        .trim();
      return clean ? `${role === "user" ? "Consultant" : "Assistant"} : ${clean}` : null;
    })
    .filter(Boolean)
    .join("\n\n")
    .slice(-MAX_CHARS);
}

export type MemorizeResult =
  | { ok: true; note: string; project: string }
  | { ok: false; status: number; error: string; note?: string };

export async function memorizeToHq(args: {
  transcript: string;
  project: string;
  clientLabel: string;
  author: string;
  origin: string;
  usage: UsageContext;
}): Promise<MemorizeResult> {
  if (args.transcript.length < 80) return { ok: false, status: 400, error: "Conversation trop courte pour en tirer une note." };
  if (!HQ_PROJECT_RE.test(args.project)) return { ok: false, status: 400, error: "Dossier HQ invalide." };

  let note: string;
  try {
    note = (await relayComplete(
      {
        messages: [{ role: "user", content: `Client : ${args.clientLabel} (dossier HQ projects/${args.project}).\n\nCONVERSATION :\n${args.transcript}` }],
        systemPrompt: SUMMARY_PROMPT,
        allowedServers: [],
        model: HQ_CONTEXT_PROFILE.model,
        effort: HQ_CONTEXT_PROFILE.effort,
        maxTurns: 1,
      },
      { maxMs: 90_000, onUsage: (usage) => { void recordAiUsage(usage, args.usage); } },
    )).trim();
  } catch (e) {
    return { ok: false, status: 502, error: `Résumé impossible (${e instanceof Error ? e.message : String(e)})` };
  }
  if (!note) return { ok: false, status: 502, error: "Résumé vide" };

  const content = `${note}\n\n---\n_Note issue de ${args.origin}, consignée par ${args.author}._`;
  const slug = `ia-${new Date().toISOString().slice(0, 10)}`;

  let lastError = "relay indisponible";
  for (const url of RELAY_URLS) {
    try {
      const res = await fetch(`${url}/api/hq/journal`, {
        method: "POST",
        headers: relayHeaders(),
        body: JSON.stringify({ project: args.project, slug, content }),
        signal: AbortSignal.timeout(45000),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { lastError = json.error ?? `relay ${res.status}`; continue; }
      // Cached briefs predate this note: force a fresh read next time.
      await prisma.dashboard.updateMany({ where: { hqSlug: args.project }, data: { hqContextAt: null } }).catch(() => {});
      return { ok: true, note, project: args.project };
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
  }
  return { ok: false, status: 502, error: `Écriture dans HQ impossible (${lastError})`, note };
}
