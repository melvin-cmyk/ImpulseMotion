/**
 * Routines — the ONE rule for the ids of the ad accounts a routine is tied to.
 *
 * Used where the routine is created (app/api/routines/route.ts), where its
 * fingerprint is computed (lib/routines/hash.ts), by the Meta writer
 * (lib/meta-write.ts) and by the Google step: an id accepted at creation is
 * accepted everywhere after, and the other way round.
 *
 * Strict on purpose, real ids only:
 *   Meta    "act_" (optional) then 6 to 20 digits (accounts of the agency
 *           have 8 digits: the lower bound leaves room under them);
 *   Google  10 digits, written "1234567890" or "123-456-7890".
 * Pure and client-safe.
 */

const META_ACCOUNT_RE = /^(?:act_)?(\d{6,20})$/;
const GOOGLE_CUSTOMER_RE = /^(?:\d{10}|\d{3}-\d{3}-\d{4})$/;

/** Digits of a Meta ad account id, without "act_"; null when it is not one. */
export function metaAccountDigits(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const m = META_ACCOUNT_RE.exec(value.trim());
  return m ? m[1] : null;
}

export function isMetaAccountId(value: unknown): value is string {
  return metaAccountDigits(value) !== null;
}

/** The ten digits of a Google Ads customer id; null when it is not one. */
export function googleCustomerDigits(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  return GOOGLE_CUSTOMER_RE.test(raw) ? raw.replace(/-/g, "") : null;
}

export function isGoogleCustomerId(value: unknown): value is string {
  return googleCustomerDigits(value) !== null;
}

export const META_ACCOUNT_INVALID = "compte Meta invalide : « act_ » puis 6 à 20 chiffres sont attendus";
export const GOOGLE_CUSTOMER_INVALID = "compte Google Ads invalide : 10 chiffres sont attendus (1234567890 ou 123-456-7890)";
