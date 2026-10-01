/**
 * Global Cockpit configuration (admin).
 *
 * GET → the clients of the budget sheet for the current month, the accounts
 *       attached to each, and the accounts the agency can read that are
 *       attached to nobody.
 * PUT → one change:
 *       { client: { key, name?, kpiMode?, hidden? } }
 *       { account: { platform, accountId, clientKey?, mode?, label?, enabled? } }
 *       platform: "meta" | "google" | "tiktok" (TikTok: the advertiser id,
 *       digits only). An account touched by an admin becomes « manual »: the
 *       automatic matching never moves it again; `enabled: false` detaches it
 *       from the cockpit. The change shows at the next build.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth-helpers";
import { fetchBudgetSheet, sheetClients } from "@/lib/cockpit/sheet";
import { cockpitCalendar } from "@/lib/cockpit/weeks";
import { listGoogleAccounts, listMetaAccounts, listTikTokAccounts, tiktokCurrency } from "@/lib/cockpit/fetch";
import { checkAdvertiser, normalizeAdvertiserId } from "@/lib/tiktok-accounts";
import { DEFAULT_MODELS } from "@/lib/cockpit/defaults";
import { asPlatform, type CockpitPlatform } from "@/lib/cockpit/engine";
import type { AvailableAccount } from "@/lib/cockpit/match";

export const maxDuration = 120;

const MODES = new Set(["cpa", "roas", "brand"]);
const KEY_RE = /^[a-z0-9][a-z0-9-]{0,60}$/;
const ID_RE = /^[0-9]{4,24}$/;

export async function GET() {
  const guard = await requireAdmin();
  if ("error" in guard) return guard.error;
  const warnings: string[] = [];
  const cal = cockpitCalendar();
  const [lines, meta, google, tiktok, accounts, overrides] = await Promise.all([
    fetchBudgetSheet(),
    listMetaAccounts().catch((e) => { warnings.push(`Comptes Meta : ${e instanceof Error ? e.message : e}`); return [] as AvailableAccount[]; }),
    listGoogleAccounts().catch((e) => { warnings.push(`Comptes Google Ads : ${e instanceof Error ? e.message : e}`); return [] as AvailableAccount[]; }),
    listTikTokAccounts().catch((e) => { warnings.push(`Comptes TikTok Ads : ${e instanceof Error ? e.message : e}`); return [] as AvailableAccount<"tiktok">[]; }),
    prisma.cockpitAccount.findMany({ orderBy: [{ clientKey: "asc" }, { platform: "asc" }, { name: "asc" }] }),
    prisma.cockpitClient.findMany(),
  ]);
  const override = new Map(overrides.map((o) => [o.key, o]));
  const attached = new Set(accounts.map((a) => `${a.platform}:${a.accountId}`));
  const clients = sheetClients(lines, cal.month.key).map((c) => ({
    key: c.key,
    name: override.get(c.key)?.name ?? c.name,
    sheetName: c.name,
    sheetNames: c.sheetNames,
    team: c.team,
    currency: c.currency,
    budget: c.budget,
    targetRoas: c.targetRoas,
    targetCpl: c.targetCpl,
    otherPlatforms: c.otherPlatforms,
    kpiMode: override.get(c.key)?.kpiMode ?? null,
    defaultMode: DEFAULT_MODELS[c.key]?.mode ?? null,
    hidden: override.get(c.key)?.hidden ?? false,
    accounts: accounts.filter((a) => a.clientKey === c.key).map((a) => ({
      platform: a.platform, accountId: a.accountId, name: a.name, currency: a.currency,
      label: a.label, mode: a.mode, source: a.source, enabled: a.enabled,
    })),
  }));
  const free = [...meta, ...google, ...tiktok]
    .filter((a) => a.active && !attached.has(`${a.platform}:${a.accountId}`))
    .sort((a, b) => a.name.localeCompare(b.name, "fr"));
  return NextResponse.json({ month: cal.month.key, clients, free, warnings }, { headers: { "Cache-Control": "no-store" } });
}

export async function PUT(req: NextRequest) {
  const guard = await requireAdmin();
  if ("error" in guard) return guard.error;
  const body = await req.json().catch(() => ({}));

  if (body?.client && typeof body.client === "object") {
    const c = body.client as Record<string, unknown>;
    if (typeof c.key !== "string" || !KEY_RE.test(c.key)) return NextResponse.json({ error: "client invalide" }, { status: 400 });
    const data: { name?: string | null; kpiMode?: string | null; hidden?: boolean } = {};
    if ("name" in c) data.name = typeof c.name === "string" && c.name.trim() ? c.name.trim().slice(0, 80) : null;
    if ("kpiMode" in c) {
      if (c.kpiMode !== null && !(typeof c.kpiMode === "string" && MODES.has(c.kpiMode))) return NextResponse.json({ error: "modèle invalide (cpa, roas, brand)" }, { status: 400 });
      data.kpiMode = (c.kpiMode as string | null) ?? null;
    }
    if ("hidden" in c) data.hidden = c.hidden === true;
    const row = await prisma.cockpitClient.upsert({ where: { key: c.key }, create: { key: c.key, ...data }, update: data });
    return NextResponse.json({ client: { key: row.key, name: row.name, kpiMode: row.kpiMode, hidden: row.hidden } });
  }

  if (body?.account && typeof body.account === "object") {
    const a = body.account as Record<string, unknown>;
    const platform = typeof a.platform === "string" ? asPlatform(a.platform) : null;
    const accountId = platform === "tiktok"
      ? normalizeAdvertiserId(a.accountId) ?? ""
      : typeof a.accountId === "string" ? a.accountId.replace(/^act_/, "").replace(/-/g, "") : "";
    if (!platform || !(platform === "tiktok" ? accountId : ID_RE.test(accountId))) return NextResponse.json({ error: "compte invalide" }, { status: 400 });

    const existing = await prisma.cockpitAccount.findUnique({ where: { platform_accountId: { platform, accountId } } });
    const data: { clientKey?: string; mode?: string | null; label?: string | null; enabled?: boolean; source: string } = { source: "manual" };
    if ("clientKey" in a) {
      if (typeof a.clientKey !== "string" || !KEY_RE.test(a.clientKey)) return NextResponse.json({ error: "client invalide" }, { status: 400 });
      data.clientKey = a.clientKey;
    }
    if ("mode" in a) {
      if (a.mode !== null && !(typeof a.mode === "string" && MODES.has(a.mode))) return NextResponse.json({ error: "modèle invalide (cpa, roas, brand)" }, { status: 400 });
      data.mode = (a.mode as string | null) ?? null;
    }
    if ("label" in a) data.label = typeof a.label === "string" && a.label.trim() ? a.label.trim().slice(0, 60) : null;
    if ("enabled" in a) data.enabled = a.enabled !== false;

    if (existing) {
      const row = await prisma.cockpitAccount.update({ where: { id: existing.id }, data });
      return NextResponse.json({ account: row });
    }
    if (!data.clientKey) return NextResponse.json({ error: "client requis pour rattacher un compte" }, { status: 400 });
    // Only an account the agency can actually read may be attached.
    const found = await readableAccount(platform, accountId);
    if (!found) return NextResponse.json({ error: "compte inconnu ou inaccessible" }, { status: 404 });
    const row = await prisma.cockpitAccount.create({
      data: { clientKey: data.clientKey, platform, accountId, name: found.name, currency: found.currency, mode: data.mode ?? null, label: data.label ?? null, enabled: data.enabled ?? true, source: "manual" },
    });
    return NextResponse.json({ account: row });
  }

  return NextResponse.json({ error: "rien à modifier" }, { status: 400 });
}

/**
 * The account as the agency reads it, or null. TikTok: the listing of the
 * Business Centers first, then TikTok itself (an account shared with the
 * agency outside its Business Centers); the currency is asked to TikTok.
 */
async function readableAccount(platform: CockpitPlatform, accountId: string): Promise<{ name: string; currency: string | null } | null> {
  if (platform === "meta") return (await listMetaAccounts()).find((x) => x.accountId === accountId) ?? null;
  if (platform === "google") return (await listGoogleAccounts()).find((x) => x.accountId === accountId) ?? null;
  const listed = (await listTikTokAccounts().catch(() => [])).find((x) => x.accountId === accountId);
  if (listed) return { name: listed.name, currency: await tiktokCurrency(accountId) };
  const check = await checkAdvertiser(accountId);
  return check.ok ? { name: check.advertiser.name, currency: check.advertiser.currency } : null;
}
