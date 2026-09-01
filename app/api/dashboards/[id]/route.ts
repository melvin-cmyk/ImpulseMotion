/**
 * GET    /api/dashboards/[id]?since&until   → dashboard + widgets with resolved data
 * PATCH  /api/dashboards/[id]               → staff: rename / rebind accounts
 * DELETE /api/dashboards/[id]               → staff
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession, requireStaff } from "@/lib/auth-helpers";
import { loadDashboardFor } from "@/lib/dashboard-auth";
import { resolveWidgets, grantDashboardAccess, type CompareRange } from "@/lib/dashboard-widgets";
import { getAccountProfileSettings } from "@/lib/account-settings";
import { describeRange, prevRange, rangeFromParams, validateRange, yearAgoRange } from "@/lib/date-ranges";

export const maxDuration = 60;

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireSession();
  if ("error" in guard) return guard.error;
  const { id } = await params;

  const loaded = await loadDashboardFor(guard.session, id);
  if (loaded.status !== 200) {
    return NextResponse.json({ error: loaded.status === 404 ? "not found" : "forbidden" }, { status: loaded.status });
  }
  const { dashboard } = loaded;

  // Default window = last 30 FULL days ending yesterday in the account timezone
  // (same rule as the portfolio, so both surfaces show the same number).
  let timezone: string | null = null;
  if (dashboard.metaAccountId) {
    try { timezone = (await getAccountProfileSettings("meta", dashboard.metaAccountId)).timezone; } catch { /* UTC */ }
  }
  const parsed = rangeFromParams(req.nextUrl.searchParams, "last_30", { tz: timezone });
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const { since, until } = parsed.range;

  // Comparison window: prev (default) | year | none | custom (cmpSince/cmpUntil)
  const compareParam = req.nextUrl.searchParams.get("compare") ?? "prev";
  const cmpSince = req.nextUrl.searchParams.get("cmpSince");
  const cmpUntil = req.nextUrl.searchParams.get("cmpUntil");
  let compare: CompareRange | null | undefined = undefined;
  if (compareParam === "none") {
    compare = null;
  } else if (compareParam === "year") {
    const shifted = yearAgoRange({ since, until });
    // clamp Feb 29 → Feb 28 on non-leap years (Date.parse rolls over instead of failing)
    const clamp = (d: string) => {
      const p = new Date(d + "T00:00:00Z");
      return Number.isNaN(p.getTime()) || !p.toISOString().startsWith(d) ? `${d.slice(0, 4)}-02-28` : d;
    };
    compare = { since: clamp(shifted.since), until: clamp(shifted.until), kind: "year" };
  } else if (compareParam === "custom") {
    const v = validateRange(cmpSince, cmpUntil);
    if (!v.ok) return NextResponse.json({ error: `cmpSince/cmpUntil : ${v.error}` }, { status: 400 });
    compare = { ...v.range, kind: "custom" };
  } else {
    compare = { ...prevRange({ since, until }), kind: "prev" };
  }

  let widgets: Awaited<ReturnType<typeof resolveWidgets>> = [];
  let error: string | null = null;
  try {
    widgets = await resolveWidgets(dashboard, dashboard.widgets, since, until, compare);
  } catch (e) {
    // e.g. unlinked dashboard (no Meta nor Google account) — surface the reason, not a 500
    const message = e instanceof Error ? e.message : String(e);
    error = message;
    widgets = dashboard.widgets.map((w) => ({
      id: w.id, type: w.type, title: w.title, width: w.width, position: w.position,
      config: (() => { try { return JSON.parse(w.config || "{}") as Record<string, unknown>; } catch { return {}; } })(),
      error: message,
    }));
  }
  const described = describeRange({ since, until }, { tz: timezone });
  return NextResponse.json({
    dashboard: {
      id: dashboard.id,
      userId: dashboard.userId,
      name: dashboard.name,
      metaAccountId: dashboard.metaAccountId,
      googleCustomerId: dashboard.googleCustomerId,
      monthlyBudget: dashboard.monthlyBudget,
      budgetCurrency: dashboard.budgetCurrency,
      timezone,
    },
    since,
    until,
    rangeLabel: described.label,
    partialDay: described.partialDay,
    compare,
    ...(error ? { error } : {}),
    widgets,
  }, { headers: { "Cache-Control": "no-store" } });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { id } = await params;

  const existing = await prisma.dashboard.findUnique({ where: { id } });
  if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const data: Record<string, unknown> = {};
  if (typeof body.name === "string" && body.name.trim()) data.name = body.name.trim();
  if (body.metaAccountId === null || typeof body.metaAccountId === "string") {
    data.metaAccountId = body.metaAccountId ? String(body.metaAccountId).replace(/^act_/, "") : null;
  }
  if (body.googleCustomerId === null || typeof body.googleCustomerId === "string") {
    data.googleCustomerId = body.googleCustomerId ? String(body.googleCustomerId).replace(/-/g, "") : null;
  }
  // Opt-in AI reporting: null | "weekly" | "monthly"
  if (body.reportFrequency === null || ["weekly", "monthly", "none"].includes(String(body.reportFrequency))) {
    data.reportFrequency = body.reportFrequency && body.reportFrequency !== "none" ? String(body.reportFrequency) : null;
  }
  // Monthly media budget of the client (pacing) — takes precedence over AccountBudget.
  if ("monthlyBudget" in body) {
    if (body.monthlyBudget === null || body.monthlyBudget === "") data.monthlyBudget = null;
    else {
      const n = Number(body.monthlyBudget);
      if (!Number.isFinite(n) || n <= 0 || n > 1e9) return NextResponse.json({ error: "monthlyBudget doit être un nombre > 0" }, { status: 400 });
      data.monthlyBudget = Math.round(n * 100) / 100;
    }
  }
  if ("budgetCurrency" in body) {
    if (body.budgetCurrency === null || body.budgetCurrency === "") data.budgetCurrency = null;
    else {
      const c = String(body.budgetCurrency).trim().toUpperCase();
      if (!/^[A-Z]{3}$/.test(c)) return NextResponse.json({ error: "budgetCurrency doit être un code ISO 4217 (EUR, ZAR…)" }, { status: 400 });
      data.budgetCurrency = c;
    }
  }
  // Re-link the dashboard to another client login (grants matching ACL rows).
  if (typeof body.userId === "string" && body.userId && body.userId !== existing.userId) {
    const target = await prisma.user.findUnique({ where: { id: body.userId } });
    if (!target) return NextResponse.json({ error: "target user not found" }, { status: 404 });
    data.userId = body.userId;
  }
  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "nothing to update" }, { status: 400 });
  }
  const dashboard = await prisma.dashboard.update({ where: { id }, data });
  // Ensure the (possibly new) owner can pass the resolver's ACL re-check.
  await grantDashboardAccess(dashboard.userId, dashboard);
  return NextResponse.json({ dashboard });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { id } = await params;
  await prisma.dashboard.delete({ where: { id } }).catch(() => null);
  return NextResponse.json({ ok: true });
}
