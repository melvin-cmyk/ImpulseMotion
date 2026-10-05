/**
 * Global Cockpit — currency conversion to EUR (totals only; every client is
 * shown in the currency of its account). Rates: ECB daily reference rates,
 * cached a day; currencies the ECB does not cover use a fixed fallback.
 */

import { cached } from "@/lib/kpi-cache";

const ECB_URL = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml";

/** EUR value of one unit — fallback of July 2026, used when the ECB is unreachable or silent on a currency. */
export const FX_FALLBACK: Record<string, number> = {
  EUR: 1, USD: 0.877, GBP: 1.162, ZAR: 0.0538, BRL: 0.169, AUD: 0.617, AED: 0.235,
  JPY: 0.00556, CHF: 1.07, CAD: 0.64, MXN: 0.047,
  // Fixed pegs to the euro (exact): franc CFA (XOF, XAF), franc pacifique (XPF).
  XOF: 1 / 655.957, XAF: 1 / 655.957, XPF: 1 / 119.33174,
  // Not published by the ECB, approximate: dirham marocain, dinar tunisien.
  MAD: 0.092, TND: 0.29,
};

export interface FxTable { rates: Record<string, number>; note: string }

/** ECB XML (`<Cube currency='USD' rate='1.14'/>` = units per EUR) → EUR per unit. */
export function parseEcb(xml: string): { date: string | null; rates: Record<string, number> } {
  const date = /time=['"](\d{4}-\d{2}-\d{2})['"]/.exec(xml)?.[1] ?? null;
  const rates: Record<string, number> = { EUR: 1 };
  for (const m of xml.matchAll(/currency=['"]([A-Z]{3})['"]\s+rate=['"]([\d.]+)['"]/g)) {
    const perEur = Number(m[2]);
    if (perEur > 0) rates[m[1]] = 1 / perEur;
  }
  return { date, rates };
}

export async function loadFx(): Promise<FxTable> {
  try {
    const ecb = await cached("cockpit:fx:ecb", async () => {
      const res = await fetch(ECB_URL, { cache: "no-store", signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`ECB ${res.status}`);
      const parsed = parseEcb(await res.text());
      if (Object.keys(parsed.rates).length < 5) throw new Error("ECB: réponse vide");
      return parsed;
    }, { ttlMs: 12 * 3600 * 1000 });
    return {
      rates: { ...FX_FALLBACK, ...ecb.rates },
      note: `FX BCE au ${ecb.date ?? "jour"} · devises non couvertes : taux de secours`,
    };
  } catch {
    return { rates: { ...FX_FALLBACK }, note: "FX : taux de secours (BCE injoignable)" };
  }
}
