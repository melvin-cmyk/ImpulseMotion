/**
 * GET  /api/dashboards/[id]/sources → staff: { sources: DashboardSourceRef[], secretsConfigured }
 * POST /api/dashboards/[id]/sources → staff: attach / update a source
 *      body { kind: "hubspot", portalId?, token?, label?, config? }
 *      A token is validated against HubSpot (testHubspotConnection) before being
 *      encrypted; portalId is taken from the test when omitted.
 *      body { kind: "tiktok", advertiserId, confirm? }
 *      The advertiser is looked up at TikTok on every call. Without confirm:
 *      { check: { advertiser, alreadyOn } }, nothing stored — the staff member
 *      reads the account name first (one token reads every advertiser of the
 *      agency: a mistyped id would hand a client another client's figures).
 *      With confirm: true: looked up again, stored, { source, check }.
 */

import { denyIfDashboardOutOfScope } from "@/lib/dashboard-auth";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireStaff } from "@/lib/auth-helpers";
import { hasSecretsKey } from "@/lib/secrets";
import { listSources, upsertHubspotSource, type HubspotSourceConfig } from "@/lib/sources";
import { testHubspotConnection } from "@/lib/hubspot/client";
import { attachTikTokAdvertiser, checkAdvertiser, dashboardsWithAdvertiser, normalizeAdvertiserId } from "@/lib/tiktok-accounts";

export const maxDuration = 30;

const NO_STORE = { "Cache-Control": "no-store" };
const TIKTOK_ID_INVALID = "Identifiant du compte TikTok Ads invalide : il ne contient que des chiffres (TikTok Ads Manager, en haut à droite sous le nom du compte).";
const SECRETS_KEY_MISSING = "SOURCE_SECRETS_KEY non configurée : impossible de chiffrer le token (définir une clé base64 de 32 octets, ex. openssl rand -base64 32).";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { id } = await params;
  const denied = await denyIfDashboardOutOfScope(guard.session, id);
  if (denied) return denied;
  const dashboard = await prisma.dashboard.findUnique({ where: { id }, select: { id: true } });
  if (!dashboard) return NextResponse.json({ error: "not found" }, { status: 404, headers: NO_STORE });
  const sources = await listSources(id);
  return NextResponse.json({ sources, secretsConfigured: hasSecretsKey() }, { headers: NO_STORE });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { id } = await params;
  const denied = await denyIfDashboardOutOfScope(guard.session, id);
  if (denied) return denied;
  const dashboard = await prisma.dashboard.findUnique({ where: { id }, select: { id: true } });
  if (!dashboard) return NextResponse.json({ error: "not found" }, { status: 404 });

  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  if (body.kind === "tiktok") return attachTikTok(id, body);
  if (body.kind !== "hubspot") return NextResponse.json({ error: "kind doit être \"hubspot\" ou \"tiktok\"" }, { status: 400 });
  const token = typeof body.token === "string" ? body.token.trim() : "";
  let portalId = typeof body.portalId === "string" ? body.portalId.trim() : "";
  const label = typeof body.label === "string" ? body.label : undefined;
  const config = body.config && typeof body.config === "object" && !Array.isArray(body.config) ? (body.config as Partial<HubspotSourceConfig>) : undefined;

  let test: { portalId: string; hubDomain: string | null; scopesOk: boolean; missingScopes: string[] } | null = null;
  if (token) {
    if (!hasSecretsKey()) return NextResponse.json({ error: SECRETS_KEY_MISSING }, { status: 409 });
    const r = await testHubspotConnection(token);
    if (!r.ok) return NextResponse.json({ error: `Connexion HubSpot refusée : ${r.error}` }, { status: 400 });
    test = { portalId: r.portalId, hubDomain: r.hubDomain, scopesOk: r.scopesOk, missingScopes: r.missingScopes };
    if (portalId && portalId !== r.portalId) {
      return NextResponse.json({ error: `Le token appartient au portail ${r.portalId}, pas au portail ${portalId}` }, { status: 400 });
    }
    portalId = r.portalId;
  } else {
    // No token: only label / config of an existing source can be updated.
    if (!portalId) return NextResponse.json({ error: "token requis (ou portalId d'une source existante)" }, { status: 400 });
    const existing = (await listSources(id)).find((s) => s.kind === "hubspot" && s.externalId === portalId);
    if (!existing) return NextResponse.json({ error: "Aucune source HubSpot pour ce portail : fournir un token" }, { status: 400 });
  }

  try {
    const source = await upsertHubspotSource({ dashboardId: id, portalId, token: token || undefined, label, config });
    return NextResponse.json({ source, test }, { status: 200 });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: /SOURCE_SECRETS_KEY/.test(message) ? 409 : 500 });
  }
}

/** TikTok: a first call shows who the advertiser is, a confirmed second call stores it. */
async function attachTikTok(dashboardId: string, body: Record<string, unknown>) {
  const advertiserId = normalizeAdvertiserId(body.advertiserId);
  if (!advertiserId) return NextResponse.json({ error: TIKTOK_ID_INVALID }, { status: 400 });
  // Asked again on the confirmed call: what is stored is TikTok's answer, never a name sent by the browser.
  const checked = await checkAdvertiser(advertiserId);
  if (!checked.ok) return NextResponse.json({ error: checked.error }, { status: 400 });

  try {
    const check = { advertiser: checked.advertiser, alreadyOn: await dashboardsWithAdvertiser(advertiserId, dashboardId) };
    if (body.confirm !== true) return NextResponse.json({ check }, { status: 200, headers: NO_STORE });
    const stored = await attachTikTokAdvertiser(dashboardId, checked.advertiser);
    const source = (await listSources(dashboardId)).find((s) => s.id === stored.id);
    if (!source) throw new Error("Compte TikTok Ads rattaché mais introuvable à la relecture");
    return NextResponse.json({ source, check }, { status: 200, headers: NO_STORE });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
