/**
 * Global Cockpit — model of each client (CPA / ROAS / branding) as it was set
 * on the agency's first cockpit, keyed by the brand token of the budget
 * sheet. It is only the starting point: an admin override (CockpitClient /
 * CockpitAccount) always wins, and a client absent from this list is read
 * from the sheet targets, then from its data.
 */

import type { AccountMode, CockpitPlatform } from "@/lib/cockpit/engine";

export interface DefaultModel {
  /** "mixte": the accounts have different models, read per account */
  mode: AccountMode | "mixte";
  meta?: AccountMode;
  google?: AccountMode;
  tiktok?: AccountMode;
}

export const DEFAULT_MODELS: Record<string, DefaultModel> = {
  cifca: { mode: "cpa" },
  collines: { mode: "roas" },
  cotton: { mode: "roas" },
  cours: { mode: "roas" },
  decathlon: { mode: "roas" },
  dufour: { mode: "cpa" },
  fepem: { mode: "cpa" },
  fountaine: { mode: "cpa" },
  france: { mode: "cpa" },
  gaia: { mode: "cpa" },
  haight: { mode: "roas" },
  hellin: { mode: "roas" },
  icn: { mode: "cpa" },
  joista: { mode: "cpa" },
  leroy: { mode: "roas" },
  liferay: { mode: "cpa" },
  livingpackets: { mode: "cpa" },
  lpev: { mode: "roas" },
  luxtrust: { mode: "cpa" },
  massena: { mode: "roas" },
  naturalia: { mode: "cpa" },
  pge: { mode: "cpa" },
  rentscape: { mode: "roas" },
  saveurs: { mode: "cpa" },
  smsmode: { mode: "cpa" },
  tbs: { mode: "cpa" },
  vins: { mode: "brand" },
  wine: { mode: "brand" },
  vocation: { mode: "cpa" },
  vorwerk: { mode: "mixte", meta: "roas" },
  yale: { mode: "roas" },
  yoga: { mode: "cpa" },
};

export function defaultModeFor(clientKey: string, platform: CockpitPlatform): AccountMode | null {
  const d = DEFAULT_MODELS[clientKey];
  if (!d) return null;
  return d[platform] ?? (d.mode === "mixte" ? null : d.mode);
}
