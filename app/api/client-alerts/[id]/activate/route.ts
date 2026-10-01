/**
 * Puts an alert in service — staff only, and only the person who created it.
 *
 * POST { proposal, confirmNoisy? } → { ok, alert, backtest, notice? }
 *
 * Nothing sent is trusted. `proposal` is what the card showed, and it is
 * treated like the AI's own text: validated again against the accounts the
 * client has TODAY and the person may read (lib/client-alerts/accounts.ts —
 * names and currencies come from them), the series are read again and the
 * replay over the last 30 days is run again with the code the cron runs. Only
 * what comes out of that is stored, with those accounts as the alert's new
 * frozen list: it is how an alert sent to `review` comes back in service on
 * accounts that exist.
 *
 * A rule that changed starts fresh: when the hash of the definition differs
 * from the one stored, the alert is re-armed and its last trigger forgotten
 * (the silence that followed a message of the OLD rule says nothing of the new
 * one). The same rule validated again keeps its silence.
 *
 * An alert that would have sent more than NOISY_MESSAGES messages in 30 days
 * is stored only with `confirmNoisy: true` — otherwise 409 { needsConfirm,
 * backtest }, and the card asks the consultant.
 *
 * A lot (lib/client-alerts/lot.ts): the same steps, client by client. Every
 * client that takes the rule gets its own alert in service (the lead for its
 * own client, the others created or updated with groupId = the lead's id);
 * the answer lists what each client gave (`lot`). A client that cannot take
 * it is left out; its alert, if it had one, goes to « À revoir » — unless the
 * reason is only that its figures cannot be read right now. `platforms` (the
 * platforms the card said, or none for all) is read as the AI's own block.
 *
 * Activating does not wait for Slack: when the person is not found in Slack,
 * or sending is switched off, the alert is recorded all the same and the
 * answer says what is missing (`notice`).
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireStaff } from "@/lib/auth-helpers";
import { readClientSeries } from "@/lib/client-alerts/series";
import { backtest, replayVerdict } from "@/lib/client-alerts/backtest";
import { definitionHash } from "@/lib/client-alerts/evaluate";
import { dmConfigured, slackIdentityOf } from "@/lib/client-alerts/slack-dm";
import { validateAlertProposal } from "@/lib/client-alerts/validate";
import { unreadText, usableAccounts } from "@/lib/client-alerts/accounts";
import { NOISY_MESSAGES, sendingEnabled, type AlertAccountRef, type AlertDefinition, type Backtest, type ClientSeries } from "@/lib/client-alerts/types";
import { checkLot, isLotLead, lotPlatforms, lotRefusal, readLot, type LotAccepted } from "@/lib/client-alerts/lot";
import { loadLotMembers, lotBlocked } from "@/lib/client-alerts/lot-members";
import { ALERT_NOT_FOUND, OWNER_ONLY, alertAccess, readAccounts, toAlertView } from "@/components/client-alerts/alert-model";

// Reading the series of several accounts can take a while when the cache is cold.
export const maxDuration = 120;

type Params = { params: Promise<{ id: string }> };

/** What stands between a recorded alert and a message in Slack, in words; null when nothing does. */
async function deliveryNotice(userId: string): Promise<string | null> {
  const missing: string[] = [];
  if (!sendingEnabled()) {
    missing.push("Mode d'essai : les déclenchements sont enregistrés ici, rien n'est encore envoyé dans Slack.");
  } else {
    let configured = false;
    try { configured = dmConfigured(); } catch { configured = false; }
    if (!configured) missing.push("L'envoi des messages privés Slack n'est pas encore branché.");
  }
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, slackEmail: true, slackUserId: true, slackCheckedAt: true },
    });
    const identity = user ? slackIdentityOf(user) : null;
    if (identity?.status !== "found") missing.push("Votre compte Slack n'a pas encore été trouvé : indiquez votre adresse Slack en haut de la page pour recevoir les messages.");
  } catch {
    missing.push("Votre compte Slack n'a pas pu être vérifié : faites-le en haut de la page pour recevoir les messages.");
  }
  return missing.length ? `L'alerte est enregistrée dans l'application. ${missing.join(" ")}` : null;
}

export async function POST(req: NextRequest, { params }: Params) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { session } = guard;
  const { id } = await params;

  const alert = await prisma.clientAlert.findUnique({ where: { id } });
  const access = alert ? alertAccess(session, alert) : null;
  if (!alert || !access) return NextResponse.json({ error: ALERT_NOT_FOUND }, { status: 404 });
  if (access !== "owner") return NextResponse.json({ error: OWNER_ONLY }, { status: 403 });

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object" || !body.proposal || typeof body.proposal !== "object") {
    return NextResponse.json({ error: "Aucune proposition à valider." }, { status: 400 });
  }

  if (isLotLead(alert)) return activateLot(alert, body, session);

  const usable = await usableAccounts(alert, readAccounts(alert.accountsJson), session);
  if (usable.state !== "ok") return NextResponse.json({ error: usable.reason }, { status: 409 });
  const accounts = usable.accounts;
  let series: ClientSeries;
  try {
    series = await readClientSeries(accounts);
  } catch (e) {
    console.error("[client-alerts] series unreadable", e);
    return NextResponse.json({ error: "Les chiffres du client n'ont pas pu être lus : l'alerte n'a pas été enregistrée. Réessayez dans quelques minutes." }, { status: 503 });
  }

  const checked = validateAlertProposal(body.proposal, { accounts, series });
  if (!checked.ok) return NextResponse.json({ error: "Cette proposition ne peut pas être validée.", errors: checked.errors, hints: checked.hints }, { status: 422 });
  const definition = checked.value;


  let replay: Backtest;
  let hash: string;
  try {
    replay = backtest(definition, series);
    hash = definitionHash(definition);
  } catch (e) {
    console.error("[client-alerts] backtest failed", e);
    return NextResponse.json({ error: "La vérification sur les 30 derniers jours a échoué : l'alerte n'a pas été enregistrée. Réessayez dans quelques minutes." }, { status: 500 });
  }
  // A replay that judged (almost) nothing vouches for nothing: wait for the account, or refuse the rule.
  const verdict = replayVerdict(definition, series, replay);
  if (verdict.kind === "wait") return NextResponse.json({ error: `${unreadText(verdict.unread)} L'alerte n'a pas été enregistrée.` }, { status: 503 });
  if (verdict.kind === "refused") {
    return NextResponse.json({ error: "Cette proposition ne peut pas être validée.", errors: [verdict.error], hints: [verdict.hint] }, { status: 422 });
  }
  // The cron only runs an alert whose replay vouches for its definition.
  if (!hash || replay.hash !== hash) {
    return NextResponse.json({ error: "La vérification sur les 30 derniers jours ne correspond pas à cette alerte : elle n'a pas été enregistrée. Redemandez la proposition." }, { status: 500 });
  }

  if (replay.messages.length > NOISY_MESSAGES && body.confirmNoisy !== true) {
    return NextResponse.json({
      error: `Cette alerte aurait envoyé ${replay.messages.length} messages en ${replay.days} jours : confirmez pour la mettre en service.`,
      needsConfirm: true, backtest: replay,
    }, { status: 409 });
  }

  const saved = await putInService(alert, { definition, hash, replay, clientName: usable.clientName, accounts });

  const notice = await deliveryNotice(session.userId);
  return NextResponse.json({
    ok: true,
    alert: toAlertView(saved, session.userId),
    backtest: replay,
    warnings: checked.warnings,
    ...(notice ? { notice } : {}),
  });
}

/** What putting an alert in service writes; the same for one client and for each client of a lot. */
function serviceData(
  alert: { definitionHash: string; status: string },
  input: { definition: AlertDefinition; hash: string; replay: Backtest; clientName: string | null; accounts: AlertAccountRef[] },
) {
  const { definition, hash, replay } = input;
  // A changed rule starts fresh; the same rule (validated again, or back from a pause) keeps the silence of its last message.
  const changed = hash !== alert.definitionHash;
  const state = changed
    ? { armed: true, lastTriggeredAt: null, lastCheckedAt: null, lastValue: null }
    // Back in service is what « Reprendre » does: re-armed. Validated again while in service: nothing moves.
    : alert.status === "active" ? {} : { armed: true };
  return {
    definitionJson: JSON.stringify(definition),
    definitionHash: hash,
    label: definition.label,
    // The accounts the proposal was validated against: the alert's frozen list from now on.
    accountsJson: JSON.stringify(input.accounts),
    ...(input.clientName ? { clientName: input.clientName } : {}),
    backtestJson: JSON.stringify(replay),
    backtestHash: replay.hash,
    backtestAt: new Date(),
    status: "active",
    ...state,
    consecutiveFailures: 0,
    lastNote: null,
  };
}

const WITH_EVENTS = { events: { orderBy: { triggeredAt: "desc" as const }, take: 5 } };

function putInService(
  alert: { id: string; definitionHash: string; status: string },
  input: { definition: AlertDefinition; hash: string; replay: Backtest; clientName: string | null; accounts: AlertAccountRef[] },
) {
  return prisma.clientAlert.update({ where: { id: alert.id }, data: serviceData(alert, input), include: WITH_EVENTS });
}

type Session = { userId: string; role?: string | null; baseRole?: string | null; user?: { email?: string | null } | null };
type LeadRow = NonNullable<Awaited<ReturnType<typeof prisma.clientAlert.findUnique>>>;

/** The rule on every client of the lot; one alert in service per client that takes it. */
async function activateLot(lead: LeadRow, body: Record<string, unknown>, session: Session) {
  const ids = readLot(lead.groupJson);
  const members = await loadLotMembers(ids, session);
  const blocked = lotBlocked(members);
  if (blocked) return NextResponse.json({ error: blocked }, { status: 409 });

  // The platforms the card showed, read like the AI's block; the accounts are each client's own.
  const platforms = Array.isArray(body.platforms) ? lotPlatforms(body.platforms.map((platform) => ({ platform }))) : null;
  const proposal = body.proposal as Record<string, unknown>;
  const rule = { ...proposal, accounts: platforms ? platforms.map((platform) => ({ platform })) : undefined };
  const { lot, accepted } = checkLot(rule, members, unreadText);

  if (!accepted.length) {
    const refusal = lotRefusal(lot);
    return NextResponse.json(
      { error: refusal.retry ? "Aucun client du lot n'a pu être vérifié pour le moment : rien n'a été enregistré. Réessayez dans quelques minutes." : "Cette proposition ne peut être validée pour aucun client du lot.", errors: refusal.errors, hints: refusal.hints, lot },
      { status: refusal.retry ? 503 : 422 },
    );
  }

  // The cron only runs an alert whose replay vouches for its definition.
  const proven: Array<LotAccepted & { hash: string }> = [];
  for (const a of accepted) {
    let hash = "";
    try { hash = definitionHash(a.definition); } catch (e) { console.error("[client-alerts] lot hash failed", e); }
    if (!hash || a.backtest.hash !== hash) {
      return NextResponse.json({ error: `La vérification sur les 30 derniers jours ne correspond pas à l'alerte de ${a.member.clientName} : rien n'a été enregistré. Redemandez la proposition.` }, { status: 500 });
    }
    proven.push({ ...a, hash });
  }

  const noisy = proven.filter((a) => a.backtest.messages.length > NOISY_MESSAGES);
  if (noisy.length && body.confirmNoisy !== true) {
    const loudest = noisy.reduce((x, y) => (y.backtest.messages.length > x.backtest.messages.length ? y : x));
    return NextResponse.json({
      error: `Pour ${noisy.map((a) => a.member.clientName).join(", ")}, cette alerte aurait envoyé jusqu'à ${loudest.backtest.messages.length} messages en ${loudest.backtest.days} jours : confirmez pour la mettre en service.`,
      needsConfirm: true, backtest: loudest.backtest, noisyClients: noisy.map((a) => a.member.clientName), lot,
    }, { status: 409 });
  }

  const existing = await prisma.clientAlert.findMany({ where: { groupId: lead.id, NOT: { id: lead.id } } });
  const rowOf = (clientId: string) => (clientId === lead.alertClientId ? lead : existing.find((r) => r.alertClientId === clientId) ?? null);

  const saved = await prisma.$transaction(async (tx) => {
    const out = [];
    for (const a of proven) {
      const row = rowOf(a.member.alertClientId);
      const input = { definition: a.definition, hash: a.hash, replay: a.backtest, clientName: a.member.clientName, accounts: a.member.accounts };
      out.push(row
        ? await tx.clientAlert.update({ where: { id: row.id }, data: { ...serviceData(row, input), groupId: lead.id }, include: WITH_EVENTS })
        : await tx.clientAlert.create({
          data: {
            createdById: lead.createdById, createdByEmail: lead.createdByEmail,
            alertClientId: a.member.alertClientId, groupId: lead.id,
            ...serviceData({ definitionHash: "", status: "draft" }, input),
          },
          include: WITH_EVENTS,
        }));
    }
    // A client the new rule cannot be put on no longer runs the old one — unless its figures are only unreadable for now.
    for (const c of lot.clients) {
      if (c.ok || c.retry) continue;
      const row = rowOf(c.alertClientId);
      if (!row || row.status === "draft" || row.status === "review") continue;
      await tx.clientAlert.update({
        where: { id: row.id },
        data: { status: "review", lastNote: `La nouvelle règle du lot n'a pas pu s'appliquer à ce client : ${c.error ?? "non vérifiable"}` },
      });
    }
    return out;
  });

  const leadSaved = saved.find((r) => r.id === lead.id)
    ?? await prisma.clientAlert.findUnique({ where: { id: lead.id }, include: WITH_EVENTS })
    ?? { ...lead, events: [] };
  const left = lot.clients.filter((c) => !c.ok);
  const notice = await deliveryNotice(session.userId);
  return NextResponse.json({
    ok: true,
    alert: toAlertView(leadSaved, session.userId),
    alerts: saved.map((r) => toAlertView(r, session.userId)),
    backtest: proven[0].backtest,
    warnings: proven[0].warnings,
    lot,
    ...(left.length ? { skipped: left.map((c) => `${c.clientName} : ${c.error ?? "non vérifiable"}`) } : {}),
    ...(notice ? { notice } : {}),
  });
}
