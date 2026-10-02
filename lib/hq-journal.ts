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
      // Sent but not answered in time: HQ may have it. Another relay would write it a second time.
      if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) {
        return { ok: false, error: "HQ n'a pas répondu à temps : l'entrée a peut-être été écrite. Vérifiez le journal HQ avant de réécrire." };
      }
      lastError = e instanceof Error ? e.message : String(e);
    }
  }
  return { ok: false, error: `Écriture dans HQ impossible (${lastError})` };
}

/** The HQ projects (slug, name), as the relay lists them; null when HQ cannot be reached. */
export async function listHqProjects(): Promise<Array<{ slug: string; name: string }> | null> {
  for (const url of RELAY_URLS) {
    try {
      const res = await fetch(`${url}/api/hq/projects`, { headers: relayHeaders(), signal: AbortSignal.timeout(30000) });
      if (!res.ok) continue;
      const json = await res.json();
      return Array.isArray(json.projects) ? json.projects : [];
    } catch { /* next url */ }
  }
  return null;
}
