/**
 * Routines — staff only.
 *
 * GET  → the routines the caller may see ({ routines }), archived ones left out
 *        unless ?archived=1
 * POST → creates a draft: { name, dashboardId?, clientName?, metaAccountId?, googleCustomerId? }
 *        The accounts default to those of the dashboard. Every account
 *        received is checked against the caller's scope (lib/scope.ts): a
 *        routine never gives access to an account the person does not have.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireStaff } from "@/lib/auth-helpers";
import { bindingOutOfScope, dashboardInScope, getAccountScope } from "@/lib/scope";
import { actorOf, createRoutine, listRoutines, routineView } from "@/lib/routines/store";
import { validateName } from "@/lib/routines/validate";

const NO_STORE = { "Cache-Control": "no-store" };
const META_ACCOUNT_RE = /^(act_)?\d{3,20}$/;
const GOOGLE_CUSTOMER_RE = /^\d[\d-]{4,13}\d$/;

const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

export async function GET(req: NextRequest) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const scope = await getAccountScope(guard.session);
  const params = new URL(req.url).searchParams;
  const rows = await listRoutines({
    includeArchived: params.get("archived") === "1",
    dashboardId: params.get("dashboardId") || undefined,
  });
  const routines = rows.filter((r) => !bindingOutOfScope(scope, r)).map(routineView);
  return NextResponse.json({ routines }, { headers: NO_STORE });
}

export async function POST(req: NextRequest) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return NextResponse.json({ error: "corps de requête invalide" }, { status: 400 });

  const name = validateName(body.name);
  if (!name.ok) return NextResponse.json({ error: name.errors[0] }, { status: 400 });

  let metaAccountId = text(body.metaAccountId);
  let googleCustomerId = text(body.googleCustomerId);
  if (metaAccountId && !META_ACCOUNT_RE.test(metaAccountId)) return NextResponse.json({ error: "compte Meta invalide" }, { status: 400 });
  if (googleCustomerId && !GOOGLE_CUSTOMER_RE.test(googleCustomerId)) return NextResponse.json({ error: "compte Google Ads invalide" }, { status: 400 });

  const scope = await getAccountScope(guard.session);
  const dashboardId = text(body.dashboardId);
  let clientName = text(body.clientName)?.slice(0, 120) ?? null;
  if (dashboardId) {
    const dashboard = await prisma.dashboard.findUnique({
      where: { id: dashboardId },
      select: { id: true, name: true, metaAccountId: true, googleCustomerId: true },
    });
    if (!dashboard) return NextResponse.json({ error: "dashboard introuvable" }, { status: 404 });
    if (!dashboardInScope(scope, dashboard)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
    metaAccountId = metaAccountId ?? dashboard.metaAccountId;
    googleCustomerId = googleCustomerId ?? dashboard.googleCustomerId;
    clientName = clientName ?? dashboard.name;
  }

  // The accounts as they will be stored, whether typed or taken from the dashboard.
  const outside = bindingOutOfScope(scope, { metaAccountId, googleCustomerId });
  if (outside) return NextResponse.json({ error: "forbidden", account: outside }, { status: 403 });

  const routine = await createRoutine(
    { name: name.value, clientName: clientName ?? "—", dashboardId, metaAccountId, googleCustomerId },
    actorOf(guard.session),
  );
  return NextResponse.json({ ok: true, routine: routineView(routine) }, { status: 201 });
}
