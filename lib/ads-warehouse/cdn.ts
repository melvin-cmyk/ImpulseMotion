/**
 * Signed Meta CDN URLs (client-safe helpers). `oe=` is the hex expiry, about
 * 5 days after Meta issued the URL; past it the CDN answers 403.
 */

/** Expiry in ms, or null when the URL carries none (not a signed fbcdn URL). */
export function fbcdnExpiry(url: string | null | undefined): number | null {
  const m = url?.match(/[?&]oe=([0-9A-Fa-f]{6,10})/);
  return m ? parseInt(m[1], 16) * 1000 : null;
}

/** True when a stored Meta CDN URL is still usable for at least `marginMs`. */
export function fbcdnUsable(url: string | null | undefined, marginMs = 2 * 3600_000): boolean {
  if (!url) return false;
  const exp = fbcdnExpiry(url);
  return exp === null || exp - Date.now() > marginMs;
}
