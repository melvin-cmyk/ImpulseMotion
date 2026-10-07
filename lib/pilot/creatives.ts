/**
 * Pilotage — the ads of a Meta account as creatives: the last 7 full days
 * against the 7 before (spend, impressions, CTR, frequency, conversions, cost
 * per result), the visual, and what to look at: fatigue (frequency up, CTR
 * down), spend without a conversion, a new winner. The same Meta reads as the
 * reports (ads + ad-level insights), the account's conversion event.
 */

import { getAdInsightsAll, getAds, getMetaSystemToken, purchasesFor, type MetaCreativeInsight } from "@/lib/meta-api";
import { getAccountProfileSettings } from "@/lib/account-settings";
import { parisDayOf } from "@/lib/pilot/ops";
import { metaAccountDigits } from "@/lib/routines/accounts";

export interface CreativeWindow { spend: number; impressions: number; clicks: number; ctr: number | null; frequency: number | null; conversions: number; cpa: number | null }

export interface CreativeRow {
  adId: string;
  name: string;
  adsetId: string;
  adsetName: string;
  campaignName: string;
  status: string;
  effectiveStatus: string;
  imageUrl: string | null;
  format: "video" | "image";
  last: CreativeWindow;
  prev: CreativeWindow | null;
  /** fatigue | burn | winner | new — what the figures say, or null. */
  flag: "fatigue" | "burn" | "winner" | "new" | null;
  flagText: string | null;
}

const n = (v: unknown) => (typeof v === "number" ? v : parseFloat(String(v ?? "0"))) || 0;

function windowOf(rows: MetaCreativeInsight[], conversionEvent: string | null | undefined): CreativeWindow {
  const spend = rows.reduce((s, r) => s + n(r.spend), 0);
  const impressions = rows.reduce((s, r) => s + n(r.impressions), 0);
  const clicks = rows.reduce((s, r) => s + n(r.clicks), 0);
  const conversions = rows.reduce((s, r) => s + purchasesFor(r, conversionEvent), 0);
  const reach = rows.reduce((s, r) => s + n((r as { reach?: string }).reach), 0);
  return {
    spend, impressions, clicks,
    ctr: impressions > 0 ? (clicks / impressions) * 100 : null,
    frequency: reach > 0 ? impressions / reach : null,
    conversions,
    cpa: conversions > 0 ? spend / conversions : null,
  };
}

/** What the two windows say about an ad. Pure. */
export function flagOf(last: CreativeWindow, prev: CreativeWindow | null): { flag: CreativeRow["flag"]; text: string | null } {
  if (last.spend >= 50 && last.conversions === 0 && (last.clicks >= 30 || last.impressions >= 5000)) return { flag: "burn", text: `${Math.round(last.spend)} dépensés sans conversion sur 7 jours` };
  if (prev && prev.impressions >= 1000 && last.impressions >= 1000 && last.frequency !== null && last.frequency >= 2.5 && last.ctr !== null && prev.ctr !== null && last.ctr < prev.ctr * 0.8) {
    return { flag: "fatigue", text: `fréquence ${last.frequency.toFixed(1)}, CTR ${last.ctr.toFixed(2)} % contre ${prev.ctr.toFixed(2)} % la semaine d'avant` };
  }
  if (!prev || prev.impressions < 200) { if (last.impressions >= 1000) return { flag: "new", text: "nouvelle diffusion cette semaine" }; return { flag: null, text: null }; }
  if (last.conversions >= 5 && last.cpa !== null && prev.cpa !== null && last.cpa < prev.cpa * 0.75) return { flag: "winner", text: `CPA ${Math.round(last.cpa)} contre ${Math.round(prev.cpa)} la semaine d'avant` };
  return { flag: null, text: null };
}

export async function readCreatives(accountId: string, now: Date = new Date()): Promise<{ since: string; until: string; rows: CreativeRow[] }> {
  const digits = metaAccountDigits(accountId);
  if (!digits) throw new Error("Compte Meta invalide");
  const token = getMetaSystemToken();
  const settings = await getAccountProfileSettings("meta", digits);
  const until = parisDayOf(new Date(now.getTime() - 86_400_000));
  const since = parisDayOf(new Date(now.getTime() - 7 * 86_400_000));
  const prevUntil = parisDayOf(new Date(now.getTime() - 8 * 86_400_000));
  const prevSince = parisDayOf(new Date(now.getTime() - 14 * 86_400_000));
  const [ads, last, prev] = await Promise.all([
    getAds(token, digits, 500),
    getAdInsightsAll(token, digits, { since, until }, 2000),
    getAdInsightsAll(token, digits, { since: prevSince, until: prevUntil }, 2000),
  ]);
  const byAd = (list: MetaCreativeInsight[]) => { const m = new Map<string, MetaCreativeInsight[]>(); for (const r of list) m.set(r.ad_id, [...(m.get(r.ad_id) ?? []), r]); return m; };
  const lastBy = byAd(last), prevBy = byAd(prev);
  const adsById = new Map(ads.map((a) => [a.id, a]));
  const ids = new Set([...lastBy.keys(), ...prevBy.keys()]);
  const rows: CreativeRow[] = [];
  for (const id of ids) {
    const ad = adsById.get(id);
    const l = lastBy.get(id) ?? [];
    const p = prevBy.get(id);
    const lastW = windowOf(l, settings.conversionEvent);
    const prevW = p ? windowOf(p, settings.conversionEvent) : null;
    if (lastW.spend === 0 && (!prevW || prevW.spend === 0)) continue;
    const sample = l[0] ?? p?.[0];
    const isVideo = !!ad?.creative?.video_id || ((sample as { video_play_actions?: unknown[] } | undefined)?.video_play_actions?.length ?? 0) > 0;
    const { flag, text } = flagOf(lastW, prevW);
    rows.push({
      adId: id, name: ad?.name ?? sample?.ad_name ?? id,
      adsetId: ad?.adset?.id ?? (sample as { adset_id?: string } | undefined)?.adset_id ?? "", adsetName: ad?.adset?.name ?? (sample as { adset_name?: string } | undefined)?.adset_name ?? "",
      campaignName: (sample as { campaign_name?: string } | undefined)?.campaign_name ?? "",
      status: ad?.status ?? "", effectiveStatus: ad?.effective_status ?? ad?.status ?? "",
      imageUrl: ad?.creative?.image_url ?? ad?.creative?.thumbnail_url ?? null, format: isVideo ? "video" : "image",
      last: lastW, prev: prevW, flag, flagText: text,
    });
  }
  rows.sort((a, b) => b.last.spend - a.last.spend);
  return { since, until, rows };
}
