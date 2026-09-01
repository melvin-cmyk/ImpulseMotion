/**
 * CRM (HubSpot) shapes as seen by the UI — type-only re-exports of the server
 * contract (lib/crm-view.ts, lib/portfolio.ts) plus UI-only labels. Client
 * components import from here so they never pull server code at runtime.
 */

import type { CrmSource } from "@/lib/hubspot/types";
import type { CrmLevel } from "@/lib/crm-view";

export type {
  CrmLevel,
  CrmFunnelData,
  CrmAttributionData,
  CrmSourceRow as CrmAttributionSourceRow,
  CrmCampaignView as CrmAttributionCampaignRow,
} from "@/lib/crm-view";
export type { PortfolioCrm as PortfolioClientCrm } from "@/lib/portfolio";

/** French labels for HubSpot origin sources (row.label from the API wins when present). */
export const CRM_SOURCE_LABELS: Record<CrmSource, string> = {
  PAID_SOCIAL: "Social payant (Meta)",
  PAID_SEARCH: "Recherche payante (Google)",
  ORGANIC_SEARCH: "Recherche organique",
  SOCIAL_MEDIA: "Réseaux sociaux (organique)",
  EMAIL_MARKETING: "E-mail",
  REFERRALS: "Référents",
  DIRECT_TRAFFIC: "Trafic direct",
  OTHER_CAMPAIGNS: "Autres campagnes",
  OFFLINE: "Hors ligne",
  UNKNOWN: "Inconnue",
};

export const CRM_LEVEL_INFO: Record<CrmLevel, { label: string; tone: "default" | "amber" | "emerald"; title: string; explanation: string }> = {
  0: {
    label: "L0",
    tone: "default",
    title: "Pas d'attribution",
    explanation: "Les contacts HubSpot de la période n'ont pas de source d'origine exploitable : impossible de relier le CRM aux campagnes.",
  },
  1: {
    label: "L1",
    tone: "amber",
    title: "Attribution par source",
    explanation: "HubSpot renseigne la source d'origine des contacts : CPL qualifié et ROAS réel sont calculés par plateforme (social payant = Meta, recherche payante = Google), pas encore par campagne.",
  },
  2: {
    label: "L2",
    tone: "emerald",
    title: "Attribution par campagne",
    explanation: "Les contacts portent un utm_campaign rattaché aux campagnes Meta / Google : CPL qualifié et ROAS réel sont disponibles campagne par campagne.",
  },
};

export function pctOf(part: number, total: number): number | null {
  if (!Number.isFinite(part) || !Number.isFinite(total) || total <= 0) return null;
  return (part / total) * 100;
}
