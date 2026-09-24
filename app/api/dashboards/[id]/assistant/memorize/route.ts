/**
 * « Mémoriser dans HQ » (copilote, staff only) : résume les conclusions de la
 * conversation en une note datée et l'ajoute au journal du projet HQ du
 * client (projects/{hqSlug}/journal/). Deux étapes déterministes :
 *   1. un appel IA one-shot sans outil produit la note (Markdown) ;
 *   2. le relay l'écrit dans HQ avec son propre jeton (POST /api/hq/journal).
 * Le brief HQ mis en cache sur le dashboard est invalidé pour que la
 * prochaine lecture (rapport, copilote) tienne compte de la note.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireStaff } from "@/lib/auth-helpers";
import { denyIfDashboardOutOfScope } from "@/lib/dashboard-auth";
import { relayComplete } from "@/lib/relay-chat";
import { RELAY_URLS } from "@/lib/relay-server";
import { relayHeaders } from "@/lib/relay-headers";
import { HQ_CONTEXT_PROFILE } from "@/lib/ai-profiles";
import { recordAiUsage, type UsageContext } from "@/lib/ai-usage";

export const maxDuration = 120;

const MAX_MESSAGES = 40;
const MAX_CHARS = 12_000;

const SUMMARY_PROMPT = `Tu rédiges une note de journal pour la mémoire de l'agence (HQ) à partir d'une conversation entre un consultant et son copilote IA au sujet d'un client.
Écris en français, en Markdown, 250 mots maximum, avec exactement ces sections (omets une section vide) :
## Constats
(faits et chiffres établis dans la conversation, avec périodes et sources ; pas d'hypothèses)
## Décisions et actions
(ce qui a été décidé, appliqué au dashboard ou planifié — qui, quoi, quand si connu)
## Questions ouvertes
(ce qui reste à vérifier ou à arbitrer)
Ne reformule pas la conversation, ne mentionne pas l'outil ni le copilote, n'invente rien. Réponds avec la note seule, sans préambule.`;

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { id } = await params;
  const denied = await denyIfDashboardOutOfScope(guard.session, id);
  if (denied) return denied;

  const dashboard = await prisma.dashboard.findUnique({ where: { id }, select: { id: true, name: true, hqSlug: true } });
  if (!dashboard) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (!dashboard.hqSlug) {
    return NextResponse.json({ error: "Ce dashboard n'est rattaché à aucun dossier HQ (réglages du dashboard → dossier HQ)." }, { status: 409 });
  }

  const body = await req.json().catch(() => ({}));
  const raw: unknown[] = Array.isArray(body.messages) ? body.messages.slice(-MAX_MESSAGES) : [];
  const transcript = raw
    .map((m) => {
      const role = (m as Record<string, unknown>)?.role;
      const content = (m as Record<string, unknown>)?.content;
      if ((role !== "user" && role !== "assistant") || typeof content !== "string") return null;
      const clean = content
        .replace(/```action[\s\S]*?```/g, "[proposition de widget]")
        .replace(/^\[Résultat des propositions précédentes[^\]]*\]\n\n/, "")
        .trim();
      return clean ? `${role === "user" ? "Consultant" : "Copilote"} : ${clean}` : null;
    })
    .filter(Boolean)
    .join("\n\n")
    .slice(-MAX_CHARS);
  if (transcript.length < 80) return NextResponse.json({ error: "Conversation trop courte pour en tirer une note." }, { status: 400 });

  const usageCtx: UsageContext = {
    feature: "copilot_memorize",
    dashboardId: dashboard.id,
    clientName: dashboard.name,
    user: { id: guard.session.userId, email: guard.session.user?.email, role: guard.session.role },
  };
  let note: string;
  try {
    note = (await relayComplete(
      {
        messages: [{ role: "user", content: `Client : ${dashboard.name} (dossier HQ projects/${dashboard.hqSlug}).\n\nCONVERSATION :\n${transcript}` }],
        systemPrompt: SUMMARY_PROMPT,
        allowedServers: [],
        model: HQ_CONTEXT_PROFILE.model,
        effort: HQ_CONTEXT_PROFILE.effort,
        maxTurns: 1,
      },
      { maxMs: 90_000, onUsage: (usage) => { void recordAiUsage(usage, usageCtx); } },
    )).trim();
  } catch (e) {
    return NextResponse.json({ error: `Résumé impossible (${e instanceof Error ? e.message : String(e)})` }, { status: 502 });
  }
  if (!note) return NextResponse.json({ error: "Résumé vide" }, { status: 502 });

  const author = guard.session.user?.email ?? guard.session.userId;
  const content = `${note}\n\n---\n_Note issue du copilote ImpulseMotion (dashboard « ${dashboard.name} »), consignée par ${author}._`;
  const slug = `copilote-${new Date().toISOString().slice(0, 10)}`;

  let lastError = "relay indisponible";
  for (const url of RELAY_URLS) {
    try {
      const res = await fetch(`${url}/api/hq/journal`, {
        method: "POST",
        headers: relayHeaders(),
        body: JSON.stringify({ project: dashboard.hqSlug, slug, content }),
        signal: AbortSignal.timeout(45000),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { lastError = json.error ?? `relay ${res.status}`; continue; }
      // The cached brief predates this note: force a fresh read next time.
      await prisma.dashboard.update({ where: { id: dashboard.id }, data: { hqContextAt: null } }).catch(() => {});
      return NextResponse.json({ ok: true, note, project: dashboard.hqSlug });
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
  }
  return NextResponse.json({ error: `Écriture dans HQ impossible (${lastError})`, note }, { status: 502 });
}
