/**
 * Shared formatters for the portfolio / cockpit / client sheet.
 * Every amount goes through `fmtMoney(value, currency)` — no hard-coded €.
 */

const cache = new Map<string, Intl.NumberFormat>();

function numberFormat(currency: string | null | undefined, digits: number): Intl.NumberFormat {
  const key = `${currency ?? "-"}:${digits}`;
  let f = cache.get(key);
  if (!f) {
    try {
      f = currency
        ? new Intl.NumberFormat("fr-FR", { style: "currency", currency, maximumFractionDigits: digits, minimumFractionDigits: 0 })
        : new Intl.NumberFormat("fr-FR", { maximumFractionDigits: digits });
    } catch {
      f = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: digits });
    }
    cache.set(key, f);
  }
  return f;
}

/** Amount in the account currency; without a currency the bare number is shown (never a fake €). */
export function fmtMoney(value: number | null | undefined, currency?: string | null, opts: { digits?: number } = {}): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const digits = opts.digits ?? (Math.abs(value) < 100 ? 2 : 0);
  return numberFormat(currency, digits).format(value);
}

export function fmtNumber(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return value.toLocaleString("fr-FR", { maximumFractionDigits: digits });
}

export function fmtPct(value: number | null | undefined, digits = 1, withSign = false): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const s = value.toLocaleString("fr-FR", { maximumFractionDigits: digits });
  return `${withSign && value > 0 ? "+" : ""}${s} %`;
}

/** ROAS: "—" when unavailable, "*" suffix when estimated (purchases × AOV). */
export function fmtRoas(value: number | null | undefined, flags: { estimated?: boolean; unavailable?: boolean } = {}): string {
  if (flags.unavailable || value === null || value === undefined || !Number.isFinite(value)) return "—";
  if (value <= 0) return "—";
  return `${value.toLocaleString("fr-FR", { maximumFractionDigits: 2 })}x${flags.estimated ? "*" : ""}`;
}

/** Metric-aware formatter (spend/revenue/cpa/cpc = money, ctr/cr = %, roas = x, else number). */
export function fmtMetric(metric: string, value: number | null | undefined, currency?: string | null, flags: { estimated?: boolean; unavailable?: boolean } = {}): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  switch (metric) {
    case "spend":
    case "revenue":
    case "cost":
      return flags.unavailable ? "—" : fmtMoney(value, currency, { digits: 0 });
    case "cpa":
    case "cpc":
    case "cpm":
      return fmtMoney(value, currency, { digits: 2 });
    case "ctr":
    case "cr":
      return fmtPct(value, 2);
    case "roas":
      return fmtRoas(value, flags);
    default:
      return fmtNumber(value, 0);
  }
}

/** "HH:MM" (local) for "données au HH:MM"; adds the day when older than today. */
export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const sameDay = d.toDateString() === new Date().toDateString();
  const time = d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  return sameDay ? time : `${d.toLocaleDateString("fr-FR", { day: "numeric", month: "short" })} ${time}`;
}

/** Plain-French explanation of a client error kind. */
export function errorKindLabel(kind: string | null | undefined): string {
  switch (kind) {
    case "rate_limit": return "quota Meta atteint, réessayez dans quelques minutes";
    case "auth": return "token Meta expiré";
    case "permission": return "compte hors du Business Manager";
    case "invalid": return "requête Meta refusée (compte ou paramètres invalides)";
    case "transient": return "Meta temporairement indisponible";
    case "google": return "Google Ads indisponible";
    case "timeout": return "délai dépassé";
    case "widget": return "données indisponibles";
    default: return "données indisponibles";
  }
}

export const PACING_STATUS_LABEL: Record<string, string> = {
  on_track: "Dans la cible",
  under: "Sous-consomme",
  over: "Sur-consomme",
  critical_under: "Très en retard",
  critical_over: "Très en avance",
  unknown: "Inconnu",
};
