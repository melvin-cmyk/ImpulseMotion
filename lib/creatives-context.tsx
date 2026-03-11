"use client";

import { createContext, useContext, useEffect, useState, useCallback, useMemo } from "react";
import { Creative, mockCreatives } from "./mock-data";
import { useCreatives } from "./use-creatives";
import { useWow, WowData } from "./use-wow";

/** Helper: returns YYYY-MM-DD string for a date offset from today */
function offsetDate(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().split("T")[0];
}

export type DatePreset = 7 | 14 | 30 | 90;

export interface DateRange {
  since: string; // YYYY-MM-DD
  until: string; // YYYY-MM-DD
}

interface CreativesContextValue {
  creatives: Creative[];
  isLoading: boolean;
  isRealData: boolean;
  error: string | null;
  refetch: () => void;
  /** Currently selected date range */
  dateRange: DateRange;
  /** Currently active preset (null if custom) */
  datePreset: DatePreset | null;
  /** Set date range via a preset number of days */
  setDatePreset: (days: DatePreset) => void;
  /** Set a fully custom date range */
  setDateRange: (range: DateRange) => void;
  /** Selected Meta campaign id filter (null = all) */
  campaignId: string | null;
  setCampaignId: (id: string | null) => void;
  /** Selected Meta campaign status filter (null = all) */
  campaignStatus: "ACTIVE" | "PAUSED" | null;
  setCampaignStatus: (status: "ACTIVE" | "PAUSED" | null) => void;
  /** Week-over-week data (null when no Meta account connected) */
  wowData: WowData | null;
  isWowLoading: boolean;
}

const CreativesContext = createContext<CreativesContextValue | null>(null);

const DEFAULT_PRESET: DatePreset = 7;

export function CreativesProvider({ children }: { children: React.ReactNode }) {
  const [metaAccountId, setMetaAccountId] = useState<string | null>(null);
  const [tiktokAccountId, setTiktokAccountId] = useState<string | null>(null);
  const [fetchKey, setFetchKey] = useState(0);

  // Date range state — defaults to last 30 days
  const [datePreset, setDatePresetState] = useState<DatePreset | null>(DEFAULT_PRESET);
  const [dateRange, setDateRangeState] = useState<DateRange>({
    since: offsetDate(-DEFAULT_PRESET),
    until: offsetDate(0),
  });

  // Campaign filter
  const [campaignId, setCampaignId] = useState<string | null>(null);
  const [campaignStatus, setCampaignStatus] = useState<"ACTIVE" | "PAUSED" | null>(null);

  useEffect(() => {
    const meta = localStorage.getItem("impulse_meta_account");
    const tiktok = localStorage.getItem("impulse_tiktok_account");
    if (meta) {
      try {
        setMetaAccountId(JSON.parse(meta).accountId);
      } catch {}
    }
    if (tiktok) {
      try {
        setTiktokAccountId(JSON.parse(tiktok).accountId);
      } catch {}
    }
  }, [fetchKey]);

  const isConnected = !!(metaAccountId || tiktokAccountId);

  const { wowData: realWowData, loading: wowLoading } = useWow({
    metaAccountId,
    enabled: !!metaAccountId,
  });

  const { creatives, loading, error, isRealData } = useCreatives({
    metaAccountId,
    tiktokAccountId,
    isConnected,
    since: dateRange.since,
    until: dateRange.until,
    campaignId: campaignId ?? undefined,
    campaignStatus: campaignStatus ?? undefined,
  });

  // Build mock WoW aggregate for demo mode from mock creatives
  const mockWowData = useMemo<WowData>(() => {
    const wowByAdId: Record<string, import("./mock-data").WowMetrics> = {};
    for (const c of mockCreatives) {
      if (c.wow) wowByAdId[c.id] = c.wow;
    }
    // Compute aggregate from mock values
    const vals = mockCreatives.map((c) => c.wow).filter(Boolean) as import("./mock-data").WowMetrics[];
    const avg = (key: keyof import("./mock-data").WowMetrics) => {
      const nonNull = vals.map((v) => v[key]).filter((v) => v !== null) as number[];
      return nonNull.length ? nonNull.reduce((a, b) => a + b, 0) / nonNull.length : null;
    };
    return {
      wowByAdId,
      aggregateWow: {
        spendChange: avg("spendChange"),
        ctrChange: avg("ctrChange"),
        cpaChange: avg("cpaChange"),
        roasChange: avg("roasChange"),
        hookRateChange: avg("hookRateChange"),
      },
      currentPeriod: { since: offsetDate(-7), until: offsetDate(0) },
      prevPeriod: { since: offsetDate(-14), until: offsetDate(-8) },
    };
  }, []);

  // Use real WoW data when connected, otherwise use mock WoW data for demo
  const wowData: WowData | null = isRealData
    ? (realWowData ?? null)
    : mockWowData;

  const refetch = useCallback(() => {
    setFetchKey((k) => k + 1);
  }, []);

  const setDatePreset = useCallback((days: DatePreset) => {
    setDatePresetState(days);
    setDateRangeState({
      since: offsetDate(-days),
      until: offsetDate(0),
    });
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
        error,
        refetch,
        dateRange,
        datePreset,
        setDatePreset,
        setDateRange,
        campaignId,
        setCampaignId,
        campaignStatus,
        setCampaignStatus,
        wowData,
        isWowLoading: isRealData ? wowLoading : false,
      }}
    >
      {children}
    </CreativesContext.Provider>
  );
}

export function useCreativesContext(): CreativesContextValue {
  const ctx = useContext(CreativesContext);
  if (!ctx) {
    throw new Error("useCreativesContext must be used within a CreativesProvider");
  }
  return ctx;
}
