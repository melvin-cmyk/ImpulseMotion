/**
 * Pilotage — which platform changes were made by the agency itself.
 *
 * Google names the actor by email (user_email of the change event): anyone
 * at @impulse-analytics.com is the agency. Meta only gives a display name
 * (« Pierre Ayel »), so it is matched against the staff accounts of the
 * tool: the name, and the tokens of the email local part (pierre.ayel →
 * Pierre Ayel). A single-word staff name (« Victoire ») matches an actor
 * whose first name is that word. AGENCY_ACTOR_NAMES adds names that have
 * no account here. Pure: no I/O.
 */

import { groupSessions, type ChangeLike } from "@/lib/pilot/changes";

export const AGENCY_EMAIL_DOMAIN = "impulse-analytics.com";

export interface StaffPerson { name: string | null; email: string | null }

const tokensOf = (s: string): string[] =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1);

export type AgencyMatcher = (actorName: string, actorEmail: string | null) => boolean;

/** Builds the matcher once from the staff list (and the optional env list). */
export function agencyMatcher(staff: StaffPerson[], extraNames: string | undefined = process.env.AGENCY_ACTOR_NAMES): AgencyMatcher {
  const fullNames = new Set<string>();
  const firstNames = new Set<string>();
  const add = (tokens: string[]) => {
    if (!tokens.length) return;
    if (tokens.length === 1) firstNames.add(tokens[0]);
    else fullNames.add(tokens.join(" "));
  };
  for (const p of staff) {
    if (p.name) add(tokensOf(p.name));
    const local = p.email?.toLowerCase().endsWith(`@${AGENCY_EMAIL_DOMAIN}`) ? p.email.split("@")[0] : null;
    if (local && !/^(bot|data|admin|contact|hello|no-?reply)$/.test(local)) add(tokensOf(local));
  }
  for (const n of (extraNames ?? "").split(",")) add(tokensOf(n));

  return (actorName, actorEmail) => {
    if (actorEmail && actorEmail.toLowerCase().endsWith(`@${AGENCY_EMAIL_DOMAIN}`)) return true;
    const t = tokensOf(actorName);
    if (!t.length) return false;
    if (t.length >= 2 && fullNames.has(`${t[0]} ${t[t.length - 1]}`)) return true;
    if (t.length >= 2 && fullNames.has(t.join(" "))) return true;
    // A bare first name: only when the actor is a person with that first name (not a tool name like « Bulk Actions »).
    if (firstNames.has(t[0]) && !/^(bulk|conversion|meta|google|system|api)$/.test(t[0])) return true;
    return false;
  };
}

// ── Report entries ───────────────────────────────────────────────────────

export interface AgencyChange extends ChangeLike {
  objectType: string;
  objectName: string;
  field: string;
  line: string;
  note: string;
  significant: boolean;
  accountName?: string | null;
  impact?: { horizon: number; verdict: string; summary: string } | null;
}

export interface ReportAction {
  at: string;
  author: string;
  platform: string;
  account: string;
  /** pilotage = done from the tool; plateforme = done directly on Meta / Google by someone at the agency. */
  origin: "pilotage" | "plateforme";
  lines: string[];
  why: string;
  verdict: string | null;
  /** The measured effect, one paragraph, when a J+7 / J+14 review exists. */
  effect: string | null;
}

export const REPORT_SESSION_LINES = 8;

/** Changes by the agency, outside Pilotage, grouped into sessions (one person, one sitting) the way a report tells them. */
export function agencyChangesToActions(changes: AgencyChange[], verdictFr: Record<string, string>): ReportAction[] {
  const sessions = groupSessions(changes.filter((c) => !c.pilotActionId && c.source === "external"));
  return sessions.map((s): ReportAction => {
    const first = s[s.length - 1];
    // Budgets, statuses, bids and targeting first; renames and ad-level toggles after, so a cut keeps what matters.
    const ordered = [...s].reverse().sort((a, b) => Number(b.significant) - Number(a.significant));
    const lines = dedupe(ordered.map((c) => c.line).filter(Boolean));
    const notes = dedupe(s.map((c) => c.note.trim()).filter(Boolean));
    const judged = s.map((c) => c.impact).filter((i): i is NonNullable<AgencyChange["impact"]> => !!i && !!i.verdict && i.verdict !== "skipped")
      .sort((a, b) => b.horizon - a.horizon)[0] ?? null;
    return {
      at: new Date(first.at).toISOString().slice(0, 10),
      author: first.actorName,
      platform: first.platform,
      account: first.accountName || first.accountId,
      origin: "plateforme" as const,
      lines: lines.length > REPORT_SESSION_LINES ? [...lines.slice(0, REPORT_SESSION_LINES), `… et ${lines.length - REPORT_SESSION_LINES} autres modifications`] : lines,
      why: notes.join(" · "),
      verdict: judged ? `J+${judged.horizon} ${verdictFr[judged.verdict] ?? judged.verdict}` : null,
      effect: judged?.summary || null,
    };
  }).filter((a) => a.lines.length);
}

function dedupe(items: string[]): string[] {
  const seen = new Set<string>();
  return items.filter((i) => (seen.has(i) ? false : (seen.add(i), true)));
}
