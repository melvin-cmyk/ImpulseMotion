/**
 * Portfolio = one row per CLIENT, where a client is an AD ACCOUNT (a Meta
 * account and/or a Google Ads customer) represented by one or more Dashboard
 * rows — never a login. Feeds /portfolio, /portfolio/[id], /api/changes and
 * the cockpit summary from a single implementation.
 *
 * Rules (Lot F4):
 * - dedup by ACCOUNT: dashboards sharing a metaAccountId OR a googleCustomerId
 *   are one client (union-find), so "meta-only + combined + google-only" for
 *   the same brand collapse to one row; unlinked dashboards are listed apart;
 * - the default window is the last 30 FULL days ending yesterday in the
 *   account timezone (UTC when unknown); the comparison window is the
 *   previous window of equal length;
 * - KPIs come from the same resolvers as the client dashboards
 *   (lib/dashboard-widgets.resolveWidgets) so every surface shows the same
 *   numbers; fetches are cached (KpiCache), `refresh` drops the account cache;
 * - a client whose Meta fetch fails is flagged `fetchOk: false` with a typed
 *   error and EXCLUDED from totals (summary.clientsWithoutData);
 * - totals are per currency (never summed across currencies); ROAS is always
 *   revenue / spend, never an average of ratios; estimated / unavailable
 *   revenue never feeds the attention score;
 * - a global time budget (`deadlineMs`) returns partial results with
 *   `summary.timedOut` + the unresolved clients instead of a 504.
 */

import { prisma } from "@/lib/prisma";
import { resolveWidgets } from "@/lib/dashboard-widgets";
import { computePacing, pickBudget, type PacingResult } from "@/lib/budgets";
import { getAccountProfileSettings } from "@/lib/account-settings";
import { getAccountInsightsCachedWithMeta } from "@/lib/insights";
import { getMetaSystemToken } from "@/lib/meta-api";
import { isMetaApiError, type MetaErrorKind } from "@/lib/meta-errors";
import { describeRange, lastFullDays, prevRange, type DateRange } from "@/lib/date-ranges";

// ── Types ────────────────────────────────────────────────────────────────────

export interface PortfolioKpi {
  value: number;
  previous: number | null;
  deltaPct: number | null;
  /** revenue/roas: value is purchases × AOV */
  estimated?: boolean;
  /** revenue/roas: no tracked value and no AOV → value is meaningless (0) */
  unavailable?: boolean;
}

export type ClientErrorKind = MetaErrorKind | "google" | "widget" | "timeout";

export interface ClientError {
  kind: ClientErrorKind;
  message: string;
}

export interface AttentionSignal {
  code: "roas_drop" | "cpa_up" | "conversions_zero" | "spend_move" | "roas_low" | "frequency" | "alerts" | "pacing";
  label: string;
  before?: number | null;
  after?: number | null;
  deltaPct?: number | null;
  points: number;
}

export interface PortfolioClient {
  /** Primary dashboard id (oldest of the group) — the client's canonical id. */
  id: string;
  name: string;
  metaAccountId: string | null;
  googleCustomerId: string | null;
  reportFrequency: string | null;
  owner: { id: string; name: string | null; email: string | null };
  memberCount: number;
  /** Every dashboard that maps to this client (primary first). */
  dashboardIds: string[];
  /** dashboardIds.length - 1 */
  duplicates: number;
  /** @deprecated use dashboardIds — kept for older consumers */
  duplicateIds: string[];
  range: DateRange;
  compare: DateRange;
  /** ISO 4217 of the KPIs (Meta account currency, else Google), null when unknown. */
  currency: string | null;
  timezone: string | null;
  spend: PortfolioKpi;
  revenue: PortfolioKpi;
  roas: PortfolioKpi;
  cpa: PortfolioKpi;
  conversions: PortfolioKpi;
  /** Meta account frequency over the window, null when unavailable. */
  frequency: number | null;
  estimated: boolean;
  fetchOk: boolean;
  error: ClientError | null;
  errors: string[];
  /** Oldest fetch among the KPIs (ISO), null when nothing was fetched. */
  fetchedAt: string | null;
  alertCount: number;
  lastReport: { id: string; status: string; periodSince: string; periodUntil: string; createdAt: string } | null;
  pacing: PacingResult | null;
  /** 0-100 attention score: spend-weighted negative movements + alerts + pacing drift. */
  attention: number;
  attentionReasons: string[];
  attentionSignals: AttentionSignal[];
}

export interface CurrencyTotals {
  currency: string;
  clientCount: number;
  spend: number;
  /** Previous-window spend over the clients that have BOTH windows (consistent set). */
  prevSpend: number | null;
  /** Current spend over that same consistent set. */
  spendForDelta: number;
  spendDeltaPct: number | null;
  /** Revenue over clients whose revenue is known (not unavailable). */
  revenue: number;
  /** Spend of those same clients — denominator of `roas`. */
  spendWithRevenue: number;
  revenueEstimated: boolean;
  purchases: number;
  /** revenue / spendWithRevenue — never an average of ratios. */
  roas: number | null;
}

export interface PortfolioSummary {
  clientCount: number;
  clientsWithoutData: number;
  unlinkedCount: number;
  totalsByCurrency: Record<string, CurrencyTotals>;
  /** Single-currency convenience: null when clients span several currencies. */
  currency: string | null;
  totalSpend: number | null;
  prevTotalSpend: number | null;
  spendDeltaPct: number | null;
  weightedRoas: number | null;
  openAlerts: number;
  reportsEnabled: number;
  range: DateRange;
  compare: DateRange;
  rangeLabel: string;
  timedOut: boolean;
  unresolved: Array<{ id: string; name: string }>;
  generatedAt: string;
}

export interface PortfolioResult {
  clients: PortfolioClient[];
  unlinked: Array<{ id: string; name: string }>;
  summary: PortfolioSummary;
  range: DateRange;
  rangeLabel: string;
  generatedAt: string;
}

// ── Dedup (union-find by account) ────────────────────────────────────────────

export interface DashboardLike {
  id: string;
  name: string;
  metaAccountId: string | null;
  googleCustomerId: string | null;
  createdAt: Date | string;
}

export interface ClientGroup<T extends DashboardLike> {
  primary: T;
  /** Oldest first (primary included). */
  members: T[];
  metaAccountId: string | null;
  googleCustomerId: string | null;
  dashboardIds: string[];
  duplicates: number;
}

export const normMeta = (id: string) => id.trim().replace(/^act_/, "");
export const normGoogle = (id: string) => id.trim().replace(/-/g, "").replace(/^0+/, "");

const ts = (d: Date | string) => new Date(d).getTime();

/**
 * Groups dashboards that share a Meta account OR a Google customer (transitively).
 * Unlinked dashboards (no account at all) are returned apart.
 */
export function groupDashboardsByAccount<T extends DashboardLike>(rows: T[]): { groups: Array<ClientGroup<T>>; unlinked: T[] } {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    let c = x;
    while (parent.get(c) !== r) { const n = parent.get(c)!; parent.set(c, r); c = n; }
    return r;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
  };

  const unlinked: T[] = [];
  const byMeta = new Map<string, string>();
  const byGoogle = new Map<string, string>();
  const sorted = [...rows].sort((a, b) => ts(a.createdAt) - ts(b.createdAt) || a.id.localeCompare(b.id));
  for (const d of sorted) {
    const meta = d.metaAccountId ? normMeta(d.metaAccountId) : "";
    const google = d.googleCustomerId ? normGoogle(d.googleCustomerId) : "";
    if (!meta && !google) { unlinked.push(d); continue; }
    parent.set(d.id, d.id);
    if (meta) {
      const first = byMeta.get(meta);
      if (first) union(first, d.id); else byMeta.set(meta, d.id);
    }
    if (google) {
      const first = byGoogle.get(google);
      if (first) union(first, d.id); else byGoogle.set(google, d.id);
    }
  }

  const buckets = new Map<string, T[]>();
  for (const d of sorted) {
    if (!parent.has(d.id)) continue;
    const root = find(d.id);
    const list = buckets.get(root) ?? [];
    list.push(d);
    buckets.set(root, list);
  }

  const groups: Array<ClientGroup<T>> = [];
  for (const members of buckets.values()) {
    members.sort((a, b) => ts(a.createdAt) - ts(b.createdAt) || a.id.localeCompare(b.id));
    const primary = members[0];
    const meta = primary.metaAccountId ?? members.find((m) => m.metaAccountId)?.metaAccountId ?? null;
    const google = primary.googleCustomerId ?? members.find((m) => m.googleCustomerId)?.googleCustomerId ?? null;
    groups.push({
      primary,
      members,
      metaAccountId: meta ? normMeta(meta) : null,
      googleCustomerId: google ? normGoogle(google) : null,
      dashboardIds: members.map((m) => m.id),
      duplicates: members.length - 1,
    });
  }
  groups.sort((a, b) => a.primary.name.localeCompare(b.primary.name) || ts(a.primary.createdAt) - ts(b.primary.createdAt));
  return { groups, unlinked };
}

/** @deprecated legacy exact-pair dedup; prefer groupDashboardsByAccount. */
export function dedupeDashboards<T extends DashboardLike>(rows: T[]): Array<T & { duplicateIds: string[] }> {
  const { groups, unlinked } = groupDashboardsByAccount(rows);
  return [
    ...groups.map((g) => ({ ...g.primary, duplicateIds: g.dashboardIds.slice(1) })),
    ...unlinked.map((d) => ({ ...d, duplicateIds: [] as string[] })),
  ];
}

// ── Concurrency with a global deadline ───────────────────────────────────────

async function mapLimitWithDeadline<T, R>(
  items: T[],
  limit: number,
  deadlineAt: number | null,
  fn: (item: T) => Promise<R>,
): Promise<{ results: Array<R | undefined>; timedOut: boolean }> {
  const results: Array<R | undefined> = new Array(items.length);
  let next = 0;
  let timedOut = false;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      if (deadlineAt !== null && Date.now() >= deadlineAt) { timedOut = true; return; }
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  });
  const all = Promise.all(workers).then(() => "done" as const);
  if (deadlineAt === null) {
    await all;
    return { results, timedOut };
  }
  const wait = Math.max(0, deadlineAt - Date.now());
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clock = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), wait); });
  const outcome = await Promise.race([all, clock]);
  if (timer) clearTimeout(timer);
  if (outcome === "timeout") timedOut = true;
  return { results, timedOut };
}

// ── Attention score (pure) ───────────────────────────────────────────────────

export interface AttentionInput {
  fetchOk: boolean;
  spend: PortfolioKpi;
  roas: PortfolioKpi;
  cpa: PortfolioKpi;
  conversions: PortfolioKpi;
  frequency: number | null;
  alertCount: number;
  pacing: Pick<PacingResult, "status" | "pacingPct"> | null;
}

const MIN_CONVERSIONS_FOR_RATIO = 10;
const fmtNum = (n: number, digits = 0) => n.toLocaleString("fr-FR", { maximumFractionDigits: digits });

export function attentionScore(c: AttentionInput): { score: number; reasons: string[]; signals: AttentionSignal[] } {
  const signals: AttentionSignal[] = [];
  if (!c.fetchOk) return { score: 0, reasons: [], signals };

  const roasUsable = !c.roas.unavailable && !c.roas.estimated;
  const enoughPrevConv = (c.conversions.previous ?? 0) >= MIN_CONVERSIONS_FOR_RATIO;

  // Conversions collapsed to zero while still spending → critical.
  if (c.conversions.value === 0 && (c.conversions.previous ?? 0) > 0 && c.spend.value > 100) {
    signals.push({
      code: "conversions_zero",
      label: `Conversions ${fmtNum(c.conversions.previous!)} → 0 (${fmtNum(c.spend.value)} dépensés)`,
      before: c.conversions.previous, after: 0, deltaPct: -100, points: 40,
    });
  }

  if (roasUsable && enoughPrevConv && c.roas.deltaPct !== null && c.roas.previous !== null && c.roas.previous > 0.5) {
    const drop = -c.roas.deltaPct;
    if (drop >= 15) {
      signals.push({
        code: "roas_drop",
        label: `ROAS ${c.roas.previous.toFixed(2)}x → ${c.roas.value.toFixed(2)}x (${c.roas.deltaPct.toFixed(0)} %)`,
        before: c.roas.previous, after: c.roas.value, deltaPct: c.roas.deltaPct, points: Math.min(40, Math.round(drop)),
      });
    }
  }

  if (enoughPrevConv && c.cpa.deltaPct !== null && c.cpa.previous && c.cpa.previous > 0 && c.cpa.value > 0 && c.cpa.deltaPct >= 20) {
    signals.push({
      code: "cpa_up",
      label: `CPA ${fmtNum(c.cpa.previous, 2)} → ${fmtNum(c.cpa.value, 2)} (+${c.cpa.deltaPct.toFixed(0)} %)`,
      before: c.cpa.previous, after: c.cpa.value, deltaPct: c.cpa.deltaPct, points: Math.min(30, Math.round(c.cpa.deltaPct / 2)),
    });
  }

  if (c.spend.deltaPct !== null && Math.abs(c.spend.deltaPct) >= 40 && (c.spend.previous ?? 0) > 100) {
    const sign = c.spend.deltaPct > 0 ? "+" : "";
    signals.push({
      code: "spend_move",
      label: `Dépenses ${fmtNum(c.spend.previous!)} → ${fmtNum(c.spend.value)} (${sign}${c.spend.deltaPct.toFixed(0)} %)`,
      before: c.spend.previous, after: c.spend.value, deltaPct: c.spend.deltaPct, points: 20,
    });
  }

  if (roasUsable && enoughPrevConv && c.roas.value > 0 && c.roas.value < 1 && c.spend.value > 200) {
    signals.push({
      code: "roas_low",
      label: `ROAS ${c.roas.value.toFixed(2)}x < 1`,
      before: c.roas.previous, after: c.roas.value, deltaPct: c.roas.deltaPct, points: 25,
    });
  }

  if (c.frequency !== null && c.frequency > 4) {
    signals.push({
      code: "frequency",
      label: `Fréquence ${c.frequency.toFixed(1)} > 4`,
      after: c.frequency, points: 15,
    });
  }

  if (c.alertCount > 0) {
    signals.push({
      code: "alerts",
      label: `${c.alertCount} alerte${c.alertCount > 1 ? "s" : ""} ouverte${c.alertCount > 1 ? "s" : ""}`,
      after: c.alertCount, points: Math.min(20, c.alertCount * 10),
    });
  }

  if (c.pacing && c.pacing.status.startsWith("critical")) {
    signals.push({
      code: "pacing",
      label: `Pacing ${c.pacing.pacingPct} %`,
      after: c.pacing.pacingPct, points: 20,
    });
  }

  const score = Math.min(100, signals.reduce((s, x) => s + x.points, 0));
  return { score, reasons: signals.map((s) => s.label), signals };
}

// ── Summary (pure) ───────────────────────────────────────────────────────────

const round2 = (n: number) => Math.round(n * 100) / 100;

export function totalsByCurrency(clients: PortfolioClient[]): Record<string, CurrencyTotals> {
  const out: Record<string, CurrencyTotals> = {};
  for (const c of clients) {
    if (!c.fetchOk) continue;
    const code = c.currency ?? "unknown";
    const t = (out[code] ??= {
      currency: code, clientCount: 0, spend: 0, prevSpend: null, spendForDelta: 0, spendDeltaPct: null,
      revenue: 0, spendWithRevenue: 0, revenueEstimated: false, purchases: 0, roas: null,
    });
    t.clientCount++;
    t.spend += c.spend.value;
    t.purchases += c.conversions.value;
    if (c.spend.previous !== null) {
      t.prevSpend = (t.prevSpend ?? 0) + c.spend.previous;
      t.spendForDelta += c.spend.value;
    }
    if (!c.revenue.unavailable) {
      t.revenue += c.revenue.value;
      t.spendWithRevenue += c.spend.value;
      if (c.revenue.estimated) t.revenueEstimated = true;
    }
  }
  for (const t of Object.values(out)) {
    t.spend = round2(t.spend);
    t.spendForDelta = round2(t.spendForDelta);
    t.prevSpend = t.prevSpend !== null ? round2(t.prevSpend) : null;
    t.spendDeltaPct = t.prevSpend !== null && t.prevSpend > 0 ? Math.round(((t.spendForDelta - t.prevSpend) / t.prevSpend) * 1000) / 10 : null;
    t.revenue = round2(t.revenue);
    t.spendWithRevenue = round2(t.spendWithRevenue);
    t.roas = t.spendWithRevenue > 0 ? round2(t.revenue / t.spendWithRevenue) : null;
    t.purchases = Math.round(t.purchases);
  }
  return out;
}

export function summarize(
  clients: PortfolioClient[],
  extra: { unlinkedCount: number; openAlerts: number; range: DateRange; compare: DateRange; timedOut: boolean; unresolved: Array<{ id: string; name: string }>; now?: Date },
): PortfolioSummary {
  const totals = totalsByCurrency(clients);
  const codes = Object.keys(totals);
  const single = codes.length === 1 && codes[0] !== "unknown" ? totals[codes[0]] : null;
  return {
    clientCount: clients.length,
    clientsWithoutData: clients.filter((c) => !c.fetchOk).length,
    unlinkedCount: extra.unlinkedCount,
    totalsByCurrency: totals,
    currency: single?.currency ?? null,
    totalSpend: single ? single.spend : null,
    prevTotalSpend: single ? single.prevSpend : null,
    spendDeltaPct: single ? single.spendDeltaPct : null,
    weightedRoas: single ? single.roas : null,
    openAlerts: extra.openAlerts,
    reportsEnabled: clients.filter((c) => c.reportFrequency).length,
    range: extra.range,
    compare: extra.compare,
    rangeLabel: describeRange(extra.range, { now: extra.now }).label,
    timedOut: extra.timedOut,
    unresolved: extra.unresolved,
    generatedAt: (extra.now ?? new Date()).toISOString(),
  };
}

// ── Cache invalidation (refresh=1) ───────────────────────────────────────────

/** Drops every KpiCache row keyed on one of the given account ids (Meta and Google). */
export async function invalidateAccountCache(accountIds: Array<string | null | undefined>): Promise<void> {
  const ids = [...new Set(accountIds.filter((x): x is string => !!x).map((x) => x.replace(/^act_/, "")))];
  if (ids.length === 0) return;
  try {
    await prisma.kpiCache.deleteMany({
      where: { OR: ids.flatMap((id) => [{ key: { contains: `:${id}:` } }, { key: { contains: `:act_${id}:` } }]) },
    });
  } catch {
    // best effort — a stale cache is better than a failed refresh
  }
}

// ── Client listing (no KPI) ──────────────────────────────────────────────────

export interface PortfolioClientRef {
  id: string;
  name: string;
  metaAccountId: string | null;
  googleCustomerId: string | null;
  dashboardIds: string[];
  duplicates: number;
  ownerId: string;
}

/** Deduped clients without any KPI fetch — for /api/changes and the client sheet. */
export async function listPortfolioClients(): Promise<{ clients: PortfolioClientRef[]; unlinked: Array<{ id: string; name: string }> }> {
  const rows = await prisma.dashboard.findMany({
    select: { id: true, name: true, userId: true, metaAccountId: true, googleCustomerId: true, createdAt: true },
  });
  const { groups, unlinked } = groupDashboardsByAccount(rows);
  return {
    clients: groups.map((g) => ({
      id: g.primary.id,
      name: g.primary.name,
      metaAccountId: g.metaAccountId,
      googleCustomerId: g.googleCustomerId,
      dashboardIds: g.dashboardIds,
      duplicates: g.duplicates,
      ownerId: g.primary.userId,
    })),
    unlinked: unlinked.map((d) => ({ id: d.id, name: d.name })),
  };
}

// ── Main loader ──────────────────────────────────────────────────────────────

const KPI_METRICS = ["spend", "revenue", "roas", "cpa", "purchases"] as const;
const CONCURRENCY = 4;

export interface LoadPortfolioOptions {
  /** Explicit window; omitted → last 30 full days in each account's timezone. */
  range?: DateRange | null;
  compare?: DateRange | null;
  refresh?: boolean;
  /** Global time budget in ms (partial results + summary.timedOut when hit). */
  deadlineMs?: number;
  now?: Date;
}

function emptyKpi(): PortfolioKpi {
  return { value: 0, previous: null, deltaPct: null };
}

export function toClientError(e: unknown): ClientError {
  if (isMetaApiError(e)) return { kind: e.kind, message: e.message };
  const message = e instanceof Error ? e.message : String(e);
  if (/google/i.test(message)) return { kind: "google", message };
  return { kind: "widget", message };
}

const minIso = (a: string | null, b: string | null | undefined) => (!b ? a : !a ? b : a < b ? a : b);

export async function loadPortfolio(opts: LoadPortfolioOptions = {}): Promise<PortfolioResult> {
  const now = opts.now ?? new Date();
  const started = Date.now();
  const deadlineAt = opts.deadlineMs ? started + opts.deadlineMs : null;

  const [rows, openAlerts, budgets] = await Promise.all([
    prisma.dashboard.findMany({
      include: {
        user: { select: { id: true, name: true, email: true } },
        _count: { select: { members: true } },
        reports: { orderBy: { createdAt: "desc" }, take: 1, select: { id: true, status: true, periodSince: true, periodUntil: true, createdAt: true } },
      },
    }),
    prisma.alertEvent.findMany({ where: { acknowledged: false }, select: { clientId: true } }),
    prisma.accountBudget.findMany({ where: { platform: "meta" }, orderBy: { createdAt: "asc" } }),
  ]);

  const alertsByAccount = new Map<string, number>();
  for (const a of openAlerts) {
    const key = a.clientId.replace(/^act_/, "");
    alertsByAccount.set(key, (alertsByAccount.get(key) ?? 0) + 1);
  }
  const budgetsByAccount = new Map<string, Array<{ monthlyTarget: number; currency: string }>>();
  for (const b of budgets) {
    const key = b.accountId.replace(/^act_/, "");
    const list = budgetsByAccount.get(key) ?? [];
    list.push({ monthlyTarget: b.monthlyTarget, currency: b.currency });
    budgetsByAccount.set(key, list);
  }

  const { groups, unlinked } = groupDashboardsByAccount(rows);
  const token = (() => { try { return getMetaSystemToken(); } catch { return ""; } })();

  const { results, timedOut } = await mapLimitWithDeadline(groups, CONCURRENCY, deadlineAt, async (g): Promise<PortfolioClient> => {
    const d = g.primary;
    const memberCount = g.members.reduce((s, m) => s + m._count.members, 0);
    const lastReportRow = g.members.map((m) => m.reports[0]).filter(Boolean).sort((a, b) => b!.createdAt.getTime() - a!.createdAt.getTime())[0] ?? null;
    const reportFrequency = g.members.find((m) => m.reportFrequency)?.reportFrequency ?? null;

    // Account profile (timezone / currency) → window in the account timezone.
    let timezone: string | null = null;
    let currency: string | null = null;
    if (g.metaAccountId) {
      try {
        const p = await getAccountProfileSettings("meta", g.metaAccountId);
        timezone = p.timezone;
        currency = p.currency;
      } catch { /* UTC fallback */ }
    }
    const range = opts.range ?? lastFullDays(30, { tz: timezone, now });
    const compare = opts.compare ?? prevRange(range);

    const base: PortfolioClient = {
      id: d.id,
      name: d.name,
      metaAccountId: g.metaAccountId,
      googleCustomerId: g.googleCustomerId,
      reportFrequency,
      owner: d.user,
      memberCount,
      dashboardIds: g.dashboardIds,
      duplicates: g.duplicates,
      duplicateIds: g.dashboardIds.slice(1),
      range,
      compare,
      currency,
      timezone,
      spend: emptyKpi(), revenue: emptyKpi(), roas: emptyKpi(), cpa: emptyKpi(), conversions: emptyKpi(),
      frequency: null,
      estimated: false,
      fetchOk: false,
      error: null,
      errors: [],
      fetchedAt: null,
      alertCount: (g.metaAccountId ? alertsByAccount.get(g.metaAccountId) ?? 0 : 0) + (g.googleCustomerId ? alertsByAccount.get(g.googleCustomerId) ?? 0 : 0),
      lastReport: lastReportRow ? { ...lastReportRow, createdAt: lastReportRow.createdAt.toISOString() } : null,
      pacing: null,
      attention: 0,
      attentionReasons: [],
      attentionSignals: [],
    };

    if (opts.refresh) await invalidateAccountCache([g.metaAccountId, g.googleCustomerId]);

    // 1) Meta account insight first: typed errors (rate_limit / auth / permission),
    //    frequency, currency and fetchedAt. The same cache key feeds resolveWidgets.
    if (g.metaAccountId) {
      try {
        const cur = await getAccountInsightsCachedWithMeta(token, g.metaAccountId, range, { refresh: opts.refresh });
        base.fetchedAt = cur.fetchedAt;
        if (cur.data.currency) base.currency = cur.data.currency;
        const freq = parseFloat(cur.data.frequency ?? "");
        base.frequency = cur.data.hasData !== false && Number.isFinite(freq) && freq > 0 ? Math.round(freq * 100) / 100 : null;
        // Previous window is best effort (comparison only).
        await getAccountInsightsCachedWithMeta(token, g.metaAccountId, compare, { refresh: opts.refresh }).catch(() => null);
      } catch (e) {
        base.error = toClientError(e);
        base.errors.push(base.error.message);
        const att = attentionScore(base);
        return { ...base, attention: att.score, attentionReasons: att.reasons, attentionSignals: att.signals };
      }
    }

    // 2) Same resolvers as the client dashboards (combined when both platforms are bound).
    const source = g.metaAccountId && g.googleCustomerId ? "combined" : g.googleCustomerId && !g.metaAccountId ? "google" : "meta";
    try {
      const resolved = await resolveWidgets(
        { id: d.id, userId: d.userId, metaAccountId: g.metaAccountId, googleCustomerId: g.googleCustomerId },
        KPI_METRICS.map((metric, i) => ({ id: metric, type: "kpi", title: null, width: "third", position: i, config: JSON.stringify({ metric, source }) })),
        range.since,
        range.until,
        { ...compare, kind: "prev" },
      );
      let okCount = 0;
      for (const r of resolved) {
        if (r.error) { base.errors.push(`${r.id}: ${r.error}`); continue; }
        okCount++;
        const data = r.data as { value: number; previous: number | null; deltaPct: number | null; estimated?: boolean; unavailable?: boolean; currency?: string; fetchedAt?: string; partial?: boolean; errors?: string[] };
        const kpi: PortfolioKpi = { value: data.value, previous: data.previous, deltaPct: data.deltaPct };
        if (data.estimated) { kpi.estimated = true; base.estimated = true; }
        if (data.unavailable) kpi.unavailable = true;
        if (data.currency && !base.currency) base.currency = data.currency;
        if (data.partial && data.errors) base.errors.push(...data.errors.map((m) => `${r.id}: ${m}`));
        base.fetchedAt = minIso(base.fetchedAt, data.fetchedAt);
        if (r.id === "spend") base.spend = kpi;
        else if (r.id === "revenue") base.revenue = kpi;
        else if (r.id === "roas") base.roas = kpi;
        else if (r.id === "cpa") base.cpa = kpi;
        else if (r.id === "purchases") base.conversions = kpi;
      }
      const spendWidget = resolved.find((r) => r.id === "spend");
      base.fetchOk = okCount > 0 && !!spendWidget && !spendWidget.error;
      if (!base.fetchOk) {
        const first = resolved.find((r) => r.error)?.error ?? "Aucune donnée";
        base.error = { kind: source === "google" ? "google" : "widget", message: first };
      }
    } catch (e) {
      base.error = toClientError(e);
      base.errors.push(base.error.message);
      base.fetchOk = false;
    }

    // 3) Budget pacing: Dashboard.monthlyBudget first, then any AccountBudget for the account.
    if (g.metaAccountId) {
      const choice = pickBudget(g.members, budgetsByAccount.get(g.metaAccountId) ?? [], base.currency);
      if (choice) {
        base.pacing = await computePacing(g.metaAccountId, choice.monthlyTarget, choice.currency, {
          tz: timezone, now, refresh: opts.refresh, source: choice.source,
        }).catch(() => null);
      }
    }

    const att = attentionScore(base);
    return { ...base, attention: att.score, attentionReasons: att.reasons, attentionSignals: att.signals };
  });

  const clients: PortfolioClient[] = [];
  const unresolved: Array<{ id: string; name: string }> = [];
  groups.forEach((g, i) => {
    const r = results[i];
    if (r) clients.push(r);
    else unresolved.push({ id: g.primary.id, name: g.primary.name });
  });
  clients.sort((a, b) => b.spend.value - a.spend.value || a.name.localeCompare(b.name));

  const range = opts.range ?? lastFullDays(30, { now });
  const compare = opts.compare ?? prevRange(range);
  const unlinkedOut = unlinked.map((d) => ({ id: d.id, name: d.name }));
  const summary = summarize(clients, {
    unlinkedCount: unlinkedOut.length,
    openAlerts: openAlerts.length,
    range,
    compare,
    timedOut,
    unresolved,
    now,
  });

  return {
    clients,
    unlinked: unlinkedOut,
    summary,
    range,
    rangeLabel: summary.rangeLabel,
    generatedAt: summary.generatedAt,
  };
}

/** Default portfolio window: last 30 full days ending yesterday (account tz when known). */
export function defaultPortfolioRange(opts: { tz?: string | null; now?: Date } = {}): DateRange {
  return lastFullDays(30, opts);
}
