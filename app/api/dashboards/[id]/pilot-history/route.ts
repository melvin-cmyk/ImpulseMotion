/**
 * GET /api/dashboards/[id]/pilot-history?days=60 — the onglet « Historique & impact »
 * of a client's dashboard (staff only): every change sent from Pilotage on the
 * accounts of this client, every change the platforms' logs say anyone made,
 * their J+7 and J+14 analyses, and the day-by-day figures of the dashboard's
 * Meta (else Google Ads) account for the curve.
 *
 * The client of the dashboard is the agency client (AlertClient) attached to
 * it, or owning one of its accounts. Read only: the analyses are written by the
 * cron (lib/pilot/impact-run.ts), never on reading — no platform call, no AI.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireStaff } from "@/lib/auth-helpers";
import { dashboardIdInScope, getAccountScope } from "@/lib/scope";
import { normGoogle, normMeta } from "@/lib/portfolio";
import { parseAlertAccounts } from "@/lib/auto-alerts/clients";
import { clientHistory } from "@/lib/pilot/history";

export const maxDuration = 60;

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { id } = await params;
  const scope = await getAccountScope(guard.session);
  if (!(await dashboardIdInScope(scope, id))) return NextResponse.json({ error: "not found" }, { status: 404 });
  const dashboard = await prisma.dashboard.findUnique({ where: { id }, select: { metaAccountId: true, googleCustomerId: true, hqSlug: true } });
  if (!dashboard) return NextResponse.json({ error: "not found" }, { status: 404 });

  const meta = dashboard.metaAccountId ? normMeta(dashboard.metaAccountId) : null;
  const google = dashboard.googleCustomerId ? normGoogle(dashboard.googleCustomerId) : null;
  const clients = await prisma.alertClient.findMany({ where: { gone: false }, select: { id: true, name: true, dashboardId: true, accountsJson: true, hqSlug: true } });
  const mine = clients.filter((c) => c.dashboardId === id || parseAlertAccounts(c.accountsJson).some((a) =>
    (a.platform === "meta" && meta && normMeta(a.accountId) === meta) || (a.platform === "google" && google && normGoogle(a.accountId) === google)));

  const focus = meta ? { platform: "meta", accountId: meta } : google ? { platform: "google", accountId: google } : null;
  const days = Number(new URL(req.url).searchParams.get("days")) || undefined;
  const view = await clientHistory(guard.session, { alertClientIds: mine.map((c) => c.id), focus, days, refresh: true });

  return NextResponse.json({
    clients: mine.map((c) => ({ id: c.id, name: c.name })),
    hqProject: mine.find((c) => c.hqSlug)?.hqSlug ?? dashboard.hqSlug ?? null,
    ...view,
    // Drafts are the preparer's own business: only what was sent is history.
    actions: view.actions.filter((a) => a.status !== "draft" && a.status !== "expired"),
  }, { headers: { "Cache-Control": "no-store" } });
}
