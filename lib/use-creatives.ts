"use client";

import { useState, useEffect, type MutableRefObject } from "react";
import type { Creative, CreativesMeta } from "./creative-types";
import { mockCreatives } from "./mock-data";

interface UseCreativesOptions {
  /** If provided, fetch real data for this account ID */
  metaAccountId?: string | null;
  tiktokAccountId?: string | null;
  /** Whether the user has configured real accounts (mocks are shown ONLY when false) */
  isConnected?: boolean;
  /** Date range filter (YYYY-MM-DD) — forwarded to the Meta API */
  since?: string;
  until?: string;
  /** Meta campaign ID filter */
  campaignId?: string;
  /** Bump to refetch */
  nonce?: number;
  /** When `.current` is true at fetch time, the Meta cache is bypassed (`refresh=1`); reset after reading. */
  refreshRef?: MutableRefObject<boolean>;
}

interface UseCreativesResult {
  creatives: Creative[];
  loading: boolean;
  error: string | null;
  /** True when the list comes from a connected account (even when empty). */
  isRealData: boolean;
  /** Meta provenance / freshness (null in demo mode or before the first response). */
  meta: CreativesMeta | null;
}

type MetaPayload = { creatives: Creative[]; meta: CreativesMeta } | Creative[] | { error?: string };

interface FetchResult {
  /** Request the result belongs to — a result for another key is stale and ignored. */
  key: string;
  creatives: Creative[];
  meta: CreativesMeta | null;
  error: string | null;
}

const EMPTY: Creative[] = [];

/**
 * Real creatives for the selected accounts / range. State is keyed by the
 * request so a change of account, range or campaign immediately yields
 * `[]` + loading (no stale list, no setState inside the effect body); the
 * in-flight request is aborted.
 */
export function useCreatives({
  metaAccountId,
  tiktokAccountId,
  isConnected = false,
  since,
  until,
  campaignId,
  nonce = 0,
  refreshRef,
}: UseCreativesOptions = {}): UseCreativesResult {
  const demo = !isConnected || (!metaAccountId && !tiktokAccountId);
  const key = JSON.stringify({ metaAccountId, tiktokAccountId, since, until, campaignId, nonce });
  const [result, setResult] = useState<FetchResult | null>(null);

  useEffect(() => {
    if (demo) return;

    const controller = new AbortController();
    let cancelled = false;
    const refresh = refreshRef?.current === true;
    if (refreshRef) refreshRef.current = false;

    async function fetchAll(): Promise<FetchResult> {
      const fetches: Promise<{ creatives: Creative[]; meta: CreativesMeta | null }>[] = [];

      if (metaAccountId) {
        const params = new URLSearchParams({ accountId: metaAccountId });
        if (since) params.set("since", since);
        if (until) params.set("until", until);
        if (campaignId) params.set("campaignId", campaignId);
        if (refresh) params.set("refresh", "1");
        fetches.push(
          fetch(`/api/meta/creatives?${params.toString()}`, { signal: controller.signal })
            .then(async (r) => {
              const data = (await r.json()) as MetaPayload;
              if (Array.isArray(data)) return { creatives: data, meta: null };
              if ("creatives" in data && Array.isArray(data.creatives)) return { creatives: data.creatives, meta: data.meta ?? null };
              throw new Error((data as { error?: string }).error ?? `Meta creatives HTTP ${r.status}`);
            }),
        );
      }

      if (tiktokAccountId) {
        fetches.push(
          fetch(`/api/tiktok/creatives?accountId=${encodeURIComponent(tiktokAccountId)}`, { signal: controller.signal })
            .then(async (r) => {
              const data = (await r.json()) as Creative[] | { error?: string };
              if (Array.isArray(data)) return { creatives: data, meta: null };
              throw new Error(data.error ?? `TikTok creatives HTTP ${r.status}`);
            }),
        );
      }

      const results = await Promise.allSettled(fetches);
      const all: Creative[] = [];
      const errors: string[] = [];
      let meta: CreativesMeta | null = null;
      for (const r of results) {
        if (r.status === "fulfilled") {
          all.push(...r.value.creatives);
          if (r.value.meta) meta = r.value.meta;
        } else if (!(r.reason instanceof DOMException && r.reason.name === "AbortError")) {
          errors.push(r.reason?.message ?? "Unknown error");
        }
      }
      const error = errors.length > 0 ? (all.length > 0 ? `Erreur partielle : ${errors.join("; ")}` : errors.join("; ")) : null;
      return { key, creatives: all, meta, error };
    }

    fetchAll()
      .then((res) => {
        if (!cancelled) setResult(res);
      })
      .catch((err) => {
        if (cancelled) return;
        setResult({ key, creatives: [], meta: null, error: err instanceof Error ? err.message : "Unknown error" });
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [demo, key, metaAccountId, tiktokAccountId, since, until, campaignId, refreshRef]);

  if (demo) {
    return { creatives: mockCreatives, loading: false, error: null, isRealData: false, meta: null };
  }

  const current = result && result.key === key ? result : null;
  return {
    creatives: current?.creatives ?? EMPTY,
    loading: current === null,
    error: current?.error ?? null,
    isRealData: true,
    meta: current?.meta ?? null,
  };
}
