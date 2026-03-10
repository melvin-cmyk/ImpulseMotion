"use client";

import { createContext, useContext, useEffect, useState, useCallback } from "react";
import { Creative } from "./mock-data";
import { useCreatives } from "./use-creatives";

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

  const { creatives, loading, error, isRealData } = useCreatives({
    metaAccountId,
    tiktokAccountId,
    isConnected,
    since: dateRange.since,
    until: dateRange.until,
    campaignId: campaignId ?? undefined,
    campaignStatus: campaignStatus ?? undefined,
  });

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
