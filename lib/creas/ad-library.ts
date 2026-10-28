/**
 * Meta Ad Library (competitors' ads). The API answers only to a token of a
 * person who confirmed their identity at facebook.com/ads/library/api (the
 * system user token is refused, code 10 / 2332002): META_AD_LIBRARY_TOKEN.
 * EU ads of every kind are listed (ad_type=ALL); the picture is not in the
 * API — the snapshot page is (ad_snapshot_url, rendered with the token).
 */

import { RELAY_URLS } from "@/lib/relay-server";
import { relayHeaders } from "@/lib/relay-headers";

export interface AdLibraryAd {
  id: string;
  pageId: string;
  pageName: string;
  bodies: string[];
  titles: string[];
  snapshotUrl: string | null;
  /** ISO date (API) or the page's wording ("5 jan 2026") when read from the public page. */
  startedAt: string | null;
  platforms: string[];
  euReach: number | null;
  /** Picture of the ad (or the video's poster) — only the public page gives it. */
  imageUrl?: string | null;
  videoUrl?: string | null;
  domain?: string | null;
}

interface RelayAd { id: string; pageName: string; body: string; started: string | null; platforms: string[]; image: string | null; video: string | null; poster: string | null; domain: string | null; snapshot: string }

/**
 * The public page of the Ad Library, read by the relay's headless Chromium
 * (server/adlib.mjs): no token, pictures included. Null when the relay cannot.
 */
async function searchViaRelay(opts: { q: string; country: string; limit: number; active: boolean }): Promise<{ ads: AdLibraryAd[]; total: number | null } | null> {
  const qs = new URLSearchParams({ q: opts.q, country: opts.country, limit: String(opts.limit), ...(opts.active ? {} : { all: "1" }) });
  for (const url of RELAY_URLS) {
    try {
      const res = await fetch(`${url}/api/adlib/search?${qs}`, { headers: relayHeaders(), signal: AbortSignal.timeout(url.includes("localhost") && RELAY_URLS.length > 1 ? 4000 : 75_000) });
      if (res.status === 503) return null;
      if (!res.ok) continue;
      const j = (await res.json()) as { ads?: RelayAd[]; total?: number | null };
      return {
        total: j.total ?? null,
        ads: (j.ads ?? []).filter((a) => a && typeof a.id === "string").map((a) => ({
          id: a.id, pageId: "", pageName: a.pageName || "", bodies: a.body ? [a.body] : [], titles: [], snapshotUrl: a.snapshot, startedAt: a.started, platforms: a.platforms ?? [], euReach: null,
          imageUrl: a.image ?? a.poster ?? null, videoUrl: a.video ?? null, domain: a.domain ?? null,
        })),
      };
    } catch { /* next relay */ }
  }
  return null;
}

const API = "https://graph.facebook.com/v21.0/ads_archive";
const FIELDS = "id,page_id,page_name,ad_creative_bodies,ad_creative_link_titles,ad_snapshot_url,ad_delivery_start_time,publisher_platforms,eu_total_reach";

/** True when a search can be done: the relay reads the public page, or the API token is there. */
export const adLibraryConfigured = () => RELAY_URLS.length > 0 || !!process.env.META_AD_LIBRARY_TOKEN;

/** The one-time steps the admin has to do before the search works. */
export const AD_LIBRARY_SETUP = "La recherche dans la bibliothèque publicitaire Meta demande un jeton d'une personne ayant confirmé son identité : 1) facebook.com/ID → confirmer l'identité ; 2) facebook.com/ads/library/api → accepter les conditions ; 3) générer un jeton utilisateur (Graph API Explorer, app ImpulseMotion) et le poser dans META_AD_LIBRARY_TOKEN sur Vercel. En attendant : importez la pub (capture, fichier ou lien de l'image).";

export async function searchAdLibrary(opts: { q?: string; pageIds?: string[]; country?: string; limit?: number; active?: boolean }): Promise<{ ads: AdLibraryAd[]; total?: number | null; error?: string }> {
  // The public page first (pictures, no token); the API only with a token when the relay cannot.
  if (opts.q?.trim() && !opts.pageIds?.length) {
    const viaRelay = await searchViaRelay({ q: opts.q.trim().slice(0, 100), country: opts.country ?? "FR", limit: Math.min(60, Math.max(1, opts.limit ?? 24)), active: opts.active !== false });
    if (viaRelay) return viaRelay;
  }
  const token = process.env.META_AD_LIBRARY_TOKEN;
  if (!token) return { ads: [], error: AD_LIBRARY_SETUP };
  const params = new URLSearchParams({
    access_token: token, fields: FIELDS, ad_type: "ALL", ad_reached_countries: JSON.stringify([opts.country ?? "FR"]),
    ad_active_status: opts.active === false ? "ALL" : "ACTIVE", limit: String(Math.min(50, Math.max(1, opts.limit ?? 24))),
  });
  if (opts.pageIds?.length) params.set("search_page_ids", JSON.stringify(opts.pageIds.slice(0, 10)));
  else if (opts.q?.trim()) params.set("search_terms", opts.q.trim().slice(0, 100));
  else return { ads: [] };
  try {
    const res = await fetch(`${API}?${params}`, { signal: AbortSignal.timeout(20_000) });
    const json = (await res.json().catch(() => ({}))) as { data?: Array<Record<string, unknown>>; error?: { message?: string; code?: number } };
    if (!res.ok || json.error) {
      const code = json.error?.code;
      return { ads: [], error: code === 10 ? AD_LIBRARY_SETUP : `Meta : ${json.error?.message ?? `HTTP ${res.status}`}` };
    }
    const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 5) : []);
    return {
      ads: (json.data ?? []).map((a) => ({
        id: String(a.id ?? ""), pageId: String(a.page_id ?? ""), pageName: String(a.page_name ?? ""),
        bodies: strs(a.ad_creative_bodies), titles: strs(a.ad_creative_link_titles),
        snapshotUrl: typeof a.ad_snapshot_url === "string" ? a.ad_snapshot_url : null,
        startedAt: typeof a.ad_delivery_start_time === "string" ? a.ad_delivery_start_time : null,
        platforms: strs(a.publisher_platforms), euReach: typeof a.eu_total_reach === "number" ? a.eu_total_reach : null,
      })).filter((a) => a.id),
    };
  } catch (e) {
    return { ads: [], error: `Bibliothèque Meta injoignable (${e instanceof Error ? e.message : String(e)})` };
  }
}
