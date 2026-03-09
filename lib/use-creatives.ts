"use client";

import { useState, useEffect } from "react";
import { Creative, mockCreatives } from "./mock-data";

interface UseCreativesOptions {
  /** If provided, fetch real data for this account ID */
  metaAccountId?: string | null;
  tiktokAccountId?: string | null;
  /** Whether the user has configured real accounts */
  isConnected?: boolean;
}

interface UseCreativesResult {
  creatives: Creative[];
  loading: boolean;
  error: string | null;
  isRealData: boolean;
}

export function useCreatives({
  metaAccountId,
  tiktokAccountId,
  isConnected = false,
}: UseCreativesOptions = {}): UseCreativesResult {
  const [creatives, setCreatives] = useState<Creative[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isRealData, setIsRealData] = useState(false);

  useEffect(() => {
    if (!isConnected || (!metaAccountId && !tiktokAccountId)) {
      setCreatives(mockCreatives);
      setLoading(false);
      setIsRealData(false);
      return;
    }

    async function fetchAll() {
      setLoading(true);
      setError(null);

      const fetches: Promise<Creative[]>[] = [];

      if (metaAccountId) {
        fetches.push(
          fetch(`/api/meta/creatives?accountId=${encodeURIComponent(metaAccountId)}`)
            .then((r) => r.json())
            .then((data) => {
              if (Array.isArray(data)) return data as Creative[];
              throw new Error(data.error ?? "Failed to fetch Meta creatives");
            })
        );
      }

      if (tiktokAccountId) {
        fetches.push(
          fetch(`/api/tiktok/creatives?accountId=${encodeURIComponent(tiktokAccountId)}`)
            .then((r) => r.json())
            .then((data) => {
              if (Array.isArray(data)) return data as Creative[];
              throw new Error(data.error ?? "Failed to fetch TikTok creatives");
            })
        );
      }

      try {
        const results = await Promise.allSettled(fetches);
        const all: Creative[] = [];
        const errors: string[] = [];

        for (const result of results) {
          if (result.status === "fulfilled") {
            all.push(...result.value);
          } else {
            errors.push(result.reason?.message ?? "Unknown error");
          }
        }

        if (all.length === 0 && errors.length > 0) {
          setError(errors.join("; "));
          setCreatives(mockCreatives);
          setIsRealData(false);
        } else {
          setCreatives(all.length > 0 ? all : mockCreatives);
          setIsRealData(all.length > 0);
          if (errors.length > 0) {
            setError(`Partial error: ${errors.join("; ")}`);
          }
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unknown error");
        setCreatives(mockCreatives);
        setIsRealData(false);
      } finally {
        setLoading(false);
      }
    }

    fetchAll();
  }, [metaAccountId, tiktokAccountId, isConnected]);

  return { creatives, loading, error, isRealData };
}
