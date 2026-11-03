/**
 * Comments under a client's Meta ads — the customers' own words for the
 * statics factory (lib/creas/context.ts). On with META_COMMENTS=1.
 *
 * /{story}/comments needs a PAGE token (the system user token is refused
 * with « Invalid OAuth 2.0 Access Token »): /{page}?fields=access_token with
 * the system user token, which only works for the Pages assigned to the
 * system user in Business Settings (26 on 2026-11-03; the others are skipped).
 *
 * Path: ad → creative.effective_object_story_id → page token → /{story}/comments. Cached
 * 24 h per ad set of ids (in memory: one instance warm), 200 comments max,
 * spam and tags-only comments dropped.
 */

import { getMetaSystemToken, metaGraphGet } from "@/lib/meta-api";

export const metaCommentsOpen = () => process.env.META_COMMENTS === "1";

export interface AdComment { adId: string; text: string; likes: number; at: string | null }

const MAX_COMMENTS = 200;
const PER_AD = 50;
const TTL_MS = 24 * 3600 * 1000;
const cache = new Map<string, { at: number; comments: AdComment[] }>();
const pageTokens = new Map<string, { at: number; token: string | null }>();

/** Page token of a Page assigned to the system user (null = not assigned), cached 1 h. */
export async function pageToken(pageId: string, systemToken: string): Promise<string | null> {
  const hit = pageTokens.get(pageId);
  if (hit && Date.now() - hit.at < 3600 * 1000) return hit.token;
  let token: string | null = null;
  try { token = (await metaGraphGet<{ access_token?: string }>(`/${pageId}`, systemToken, { fields: "access_token" })).access_token ?? null; } catch { token = null; }
  pageTokens.set(pageId, { at: Date.now(), token });
  return token;
}

/** A comment worth reading: words (not only @tags or emojis), no link, not a copy-paste of a spam template. */
export function usefulComment(text: string): boolean {
  const t = text.replace(/@\[\d+:[^\]]*\]|@\S+/g, " ").replace(/\s+/g, " ").trim();
  if (t.length < 12) return false;
  if (/https?:\/\/|www\.|\bwhatsapp\b|\btelegram\b|\bdm me\b|\bcheck my\b/i.test(t)) return false;
  return (t.match(/\p{L}/gu) ?? []).length >= 8;
}

/** Most liked first, duplicates (same text) once, capped. */
export function pickComments(list: AdComment[], max = MAX_COMMENTS): AdComment[] {
  const seen = new Set<string>();
  return [...list]
    .filter((c) => usefulComment(c.text))
    .sort((a, b) => b.likes - a.likes)
    .filter((c) => { const k = c.text.toLowerCase().replace(/\W+/g, " ").trim(); if (seen.has(k)) return false; seen.add(k); return true; })
    .slice(0, max);
}

/** Comments of the given ads (best effort: an ad whose Page is not readable is skipped). Empty when the flag is off. */
export async function readAdComments(adIds: string[]): Promise<{ comments: AdComment[]; errors: number }> {
  if (!metaCommentsOpen() || !adIds.length) return { comments: [], errors: 0 };
  const ids = [...new Set(adIds.filter((id) => /^\d{5,25}$/.test(id)))].slice(0, 20);
  const key = ids.join(",");
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return { comments: hit.comments, errors: 0 };
  const token = getMetaSystemToken();
  let errors = 0;
  const all: AdComment[] = [];
  await Promise.all(ids.map(async (adId) => {
    try {
      const ad = await metaGraphGet<{ creative?: { effective_object_story_id?: string } }>(`/${adId}`, token, { fields: "creative{effective_object_story_id}" });
      const story = ad.creative?.effective_object_story_id;
      if (!story || !/^\d+_\d+$/.test(story)) return;
      const pt = await pageToken(story.split("_")[0], token);
      if (!pt) { errors += 1; return; }
      const pageId = story.split("_")[0];
      const res = await metaGraphGet<{ data?: Array<{ message?: string; like_count?: number; created_time?: string; from?: { id?: string } }> }>(`/${story}/comments`, pt, { fields: "message,like_count,created_time,from{id}", limit: String(PER_AD), order: "reverse_chronological", filter: "stream" });
      // The brand's own replies are not the customers' words.
      for (const c of res.data ?? []) if (c.message && c.from?.id !== pageId) all.push({ adId, text: c.message.slice(0, 500), likes: c.like_count ?? 0, at: c.created_time ?? null });
    } catch { errors += 1; }
  }));
  const comments = pickComments(all);
  cache.set(key, { at: Date.now(), comments });
  return { comments, errors };
}
