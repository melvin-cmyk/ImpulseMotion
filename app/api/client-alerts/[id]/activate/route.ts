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
import { NOISY_MESSAGES, sendingEnabled, type Backtest, type ClientSeries } from "@/lib/client-alerts/types";
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

  // A changed rule starts fresh; the same rule (validated again, or back from a pause) keeps the silence of its last message.
  const changed = hash !== alert.definitionHash;
  const state = changed
    ? { armed: true, lastTriggeredAt: null, lastCheckedAt: null, lastValue: null }
    // Back in service is what « Reprendre » does: re-armed. Validated again while in service: nothing moves.
    : alert.status === "active" ? {} : { armed: true };

  const saved = await prisma.clientAlert.update({
    where: { id: alert.id },
    data: {
      definitionJson: JSON.stringify(definition),
      definitionHash: hash,
      label: definition.label,
      // The accounts the proposal was validated against: the alert's frozen list from now on.
      accountsJson: JSON.stringify(accounts),
      ...(usable.clientName ? { clientName: usable.clientName } : {}),
      backtestJson: JSON.stringify(replay),
      backtestHash: replay.hash,
      backtestAt: new Date(),
      status: "active",
      ...state,
      consecutiveFailures: 0,
      lastNote: null,
    },
    include: { events: { orderBy: { triggeredAt: "desc" }, take: 5 } },
  });

  const notice = await deliveryNotice(session.userId);
  return NextResponse.json({
    ok: true,
    alert: toAlertView(saved, session.userId),
    backtest: replay,
    warnings: checked.warnings,
    ...(notice ? { notice } : {}),
  });
}
