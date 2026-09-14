"use client";

import { useCallback, useEffect, useState } from "react";

/** One row of GET /api/me/accounts/preview (already scoped server-side). */
export interface PreviewAccount {
  id: string;
  name: string;
  currency?: string;
  outOfScope: boolean;
  spend7d: number;
  roas7d: number;
  alertCount: number;
  /** Portfolio client (dashboard id) linked to this account, null when none. */
  clientId: string | null;
  /** Name of that client (dashboard), null when none. */
  clientName: string | null;
}

// Cache is keyed by userId so a list built for one user (e.g. admin) can never
// be served to another user after a sign-out/sign-in in the same tab.
const CACHE_PREFIX = "impulse_meta_accounts_preview_v3:";
const CACHE_TTL_MS = 5 * 60 * 1000;

function cacheKey(userId: string | null): string {
  return `${CACHE_PREFIX}${userId ?? "anon"}`;
}

function readCache(userId: string | null): PreviewAccount[] | null {
  try {
    const raw = sessionStorage.getItem(cacheKey(userId));
    if (!raw) return null;
    const { t, data } = JSON.parse(raw) as { t: number; data: PreviewAccount[] };
    if (Date.now() - t > CACHE_TTL_MS) return null;
    return data;
  } catch {
    return null;
  }
}

function writeCache(userId: string | null, data: PreviewAccount[]) {
  try {
    sessionStorage.setItem(cacheKey(userId), JSON.stringify({ t: Date.now(), data }));
  } catch { /* quota exceeded etc. — ignore */ }
}

export const normalizeAct = (id: string) => id.replace(/^act_/, "");

/**
 * The viewer's account list (Meta), cached 5 min per user in sessionStorage.
 * `enabled: false` defers the network call until the list is actually needed
 * (the palette is opened) — nothing is fetched just because the page mounted.
 */
export function useAccountList(userId: string | null, enabled = true) {
  const [accounts, setAccounts] = useState<PreviewAccount[]>([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async (useCache = true): Promise<PreviewAccount[]> => {
    if (useCache) {
      const cached = readCache(userId);
      if (cached && cached.length > 0) {
        setAccounts(cached);
        setLoaded(true);
        return cached;
      }
    }
    setLoading(true);
    try {
      const res = await fetch("/api/me/accounts/preview");
      if (!res.ok) return [];
      const data = (await res.json()) as { accounts: PreviewAccount[] };
      setAccounts(data.accounts);
      writeCache(userId, data.accounts);
      setLoaded(true);
      return data.accounts;
    } catch {
      return [];
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    if (enabled) void load();
  }, [enabled, load]);

  return { accounts, loading, loaded, reload: load };
}
