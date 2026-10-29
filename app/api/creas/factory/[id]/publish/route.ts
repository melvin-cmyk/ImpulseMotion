/**
 * Publication of the kept visuals of a fabrique (staff) — lib/creas/publish.ts.
 *   GET  ?account=  → { targets } : Meta accounts, ad sets (by spend 30 d), Pages, Instagram, texts of the best ad, kept visuals
 *   POST { accountId, adsetId, pageId, instagramUserId?, primaryText, linkUrl, callToAction?, assetIds?, why? }
 *        → { action } : the preview (one Pilotage action, one ad per visual, everything checked on Meta, NOTHING sent)
 *   POST { confirm: true, actionId, why? } → { action } : sent on this single confirmation, every ad created PAUSED, journaled in HQ
 */

import { NextRequest, NextResponse } from "next/server";
import { requireStaff } from "@/lib/auth-helpers";
import { effectiveRole } from "@/lib/roles";
import { resolveAlertClient } from "@/lib/creas/templates";
import { FactoryError, loadRun } from "@/lib/creas/factory";
import { confirmPublish, preparePublish, publishTargets } from "@/lib/creas/publish";
import type { PilotSession } from "@/lib/pilot/service";

export const maxDuration = 300;
const NO_STORE = { headers: { "Cache-Control": "no-store" } };
type Params = { params: Promise<{ id: string }> };

async function load(id: string) {
  const run = await loadRun(id);
  if (!run) return null;
  const client = await resolveAlertClient(run.alertClientId);
  return client ? { run, client } : null;
}

export async function GET(req: NextRequest, { params }: Params) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const found = await load((await params).id);
  if (!found) return NextResponse.json({ error: "Fabrique introuvable." }, { status: 404 });
  return NextResponse.json({ targets: await publishTargets(found.run, found.client, req.nextUrl.searchParams.get("account")) }, NO_STORE);
}

export async function POST(req: NextRequest, { params }: Params) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const found = await load((await params).id);
  if (!found) return NextResponse.json({ error: "Fabrique introuvable." }, { status: 404 });
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const s = guard.session;
  const session: PilotSession = { userId: s.userId, role: effectiveRole(s.role ?? ""), baseRole: s.role ?? null, user: { email: s.user?.email ?? null, name: s.user?.name ?? null } };
  const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  try {
    if (body.confirm === true) {
      const actionId = str(body.actionId, 40);
      if (!actionId) return NextResponse.json({ error: "Aperçu manquant." }, { status: 400 });
      return NextResponse.json({ action: await confirmPublish(found.run, found.client, session, actionId, str(body.why, 2000)) }, NO_STORE);
    }
    const action = await preparePublish(found.run, found.client, session, {
      accountId: str(body.accountId, 40), adsetId: str(body.adsetId, 30), pageId: str(body.pageId, 30), instagramUserId: str(body.instagramUserId, 30) || undefined,
      primaryText: str(body.primaryText, 2000), linkUrl: str(body.linkUrl, 2000), callToAction: str(body.callToAction, 40) || undefined, why: str(body.why, 2000) || undefined,
      assetIds: Array.isArray(body.assetIds) ? body.assetIds.filter((x): x is string => typeof x === "string").slice(0, 24) : undefined,
    });
    return NextResponse.json({ action }, NO_STORE);
  } catch (e) {
    if (e instanceof FactoryError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
