/**
 * One dated entry appended to the journal of a client's HQ project, written by
 * the relay with its own HQ bearer (POST /api/hq/journal → hq_project_journal_append).
 * Never edits nor replaces: HQ keeps every entry. The briefs cached on the
 * client's dashboards are then read again, so the next report knows of it.
 */

import { prisma } from "@/lib/prisma";
import { RELAY_URLS } from "@/lib/relay-server";
import { relayHeaders } from "@/lib/relay-headers";

export const HQ_PROJECT_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;

export async function appendHqJournal(args: { project: string; slug: string; content: string }): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!HQ_PROJECT_RE.test(args.project)) return { ok: false, error: "Dossier HQ invalide." };
  let lastError = "relay indisponible";
  for (const url of RELAY_URLS) {
    try {
      const res = await fetch(`${url}/api/hq/journal`, {
        method: "POST",
        headers: relayHeaders(),
        body: JSON.stringify({ project: args.project, slug: args.slug, content: args.content }),
        signal: AbortSignal.timeout(45000),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { lastError = json.error ?? `relay ${res.status}`; continue; }
      // Cached briefs predate this entry: force a fresh read next time.
      await prisma.dashboard.updateMany({ where: { hqSlug: args.project }, data: { hqContextAt: null } }).catch(() => {});
      return { ok: true };
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
  }
  return { ok: false, error: `Écriture dans HQ impossible (${lastError})` };
}
