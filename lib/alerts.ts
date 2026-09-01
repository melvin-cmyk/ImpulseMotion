import { prisma } from "@/lib/prisma";
import {
  getMetaSystemToken,
  purchasesFor,
  computeRevenue,
  type MetaAccountInsight,
} from "@/lib/meta-api";
import { getAccountInsightsCached } from "@/lib/insights";
import { getAccountProfileSettings } from "@/lib/account-settings";
import { computePacingBatch } from "@/lib/budgets";
import { lastFullDays, prevRange, type DateRange } from "@/lib/date-ranges";

/**
 * Special metric value reserved for the auto-generated budget pacing rule.
 * Rules with this metric are system-managed and hidden from the alert
 * configuration UIs — see `/api/admin/alerts` and `/api/me/alerts`.
 *
 * TODO (Lot F4 follow-up): rules are still attached to a login (userId) +
 * optional raw account id. Redesign them "per dashboard" (Dashboard.id) so a
 * client = an ad account, consistent with the portfolio; the pages only got
 * their empty states fixed for now.
 */
export const BUDGET_PACING_METRIC = "budget_pacing";

export type AlertMetric = "roas" | "spend" | "cpa" | "ctr" | "frequency";
export type AlertCondition = "below" | "above" | "drop_pct";
export type AlertWindow = "1d" | "7d" | "14d" | "30d";

export const METRIC_LABELS: Record<AlertMetric, string> = {
  roas: "ROAS",
  spend: "Dépenses",
  cpa: "CPA",
  ctr: "CTR",
  frequency: "Fréquence",
};

export const CONDITION_LABELS: Record<AlertCondition, string> = {
  below: "en dessous de",
  above: "au-dessus de",
  drop_pct: "chute de plus de",
};

export function windowDays(window: string): number {
  return window === "1d" ? 1 : window === "14d" ? 14 : window === "30d" ? 30 : 7;
}

/** Current window = the N full days ending yesterday (account tz); never a partial day. */
export function windowToRange(window: string, opts: { tz?: string | null; now?: Date } = {}): DateRange {
  return lastFullDays(windowDays(window), opts);
}

/** Previous window of equal length, ending the day before the current one. */
export function prevWindowRange(window: string, opts: { tz?: string | null; now?: Date } = {}): DateRange {
  return prevRange(windowToRange(window, opts));
}

export interface ComputedMetrics {
  spend: number;
  roas: number;
  cpa: number;
  ctr: number;
  frequency: number;
  /** false when revenue is unknown (no tracked value, no AOV) → ROAS rules are skipped. */
  roasAvailable: boolean;
  /** true when ROAS comes from purchases × AOV. */
  roasEstimated: boolean;
  conversions: number;
}

export function computeFromInsight(
  insight: MetaAccountInsight | null,
  settings: { conversionEvent?: string | null; aov?: number | null } = {},
): ComputedMetrics {
  if (!insight) return { spend: 0, roas: 0, cpa: 0, ctr: 0, frequency: 0, roasAvailable: false, roasEstimated: false, conversions: 0 };
  const spend = parseFloat(insight.spend ?? "0") || 0;
  const conversions = purchasesFor(insight, settings.conversionEvent ?? "purchase");
  const rev = computeRevenue(insight, settings.aov ?? null);
  const roasAvailable = !rev.unavailable;
  const roas = roasAvailable && spend > 0 ? Math.round((rev.revenue / spend) * 100) / 100 : 0;
  const cpa = conversions > 0 ? Math.round((spend / conversions) * 100) / 100 : 0;
  const ctr = parseFloat(insight.ctr ?? "0") || 0;
  const frequency = parseFloat(insight.frequency ?? "0") || 0;
  return { spend: Math.round(spend), roas, cpa, ctr, frequency, roasAvailable, roasEstimated: rev.estimated && roasAvailable, conversions };
}

export async function fetchMetricsForAccount(
  accountId: string,
  window: string,
): Promise<{ current: ComputedMetrics; previous: ComputedMetrics; range: DateRange; compare: DateRange }> {
  const token = getMetaSystemToken();
  const settings = await getAccountProfileSettings("meta", accountId);
  const range = windowToRange(window, { tz: settings.timezone });
  const compare = prevRange(range);
  const [currentInsight, previousInsight] = await Promise.all([
    getAccountInsightsCached(token, accountId, range),
    getAccountInsightsCached(token, accountId, compare),
  ]);
  return {
    current: computeFromInsight(currentInsight, settings),
    previous: computeFromInsight(previousInsight, settings),
    range,
    compare,
  };
}

export function evaluateRule(
  metric: AlertMetric,
  condition: AlertCondition,
  threshold: number,
  current: ComputedMetrics,
  previous: ComputedMetrics,
): { triggered: boolean; value: number; message: string; skipped?: string } {
  const v = current[metric];
  // ROAS rules are meaningless when revenue is unknown — skip, never "trigger on 0".
  if (metric === "roas" && !current.roasAvailable) {
    return { triggered: false, value: v, message: "", skipped: "ROAS indisponible (pas de valeur de conversion ni de panier moyen)" };
  }
  if (condition === "below") {
    return {
      triggered: v < threshold && v > 0,
      value: v,
      message: `${METRIC_LABELS[metric]} = ${v} (seuil ${threshold})`,
    };
  }
  if (condition === "above") {
    return {
      triggered: v > threshold,
      value: v,
      message: `${METRIC_LABELS[metric]} = ${v} (seuil ${threshold})`,
    };
  }
  // drop_pct: triggered if value dropped more than threshold% vs previous window
  if (metric === "roas" && !previous.roasAvailable) {
    return { triggered: false, value: v, message: "", skipped: "ROAS période précédente indisponible" };
  }
  const prev = previous[metric];
  if (prev === 0) return { triggered: false, value: v, message: "" };
  const pctChange = ((v - prev) / prev) * 100;
  return {
    triggered: pctChange < -Math.abs(threshold),
    value: Math.round(pctChange * 10) / 10,
    message: `${METRIC_LABELS[metric]} a chuté de ${Math.abs(Math.round(pctChange))}% (${prev} → ${v})`,
  };
}

/** Get or create a per-user system rule that anchors budget pacing events. */
async function getOrCreateBudgetRule(userId: string): Promise<string> {
  const existing = await prisma.alertRule.findFirst({
    where: { userId, metric: BUDGET_PACING_METRIC, clientId: null },
  });
  if (existing) return existing.id;
  const created = await prisma.alertRule.create({
    data: {
      userId,
      metric: BUDGET_PACING_METRIC,
      condition: "critical",
      threshold: 0,
      window: "30d",
      clientId: null,
    },
  });
  return created.id;
}

/**
 * Scan all enabled AccountBudget rows. For accounts whose pacing is
 * critical_under or critical_over, create an AlertEvent (with 23h dedup).
 * Status "unknown" (Meta error / no closed day) NEVER creates an alert.
 */
async function scanBudgetPacing(): Promise<{ scanned: number; triggered: number; unknown: number }> {
  const budgets = await prisma.accountBudget.findMany();
  if (budgets.length === 0) return { scanned: 0, triggered: 0, unknown: 0 };

  const pacing = await computePacingBatch(
    budgets.map((b) => ({
      accountId: b.accountId,
      monthlyTarget: b.monthlyTarget,
      currency: b.currency,
    })),
  );
  const pacingByAccount = new Map(pacing.map((p) => [p.accountId, p]));

  // Cache the per-user system rule id to avoid repeated upserts
  const ruleIdByUser = new Map<string, string>();
  let triggered = 0;
  let unknown = 0;

  for (const b of budgets) {
    const p = pacingByAccount.get(b.accountId);
    if (!p) continue;
    if (p.status === "unknown") { unknown++; continue; }
    if (p.status !== "critical_under" && p.status !== "critical_over") continue;

    const recent = await prisma.alertEvent.findFirst({
      where: {
        userId: b.userId,
        clientId: b.accountId,
        metric: BUDGET_PACING_METRIC,
        triggeredAt: { gte: new Date(Date.now() - 23 * 3600 * 1000) },
      },
    });
    if (recent) continue;

    let ruleId = ruleIdByUser.get(b.userId);
    if (!ruleId) {
      ruleId = await getOrCreateBudgetRule(b.userId);
      ruleIdByUser.set(b.userId, ruleId);
    }

    const direction = p.status === "critical_under" ? "sous-consomme" : "sur-consomme";
    const message = `Le compte ${direction} fortement (pacing ${p.pacingPct}% — projeté ${Math.round(p.projectedSpend)} ${b.currency} vs cible ${Math.round(b.monthlyTarget)} ${b.currency}, J${Math.floor(p.daysElapsed)}/${p.daysInMonth})`;

    await prisma.alertEvent.create({
      data: {
        ruleId,
        userId: b.userId,
        clientId: b.accountId,
        metric: BUDGET_PACING_METRIC,
        value: p.pacingPct,
        threshold: 100,
        message,
      },
    });
    triggered++;
  }

  return { scanned: budgets.length, triggered, unknown };
}

/** Scan all enabled alert rules + budget pacing, persist events for triggers. */
export async function runAlertScan(): Promise<{
  scanned: number;
  triggered: number;
  errors: string[];
  skipped?: string[];
}> {
  const rules = await prisma.alertRule.findMany({
    where: { enabled: true, NOT: { metric: BUDGET_PACING_METRIC } },
  });
  const errors: string[] = [];
  const skipped: string[] = [];
  let triggered = 0;

  // Group rules by account so we hit Meta once per account
  const accountsToFetch = new Set<string>();
  const accountsByUser = new Map<string, string[]>();
  for (const rule of rules) {
    if (rule.clientId) {
      accountsToFetch.add(`${rule.clientId}|${rule.window}`);
    } else {
      const accounts = await prisma.userAdAccount.findMany({
        where: { userId: rule.userId, platform: rule.platform },
        select: { accountId: true },
      });
      const ids = accounts.map((a) => a.accountId);
      accountsByUser.set(rule.userId, ids);
      for (const id of ids) accountsToFetch.add(`${id}|${rule.window}`);
    }
  }

  const metricsCache = new Map<string, { current: ComputedMetrics; previous: ComputedMetrics }>();
  await Promise.all(
    Array.from(accountsToFetch).map(async (key) => {
      const [accountId, window] = key.split("|");
      try {
        const metrics = await fetchMetricsForAccount(accountId, window);
        metricsCache.set(key, metrics);
      } catch (e) {
        errors.push(`${accountId}: ${e instanceof Error ? e.message : "fetch error"}`);
      }
    }),
  );

  for (const rule of rules) {
    const targets = rule.clientId ? [rule.clientId] : accountsByUser.get(rule.userId) ?? [];
    for (const accountId of targets) {
      const metrics = metricsCache.get(`${accountId}|${rule.window}`);
      if (!metrics) continue;
      const result = evaluateRule(
        rule.metric as AlertMetric,
        rule.condition as AlertCondition,
        rule.threshold,
        metrics.current,
        metrics.previous,
      );
      if (result.skipped) skipped.push(`${accountId}/${rule.metric}: ${result.skipped}`);
      if (!result.triggered) continue;
      // Dedup: don't re-fire if same rule+account fired within 23h
      const recent = await prisma.alertEvent.findFirst({
        where: {
          ruleId: rule.id,
          clientId: accountId,
          triggeredAt: { gte: new Date(Date.now() - 23 * 3600 * 1000) },
        },
      });
      if (recent) continue;

      await prisma.alertEvent.create({
        data: {
          ruleId: rule.id,
          userId: rule.userId,
          clientId: accountId,
          metric: rule.metric,
          value: result.value,
          threshold: rule.threshold,
          message: result.message,
        },
      });
      await prisma.alertRule.update({
        where: { id: rule.id },
        data: { lastTriggeredAt: new Date() },
      });
      triggered++;
    }
  }

  // Budget pacing scan: separate path because it joins budgets, not metric rules.
  let budgetScan = { scanned: 0, triggered: 0, unknown: 0 };
  try {
    budgetScan = await scanBudgetPacing();
  } catch (e) {
    errors.push(`budget pacing scan: ${e instanceof Error ? e.message : "unknown"}`);
  }
  if (budgetScan.unknown > 0) skipped.push(`pacing: ${budgetScan.unknown} compte(s) sans donnée (statut inconnu)`);

  return {
    scanned: rules.length + budgetScan.scanned,
    triggered: triggered + budgetScan.triggered,
    errors,
    ...(skipped.length ? { skipped } : {}),
  };
}
