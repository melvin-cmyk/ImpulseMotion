/** Shared bits of the Créas pages (client-side). */

import type { AssetView } from "@/lib/studio-assets";
import type { FactoryCopyView, FactoryRunView, FeedbackView, TemplateView } from "@/lib/creas/model";

export type Asset = AssetView;
export type Template = TemplateView;
export type FactoryRun = FactoryRunView;
export type FactoryCopy = FactoryCopyView;
export type Feedback = FeedbackView;
export interface Engine { id: string; label: string; provider: "agnes" | "fal"; refs: boolean; usd: number }
export interface QuotaInfo { quotas: { teamDailyUsd: number; userDailyUsd: number; teamDailyImages: number; warnAtPct: number }; today: { team: { usd: number; images: number }; user: { usd: number; images: number } } }
export interface ClientOption { id: string; clientId: string; aliasIds: string[]; name: string; dashboardId: string | null; hqSlug: string | null }

export const usd = (v: number) => `${v.toFixed(2).replace(".", ",")} $`;
export const when = (iso: string) => new Date(iso).toLocaleString("fr-FR", { timeZone: "Europe/Paris", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
export const aspect = (r?: unknown) => { const [w, h] = String(r ?? "1:1").split(":").map(Number); return w && h ? `${w} / ${h}` : "1 / 1"; };

export const ORIGIN_LABEL: Record<string, string> = { studio: "Génération libre", template: "Depuis un template", variation: "Variante", factory: "Fabrique", asset: "Élément de marque" };

export const BTN = "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm border border-gray-700 text-gray-200 hover:text-white hover:border-gray-500 disabled:opacity-40";
export const BTN_PRIMARY = "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm bg-violet-600 hover:bg-violet-500 text-white font-medium disabled:opacity-40";
export const FIELD = "bg-gray-950 border border-gray-800 rounded-lg px-2.5 py-1.5 text-sm text-white outline-none focus:border-violet-500";

/** The price line shown before a generation: unit × n, what the team and the consultant spent today, amber near a cap, red over it. */
export function priceReminder(quota: QuotaInfo | null, unitUsd: number, n: number): { text: string; over: boolean; warn: boolean } | null {
  if (!quota) return null;
  const { quotas: q, today } = quota;
  const estimate = unitUsd * n;
  const teamAfter = today.team.usd + estimate;
  const userAfter = today.user.usd + estimate;
  const over = (q.teamDailyUsd > 0 && teamAfter > q.teamDailyUsd) || (q.userDailyUsd > 0 && userAfter > q.userDailyUsd) || (q.teamDailyImages > 0 && today.team.images + n > q.teamDailyImages);
  const warn = !over && ((q.teamDailyUsd > 0 && (teamAfter / q.teamDailyUsd) * 100 >= q.warnAtPct) || (q.userDailyUsd > 0 && (userAfter / q.userDailyUsd) * 100 >= q.warnAtPct));
  const cost = estimate > 0 ? (n > 1 ? `${n} × ${usd(unitUsd)} = ${usd(estimate)}` : usd(estimate)) : "gratuit";
  return {
    text: `Coût estimé : ${cost} · Aujourd'hui : équipe ${usd(today.team.usd)}${q.teamDailyUsd > 0 ? ` / ${usd(q.teamDailyUsd)}` : ""} · toi ${usd(today.user.usd)}${q.userDailyUsd > 0 ? ` / ${usd(q.userDailyUsd)}` : ""}${q.teamDailyImages > 0 ? ` · ${today.team.images} / ${q.teamDailyImages} images` : ""}`,
    over, warn,
  };
}

/** « 0,003 $ / image » or « gratuit »: the price shown next to each engine (the cheap ones cost less than a cent). */
export const enginePrice = (e: Pick<Engine, "usd">) => (e.usd > 0 ? `${String(Math.round(e.usd * 1000) / 1000).replace(".", ",")} $ / image` : "gratuit");

/**
 * The engine used while the consultant has not chosen one: the cheapest fal.ai
 * model that fits (FLUX Schnell without a reference image, the cheapest edit
 * model with one), Agnes only when fal is not configured.
 */
export function cheapestEngine(engines: Engine[], withRefs: boolean): Engine | null {
  const fits = engines.filter((e) => !withRefs || e.refs);
  const pool = fits.some((e) => e.provider === "fal") ? fits.filter((e) => e.provider === "fal") : fits;
  return pool.reduce<Engine | null>((best, e) => (!best || e.usd < best.usd ? e : best), null);
}

export function matchClient(clients: ClientOption[], wanted: string | null): ClientOption | null {
  if (!wanted) return null;
  return clients.find((c) => c.id === wanted || c.clientId === wanted || c.dashboardId === wanted || c.aliasIds.includes(wanted)) ?? null;
}

/** What may still be spent today (the tightest of the team's and the consultant's USD caps), null when no cap is set. */
export function remainingToday(quota: QuotaInfo | null): number | null {
  if (!quota) return null;
  const { quotas: q, today } = quota;
  const caps = [q.teamDailyUsd > 0 ? q.teamDailyUsd - today.team.usd : null, q.userDailyUsd > 0 ? q.userDailyUsd - today.user.usd : null].filter((v): v is number => v !== null);
  return caps.length ? Math.max(0, Math.min(...caps)) : null;
}

/** The price line of a fabrique: « 12 × 0,06 $ = 0,72 $ · reste aujourd'hui 4,28 $ ». */
export function factoryPriceLine(quota: QuotaInfo | null, unitUsd: number, n: number): { text: string; over: boolean } {
  const total = Math.round(unitUsd * n * 1000) / 1000;
  const rest = remainingToday(quota);
  const r = priceReminder(quota, unitUsd, n);
  return { text: `${n} × ${usd(unitUsd)} = ${usd(total)} · reste aujourd'hui ${rest === null ? "sans plafond" : usd(rest)}`, over: r?.over ?? false };
}
