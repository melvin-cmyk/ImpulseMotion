/**
 * Client alerts — the clients of a lot as they are TODAY for the person who
 * talks to the AI: their current accounts in the person's scope
 * (usableAccounts, as for one client) and their figures, read once per
 * request. Never throws for one client: a client that is gone or out of reach
 * carries `blocked`, figures that cannot be read leave `series` null.
 */

import { prisma } from "@/lib/prisma";
import { readClientSeries } from "@/lib/client-alerts/series";
import { usableAccounts } from "@/lib/client-alerts/accounts";
import type { LotMember } from "@/lib/client-alerts/lot";

/** Series read at once: the cache absorbs most of them, the platforms the rest. */
const CONCURRENCY = 4;

type SessionLike = { userId: string; role?: string | null };

export async function loadLotMembers(ids: string[], session: SessionLike, opts: { series?: boolean } = {}): Promise<LotMember[]> {
  const rows = await prisma.alertClient.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
  const names = new Map(rows.map((r) => [r.id, r.name]));
  const members: LotMember[] = [];
  for (const id of ids) {
    const name = names.get(id) ?? "Client supprimé";
    const usable = await usableAccounts({ alertClientId: id, clientName: name }, [], session);
    members.push(usable.state === "ok"
      ? { alertClientId: id, clientName: usable.clientName ?? name, accounts: usable.accounts, series: null }
      : { alertClientId: id, clientName: name, accounts: [], series: null, blocked: usable.reason });
  }
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
