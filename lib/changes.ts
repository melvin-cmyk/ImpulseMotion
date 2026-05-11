import {
  getAds,
  getAdInsights,
  getAccountInsights,
  getActionValue,
  getMetaSystemToken,
  computeRoas,
  type MetaAd,
  type MetaCreativeInsight,
} from "@/lib/meta-api";

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
  metric?: string;
  before?: number;
  after?: number;
  deltaPct?: number;
  title: string;
  detail: string;
  evidence?: Record<string, unknown>;
}

function offsetDate(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().split("T")[0];
}

function pctChange(before: number, after: number): number | null {
  if (before === 0) return null;
  return Math.round(((after - before) / before) * 1000) / 10;
}

function accountSpend(insight: Awaited<ReturnType<typeof getAccountInsights>>): number {
  return parseFloat(insight?.spend ?? "0");
}

function accountRoas(insight: Awaited<ReturnType<typeof getAccountInsights>>): number {
  if (!insight) return 0;
  const spend = parseFloat(insight.spend);
  const purchaseValue = getActionValue(insight.actions, "purchase") * 20;
  return spend > 0 ? Math.round((purchaseValue / spend) * 100) / 100 : 0;
}

function accountFrequency(insight: Awaited<ReturnType<typeof getAccountInsights>>): number {
  return parseFloat(insight?.frequency ?? "0");
}

function adRoas(insight: MetaCreativeInsight): number {
  return computeRoas(insight);
}

function adSpend(insight: MetaCreativeInsight): number {
  return parseFloat(insight.spend ?? "0");
}

/** Compute change events for a single account, comparing last 30d vs prior 30d. */
export async function detectAccountChanges(
  accountId: string,
  accountLabel?: string | null,
): Promise<ChangeEvent[]> {
  const token = getMetaSystemToken();
  const currentRange = { since: offsetDate(-30), until: offsetDate(0) };
  const previousRange = { since: offsetDate(-60), until: offsetDate(-31) };

  const [currentAccount, previousAccount, currentAds, currentInsights, previousInsights] = await Promise.all([
    getAccountInsights(token, accountId, currentRange).catch(() => null),
    getAccountInsights(token, accountId, previousRange).catch(() => null),
    getAds(token, accountId, 100).catch((): MetaAd[] => []),
    getAdInsights(token, accountId, currentRange, 100).catch((): MetaCreativeInsight[] => []),
    getAdInsights(token, accountId, previousRange, 100).catch((): MetaCreativeInsight[] => []),
  ]);

  const events: ChangeEvent[] = [];

  // ── Account-level metric movements ─────────────────────────────────────
  if (currentAccount && previousAccount) {
    const curSpend = accountSpend(currentAccount);
    const prevSpend = accountSpend(previousAccount);
    const spendDelta = pctChange(prevSpend, curSpend);

    if (spendDelta !== null && Math.abs(spendDelta) >= 25) {
      events.push({
        kind: spendDelta < 0 ? "spend_pacing" : "spend_pacing",
        severity: spendDelta < -50 || spendDelta > 100 ? "warning" : "info",
        accountId,
        accountLabel,
        metric: "spend",
        before: Math.round(prevSpend),
        after: Math.round(curSpend),
        deltaPct: spendDelta,
        title: `Dépenses ${spendDelta > 0 ? "+" : ""}${spendDelta}% sur 30j`,
        detail: `${Math.round(prevSpend)}€ → ${Math.round(curSpend)}€ vs période précédente`,
      });
    }

    const curRoas = accountRoas(currentAccount);
    const prevRoas = accountRoas(previousAccount);
    const roasDelta = pctChange(prevRoas, curRoas);

    if (roasDelta !== null && Math.abs(roasDelta) >= 15 && prevRoas > 0.5) {
      events.push({
        kind: roasDelta < 0 ? "metric_drop" : "metric_jump",
        severity: roasDelta < -25 ? "critical" : roasDelta < 0 ? "warning" : "positive",
        accountId,
        accountLabel,
        metric: "roas",
        before: prevRoas,
        after: curRoas,
        deltaPct: roasDelta,
        title: `ROAS ${roasDelta > 0 ? "+" : ""}${roasDelta}% (${prevRoas.toFixed(2)}x → ${curRoas.toFixed(2)}x)`,
        detail: roasDelta < 0
          ? `Le ROAS s'est dégradé sur les 30 derniers jours.`
          : `Le ROAS s'est amélioré sur les 30 derniers jours.`,
      });
    }

    const curFreq = accountFrequency(currentAccount);
    const prevFreq = accountFrequency(previousAccount);
    if (curFreq > 4 && curFreq > prevFreq * 1.2) {
      events.push({
        kind: "audience_fatigue",
        severity: curFreq > 6 ? "critical" : "warning",
        accountId,
        accountLabel,
        metric: "frequency",
        before: prevFreq,
        after: curFreq,
        deltaPct: pctChange(prevFreq, curFreq) ?? 0,
        title: `Fréquence en hausse (${prevFreq.toFixed(2)} → ${curFreq.toFixed(2)})`,
        detail: `Possible fatigue d'audience — la même personne voit la pub ${curFreq.toFixed(1)} fois en moyenne.`,
      });
    }
  }

  // ── Per-creative status changes ────────────────────────────────────────
  const currentByAd = new Map(currentInsights.map((i) => [i.ad_id, i]));
  const previousByAd = new Map(previousInsights.map((i) => [i.ad_id, i]));
  const adsById = new Map(currentAds.map((a) => [a.id, a]));

  // Killed: had significant spend before, no spend now
  for (const [adId, prevInsight] of previousByAd) {
    const prevSpend = adSpend(prevInsight);
    if (prevSpend < 50) continue; // ignore noise
    const current = currentByAd.get(adId);
    const curSpend = current ? adSpend(current) : 0;
    if (curSpend < prevSpend * 0.1) {
      const prevRoasVal = adRoas(prevInsight);
      const ad = adsById.get(adId);
      events.push({
        kind: "creative_killed",
        severity: prevRoasVal >= 2.5 ? "warning" : "info",
        accountId,
        accountLabel,
        title: `Créa "${ad?.name ?? prevInsight.ad_name ?? adId}" arrêtée`,
        detail: `Spend ${Math.round(prevSpend)}€ → ${Math.round(curSpend)}€ · ROAS période précédente ${prevRoasVal.toFixed(2)}x.${
          prevRoasVal >= 2.5 ? " C'était un winner — vérifier pourquoi elle a été coupée." : ""
        }`,
        evidence: { adId, prevSpend, prevRoas: prevRoasVal },
      });
    }
  }

  // New winners: significant spend now, was minimal before
  for (const [adId, current] of currentByAd) {
    const curSpend = adSpend(current);
    if (curSpend < 200) continue;
    const curRoasVal = adRoas(current);
    if (curRoasVal < 2.5) continue;
    const prevInsight = previousByAd.get(adId);
    const prevSpend = prevInsight ? adSpend(prevInsight) : 0;
    if (prevSpend < 50) {
      const ad = adsById.get(adId);
      events.push({
        kind: "creative_new_winner",
        severity: "positive",
        accountId,
        accountLabel,
        title: `Nouveau winner : "${ad?.name ?? current.ad_name ?? adId}"`,
        detail: `${Math.round(curSpend)}€ dépensés à ${curRoasVal.toFixed(2)}x — créa montante des 30 derniers jours.`,
        evidence: { adId, curSpend, curRoas: curRoasVal },
      });
    }
  }

  // Sort: critical → warning → positive → info; ties by absolute delta
  const sevRank: Record<ChangeSeverity, number> = {
    critical: 0,
    warning: 1,
    positive: 2,
    info: 3,
  };
  events.sort((a, b) => {
    const r = sevRank[a.severity] - sevRank[b.severity];
    if (r !== 0) return r;
    return Math.abs(b.deltaPct ?? 0) - Math.abs(a.deltaPct ?? 0);
  });

  return events;
}
