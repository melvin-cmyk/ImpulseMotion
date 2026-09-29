/**
 * Routines — whoever has access to the routines (lib/routines/access.ts).
 *
 * GET  → the routines the caller may see ({ routines }), archived ones left out
 *        unless ?archived=1
 * POST → creates a draft: { name, dashboardId?, clientName?, metaAccountId?, googleCustomerId?, pageId? }
 *        The accounts default to those of the dashboard. Every account
 *        received is checked against the caller's scope (lib/scope.ts): a
 *        routine never gives access to an account the person does not have.
 *        `pageId` is the Facebook Page picked in the form: it must be one the
 *        Meta account of the routine can promote, read again here.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireRoutinesAccess } from "@/lib/routines/access";
import { bindingOutOfScope, dashboardInScope, getAccountScope } from "@/lib/scope";
import { cleanMetaMessage, isMetaId, listPromotablePages } from "@/lib/meta-write";
import type { RoutinePage } from "@/lib/routines/context";
import { GOOGLE_CUSTOMER_INVALID, META_ACCOUNT_INVALID, isGoogleCustomerId, isMetaAccountId } from "@/lib/routines/accounts";
import { actorOf, createRoutine, listRoutines, routineView } from "@/lib/routines/store";
import { validateName } from "@/lib/routines/validate";

const NO_STORE = { "Cache-Control": "no-store" };

const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

export async function GET(req: NextRequest) {
  const guard = await requireRoutinesAccess();
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
  const guard = await requireRoutinesAccess();
  if ("error" in guard) return guard.error;
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return NextResponse.json({ error: "corps de requête invalide" }, { status: 400 });

  const name = validateName(body.name);
  if (!name.ok) return NextResponse.json({ error: name.errors[0] }, { status: 400 });

  let metaAccountId = text(body.metaAccountId);
  let googleCustomerId = text(body.googleCustomerId);
  // The one rule of lib/routines/accounts.ts, the same the steps and the Meta writer apply afterwards.
  if (metaAccountId && !isMetaAccountId(metaAccountId)) return NextResponse.json({ error: META_ACCOUNT_INVALID }, { status: 400 });
  if (googleCustomerId && !isGoogleCustomerId(googleCustomerId)) return NextResponse.json({ error: GOOGLE_CUSTOMER_INVALID }, { status: 400 });

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

  // The accounts as they will be stored, whether typed or taken from the dashboard: same rule.
  if (metaAccountId && !isMetaAccountId(metaAccountId)) return NextResponse.json({ error: `${META_ACCOUNT_INVALID} (compte du dashboard)` }, { status: 400 });
  if (googleCustomerId && !isGoogleCustomerId(googleCustomerId)) return NextResponse.json({ error: `${GOOGLE_CUSTOMER_INVALID} (compte du dashboard)` }, { status: 400 });
  const outside = bindingOutOfScope(scope, { metaAccountId, googleCustomerId });
  if (outside) return NextResponse.json({ error: "forbidden", account: outside }, { status: 403 });

  // The Page picked in the form: nothing the browser says of it is kept, it is read in the account's own list.
  let page: RoutinePage | null = null;
  if (body.pageId !== undefined && body.pageId !== null && body.pageId !== "") {
    if (!isMetaId(body.pageId)) return NextResponse.json({ error: "Page Facebook invalide : son identifiant est attendu, en chiffres" }, { status: 400 });
    if (!metaAccountId) return NextResponse.json({ error: "Une Page Facebook ne se choisit qu'avec un compte Meta" }, { status: 400 });
    try {
      const { pages } = await listPromotablePages(metaAccountId);
      page = pages.find((p) => p.id === body.pageId) ?? null;
    } catch (e) {
      return NextResponse.json({ error: `Pages du compte Meta illisibles : ${cleanMetaMessage(e)}. Réessayez, ou créez la routine sans choisir de Page.` }, { status: 502 });
    }
    if (!page) return NextResponse.json({ error: "Cette Page Facebook n'est pas de celles que le compte Meta de la routine peut promouvoir" }, { status: 400 });
  }

  const routine = await createRoutine(
    { name: name.value, clientName: clientName ?? "—", dashboardId, metaAccountId, googleCustomerId, page },
    actorOf(guard.session),
  );
  return NextResponse.json({ ok: true, routine: routineView(routine) }, { status: 201 });
}
