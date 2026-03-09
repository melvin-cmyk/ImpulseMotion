"use client";

import { createContext, useContext, useEffect, useState, useCallback } from "react";
import { Creative } from "./mock-data";
import { useCreatives } from "./use-creatives";

interface CreativesContextValue {
  creatives: Creative[];
  isLoading: boolean;
  isRealData: boolean;
  error: string | null;
  refetch: () => void;
}

const CreativesContext = createContext<CreativesContextValue | null>(null);

export function CreativesProvider({ children }: { children: React.ReactNode }) {
  const [metaAccountId, setMetaAccountId] = useState<string | null>(null);
  const [tiktokAccountId, setTiktokAccountId] = useState<string | null>(null);
  const [fetchKey, setFetchKey] = useState(0);

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
  });

  const refetch = useCallback(() => {
    setFetchKey((k) => k + 1);
  }, []);

  return (
    <CreativesContext.Provider
      value={{ creatives, isLoading: loading, isRealData, error, refetch }}
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
