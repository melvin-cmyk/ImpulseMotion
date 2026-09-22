/**
 * GET    /api/dashboards/[id]?since&until   → dashboard + widgets with resolved data
 * PATCH  /api/dashboards/[id]               → staff: rename / rebind accounts
 * DELETE /api/dashboards/[id]               → staff
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { isValidHqSlug } from "@/lib/hq-client-context";
import { requireSession, requireStaff } from "@/lib/auth-helpers";
import { loadDashboardFor, denyIfDashboardOutOfScope } from "@/lib/dashboard-auth";
import { bindingOutOfScope, getAccountScope } from "@/lib/scope";
import { resolveWidgets, grantDashboardAccess, type CompareRange } from "@/lib/dashboard-widgets";
import { revokeUncoveredAccess } from "@/lib/dashboard-members";
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
  const denied = await denyIfDashboardOutOfScope(guard.session, id);
  if (denied) return denied;

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
  // denyIfDashboardOutOfScope above only cleared the accounts the dashboard has
  // *today*. Re-binding it to another account grants ACL on that account below,
  // so the incoming ids need the same check.
  const offending = bindingOutOfScope(await getAccountScope(guard.session), {
    metaAccountId: data.metaAccountId as string | null | undefined,
    googleCustomerId: data.googleCustomerId as string | null | undefined,
  });
  if (offending) {
    return NextResponse.json({ error: `compte hors périmètre : ${offending}` }, { status: 403 });
  }
  // HQ folder of the client (projects/{slug}); changing it drops the cached brief.
  if (body.hqSlug === null || body.hqSlug === "" || typeof body.hqSlug === "string") {
    const slug = typeof body.hqSlug === "string" ? body.hqSlug.trim().toLowerCase() : "";
    if (slug && !isValidHqSlug(slug)) return NextResponse.json({ error: "hqSlug invalide (a-z, 0-9, tirets)" }, { status: 400 });
    if ((slug || null) !== existing.hqSlug) {
      data.hqSlug = slug || null;
      data.hqContextMd = null;
      data.hqContextAt = null;
    }
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
  // Handing an account to another login is ACL management → admin only.
  if (typeof body.userId === "string" && body.userId && body.userId !== existing.userId) {
    if (guard.session.role !== "admin") {
      return NextResponse.json({ error: "réservé aux admins" }, { status: 403 });
    }
    const target = await prisma.user.findUnique({ where: { id: body.userId } });
    if (!target) return NextResponse.json({ error: "target user not found" }, { status: 404 });
    data.userId = body.userId;
  }
  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "nothing to update" }, { status: 400 });
  }
  const dashboard = await prisma.dashboard.update({ where: { id }, data });
  // Access follows the binding: the owner (resolver's ACL re-check) and every
  // attached person get the new accounts, and lose the old ones unless another
  // dashboard of theirs still covers them.
  const members = await prisma.dashboardMember.findMany({ where: { dashboardId: id }, select: { userId: true } });
  const people = new Set([dashboard.userId, ...members.map((m) => m.userId)]);
  for (const uid of people) await grantDashboardAccess(uid, dashboard);
  for (const uid of new Set([...people, existing.userId])) await revokeUncoveredAccess(uid, existing);
  return NextResponse.json({ dashboard });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { id } = await params;
  const denied = await denyIfDashboardOutOfScope(guard.session, id);
  if (denied) return denied;
  const existing = await prisma.dashboard.findUnique({
    where: { id },
    select: { userId: true, metaAccountId: true, googleCustomerId: true, members: { select: { userId: true } } },
  });
  await prisma.dashboard.delete({ where: { id } }).catch(() => null);
  // Closing the silo closes the access it had opened.
  if (existing) {
    for (const uid of new Set([existing.userId, ...existing.members.map((m) => m.userId)])) {
      await revokeUncoveredAccess(uid, existing);
    }
  }
  return NextResponse.json({ ok: true });
}
