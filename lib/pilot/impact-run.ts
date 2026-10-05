/**
 * Pilotage — the daily pass that writes the J+7 and J+14 impacts of the
 * changes sent (cron /api/cron/pilot-impact). No AI: figures read on the
 * platforms, a paragraph written by code (lib/pilot/impact.ts), saved as a
 * PilotImpact and appended to the client's HQ journal.
 *
 * An action put back (undone) before the end of the window is not judged: its
 * effect is no longer on the account. An undo itself is not judged either.
 * A pass is capped in time and in number; what is left waits for the next day.
 */

import { prisma } from "@/lib/prisma";
import { appendHqJournal, HQ_PROJECT_RE } from "@/lib/hq-journal";
import { describeOperation, readGoal } from "@/lib/pilot/ops";
import {
  IMPACT_HORIZONS, impactDue, parisDay, impactHqEntry, impactHqSlug, impactSummary, impactWindows,
  type ImpactResult, type Metrics, type ObjectImpact,
} from "@/lib/pilot/impact";
import { googleAccountMetrics, googleObjectMetrics, metaAccountMetrics, metaObjectMetrics } from "@/lib/pilot/impact-data";

const MAX_PER_PASS = 20;
const PASS_BUDGET_MS = 240_000;
const MAX_ATTEMPTS = 3;
/** Older actions are not looked at any more (J+14 + settling + some days of retries). */
const LOOKBACK_DAYS = 30;

type ActionRow = Awaited<ReturnType<typeof loadCandidates>>[number];

async function loadCandidates(now: Date) {
  return prisma.pilotAction.findMany({
    where: {
      status: { in: ["done", "partial"] },
      undoOfId: null,
      executedAt: { not: null, gte: new Date(now.getTime() - LOOKBACK_DAYS * 86_400_000), lte: new Date(now.getTime() - 7 * 86_400_000) },
    },
    include: { operations: { orderBy: { position: "asc" } }, impacts: true },
    orderBy: { executedAt: "asc" },
    take: 200,
  });
}

const parse = (json: string | null) => { try { const v = JSON.parse(json ?? "null"); return typeof v === "string" || typeof v === "number" ? v : null; } catch { return null; } };

async function tryRead(fn: () => Promise<Metrics>): Promise<{ m: Metrics | null; error: string | null }> {
  try { return { m: await fn(), error: null }; } catch (e) { return { m: null, error: (e instanceof Error ? e.message : String(e)).slice(0, 200) }; }
}

/** The figures of every changed object and of the account, before and after. */
export async function computeImpact(action: ActionRow, horizon: number): Promise<ImpactResult> {
  const { before, after } = impactWindows(action.executedAt!, horizon);
  const done = action.operations.filter((o) => o.status === "done");
  const byObject = new Map<string, typeof done>();
  for (const o of done) byObject.set(o.objectId, [...(byObject.get(o.objectId) ?? []), o]);
  const names = new Map([...byObject.values()].map((ops) => [ops[0].objectName, ops[0].objectType]));

  const meta = action.platform === "meta";
  const objects: ObjectImpact[] = [];
  for (const [objectId, ops] of byObject) {
    const o = ops[0];
    const read = (r: typeof before) => tryRead(() => (meta ? metaObjectMetrics(action.accountId, objectId, r) : googleObjectMetrics(action.accountId, objectId, o.objectType, r)));
    const [b, a] = [await read(before), await read(after)];
    const parentType = names.get(o.parentName);
    objects.push({
      objectId, objectType: o.objectType, name: o.objectName,
      changes: ops.map((x) => describeOperation({ ...x, before: parse(x.beforeJson), after: parse(x.afterJson) }, action.currency, action.platform)),
      before: b.m, after: a.m, error: b.error ?? a.error,
      insideChanged: !!o.parentName && !!parentType && parentType !== o.objectType,
    });
  }
  const readAccount = (r: typeof before) => tryRead(() => (meta ? metaAccountMetrics(action.accountId, r) : googleAccountMetrics(action.accountId, r)));
  const [ab, aa] = [await readAccount(before), await readAccount(after)];
  return { horizon, before, after, currency: action.currency, objects, account: { before: ab.m, after: aa.m, error: ab.error ?? aa.error } };
}

async function writeImpactHq(impactId: string): Promise<void> {
  const impact = await prisma.pilotImpact.findUnique({ where: { id: impactId }, include: { action: { include: { operations: { orderBy: { position: "asc" } } } } } });
  if (!impact || impact.hqWrittenAt || impact.status !== "done") return;
  const action = impact.action;
  if (!action.hqProject || !HQ_PROJECT_RE.test(action.hqProject)) {
    await prisma.pilotImpact.update({ where: { id: impactId }, data: { hqError: "Pas de dossier HQ pour ce client." } });
    return;
  }
  const result = JSON.parse(impact.resultJson) as ImpactResult;
  const content = impactHqEntry({
    actionId: action.id, clientName: action.clientName, platform: action.platform, accountName: action.accountName, accountId: action.accountId,
    authorName: action.createdByName, executedAt: action.executedAt!, why: action.why, goal: readGoal(JSON.parse(action.goalJson || "{}")),
    changes: action.operations.filter((o) => o.status === "done").map((o) => describeOperation({ ...o, before: parse(o.beforeJson), after: parse(o.afterJson) }, action.currency, action.platform)),
    result, summary: impact.summary,
  });
  const written = await appendHqJournal({ project: action.hqProject, slug: impactHqSlug(action.id, impact.horizon, action.executedAt!), content });
  await prisma.pilotImpact.update({ where: { id: impactId }, data: written.ok ? { hqWrittenAt: new Date(), hqError: null } : { hqError: written.error } });
}

export interface ImpactPassSummary { looked: number; computed: number; skipped: number; failed: number; hqWritten: number; left: number }

export async function runPilotImpacts(now: Date = new Date()): Promise<ImpactPassSummary> {
  const started = Date.now();
  const summary: ImpactPassSummary = { looked: 0, computed: 0, skipped: 0, failed: 0, hqWritten: 0, left: 0 };
  const actions = await loadCandidates(now);
  const todo: Array<{ action: ActionRow; horizon: number }> = [];
  for (const action of actions) {
    for (const horizon of IMPACT_HORIZONS) {
      const existing = action.impacts.find((i) => i.horizon === horizon);
      if (existing && (existing.status !== "failed" || existing.attempts >= MAX_ATTEMPTS)) continue;
      if (impactDue(action.executedAt!, horizon, now)) todo.push({ action, horizon });
    }
  }
  summary.looked = todo.length;

  for (const [i, { action, horizon }] of todo.entries()) {
    if (i >= MAX_PER_PASS || Date.now() - started > PASS_BUDGET_MS) { summary.left = todo.length - i; break; }
    const attempts = (action.impacts.find((x) => x.horizon === horizon)?.attempts ?? 0) + 1;
    const key = { actionId_horizon: { actionId: action.id, horizon } };

    // Put back before the end of the window: its effect is gone, nothing to judge.
    if (action.undoneById) {
      const undo = await prisma.pilotAction.findUnique({ where: { id: action.undoneById }, select: { executedAt: true, createdByName: true } });
      const end = impactWindows(action.executedAt!, horizon).after.until;
      if (undo?.executedAt && parisDay(undo.executedAt) <= end) {
        const text = `Non analysé : la modification a été annulée le ${undo.executedAt.toLocaleDateString("fr-FR", { timeZone: "Europe/Paris" })} par ${undo.createdByName}.`;
        await prisma.pilotImpact.upsert({ where: key, create: { actionId: action.id, horizon, status: "skipped", verdict: "skipped", summary: text, attempts }, update: { status: "skipped", verdict: "skipped", summary: text, attempts } });
        summary.skipped++;
        continue;
      }
    }

    try {
      const result = await computeImpact(action, horizon);
      // Nothing readable at all (platform down): tried again tomorrow.
      if (!result.objects.some((o) => o.before || o.after) && !result.account.before && !result.account.after) throw new Error(result.objects[0]?.error ?? result.account.error ?? "plateforme illisible");
      const { verdict, summary: text } = impactSummary(result, readGoal(JSON.parse(action.goalJson || "{}")), action.platform);
      const row = await prisma.pilotImpact.upsert({
        where: key,
        create: { actionId: action.id, horizon, status: "done", verdict, summary: text, resultJson: JSON.stringify(result), attempts, computedAt: now },
        update: { status: "done", verdict, summary: text, resultJson: JSON.stringify(result), attempts, error: null, computedAt: now },
      });
      summary.computed++;
      await writeImpactHq(row.id);
    } catch (e) {
      const error = (e instanceof Error ? e.message : String(e)).slice(0, 500);
      await prisma.pilotImpact.upsert({ where: key, create: { actionId: action.id, horizon, status: "failed", error, attempts }, update: { status: "failed", error, attempts } });
      summary.failed++;
    }
  }

  // HQ entries that could not be written (HQ down): tried again.
  const unwritten = await prisma.pilotImpact.findMany({ where: { status: "done", hqWrittenAt: null, NOT: { hqError: "Pas de dossier HQ pour ce client." } }, select: { id: true }, take: 10 });
  for (const { id } of unwritten) {
    if (Date.now() - started > PASS_BUDGET_MS) break;
    await writeImpactHq(id).catch(() => {});
  }
  summary.hqWritten = await prisma.pilotImpact.count({ where: { hqWrittenAt: { gte: new Date(started) } } });
  return summary;
}
