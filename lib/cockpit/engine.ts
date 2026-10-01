/**
 * Global Cockpit — calculation engine (pure, no I/O).
 *
 * One row per CLIENT, made of one or more ad accounts ("platforms"). Each
 * account brings 9 weekly points (W-8 … W0, W0 = last full week Monday →
 * Sunday). From them:
 *   - the week is compared to the average of the 8 previous weeks
 *     ("baseline", structural) and to the previous week (WoW);
 *   - the KPI is CPA (spend / conversions) or ROAS (value / spend) depending
 *     on the client's model; "brand" has no performance KPI, "mixte" has
 *     accounts with different models (KPI read per account only);
 *   - `diag` splits a KPI drift into funnel components (CPM, CTR, CVR, AOV);
 *   - the budget pace compares the share of the monthly budget already spent
 *     with the share of the month elapsed;
 *   - one alert per client: the most severe finding, with an explicit reason.
 *
 * Thresholds live in COCKPIT_CFG — the same ones the interface uses to colour
 * the deltas, so a level and its chips never disagree.
 *
 * The same reading exists by day and by month (PeriodKind): the « weeks » of
 * this file are then days or months, and the thresholds that are amounts or
 * volumes follow the length of the period (PERIOD_LIMITS).
 */

export type KpiMode = "cpa" | "roas" | "brand" | "mixte";
export type AccountMode = "cpa" | "roas" | "brand";
/** Ad platforms the cockpit reads. */
export type CockpitPlatform = "meta" | "google" | "tiktok";
export const COCKPIT_PLATFORMS: readonly CockpitPlatform[] = ["meta", "google", "tiktok"];
/** Short name of a platform (account labels, alerts) and the one shown in lists. */
export const PLATFORM_SHORT: Record<CockpitPlatform, string> = { meta: "Meta", google: "Google", tiktok: "TikTok" };
export const PLATFORM_NAME: Record<CockpitPlatform, string> = { meta: "Meta", google: "Google Ads", tiktok: "TikTok Ads" };
/** A stored platform string read as a cockpit platform; anything else → null (never read as Meta). */
export const asPlatform = (v: string | null | undefined): CockpitPlatform | null =>
  v === "meta" || v === "google" || v === "tiktok" ? v : null;
export type Severity = "urgent" | "action" | "watch" | "ok";
export type AlertCategory = "data" | "measurement" | "performance" | "budget" | "delivery" | "limited";

export const COCKPIT_CFG = {
  /** Below this weekly spend (EUR) a client never goes above « À surveiller ». */
  microEur: 500,
  urgent: { bigWorse: 0.30, bigEur: 10_000 },
  action: { worse: 0.20, spendAbs: 0.30 },
  watch: { worse: 0.10, spendAbs: 0.15 },
  paceWarnPts: 5,
  paceBadPts: 12,
  /** A KPI computed on fewer conversions than this is not read as a trend. */
  lowVolConv: 10,
  /** An account weighs in the client's performance reading from this share of spend. */
  minShare: 0.20,
  histWeeks: 8,
} as const;

/** Length of the period read: yesterday, the last full week, the month to date. */
export type PeriodKind = "day" | "week" | "month";

export interface PeriodLimits {
  /** Points of a series, the period read included. */
  points: number;
  /** Below this spend (EUR) over the period a client never goes above « À surveiller ». */
  microEur: number;
  /** From this spend (EUR) over the period a big drift is an urgency. */
  bigEur: number;
  /** A KPI computed on fewer conversions than this is not read as a trend. */
  lowVolConv: number;
}

/** Amounts and volumes of the week, scaled to a day (÷ 7) and to a month (× 4). */
export const PERIOD_LIMITS: Record<PeriodKind, PeriodLimits> = {
  day: { points: 9, microEur: 70, bigEur: 1_500, lowVolConv: 3 },
  week: { points: COCKPIT_CFG.histWeeks + 1, microEur: COCKPIT_CFG.microEur, bigEur: COCKPIT_CFG.urgent.bigEur, lowVolConv: COCKPIT_CFG.lowVolConv },
  month: { points: 4, microEur: 2_000, bigEur: 40_000, lowVolConv: 30 },
};

export interface WeekPoint {
  spend: number;
  conv: number;
  value: number;
  impressions: number;
  clicks: number;
}

export const EMPTY_WEEK: WeekPoint = { spend: 0, conv: 0, value: 0, impressions: 0, clicks: 0 };

export interface Pacing {
  budget: number;
  mtd: number;
  /** mtd / budget */
  pct_spent: number;
  /** share of the month elapsed (full days) */
  pct_month: number;
  /** daily spend needed to land on the budget, 0 when already over */
  daily_needed: number;
}

export interface Diag { cpm?: number; ctr?: number; cvr?: number; aov?: number }

export interface SeriesMetrics {
  spend: number;
  conv: number;
  value: number;
  kpi: number | null;
  /** weeks of the baseline that actually spent */
  n_base: number;
  spend_base: number | null;
  kpi_base: number | null;
  spend_d: number | null;
  kpi_d: number | null;
  zero_conv: boolean;
  low_vol: boolean;
  diag: Diag | null;
  spend_prev: number | null;
  spend_d_wow: number | null;
  kpi_prev: number | null;
  kpi_d_wow: number | null;
  /** weeks (out of 9) that spent without a single conversion */
  zero_weeks: number;
  weeks: number[];
  weeks_kpi: Array<number | null>;
}

export interface PlatformInput {
  /** stable key inside the client ("meta", "google", "tiktok", "meta-<account>") */
  key: string;
  plat: CockpitPlatform;
  label: string;
  accountId: string;
  ccy: string | null;
  mode: AccountMode;
  weeks: WeekPoint[];
  mtd: number | null;
  budget: number | null;
  /** fetch failure (French, displayable); the account then has no numbers */
  err: string | null;
}

export interface PlatformRow extends SeriesMetrics {
  key: string;
  plat: CockpitPlatform;
  label: string;
  accountId: string;
  ccy: string | null;
  mode: AccountMode;
  budget: number | null;
  pacing: Pacing | null;
  err: string | null;
  data_issue: string | null;
}

export interface CockpitAlert {
  severity: Severity;
  category: AlertCategory;
  reason: string;
  next_action: string;
}

export interface ClientInput {
  key: string;
  name: string;
  kpi_mode: KpiMode;
  team: string | null;
  /** targets from the budget sheet, in the client's currency */
  target_roas: number | null;
  target_cpl: number | null;
  /**
   * Monthly budget of the sheet per platform (client currency). An account
   * alone on its platform also carries it (`PlatformInput.budget`); with
   * several accounts the sheet does not say how it splits, so the pace is
   * read at the client level only.
   */
  budgets: { meta: number | null; google: number | null; tiktok?: number | null };
  platforms: PlatformInput[];
}

export interface ClientRow {
  key: string;
  name: string;
  kpi_mode: KpiMode;
  team: string | null;
  target_roas: number | null;
  target_cpl: number | null;
  /** currency of the client's figures; null when unknown */
  ccy: string | null;
  /** accounts in several currencies: blended figures are converted to `ccy` */
  mixed: boolean;
  eur_w0: number;
  eur_base: number;
  score: number;
  pacing: Pacing | null;
  blended: SeriesMetrics;
  platforms: Record<string, PlatformRow>;
  alert: CockpitAlert;
}

const ratio = (a: number, b: number): number | null => (b > 0 ? a / b : null);
const delta = (now: number | null, base: number | null): number | null =>
  now === null || base === null || base === 0 ? null : now / base - 1;
const sum = (xs: WeekPoint[], k: keyof WeekPoint): number => xs.reduce((s, x) => s + (x[k] || 0), 0);

export function kpiOf(w: Pick<WeekPoint, "spend" | "conv" | "value">, mode: AccountMode | KpiMode): number | null {
  if (mode === "roas") return w.spend > 0 && w.value > 0 ? w.value / w.spend : w.spend > 0 ? 0 : null;
  if (mode === "cpa") return w.conv > 0 ? w.spend / w.conv : null;
  return null;
}

/** A KPI moving the wrong way, as a positive number (CPA up, ROAS down). */
export function worsening(kpiDelta: number | null, mode: AccountMode | KpiMode): number {
  if (kpiDelta === null) return 0;
  if (mode === "cpa") return kpiDelta;
  if (mode === "roas") return -kpiDelta;
  return 0;
}

/** Metrics of one series of 9 weekly points (an account, or a client's blend). */
export function seriesMetrics(weeksIn: WeekPoint[], mode: AccountMode | KpiMode, limits: PeriodLimits = PERIOD_LIMITS.week): SeriesMetrics {
  const n = limits.points;
  const weeks = [...Array(Math.max(0, n - weeksIn.length)).fill(EMPTY_WEEK), ...weeksIn.slice(-n)] as WeekPoint[];
  const w0 = weeks[n - 1];
  const prev = weeks[n - 2];
  const base = weeks.slice(0, n - 1).filter((w) => w.spend > 0);
  const baseAgg: WeekPoint = {
    spend: sum(base, "spend"), conv: sum(base, "conv"), value: sum(base, "value"),
    impressions: sum(base, "impressions"), clicks: sum(base, "clicks"),
  };

  const kpi = kpiOf(w0, mode);
  const kpiBase = base.length ? kpiOf(baseAgg, mode) : null;
  const spendBase = base.length ? baseAgg.spend / base.length : null;
  const measurable = mode === "cpa" || mode === "roas";
  const zeroConv = measurable && w0.spend > 0 && w0.conv === 0;
  const lowVol = measurable && !zeroConv && w0.conv < limits.lowVolConv;

  let diag: Diag | null = null;
  if (measurable && base.length && w0.spend > 0) {
    const d: Diag = {};
    const cpm = delta(ratio(w0.spend * 1000, w0.impressions), ratio(baseAgg.spend * 1000, baseAgg.impressions));
    const ctr = delta(ratio(w0.clicks, w0.impressions), ratio(baseAgg.clicks, baseAgg.impressions));
    const cvr = delta(ratio(w0.conv, w0.clicks), ratio(baseAgg.conv, baseAgg.clicks));
    if (cpm !== null) d.cpm = round(cpm, 4);
    if (ctr !== null) d.ctr = round(ctr, 4);
    if (cvr !== null) d.cvr = round(cvr, 4);
    if (mode === "roas") {
      const aov = delta(ratio(w0.value, w0.conv), ratio(baseAgg.value, baseAgg.conv));
      if (aov !== null) d.aov = round(aov, 4);
    }
    diag = Object.keys(d).length ? d : null;
  }

  const kpiPrev = prev.spend > 0 ? kpiOf(prev, mode) : null;
  return {
    spend: w0.spend,
    conv: w0.conv,
    value: w0.value,
    kpi,
    n_base: base.length,
    spend_base: spendBase,
    kpi_base: kpiBase,
    spend_d: delta(w0.spend, spendBase),
    // A KPI on zero conversions is not a number: the alert says « aucune conversion ».
    kpi_d: zeroConv ? null : delta(kpi, kpiBase),
    zero_conv: zeroConv,
    low_vol: lowVol,
    diag,
    spend_prev: prev.spend > 0 ? prev.spend : null,
    spend_d_wow: prev.spend > 0 ? delta(w0.spend, prev.spend) : null,
    kpi_prev: kpiPrev,
    kpi_d_wow: zeroConv ? null : delta(kpi, kpiPrev),
    zero_weeks: measurable ? weeks.filter((w) => w.spend > 0 && w.conv === 0).length : 0,
    weeks: weeks.map((w) => round(w.spend, 2)),
    weeks_kpi: weeks.map((w) => (w.spend > 0 ? kpiOf(w, mode) : null)),
  };
}

export function pacingOf(budget: number | null, mtd: number | null, month: { elapsed: number; days: number }): Pacing | null {
  if (!budget || budget <= 0 || mtd === null) return null;
  const remaining = Math.max(0, month.days - month.elapsed);
  return {
    budget,
    mtd: Math.round(mtd),
    pct_spent: round(mtd / budget, 4),
    pct_month: round(month.elapsed / month.days, 4),
    daily_needed: remaining > 0 ? Math.max(0, Math.round((budget - mtd) / remaining)) : 0,
  };
}

export const pacePoints = (p: Pacing | null): number | null => (p ? (p.pct_spent - p.pct_month) * 100 : null);

function round(v: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

const RANK: Record<Severity, number> = { urgent: 0, action: 1, watch: 2, ok: 3 };
const CATEGORY_ORDER: AlertCategory[] = ["data", "measurement", "performance", "budget", "delivery", "limited"];

const NEXT_ACTION: Record<AlertCategory, string> = {
  data: "Vérifier l'accès au compte et la remontée des données.",
  measurement: "Vérifier événements, objectifs et diffusion dans le compte.",
  performance: "Examiner les campagnes et le mix de diffusion.",
  budget: "Vérifier le budget et le calendrier de diffusion.",
  delivery: "Comparer la variation au plan de diffusion prévu.",
  limited: "Accumuler des données avant de conclure sur le KPI.",
};

const pctTxt = (d: number): string => `${Math.round(Math.abs(d) * 100)}%`;
const signedPct = (d: number): string => `${d > 0 ? "+" : "-"}${Math.round(Math.abs(d) * 100)}%`;

export interface AlertContext {
  kpi_mode: KpiMode;
  eur_w0: number;
  blended: SeriesMetrics;
  platforms: PlatformRow[];
  pacing: Pacing | null;
  /** EUR value of one unit of each platform's currency */
  eurOf: (amount: number, ccy: string | null) => number;
  /** thresholds of the period read; the week's when absent */
  limits?: PeriodLimits;
}

/** Every finding of a client, then the single most severe one. */
export function classify(ctx: AlertContext): CockpitAlert {
  const found: Array<{ severity: Severity; category: AlertCategory; reason: string; weight: number }> = [];
  const limits = ctx.limits ?? PERIOD_LIMITS.week;
  const total = ctx.platforms.reduce((s, p) => s + ctx.eurOf(p.spend, p.ccy), 0) || 1;
  const big = ctx.eur_w0 >= limits.bigEur;

  // Data: an account that could not be read hides everything else about it.
  const broken = ctx.platforms.filter((p) => p.err);
  if (broken.length) {
    found.push({
      severity: broken.length === ctx.platforms.length ? "action" : "watch",
      category: "data",
      reason: `Données indisponibles : ${broken.map((p) => p.label).join(", ")}`,
      weight: 1,
    });
  }

  // Measurement: money spent, not one conversion.
  const silent = ctx.platforms.filter((p) => !p.err && p.zero_conv);
  if (silent.length) {
    const eur = silent.reduce((s, p) => s + ctx.eurOf(p.spend, p.ccy), 0);
    const repeated = silent.some((p) => p.zero_weeks >= 2);
    found.push({
      severity: eur >= limits.bigEur ? "urgent" : repeated && eur >= limits.microEur ? "action" : "watch",
      category: "measurement",
      reason: `Aucune conversion malgré les dépenses : ${silent.map((p) => p.label).join(", ")}`,
      weight: eur,
    });
  }

  // Performance: the worst readable KPI drift — the blend, or an account that weighs.
  const candidates: Array<{ label: string; worse: number }> = [];
  if (ctx.kpi_mode === "cpa" || ctx.kpi_mode === "roas") {
    if (!ctx.blended.low_vol && !ctx.blended.zero_conv && ctx.platforms.length > 1) {
      candidates.push({ label: "Ensemble", worse: worsening(ctx.blended.kpi_d, ctx.kpi_mode) });
    }
  }
  for (const p of ctx.platforms) {
    if (p.err || p.low_vol || p.zero_conv || p.mode === "brand") continue;
    if (ctx.eurOf(p.spend, p.ccy) / total < COCKPIT_CFG.minShare) continue;
    candidates.push({ label: p.label, worse: worsening(p.kpi_d, p.mode) });
  }
  const worst = candidates.sort((a, b) => b.worse - a.worse)[0];
  if (worst && worst.worse >= COCKPIT_CFG.watch.worse) {
    found.push({
      severity: worst.worse >= COCKPIT_CFG.urgent.bigWorse && big ? "urgent"
        : worst.worse >= COCKPIT_CFG.action.worse ? "action" : "watch",
      category: "performance",
      reason: `${worst.label} : dégradation du KPI de ${pctTxt(worst.worse)}`,
      weight: worst.worse,
    });
  }

  // Budget: gap between the share spent and the share of the month elapsed.
  const pts = pacePoints(ctx.pacing);
  if (pts !== null && Math.abs(pts) >= COCKPIT_CFG.paceWarnPts) {
    found.push({
      severity: Math.abs(pts) >= COCKPIT_CFG.paceBadPts ? "action" : "watch",
      category: "budget",
      reason: `Écart au rythme linéaire : ${pts > 0 ? "+" : "-"}${Math.round(Math.abs(pts))} points`,
      weight: Math.abs(pts),
    });
  }

  // Delivery: the spend itself moved.
  const sd = ctx.blended.spend_d;
  if (sd !== null && Math.abs(sd) >= COCKPIT_CFG.watch.spendAbs) {
    found.push({
      severity: Math.abs(sd) >= COCKPIT_CFG.action.spendAbs ? "action" : "watch",
      category: "delivery",
      reason: `Dépenses ${signedPct(sd)} vs baseline`,
      weight: Math.abs(sd),
    });
  }

  // Limited: nothing can be concluded on the KPI yet.
  const measurable = ctx.kpi_mode !== "brand";
  if (measurable && (ctx.blended.n_base < 2 || (ctx.blended.low_vol && !candidates.length))) {
    found.push({ severity: "watch", category: "limited", reason: "Historique ou volume insuffisant", weight: 0 });
  }

  if (!found.length) return { severity: "ok", category: "delivery", reason: "Aucun seuil franchi", next_action: "" };

  // Small accounts never raise an urgency; a budget gap stays actionable whatever the size.
  const micro = ctx.eur_w0 < limits.microEur;
  for (const f of found) {
    if (micro && f.category !== "budget" && f.category !== "data" && RANK[f.severity] < RANK.watch) f.severity = "watch";
  }
  found.sort((a, b) =>
    RANK[a.severity] - RANK[b.severity] || CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category));
  const top = found[0];
  return { severity: top.severity, category: top.category, reason: top.reason, next_action: NEXT_ACTION[top.category] };
}

/**
 * Sorting score inside a level: how far spend and KPI moved, weighted by the
 * size of the account (log10 of the weekly spend in EUR).
 */
export function scoreOf(blended: SeriesMetrics, worse: number, eurW0: number, bonus: number): number {
  const s = 0.4 * Math.min(Math.abs(blended.spend_d ?? 0) / 0.30, 2) + 0.6 * Math.min(Math.max(worse, 0) / 0.20, 2) + bonus;
  return round(s * Math.log10(Math.max(eurW0, 1)), 3);
}

export interface BuildContext {
  /** EUR value of one unit of each currency (EUR: 1) */
  fx: Record<string, number>;
  month: { elapsed: number; days: number };
  /** thresholds of the period read; the week's when absent */
  limits?: PeriodLimits;
}

export function buildClient(input: ClientInput, ctx: BuildContext): ClientRow {
  const limits = ctx.limits ?? PERIOD_LIMITS.week;
  const rate = (ccy: string | null) => (ccy ? ctx.fx[ccy] ?? null : null);
  const eurOf = (amount: number, ccy: string | null) => amount * (rate(ccy) ?? 1);

  const platforms: PlatformRow[] = input.platforms.map((p) => ({
    ...seriesMetrics(p.err ? [] : p.weeks, p.mode, limits),
    key: p.key, plat: p.plat, label: p.label, accountId: p.accountId, ccy: p.ccy, mode: p.mode,
    budget: p.budget,
    pacing: p.err ? null : pacingOf(p.budget, p.mtd, ctx.month),
    err: p.err,
    data_issue: p.err,
  }));

  const live = input.platforms.filter((p) => !p.err);
  const currencies = [...new Set(live.map((p) => p.ccy).filter((c): c is string => !!c))];
  const mixed = currencies.length > 1;
  // The client's currency: the one that carries the most spend this week.
  const byCcy = new Map<string, number>();
  for (const p of platforms) if (p.ccy && !p.err) byCcy.set(p.ccy, (byCcy.get(p.ccy) ?? 0) + eurOf(p.spend, p.ccy));
  const ccy = [...byCcy.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? currencies[0] ?? null;
  const toClient = (amount: number, from: string | null) => {
    if (!mixed || !from || !ccy || from === ccy) return amount;
    const a = rate(from), b = rate(ccy);
    return a && b ? (amount * a) / b : amount;
  };

  const n = limits.points;
  const blendedWeeks: WeekPoint[] = Array.from({ length: n }, (_, i) => {
    const w: WeekPoint = { ...EMPTY_WEEK };
    for (const p of live) {
      const padded = [...Array(Math.max(0, n - p.weeks.length)).fill(EMPTY_WEEK), ...p.weeks.slice(-n)] as WeekPoint[];
      const x = padded[i];
      w.spend += toClient(x.spend, p.ccy);
      w.value += toClient(x.value, p.ccy);
      // Conversions of a brand account are not a performance signal.
      if (p.mode !== "brand") w.conv += x.conv;
      w.impressions += x.impressions;
      w.clicks += x.clicks;
    }
    return w;
  });
  const blended = seriesMetrics(blendedWeeks, input.kpi_mode, limits);

  // Budget of the platforms that have a readable account, against what those accounts spent.
  let budget = 0, mtd = 0, budgeted = false;
  for (const plat of COCKPIT_PLATFORMS) {
    const b = input.budgets[plat] ?? null;
    const accounts = live.filter((p) => p.plat === plat && p.mtd !== null);
    if (b === null || b <= 0 || !accounts.length) continue;
    budgeted = true;
    budget += b;
    mtd += accounts.reduce((s, p) => s + toClient(p.mtd ?? 0, p.ccy), 0);
  }
  const pacing = budgeted ? pacingOf(budget, mtd, ctx.month) : null;

  const eurW0 = Math.round(platforms.reduce((s, p) => s + eurOf(p.spend, p.ccy), 0));
  const eurBase = Math.round(platforms.reduce((s, p) => s + eurOf(p.spend_base ?? 0, p.ccy), 0));
  const alert = classify({ kpi_mode: input.kpi_mode, eur_w0: eurW0, blended, platforms, pacing, eurOf, limits });

  const total = platforms.reduce((s, p) => s + eurOf(p.spend, p.ccy), 0) || 1;
  let worse = input.kpi_mode === "cpa" || input.kpi_mode === "roas" ? (blended.low_vol ? 0 : worsening(blended.kpi_d, input.kpi_mode)) : 0;
  for (const p of platforms) {
    if (p.err || p.low_vol || eurOf(p.spend, p.ccy) / total < COCKPIT_CFG.minShare) continue;
    worse = Math.max(worse, worsening(p.kpi_d, p.mode));
  }
  const bonus = platforms.some((p) => p.zero_conv) ? 0.5 : 0;

  return {
    key: input.key,
    name: input.name,
    kpi_mode: input.kpi_mode,
    team: input.team,
    target_roas: input.target_roas,
    target_cpl: input.target_cpl,
    ccy,
    mixed,
    eur_w0: eurW0,
    eur_base: eurBase,
    score: scoreOf(blended, worse, eurW0, bonus),
    pacing,
    blended,
    platforms: Object.fromEntries(platforms.map((p) => [p.key, p])),
    alert,
  };
}

/** Urgent first, then by score, then by size. */
export function sortClients<T extends Pick<ClientRow, "alert" | "score" | "eur_w0">>(clients: T[]): T[] {
  return [...clients].sort((a, b) =>
    RANK[a.alert.severity] - RANK[b.alert.severity] || b.score - a.score || b.eur_w0 - a.eur_w0);
}
