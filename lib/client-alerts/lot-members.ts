/**
 * Client alerts — the clients of a lot as they are TODAY for the person who
 * talks to the AI: their current accounts in the person's scope
 * (as usableAccounts does for one client) and their figures, read once per
 * request. Never throws for one client: a client that is gone or out of reach
 * carries `blocked`, figures that cannot be read leave `series` null.
 */

import { prisma } from "@/lib/prisma";
import { readClientSeries } from "@/lib/client-alerts/series";
import { NO_ACCESS, clientGoneText } from "@/lib/client-alerts/accounts";
import { getAccountScope, platformAccountInScope } from "@/lib/scope";
import { parseAlertAccounts } from "@/lib/auto-alerts/clients";
import type { LotMember } from "@/lib/client-alerts/lot";

/** Series read at once: the cache absorbs most of them, the platforms the rest. */
const CONCURRENCY = 4;

type SessionLike = { userId: string; role?: string | null };

export async function loadLotMembers(ids: string[], session: SessionLike, opts: { series?: boolean } = {}): Promise<LotMember[]> {
  // What usableAccounts does for one client, for all of them: one read of the clients, one of the scope.
  const [rows, scope] = await Promise.all([
    prisma.alertClient.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, gone: true, accountsJson: true } }),
    getAccountScope(session),
  ]);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const members: LotMember[] = ids.map((id) => {
    const row = byId.get(id);
    const name = row?.name ?? "Client supprimé";
    if (!row || row.gone) return { alertClientId: id, clientName: name, accounts: [], series: null, blocked: clientGoneText(name) };
    const accounts = parseAlertAccounts(row.accountsJson).filter((a) => platformAccountInScope(scope, a.platform, a.accountId));
    return accounts.length
      ? { alertClientId: id, clientName: name, accounts, series: null }
      : { alertClientId: id, clientName: name, accounts: [], series: null, blocked: NO_ACCESS };
  });
  if (opts.series === false) return members;

  let next = 0;
  const worker = async () => {
    while (next < members.length) {
      const member = members[next++];
      if (member.blocked || !member.accounts.length) continue;
      try {
        member.series = await readClientSeries(member.accounts);
      } catch (e) {
        console.error("[client-alerts] lot series unreadable", member.alertClientId, e);
        member.series = null;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, members.length) }, worker));
  return members;
}

/** Nothing can be proposed for any client of the lot: the reason, or null when one at least is usable. */
export function lotBlocked(members: LotMember[]): string | null {
  if (members.some((m) => !m.blocked)) return null;
  return "Aucun client de ce lot n'est encore accessible : cette alerte ne peut plus être vérifiée ni modifiée. Vous pouvez seulement la supprimer.";
}
