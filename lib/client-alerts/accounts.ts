/**
 * Client alerts — the accounts a proposal may use today.
 *
 * An alert freezes its accounts when it is validated (AlertDefinition.accounts):
 * a later regrouping of the client never changes an alert silently. But the
 * conversation that writes — or rewrites — an alert works on the client as it
 * is NOW: its current accounts, those the person may read. Without that, an
 * alert sent to `review` because an account left its client could never come
 * back: every new proposal would be validated against the very list that put
 * it there.
 *
 * So, for an alert made from a client (alertClientId):
 *   - the client still exists → its current accounts in the person's scope;
 *     the assistant checks, the context given to the AI and the activation all
 *     use them, and the activation stores them as the alert's new accounts;
 *   - the client is gone (the row was deleted, or none of its accounts is
 *     readable any more) → nothing can be proposed: the alert says so, and can
 *     only be deleted.
 * An alert without a client keeps the accounts it was created with.
 *
 * Also here: what the person reads when a replay has to wait for an account
 * that could not be read (replayVerdict of backtest.ts says when).
 */

import { prisma } from "@/lib/prisma";
import { getAccountScope, googleInScope, metaInScope } from "@/lib/scope";
import { parseAccounts } from "@/lib/auto-alerts/clients";
import type { AlertAccountRef } from "@/lib/client-alerts/types";

export type UsableAccounts =
  /** `clientName`: the client's name today; null for an alert without a client. */
  | { state: "ok"; accounts: AlertAccountRef[]; clientName: string | null }
  /** Nothing can be proposed; `reason` is what the person reads. */
  | { state: "gone" | "noAccess"; accounts: []; reason: string };

export const clientGoneText = (name: string) =>
  `Le client « ${name} » n'existe plus dans l'application : cette alerte ne peut plus être vérifiée ni modifiée. Vous pouvez seulement la supprimer.`;
export const NO_ACCESS = "Vous n'avez plus accès aux comptes de ce client : cette alerte ne peut pas être modifiée.";

type SessionLike = { userId: string; role?: string | null };

/** The accounts a proposal of this alert may use, for this person, today. */
export async function usableAccounts(
  alert: { alertClientId: string | null; clientName: string },
  frozen: AlertAccountRef[],
  session: SessionLike,
): Promise<UsableAccounts> {
  if (!alert.alertClientId) return { state: "ok", accounts: frozen, clientName: null };
  const client = await prisma.alertClient.findUnique({ where: { id: alert.alertClientId }, select: { name: true, gone: true, accountsJson: true } });
  if (!client || client.gone) return { state: "gone", accounts: [], reason: clientGoneText(client?.name ?? alert.clientName) };
  // Only the accounts the person may read: an alert never opens the figures of an account out of scope.
  const scope = await getAccountScope(session);
  const accounts = parseAccounts(client.accountsJson)
    .filter((a) => (a.platform === "meta" ? metaInScope(scope, a.accountId) : googleInScope(scope, a.accountId)));
  if (!accounts.length) return { state: "noAccess", accounts: [], reason: NO_ACCESS };
  return { state: "ok", accounts, clientName: client.name };
}

/** Among these clients, those an alert can no longer be checked on: the row is gone, or flagged `gone`. One query. */
export async function goneClients(ids: Array<string | null | undefined>): Promise<Set<string>> {
  const wanted = [...new Set(ids.filter((id): id is string => !!id))];
  if (!wanted.length) return new Set();
  const rows = await prisma.alertClient.findMany({ where: { id: { in: wanted } }, select: { id: true, gone: true } });
  const alive = new Set(rows.filter((r) => !r.gone).map((r) => r.id));
  return new Set(wanted.filter((id) => !alive.has(id)));
}

const PLATFORM_FR = { meta: "Meta", google: "Google Ads" } as const;

/** What the person reads when the replay has to wait for an account. */
export function unreadText(unread: AlertAccountRef[]): string {
  const names = unread.map((a) => `${PLATFORM_FR[a.platform]} « ${a.name} »`).join(", ");
  const subject = unread.length > 1 ? `Les comptes ${names} n'ont pas pu être lus` : `Le compte ${names} n'a pas pu être lu`;
  return `${subject} pour le moment : la proposition ne peut pas être vérifiée sur les 30 derniers jours. Réessayez dans quelques minutes, ou demandez une alerte qui ne porte pas sur ${unread.length > 1 ? "ces comptes" : "ce compte"}.`;
}
