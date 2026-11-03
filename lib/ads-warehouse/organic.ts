/**
 * Organique — Motion's « Organic » tab, on what Meta lets us read: the
 * organic Facebook posts of the client's Pages (the Pages its ad accounts
 * promote) over 90 days, with their figures (views, reach, clicks, video
 * views, reactions, comments, shares) and whether they are already promoted.
 * Posts that engage well above the Page's median and are not promoted are
 * flagged « À sponsoriser » — the classic organic → ads move.
 *
 * Page token needed (Pages assigned to the system user); Instagram and
 * hashtag search need instagram_basic, which the token does not have.
 * Cached 30 min per Page (one warm instance).
 */

import { getMetaSystemToken, metaGraphGet } from "@/lib/meta-api";
import { pageToken } from "@/lib/meta-comments";
import type { AdsQuery } from "./query";

export interface OrganicPage { id: string; name: string; readable: boolean; followers: number | null }
export interface OrganicPost {
  id: string; pageId: string; pageName: string; text: string; createdAt: string; picture: string | null; permalink: string | null;
  kind: "video" | "photo" | "link" | "text" | "other";
  promoted: boolean;
  views: number; reach: number; clicks: number; videoViews: number; reactions: number; comments: number; shares: number;
  engagement: number;
  /** (reactions + comments + shares) / reach, 0 when no reach. */
  engagementRate: number;
  /** Engagement rate / the Page's median (1 = median). */
  vsMedian: number | null;
  suggest: boolean;
}
export interface OrganicResult { pages: OrganicPage[]; posts: OrganicPost[]; since: string }

const DAYS = 90;
const TTL = 30 * 60_000;
const cache = new Map<string, { at: number; posts: OrganicPost[]; page: OrganicPage }>();

type RawPost = {
  id: string; message?: string; created_time?: string; full_picture?: string; permalink_url?: string; status_type?: string; promotion_status?: string;
  attachments?: { data?: Array<{ media_type?: string }> };
  shares?: { count?: number }; reactions?: { summary?: { total_count?: number } }; comments?: { summary?: { total_count?: number } };
  insights?: { data?: Array<{ name: string; period?: string; values?: Array<{ value?: unknown }> }> };
};

export const median = (xs: number[]): number => {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return 0;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export function kindOf(p: Pick<RawPost, "status_type" | "attachments">): OrganicPost["kind"] {
  const m = p.attachments?.data?.[0]?.media_type ?? "";
  if (m === "video" || /video/.test(p.status_type ?? "")) return "video";
  if (m === "photo" || m === "album" || /photo/.test(p.status_type ?? "")) return "photo";
  if (m === "link" || p.status_type === "shared_story") return "link";
  if (!m && p.status_type === "mobile_status_update") return "text";
  return "other";
}

/** Raw Graph posts → OrganicPost with the Page's median and the « À sponsoriser » flag. */
export function shapePosts(raw: RawPost[], page: { id: string; name: string }): OrganicPost[] {
  const posts = raw.map((p) => {
    // Meta may send a metric twice (lifetime, then per day): keep the lifetime one.
    const ins: Record<string, number> = {};
    for (const d of p.insights?.data ?? []) if (d.period === "lifetime" || !(d.name in ins)) ins[d.name] = Number(d.values?.[0]?.value ?? 0) || 0;
    const reactions = p.reactions?.summary?.total_count ?? 0, comments = p.comments?.summary?.total_count ?? 0, shares = p.shares?.count ?? 0;
    const reach = ins.post_total_media_view_unique ?? 0;
    const engagement = reactions + comments + shares;
    return {
      id: p.id, pageId: page.id, pageName: page.name, text: (p.message ?? "").slice(0, 600), createdAt: p.created_time ?? "",
      picture: p.full_picture ?? null, permalink: p.permalink_url ?? null, kind: kindOf(p),
      promoted: p.promotion_status === "active" || p.promotion_status === "extendable",
      views: ins.post_media_view ?? 0, reach, clicks: ins.post_clicks ?? 0, videoViews: ins.post_video_views ?? 0,
      reactions, comments, shares, engagement, engagementRate: reach > 0 ? engagement / reach : 0, vsMedian: null as number | null, suggest: false,
    };
  });
  const med = median(posts.filter((p) => p.reach >= 100).map((p) => p.engagementRate));
  const medReach = median(posts.map((p) => p.reach));
  for (const p of posts) {
    p.vsMedian = med > 0 && p.reach >= 100 ? p.engagementRate / med : null;
    // Engages ≥ 1.5× the Page's median with a reach that is not marginal, and not already promoted.
    p.suggest = !p.promoted && p.vsMedian !== null && p.vsMedian >= 1.5 && p.reach >= Math.max(100, medReach * 0.3);
  }
  return posts;
}

async function readPage(pageId: string, sys: string): Promise<{ page: OrganicPage; posts: OrganicPost[] }> {
  const hit = cache.get(pageId);
  if (hit && Date.now() - hit.at < TTL) return { page: hit.page, posts: hit.posts };
  const pt = await pageToken(pageId, sys);
  if (!pt) return { page: { id: pageId, name: "", readable: false, followers: null }, posts: [] };
  const info = await metaGraphGet<{ name?: string; followers_count?: number }>(`/${pageId}`, pt, { fields: "name,followers_count" });
  const page: OrganicPage = { id: pageId, name: info.name ?? pageId, readable: true, followers: info.followers_count ?? null };
  const res = await metaGraphGet<{ data?: RawPost[] }>(`/${pageId}/published_posts`, pt, {
    fields: "id,message,created_time,full_picture,permalink_url,status_type,promotion_status,attachments{media_type},shares,reactions.summary(true).limit(0),comments.summary(true).limit(0),insights.metric(post_media_view,post_total_media_view_unique,post_clicks,post_video_views)",
    limit: "100", since: String(Math.floor(Date.now() / 1000) - DAYS * 86400),
  });
  const posts = shapePosts(res.data ?? [], page);
  cache.set(pageId, { at: Date.now(), page, posts });
  return { page, posts };
}

/** The organic posts of the Pages promoted by the client's Meta ad accounts. */
export async function readOrganic(q: AdsQuery): Promise<OrganicResult> {
  const accounts = (q.accounts ? q.accounts.filter((a) => a.platform === "meta").map((a) => a.id) : q.platforms.includes("meta") && q.platforms.length === 1 ? q.accountIds : []).slice(0, 10);
  const since = new Date(Date.now() - DAYS * 86400_000).toISOString().slice(0, 10);
  if (!accounts.length) return { pages: [], posts: [], since };
  const sys = getMetaSystemToken();
  const pageIds = new Set<string>();
  const names = new Map<string, string>();
  await Promise.all(accounts.map(async (a) => {
    try {
      const r = await metaGraphGet<{ data?: Array<{ id: string; name?: string }> }>(`/act_${a.replace(/^act_/, "")}/promote_pages`, sys, { fields: "id,name", limit: "20" });
      for (const p of r.data ?? []) { pageIds.add(p.id); if (p.name) names.set(p.id, p.name); }
    } catch { /* account without Pages / not readable */ }
  }));
  const pages: OrganicPage[] = [];
  const posts: OrganicPost[] = [];
  await Promise.all(Array.from(pageIds).slice(0, 8).map(async (id) => {
    try {
      const r = await readPage(id, sys);
      pages.push({ ...r.page, name: r.page.name || names.get(id) || id });
      posts.push(...r.posts);
    } catch { pages.push({ id, name: names.get(id) ?? id, readable: false, followers: null }); }
  }));
  pages.sort((a, b) => Number(b.readable) - Number(a.readable) || (b.followers ?? 0) - (a.followers ?? 0));
  posts.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return { pages, posts, since };
}
