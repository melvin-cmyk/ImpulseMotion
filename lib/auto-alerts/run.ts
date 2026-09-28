/**
 * Automatic alerting — one run over every client.
 *
 * A client = a group of ad accounts (lib/auto-alerts/clients.ts), with or
 * without a dashboard. Each account is scanned on its own and its findings
 * carry the account in their key. No channel → incidents are still tracked,
 * nothing is sent and no AI is called.
 */

import { prisma } from "@/lib/prisma";
import { pruneFindings, type DayPoint, type Finding } from "@/lib/auto-alerts/detect";
import { scanMetaAccount, type ScanResult } from "@/lib/auto-alerts/meta";
import { scanGoogleAccount } from "@/lib/auto-alerts/google";
import { applyPlan, markNotified, markNotifyError, planIncidents, type Plan } from "@/lib/auto-alerts/incidents";
import { buildDigest, hasNews, writeReading } from "@/lib/auto-alerts/message";
import { autoAlertWebhook, postDigest } from "@/lib/auto-alerts/slack";
import { enabledKinds, isDue, parseConfig } from "@/lib/auto-alerts/config";
import { parseAccounts, syncAlertClients, type AlertAccount } from "@/lib/auto-alerts/clients";
import { loadFx } from "@/lib/cockpit/fx";

export interface RunOptions {
  /** Detect only: no incident written, nothing sent, no AI. */
  dryRun?: boolean;
  /** Restrict to these clients. */
  clientIds?: string[];
  /** Cron firing: each client is scanned only at the slots of its own frequency. */
  scheduled?: boolean;
  /** Read the platforms again for new accounts before scanning (the cron does). */
  sync?: boolean;
  /** Hard stop for the whole run (ms since epoch). */
  deadlineAt?: number;
  now?: Date;
}

export interface ClientRun {
  clientId: string;
  name: string;
  channel: string | null;
  accounts: number;
  /** No account spent anything over the last ten days. */
  dormant: boolean;
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

const CONCURRENCY = 4;
/** Ceiling on Slack messages per run: what does not fit waits for the next run, critical first. */
export const MAX_MESSAGES = 10;
/**
 * The same sharp break on many clients at once is not many problems, it is
 * one: a platform that reports late, an API that answers zeros. From this
 * many clients (and this share of those scanned) nothing is sent for it.
 */
export const FLOOD = { minClients: 4, share: 0.3 } as const;
const FLOOD_KINDS = new Set<string>(["spend_stopped", "spend_drop", "spend_spike", "conversions_zero", "access_lost"]);
const KIND_LABEL: Record<string, string> = {
  spend_stopped: "dépense à l'arrêt", spend_drop: "dépense en forte baisse", spend_spike: "dépense anormalement haute",
  conversions_zero: "plus aucune conversion", access_lost: "accès au compte perdu",
};

/** Pure: the kinds announced on too many clients at once to be believed one by one. */
export function floodedKinds(announced: Array<{ clientId: string; kinds: string[] }>, scanned: number): string[] {
  const clients = new Map<string, Set<string>>();
  for (const a of announced) for (const k of a.kinds) {
    if (!FLOOD_KINDS.has(k)) continue;
    clients.set(k, (clients.get(k) ?? new Set()).add(a.clientId));
  }
  const limit = Math.max(FLOOD.minClients, Math.ceil(scanned * FLOOD.share));
  return [...clients.entries()].filter(([, ids]) => ids.size >= limit).map(([k]) => k).sort();
}
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
const PLATFORM = { meta: "Meta Ads", google: "Google Ads" } as const;

export interface AccountOutcome { findings: Finding[]; evaluated: string[]; dormant: boolean }

/**
 * Pure: what one account contributes to its client. Findings and scopes get
 * the account in their key; the title names the account when the client has
 * several on the platform. An account that spent nothing for ten days raises
 * nothing new — a closed account of 2023 is not news — but what is already
 * open on it keeps being followed.
 */
export function tagAccount(account: AlertAccount, scan: Pick<ScanResult, "findings" | "evaluated" | "series">, opts: { siblings: number; openKeys: ReadonlySet<string> }): AccountOutcome {
  const read = scan.evaluated.has(account.platform === "meta" ? "meta:days" : "google:days");
  const dormant = read && scan.series.every((d) => d.spend <= 0);
  const findings = scan.findings
    .map((f): Finding => ({
      ...f,
      key: `${f.key}@${account.accountId}`,
      scope: `${f.scope}@${account.accountId}` as Finding["scope"],
      title: opts.siblings > 1 ? `${f.title} (${account.name})` : f.title,
    }))
    .filter((f) => !dormant || opts.openKeys.has(f.key));
  return { findings, evaluated: [...scan.evaluated].map((s) => `${s}@${account.accountId}`), dormant };
}

export async function runAutoAlerts(opts: RunOptions = {}): Promise<RunResult> {
  const now = opts.now ?? new Date();
  const result: RunResult = { clients: 0, scanned: 0, withFindings: 0, messages: 0, aiCalls: 0, timedOut: false, errors: [], runs: [] };
  if (opts.sync || (await prisma.alertClient.count()) === 0) {
    try {
      result.errors.push(...(await syncAlertClients()).warnings);
    } catch (e) {
      result.errors.push(`Liste des clients non mise à jour — ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Longest without a scan first: a run cut by its time budget resumes with the others.
  let clients = await prisma.alertClient.findMany({
    where: { gone: false, autoAlerts: true, ...(opts.clientIds?.length ? { id: { in: opts.clientIds } } : {}) },
    orderBy: [{ lastScanAt: { sort: "asc", nulls: "first" } }, { name: "asc" }],
  });
  if (opts.scheduled) clients = clients.filter((c) => isDue(parseConfig(c.autoAlertConfig), now));
  result.clients = clients.length;

  const canSend = !opts.dryRun && autoAlertWebhook() !== null;
  // EUR value of each currency: the thresholds of the detectors are amounts in EUR.
  const rates = (await loadFx()).rates;
  let next = 0;

  interface Pending { client: (typeof clients)[number]; run: ClientRun; plan: Plan; announcedIds: string[]; series: Record<string, DayPoint[]>; target: string; channel: string | null }
  const pending: Pending[] = [];

  const one = async (c: (typeof clients)[number]): Promise<ClientRun> => {
    const accounts = parseAccounts(c.accountsJson);
    const channel = c.slackChannel ?? c.slackChannelId ?? null;
    const target = c.slackChannelId ?? c.slackChannel ?? null;
    const kinds = enabledKinds(parseConfig(c.autoAlertConfig));
    const run: ClientRun = { clientId: c.id, name: c.name, channel, accounts: accounts.length, dormant: false, findings: [], announced: 0, resolved: 0, sent: false, aiUsed: false, errors: [] };

    const existing = await prisma.autoIncident.findMany({ where: { clientId: c.id } });
    const openKeys = new Set(existing.filter((i) => i.status === "open").map((i) => i.key));
    const count = { meta: accounts.filter((a) => a.platform === "meta").length, google: accounts.filter((a) => a.platform === "google").length };
    const fallbackCurrency = accounts.find((a) => a.currency)?.currency ?? "EUR";

    const evaluated = new Set<string>();
    const series: Record<string, DayPoint[]> = {};
    const found: Finding[] = [];
    const dormant: boolean[] = [];
    await Promise.all(accounts.map(async (a) => {
      const label = count[a.platform] > 1 ? `${PLATFORM[a.platform]} — ${a.name}` : PLATFORM[a.platform];
      try {
        const scan = await within(
          a.platform === "meta" ? scanMetaAccount(a.accountId, now, rates) : scanGoogleAccount(a.accountId, a.currency ?? fallbackCurrency, now, rates),
          label,
        );
        run.errors.push(...scan.errors.map((e) => (count[a.platform] > 1 ? `${a.name} — ${e}` : e)));
        // Topics first, symptoms second: with "paiement" switched off, a blocked
        // account must not hide the stop of delivery it causes.
        const kept = pruneFindings(scan.findings.filter((f) => kinds.has(f.kind)));
        const out = tagAccount(a, { ...scan, findings: kept }, { siblings: count[a.platform], openKeys });
        found.push(...out.findings);
        out.evaluated.forEach((s) => evaluated.add(s));
        dormant.push(out.dormant);
        if (!out.dormant) series[label] = scan.series;
      } catch (e) {
        dormant.push(false);
        run.errors.push(e instanceof Error ? e.message : String(e));
      }
    }));
    run.dormant = dormant.length > 0 && dormant.every(Boolean);
    run.findings = found.sort((a, b) => Number(b.severity === "critical") - Number(a.severity === "critical"));
    if (opts.dryRun) return run;

    const plan = planIncidents(existing, run.findings, evaluated, now);
    for (const r of plan.resolve) {
      // A topic switched off closes its incidents without a word; so does a warning
      // that went away — only the end of a critical problem is worth a message.
      if (!kinds.has(r.incident.kind as never) || r.incident.severity !== "critical") r.say = false;
    }
    const { announcedIds } = await applyPlan(c.id, plan, now);
    await prisma.alertClient.update({ where: { id: c.id }, data: { lastScanAt: now, dormant: run.dormant } });
    run.announced = plan.announce.length;
    run.resolved = plan.resolve.length;
    // Nothing is sent from here: the run decides once every client has been read.
    if (hasNews(plan) && target && canSend) pending.push({ client: c, run, plan, announcedIds, series, target, channel });
    return run;
  };

  const workers = Array.from({ length: Math.min(CONCURRENCY, clients.length) }, async () => {
    for (;;) {
      if (opts.deadlineAt && Date.now() >= opts.deadlineAt) { result.timedOut = true; return; }
      const i = next++;
      if (i >= clients.length) return;
      const c = clients[i];
      try {
        const run = await one(c);
        result.scanned++;
        if (run.findings.length) result.withFindings++;
        for (const e of run.errors) result.errors.push(`${run.name} — ${e}`);
        result.runs.push(run);
      } catch (e) {
        result.errors.push(`${c.name} — ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  });
  await Promise.all(workers);

  // ── What reaches Slack ─────────────────────────────────────────────────────
  const flooded = new Set(floodedKinds(
    pending.map((p) => ({ clientId: p.client.id, kinds: p.plan.announce.map((a) => a.finding.kind) })),
    result.runs.filter((r) => !r.dormant).length,
  ));
  for (const kind of flooded) {
    const n = pending.filter((p) => p.plan.announce.some((a) => a.finding.kind === kind)).length;
    result.errors.push(`Anomalie générale suspectée : « ${KIND_LABEL[kind] ?? kind} » sur ${n} clients en même temps — rien n'a été envoyé dans Slack pour ce sujet, à vérifier côté plateforme.`);
  }
  const toSend = pending
    .map((p) => {
      const keep = p.plan.announce.map((a, i) => ({ a, id: p.announcedIds[i] })).filter((x) => !flooded.has(x.a.finding.kind));
      return { ...p, plan: { ...p.plan, announce: keep.map((x) => x.a) }, announcedIds: keep.map((x) => x.id) };
    })
    .filter((p) => hasNews(p.plan))
    // Critical first, then the clients with the most to say.
    .sort((x, y) =>
      Number(y.plan.announce.some((a) => a.finding.severity === "critical")) - Number(x.plan.announce.some((a) => a.finding.severity === "critical"))
      || y.plan.announce.length - x.plan.announce.length || x.client.name.localeCompare(y.client.name));
  if (toSend.length > MAX_MESSAGES) {
    result.errors.push(`${toSend.length} messages à envoyer, ${MAX_MESSAGES} au plus par passage : les ${toSend.length - MAX_MESSAGES} autres partiront au passage suivant.`);
  }
  for (const p of toSend.slice(0, MAX_MESSAGES)) {
    if (opts.deadlineAt && Date.now() >= opts.deadlineAt) { result.timedOut = true; break; }
    const { client: c, run, plan, announcedIds } = p;
    // The AI reads only what is new and unexplained — a reminder has already been read.
    const unexplained = plan.announce.filter((a) => a.reason !== "reminder" && a.finding.needsAi).map((a) => a.finding);
    let reading: string | null = null;
    if (unexplained.length && result.aiCalls < MAX_AI_CALLS) {
      result.aiCalls++;
      reading = await writeReading({ dashboardId: c.dashboardId, name: c.name }, plan.announce.map((a) => a.finding), p.series);
      run.aiUsed = reading !== null;
    }
    const link = c.dashboardId ? `${appUrl()}/portfolio/${c.dashboardId}` : `${appUrl()}/admin/auto-alerts`;
    run.text = buildDigest({ clientName: c.name, plan, reading, link, stillOpen: plan.touch.length });
    try {
      await postDigest(p.target, run.text, { id: c.id, name: c.name });
      await markNotified(plan, announcedIds, now);
      run.sent = true;
      result.messages++;
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      result.errors.push(`${c.name} — slack ${p.channel} : ${m}`);
      await markNotifyError(announcedIds, m).catch(() => undefined);
    }
  }
  result.runs.sort((a, b) => b.findings.length - a.findings.length || a.name.localeCompare(b.name));
  return result;
}
