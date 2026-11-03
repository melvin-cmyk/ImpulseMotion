/**
 * Media of a client bot's creatives (images, Meta videos), shared by
 * /api/bot/[botId]/image and /api/bot/[botId]/video: the caller must be
 * allowed on the bot AND the ad must belong to the bot's own accounts.
 */

import { prisma } from "@/lib/prisma";
import { loadBotFor } from "@/lib/bot-access";
import { getDashboardTikTokIds } from "@/lib/tiktok-accounts";
import { getMetaSystemToken, metaGraphGet } from "@/lib/meta-api";
import { pageToken } from "@/lib/meta-comments";

type Session = Parameters<typeof loadBotFor>[0];
export type BotAd = { platform: "meta" | "google" | "tiktok"; adId: string; imageUrl: string | null; thumbnailUrl: string | null; videoId: string | null };

/** The ad when the session may see it through this bot; else the HTTP status to answer. */
export async function botAd(session: Session, botId: string, ad: string): Promise<{ ad: BotAd } | { status: number; error: string }> {
  const loaded = await loadBotFor(session, botId);
  if (loaded.status !== 200) return { status: loaded.status, error: loaded.status === 403 ? "forbidden" : "not found" };
  const m = /^(meta|google|tiktok):([\w-]{3,40})$/.exec(ad);
  if (!m) return { status: 400, error: "annonce invalide" };
  const platform = m[1] as BotAd["platform"], adId = m[2];
  const row = await prisma.adCatalog.findUnique({ where: { id: `${platform}:${adId}` }, select: { accountId: true, imageUrl: true, thumbnailUrl: true, videoId: true } });
  if (!row) return { status: 404, error: "annonce inconnue" };
  const d = loaded.bot.dashboard;
  const own = platform === "meta" ? (d.metaAccountId ?? "").replace(/^act_/, "") === row.accountId
    : platform === "google" ? (d.googleCustomerId ?? "").replace(/-/g, "") === row.accountId
    : (await getDashboardTikTokIds(d.id)).includes(row.accountId);
  if (!own) return { status: 403, error: "forbidden" };
  return { ad: { platform, adId, imageUrl: row.imageUrl, thumbnailUrl: row.thumbnailUrl, videoId: row.videoId } };
}

const videoCache = new Map<string, { at: number; url: string | null }>();
const VIDEO_TTL = 30 * 60_000;

/**
 * Playable MP4 of a Meta video ad: the video's `source` needs the token of the
 * Page that published it (Page assigned to the system user), else null.
 */
export async function metaVideoSource(adId: string, videoId: string): Promise<string | null> {
  const hit = videoCache.get(adId);
  if (hit && Date.now() - hit.at < VIDEO_TTL) return hit.url;
  let url: string | null = null;
  try {
    const sys = getMetaSystemToken();
    const ad = await metaGraphGet<{ creative?: { effective_object_story_id?: string } }>(`/${adId}`, sys, { fields: "creative{effective_object_story_id}" });
    const pageId = ad.creative?.effective_object_story_id?.split("_")[0];
    const pt = pageId && /^\d+$/.test(pageId) ? await pageToken(pageId, sys) : null;
    if (pt) url = (await metaGraphGet<{ source?: string }>(`/${videoId}`, pt, { fields: "source" })).source ?? null;
  } catch { url = null; }
  if (url && !/^https:\/\//.test(url)) url = null;
  videoCache.set(adId, { at: Date.now(), url });
  return url;
}
