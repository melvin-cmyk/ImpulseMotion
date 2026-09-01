/**
 * GET /api/cockpit?since&until&refresh=1 → staff: today's view — portfolio
 * summary (per currency), clients that need attention, open alerts, budget
 * pacing, recent AI reports, and the configuration counters the empty states
 * need (alert rules, budgets). Everything is keyed by CLIENT (= ad account),
 * never by login.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireStaff } from "@/lib/auth-helpers";
import { prisma } from "@/lib/prisma";
import { loadPortfolio } from "@/lib/portfolio";
import { BUDGET_PACING_METRIC } from "@/lib/alerts";
import { validateRange, type DateRange } from "@/lib/date-ranges";

export const maxDuration = 120;
const TIME_BUDGET_MS = 100_000;

export async function GET(req: NextRequest) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const headers = { "Cache-Control": "no-store" };

  const params = req.nextUrl.searchParams;
  let range: DateRange | null = null;
  if (params.get("since") || params.get("until")) {
    const v = validateRange(params.get("since"), params.get("until"));
    if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400, headers });
    range = v.range;
  }
  const refresh = params.get("refresh") === "1";

  const [portfolio, openAlerts, recentReportRows, alertRules, accountBudgets, dashboardBudgets] = await Promise.all([
    loadPortfolio({ range, refresh, deadlineMs: TIME_BUDGET_MS }),
    prisma.alertEvent.findMany({
      where: { acknowledged: false },
      orderBy: { triggeredAt: "desc" },
      take: 20,
      select: {
        id: true, ruleId: true, userId: true, clientId: true, metric: true, value: true, threshold: true,
        message: true, acknowledged: true, triggeredAt: true, recommendations: true,
        rule: { select: { metric: true, condition: true, threshold: true, window: true } },
      },
    }),
    prisma.clientReport.findMany({
      orderBy: { createdAt: "desc" },
      take: 10,
      select: {
        id: true, title: true, status: true, periodSince: true, periodUntil: true, createdAt: true, trigger: true,
        dashboard: { select: { id: true, name: true } },
      },
    }),
    prisma.alertRule.count({ where: { enabled: true, NOT: { metric: BUDGET_PACING_METRIC } } }),
    prisma.accountBudget.count(),
    prisma.dashboard.count({ where: { monthlyBudget: { gt: 0 } } }),
  ]);

  // Resolve alert account ids to client names for display.
  const nameByAccount = new Map<string, { id: string; name: string }>();
  for (const c of portfolio.clients) {
    if (c.metaAccountId) nameByAccount.set(c.metaAccountId, { id: c.id, name: c.name });
    if (c.googleCustomerId) nameByAccount.set(c.googleCustomerId, { id: c.id, name: c.name });
  }
  const alerts = openAlerts.map((e) => {
    const client = nameByAccount.get(e.clientId.replace(/^act_/, "")) ?? null;
    return { ...e, client };
  });

  const attention = portfolio.clients
    .filter((c) => c.attention > 0)
    .sort((a, b) => b.attention - a.attention || b.spend.value - a.spend.value)
    .slice(0, 8);

  const pacing = portfolio.clients
    .filter((c) => c.pacing)
    .map((c) => ({ id: c.id, name: c.name, pacing: c.pacing! }))
    .sort((a, b) => {
      const ua = a.pacing.status === "unknown" ? 1 : 0;
      const ub = b.pacing.status === "unknown" ? 1 : 0;
      if (ua !== ub) return ua - ub;
      return Math.abs(100 - b.pacing.pacingPct) - Math.abs(100 - a.pacing.pacingPct);
    });

  const recentReports = recentReportRows.map((r) => ({
    id: r.id,
    clientId: r.dashboard.id,
    clientName: r.dashboard.name,
    title: r.title,
    status: r.status,
    trigger: r.trigger,
    startDate: r.periodSince,
    endDate: r.periodUntil,
    createdAt: r.createdAt.toISOString(),
  }));

  const withoutData = portfolio.clients
    .filter((c) => !c.fetchOk)
    .map((c) => ({ id: c.id, name: c.name, error: c.error }));

  const fetchedAt = portfolio.clients.reduce<string | null>((min, c) => (c.fetchedAt && (!min || c.fetchedAt < min) ? c.fetchedAt : min), null);

  return NextResponse.json({
    summary: { ...portfolio.summary, openAlerts: alerts.length },
    range: portfolio.range,
    rangeLabel: portfolio.rangeLabel,
    generatedAt: portfolio.generatedAt,
    fetchedAt,
    config: { alertRules, budgets: accountBudgets + dashboardBudgets },
    withoutData,
    unlinked: portfolio.unlinked,
    attention,
    alerts,
    pacing,
    recentReports,
    topClients: portfolio.clients.filter((c) => c.fetchOk).slice(0, 8).map((c) => ({
      id: c.id, name: c.name, currency: c.currency, spend: c.spend, roas: c.roas, cpa: c.cpa, alertCount: c.alertCount, fetchOk: c.fetchOk,
    })),
  }, { headers });
}
