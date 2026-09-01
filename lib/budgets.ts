/**
 * Monthly budget pacing for a Meta ad account.
 *
 * Rules (Lot F4):
 * - the month is computed in the ACCOUNT timezone (Meta interprets since/until
 *   in that timezone), UTC when unknown;
 * - daysElapsed = fully elapsed days (yesterday-based) + the fraction of the
 *   current day, so J0.6 on the 1st and J4.6 in the afternoon of the 5th;
 * - MTD spend only covers CLOSED days (1st → yesterday): never a partial day,
 *   so the window is cacheable 24 h and the run-rate is spend / fullDays;
 * - a Meta error (or no closed day yet) yields status "unknown" — never a
 *   fake "under" that would trigger alerts;
 * - budget precedence: Dashboard.monthlyBudget first, then any AccountBudget
 *   row for the account (whatever the owner).
 */

import { prisma } from "@/lib/prisma";
import { getMetaSystemToken } from "@/lib/meta-api";
import { getAccountInsightsCachedWithMeta } from "@/lib/insights";
import { getAccountProfileSettings } from "@/lib/account-settings";
import { addDays, todayIn } from "@/lib/date-ranges";

export type PacingStatus = "on_track" | "under" | "over" | "critical_under" | "critical_over" | "unknown";

export interface PacingResult {
  accountId: string;
  monthlyTarget: number;
  currency: string;
  mtdSpend: number;
  /** Fully elapsed days + fraction of today (e.g. 4.6). */
  daysElapsed: number;
  daysInMonth: number;
  daysRemaining: number;
  dailyRunRate: number;
  projectedSpend: number;
  pacingPct: number; // 100 = on track, <100 = under, >100 = over
  status: PacingStatus;
  /** Set when status is "unknown" (Meta error, no closed day yet). */
  reason?: string;
  /** Where the target comes from. */
  source?: "dashboard" | "account_budget";
  /** ISO timestamp of the MTD spend fetch (cache aware). */
  fetchedAt?: string;
}

export function classify(pacingPct: number): Exclude<PacingStatus, "unknown"> {
  if (pacingPct < 70) return "critical_under";
  if (pacingPct < 90) return "under";
  if (pacingPct > 130) return "critical_over";
  if (pacingPct > 110) return "over";
  return "on_track";
}

export interface MonthProgress {
  /** YYYY-MM-DD of the 1st of the current month (account tz). */
  first: string;
  /** Last closed day (yesterday) — may be before `first` on the 1st. */
  lastClosed: string;
  daysInMonth: number;
  /** Closed days since the 1st (0 on the 1st). */
  fullDays: number;
  /** fullDays + fraction of the current day. */
  daysElapsed: number;
}

/** Hour-of-day (0-23.99) of `now` in the given timezone, UTC fallback. */
function hourIn(tz: string | null | undefined, now: Date): number {
  if (tz) {
    try {
      const parts = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(now);
      const h = Number(parts.find((p) => p.type === "hour")?.value ?? NaN);
      const m = Number(parts.find((p) => p.type === "minute")?.value ?? NaN);
      if (Number.isFinite(h) && Number.isFinite(m)) return (h % 24) + m / 60;
    } catch {
      // invalid tz → UTC
    }
  }
  return now.getUTCHours() + now.getUTCMinutes() / 60;
}

/** Pure: progress through the current month in the account timezone. */
export function monthProgress(opts: { tz?: string | null; now?: Date } = {}): MonthProgress {
  const now = opts.now ?? new Date();
  const today = todayIn(opts.tz, now);
  const first = `${today.slice(0, 7)}-01`;
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const fullDays = Number(today.slice(8, 10)) - 1;
  const fraction = hourIn(opts.tz, now) / 24;
  return {
    first,
    lastClosed: addDays(today, -1),
    daysInMonth,
    fullDays,
    daysElapsed: Math.round((fullDays + fraction) * 100) / 100,
  };
}

/** Pure: projection from MTD spend over closed days. */
export function projectPacing(
  input: { monthlyTarget: number; mtdSpend: number; progress: MonthProgress },
): Pick<PacingResult, "dailyRunRate" | "projectedSpend" | "pacingPct" | "status" | "daysRemaining"> {
  const { monthlyTarget, mtdSpend, progress } = input;
  const daysRemaining = Math.max(0, progress.daysInMonth - progress.fullDays);
  if (progress.fullDays < 1) {
    return { dailyRunRate: 0, projectedSpend: 0, pacingPct: 0, status: "unknown", daysRemaining };
  }
  const dailyRunRate = mtdSpend / progress.fullDays;
  const projectedSpend = mtdSpend + dailyRunRate * daysRemaining;
  const pacingPct = monthlyTarget > 0 ? Math.round((projectedSpend / monthlyTarget) * 100) : 0;
  return {
    dailyRunRate: Math.round(dailyRunRate * 100) / 100,
    projectedSpend: Math.round(projectedSpend),
    pacingPct,
    status: monthlyTarget > 0 ? classify(pacingPct) : "unknown",
    daysRemaining,
  };
}

export interface BudgetChoice {
  monthlyTarget: number;
  currency: string;
  source: "dashboard" | "account_budget";
}

/**
 * Pure precedence: a Dashboard.monthlyBudget (oldest dashboard first) wins over
 * any AccountBudget row. `fallbackCurrency` = account currency when the budget
 * has none.
 */
export function pickBudget(
  dashboards: Array<{ monthlyBudget: number | null; budgetCurrency: string | null; createdAt?: Date | string }>,
  accountBudgets: Array<{ monthlyTarget: number; currency: string }>,
  fallbackCurrency?: string | null,
): BudgetChoice | null {
  const withBudget = dashboards
    .filter((d) => typeof d.monthlyBudget === "number" && d.monthlyBudget > 0)
    .sort((a, b) => new Date(a.createdAt ?? 0).getTime() - new Date(b.createdAt ?? 0).getTime());
  if (withBudget.length > 0) {
    const d = withBudget[0];
    return { monthlyTarget: d.monthlyBudget as number, currency: d.budgetCurrency || fallbackCurrency || "EUR", source: "dashboard" };
  }
  const b = accountBudgets.find((x) => x.monthlyTarget > 0);
  if (b) return { monthlyTarget: b.monthlyTarget, currency: b.currency || fallbackCurrency || "EUR", source: "account_budget" };
  return null;
}

const normId = (id: string) => id.replace(/^act_/, "");

/** DB lookup with the same precedence as the portfolio (Dashboard budget → AccountBudget). */
export async function findBudgetForMetaAccount(accountId: string, fallbackCurrency?: string | null): Promise<BudgetChoice | null> {
  const id = normId(accountId);
  const [dashboards, budgets] = await Promise.all([
    prisma.dashboard.findMany({
      where: { OR: [{ metaAccountId: id }, { metaAccountId: `act_${id}` }], monthlyBudget: { not: null } },
      select: { monthlyBudget: true, budgetCurrency: true, createdAt: true },
    }),
    prisma.accountBudget.findMany({
      where: { platform: "meta", OR: [{ accountId: id }, { accountId: `act_${id}` }] },
      orderBy: { createdAt: "asc" },
      select: { monthlyTarget: true, currency: true },
    }),
  ]);
  return pickBudget(dashboards, budgets, fallbackCurrency);
}

export interface ComputePacingOptions {
  /** Account timezone (IANA); resolved from the account profile when omitted. */
  tz?: string | null;
  now?: Date;
  refresh?: boolean;
  source?: BudgetChoice["source"];
}

export async function computePacing(
  accountId: string,
  monthlyTarget: number,
  currency = "EUR",
  opts: ComputePacingOptions = {},
): Promise<PacingResult> {
  let tz = opts.tz;
  if (tz === undefined) {
    try {
      tz = (await getAccountProfileSettings("meta", accountId)).timezone;
    } catch {
      tz = null;
    }
  }
  const progress = monthProgress({ tz, now: opts.now });
  const base = {
    accountId,
    monthlyTarget,
    currency,
    daysElapsed: progress.daysElapsed,
    daysInMonth: progress.daysInMonth,
    ...(opts.source ? { source: opts.source } : {}),
  };

  if (progress.fullDays < 1) {
    return {
      ...base,
      mtdSpend: 0,
      daysRemaining: progress.daysInMonth,
      dailyRunRate: 0,
      projectedSpend: 0,
      pacingPct: 0,
      status: "unknown",
      reason: "Aucune journée complète ce mois-ci",
    };
  }

  let mtdSpend = 0;
  let fetchedAt: string | undefined;
  try {
    const token = getMetaSystemToken();
    const res = await getAccountInsightsCachedWithMeta(
      token,
      accountId,
      { since: progress.first, until: progress.lastClosed },
      { refresh: opts.refresh },
    );
    mtdSpend = parseFloat(res.data.spend ?? "0") || 0;
    fetchedAt = res.fetchedAt;
  } catch (e) {
    return {
      ...base,
      mtdSpend: 0,
      daysRemaining: Math.max(0, progress.daysInMonth - progress.fullDays),
      dailyRunRate: 0,
      projectedSpend: 0,
      pacingPct: 0,
      status: "unknown",
      reason: e instanceof Error ? e.message : String(e),
    };
  }

  const proj = projectPacing({ monthlyTarget, mtdSpend, progress });
  return {
    ...base,
    mtdSpend: Math.round(mtdSpend),
    ...proj,
    ...(fetchedAt ? { fetchedAt } : {}),
  };
}

/** Compute pacing for many accounts in parallel (never throws: errors → status "unknown"). */
export async function computePacingBatch(
  budgets: Array<{ accountId: string; monthlyTarget: number; currency: string }>,
  opts: Pick<ComputePacingOptions, "refresh" | "now"> = {},
): Promise<PacingResult[]> {
  return Promise.all(
    budgets.map((b) => computePacing(b.accountId, b.monthlyTarget, b.currency, opts).catch((e): PacingResult => ({
      accountId: b.accountId,
      monthlyTarget: b.monthlyTarget,
      currency: b.currency,
      mtdSpend: 0,
      daysElapsed: 0,
      daysInMonth: 30,
      daysRemaining: 30,
      dailyRunRate: 0,
      projectedSpend: 0,
      pacingPct: 0,
      status: "unknown",
      reason: e instanceof Error ? e.message : String(e),
    }))),
  );
}
