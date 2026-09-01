/**
 * GET   /api/portfolio/[id]?since&until&refresh=1 → staff: client sheet for one
 *       dashboard (merged with its duplicates: same Meta / Google accounts) —
 *       KPIs with deltas, platform table, daily spend, campaigns, top creatives,
 *       pacing, alerts, reports, members. Same resolvers as the client dashboard.
 * PATCH /api/portfolio/[id] → staff: { monthlyBudget, budgetCurrency, reportFrequency, name }
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireStaff } from "@/lib/auth-helpers";
import { resolveWidgets } from "@/lib/dashboard-widgets";
import { groupDashboardsByAccount, invalidateAccountCache, toClientError } from "@/lib/portfolio";
import { getAccountProfileSettings } from "@/lib/account-settings";
import { findBudgetForMetaAccount } from "@/lib/budgets";
import { REPORT_LIST_SELECT, serializeReportRow } from "@/lib/reports-api";
import { describeRange, lastFullDays, prevRange, validateRange, type DateRange } from "@/lib/date-ranges";

export const maxDuration = 120;

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { id } = await params;
  const headers = { "Cache-Control": "no-store" };

  const dashboard = await prisma.dashboard.findUnique({
    where: { id },
    include: {
      user: { select: { id: true, name: true, email: true } },
      members: { select: { user: { select: { id: true, name: true, email: true } } } },
    },
  });
  if (!dashboard) return NextResponse.json({ error: "not found" }, { status: 404, headers });

  // Merge with the dashboards that map to the same client (same accounts).
  const all = await prisma.dashboard.findMany({
    select: { id: true, name: true, metaAccountId: true, googleCustomerId: true, createdAt: true, monthlyBudget: true, budgetCurrency: true, reportFrequency: true },
  });
  const { groups } = groupDashboardsByAccount(all);
  const group = groups.find((g) => g.dashboardIds.includes(id)) ?? null;
  const metaAccountId = group?.metaAccountId ?? (dashboard.metaAccountId ? dashboard.metaAccountId.replace(/^act_/, "") : null);
  const googleCustomerId = group?.googleCustomerId ?? dashboard.googleCustomerId;
  const hasMeta = !!metaAccountId;
  const hasGoogle = !!googleCustomerId;

  // Window: explicit ?since&until, else last 30 full days in the account timezone.
  let timezone: string | null = null;
  let currency: string | null = null;
  if (hasMeta) {
    try {
      const p = await getAccountProfileSettings("meta", metaAccountId!);
      timezone = p.timezone;
      currency = p.currency;
    } catch { /* UTC */ }
  }
  const sp = req.nextUrl.searchParams;
  let range: DateRange;
  if (sp.get("since") || sp.get("until")) {
    const v = validateRange(sp.get("since"), sp.get("until"));
    if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400, headers });
    range = v.range;
  } else {
    range = lastFullDays(30, { tz: timezone });
  }
  const cmp = { ...prevRange(range), kind: "prev" };
  const refresh = sp.get("refresh") === "1";
  if (refresh) await invalidateAccountCache([metaAccountId, googleCustomerId]);

  if (!hasMeta && !hasGoogle) {
    return NextResponse.json({
      error: "Ce dashboard n'est lié à aucun compte publicitaire (Meta ou Google). Liez un compte dans les réglages du dashboard.",
      unlinked: true,
      client: { id: dashboard.id, name: dashboard.name },
    }, { status: 422, headers });
  }

  const source = hasMeta && hasGoogle ? "combined" : hasGoogle && !hasMeta ? "google" : "meta";
  const widgets: Array<{ id: string; type: string; config: Record<string, unknown> }> = [
    ...["spend", "revenue", "roas", "purchases", "cpa", "ctr", "cpc", "cr"].map((metric) => ({ id: `kpi:${metric}`, type: "kpi", config: { metric, source } })),
    { id: "platforms", type: "platform_table", config: {} },
    { id: "funnel", type: "funnel", config: { source } },
    { id: "alerts", type: "alerts", config: { limit: 8 } },
  ];
  if (hasMeta) {
    widgets.push({ id: "daily:meta", type: "timeseries", config: { metric: "spend", source: "meta" } });
    widgets.push({ id: "campaigns:meta", type: "table", config: { kind: "campaigns", source: "meta", limit: 10 } });
    widgets.push({ id: "creatives", type: "top_creatives", config: { limit: 8 } });
    widgets.push({ id: "pacing", type: "pacing", config: {} });
  }
  if (hasGoogle) {
    widgets.push({ id: "daily:google", type: "timeseries", config: { metric: "spend", source: "google" } });
    widgets.push({ id: "campaigns:google", type: "table", config: { kind: "campaigns", source: "google", limit: 10 } });
  }

  const dashboardIds = group?.dashboardIds ?? [id];
  let resolved: Awaited<ReturnType<typeof resolveWidgets>> = [];
  let fatal: { kind: string; message: string } | null = null;
  const [resolvedRes, reports, budget] = await Promise.all([
    resolveWidgets(
      { id: dashboard.id, userId: dashboard.userId, metaAccountId, googleCustomerId },
      widgets.map((w, i) => ({ id: w.id, type: w.type, title: null, width: "half", position: i, config: JSON.stringify(w.config) })),
      range.since, range.until, cmp,
    ).catch((e) => { fatal = toClientError(e); return []; }),
    prisma.clientReport.findMany({ where: { dashboardId: { in: dashboardIds } }, orderBy: { createdAt: "desc" }, take: 20, select: REPORT_LIST_SELECT }),
    hasMeta ? findBudgetForMetaAccount(metaAccountId!, currency).catch(() => null) : Promise.resolve(null),
  ]);
  resolved = resolvedRes;

  const out: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  let fetchedAt: string | null = null;
  for (const r of resolved) {
    if (r.error) errors[r.id] = r.error;
    else {
      out[r.id] = r.data;
      const fa = (r.data as { fetchedAt?: string } | null)?.fetchedAt;
      if (fa && (!fetchedAt || fa < fetchedAt)) fetchedAt = fa;
      const cur = (r.data as { currency?: string } | null)?.currency;
      if (cur && !currency) currency = cur;
    }
  }

  const budgetDash = group?.members.find((m) => typeof m.monthlyBudget === "number" && m.monthlyBudget > 0) ?? null;
  const described = describeRange(range, { tz: timezone });

  return NextResponse.json({
    client: {
      id: dashboard.id,
      name: dashboard.name,
      metaAccountId,
      googleCustomerId,
      reportFrequency: dashboard.reportFrequency ?? group?.members.find((m) => m.reportFrequency)?.reportFrequency ?? null,
      owner: dashboard.user,
      members: dashboard.members.map((m) => m.user),
      createdAt: dashboard.createdAt.toISOString(),
      dashboardIds,
      duplicates: dashboardIds.length - 1,
      currency,
      timezone,
      monthlyBudget: budgetDash?.monthlyBudget ?? dashboard.monthlyBudget ?? null,
      budgetCurrency: budgetDash?.budgetCurrency ?? dashboard.budgetCurrency ?? null,
      budgetSource: budget?.source ?? null,
      budgetDashboardId: budgetDash?.id ?? dashboard.id,
    },
    range,
    rangeLabel: described.label,
    partialDay: described.partialDay,
    compare: cmp,
    data: out,
    errors,
    error: fatal,
    fetchedAt,
    generatedAt: new Date().toISOString(),
    reports: reports.map(serializeReportRow),
  }, { headers });
}

const CURRENCY_RE = /^[A-Z]{3}$/;

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { id } = await params;
  const existing = await prisma.dashboard.findUnique({ where: { id } });
  if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const data: Record<string, unknown> = {};
  const problems: string[] = [];

  if ("monthlyBudget" in body) {
    if (body.monthlyBudget === null || body.monthlyBudget === "") data.monthlyBudget = null;
    else {
      const n = Number(body.monthlyBudget);
      if (!Number.isFinite(n) || n <= 0 || n > 1e9) problems.push("monthlyBudget doit être un nombre > 0");
      else data.monthlyBudget = Math.round(n * 100) / 100;
    }
  }
  if ("budgetCurrency" in body) {
    if (body.budgetCurrency === null || body.budgetCurrency === "") data.budgetCurrency = null;
    else {
      const c = String(body.budgetCurrency).trim().toUpperCase();
      if (!CURRENCY_RE.test(c)) problems.push("budgetCurrency doit être un code ISO 4217 (EUR, ZAR…)");
      else data.budgetCurrency = c;
    }
  }
  if ("reportFrequency" in body) {
    if (body.reportFrequency === null || ["weekly", "monthly", "none"].includes(String(body.reportFrequency))) {
      data.reportFrequency = body.reportFrequency && body.reportFrequency !== "none" ? String(body.reportFrequency) : null;
    } else problems.push("reportFrequency doit être weekly | monthly | null");
  }
  if (typeof body.name === "string" && body.name.trim()) data.name = body.name.trim();

  if (problems.length) return NextResponse.json({ error: problems.join(" · ") }, { status: 400 });
  if (Object.keys(data).length === 0) return NextResponse.json({ error: "nothing to update" }, { status: 400 });

  const dashboard = await prisma.dashboard.update({ where: { id }, data });
  return NextResponse.json({ dashboard });
}
