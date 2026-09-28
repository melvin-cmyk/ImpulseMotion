/**
 * Global Cockpit — which ad accounts belong to which client of the sheet.
 *
 * The sheet names brands, the platforms name accounts: « LPEV » ↔
 * « Laboratoire LPEV 2 », « Saveurs & Vie » ↔ « SAVEURS ET VIE 2025 ».
 * An account matches a client when every significant word of the client
 * name appears, in order, in the account name. Short words (≤ 3 letters)
 * must be a whole word, so « FED » never matches « Fepem ».
 *
 * This is a first guess: admins correct it, and what they set (source
 * « manual ») is never overwritten. Pure functions.
 */

import { normalizeName } from "@/lib/cockpit/sheet";

export interface AvailableAccount {
  platform: "meta" | "google";
  accountId: string;
  name: string;
  currency: string | null;
  /** false: closed / disabled at the platform */
  active: boolean;
}

const FILLER = new Set(["de", "du", "des", "la", "le", "les", "et", "of", "the", "and"]);

export function significantTokens(name: string): string[] {
  return normalizeName(name).split(" ").filter((t) => t && !FILLER.has(t));
}

export function accountMatches(clientName: string, accountName: string): boolean {
  const tokens = significantTokens(clientName);
  if (!tokens.length) return false;
  const words = normalizeName(accountName).split(" ").filter(Boolean);
  const squashed = words.join("");
  // A brand written in one word on one side and two on the other (« SMSMODE » / « SMS MODE »).
  if (tokens.join("").length >= 5 && squashed.includes(tokens.join(""))) return true;
  let from = 0;
  for (const t of tokens) {
    if (t.length <= 3) {
      const i = words.indexOf(t);
      if (i < 0) return false;
      continue;
    }
    const at = squashed.indexOf(t, from);
    if (at < 0) return false;
    from = at + t.length;
  }
  return true;
}

export interface MatchClient { key: string; name: string; sheetNames: string[] }

/** Accounts of each client; an account goes to the client with the longest matching name. */
export function matchAccounts(clients: MatchClient[], accounts: AvailableAccount[]): Map<string, AvailableAccount[]> {
  const out = new Map<string, AvailableAccount[]>();
  for (const a of accounts) {
    if (!a.active) continue;
    let best: { key: string; size: number } | null = null;
    for (const c of clients) {
      // The brand alone (« Cours Legendre »), then each line of the sheet (« Dufour (LG) »).
      const names = [c.name, ...c.sheetNames.map((n) => n.replace(/\(.*?\)/g, " ").split(/\s[-–]\s/)[0])];
      for (const n of names) {
        if (!accountMatches(n, a.name)) continue;
        const size = significantTokens(n).join("").length;
        if (!best || size > best.size) best = { key: c.key, size };
      }
    }
    if (!best) {
      // Last resort: the account name starts with the brand (« ICN - ARTEM », « FEPEM New »).
      const first = normalizeName(a.name).split(" ")[0] ?? "";
      const byBrand = clients.filter((c) => c.key.length >= 3 && c.key === first);
      if (byBrand.length === 1) best = { key: byBrand[0].key, size: first.length };
    }
    if (best) out.set(best.key, [...(out.get(best.key) ?? []), a]);
  }
  return out;
}

/** Short label of an account inside its client: what its name adds to the client's. */
export function accountLabel(platform: "meta" | "google", clientName: string, accountName: string, siblings: number): string {
  const plat = platform === "meta" ? "Meta" : "Google";
  if (siblings <= 1) return plat;
  const drop = new Set([...significantTokens(clientName), "new", "compte", "account", "ads", "google", "meta", "publicitaire", "official"]);
  const rest = accountName.split(/[\s\-–_.]+/).filter((w) => w && !drop.has(normalizeName(w)) && !/^\d+$/.test(w));
  return rest.length ? `${plat} · ${rest.slice(0, 3).join(" ")}` : `${plat} · ${accountName}`;
}
