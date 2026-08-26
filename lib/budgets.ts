import { getMetaSystemToken } from "@/lib/meta-api";
import { getAccountInsightsCached } from "@/lib/insights";

export interface PacingResult {
  accountId: string;
  monthlyTarget: number;
  currency: string;
  mtdSpend: number;
  daysElapsed: number;
  daysInMonth: number;
  daysRemaining: number;
  dailyRunRate: number;
  projectedSpend: number;
  pacingPct: number; // 100 = on track, <100 = under, >100 = over
  status: "on_track" | "under" | "over" | "critical_under" | "critical_over";
}

const MS_PER_DAY = 24 * 3600 * 1000;

function monthBounds(date = new Date()): { start: Date; end: Date; daysInMonth: number } {
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  const end = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0, 23, 59, 59));
  const daysInMonth = end.getUTCDate();
  return { start, end, daysInMonth };
}

function fmt(d: Date): string {
  return d.toISOString().split("T")[0];
}

function classify(pacingPct: number): PacingResult["status"] {
  if (pacingPct < 70) return "critical_under";
  if (pacingPct < 90) return "under";
  if (pacingPct > 130) return "critical_over";
  if (pacingPct > 110) return "over";
  return "on_track";
}

export async function computePacing(
  accountId: string,
  monthlyTarget: number,
  currency = "EUR",
): Promise<PacingResult> {
  const now = new Date();
  const { start, end, daysInMonth } = monthBounds(now);
  // Cap daysElapsed at daysInMonth; never zero (avoid /0)
  const daysElapsed = Math.max(
    1,
    Math.min(daysInMonth, Math.ceil((now.getTime() - start.getTime()) / MS_PER_DAY)),
  );
  const daysRemaining = Math.max(0, daysInMonth - daysElapsed);

  const token = getMetaSystemToken();
  const insight = await getAccountInsightsCached(token, accountId, {
    since: fmt(start),
    until: fmt(now > end ? end : now),
  }).catch(() => null);

  const mtdSpend = parseFloat(insight?.spend ?? "0");
  const dailyRunRate = mtdSpend / daysElapsed;
  const projectedSpend = mtdSpend + dailyRunRate * daysRemaining;
  const pacingPct = monthlyTarget > 0 ? Math.round((projectedSpend / monthlyTarget) * 100) : 0;

  return {
    accountId,
    monthlyTarget,
    currency,
    mtdSpend: Math.round(mtdSpend),
    daysElapsed,
    daysInMonth,
    daysRemaining,
    dailyRunRate: Math.round(dailyRunRate * 100) / 100,
    projectedSpend: Math.round(projectedSpend),
    pacingPct,
    status: classify(pacingPct),
  };
}

/** Compute pacing for many accounts in parallel. */
export async function computePacingBatch(
  budgets: Array<{ accountId: string; monthlyTarget: number; currency: string }>,
): Promise<PacingResult[]> {
  return Promise.all(
    budgets.map((b) => computePacing(b.accountId, b.monthlyTarget, b.currency).catch(() => ({
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
      status: "under" as const,
    }))),
  );
}
