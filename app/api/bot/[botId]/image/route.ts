/**
 * GET /api/bot/[botId]/image?ad=<platform>:<adId> — the visual of one of the
 * client's ads, for the creatives a client bot shows (lib/bot-ads-pack.ts).
 * The caller must be allowed on the bot (client user granted, or staff in
 * scope) AND the ad must belong to the bot's own accounts (dashboard Meta
 * account, Google customer, TikTok advertisers attached): a crafted address
 * cannot reach another client's creative.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/auth-helpers";
import { loadBotFor } from "@/lib/bot-access";
import { getDashboardTikTokIds } from "@/lib/tiktok-accounts";
import { freshMetaAdImage } from "@/lib/ads-warehouse/preview";

export const maxDuration = 30;

export async function GET(req: NextRequest, { params }: { params: Promise<{ botId: string }> }) {
  const guard = await requireSession();
  if ("error" in guard) return guard.error;
  const { botId } = await params;
  const loaded = await loadBotFor(guard.session, botId);
  if (loaded.status !== 200) return NextResponse.json({ error: loaded.status === 403 ? "forbidden" : "not found" }, { status: loaded.status });
  const m = /^(meta|google|tiktok):([\w-]{3,40})$/.exec(req.nextUrl.searchParams.get("ad") ?? "");
  if (!m) return NextResponse.json({ error: "annonce invalide" }, { status: 400 });
  const [, platform, adId] = m;
  const row = await prisma.adCatalog.findUnique({ where: { id: `${platform}:${adId}` }, select: { accountId: true, imageUrl: true, thumbnailUrl: true } });
  if (!row) return NextResponse.json({ error: "annonce inconnue" }, { status: 404 });
  const d = loaded.bot.dashboard;
  const own = platform === "meta" ? (d.metaAccountId ?? "").replace(/^act_/, "") === row.accountId
    : platform === "google" ? (d.googleCustomerId ?? "").replace(/-/g, "") === row.accountId
    : (await getDashboardTikTokIds(d.id)).includes(row.accountId);
  if (!own) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const url = platform === "meta" ? (await freshMetaAdImage(adId))?.url ?? null : row.imageUrl || row.thumbnailUrl;
  if (!url || !/^https:\/\//.test(url)) return NextResponse.json({ error: "visuel indisponible" }, { status: 404 });
  return NextResponse.redirect(url, { status: 302, headers: { "Cache-Control": "private, max-age=3600" } });
}
