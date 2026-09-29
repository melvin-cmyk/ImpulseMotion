/**
 * « J'ai vérifié » — what a person decided of an item that was to be checked.
 * For whoever has access to the routines (lib/routines/access.ts). Nothing is written on any platform here: the ad is READ.
 *
 * POST { outcome: "exists", adId }  the ad exists, here is its id. The server
 *        reads it: it must be in the ad set the item was made for. Read
 *        paused, the item is closed as created; at another status the id is
 *        kept and the item stays to be checked (the next run reads that ad
 *        again, and never creates another).
 * POST { outcome: "retry" }         nothing was created: the item leaves for
 *        one more attempt, at the next run.
 *
 * Every decision is kept in the journal of the routine (RoutineEvent,
 * `item_resolved`) with who took it.
 *
 * 409 → the item is not (or no longer) one to check; 422 → the ad is not the
 * one of this row.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireRoutinesAccess } from "@/lib/routines/access";
import { cleanMetaMessage, isMetaId, readAdById } from "@/lib/meta-write";
import { MAX_ITEM_ATTEMPTS, splitItemKey } from "@/lib/routines/types";
import { actorOf, externalIdTaken, getItem, logEvent, resolveItem, routineForSession } from "@/lib/routines/store";

const refuse = (status: number, error: string, code?: string) => NextResponse.json({ error, ...(code ? { code } : {}) }, { status });

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string; itemId: string }> }) {
  const guard = await requireRoutinesAccess();
  if ("error" in guard) return guard.error;
  const { id, itemId } = await params;
  const found = await routineForSession(guard.session, id);
  if (found.status !== 200) return refuse(found.status, found.status === 403 ? "forbidden" : "not found");
  const { routine } = found;
  if (routine.status === "archived") return refuse(409, "Cette routine est archivée.");
  if (typeof itemId !== "string" || !/^[a-z0-9]{8,40}$/i.test(itemId)) return refuse(404, "not found");
  const item = await getItem(routine.id, itemId);
  if (!item) return refuse(404, "not found");

  const body = await req.json().catch(() => null);
  const outcome = body && typeof body === "object" ? (body as { outcome?: unknown }).outcome : undefined;
  if (outcome !== "exists" && outcome !== "retry") return refuse(400, "issue inconnue : « exists » (la publicité existe) ou « retry » (rien n'a été créé)");

  const abandoned = item.status === "failed" && item.attempts >= MAX_ITEM_ATTEMPTS;
  if (item.status !== "uncertain" && !abandoned) return refuse(409, "Cette ligne n'est pas, ou n'est plus, à vérifier.", "not_to_check");
  const { adsetId, rowKey } = splitItemKey(item.itemKey);
  const actor = actorOf(guard.session);
  const from = { status: item.status, attempts: item.attempts };

  if (outcome === "retry") {
    // An item that carries the id of an ad is never sent back to creation: that ad exists, or did.
    if (item.externalId) {
      return refuse(409, `Cette ligne porte l'identifiant de la publicité ${item.externalId} : elle ne peut pas repartir en création. Si cette publicité n'existe plus, créez une nouvelle ligne avec une nouvelle clé.`, "has_external_id");
    }
    if (!(await resolveItem({ routineId: routine.id, itemId: item.id, from, outcome: "retry" }))) return refuse(409, "Cette ligne a changé entre-temps : rechargez la page.");
    await logEvent(routine.id, "item_resolved", actor, {
      definitionHash: routine.definitionHash,
      detail: `Ligne « ${rowKey} » : vérifiée, rien n'avait été créé. Elle repart pour une tentative à la prochaine exécution.`,
    });
    return NextResponse.json({ ok: true, item: { id: item.id, status: "failed" } });
  }

  const adId = (body as { adId?: unknown }).adId;
  if (!isMetaId(adId)) return refuse(400, "identifiant de publicité invalide : des chiffres seulement");
  if (item.externalId && item.externalId !== adId) {
    return refuse(422, `Cette ligne porte déjà l'identifiant de la publicité ${item.externalId} : ce n'est pas celui que vous donnez.`, "other_ad");
  }
  if (!adsetId) return refuse(422, "L'ensemble de publicités de cette ligne n'est pas connu : la publicité ne peut pas être rapprochée.", "no_adset");
  if (await externalIdTaken(routine.id, adId, item.id)) return refuse(422, `La publicité ${adId} est déjà celle d'une autre ligne de cette routine.`, "taken");

  let ad: Awaited<ReturnType<typeof readAdById>>;
  try {
    ad = await readAdById(adId);
  } catch (e) {
    return refuse(502, `La publicité n'a pas pu être relue dans Meta : ${cleanMetaMessage(e)}. Réessayez.`, "unreadable");
  }
  if (!ad) return refuse(422, `La publicité ${adId} est introuvable dans Meta.`, "not_found");
  if (ad.adsetId !== adsetId) {
    return refuse(422, `La publicité ${adId} n'est pas dans l'ensemble de publicités ${adsetId} de cette ligne : ce n'est pas la sienne.`, "other_adset");
  }

  const confirmed = ad.status === "PAUSED";
  const note = `Vérifié par une personne : la publicité ${adId} existe au statut ${ad.status}. Elle est relue à chaque exécution, jamais créée de nouveau.`;
  if (!(await resolveItem({ routineId: routine.id, itemId: item.id, from, outcome: "exists", externalId: adId, confirmed, note }))) {
    return refuse(409, "Cette ligne a changé entre-temps : rechargez la page.");
  }
  await logEvent(routine.id, "item_resolved", actor, {
    definitionHash: routine.definitionHash,
    detail: `Ligne « ${rowKey} » : vérifiée, la publicité ${adId} existe (« ${ad.name.slice(0, 120)} », statut ${ad.status}). ${confirmed ? "Ligne close." : "Elle reste à vérifier tant que la publicité n'est pas en pause."}`,
  });
  return NextResponse.json({ ok: true, item: { id: item.id, status: confirmed ? "created" : "uncertain", externalId: adId, adStatus: ad.status } });
}
