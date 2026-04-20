"use client";

import { createContext, useContext } from "react";
import type { DeckData } from "./deck-data";

const DeckDataContext = createContext<DeckData | null>(null);

export const DeckDataProvider = DeckDataContext.Provider;

export function useDeckData(): DeckData | null {
  return useContext(DeckDataContext);
}

/**
 * Resolve a chart's data source against live DeckData.
 *
 * Supported sources (dot-path into DeckData):
 *   - "metaCampaigns", "googleCampaigns" → labelKey=name, valueKey=spend|roas|...
 *   - "topCreatives"                     → labelKey=name, valueKey=spend|roas|...
 *   - "highlights"                       → labelKey=label, valueKey=delta|value (numeric)
 *   - "globalTable"                      → labelKey=platform, valueKey=spend|roas|...
 *   - "monthlyTrend" (synthetic)         → six-month ROAS/spend trend (currently single month duplicated)
 *
 * If the field or keys can't be resolved, returns null so the caller can fall
 * back to the element's static `chartData`.
 */
export function resolveChartSource(
  data: DeckData | null,
  source: { field: string; labelKey: string; valueKey: string },
): { label: string; value: number }[] | null {
  if (!data) return null;

  // Narrowed access rather than `any`
  const rec = data as unknown as Record<string, unknown>;
  const raw = rec[source.field];
  if (!Array.isArray(raw)) return null;

  const out: { label: string; value: number }[] = [];
  for (const row of raw) {
    if (row == null || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const label = r[source.labelKey];
    const value = r[source.valueKey];
    if (typeof label !== "string" && typeof label !== "number") continue;
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    out.push({ label: String(label), value });
  }
  return out.length > 0 ? out : null;
}
