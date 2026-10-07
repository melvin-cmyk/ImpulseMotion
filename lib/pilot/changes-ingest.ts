/**
 * Pilotage — reads the platforms' own change logs into PlatformChange rows.
 *
 *   Meta       GET /act_X/activities since the last read (first read: the last
 *              LOOKBACK_DAYS), newest first, capped — no id on an activity, so
 *              a hash of it is the key, and a row read twice is not written twice.
 *   Google Ads GAQL on change_event through the relay (the same door as the
 *              dashboards); the log is kept 30 days by Google, so a first read
 *              starts there. Each event becomes one row per changed field.
 *
 * Every row is then matched with the Pilotage operations sent on the same
 * object around the same time: those are « ImpulseMotion » changes, shown once
 * (the action card), judged once (the action's analyses). The rest is what
 * someone else did, on Ads Manager, Google Ads, a rule or a script.
 *
 * Two entry points: one account on demand (the page opening, throttled), and
 * every account of the agency in the daily pass (cron pilot-impact), oldest
 * read first, within a time budget — what is left waits for the next day.
 */

import { prisma } from "@/lib/prisma";
import { getMetaSystemToken, metaGraphGetAll } from "@/lib/meta-api";
import { relayDirectTool } from "@/lib/relay-tool";
import { extractRows } from "@/lib/dashboard-widgets";
import { parseAlertAccounts } from "@/lib/auto-alerts/clients";
import { metaAccountDigits } from "@/lib/routines/accounts";
import { normGoogle } from "@/lib/portfolio";
import { fromGoogleChangeEvent, fromMetaActivity, type ChangeDraft, type GoogleChangeRow, type MetaActivity } from "@/lib/pilot/changes";

/** A first read goes back this far (Google keeps 30 days; Meta more, but the recent weeks are what matters). */
export const LOOKBACK_DAYS = 28;
/** A read is not repeated within this long when the page asks for it. */
export const ON_DEMAND_MIN_INTERVAL_MS = 10 * 60 * 1000;
const META_MAX_ROWS = 2000;
const GOOGLE_MAX_ROWS = 3000;
/** A Pilotage operation sent within this long of a logged change, on the same object, is that change. */
const MATCH_WINDOW_MS = 30 * 60 * 1000;
const GAQL_TIMEOUT_MS = 40_000;

export interface SyncOutcome { platform: string; accountId: string; read: number; written: number; error: string | null; truncated: boolean }

export type Account = { platform: "meta" | "google"; accountId: string; currency: string; alertClientId: string | null };

const fmtGoogle = (d: Date) => d.toISOString().replace("T", " ").slice(0, 19);

async function readMeta(accountId: string, currency: string, since: Date, until: Date): Promise<{ drafts: ChangeDraft[]; truncated: boolean }> {
  const res = await metaGraphGetAll<MetaActivity>(`/act_${accountId}/activities`, getMetaSystemToken(), {
    fields: "event_type,event_time,object_type,object_name,object_id,actor_name,actor_id,application_name,extra_data",
    since: String(Math.floor(since.getTime() / 1000)),
    until: String(Math.ceil(until.getTime() / 1000)),
    limit: "500",
  }, META_MAX_ROWS);
  const drafts = res.data.map((a) => fromMetaActivity(accountId, currency, a)).filter((d): d is ChangeDraft => !!d);
  return { drafts, truncated: res.truncated };
}

async function readGoogle(customerId: string, currency: string, since: Date, until: Date): Promise<{ drafts: ChangeDraft[]; truncated: boolean }> {
  const query = `SELECT change_event.resource_name, change_event.change_date_time, change_event.change_resource_type, change_event.change_resource_name,
      change_event.resource_change_operation, change_event.changed_fields, change_event.user_email, change_event.client_type,
      change_event.old_resource, change_event.new_resource, campaign.id, campaign.name, ad_group.id, ad_group.name
    FROM change_event
    WHERE change_event.change_date_time >= '${fmtGoogle(since)}' AND change_event.change_date_time <= '${fmtGoogle(until)}'
    ORDER BY change_event.change_date_time DESC LIMIT ${GOOGLE_MAX_ROWS}`.replace(/\s+/g, " ");
  const rows = extractRows(await relayDirectTool("mcp-google-ads.Custom_GAQL_Query", { input: JSON.stringify({ customer_id: customerId, gaql_query: query }) }, GAQL_TIMEOUT_MS)) as GoogleChangeRow[];
  const drafts = rows.flatMap((r) => fromGoogleChangeEvent(customerId, currency, r));
  return { drafts, truncated: rows.length >= GOOGLE_MAX_ROWS };
}

/** The Pilotage action each draft belongs to, when one sent that change (same object, same account, close in time). */
async function matchActions(account: Account, drafts: ChangeDraft[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!drafts.length) return out;
  const times = drafts.map((d) => d.at.getTime());
  const ops = await prisma.pilotOperation.findMany({
    where: {
      status: { in: ["done", "uncertain"] },
      executedAt: { gte: new Date(Math.min(...times) - MATCH_WINDOW_MS), lte: new Date(Math.max(...times) + MATCH_WINDOW_MS) },
      action: { platform: account.platform, accountId: account.accountId },
    },
    select: { actionId: true, objectId: true, field: true, executedAt: true, readBackJson: true },
  });
  if (!ops.length) return out;
  for (const d of drafts) {
    let best: { actionId: string; gap: number } | null = null;
    for (const op of ops) {
      if (!op.executedAt) continue;
      const createdId = op.field === "new_ad" ? String(JSON.parse(op.readBackJson ?? "null") ?? "") : "";
      const sameObject = op.objectId === d.objectId || (!!createdId && createdId === d.objectId) || (!!d.campaignId && op.objectId === d.campaignId && d.objectType === "campaign");
      if (!sameObject) continue;
      const gap = Math.abs(op.executedAt.getTime() - d.at.getTime());
      if (gap <= MATCH_WINDOW_MS && (!best || gap < best.gap)) best = { actionId: op.actionId, gap };
    }
    if (best) out.set(d.externalId, best.actionId);
  }
  return out;
}

async function writeDrafts(account: Account, drafts: ChangeDraft[]): Promise<number> {
  if (!drafts.length) return 0;
  const matched = await matchActions(account, drafts);
  const existing = new Set((await prisma.platformChange.findMany({ where: { externalId: { in: drafts.map((d) => d.externalId) } }, select: { externalId: true } })).map((r) => r.externalId));
  const fresh = drafts.filter((d) => !existing.has(d.externalId));
  if (!fresh.length) return 0;
  await prisma.platformChange.createMany({
    data: fresh.map((d) => {
      const actionId = matched.get(d.externalId) ?? null;
      return {
        platform: d.platform, accountId: d.accountId, alertClientId: account.alertClientId, currency: d.currency,
        externalId: d.externalId, at: d.at, actorName: d.actorName, actorEmail: d.actorEmail, via: d.via,
        source: actionId ? "impulsemotion" : d.source, pilotActionId: actionId,
        objectType: d.objectType, objectId: d.objectId, objectName: d.objectName, eventType: d.eventType, field: d.field,
        beforeJson: JSON.stringify(d.before), afterJson: JSON.stringify(d.after), line: d.line, significant: d.significant,
        rawJson: JSON.stringify(d.raw).slice(0, 4000),
      };
    }),
    skipDuplicates: true,
  });
  return fresh.length;
}

/** Reads one account's log since its last read. Never throws: the outcome says what happened. */
export async function syncAccountChanges(account: Account, now: Date = new Date()): Promise<SyncOutcome> {
  const key = { platform_accountId: { platform: account.platform, accountId: account.accountId } };
  const state = await prisma.platformChangeSync.findUnique({ where: key });
  const floor = new Date(now.getTime() - LOOKBACK_DAYS * 86_400_000);
  // Read again the last hour: a log entry can show up a little late.
  const since = state?.syncedTo && state.syncedTo > floor ? new Date(state.syncedTo.getTime() - 60 * 60 * 1000) : floor;
  const outcome: SyncOutcome = { platform: account.platform, accountId: account.accountId, read: 0, written: 0, error: null, truncated: false };
  try {
    const { drafts, truncated } = account.platform === "meta" ? await readMeta(account.accountId, account.currency, since, now) : await readGoogle(account.accountId, account.currency, since, now);
    outcome.read = drafts.length;
    outcome.truncated = truncated;
    outcome.written = await writeDrafts(account, drafts);
    await prisma.platformChangeSync.upsert({
      where: key,
      create: { platform: account.platform, accountId: account.accountId, syncedTo: now, lastRunAt: now, lastError: truncated ? "Journal tronqué : les entrées les plus anciennes de la période n'ont pas toutes été lues." : null },
      update: { syncedTo: now, lastRunAt: now, lastError: truncated ? "Journal tronqué : les entrées les plus anciennes de la période n'ont pas toutes été lues." : null },
    });
  } catch (e) {
    outcome.error = (e instanceof Error ? e.message : String(e)).replace(/access_token=[^\s&"']+/gi, "access_token=[masqué]").slice(0, 300);
    await prisma.platformChangeSync.upsert({
      where: key,
      create: { platform: account.platform, accountId: account.accountId, lastRunAt: now, lastError: outcome.error },
      update: { lastRunAt: now, lastError: outcome.error },
    }).catch(() => {});
  }
  return outcome;
}

/** The accounts of an agency client, as the ingestion takes them. */
export function clientAccounts(client: { id: string; accountsJson: string }): Account[] {
  return parseAlertAccounts(client.accountsJson).flatMap((a): Account[] => {
    if (a.platform === "meta") { const d = metaAccountDigits(a.accountId); return d ? [{ platform: "meta" as const, accountId: d, currency: a.currency ?? "EUR", alertClientId: client.id }] : []; }
    if (a.platform === "google") { const d = normGoogle(a.accountId); return /^\d{6,12}$/.test(d) ? [{ platform: "google" as const, accountId: d, currency: a.currency ?? "EUR", alertClientId: client.id }] : []; }
    return [];
  });
}

/**
 * The page asked for one client: its accounts not read for ON_DEMAND_MIN_INTERVAL_MS
 * are read now, within `budgetMs`. The selected account goes first.
 */
export async function syncClientOnDemand(client: { id: string; accountsJson: string }, first: { platform: string; accountId: string } | null, budgetMs = 25_000, now: Date = new Date()): Promise<SyncOutcome[]> {
  const started = Date.now();
  const accounts = clientAccounts(client).sort((a, b) => Number(b.platform === first?.platform && b.accountId === first?.accountId) - Number(a.platform === first?.platform && a.accountId === first?.accountId));
  const states = await prisma.platformChangeSync.findMany({ where: { OR: accounts.map((a) => ({ platform: a.platform, accountId: a.accountId })) } });
  const out: SyncOutcome[] = [];
  for (const account of accounts) {
    if (Date.now() - started > budgetMs) break;
    const state = states.find((s) => s.platform === account.platform && s.accountId === account.accountId);
    if (state?.lastRunAt && now.getTime() - state.lastRunAt.getTime() < ON_DEMAND_MIN_INTERVAL_MS) continue;
    out.push(await syncAccountChanges(account, now));
  }
  return out;
}

export interface IngestPassSummary { accounts: number; synced: number; written: number; failed: number; left: number }

/** Every account of every client, the least recently read first, within the budget. */
export async function runChangesIngest(budgetMs = 120_000, now: Date = new Date()): Promise<IngestPassSummary> {
  const started = Date.now();
  const clients = await prisma.alertClient.findMany({ where: { gone: false }, select: { id: true, accountsJson: true } });
  const accounts = clients.flatMap(clientAccounts);
  const states = await prisma.platformChangeSync.findMany({ select: { platform: true, accountId: true, lastRunAt: true } });
  const lastRun = new Map(states.map((s) => [`${s.platform}:${s.accountId}`, s.lastRunAt?.getTime() ?? 0]));
  accounts.sort((a, b) => (lastRun.get(`${a.platform}:${a.accountId}`) ?? 0) - (lastRun.get(`${b.platform}:${b.accountId}`) ?? 0));
  const summary: IngestPassSummary = { accounts: accounts.length, synced: 0, written: 0, failed: 0, left: 0 };
  for (const [i, account] of accounts.entries()) {
    if (Date.now() - started > budgetMs) { summary.left = accounts.length - i; break; }
    const o = await syncAccountChanges(account, now);
    if (o.error) summary.failed++; else summary.synced++;
    summary.written += o.written;
  }
  return summary;
}
