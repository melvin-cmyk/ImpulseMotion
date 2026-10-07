/**
 * Pilotage — the history of a client's accounts: what was changed from
 * Pilotage (PilotAction) and what the platforms' logs say was changed by
 * anyone (PlatformChange), with the day-by-day figures of one account so the
 * page can draw the changes on the curve.
 *
 * Read only here, except the ingestion asked on demand (throttled) and the
 * note a consultant writes on a change made outside Pilotage.
 */

import { prisma } from "@/lib/prisma";
import { getAccountDailyInsightsPaged, getMetaSystemToken, purchasesFor } from "@/lib/meta-api";
import { getAccountProfileSettings } from "@/lib/account-settings";
import { relayDirectTool } from "@/lib/relay-tool";
import { extractRows } from "@/lib/dashboard-widgets";
import { getAccountScope, platformAccountInScope, type AccountScope } from "@/lib/scope";
import { HQ_PROJECT_RE, appendHqJournal } from "@/lib/hq-journal";
import { parisDay, addDays, impactWindows, IMPACT_HORIZONS, IMPACT_SETTLE_DAYS } from "@/lib/pilot/impact";
import { SOURCE_FR, type ChangeSource } from "@/lib/pilot/changes";
import { clientAccounts, syncClientOnDemand, type SyncOutcome } from "@/lib/pilot/changes-ingest";
import { listActions, type PilotActionView, type PilotImpactView, type PilotSession } from "@/lib/pilot/service";
import type { PilotValue } from "@/lib/pilot/ops";

export const HISTORY_DAYS_DEFAULT = 60;
const HISTORY_DAYS_MAX = 120;
const CHANGES_MAX = 600;

export interface PlatformChangeView {
  id: string;
  platform: string;
  accountId: string;
  alertClientId: string | null;
  currency: string;
  at: string;
  actorName: string;
  actorEmail: string | null;
  via: string;
  source: ChangeSource;
  sourceText: string;
  pilotActionId: string | null;
  objectType: string;
  objectId: string;
  objectName: string;
  eventType: string;
  field: string;
  before: PilotValue;
  after: PilotValue;
  line: string;
  significant: boolean;
  note: string;
  noteByName: string | null;
  noteAt: string | null;
  hqWrittenAt: string | null;
  hqError: string | null;
  impacts: PilotImpactView[];
}

export interface DailyPoint { day: string; spend: number; conversions: number; revenue: number | null }

export interface HistoryView {
  actions: PilotActionView[];
  changes: PlatformChangeView[];
  series: { platform: string; accountId: string; currency: string; days: number; points: DailyPoint[]; error: string | null } | null;
  sync: Array<{ platform: string; accountId: string; syncedTo: string | null; lastRunAt: string | null; lastError: string | null }>;
  synced: SyncOutcome[];
}

const parse = (json: string | null | undefined): PilotValue => {
  try { const v = JSON.parse(json ?? "null"); return typeof v === "string" || typeof v === "number" ? v : null; } catch { return null; }
};

type ChangeRow = NonNullable<Awaited<ReturnType<typeof prisma.platformChange.findUnique>>> & { impacts?: Array<NonNullable<Awaited<ReturnType<typeof prisma.pilotImpact.findUnique>>>> };

function changeImpacts(c: ChangeRow): PilotImpactView[] {
  if (!c.significant || c.pilotActionId || c.source === "impulsemotion" || !["campaign", "adset", "ad"].includes(c.objectType)) return [];
  return IMPACT_HORIZONS.map((horizon) => {
    const row = c.impacts?.find((i) => i.horizon === horizon);
    const settled = addDays(impactWindows(c.at, horizon).after.until, IMPACT_SETTLE_DAYS + 1);
    if (!row || row.status === "failed") return { horizon, status: "pending", verdict: "", summary: "", computedAt: null, dueOn: settled, hqWritten: false, result: null };
    let result: unknown = null;
    try { result = JSON.parse(row.resultJson); } catch { result = null; }
    return { horizon, status: row.status, verdict: row.verdict, summary: row.summary, computedAt: row.computedAt.toISOString(), dueOn: null, hqWritten: !!row.hqWrittenAt, result };
  });
}

export function toChangeView(c: ChangeRow): PlatformChangeView {
  return {
    id: c.id, platform: c.platform, accountId: c.accountId, alertClientId: c.alertClientId, currency: c.currency, at: c.at.toISOString(),
    actorName: c.actorName, actorEmail: c.actorEmail, via: c.via, source: c.source as ChangeSource, sourceText: SOURCE_FR[c.source as ChangeSource] ?? c.source,
    pilotActionId: c.pilotActionId, objectType: c.objectType, objectId: c.objectId, objectName: c.objectName, eventType: c.eventType, field: c.field,
    before: parse(c.beforeJson), after: parse(c.afterJson), line: c.line, significant: c.significant,
    note: c.note, noteByName: c.noteByName, noteAt: c.noteAt?.toISOString() ?? null, hqWrittenAt: c.hqWrittenAt?.toISOString() ?? null, hqError: c.hqError,
    impacts: changeImpacts(c),
  };
}

// ── Daily figures ─────────────────────────────────────────────────────────

const n = (v: unknown) => (typeof v === "number" ? v : parseFloat(String(v ?? "0"))) || 0;

async function metaDaily(accountId: string, since: string, until: string): Promise<DailyPoint[]> {
  const settings = await getAccountProfileSettings("meta", accountId);
  const res = await getAccountDailyInsightsPaged(getMetaSystemToken(), accountId, { since, until }, { max: 400 });
  return res.data.map((r) => {
    const conversions = purchasesFor(r, settings.conversionEvent);
    const values = (r.action_values ?? []).find((a) => a.action_type === (settings.conversionEvent ?? "purchase")) ?? (r.action_values ?? []).find((a) => a.action_type === "purchase");
    const revenue = values ? n(values.value) : settings.aov ? conversions * settings.aov : null;
    return { day: r.date_start, spend: n(r.spend), conversions, revenue };
  }).sort((a, b) => a.day.localeCompare(b.day));
}

async function googleDaily(customer: string, since: string, until: string): Promise<DailyPoint[]> {
  const query = `SELECT segments.date, metrics.cost_micros, metrics.conversions, metrics.conversions_value FROM customer WHERE segments.date BETWEEN '${since}' AND '${until}' ORDER BY segments.date`;
  const rows = extractRows(await relayDirectTool("mcp-google-ads.Custom_GAQL_Query", { input: JSON.stringify({ customer_id: customer, gaql_query: query }) }, 30_000));
  return rows.map((r) => {
    const m = (r.metrics ?? {}) as Record<string, unknown>;
    const s = (r.segments ?? {}) as Record<string, unknown>;
    const value = n(m.conversionsValue ?? m.conversions_value);
    return { day: String(s.date ?? ""), spend: n(m.costMicros ?? m.cost_micros) / 1_000_000, conversions: n(m.conversions), revenue: value > 0 ? value : null };
  }).filter((p) => /^\d{4}-\d{2}-\d{2}$/.test(p.day)).sort((a, b) => a.day.localeCompare(b.day));
}

/** Every day of the period, zero when the platform gave nothing for it. */
function fillDays(points: DailyPoint[], since: string, until: string): DailyPoint[] {
  const by = new Map(points.map((p) => [p.day, p]));
  const out: DailyPoint[] = [];
  for (let d = since; d <= until; d = addDays(d, 1)) out.push(by.get(d) ?? { day: d, spend: 0, conversions: 0, revenue: null });
  return out;
}

export async function dailySeries(platform: string, accountId: string, currency: string, days: number, now: Date = new Date()): Promise<HistoryView["series"]> {
  const until = parisDay(now);
  const since = addDays(until, -(days - 1));
  try {
    const points = platform === "meta" ? await metaDaily(accountId, since, until) : await googleDaily(accountId, since, until);
    return { platform, accountId, currency, days, points: fillDays(points, since, until), error: null };
  } catch (e) {
    return { platform, accountId, currency, days, points: [], error: (e instanceof Error ? e.message : String(e)).slice(0, 200) };
  }
}

// ── The history of a client ───────────────────────────────────────────────

export async function clientHistory(session: PilotSession, input: {
  alertClientIds: string[];
  /** The account whose curve is drawn; null = no curve. */
  focus: { platform: string; accountId: string } | null;
  days?: number;
  /** Read the platforms' logs now when they are stale (the page opening). */
  refresh?: boolean;
}, now: Date = new Date()): Promise<HistoryView> {
  const days = Math.min(Math.max(input.days ?? HISTORY_DAYS_DEFAULT, 7), HISTORY_DAYS_MAX);
  const scope = await getAccountScope(session);
  const clients = await prisma.alertClient.findMany({ where: { id: { in: input.alertClientIds }, gone: false }, select: { id: true, accountsJson: true } });
  const accounts = clients.flatMap(clientAccounts).filter((a) => platformAccountInScope(scope, a.platform, a.accountId));
  const focus = input.focus && accounts.find((a) => a.platform === input.focus!.platform && a.accountId === input.focus!.accountId) ? input.focus : null;

  let synced: SyncOutcome[] = [];
  if (input.refresh) {
    for (const client of clients) {
      try { synced = synced.concat(await syncClientOnDemand(client, focus, 20_000, now)); } catch (e) { console.error("[pilot] on-demand ingest failed", e); }
    }
  }

  const since = new Date(now.getTime() - days * 86_400_000);
  const [actionsLists, changeRows, syncRows, series] = await Promise.all([
    Promise.all(input.alertClientIds.map((id) => listActions(session, { alertClientId: id, take: 100 }))),
    accounts.length ? prisma.platformChange.findMany({
      where: { OR: accounts.map((a) => ({ platform: a.platform, accountId: a.accountId })), at: { gte: since } },
      include: { impacts: true }, orderBy: { at: "desc" }, take: CHANGES_MAX,
    }) : Promise.resolve([]),
    accounts.length ? prisma.platformChangeSync.findMany({ where: { OR: accounts.map((a) => ({ platform: a.platform, accountId: a.accountId })) } }) : Promise.resolve([]),
    focus ? dailySeries(focus.platform, focus.accountId, accounts.find((a) => a.platform === focus.platform && a.accountId === focus.accountId)?.currency ?? "EUR", days, now) : Promise.resolve(null),
  ]);
  return {
    actions: actionsLists.flat().filter((a) => a.status !== "draft" && a.status !== "expired" || a.mine).sort((a, b) => (b.executedAt ?? b.createdAt).localeCompare(a.executedAt ?? a.createdAt)),
    changes: changeRows.map(toChangeView),
    series,
    sync: syncRows.map((s) => ({ platform: s.platform, accountId: s.accountId, syncedTo: s.syncedTo?.toISOString() ?? null, lastRunAt: s.lastRunAt?.toISOString() ?? null, lastError: s.lastError })),
    synced,
  };
}

// ── The note of a consultant on a change made outside Pilotage ───────────

async function changeInScope(scope: AccountScope, id: string) {
  const change = await prisma.platformChange.findUnique({ where: { id }, include: { impacts: true } });
  if (!change || !platformAccountInScope(scope, change.platform, change.accountId)) return null;
  return change;
}

/** Writes why a change was made (by whoever), signed by the consultant, then in the client's HQ journal. */
export async function noteChange(session: PilotSession, id: string, note: unknown): Promise<{ ok: true; change: PlatformChangeView } | { ok: false; status: number; error: string }> {
  const text = typeof note === "string" ? note.trim().slice(0, 1000) : "";
  const scope = await getAccountScope(session);
  const change = await changeInScope(scope, id);
  if (!change) return { ok: false, status: 404, error: "Modification introuvable." };
  if (change.pilotActionId) return { ok: false, status: 409, error: "Cette modification vient du Pilotage : son pourquoi est sur l'action." };
  const user = await prisma.user.findUnique({ where: { id: session.userId }, select: { name: true, email: true } });
  const name = (user?.name ?? session.user?.name ?? "").trim() || user?.email || session.user?.email || "Consultant";
  const client = change.alertClientId ? await prisma.alertClient.findUnique({ where: { id: change.alertClientId }, select: { name: true, hqSlug: true, dashboardId: true } }) : null;
  let hqProject = change.hqProject ?? client?.hqSlug ?? null;
  if (!hqProject && client?.dashboardId) hqProject = (await prisma.dashboard.findUnique({ where: { id: client.dashboardId }, select: { hqSlug: true } }))?.hqSlug ?? null;

  const updated = await prisma.platformChange.update({
    where: { id },
    data: { note: text, noteById: session.userId, noteByName: name, noteAt: text ? new Date() : null, hqProject, hqWrittenAt: null, hqError: null },
    include: { impacts: true },
  });
  if (text && hqProject && HQ_PROJECT_RE.test(hqProject)) {
    const when = change.at.toLocaleString("fr-FR", { timeZone: "Europe/Paris", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
    const content = [
      `## Modification ${change.platform === "meta" ? "Meta" : "Google Ads"} hors ImpulseMotion — ${client?.name ?? ""}`,
      "",
      `Faite par ${change.actorName} (${SOURCE_FR[change.source as ChangeSource] ?? change.source}, via ${change.via}) le ${when}, lue dans le journal de la plateforme.`,
      "",
      "### Changement",
      `- ${change.line}`,
      "",
      `**Pourquoi** (expliqué par ${name} le ${new Date().toLocaleDateString("fr-FR", { timeZone: "Europe/Paris" })}) : ${text}`,
      "",
      "---",
      `_Consigné par ImpulseMotion, modification ${change.id}._`,
    ].join("\n");
    const written = await appendHqJournal({ project: hqProject, slug: `pilotage-externe-${parisDay(change.at)}-${change.id.slice(-8)}`, content });
    const row = await prisma.platformChange.update({ where: { id }, data: written.ok ? { hqWrittenAt: new Date(), hqError: null } : { hqError: written.error }, include: { impacts: true } });
    return { ok: true, change: toChangeView(row) };
  }
  if (text && !hqProject) {
    const row = await prisma.platformChange.update({ where: { id }, data: { hqError: "Pas de dossier HQ pour ce client : note gardée ici seulement." }, include: { impacts: true } });
    return { ok: true, change: toChangeView(row) };
  }
  return { ok: true, change: toChangeView(updated) };
}
