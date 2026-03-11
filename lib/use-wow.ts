"use client";

import { useState, useEffect } from "react";
import { WowMetrics } from "./mock-data";

export interface WowData {
  wowByAdId: Record<string, WowMetrics>;
  aggregateWow: WowMetrics;
  currentPeriod: { since: string; until: string };
  prevPeriod: { since: string; until: string };
}

interface UseWowOptions {
  metaAccountId?: string | null;
  /** Only fetch when user has real Meta data */
  enabled?: boolean;
}

interface UseWowResult {
  wowData: WowData | null;
  loading: boolean;
  error: string | null;
}

export function useWow({ metaAccountId, enabled = true }: UseWowOptions = {}): UseWowResult {
  const [wowData, setWowData] = useState<WowData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled || !metaAccountId) {
      setWowData(null);
      return;
    }

    let cancelled = false;

    async function fetchWow() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(
          `/api/meta/wow?accountId=${encodeURIComponent(metaAccountId as string)}`
        );
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Failed to fetch WoW data");
        if (!cancelled) setWowData(data as WowData);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Unknown error");
          setWowData(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchWow();
    return () => { cancelled = true; };
  }, [metaAccountId, enabled]);

  return { wowData, loading, error };
}
