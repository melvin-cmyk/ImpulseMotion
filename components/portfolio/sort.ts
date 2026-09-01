import type { PortfolioClient } from "@/lib/portfolio";

export type SortKey = "spend" | "roas" | "cpa" | "conversions" | "attention" | "name";
export type SortDir = "asc" | "desc";

export const DEFAULT_DIR: Record<SortKey, SortDir> = { spend: "desc", roas: "desc", cpa: "asc", conversions: "desc", attention: "desc", name: "asc" };

/**
 * Stable comparator: clients without data / without a value (CPA 0, ROAS
 * unavailable) always go LAST whatever the direction; ties are broken by
 * spend (desc) then name so the order never flickers between reloads.
 */
export function compareClients(a: PortfolioClient, b: PortfolioClient, key: SortKey, dir: SortDir): number {
  const sign = dir === "asc" ? 1 : -1;
  const tie = () => (b.spend.value - a.spend.value) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
  if (key === "name") return a.name.localeCompare(b.name) * sign || tie();
  const val = (c: PortfolioClient): number | null => {
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
