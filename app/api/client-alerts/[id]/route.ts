/**
 * One client alert — staff only. An alert belongs to the person who created
 * it; a real admin may read, pause and delete everyone's, nothing more.
 *
 * GET    → the alert with its last 30 triggers ({ alert })
 * PATCH  → { action: "pause" | "resume" }
 *          pause  : active → paused (the creator or a real admin)
 *          resume : paused or error → active, by the creator only, and only if
 *                   the replay still covers the definition (backtestHash =
 *                   definitionHash). Resuming re-arms the alert; the silence
 *                   of its last message continues. Refused from `review`
 *                   (the way out is a new validation in the conversation)
 *                   and when the client is gone (only deleting is left).
 * DELETE → deletes the alert and its triggers (the creator or a real admin).
 *          The alert that holds the conversation of a lot takes the whole lot
 *          with it; another alert of a lot leaves the lot (the next validation
 *          of the lot no longer puts it back); with one client left, the
 *          conversation becomes an ordinary alert again.
 *
 * The definition itself changes in one place only: the conversation, then
 * POST /api/client-alerts/[id]/activate.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireStaff } from "@/lib/auth-helpers";
import { definitionHash } from "@/lib/client-alerts/evaluate";
import { clientGoneText, goneClients } from "@/lib/client-alerts/accounts";
import { readDefinition } from "@/lib/client-alerts/types";
import { readLot } from "@/lib/client-alerts/lot";
import { ALERT_NOT_FOUND, OWNER_ONLY, alertAccess, toAlertView } from "@/components/client-alerts/alert-model";

const NO_STORE = { "Cache-Control": "no-store" };
const EVENTS = 30;
const NOT_FOUND = () => NextResponse.json({ error: ALERT_NOT_FOUND }, { status: 404 });
const conflict = (error: string) => NextResponse.json({ error }, { status: 409 });

type Ctx = { params: Promise<{ id: string }> };
type Session = { userId: string; baseRole?: string | null };

const withEvents = { events: { orderBy: { triggeredAt: "desc" as const }, take: EVENTS } };

/** The alert and what the session may do with it; an alert of someone else does not exist for a consultant. */
async function load(id: string, session: Session) {
  const alert = await prisma.clientAlert.findUnique({ where: { id }, include: withEvents });
  const access = alert ? alertAccess(session, alert) : null;
  return alert && access ? { alert, access } : null;
}

/** The client the alert was made from no longer exists, or has no readable account left. */
async function isGone(alert: { alertClientId: string | null }): Promise<boolean> {
  return !!alert.alertClientId && (await goneClients([alert.alertClientId])).has(alert.alertClientId);
}

export async function GET(_req: NextRequest, { params }: Ctx) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const found = await load((await params).id, guard.session);
  if (!found) return NOT_FOUND();
  return NextResponse.json({ alert: toAlertView(found.alert, guard.session.userId, { clientGone: await isGone(found.alert) }) }, { headers: NO_STORE });
}

export async function PATCH(req: NextRequest, { params }: Ctx) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const found = await load((await params).id, guard.session);
  if (!found) return NOT_FOUND();
  const { alert, access } = found;

  const body = await req.json().catch(() => null);
  const action = body && typeof body === "object" ? body.action : undefined;
  if (action !== "pause" && action !== "resume") {
    return NextResponse.json({ error: "Action inconnue." }, { status: 400 });
  }

  if (action === "pause") {
    // The status is part of the condition: a check that paused it meanwhile is not undone.
    const done = await prisma.clientAlert.updateMany({ where: { id: alert.id, status: "active" }, data: { status: "paused" } });
    if (!done.count) return conflict("Seule une alerte en service peut être mise en pause.");
  } else {
    if (access !== "owner") return NextResponse.json({ error: OWNER_ONLY }, { status: 403 });
    if (alert.status === "review") return conflict("Cette alerte est à revoir : ouvrez sa conversation et validez-la de nouveau.");
    if (alert.status !== "paused" && alert.status !== "error") return conflict("Seule une alerte en pause ou en erreur peut être reprise.");
    // It would go to « À revoir » at the next pass, with nothing left to review.
    if (await isGone(alert)) return conflict(clientGoneText(alert.clientName));
    const definition = readDefinition(alert.definitionJson);
    if (!definition) return conflict("Cette alerte n'a pas encore de règle validée : ouvrez sa conversation pour la terminer.");
    // The replay vouches for one definition, the one stored: anything else goes through a validation again.
    let hash: string | null = null;
    try { hash = definitionHash(definition); } catch { hash = null; }
    if (!alert.definitionHash || alert.backtestHash !== alert.definitionHash || hash !== alert.definitionHash) {
      return conflict("La règle a changé depuis sa dernière vérification sur 30 jours : ouvrez la conversation et validez-la de nouveau.");
    }
    const done = await prisma.clientAlert.updateMany({
      where: { id: alert.id, status: { in: ["paused", "error"] }, definitionHash: alert.definitionHash },
      data: { status: "active", armed: true, consecutiveFailures: 0, lastNote: null },
    });
    if (!done.count) return conflict("L'alerte a changé d'état entre-temps : rechargez la page.");
  }

  const fresh = await prisma.clientAlert.findUnique({ where: { id: alert.id }, include: withEvents });
  return NextResponse.json({ ok: true, alert: toAlertView(fresh ?? alert, guard.session.userId, { clientGone: await isGone(alert) }) });
}

export async function DELETE(_req: NextRequest, { params }: Ctx) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const found = await load((await params).id, guard.session);
  if (!found) return NOT_FOUND();
  const { alert } = found;
  // The triggers go with it (cascade). deleteMany: deleting twice is not an error.
  if (alert.groupId && alert.groupId === alert.id) {
    // The conversation of a lot: nothing could change the other alerts of the lot any more — they go with it.
    const done = await prisma.clientAlert.deleteMany({ where: { OR: [{ id: alert.id }, { groupId: alert.id }] } });
    return NextResponse.json({ ok: true, deleted: done.count });
  }
  if (!alert.groupId || !alert.alertClientId) {
    await prisma.clientAlert.deleteMany({ where: { id: alert.id } });
    return NextResponse.json({ ok: true, deleted: 1 });
  }
  const { groupId, alertClientId } = alert;
  await prisma.$transaction(async (tx) => {
    await tx.clientAlert.deleteMany({ where: { id: alert.id } });
    const lead = await tx.clientAlert.findUnique({ where: { id: groupId }, select: { id: true, groupJson: true } });
    if (!lead) return;
    const rest = readLot(lead.groupJson).filter((id) => id !== alertClientId);
    // One client left: the conversation is an ordinary alert again, not a lot of one.
    await tx.clientAlert.update({
      where: { id: lead.id },
      data: rest.length > 1 ? { groupJson: JSON.stringify(rest) } : { groupJson: "[]", groupId: null, groupPlatforms: "" },
    });
  });
  return NextResponse.json({ ok: true, deleted: 1 });
}
