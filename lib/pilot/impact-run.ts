/**
 * Pilotage — the daily pass that writes the J+7 and J+14 impacts of the
 * changes sent (cron /api/cron/pilot-impact). No AI: figures read on the
 * platforms, a paragraph written by code (lib/pilot/impact.ts), saved as a
 * PilotImpact and appended to the client's HQ journal.
 *
 * An action put back (undone) before the end of the window is not judged: its
 * effect is no longer on the account. An undo itself is not judged either.
 * A pass is capped in time and in number; what is left waits for the next day.
 *
 * Changes made outside Pilotage (PlatformChange, read by changes-ingest.ts) are
 * judged the same way, after the actions: the significant ones only, one per
 * object and day (the last of the day carries the analysis). Their HQ entry is
 * written when a consultant explained the change, or when the verdict is
 * clear (improved / worse): HQ keeps what matters, not every tweak.
 */

import { prisma } from "@/lib/prisma";
import { appendHqJournal, HQ_PROJECT_RE } from "@/lib/hq-journal";
import { describeOperation, readGoal, type PilotGoal } from "@/lib/pilot/ops";
import {
  IMPACT_HORIZONS, impactDue, parisDay, impactHqEntry, impactHqSlug, impactSummary, impactWindows,
  type ImpactResult, type Metrics, type ObjectImpact,
} from "@/lib/pilot/impact";
import { SOURCE_FR } from "@/lib/pilot/changes";
import { googleAccountMetrics, googleObjectMetrics, metaAccountMetrics, metaObjectMetrics } from "@/lib/pilot/impact-data";

const MAX_PER_PASS = 20;
const MAX_CHANGES_PER_PASS = 30;
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

/** What is judged: an action of Pilotage, or a change read on the platform. */
export interface ImpactSubject {
  platform: string;
  accountId: string;
  currency: string;
  executedAt: Date;
  objects: Array<{ objectId: string; objectType: string; name: string; parentName: string; changes: string[] }>;
}

export function actionSubject(action: ActionRow): ImpactSubject {
  const done = action.operations.filter((o) => o.status === "done");
  const byObject = new Map<string, typeof done>();
  for (const o of done) byObject.set(o.objectId, [...(byObject.get(o.objectId) ?? []), o]);
  return {
    platform: action.platform, accountId: action.accountId, currency: action.currency, executedAt: action.executedAt!,
    objects: [...byObject.values()].map((ops) => ({
      objectId: ops[0].objectId, objectType: ops[0].objectType, name: ops[0].objectName, parentName: ops[0].parentName,
      changes: ops.map((x) => describeOperation({ ...x, before: parse(x.beforeJson), after: parse(x.afterJson) }, action.currency, action.platform)),
    })),
  };
}

/** The figures of every changed object and of the account, before and after. */
export async function computeSubjectImpact(subject: ImpactSubject, horizon: number): Promise<ImpactResult> {
  const { before, after } = impactWindows(subject.executedAt, horizon);
  const names = new Map(subject.objects.map((o) => [o.name, o.objectType]));
  const meta = subject.platform === "meta";
  const objects: ObjectImpact[] = [];
  for (const o of subject.objects) {
    if (!/^\d{1,25}$/.test(o.objectId) || !["campaign", "adset", "ad"].includes(o.objectType)) continue;
    const read = (r: typeof before) => tryRead(() => (meta ? metaObjectMetrics(subject.accountId, o.objectId, r) : googleObjectMetrics(subject.accountId, o.objectId, o.objectType, r)));
    const [b, a] = [await read(before), await read(after)];
    const parentType = names.get(o.parentName);
    objects.push({
      objectId: o.objectId, objectType: o.objectType, name: o.name, changes: o.changes,
      before: b.m, after: a.m, error: b.error ?? a.error,
      insideChanged: !!o.parentName && !!parentType && parentType !== o.objectType,
    });
  }
  const readAccount = (r: typeof before) => tryRead(() => (meta ? metaAccountMetrics(subject.accountId, r) : googleAccountMetrics(subject.accountId, r)));
  const [ab, aa] = [await readAccount(before), await readAccount(after)];
  return { horizon, before, after, currency: subject.currency, objects, account: { before: ab.m, after: aa.m, error: ab.error ?? aa.error } };
}

export const computeImpact = (action: ActionRow, horizon: number) => computeSubjectImpact(actionSubject(action), horizon);

async function writeImpactHq(impactId: string): Promise<void> {
  const impact = await prisma.pilotImpact.findUnique({ where: { id: impactId }, include: { action: { include: { operations: { orderBy: { position: "asc" } } } }, change: true } });
  if (!impact || impact.hqWrittenAt || impact.status !== "done") return;
  if (impact.change) return writeChangeImpactHq(impact.id, impact.change, impact.horizon, impact.resultJson, impact.summary);
  const action = impact.action;
  if (!action) return;
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

  await runChangeImpacts(now, started, summary);

  // HQ entries that could not be written (HQ down): tried again.
  const unwritten = await prisma.pilotImpact.findMany({ where: { status: "done", hqWrittenAt: null, NOT: { hqError: "Pas de dossier HQ pour ce client." } }, select: { id: true }, take: 10 });
  for (const { id } of unwritten) {
    if (Date.now() - started > PASS_BUDGET_MS) break;
    await writeImpactHq(id).catch(() => {});
  }
  summary.hqWritten = await prisma.pilotImpact.count({ where: { hqWrittenAt: { gte: new Date(started) } } });
  return summary;
}

// ── Changes made outside Pilotage ─────────────────────────────────────────

type ChangeRow = NonNullable<Awaited<ReturnType<typeof prisma.platformChange.findUnique>>>;

const NO_GOAL: PilotGoal = { metric: null, target: null, note: "" };

function changeSubject(c: ChangeRow, siblings: ChangeRow[]): ImpactSubject {
  return {
    platform: c.platform, accountId: c.accountId, currency: c.currency, executedAt: c.at,
    objects: [{ objectId: c.objectId, objectType: c.objectType, name: c.objectName, parentName: "", changes: siblings.map((x) => x.line) }],
  };
}

/** The account-level client name, as the page shows it. */
async function changeContext(c: ChangeRow): Promise<{ clientName: string; accountName: string; hqProject: string | null }> {
  if (!c.alertClientId) return { clientName: "", accountName: "", hqProject: null };
  const client = await prisma.alertClient.findUnique({ where: { id: c.alertClientId }, select: { name: true, accountsJson: true, hqSlug: true, dashboardId: true } });
  if (!client) return { clientName: "", accountName: "", hqProject: null };
  let hqProject = client.hqSlug;
  if (!hqProject && client.dashboardId) hqProject = (await prisma.dashboard.findUnique({ where: { id: client.dashboardId }, select: { hqSlug: true } }))?.hqSlug ?? null;
  let accountName = "";
  try {
    const list = JSON.parse(client.accountsJson || "[]") as Array<{ platform?: string; accountId?: string; name?: string }>;
    accountName = list.find((a) => a.platform === c.platform && String(a.accountId ?? "").replace(/^act_/, "").replace(/-/g, "") === c.accountId)?.name ?? "";
  } catch { /* no name */ }
  return { clientName: client.name, accountName, hqProject };
}

async function writeChangeImpactHq(impactId: string, change: ChangeRow, horizon: number, resultJson: string, summary: string): Promise<void> {
  const impact = await prisma.pilotImpact.findUnique({ where: { id: impactId }, select: { verdict: true, hqWrittenAt: true } });
  if (!impact || impact.hqWrittenAt) return;
  // HQ keeps what matters: a change a consultant explained, or one whose effect is clear.
  if (!change.note && impact.verdict !== "improved" && impact.verdict !== "worse") {
    await prisma.pilotImpact.update({ where: { id: impactId }, data: { hqError: "Non consigné dans HQ : modification hors ImpulseMotion sans explication ni effet net." } });
    return;
  }
  const ctx = await changeContext(change);
  const hqProject = change.hqProject ?? ctx.hqProject;
  if (!hqProject || !HQ_PROJECT_RE.test(hqProject)) {
    await prisma.pilotImpact.update({ where: { id: impactId }, data: { hqError: "Pas de dossier HQ pour ce client." } });
    return;
  }
  const siblings = await prisma.platformChange.findMany({ where: { accountId: change.accountId, platform: change.platform, objectId: change.objectId, significant: true, at: { gte: new Date(change.at.getTime() - 86_400_000), lte: change.at } }, orderBy: { at: "asc" } });
  const result = JSON.parse(resultJson) as ImpactResult;
  const content = impactHqEntry({
    actionId: change.id, clientName: ctx.clientName, platform: change.platform, accountName: ctx.accountName, accountId: change.accountId,
    authorName: `${change.actorName} (${SOURCE_FR[change.source as keyof typeof SOURCE_FR] ?? change.source}, via ${change.via})`, executedAt: change.at,
    why: change.note ? `${change.note} (expliqué par ${change.noteByName ?? "un consultant"})` : "non précisé — modification faite hors ImpulseMotion",
    goal: NO_GOAL, changes: siblings.length ? siblings.map((x) => x.line) : [change.line], result, summary, external: true,
  });
  const written = await appendHqJournal({ project: hqProject, slug: impactHqSlug(change.id, horizon, change.at), content });
  await prisma.pilotImpact.update({ where: { id: impactId }, data: written.ok ? { hqWrittenAt: new Date(), hqError: null } : { hqError: written.error } });
}

/** The significant changes made outside Pilotage, due for an analysis: the last of each object and day carries it. */
async function runChangeImpacts(now: Date, started: number, summary: ImpactPassSummary): Promise<void> {
  const rows = await prisma.platformChange.findMany({
    where: {
      significant: true, pilotActionId: null, source: { not: "impulsemotion" },
      objectType: { in: ["campaign", "adset", "ad"] },
      at: { gte: new Date(now.getTime() - LOOKBACK_DAYS * 86_400_000), lte: new Date(now.getTime() - 7 * 86_400_000) },
    },
    include: { impacts: true },
    orderBy: { at: "asc" },
    take: 1000,
  });
  // One analysis per object and day: the last change of the day; the others point to it.
  const lastOfDay = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    const key = `${r.platform}:${r.accountId}:${r.objectId}:${parisDay(r.at)}`;
    const held = lastOfDay.get(key);
    if (!held || held.at < r.at) lastOfDay.set(key, r);
  }
  const todo: Array<{ change: (typeof rows)[number]; horizon: number; carrier: (typeof rows)[number] }> = [];
  for (const r of rows) {
    const carrier = lastOfDay.get(`${r.platform}:${r.accountId}:${r.objectId}:${parisDay(r.at)}`)!;
    for (const horizon of IMPACT_HORIZONS) {
      const existing = r.impacts.find((i) => i.horizon === horizon);
      if (existing && (existing.status !== "failed" || existing.attempts >= MAX_ATTEMPTS)) continue;
      if (impactDue(r.at, horizon, now)) todo.push({ change: r, horizon, carrier });
    }
  }
  summary.looked += todo.length;
  let computed = 0;
  for (const [i, { change, horizon, carrier }] of todo.entries()) {
    if (computed >= MAX_CHANGES_PER_PASS || Date.now() - started > PASS_BUDGET_MS) { summary.left += todo.length - i; break; }
    const attempts = (change.impacts.find((x) => x.horizon === horizon)?.attempts ?? 0) + 1;
    const key = { changeId_horizon: { changeId: change.id, horizon } };
    if (carrier.id !== change.id) {
      const text = `Analysé avec la dernière modification du même jour sur cet objet (${carrier.at.toLocaleTimeString("fr-FR", { timeZone: "Europe/Paris", hour: "2-digit", minute: "2-digit" })}).`;
      await prisma.pilotImpact.upsert({ where: key, create: { changeId: change.id, horizon, status: "skipped", verdict: "skipped", summary: text, attempts }, update: { status: "skipped", verdict: "skipped", summary: text, attempts } });
      summary.skipped++;
      continue;
    }
    try {
      const siblings = rows.filter((x) => x.platform === change.platform && x.accountId === change.accountId && x.objectId === change.objectId && parisDay(x.at) === parisDay(change.at));
      const result = await computeSubjectImpact(changeSubject(change, siblings), horizon);
      if (!result.objects.some((o) => o.before || o.after) && !result.account.before && !result.account.after) throw new Error(result.objects[0]?.error ?? result.account.error ?? "plateforme illisible");
      const { verdict, summary: text } = impactSummary(result, NO_GOAL, change.platform);
      const row = await prisma.pilotImpact.upsert({
        where: key,
        create: { changeId: change.id, horizon, status: "done", verdict, summary: text, resultJson: JSON.stringify(result), attempts, computedAt: now },
        update: { status: "done", verdict, summary: text, resultJson: JSON.stringify(result), attempts, error: null, computedAt: now },
      });
      computed++;
      summary.computed++;
      await writeChangeImpactHq(row.id, change, horizon, row.resultJson, row.summary).catch((e) => console.error("[pilot-impact] HQ of a change not written", e));
    } catch (e) {
      const error = (e instanceof Error ? e.message : String(e)).slice(0, 500);
      await prisma.pilotImpact.upsert({ where: key, create: { changeId: change.id, horizon, status: "failed", error, attempts }, update: { status: "failed", error, attempts } });
      summary.failed++;
    }
  }
}
