/** Shared bits of the Créas pages (client-side). */

import type { AssetView } from "@/lib/studio-assets";
import type { TemplateView } from "@/lib/creas/model";

export type Asset = AssetView;
export type Template = TemplateView;
export interface Engine { id: string; label: string; provider: "agnes" | "fal"; refs: boolean; usd: number }
export interface QuotaInfo { quotas: { teamDailyUsd: number; userDailyUsd: number; teamDailyImages: number; warnAtPct: number }; today: { team: { usd: number; images: number }; user: { usd: number; images: number } } }
export interface ClientOption { id: string; clientId: string; aliasIds: string[]; name: string; dashboardId: string | null; hqSlug: string | null }

export const usd = (v: number) => `${v.toFixed(2).replace(".", ",")} $`;
export const when = (iso: string) => new Date(iso).toLocaleString("fr-FR", { timeZone: "Europe/Paris", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
export const aspect = (r?: unknown) => { const [w, h] = String(r ?? "1:1").split(":").map(Number); return w && h ? `${w} / ${h}` : "1 / 1"; };

export const ORIGIN_LABEL: Record<string, string> = { studio: "Studio", template: "Depuis un template", variation: "Variante", asset: "Élément de marque" };

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

export function matchClient(clients: ClientOption[], wanted: string | null): ClientOption | null {
  if (!wanted) return null;
  return clients.find((c) => c.id === wanted || c.clientId === wanted || c.dashboardId === wanted || c.aliasIds.includes(wanted)) ?? null;
}
