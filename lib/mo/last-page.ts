/**
 * Coming back to Mo where one left it: the page opened last and the camera of
 * each page, kept in the browser (localStorage), per person — the keys carry
 * the id of the person's « Aujourd'hui » board, one per person. Pure helpers
 * (unit-tested) plus thin storage wrappers that never throw.
 */

import type { MoPages } from "@/lib/mo/pages";

export interface SavedView { x: number; y: number; k: number }
type ViewEntry = SavedView & { at: number };
export type SavedViews = Record<string, ViewEntry>;

/** Pages whose camera is remembered (the most recently seen ones). */
export const MAX_SAVED_VIEWS = 40;
/** Zoom bounds of the board (components/mo/board.tsx). */
const K_MIN = 0.2, K_MAX = 2.2;

export const lastPageKey = (homeId: string) => `mo:last-page:${homeId}`;
export const viewsKey = (homeId: string) => `mo:views:${homeId}`;

/** Every page of the workspace that can be opened (archived ones are not listed by /api/mo). */
export const livePageIds = (pages: MoPages): Set<string> => new Set([pages.home.id, ...pages.client.map((p) => p.id), ...pages.free.map((p) => p.id)]);

/**
 * The page to open on arrival: the deep link (/mo?b=…) when there is one,
 * else the page opened last when it still exists and is not archived, else
 * « Aujourd'hui ».
 */
export function startPageId(pages: MoPages, deepLink: string | null, last: string | null): string {
  if (deepLink) return deepLink;
  if (last && livePageIds(pages).has(last)) return last;
  return pages.home.id;
}

export function isValidView(v: unknown): v is SavedView {
  if (!v || typeof v !== "object") return false;
  const { x, y, k } = v as Record<string, unknown>;
  return typeof x === "number" && typeof y === "number" && typeof k === "number" && Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(k) && k >= K_MIN && k <= K_MAX && Math.abs(x) < 1e7 && Math.abs(y) < 1e7;
}

/** The saved cameras from their JSON (anything malformed is dropped). */
export function parseViews(raw: string | null): SavedViews {
  if (!raw) return {};
  let data: unknown;
  try { data = JSON.parse(raw); } catch { return {}; }
  if (!data || typeof data !== "object" || Array.isArray(data)) return {};
  const out: SavedViews = {};
  for (const [id, v] of Object.entries(data as Record<string, unknown>)) {
    if (!isValidView(v)) continue;
    const at = (v as { at?: unknown }).at;
    out[id] = { x: v.x, y: v.y, k: v.k, at: typeof at === "number" && Number.isFinite(at) ? at : 0 };
  }
  return out;
}

/** The cameras with this page's one set (rounded), the oldest dropped past MAX_SAVED_VIEWS. */
export function withView(views: SavedViews, pageId: string, view: SavedView, now: number, max = MAX_SAVED_VIEWS): SavedViews {
  if (!isValidView(view)) return views;
  const next: SavedViews = { ...views, [pageId]: { x: Math.round(view.x), y: Math.round(view.y), k: Math.round(view.k * 1000) / 1000, at: now } };
  const ids = Object.keys(next);
  if (ids.length <= max) return next;
  const keep = new Set(ids.sort((a, b) => next[b].at - next[a].at).slice(0, max));
  return Object.fromEntries(Object.entries(next).filter(([id]) => keep.has(id)));
}

export const viewOf = (views: SavedViews, pageId: string): SavedView | null => {
  const v = views[pageId];
  return v ? { x: v.x, y: v.y, k: v.k } : null;
};

// ── Storage (browser) ───────────────────────────────────────────────────────

const read = (key: string): string | null => { try { return localStorage.getItem(key); } catch { return null; } };
const write = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* private mode, quota: not kept */ } };

export const readLastPage = (homeId: string): string | null => read(lastPageKey(homeId));
export const saveLastPage = (homeId: string, pageId: string) => write(lastPageKey(homeId), pageId);
export const readView = (homeId: string, pageId: string): SavedView | null => viewOf(parseViews(read(viewsKey(homeId))), pageId);
export const saveView = (homeId: string, pageId: string, view: SavedView) => write(viewsKey(homeId), JSON.stringify(withView(parseViews(read(viewsKey(homeId))), pageId, view, Date.now())));
