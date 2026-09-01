/**
 * Display formatters for creative metrics. `null`/non-finite values always
 * render as "—" so pages never show a fabricated number.
 */

export const DASH = "—";

/** Currency assumed when the account currency is unknown (shown as a code, never as "$"). */
const currencyCache = new Map<string, Intl.NumberFormat | null>();

function formatter(currency: string, digits: number): Intl.NumberFormat | null {
  const key = `${currency}:${digits}`;
  if (currencyCache.has(key)) return currencyCache.get(key) ?? null;
  let f: Intl.NumberFormat | null = null;
  try {
    f = new Intl.NumberFormat("fr-FR", {
      style: "currency",
      currency,
      currencyDisplay: "narrowSymbol",
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
  } catch {
    f = null;
  }
  currencyCache.set(key, f);
  return f;
}

/**
 * Money in the account currency (Intl, fr-FR). Amounts ≥ 1000 are shortened
 * ("12,3 k ZAR"). Unknown / invalid currency → number + code (or no code when
 * none is known). Legacy call `fmtMoney(v, 2)` (digits as 2nd arg) is still
 * accepted.
 */
export function fmtMoney(
  v: number | null | undefined,
  currencyOrDigits?: string | number | null,
  digitsArg?: number,
): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return DASH;
  const currency = typeof currencyOrDigits === "string" ? currencyOrDigits.toUpperCase() : null;
  const digits = typeof currencyOrDigits === "number" ? currencyOrDigits : (digitsArg ?? 0);
  const abs = Math.abs(v);
  const compact = abs >= 1000;
  const value = compact ? v / 1000 : v;
  const fractionDigits = compact ? 1 : digits;
  const f = currency ? formatter(currency, fractionDigits) : null;
  if (f) {
    const out = f.format(value);
    // "12,3 k ZAR": insert the k right after the number, before the symbol/code.
    return compact ? out.replace(/(\d)(\s*)(?=[^\d\s,.]|$)/, (_m, d: string, sp: string) => `${d} k${sp ? " " : ""}`).replace(/\s{2,}/g, " ") : out;
  }
  const n = value.toLocaleString("fr-FR", { minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits });
  return `${n}${compact ? " k" : ""}${currency ? ` ${currency}` : ""}`;
}

/** Formatter bound to a currency: `money(v)` / `money(v, 2)`. */
export type MoneyFmt = (v: number | null | undefined, digits?: number) => string;

export function moneyFormatter(currency: string | null | undefined): MoneyFmt {
  return (v, digits = 0) => fmtMoney(v, currency ?? null, digits);
}

export function fmtPct(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return DASH;
  return `${v.toFixed(digits)}%`;
}

export function fmtX(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return DASH;
  return `${v.toFixed(digits)}x`;
}

/** ROAS with its "*" estimated marker (only when estimated and available); "—" when null. */
export function fmtRoas(v: number | null | undefined, opts: { estimated?: boolean; unavailable?: boolean } = {}, digits = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v) || opts.unavailable) return DASH;
  return `${fmtX(v, digits)}${opts.estimated ? "*" : ""}`;
}

export function fmtInt(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return DASH;
  return v.toLocaleString("fr-FR");
}

/** Time "HH:MM" (fr-FR) of an ISO timestamp, "—" when invalid. */
export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return DASH;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return DASH;
  return d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
}

export function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : pluralForm}`;
}
