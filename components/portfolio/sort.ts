import type { PortfolioClient } from "@/lib/portfolio";
import type { PortfolioClientCrm } from "@/components/portfolio/crm-types";

export type SortKey = "spend" | "roas" | "cpa" | "conversions" | "attention" | "name" | "crm";
export type SortDir = "asc" | "desc";

export const DEFAULT_DIR: Record<SortKey, SortDir> = { spend: "desc", roas: "desc", cpa: "asc", conversions: "desc", attention: "desc", name: "asc", crm: "asc" };

/** PortfolioClient with the optional HubSpot summary (declared locally until lib/portfolio.ts exports it). */
export type PortfolioRow = PortfolioClient & { crm?: PortfolioClientCrm };

/**
 * Stable comparator: clients without data / without a value (CPA 0, ROAS
 * unavailable, no CRM) always go LAST whatever the direction; ties are broken
 * by spend (desc) then name so the order never flickers between reloads.
 * "crm" sorts on the HubSpot qualified CPL (lowest first by default).
 */
export function compareClients(a: PortfolioClient, b: PortfolioClient, key: SortKey, dir: SortDir): number {
  const sign = dir === "asc" ? 1 : -1;
  const tie = () => (b.spend.value - a.spend.value) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
  if (key === "name") return a.name.localeCompare(b.name) * sign || tie();
  const val = (c: PortfolioClient): number | null => {
    if (key === "crm") {
      const crm = (c as PortfolioRow).crm;
      if (!crm || crm.error) return null;
      return crm.cplQualified !== null && crm.cplQualified > 0 ? crm.cplQualified : null;
    }
    if (!c.fetchOk) return null;
    if (key === "attention") return c.attention;
    if (key === "cpa") return c.cpa.value > 0 ? c.cpa.value : null;
    if (key === "roas") return c.roas.unavailable || c.roas.value <= 0 ? null : c.roas.value;
    if (key === "conversions") return c.conversions.value;
    return c.spend.value;
  };
  const va = val(a);
  const vb = val(b);
  if (va === null && vb === null) return tie();
  if (va === null) return 1;
  if (vb === null) return -1;
  if (va === vb) return tie();
  return (va - vb) * sign;
}
