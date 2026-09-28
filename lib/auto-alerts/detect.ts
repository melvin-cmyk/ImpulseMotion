/**
 * Automatic alerting — pure detectors (no I/O, no AI).
 *
 * Nothing here is configured by a consultant: every client gets the same
 * checks, computed from a handful of daily rows. The AI never decides whether
 * something is wrong; it only words a hypothesis once a detector has fired
 * (lib/auto-alerts/message.ts), so a quiet account costs zero tokens.
 *
 * A finding carries a stable `key`: the same problem seen at the next run maps
 * onto the same incident (lib/auto-alerts/incidents.ts) and is not re-sent.
 */

export type Severity = "critical" | "warning";
export type AutoPlatform = "meta" | "google";

/** Group of checks fed by one fetch; an incident is only resolved when its scope was evaluated. */
export type Scope = "meta:account" | "meta:days" | "meta:ads" | "meta:pacing" | "google:days";

export type FindingKind =
  | "access_lost"
  | "account_blocked"
  | "spend_cap"
  | "spend_stopped"
  | "spend_spike"
  | "conversions_zero"
  | "perf_drift"
  | "ad_blocked"
  | "ad_stopped"
  | "pacing";

export interface Finding {
  /** The run adds the account to both (`…@<accountId>`): a client may have several. */
  key: string;
  scope: Scope | `${Scope}@${string}`;
  platform: AutoPlatform;
  kind: FindingKind;
  severity: Severity;
  /** Short label, e.g. « Dépense à l'arrêt ». */
  title: string;
  /** One sentence with the figures that justify the alert. */
  detail: string;
  entity?: { level: string; id: string; name: string };
  /** true when the cause is not known from the data: worth one AI hypothesis. */
  needsAi?: boolean;
}

export interface DayPoint {
  /** YYYY-MM-DD in the account timezone. */
  date: string;
  spend: number;
  conversions: number;
  /** null when no conversion value is tracked. */
  revenue: number | null;
}

export const THRESHOLDS = {
  /** Under this average daily spend an account (or ad) is too small to alert on. */
  minDailySpend: 10,
  /** Yesterday counts as "stopped" under this share of the baseline. */
  stopRatio: 0.1,
  /** Local hour after which a day still at zero is suspicious. */
  todayZeroHour: 13,
  spikeRatio: 2.5,
  spikeMinDelta: 50,
  /** Baseline conversions per day needed before "zero conversion" means anything. */
  minDailyConversions: 2,
  driftCpaPct: 60,
  driftRoasPct: 40,
  driftMinPrevConversions: 10,
  driftMinSpend: 150,
  adMinDailySpend: 5,
  adMinShare: 0.05,
  adCriticalShare: 0.25,
  maxAdFindings: 5,
  spendCapWarn: 0.9,
  spendCapCritical: 0.98,
  pacingMinFullDays: 5,
} as const;

const round = (n: number) => Math.round(n);
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const mean = (xs: number[]) => (xs.length ? sum(xs) / xs.length : 0);
const money = (n: number, currency: string) => `${round(n).toLocaleString("fr-FR")} ${currency}`.trim();

/**
 * Fills the missing days with zeros: an insights API returns no row for a day
 * without delivery, and that absence is precisely what we are looking for.
 */
export function fillDays(rows: DayPoint[], since: string, until: string): DayPoint[] {
  const by = new Map(rows.map((r) => [r.date, r]));
  const out: DayPoint[] = [];
  for (let t = Date.parse(`${since}T00:00:00Z`); t <= Date.parse(`${until}T00:00:00Z`); t += 86_400_000) {
    const date = new Date(t).toISOString().slice(0, 10);
    out.push(by.get(date) ?? { date, spend: 0, conversions: 0, revenue: null });
  }
  return out;
}

export interface DaysInput {
  platform: AutoPlatform;
  /** Full days, oldest first, ending yesterday (≥ 8 for the stop checks, ≥ 10 for drift). */
  full: DayPoint[];
  /** Today's partial day; null when unknown. */
  today: { spend: number; hour: number } | null;
  currency: string;
}

const scopeOf = (p: AutoPlatform): Scope => (p === "google" ? "google:days" : "meta:days");
const label = (p: AutoPlatform) => (p === "google" ? "Google Ads" : "Meta Ads");

/** Account-level checks on the daily series. */
export function detectFromDays(input: DaysInput): Finding[] {
  const { platform, full, today, currency } = input;
  const out: Finding[] = [];
  if (full.length < 8) return out;
  const T = THRESHOLDS;
  const yesterday = full[full.length - 1];
  const base = full.slice(-8, -1);
  const avg = mean(base.map((d) => d.spend));
  const scope = scopeOf(platform);

  // ── Delivery stopped ──────────────────────────────────────────────────────
  let stopped = false;
  if (avg >= T.minDailySpend && yesterday.spend <= avg * T.stopRatio) {
    stopped = true;
    const since = [...full].reverse().findIndex((d) => d.spend > avg * T.stopRatio);
    const days = since === -1 ? full.length : since;
    out.push({
      key: `${platform}:spend_stopped`, scope, platform, kind: "spend_stopped", severity: "critical", needsAi: true,
      title: `${label(platform)} · Dépense à l'arrêt`,
      detail: `${money(yesterday.spend, currency)} dépensés hier contre ${money(avg, currency)}/jour en moyenne sur les 7 jours précédents${days > 1 ? ` (${days} jours de suite)` : ""}.`,
    });
  } else if (today && today.hour >= T.todayZeroHour && today.spend === 0 && yesterday.spend >= T.minDailySpend) {
    stopped = true;
    out.push({
      key: `${platform}:spend_stopped`, scope, platform, kind: "spend_stopped", severity: "critical", needsAi: true,
      title: `${label(platform)} · Dépense à l'arrêt`,
      detail: `Aucune dépense aujourd'hui à ${Math.floor(today.hour)} h, alors que le compte a dépensé ${money(yesterday.spend, currency)} hier.`,
    });
  }
  if (stopped) return out; // everything below is a consequence of the stop

  // ── Spend spike ───────────────────────────────────────────────────────────
  if (avg >= T.minDailySpend && yesterday.spend >= avg * T.spikeRatio && yesterday.spend - avg >= T.spikeMinDelta) {
    out.push({
      key: `${platform}:spend_spike`, scope, platform, kind: "spend_spike", severity: "warning", needsAi: true,
      title: `${label(platform)} · Dépense anormalement haute`,
      detail: `${money(yesterday.spend, currency)} dépensés hier, soit ${(yesterday.spend / avg).toFixed(1).replace(".", ",")} fois la moyenne des 7 jours précédents (${money(avg, currency)}/jour).`,
    });
  }

  // ── Conversions at zero while still spending (tracking, site, checkout) ───
  const last2 = full.slice(-2);
  const base7 = full.slice(-9, -2);
  const convAvg = mean(base7.map((d) => d.conversions));
  const spendAvg7 = mean(base7.map((d) => d.spend));
  if (
    base7.length === 7 && convAvg >= T.minDailyConversions && spendAvg7 >= T.minDailySpend &&
    last2.every((d) => d.conversions === 0 && d.spend >= spendAvg7 * 0.5)
  ) {
    out.push({
      key: `${platform}:conversions_zero`, scope, platform, kind: "conversions_zero", severity: "critical", needsAi: true,
      title: `${label(platform)} · Plus aucune conversion`,
      detail: `0 conversion sur les 2 derniers jours pour ${money(sum(last2.map((d) => d.spend)), currency)} dépensés, contre ${convAvg.toFixed(1).replace(".", ",")} conversions/jour auparavant.`,
    });
    return out; // a drift alert on top would say the same thing
  }

  // ── Performance drift: last 3 full days vs the 7 before ───────────────────
  if (full.length >= 10) {
    const recent = full.slice(-3);
    const prev = full.slice(-10, -3);
    const rSpend = sum(recent.map((d) => d.spend));
    const pSpend = sum(prev.map((d) => d.spend));
    const rConv = sum(recent.map((d) => d.conversions));
    const pConv = sum(prev.map((d) => d.conversions));
    if (rSpend >= T.driftMinSpend && pConv >= T.driftMinPrevConversions && pSpend > 0) {
      const pCpa = pSpend / pConv;
      // No conversion at all in 3 days is handled above; here CPA needs a denominator.
      const rCpa = rConv > 0 ? rSpend / rConv : null;
      const hasRevenue = recent.every((d) => d.revenue !== null) && prev.every((d) => d.revenue !== null);
      const pRoas = hasRevenue ? sum(prev.map((d) => d.revenue ?? 0)) / pSpend : null;
      const rRoas = hasRevenue ? sum(recent.map((d) => d.revenue ?? 0)) / rSpend : null;
      const cpaPct = rCpa !== null ? ((rCpa - pCpa) / pCpa) * 100 : null;
      const roasPct = pRoas && rRoas !== null ? ((rRoas - pRoas) / pRoas) * 100 : null;
      const parts: string[] = [];
      if (roasPct !== null && roasPct <= -T.driftRoasPct) parts.push(`ROAS ${pRoas!.toFixed(2).replace(".", ",")} → ${rRoas!.toFixed(2).replace(".", ",")} (${round(roasPct)} %)`);
      if (cpaPct !== null && cpaPct >= T.driftCpaPct) parts.push(`CPA ${money(pCpa, currency)} → ${money(rCpa!, currency)} (+${round(cpaPct)} %)`);
      if (parts.length) {
        out.push({
          key: `${platform}:perf_drift`, scope, platform, kind: "perf_drift", severity: "warning", needsAi: true,
          title: `${label(platform)} · Performance en baisse`,
          detail: `${parts.join(" ; ")} sur les 3 derniers jours par rapport aux 7 précédents, pour ${money(rSpend, currency)} dépensés.`,
        });
      }
    }
  }
  return out;
}

// ── Meta account status ──────────────────────────────────────────────────────

/** https://developers.facebook.com/docs/marketing-api/reference/ad-account — account_status */
const ACCOUNT_STATUS: Record<number, { label: string; severity: Severity; hint: string } | null> = {
  1: null,
  2: { label: "désactivé", severity: "critical", hint: "Le compte ne diffuse plus." },
  3: { label: "impayé", severity: "critical", hint: "Un paiement a échoué : les campagnes sont suspendues jusqu'au règlement." },
  7: { label: "en examen (risque)", severity: "critical", hint: "Meta examine le compte, la diffusion est suspendue." },
  8: { label: "règlement en attente", severity: "warning", hint: "Un prélèvement est en cours de traitement." },
  9: { label: "en période de grâce", severity: "critical", hint: "Paiement en retard : la diffusion va s'arrêter sans règlement." },
  100: { label: "fermeture en cours", severity: "critical", hint: "Le compte est en cours de fermeture." },
  101: { label: "fermé", severity: "critical", hint: "Le compte est fermé." },
};

export interface AccountHealth {
  accountStatus: number | null;
  disableReason: number | null;
  /** Minor units as returned by Meta; "0" or absent = no cap. */
  spendCap: number | null;
  amountSpent: number | null;
}

export function detectFromAccount(h: AccountHealth, currency: string): Finding[] {
  const out: Finding[] = [];
  if (h.accountStatus !== null) {
    const s = h.accountStatus in ACCOUNT_STATUS ? ACCOUNT_STATUS[h.accountStatus] : { label: `statut ${h.accountStatus}`, severity: "warning" as Severity, hint: "Statut inhabituel du compte publicitaire." };
    if (s) {
      out.push({
        key: "meta:account_blocked", scope: "meta:account", platform: "meta", kind: "account_blocked", severity: s.severity,
        title: "Meta Ads · Compte bloqué",
        detail: `Compte publicitaire ${s.label}. ${s.hint} À vérifier dans Facturation et paiements.`,
      });
    }
  }
  if (h.spendCap && h.spendCap > 0 && h.amountSpent !== null) {
    const ratio = h.amountSpent / h.spendCap;
    if (ratio >= THRESHOLDS.spendCapWarn) {
      const left = Math.max(0, h.spendCap - h.amountSpent) / 100;
      out.push({
        key: "meta:spend_cap", scope: "meta:account", platform: "meta", kind: "spend_cap",
        severity: ratio >= THRESHOLDS.spendCapCritical ? "critical" : "warning",
        title: "Meta Ads · Plafond de dépense du compte",
        detail: `${round(ratio * 100)} % du plafond de dépense du compte est consommé (reste environ ${money(left, currency)}) : la diffusion s'arrête une fois le plafond atteint.`,
      });
    }
  }
  return out;
}

/** The agency's token no longer reads this account (partner access removed, account moved). */
export function accessLost(): Finding {
  return {
    key: "meta:access_lost", scope: "meta:account", platform: "meta", kind: "access_lost", severity: "warning",
    title: "Meta Ads · Accès au compte perdu",
    detail: `ImpulseMotion ne peut plus lire ce compte publicitaire : plus aucune surveillance tant que l'accès partenaire n'est pas rétabli.`,
  };
}

// ── Ads that stopped spending ────────────────────────────────────────────────

export interface AdSpend { adId: string; spend: number }

export interface AdCandidate { adId: string; avg: number; share: number }

/** Ads big enough to matter: their share of the 7 days before yesterday. */
export function heavyAds(baseTotals: AdSpend[], full: DayPoint[]): AdCandidate[] {
  if (full.length < 8) return [];
  const accountAvg = mean(full.slice(-8, -1).map((d) => d.spend));
  if (accountAvg < THRESHOLDS.minDailySpend) return [];
  const min = Math.max(THRESHOLDS.adMinDailySpend, accountAvg * THRESHOLDS.adMinShare);
  return baseTotals
    .map((a) => ({ adId: a.adId, avg: a.spend / 7, share: a.spend / 7 / accountAvg }))
    .filter((c) => c.avg >= min)
    .sort((a, b) => b.avg - a.avg)
    .slice(0, 20);
}

/**
 * Among the heavy ads, those that spent nothing yesterday. Status is not known
 * here — see classifyStoppedAds.
 */
export function findStoppedAds(heavy: AdCandidate[], spentYesterday: ReadonlySet<string>): AdCandidate[] {
  return heavy.filter((c) => !spentYesterday.has(c.adId));
}

export interface AdStatus {
  id: string;
  name: string;
  effectiveStatus: string;
  adsetName?: string | null;
  campaignName?: string | null;
  /** ISO date; an ad set whose schedule ended stops on purpose. */
  adsetEndTime?: string | null;
  campaignStopTime?: string | null;
  /** Meta's own explanation (issues_info / ad_review_feedback), already flattened. */
  issue?: string | null;
}

const INTENTIONAL = new Set(["PAUSED", "CAMPAIGN_PAUSED", "ADSET_PAUSED", "ARCHIVED", "DELETED"]);
const BLOCKED: Record<string, string> = {
  DISAPPROVED: "refusée par Meta",
  WITH_ISSUES: "en erreur",
  PENDING_BILLING_INFO: "bloquée : informations de paiement manquantes",
  PENDING_REVIEW: "en cours d'examen",
  IN_PROCESS: "en cours de traitement",
};

const ended = (iso: string | null | undefined, now: Date) => !!iso && Date.parse(iso) > 0 && Date.parse(iso) <= now.getTime();

/** Keeps only the stops nobody decided: paused or ended ads are left alone. */
export function classifyStoppedAds(cands: AdCandidate[], statuses: AdStatus[], currency: string, now: Date = new Date()): Finding[] {
  const by = new Map(statuses.map((s) => [s.id, s]));
  const out: Finding[] = [];
  for (const c of cands) {
    const s = by.get(c.adId);
    if (!s) continue;
    if (INTENTIONAL.has(s.effectiveStatus)) continue;
    if (ended(s.adsetEndTime, now) || ended(s.campaignStopTime, now)) continue;
    const where = s.campaignName ? ` (campagne « ${s.campaignName} »)` : "";
    const before = `elle dépensait ${money(c.avg, currency)}/jour, soit ${round(c.share * 100)} % du compte`;
    const entity = { level: "ad", id: s.id, name: s.name };
    if (s.effectiveStatus in BLOCKED) {
      out.push({
        key: `meta:ad_blocked:${s.id}`, scope: "meta:ads", platform: "meta", kind: "ad_blocked", severity: "critical", entity,
        title: "Meta Ads · Créa bloquée",
        detail: `« ${s.name} »${where} est ${BLOCKED[s.effectiveStatus]} et ne diffuse plus ; ${before}.${s.issue ? ` Motif : ${s.issue}` : ""}`,
      });
    } else {
      out.push({
        key: `meta:ad_stopped:${s.id}`, scope: "meta:ads", platform: "meta", kind: "ad_stopped", entity, needsAi: true,
        severity: c.share >= THRESHOLDS.adCriticalShare ? "critical" : "warning",
        title: "Meta Ads · Créa à l'arrêt sans raison apparente",
        detail: `« ${s.name} »${where} est toujours active mais n'a rien dépensé hier ; ${before}.`,
      });
    }
    if (out.length >= THRESHOLDS.maxAdFindings) break;
  }
  return out;
}

/** Ads rejected or in error in the last days, whether or not they ever spent. */
export function detectBlockedAds(statuses: AdStatus[], alreadyKeyed: Set<string>): Finding[] {
  const out: Finding[] = [];
  for (const s of statuses) {
    const key = `meta:ad_blocked:${s.id}`;
    if (alreadyKeyed.has(key)) continue;
    if (s.effectiveStatus !== "DISAPPROVED" && s.effectiveStatus !== "WITH_ISSUES") continue;
    out.push({
      key, scope: "meta:ads", platform: "meta", kind: "ad_blocked", severity: "warning",
      entity: { level: "ad", id: s.id, name: s.name },
      title: "Meta Ads · Créa bloquée",
      detail: `« ${s.name} »${s.campaignName ? ` (campagne « ${s.campaignName} »)` : ""} est ${BLOCKED[s.effectiveStatus]}.${s.issue ? ` Motif : ${s.issue}` : ""}`,
    });
    if (out.length >= THRESHOLDS.maxAdFindings) break;
  }
  return out;
}

// ── Budget pacing ────────────────────────────────────────────────────────────

export interface PacingInput {
  status: string;
  pacingPct: number;
  projectedSpend: number;
  monthlyTarget: number;
  currency: string;
  fullDays: number;
  daysInMonth: number;
  /** YYYY-MM, part of the key so the alert can fire again next month. */
  month: string;
}

export function detectFromPacing(p: PacingInput): Finding[] {
  if (p.fullDays < THRESHOLDS.pacingMinFullDays) return [];
  if (p.status !== "critical_under" && p.status !== "critical_over") return [];
  const over = p.status === "critical_over";
  return [{
    key: `meta:pacing:${p.month}:${over ? "over" : "under"}`, scope: "meta:pacing", platform: "meta", kind: "pacing", severity: "warning",
    title: over ? "Budget · Sur-consommation" : "Budget · Sous-consommation",
    detail: `Au rythme actuel le mois finira à ${money(p.projectedSpend, p.currency)} pour un budget de ${money(p.monthlyTarget, p.currency)} (${p.pacingPct} %), à J${p.fullDays}/${p.daysInMonth}.`,
  }];
}

/**
 * Drops what is only a symptom: a blocked account explains the stop of
 * everything below it, a stopped account explains its stopped ads.
 */
export function pruneFindings(findings: Finding[]): Finding[] {
  const blocked = findings.some((f) => f.kind === "account_blocked" && f.severity === "critical");
  const capped = findings.some((f) => f.kind === "spend_cap" && f.severity === "critical");
  const metaStopped = findings.some((f) => f.kind === "spend_stopped" && f.platform === "meta");
  return findings
    .filter((f) => {
      if (f.platform !== "meta") return true;
      if ((blocked || capped) && (f.kind === "spend_stopped" || f.kind === "ad_stopped" || f.kind === "pacing" || f.kind === "perf_drift" || f.kind === "conversions_zero")) return false;
      if (metaStopped && (f.kind === "ad_stopped" || f.kind === "pacing")) return false;
      return true;
    })
    .sort((a, b) => Number(b.severity === "critical") - Number(a.severity === "critical"));
}
