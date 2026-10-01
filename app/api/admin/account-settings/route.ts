/**
 * Admin management of per-account settings (AOV fallback, currency).
 *
 * GET  /api/admin/account-settings?platform=meta        → { settings: [...] }
 *      ?platform=tiktok&accountId=<advertiser> also gives `profile`, the
 *      currency/timezone/name TikTok gives for that advertiser
 * PUT  /api/admin/account-settings                      → upsert one
 *   Body: { platform: "meta" | "google" | "tiktok", accountId, aov?: number|null, currency?: string, conversionEvent?: string }
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireStaff } from "@/lib/auth-helpers";
import { getAccountProfileSettings } from "@/lib/account-settings";
import { normalizeAdvertiserId } from "@/lib/tiktok-accounts";
import { platformAccountInScope, getAccountScope } from "@/lib/scope";

const PLATFORMS = new Set(["meta", "google", "tiktok"]);

/** The id as AccountSetting stores it: Meta without "act_", TikTok in digits; null when it is not one. */
function cleanAccountId(platform: string, raw: string): string | null {
  if (platform === "tiktok") return normalizeAdvertiserId(raw);
  const id = raw.trim().replace(/^act_/, "");
  return id || null;
}

export async function GET(req: NextRequest) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const scope = await getAccountScope(guard.session);

  const platform = req.nextUrl.searchParams.get("platform") ?? undefined;
  if (platform && !PLATFORMS.has(platform)) return NextResponse.json({ error: "plateforme inconnue" }, { status: 400 });
  const settings = await prisma.accountSetting.findMany({
    where: platform ? { platform } : undefined,
    orderBy: { accountId: "asc" },
  });
  const visible = scope.all ? settings : settings.filter((s) => platformAccountInScope(scope, s.platform, s.accountId));

  // One TikTok advertiser asked for: its profile, read from TikTok (cached) and stored as the fallback.
  const asked = req.nextUrl.searchParams.get("accountId");
  if (platform === "tiktok" && asked) {
    const accountId = cleanAccountId(platform, asked);
    if (!accountId) return NextResponse.json({ error: "Identifiant TikTok invalide : des chiffres seulement." }, { status: 400 });
    if (!platformAccountInScope(scope, platform, accountId)) return NextResponse.json({ error: "compte hors périmètre" }, { status: 403 });
    const profile = await getAccountProfileSettings(platform, accountId);
    return NextResponse.json({ settings: visible.filter((s) => s.accountId === accountId), profile });
  }
  return NextResponse.json({ settings: visible });
}

export async function PUT(req: NextRequest) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;

  const body = await req.json().catch(() => null);
  if (!body || typeof body.accountId !== "string" || !body.accountId.trim()) {
    return NextResponse.json({ error: "accountId required" }, { status: 400 });
  }
  const platform = typeof body.platform === "string" && body.platform ? body.platform : "meta";
  if (!PLATFORMS.has(platform)) return NextResponse.json({ error: "plateforme inconnue (meta, google ou tiktok)" }, { status: 400 });
  const accountId = cleanAccountId(platform, body.accountId);
  if (!accountId) return NextResponse.json({ error: platform === "tiktok" ? "Identifiant TikTok invalide : des chiffres seulement." : "accountId required" }, { status: 400 });

  // AOV, currency and conversionEvent drive every revenue/ROAS figure and the AI
  // reports — a consultant must not be able to retune another client's numbers.
  const scope = await getAccountScope(guard.session);
  if (!platformAccountInScope(scope, platform, accountId)) {
    return NextResponse.json({ error: "compte hors périmètre" }, { status: 403 });
  }

  const aov =
    body.aov === null || body.aov === undefined
      ? null
      : Number(body.aov);
  if (aov !== null && (!Number.isFinite(aov) || aov <= 0 || aov > 100000)) {
    return NextResponse.json({ error: "aov must be a positive number" }, { status: 400 });
  }
  const currency = typeof body.currency === "string" && /^[A-Z]{3}$/.test(body.currency)
    ? body.currency
    : undefined;
  // purchase | lead | complete_registration | custom:<action_type>
  const conversionEvent =
    typeof body.conversionEvent === "string" &&
    /^(purchase|lead|complete_registration|custom:[a-z0-9_.]+)$/i.test(body.conversionEvent.trim())
      ? body.conversionEvent.trim()
      : undefined;

  // currency is never defaulted: unknown stays null until the platform profile (Meta, TikTok) fills it.
  const setting = await prisma.accountSetting.upsert({
    where: { platform_accountId: { platform, accountId } },
    create: { platform, accountId, aov, currency: currency ?? null, conversionEvent: conversionEvent ?? "purchase" },
    update: { aov, ...(currency ? { currency } : {}), ...(conversionEvent ? { conversionEvent } : {}) },
  });
  return NextResponse.json({ setting });
}
