/**
 * Automatic alerting — one run over every client.
 *
 * A client = the dashboards sharing an ad account (same grouping as the
 * portfolio). Incidents hang on the oldest dashboard of the group; the Slack
 * channel is the first one set in the group. No channel → incidents are still
 * tracked, nothing is sent and no AI is called.
 */

import { prisma } from "@/lib/prisma";
import { groupDashboardsByAccount } from "@/lib/portfolio";
import { getAccountProfileSettings } from "@/lib/account-settings";
import { pruneFindings, type DayPoint, type Finding, type Scope } from "@/lib/auto-alerts/detect";
import { scanMetaAccount } from "@/lib/auto-alerts/meta";
import { scanGoogleAccount } from "@/lib/auto-alerts/google";
import { applyPlan, markNotified, markNotifyError, planIncidents } from "@/lib/auto-alerts/incidents";
import { buildDigest, hasNews, writeReading } from "@/lib/auto-alerts/message";
import { autoAlertWebhook, postDigest } from "@/lib/auto-alerts/slack";
import { enabledKinds, isDue, parseConfig } from "@/lib/auto-alerts/config";

export interface RunOptions {
  /** Detect only: no incident written, nothing sent, no AI. */
  dryRun?: boolean;
  /** Restrict to these dashboards (any member of a client group). */
  dashboardIds?: string[];
  /** Cron firing: each client is scanned only at the slots of its own frequency. */
  scheduled?: boolean;
  /** Hard stop for the whole run (ms since epoch). */
  deadlineAt?: number;
  now?: Date;
}

export interface ClientRun {
  dashboardId: string;
  name: string;
  channel: string | null;
  findings: Finding[];
  announced: number;
  resolved: number;
  sent: boolean;
  aiUsed: boolean;
  errors: string[];
  text?: string;
}

export interface RunResult {
  clients: number;
  scanned: number;
  withFindings: number;
  messages: number;
  aiCalls: number;
  timedOut: boolean;
  errors: string[];
  runs: ClientRun[];
}

const CONCURRENCY = 3;
/** Ceiling on AI readings per run, whatever happens to the accounts that day. */
const MAX_AI_CALLS = 15;

/** One slow account must not hold the others back. */
const SCAN_TIMEOUT_MS = 45_000;

function within<T>(p: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clock = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} : pas de réponse en ${SCAN_TIMEOUT_MS / 1000} s`)), SCAN_TIMEOUT_MS); });
  return Promise.race([p, clock]).finally(() => { if (timer) clearTimeout(timer); });
}

const appUrl = () => (process.env.NEXTAUTH_URL || process.env.NEXT_PUBLIC_APP_URL || "https://app.impulse-analytics.com").replace(/\/$/, "");

export async function runAutoAlerts(opts: RunOptions = {}): Promise<RunResult> {
  const now = opts.now ?? new Date();
  const rows = await prisma.dashboard.findMany({
    select: { id: true, name: true, metaAccountId: true, googleCustomerId: true, createdAt: true, slackChannel: true, slackChannelId: true, autoAlerts: true, autoAlertConfig: true },
  });
  let { groups } = groupDashboardsByAccount(rows);
  groups = groups.filter((g) => g.members.every((m) => m.autoAlerts));
  if (opts.dashboardIds?.length) {
    const wanted = new Set(opts.dashboardIds);
    groups = groups.filter((g) => g.dashboardIds.some((id) => wanted.has(id)));
  }
  if (opts.scheduled) groups = groups.filter((g) => isDue(parseConfig(g.primary.autoAlertConfig), now));

  const result: RunResult = { clients: groups.length, scanned: 0, withFindings: 0, messages: 0, aiCalls: 0, timedOut: false, errors: [], runs: [] };
  const canSend = !opts.dryRun && autoAlertWebhook() !== null;
  let next = 0;

  const one = async (g: (typeof groups)[number]): Promise<ClientRun> => {
    const dashboardId = g.primary.id;
    const name = g.primary.name;
    const linked = g.members.find((m) => m.slackChannelId || m.slackChannel);
    const channel = linked?.slackChannel ?? linked?.slackChannelId ?? null;
    const target = linked?.slackChannelId ?? linked?.slackChannel ?? null;
    const kinds = enabledKinds(parseConfig(g.primary.autoAlertConfig));
    const run: ClientRun = { dashboardId, name, channel, findings: [], announced: 0, resolved: 0, sent: false, aiUsed: false, errors: [] };

    const evaluated = new Set<Scope>();
    const series: Record<string, DayPoint[]> = {};
    const found: Finding[] = [];
    let currency = "EUR";
    if (g.metaAccountId) {
      try {
        const meta = await within(scanMetaAccount(g.metaAccountId, now), "Meta Ads");
        found.push(...meta.findings);
        meta.evaluated.forEach((s) => evaluated.add(s));
        run.errors.push(...meta.errors);
        series["Meta Ads"] = meta.series;
        currency = meta.currency;
      } catch (e) {
        run.errors.push(e instanceof Error ? e.message : String(e));
      }
    } else {
      try { currency = (await getAccountProfileSettings("google", g.googleCustomerId ?? "")).currency ?? "EUR"; } catch { /* EUR */ }
    }
    if (g.googleCustomerId) {
      try {
        const google = await within(scanGoogleAccount(g.googleCustomerId, currency, now), "Google Ads");
        found.push(...google.findings);
        google.evaluated.forEach((s) => evaluated.add(s));
        run.errors.push(...google.errors);
        series["Google Ads"] = google.series;
      } catch (e) {
        run.errors.push(e instanceof Error ? e.message : String(e));
      }
    }
    // Topics first, symptoms second: with "paiement" switched off, a blocked
    // account must not hide the stop of delivery it causes.
    run.findings = pruneFindings(found.filter((f) => kinds.has(f.kind)));
    if (opts.dryRun) return run;

    const existing = await prisma.autoIncident.findMany({ where: { dashboardId } });
    const plan = planIncidents(existing, run.findings, evaluated, now);
    // A topic switched off closes its incidents without a word.
    for (const r of plan.resolve) if (!kinds.has(r.incident.kind as never)) r.say = false;
    const { announcedIds } = await applyPlan(dashboardId, plan, now);
    run.announced = plan.announce.length;
    run.resolved = plan.resolve.length;
    if (!hasNews(plan) || !target || !canSend) return run;

    // The AI reads only what is new and unexplained — a reminder has already been read.
    const unexplained = plan.announce.filter((a) => a.reason !== "reminder" && a.finding.needsAi).map((a) => a.finding);
    let reading: string | null = null;
    if (unexplained.length && result.aiCalls < MAX_AI_CALLS) {
      result.aiCalls++;
      reading = await writeReading({ dashboardId, name }, plan.announce.map((a) => a.finding), series);
      run.aiUsed = reading !== null;
    }
    run.text = buildDigest({ clientName: name, plan, reading, link: `${appUrl()}/portfolio/${dashboardId}`, stillOpen: plan.touch.length });
    try {
      await postDigest(target, run.text, { id: dashboardId, name });
      await markNotified(plan, announcedIds, now);
      run.sent = true;
      result.messages++;
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      run.errors.push(`slack ${channel} : ${m}`);
      await markNotifyError(announcedIds, m).catch(() => undefined);
    }
    return run;
  };

  const workers = Array.from({ length: Math.min(CONCURRENCY, groups.length) }, async () => {
    for (;;) {
      if (opts.deadlineAt && Date.now() >= opts.deadlineAt) { result.timedOut = true; return; }
      const i = next++;
      if (i >= groups.length) return;
      const g = groups[i];
      try {
        const run = await one(g);
        result.scanned++;
        if (run.findings.length) result.withFindings++;
        for (const e of run.errors) result.errors.push(`${run.name} — ${e}`);
        result.runs.push(run);
      } catch (e) {
        result.errors.push(`${g.primary.name} — ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  });
  await Promise.all(workers);
  result.runs.sort((a, b) => b.findings.length - a.findings.length || a.name.localeCompare(b.name));
  return result;
}
