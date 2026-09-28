/**
 * Global Cockpit — one build: sheet → clients → accounts → figures → alerts,
 * stored as a snapshot. The page never computes anything: it reads the latest
 * snapshot, and the older ones show how each client evolved.
 *
 * A build has a time budget. Accounts it could not read in time are flagged
 * (« partial ») and the next run, helped by the cache, completes them.
 */

import { prisma } from "@/lib/prisma";
import { PERIOD_LIMITS, buildClient, sortClients, type AccountMode, type ClientInput, type ClientRow, type KpiMode, type PeriodKind, type PlatformInput, type Severity } from "@/lib/cockpit/engine";
import { fetchBudgetSheet, sheetClients, type SheetClient } from "@/lib/cockpit/sheet";
import { accountLabel, matchAccounts, type AvailableAccount } from "@/lib/cockpit/match";
import { bucket, bucketRanges, cockpitCalendar, cockpitPeriods, type CockpitCalendar } from "@/lib/cockpit/weeks";
import { loadFx } from "@/lib/cockpit/fx";
import { defaultModeFor } from "@/lib/cockpit/defaults";
import { googleSeries, listGoogleAccounts, listMetaAccounts, metaSeries, type AccountSeries } from "@/lib/cockpit/fetch";

/** A client row, plus the platforms budgeted in the sheet that no account covers. */
export interface CockpitClientRow extends ClientRow { missing: string[] }

/**
 * One reading of the agency: by day, by week or by month. The names say
 * « week » because the week came first; they hold whatever the period is.
 */
export interface PeriodView {
  /** absent on the builds made before the readings by day and by month: a week */
  period?: PeriodKind;
  /** the period read (« 27/09 », « 21/09 → 27/09 », « 01/09 → 27/09 ») */
  w0_label: string;
  /** periods the one read is compared to */
  hist_weeks: number;
  /** one short label per period, oldest first */
  week_starts: string[];
  clients: CockpitClientRow[];
  tot_eur_w0: number;
  tot_eur_base: number;
  quality: { accounts: number; issues: number; budgeted: number; budget_coverage: number };
}

/** Totals of a list of clients — recomputed when a viewer only sees some of them. */
export function totalsOf(clients: CockpitClientRow[]): Pick<PeriodView, "tot_eur_w0" | "tot_eur_base" | "quality"> {
  const platforms = clients.flatMap((c) => Object.values(c.platforms));
  const tot = clients.reduce((s, c) => s + c.eur_w0, 0);
  const budgeted = clients.filter((c) => c.pacing).reduce((s, c) => s + c.eur_w0, 0);
  return {
    tot_eur_w0: tot,
    tot_eur_base: clients.reduce((s, c) => s + c.eur_base, 0),
    quality: {
      accounts: platforms.length,
      issues: platforms.filter((p) => p.err).length,
      budgeted: platforms.filter((p) => p.pacing).length,
      budget_coverage: tot > 0 ? Math.round((budgeted / tot) * 10_000) / 10_000 : 0,
    },
  };
}

/** The week at the top (what every build has always stored), the other readings in `views`. */
export interface CockpitData extends PeriodView {
  /** ISO timestamp of the build */
  generated: string;
  /** readings by day and by month; absent on older builds */
  views?: Partial<Record<Exclude<PeriodKind, "week">, PeriodView>>;
  /** YYYY-MM the budget pace is read on */
  month: string;
  fx: Record<string, number>;
  fx_note: string;
  /** clients of the sheet with a budget but no readable account */
  unmatched: Array<{ key: string; name: string; platforms: string[] }>;
  partial: boolean;
  warnings: string[];
}

const MODES = new Set(["cpa", "roas", "brand"]);
const asMode = (v: string | null | undefined): AccountMode | null => (v && MODES.has(v) ? (v as AccountMode) : null);

/** Runs `fn` over `items`, `size` at a time, until `deadline`; items not started are returned apart. */
async function pool<T, R>(items: T[], size: number, deadline: number, fn: (item: T) => Promise<R>): Promise<{ done: Map<T, R>; skipped: T[] }> {
  const done = new Map<T, R>();
  const skipped: T[] = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      if (Date.now() > deadline) { skipped.push(items[i]); continue; }
      done.set(items[i], await fn(items[i]));
    }
  }));
  return { done, skipped };
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 160);

/** Attaches to each client the accounts that match its name, without touching what an admin set. */
export async function syncAccounts(clients: SheetClient[], available: AvailableAccount[]): Promise<void> {
  const known = await prisma.cockpitAccount.findMany({ select: { platform: true, accountId: true } });
  const seen = new Set(known.map((k) => `${k.platform}:${k.accountId}`));
  const matched = matchAccounts(clients, available.filter((a) => !seen.has(`${a.platform}:${a.accountId}`)));
  const rows = [...matched.entries()].flatMap(([clientKey, accounts]) =>
    accounts.map((a) => ({ clientKey, platform: a.platform, accountId: a.accountId, name: a.name, currency: a.currency, source: "auto" })));
  if (rows.length) await prisma.cockpitAccount.createMany({ data: rows, skipDuplicates: true });
}

export interface BuildOptions {
  /** epoch ms after which no new account is fetched */
  deadline?: number;
  refresh?: boolean;
  now?: Date;
}

export async function buildCockpit(opts: BuildOptions = {}): Promise<CockpitData> {
  const deadline = opts.deadline ?? Date.now() + 240_000;
  const cal: CockpitCalendar = cockpitCalendar(opts.now);
  const warnings: string[] = [];

  const [lines, fx] = await Promise.all([fetchBudgetSheet(), loadFx()]);
  const sheet = sheetClients(lines, cal.month.key);

  const [meta, google] = await Promise.all([
    listMetaAccounts().catch((e) => { warnings.push(`Liste des comptes Meta indisponible (${errText(e)})`); return [] as AvailableAccount[]; }),
    listGoogleAccounts().catch((e) => { warnings.push(`Liste des comptes Google Ads indisponible (${errText(e)})`); return [] as AvailableAccount[]; }),
  ]);
  const available = [...meta, ...google];
  if (available.length) await syncAccounts(sheet, available);

  const [accounts, overrides, settings] = await Promise.all([
    prisma.cockpitAccount.findMany({ where: { enabled: true } }),
    prisma.cockpitClient.findMany(),
    prisma.accountSetting.findMany({ where: { platform: "meta" }, select: { accountId: true, conversionEvent: true } }),
  ]);
  const override = new Map(overrides.map((o) => [o.key, o]));
  const convEvent = new Map(settings.map((s) => [s.accountId.replace(/^act_/, ""), s.conversionEvent]));
  const availableName = new Map(available.map((a) => [`${a.platform}:${a.accountId}`, a]));

  // One job per account; the client rows are assembled afterwards.
  type Job = { client: SheetClient; account: (typeof accounts)[number]; mode: AccountMode | null };
  const jobs: Job[] = [];
  const bySheet = new Map(sheet.map((c) => [c.key, c]));
  for (const a of accounts) {
    const client = bySheet.get(a.clientKey);
    if (!client || override.get(client.key)?.hidden) continue;
    // Admin choice, then the model known for this client, then the sheet targets.
    const forced = asMode(a.mode) ?? asMode(override.get(client.key)?.kpiMode)
      ?? defaultModeFor(client.key, a.platform === "google" ? "google" : "meta")
      ?? (client.targetRoas ? "roas" : client.targetCpl ? "cpa" : null);
    jobs.push({ client, account: a, mode: forced });
  }

  const read = async (job: Job): Promise<{ series: AccountSeries | null; mode: AccountMode; err: string | null }> => {
    const id = job.account.accountId;
    try {
      if (job.account.platform === "google") {
        const series = await googleSeries(id, cal.fetch, { refresh: opts.refresh });
        // Without a target in the sheet, an account that tracks a value is read in ROAS.
        const mode = job.mode ?? (series.days.reduce((s, d) => s + d.value, 0) > 0 ? "roas" : "cpa");
        return { series, mode, err: null };
      }
      const asRoas = await metaSeries(id, cal.fetch, { mode: "roas", conversionEvent: convEvent.get(id), refresh: opts.refresh });
      const mode = job.mode ?? (asRoas.days.reduce((s, d) => s + d.value, 0) > 0 ? "roas" : "cpa");
      const series = mode === "roas" ? asRoas : await metaSeries(id, cal.fetch, { mode, conversionEvent: convEvent.get(id) });
      return { series, mode, err: null };
    } catch (e) {
      return { series: null, mode: job.mode ?? "cpa", err: errText(e) };
    }
  };

  const { done, skipped } = await pool(jobs, 4, deadline, read);
  if (skipped.length) warnings.push(`${skipped.length} compte(s) non lus dans le temps imparti — relancez l'actualisation pour compléter`);

  // One reading per period, from the same daily rows.
  const assemble = (kind: PeriodKind): PeriodView & { unmatched: CockpitData["unmatched"] } => {
    const periods = cockpitPeriods(kind, cal);
    const inputs: ClientInput[] = [];
    const missing = new Map<string, string[]>();
    const unmatched: CockpitData["unmatched"] = [];
    for (const client of sheet) {
      const o = override.get(client.key);
      if (o?.hidden) continue;
      const mine = jobs.filter((j) => j.client.key === client.key);
      if (!mine.length) {
        const platforms = [client.budget.meta ? "Meta" : null, client.budget.google ? "Google" : null].filter((p): p is string => !!p);
        if (platforms.length) unmatched.push({ key: client.key, name: o?.name ?? client.name, platforms });
        continue;
      }
      const name = o?.name ?? client.name;
      const read: Array<Omit<PlatformInput, "key" | "label" | "budget"> & { rawName: string; custom: string | null; spent: boolean }> = [];
      for (const j of mine) {
        const plat = j.account.platform === "google" ? "google" : "meta";
        const res = done.get(j);
        const live = availableName.get(`${plat}:${j.account.accountId}`);
        const b = res?.series ? bucket(res.series.days, cal) : null;
        read.push({
          plat,
          rawName: live?.name ?? j.account.name,
          custom: j.account.label,
          accountId: j.account.accountId,
          ccy: res?.series?.currency ?? live?.currency ?? j.account.currency ?? client.currency,
          mode: res?.mode ?? j.mode ?? "cpa",
          weeks: res?.series ? bucketRanges(res.series.days, periods.ranges) : [],
          mtd: b ? b.mtd : null,
          err: res ? res.err : "Compte non lu dans le temps imparti",
          // The same accounts in every reading: those that spent over the weeks or the month.
          spent: !!b && (b.weeks.some((w) => w.spend > 0) || b.mtd > 0),
        });
      }
      // Accounts that never spent over the window say nothing: keep them out of the view.
      const kept = read.filter((p) => p.err || p.spent);
      if (!kept.length) {
        const platformsWithBudget = [client.budget.meta ? "Meta" : null, client.budget.google ? "Google" : null].filter((p): p is string => !!p);
        if (platformsWithBudget.length) unmatched.push({ key: client.key, name, platforms: platformsWithBudget });
        continue;
      }
      // The sheet budget is in the sheet currency; the accounts may be in another one.
      const mainCcy = kept.find((p) => !p.err && p.ccy)?.ccy ?? client.currency;
      const convert = (amount: number | null): number | null => {
        if (amount === null || !client.currency || !mainCcy || client.currency === mainCcy) return amount;
        const from = fx.rates[client.currency], to = fx.rates[mainCcy];
        return from && to ? Math.round((amount * from) / to) : amount;
      };
      const budgets = { meta: convert(client.budget.meta), google: convert(client.budget.google) };
      const count = { meta: kept.filter((p) => p.plat === "meta").length, google: kept.filter((p) => p.plat === "google").length };
      const active: PlatformInput[] = kept.map(({ rawName, custom, spent: _spent, ...p }) => ({
        ...p,
        key: count[p.plat] > 1 ? `${p.plat}-${p.accountId}` : p.plat,
        label: custom ?? accountLabel(p.plat, name, rawName, count[p.plat]),
        budget: count[p.plat] === 1 ? budgets[p.plat] : null,
      }));
      const modes = [...new Set(active.filter((p) => !p.err).map((p) => p.mode))];
      const kpi: KpiMode = asMode(o?.kpiMode) ?? (modes.length > 1 ? "mixte" : modes[0] ?? (client.targetRoas ? "roas" : "cpa"));
      // A budget in the sheet for a platform no account of which could be read.
      for (const plat of ["meta", "google"] as const) {
        if (client.budget[plat] && !active.some((p) => p.plat === plat && !p.err)) {
          missing.set(client.key, [...(missing.get(client.key) ?? []), plat === "meta" ? "Meta" : "Google"]);
        }
      }
      inputs.push({
        key: client.key, name, kpi_mode: kpi, team: client.team,
        target_roas: client.targetRoas, target_cpl: client.targetCpl,
        budgets,
        platforms: active,
      });
    }

    const ctx = { fx: fx.rates, month: { elapsed: cal.month.elapsed, days: cal.month.days }, limits: PERIOD_LIMITS[kind] };
    const clients = sortClients(inputs.map((i) => ({ ...buildClient(i, ctx), missing: missing.get(i.key) ?? [] })));
    return { period: kind, w0_label: periods.label, hist_weeks: periods.ranges.length - 1, week_starts: periods.starts, clients, ...totalsOf(clients), unmatched };
  };

  const { unmatched, ...week } = assemble("week");
  const views: CockpitData["views"] = {};
  for (const kind of ["day", "month"] as const) {
    const { unmatched: _unmatched, ...view } = assemble(kind);
    views[kind] = view;
  }
  return {
    generated: new Date().toISOString(),
    ...week,
    views,
    month: cal.month.key,
    fx: fx.rates,
    fx_note: fx.note,
    unmatched,
    partial: skipped.length > 0,
    warnings,
  };
}

const KEEP_SNAPSHOTS = 150;

/** Builds and stores a snapshot; older ones beyond the retention are dropped. */
export async function runCockpitBuild(opts: BuildOptions = {}): Promise<{ id: string; clients: number; partial: boolean; durationMs: number; warnings: string[] }> {
  const started = Date.now();
  const data = await buildCockpit(opts);
  const cal = cockpitCalendar(opts.now);
  const row = await prisma.cockpitSnapshot.create({
    data: {
      weekStart: cal.w0.since,
      status: data.partial ? "partial" : "full",
      clients: data.clients.length,
      dataJson: JSON.stringify(data),
      durationMs: Date.now() - started,
    },
    select: { id: true },
  });
  const old = await prisma.cockpitSnapshot.findMany({ orderBy: { createdAt: "desc" }, skip: KEEP_SNAPSHOTS, select: { id: true } });
  if (old.length) await prisma.cockpitSnapshot.deleteMany({ where: { id: { in: old.map((o) => o.id) } } });
  return { id: row.id, clients: data.clients.length, partial: data.partial, durationMs: Date.now() - started, warnings: data.warnings };
}

export interface EvolutionPoint {
  at: string;
  severity: Severity;
  reason: string;
  spend: number;
  kpi: number | null;
  pace_pts: number | null;
}

/** How each client looked in the previous snapshots (newest first in, oldest first out). */
export function evolutionOf(snapshots: Array<{ createdAt: Date; data: CockpitData }>): Record<string, EvolutionPoint[]> {
  const out: Record<string, EvolutionPoint[]> = {};
  for (const s of [...snapshots].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) {
    for (const c of s.data.clients) {
      (out[c.key] ??= []).push({
        at: s.createdAt.toISOString(),
        severity: c.alert.severity,
        reason: c.alert.reason,
        spend: c.blended.spend,
        kpi: c.blended.kpi,
        pace_pts: c.pacing ? Math.round((c.pacing.pct_spent - c.pacing.pct_month) * 100) : null,
      });
    }
  }
  return out;
}
