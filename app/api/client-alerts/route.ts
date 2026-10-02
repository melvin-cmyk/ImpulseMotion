/**
 * Client alerts — staff only. An alert belongs to the person who created it.
 *
 * GET  → { alerts, clients, clientsError?, slack: { configured, identity }, sending, viewer }
 *        alerts  : mine, newest first, each with its last 5 triggers
 *                  (?all=1 for a real admin: everyone's, with the creator's e-mail)
 *        clients : the clients the session may see, to pick from
 *        slack   : whether private messages are plugged, and who the viewer is in Slack
 *        sending : false = test mode, triggers are recorded and nothing goes to Slack
 * POST → { alertClientId } → creates a draft for that client ({ alert }).
 *        The client must be in the session's scope; the accounts are copied
 *        on the alert, which never follows a later regrouping of the client.
 *        { alertClientIds: [...] } with several clients → the draft of a lot
 *        (lib/client-alerts/lot.ts): one conversation, made for the first
 *        client, that holds the clients of the lot; every client must be in
 *        the session's scope, at most LOT_MAX_CLIENTS.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireStaff } from "@/lib/auth-helpers";
import { getAccountScope, platformAccountInScope } from "@/lib/scope";
import { loadAlertClients, parseAlertAccounts } from "@/lib/auto-alerts/clients";
import { dmConfigured, slackIdentityOf } from "@/lib/client-alerts/slack-dm";
import { goneClients } from "@/lib/client-alerts/accounts";
import { sendingEnabled, type SlackIdentity } from "@/lib/client-alerts/types";
import { toAlertView, type ClientOption } from "@/components/client-alerts/alert-model";
import { LOT_MAX_CLIENTS, readClientIds, readLot } from "@/lib/client-alerts/lot";

const NO_STORE = { "Cache-Control": "no-store" };
const LIST_MAX = 300;
const EVENTS_IN_LIST = 5;

export async function GET(req: NextRequest) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { session } = guard;
  const realAdmin = session.baseRole === "admin";
  // Everyone's alerts are for a real admin only: the parameter is ignored for anyone else.
  const all = realAdmin && new URL(req.url).searchParams.get("all") === "1";

  const scope = await getAccountScope(session);
  const [rows, listed, user] = await Promise.all([
    prisma.clientAlert.findMany({
      where: all ? {} : { createdById: session.userId },
      orderBy: { createdAt: "desc" },
      take: LIST_MAX,
      include: { events: { orderBy: { triggeredAt: "desc" }, take: EVENTS_IN_LIST } },
    }),
    // The alerts already created stay readable when the list of clients cannot be built.
    loadAlertClients(scope)
      .then((clients) => ({ clients, failed: false }))
      // The cause is for the logs: the page only says the list could not be read.
      .catch((e) => { console.error("[client-alerts] clients unreadable", e); return { clients: [], failed: true }; }),
    prisma.user.findUnique({
      where: { id: session.userId },
      select: { email: true, slackEmail: true, slackUserId: true, slackCheckedAt: true },
    }),
  ]);

  let identity: SlackIdentity | null = null;
  try { identity = user ? slackIdentityOf(user) : null; } catch { identity = null; }
  let configured = false;
  try { configured = dmConfigured(); } catch { configured = false; }

  const options: ClientOption[] = listed.clients.map((c) => ({ id: c.id, name: c.name, accounts: c.accounts, dormant: c.dormant }));
  // An alert whose client is gone says so in the list, and only offers to be deleted.
  const gone = await goneClients(rows.map((r) => r.alertClientId));
  return NextResponse.json({
    alerts: rows.map((r) => toAlertView(r, session.userId, { clientGone: !!r.alertClientId && gone.has(r.alertClientId) })),
    clients: options,
    ...(listed.failed ? { clientsError: true } : {}),
    slack: { configured, identity },
    sending: sendingEnabled(),
    viewer: { userId: session.userId, realAdmin },
  }, { headers: NO_STORE });
}

export async function POST(req: NextRequest) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { session } = guard;

  const body = await req.json().catch(() => null);
  const ids = readClientIds(body);
  if (!ids) return NextResponse.json({ error: "Choisissez un client." }, { status: 400 });
  if (ids.length > 1) return createLot(ids, session);
  const alertClientId = ids[0];

  const client = await prisma.alertClient.findUnique({
    where: { id: alertClientId },
    select: { id: true, name: true, accountsJson: true, gone: true },
  });
  if (!client || client.gone) return NextResponse.json({ error: "Client introuvable." }, { status: 404 });

  // Only the accounts the person may read are copied: an alert never opens the figures of an account out of scope.
  const scope = await getAccountScope(session);
  const accounts = parseAlertAccounts(client.accountsJson)
    .filter((a) => platformAccountInScope(scope, a.platform, a.accountId));
  if (!accounts.length) return NextResponse.json({ error: "Vous n'avez pas accès aux comptes de ce client." }, { status: 403 });

  // A draft opened for this client and left without a word is taken up again rather than piled up.
  const untouched = await prisma.clientAlert.findFirst({
    where: { createdById: session.userId, alertClientId: client.id, groupJson: "[]", status: "draft", chatJson: "{}", definitionJson: "{}" },
    orderBy: { createdAt: "desc" },
  });
  const accountsJson = JSON.stringify(accounts);
  if (untouched) {
    const current = untouched.accountsJson === accountsJson && untouched.clientName === client.name
      ? untouched
      : await prisma.clientAlert.update({ where: { id: untouched.id }, data: { accountsJson, clientName: client.name } });
    return NextResponse.json({ ok: true, alert: toAlertView({ ...current, events: [] }, session.userId), reused: true });
  }

  const alert = await prisma.clientAlert.create({
    data: {
      createdById: session.userId,
      createdByEmail: session.user?.email ?? null,
      alertClientId: client.id,
      clientName: client.name,
      accountsJson,
    },
  });
  return NextResponse.json({ ok: true, alert: toAlertView({ ...alert, events: [] }, session.userId) }, { status: 201 });
}

type Session = { userId: string; role?: string | null; user?: { email?: string | null } | null };

/** The draft of a lot: the conversation, made for the first client, holds every client of the lot. */
async function createLot(ids: string[], session: Session) {
  if (ids.length > LOT_MAX_CLIENTS) {
    return NextResponse.json({ error: `${LOT_MAX_CLIENTS} clients au plus par alerte groupée : retirez-en ${ids.length - LOT_MAX_CLIENTS}.` }, { status: 400 });
  }
  const rows = await prisma.alertClient.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, accountsJson: true, gone: true } });
  const byId = new Map(rows.map((r) => [r.id, r]));
  const missing = ids.filter((id) => { const r = byId.get(id); return !r || r.gone; });
  if (missing.length) return NextResponse.json({ error: missing.length > 1 ? `${missing.length} clients choisis sont introuvables.` : "Un client choisi est introuvable." }, { status: 404 });

  // Every client of the lot must be readable by the person: the lot never opens the figures of an account out of scope.
  const scope = await getAccountScope(session);
  const accountsOf = (id: string) => parseAlertAccounts(byId.get(id)!.accountsJson).filter((a) => platformAccountInScope(scope, a.platform, a.accountId));
  const denied = ids.filter((id) => !accountsOf(id).length).map((id) => byId.get(id)!.name);
  if (denied.length) return NextResponse.json({ error: `Vous n'avez pas accès aux comptes de : ${denied.join(", ")}.` }, { status: 403 });

  const first = byId.get(ids[0])!;
  // The same clients opened and left without a word (in any order) are taken up again rather than piled up, as they are today.
  const sameSet = (json: string) => { const lot = readLot(json); return lot.length === ids.length && ids.every((id) => lot.includes(id)); };
  const drafts = await prisma.clientAlert.findMany({
    where: { createdById: session.userId, NOT: { groupJson: "[]" }, status: "draft", chatJson: "{}", definitionJson: "{}" },
    orderBy: { createdAt: "desc" }, take: 20, select: { id: true, groupJson: true },
  });
  const untouched = drafts.find((d) => sameSet(d.groupJson));
  if (untouched) {
    const alert = await prisma.clientAlert.update({
      where: { id: untouched.id },
      data: { alertClientId: first.id, clientName: first.name, accountsJson: JSON.stringify(accountsOf(first.id)), groupJson: JSON.stringify(ids) },
    });
    return NextResponse.json({ ok: true, alert: toAlertView({ ...alert, events: [] }, session.userId), reused: true });
  }

  const alert = await prisma.$transaction(async (tx) => {
    const created = await tx.clientAlert.create({
      data: {
        createdById: session.userId,
        createdByEmail: session.user?.email ?? null,
        alertClientId: first.id,
        clientName: first.name,
        accountsJson: JSON.stringify(accountsOf(first.id)),
        groupJson: JSON.stringify(ids),
      },
    });
    return tx.clientAlert.update({ where: { id: created.id }, data: { groupId: created.id } });
  });
  return NextResponse.json({ ok: true, alert: toAlertView({ ...alert, events: [] }, session.userId) }, { status: 201 });
}
