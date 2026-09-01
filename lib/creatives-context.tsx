"use client";

import { createContext, useContext, useEffect, useState, useCallback, useMemo, useRef, useSyncExternalStore } from "react";
import type { Creative, CreativesMeta, WowMetrics } from "./creative-types";
import { mockCreatives } from "./mock-data";
import { useCreatives } from "./use-creatives";
import { useWow, type WowData } from "./use-wow";
import { lastFullDays, presetRange, prevRange, type DateRange as CanonicalRange } from "./date-ranges";
import { moneyFormatter, type MoneyFmt } from "./creative-format";

/** localStorage keys shared with components/account-picker.tsx */
export const META_ACCOUNT_STORAGE_KEY = "impulse_meta_account";
export const TIKTOK_ACCOUNT_STORAGE_KEY = "impulse_tiktok_account";
/** Dispatched on `window` to re-read the stored selection (refetch, deep link). */
export const ACCOUNT_CHANGE_EVENT = "impulse:account-change";

export type DatePreset = 7 | 14 | 30 | 90;

export type DateRange = CanonicalRange;

interface CreativesContextValue {
  creatives: Creative[];
  isLoading: boolean;
  /** True when the list comes from a connected account (real Meta/TikTok data, possibly empty). */
  isRealData: boolean;
  /** True when at least one ad account is selected. */
  isConnected: boolean;
  error: string | null;
  /** Refetch; `{ refresh: true }` bypasses the server cache (Meta re-read). */
  refetch: (opts?: { refresh?: boolean }) => void;
  /** Provenance / freshness of the Meta list (null in demo mode or while loading). */
  meta: CreativesMeta | null;
  /** ISO 4217 currency of the selected Meta account (null when unknown / demo). */
  currency: string | null;
  /** Currently selected date range */
  dateRange: DateRange;
  /** Currently active preset (null if custom) */
  datePreset: DatePreset | null;
  /** Set date range via a preset number of FULL days ending yesterday */
  setDatePreset: (days: DatePreset) => void;
  /** Set a fully custom date range */
  setDateRange: (range: DateRange) => void;
  /** Selected Meta campaign id filter (null = all) */
  campaignId: string | null;
  setCampaignId: (id: string | null) => void;
  /** Connected Meta ad account id (act_…), null when none is selected */
  metaAccountId: string | null;
  /** Week-over-week data (null when no Meta account connected) */
  wowData: WowData | null;
  isWowLoading: boolean;
}

const CreativesContext = createContext<CreativesContextValue | null>(null);

const DEFAULT_PRESET: DatePreset = 30;

/** Browser timezone (the account timezone is only known once `meta` arrives). */
function browserTz(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

function readStoredAccount(key: string): string | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const id = JSON.parse(raw)?.accountId;
    return typeof id === "string" && id ? id : null;
  } catch {
    return null;
  }
}

const normalizeAct = (id: string) => id.replace(/^act_/, "");

// The selected accounts are an external store (localStorage written by the
// account picker): subscribe to storage + our own change event, snapshot =
// the stored id (string → stable comparison), null during SSR / hydration.
function subscribeAccounts(callback: () => void): () => void {
  window.addEventListener("storage", callback);
  window.addEventListener(ACCOUNT_CHANGE_EVENT, callback);
  return () => {
    window.removeEventListener("storage", callback);
    window.removeEventListener(ACCOUNT_CHANGE_EVENT, callback);
  };
}
const readMeta = () => readStoredAccount(META_ACCOUNT_STORAGE_KEY);
const readTiktok = () => readStoredAccount(TIKTOK_ACCOUNT_STORAGE_KEY);
const readNone = () => null;

/** Notifies every CreativesProvider that the stored selection changed. */
export function notifyAccountChange(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(ACCOUNT_CHANGE_EVENT));
}

export function CreativesProvider({ children }: { children: React.ReactNode }) {
  const metaAccountId = useSyncExternalStore(subscribeAccounts, readMeta, readNone);
  const tiktokAccountId = useSyncExternalStore(subscribeAccounts, readTiktok, readNone);
  const [nonce, setNonce] = useState(0);
  const refreshRef = useRef(false);

  // Date range state — defaults to the last 30 FULL days ending yesterday.
  const [datePreset, setDatePresetState] = useState<DatePreset | null>(DEFAULT_PRESET);
  const [dateRange, setDateRangeState] = useState<DateRange>(() => presetRange("last_30", { tz: browserTz() }));

  // Campaign filter
  const [campaignId, setCampaignId] = useState<string | null>(null);

  // Deep links from the cockpit / portfolio: `?accountId=act_…` selects the
  // account (when allowed for this user), persists it for the picker and is
  // then stripped from the URL. When the stored account differs, the page is
  // reloaded so the picker (which reads localStorage on mount) agrees.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    const wanted = url.searchParams.get("accountId");
    if (!wanted) return;
    let cancelled = false;
    (async () => {
      let allowed = false;
      let name = "";
      try {
        const res = await fetch("/api/me/accounts/preview");
        if (res.ok) {
          const data = (await res.json()) as { accounts?: Array<{ id: string; name?: string; outOfScope?: boolean }> };
          const match = data.accounts?.find((a) => normalizeAct(a.id) === normalizeAct(wanted) && !a.outOfScope);
          if (match) {
            allowed = true;
            name = match.name ?? "";
          }
        }
      } catch {
        allowed = false;
      }
      if (cancelled) return;
      url.searchParams.delete("accountId");
      const clean = `${url.pathname}${url.search}${url.hash}`;
      if (!allowed) {
        window.history.replaceState(window.history.state, "", clean);
        return;
      }
      const id = wanted.startsWith("act_") ? wanted : `act_${wanted}`;
      const current = readStoredAccount(META_ACCOUNT_STORAGE_KEY);
      try {
        localStorage.setItem(META_ACCOUNT_STORAGE_KEY, JSON.stringify({ accountId: id, accountName: name }));
      } catch {
        // storage unavailable — keep the in-memory selection only
      }
      if (current && normalizeAct(current) === normalizeAct(id)) {
        window.history.replaceState(window.history.state, "", clean);
        return;
      }
      notifyAccountChange();
      window.location.replace(clean);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const isConnected = !!(metaAccountId || tiktokAccountId);

  const { creatives, loading, error, isRealData, meta } = useCreatives({
    metaAccountId,
    tiktokAccountId,
    isConnected,
    since: dateRange.since,
    until: dateRange.until,
    campaignId: campaignId ?? undefined,
    nonce,
    refreshRef,
  });

  const { wowData: realWowData, loading: wowLoading } = useWow({
    metaAccountId,
    enabled: !!metaAccountId,
    since: dateRange.since,
    until: dateRange.until,
    nonce,
  });

  // Demo WoW aggregate built from the mock creatives (demo mode only).
  const mockWowData = useMemo<WowData>(() => {
    const wowByAdId: Record<string, WowMetrics> = {};
    for (const c of mockCreatives) if (c.wow) wowByAdId[c.id] = c.wow;
    const vals = mockCreatives.map((c) => c.wow).filter(Boolean) as WowMetrics[];
    const avg = (key: keyof WowMetrics) => {
      const nonNull = vals.map((v) => v[key]).filter((v) => v !== null) as number[];
      return nonNull.length ? nonNull.reduce((a, b) => a + b, 0) / nonNull.length : null;
    };
    const current = lastFullDays(7, { tz: browserTz() });
    return {
      wowByAdId,
      aggregateWow: {
        spendChange: avg("spendChange"),
        ctrChange: avg("ctrChange"),
        cpaChange: avg("cpaChange"),
        roasChange: avg("roasChange"),
        hookRateChange: avg("hookRateChange"),
      },
      currentPeriod: current,
      prevPeriod: prevRange(current),
    };
  }, []);

  const wowData: WowData | null = isConnected ? (realWowData ?? null) : mockWowData;

  // The account picker writes localStorage then calls refetch(): re-read the
  // selection (external store) and bump the request nonce.
  const refetch = useCallback((opts?: { refresh?: boolean }) => {
    refreshRef.current = opts?.refresh === true;
    notifyAccountChange();
    setNonce((k) => k + 1);
  }, []);

  const setDatePreset = useCallback((days: DatePreset) => {
    setDatePresetState(days);
    setDateRangeState(lastFullDays(days, { tz: browserTz() }));
  }, []);

  const setDateRange = useCallback((range: DateRange) => {
    setDatePresetState(null);
    setDateRangeState(range);
  }, []);

  return (
    <CreativesContext.Provider
      value={{
        creatives,
        isLoading: loading,
        isRealData,
        isConnected,
        error,
        refetch,
        meta,
        currency: meta?.currency ?? null,
        dateRange,
        datePreset,
        setDatePreset,
        setDateRange,
        campaignId,
        setCampaignId,
        metaAccountId,
        wowData,
        isWowLoading: isConnected ? wowLoading : false,
      }}
    >
      {children}
    </CreativesContext.Provider>
  );
}

/** Money formatter bound to the selected account's currency (code shown when unknown). */
export function useMoney(): MoneyFmt {
  const { currency } = useCreativesContext();
  return useMemo(() => moneyFormatter(currency), [currency]);
}

export function useCreativesContext(): CreativesContextValue {
  const ctx = useContext(CreativesContext);
  if (!ctx) {
    throw new Error("useCreativesContext must be used within a CreativesProvider");
  }
  return ctx;
}
