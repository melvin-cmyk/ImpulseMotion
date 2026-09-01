/**
 * "What changed" detector for one Meta account: last 30 FULL days vs the
 * previous 30 (account timezone, no partial day). Ads / ad insights are
 * fetched fully paginated and cached (`meta:changes:{account}:{since}_{until}`)
 * with the range TTL policy, so "créa arrêtée / nouveau winner" are computed
 * on complete lists. Revenue-based signals are skipped when revenue is
 * unavailable (no tracked value, no AOV).
 */

import {
  getAdsPaged,
  getAdInsightsPaged,
  getMetaSystemToken,
  computeRevenue,
  type MetaAd,
  type MetaAccountInsight,
  type MetaCreativeInsight,
} from "@/lib/meta-api";
import { getAccountInsightsCached } from "@/lib/insights";
import { getAccountProfileSettings } from "@/lib/account-settings";
import { cached, ttlForRange } from "@/lib/kpi-cache";
import { lastFullDays, prevRange, type DateRange } from "@/lib/date-ranges";

export type ChangeSeverity = "info" | "warning" | "critical" | "positive";

export type ChangeKind =
  | "metric_drop"
  | "metric_jump"
  | "creative_killed"
  | "creative_new_winner"
  | "spend_pacing"
  | "audience_fatigue";

export interface ChangeEvent {
  kind: ChangeKind;
  severity: ChangeSeverity;
  accountId: string;
  accountLabel?: string | null;
  /** Portfolio client id (primary dashboard) when known. */
  clientId?: string | null;
  metric?: string;
  before?: number;
  after?: number;
  deltaPct?: number;
  currency?: string | null;
  title: string;
  detail: string;
  evidence?: Record<string, unknown>;
}

export interface DetectOptions {
  tz?: string | null;
  refresh?: boolean;
  now?: Date;
  clientId?: string | null;
  /** Max creative events of each kind per account (default 15) — big accounts rotate hundreds of ads. */
  maxCreativeEvents?: number;
}

const DEFAULT_MAX_CREATIVE_EVENTS = 15;

export interface DetectResult {
  events: ChangeEvent[];
  range: DateRange;
  compare: DateRange;
  /** true when an ads/insights list hit the pagination cap. */
  truncated: boolean;
  revenueAvailable: boolean;
  /** Creative events dropped by the per-account cap (least significant by spend). */
  creativeSkipped: number;
}

function pctChange(before: number, after: number): number | null {
  if (before === 0) return null;
  return Math.round(((after - before) / before) * 1000) / 10;
}

const money = (n: number, currency?: string | null) =>
  currency
    ? new Intl.NumberFormat("fr-FR", { style: "currency", currency, maximumFractionDigits: 0 }).format(n)
    : Math.round(n).toLocaleString("fr-FR");

function accountSpend(insight: MetaAccountInsight | null): number {
  return parseFloat(insight?.spend ?? "0") || 0;
}

function accountRoas(insight: MetaAccountInsight | null, aov: number | null): number | null {
  if (!insight) return null;
  const spend = parseFloat(insight.spend) || 0;
  const rev = computeRevenue(insight, aov);
  if (rev.unavailable || spend <= 0) return null;
  return Math.round((rev.revenue / spend) * 100) / 100;
}

function accountFrequency(insight: MetaAccountInsight | null): number {
  return parseFloat(insight?.frequency ?? "0") || 0;
}

function adRoas(insight: MetaCreativeInsight, aov: number | null): number | null {
  const spend = parseFloat(insight.spend ?? "0") || 0;
  const rev = computeRevenue(insight, aov);
  if (rev.unavailable || spend <= 0) return null;
  return Math.round((rev.revenue / spend) * 100) / 100;
}

function adSpend(insight: MetaCreativeInsight): number {
  return parseFloat(insight.spend ?? "0") || 0;
}

interface WindowPayload {
  ads: MetaAd[] | null;
  insights: MetaCreativeInsight[];
  truncated: boolean;
}

async function loadWindow(
  token: string,
  accountId: string,
  range: DateRange,
  withAds: boolean,
  opts: { tz?: string | null; refresh?: boolean },
): Promise<WindowPayload> {
  const id = accountId.replace(/^act_/, "");
  return cached<WindowPayload>(
    `meta:changes:${id}:${range.since}_${range.until}${withAds ? ":ads" : ""}`,
    async () => {
      const [ads, insights] = await Promise.all([
        withAds ? getAdsPaged(token, accountId) : Promise.resolve(null),
        getAdInsightsPaged(token, accountId, range),
      ]);
      return {
        ads: ads ? ads.data : null,
        insights: insights.data,
        truncated: insights.truncated || !!ads?.truncated,
      };
    },
    { ttlMs: ttlForRange(range, { tz: opts.tz }), refresh: opts.refresh },
  );
}

/** Rich result: events + the windows used + truncation flag. */
export async function detectAccountChangesDetailed(
  accountId: string,
  accountLabel?: string | null,
  opts: DetectOptions = {},
): Promise<DetectResult> {
  const token = getMetaSystemToken();
  const settings = await getAccountProfileSettings("meta", accountId);
  const tz = opts.tz === undefined ? settings.timezone : opts.tz;
  const aov = settings.aov;
  const currentRange = lastFullDays(30, { tz, now: opts.now });
  const previousRange = prevRange(currentRange);

  const [currentAccount, previousAccount, currentWin, previousWin] = await Promise.all([
    getAccountInsightsCached(token, accountId, currentRange).catch((): MetaAccountInsight | null => null),
    getAccountInsightsCached(token, accountId, previousRange).catch((): MetaAccountInsight | null => null),
    loadWindow(token, accountId, currentRange, true, { tz, refresh: opts.refresh }).catch((): WindowPayload => ({ ads: null, insights: [], truncated: false })),
    loadWindow(token, accountId, previousRange, false, { tz, refresh: opts.refresh }).catch((): WindowPayload => ({ ads: null, insights: [], truncated: false })),
  ]);

  const currency = currentAccount?.currency ?? settings.currency ?? null;
  const events: ChangeEvent[] = [];
  const common = { accountId, accountLabel, clientId: opts.clientId ?? null, currency };
  let revenueAvailable = false;

  // ── Account-level metric movements ─────────────────────────────────────
  if (currentAccount && previousAccount) {
    const curSpend = accountSpend(currentAccount);
    const prevSpend = accountSpend(previousAccount);
    const spendDelta = pctChange(prevSpend, curSpend);

    if (spendDelta !== null && Math.abs(spendDelta) >= 25) {
      events.push({
        ...common,
        kind: "spend_pacing",
        severity: spendDelta < -50 || spendDelta > 100 ? "warning" : "info",
        metric: "spend",
        before: Math.round(prevSpend),
        after: Math.round(curSpend),
        deltaPct: spendDelta,
        title: `Dépenses ${spendDelta > 0 ? "+" : ""}${spendDelta}% sur 30 j`,
        detail: `${money(prevSpend, currency)} → ${money(curSpend, currency)} vs période précédente`,
      });
    }

    const curRoas = accountRoas(currentAccount, aov);
    const prevRoas = accountRoas(previousAccount, aov);
    revenueAvailable = curRoas !== null;
    if (curRoas !== null && prevRoas !== null) {
      const roasDelta = pctChange(prevRoas, curRoas);
      if (roasDelta !== null && Math.abs(roasDelta) >= 15 && prevRoas > 0.5) {
        events.push({
          ...common,
          kind: roasDelta < 0 ? "metric_drop" : "metric_jump",
          severity: roasDelta < -25 ? "critical" : roasDelta < 0 ? "warning" : "positive",
          metric: "roas",
          before: prevRoas,
          after: curRoas,
          deltaPct: roasDelta,
          title: `ROAS ${roasDelta > 0 ? "+" : ""}${roasDelta}% (${prevRoas.toFixed(2)}x → ${curRoas.toFixed(2)}x)`,
          detail: roasDelta < 0
            ? "Le ROAS s'est dégradé sur les 30 derniers jours complets."
            : "Le ROAS s'est amélioré sur les 30 derniers jours complets.",
        });
      }
    }

    const curFreq = accountFrequency(currentAccount);
    const prevFreq = accountFrequency(previousAccount);
    if (curFreq > 4 && curFreq > prevFreq * 1.2) {
      events.push({
        ...common,
        kind: "audience_fatigue",
        severity: curFreq > 6 ? "critical" : "warning",
        metric: "frequency",
        before: prevFreq,
        after: curFreq,
        deltaPct: pctChange(prevFreq, curFreq) ?? 0,
        title: `Fréquence en hausse (${prevFreq.toFixed(2)} → ${curFreq.toFixed(2)})`,
        detail: `Possible fatigue d'audience — la même personne voit la pub ${curFreq.toFixed(1)} fois en moyenne.`,
      });
    }
  }

  // ── Per-creative status changes (complete, paginated lists) ────────────
  const currentByAd = new Map(currentWin.insights.map((i) => [i.ad_id, i]));
  const previousByAd = new Map(previousWin.insights.map((i) => [i.ad_id, i]));
  const adsById = new Map((currentWin.ads ?? []).map((a) => [a.id, a]));

  const killed: Array<ChangeEvent & { _rank: number }> = [];
  const winners: Array<ChangeEvent & { _rank: number }> = [];
  const cap = Math.max(1, opts.maxCreativeEvents ?? DEFAULT_MAX_CREATIVE_EVENTS);

  // Killed: had significant spend before, (almost) none now
  for (const [adId, prevInsight] of previousByAd) {
    const prevSpend = adSpend(prevInsight);
    if (prevSpend < 50) continue; // ignore noise
    const current = currentByAd.get(adId);
    const curSpend = current ? adSpend(current) : 0;
    if (curSpend < prevSpend * 0.1) {
      const prevRoasVal = adRoas(prevInsight, aov);
      const wasWinner = prevRoasVal !== null && prevRoasVal >= 2.5;
      const ad = adsById.get(adId);
      killed.push({
        _rank: prevSpend,
        ...common,
        kind: "creative_killed",
        severity: wasWinner ? "warning" : "info",
        title: `Créa "${ad?.name ?? prevInsight.ad_name ?? adId}" arrêtée`,
        detail: `Dépenses ${money(prevSpend, currency)} → ${money(curSpend, currency)}${
          prevRoasVal !== null ? ` · ROAS période précédente ${prevRoasVal.toFixed(2)}x.` : "."
        }${wasWinner ? " C'était un winner — vérifier pourquoi elle a été coupée." : ""}`,
        evidence: { adId, prevSpend, prevRoas: prevRoasVal },
      });
    }
  }

  // New winners: significant spend now at a good ROAS, minimal before (needs revenue)
  for (const [adId, current] of currentByAd) {
    const curSpend = adSpend(current);
    if (curSpend < 200) continue;
    const curRoasVal = adRoas(current, aov);
    if (curRoasVal === null || curRoasVal < 2.5) continue;
    const prevInsight = previousByAd.get(adId);
    const prevSpend = prevInsight ? adSpend(prevInsight) : 0;
    if (prevSpend < 50) {
      const ad = adsById.get(adId);
      winners.push({
        _rank: curSpend,
        ...common,
        kind: "creative_new_winner",
        severity: "positive",
        title: `Nouveau winner : "${ad?.name ?? current.ad_name ?? adId}"`,
        detail: `${money(curSpend, currency)} dépensés à ${curRoasVal.toFixed(2)}x — créa montante des 30 derniers jours.`,
        evidence: { adId, curSpend, curRoas: curRoasVal },
      });
    }
  }

  // Keep the most significant creative events only (by spend), winners flagged first.
  const top = (list: Array<ChangeEvent & { _rank: number }>) =>
    list.sort((a, b) => b._rank - a._rank).slice(0, cap).map(({ _rank, ...e }) => { void _rank; return e; });
  const creativeSkipped = Math.max(0, killed.length - cap) + Math.max(0, winners.length - cap);
  events.push(...top(killed), ...top(winners));

  // Sort: critical → warning → positive → info; ties by absolute delta
  const sevRank: Record<ChangeSeverity, number> = { critical: 0, warning: 1, positive: 2, info: 3 };
  events.sort((a, b) => {
    const r = sevRank[a.severity] - sevRank[b.severity];
    if (r !== 0) return r;
    return Math.abs(b.deltaPct ?? 0) - Math.abs(a.deltaPct ?? 0);
  });

  return {
    events,
    range: currentRange,
    compare: previousRange,
    truncated: currentWin.truncated || previousWin.truncated,
    revenueAvailable,
    creativeSkipped,
  };
}

/** Compute change events for a single account (last 30 full days vs the previous 30). */
export async function detectAccountChanges(
  accountId: string,
  accountLabel?: string | null,
  opts: DetectOptions = {},
): Promise<ChangeEvent[]> {
  return (await detectAccountChangesDetailed(accountId, accountLabel, opts)).events;
}
