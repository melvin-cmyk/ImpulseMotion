"use client";

import { useState, useEffect } from "react";
import type { WowMetrics } from "./creative-types";

export interface WowPeriodSummary {
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  cpa: number | null;
  ctr: number | null;
  cpm: number | null;
  /** null when revenue is unknown for the account */
  roas: number | null;
  roasEstimated: boolean;
  hookRate: number | null;
  adCount: number;
}

export interface WowData {
  wowByAdId: Record<string, WowMetrics>;
  aggregateWow: WowMetrics;
  currentPeriod: { since: string; until: string };
  prevPeriod: { since: string; until: string };
  current?: WowPeriodSummary;
  previous?: WowPeriodSummary;
  meta?: {
    currency: string | null;
    timezone: string | null;
    conversionEvent: string;
    fetchedAt: string;
    truncated: boolean;
  };
}

interface UseWowOptions {
  metaAccountId?: string | null;
  /** Only fetch when user has real Meta data */
  enabled?: boolean;
  /** Selected range: the WoW window is the 7 full days ending at `until`. */
  since?: string;
  until?: string;
  /** Bump to refetch */
  nonce?: number;
}

interface UseWowResult {
  wowData: WowData | null;
  loading: boolean;
  error: string | null;
}

export function useWow({ metaAccountId, enabled = true, since, until, nonce = 0 }: UseWowOptions = {}): UseWowResult {
  const [wowData, setWowData] = useState<WowData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled || !metaAccountId) {
      setWowData(null);
      return;
    }

    const controller = new AbortController();
    let cancelled = false;

    async function fetchWow() {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({ accountId: metaAccountId as string });
        if (since) params.set("since", since);
        if (until) params.set("until", until);
        const res = await fetch(`/api/meta/wow?${params.toString()}`, { signal: controller.signal });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Failed to fetch WoW data");
        if (!cancelled) setWowData(data as WowData);
      } catch (err) {
        if (cancelled || (err instanceof DOMException && err.name === "AbortError")) return;
        setError(err instanceof Error ? err.message : "Unknown error");
        setWowData(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchWow();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [metaAccountId, enabled, since, until, nonce]);

  return { wowData, loading, error };
}
