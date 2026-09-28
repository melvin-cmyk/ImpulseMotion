/**
 * Global Cockpit — reading helpers shared by the page (pure): labels, the
 * funnel component that explains a drift, amounts and deltas.
 */

import { COCKPIT_CFG, worsening, type AccountMode, type ClientRow, type KpiMode, type Pacing, type PlatformRow, type SeriesMetrics, type Severity } from "@/lib/cockpit/engine";

export const SEVERITY_LABEL: Record<Severity, string> = { urgent: "Urgence", action: "Action requise", watch: "À surveiller", ok: "Sans alerte" };
export const ACTION_LABEL: Record<string, string> = { todo: "À faire", doing: "En cours", done: "Résolue", "": "—" };
export const CATEGORY_LABEL: Record<string, string> = {
  data: "Données", measurement: "Zéro conversion", performance: "Performance",
  budget: "Budget", delivery: "Diffusion", limited: "Faible volume / historique",
};

export const TXT = {
  noBudget: "Pas de budget renseigné", noCause: "Cause non identifiée", mixte: "Performance mixte",
  mixteDetail: "Performance mixte · voir le détail par canal", noData: "Données insuffisantes",
  na: "Non disponible", moy: "Moy. 8 sem.", brand: "Branding",
  brandDetail: "Branding · dépenses seulement, pas de KPI perf", lowVol: "Faible volume",
};

export const noKpi = (m: KpiMode | AccountMode): boolean => m === "mixte" || m === "brand";
export const modeLabel = (m: KpiMode | AccountMode): string => (m === "roas" ? "ROAS" : m === "brand" ? "BRANDING" : m === "mixte" ? "MIXTE" : "CPA");

const SYMBOL: Record<string, string> = { EUR: "€", USD: "$", GBP: "£", ZAR: "R", BRL: "R$", AUD: "A$", AED: "AED ", JPY: "¥", CHF: "CHF ", CAD: "C$", MXN: "MX$" };
const int = (v: number): string => Math.round(v).toLocaleString("fr-FR");

export interface MoneyOptions { toEur: boolean; fx: Record<string, number> }

export function money(v: number | null | undefined, ccy: string | null, o: MoneyOptions): string {
  if (v === null || v === undefined) return TXT.na;
  if (o.toEur) return `€${int(v * (ccy ? o.fx[ccy] ?? 1 : 1))}`;
  return `${ccy ? SYMBOL[ccy] ?? `${ccy} ` : ""}${int(v)}`;
}

export function kpiText(v: number | null, mode: KpiMode | AccountMode, ccy: string | null, o: MoneyOptions): string {
  if (v === null) return "—";
  return mode === "roas" ? `${v.toFixed(2).replace(".", ",")}x` : money(v, ccy, o);
}

export const pct = (d: number | null): string => (d === null ? "—" : `${d > 0 ? "+" : ""}${Math.round(d * 100)}%`);

export type Tone = "bad" | "warn" | "good" | "flat";

/** Colour of a delta: spend moves are neutral-to-alarming, KPI moves can be good. */
export function tone(d: number | null, kind: "spend" | "perf", mode?: KpiMode | AccountMode): Tone {
  if (d === null) return "flat";
  const p = d * 100;
  if (kind === "spend") return Math.abs(p) >= COCKPIT_CFG.action.spendAbs * 100 ? "bad" : Math.abs(p) >= COCKPIT_CFG.watch.spendAbs * 100 ? "warn" : "flat";
  const w = mode === "cpa" ? p : -p;
  return w >= COCKPIT_CFG.action.worse * 100 ? "bad" : w >= COCKPIT_CFG.watch.worse * 100 ? "warn" : w <= -10 ? "good" : "flat";
}

export function paceTone(p: Pacing): "bad" | "warn" | "ok" {
  const pts = Math.abs((p.pct_spent - p.pct_month) * 100);
  return pts >= COCKPIT_CFG.paceBadPts ? "bad" : pts >= COCKPIT_CFG.paceWarnPts ? "warn" : "ok";
}
export const pacePts = (p: Pacing): number => (p.pct_spent - p.pct_month) * 100;

/** The client's reference series: its blend. */
export const refOf = (c: ClientRow): SeriesMetrics => c.blended;

export function perfWorse(c: ClientRow): number {
  const r = c.blended;
  if (!noKpi(c.kpi_mode) && !r.low_vol && r.kpi_d !== null) return worsening(r.kpi_d, c.kpi_mode);
  const platforms = Object.values(c.platforms);
  const total = platforms.reduce((s, v) => s + v.spend, 0) || 1;
  let w = 0;
  for (const v of platforms) {
    if (v.kpi_d === null || v.low_vol || v.mode === "brand" || v.spend / total < COCKPIT_CFG.minShare) continue;
    w = Math.max(w, worsening(v.kpi_d, v.mode));
  }
  return w;
}

const COMPONENT: Record<string, string> = { cpm: "CPM", ctr: "CTR", cvr: "CVR", aov: "AOV" };

/** The funnel component that explains most of the drift, on the biggest degraded account. */
export function cause(c: ClientRow): { txt: string; where: string } | null {
  if (["data", "measurement", "limited"].includes(c.alert.category)) return null;
  let best: PlatformRow | null = null;
  for (const v of Object.values(c.platforms)) {
    if (worsening(v.kpi_d, v.mode) >= 0.10 && v.diag && (!best || v.spend > best.spend)) best = v;
  }
  if (!best?.diag) return null;
  let comp: [string, number] | null = null;
  let mag = 0;
  for (const [k, d] of Object.entries(best.diag) as Array<[string, number]>) {
    const w = k === "cpm" ? d : -d;
    if (w > mag) { mag = w; comp = [k, d]; }
  }
  if (!comp || mag < 0.08) return null;
  return { txt: `${COMPONENT[comp[0]]} ${comp[1] > 0 ? "+" : ""}${Math.round(comp[1] * 100)}%`, where: best.label };
}

export function spendText(c: ClientRow, o: MoneyOptions): string {
  return c.mixed ? `≈€${int(c.eur_w0)}` : money(c.blended.spend, c.ccy, o);
}

export interface BudgetRow { c: ClientRow; p: Pacing; gap: number; gapAmount: number; projection: number | null }

export function budgetRows(clients: ClientRow[]): BudgetRow[] {
  return clients.filter((c): c is ClientRow & { pacing: Pacing } => !!c.pacing).map((c) => {
    const p = c.pacing;
    return {
      c, p,
      gap: (p.pct_spent - p.pct_month) * 100,
      gapAmount: p.mtd - p.budget * p.pct_month,
      // Linear run rate to the end of the month, once enough of the month has passed.
      projection: p.pct_month >= 0.08 ? p.mtd / p.pct_month : null,
    };
  });
}

export const SEVERITY_RANK: Record<Severity, number> = { urgent: 0, action: 1, watch: 2, ok: 3 };
