"use client";

/**
 * Selected Meta account of the staff surfaces (Analyse Ads v2, ⌘K, account
 * picker). The selection lives in localStorage so it survives navigation and
 * reloads; every provider re-reads it on `storage` / ACCOUNT_CHANGE_EVENT.
 * Deep links `?accountId=act_…` select the account when the viewer may see it.
 * (The live creatives fetch of the former Analyse Ads pages is gone: the
 * warehouse serves /analyse.)
 */

import { createContext, useContext, useEffect, useSyncExternalStore } from "react";

/** localStorage key shared with components/account-picker.tsx */
export const META_ACCOUNT_STORAGE_KEY = "impulse_meta_account";
/** Dispatched on `window` to re-read the stored selection (picker, deep link). */
export const ACCOUNT_CHANGE_EVENT = "impulse:account-change";

interface CreativesContextValue {
  /** Selected Meta ad account id (act_…), null when none is selected */
  metaAccountId: string | null;
  /** Display name stored with the selection (null when unknown). */
  metaAccountName: string | null;
}

const CreativesContext = createContext<CreativesContextValue | null>(null);

const normalizeAct = (id: string) => id.replace(/^act_/, "");

function readStoredAccount(): string | null {
  try {
    const raw = localStorage.getItem(META_ACCOUNT_STORAGE_KEY);
    if (!raw) return null;
    const id = JSON.parse(raw)?.accountId;
    return typeof id === "string" && id ? id : null;
  } catch {
    return null;
  }
}

/** Display name stored with the selection (null when nothing is selected). */
export function readStoredMetaAccountName(): string | null {
  try {
    const raw = localStorage.getItem(META_ACCOUNT_STORAGE_KEY);
    const name = raw ? JSON.parse(raw)?.accountName : null;
    return typeof name === "string" && name ? name : null;
  } catch {
    return null;
  }
}

function subscribeAccounts(callback: () => void): () => void {
  window.addEventListener("storage", callback);
  window.addEventListener(ACCOUNT_CHANGE_EVENT, callback);
  return () => {
    window.removeEventListener("storage", callback);
    window.removeEventListener(ACCOUNT_CHANGE_EVENT, callback);
  };
}
const readNone = () => null;

/** Notifies every provider that the stored selection changed. */
export function notifyAccountChange(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(ACCOUNT_CHANGE_EVENT));
}

/** Persists the analysed Meta account (picker / ⌘K / deep link) and notifies. */
export function setStoredMetaAccount(accountId: string, accountName: string): void {
  const id = accountId.startsWith("act_") ? accountId : `act_${accountId}`;
  try {
    localStorage.setItem(META_ACCOUNT_STORAGE_KEY, JSON.stringify({ accountId: id, accountName }));
  } catch {
    /* storage unavailable: the selection just does not persist */
  }
  notifyAccountChange();
}

export function CreativesProvider({ children }: { children: React.ReactNode }) {
  const metaAccountId = useSyncExternalStore(subscribeAccounts, readStoredAccount, readNone);
  const metaAccountName = useSyncExternalStore(subscribeAccounts, readStoredMetaAccountName, readNone);

  // Deep links from the cockpit / clients list: `?accountId=act_…` selects the
  // account (when allowed for this user), persists it and is stripped from the URL.
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
          if (match) { allowed = true; name = match.name ?? ""; }
        }
      } catch { allowed = false; }
      if (cancelled) return;
      url.searchParams.delete("accountId");
      const clean = `${url.pathname}${url.search}${url.hash}`;
      if (allowed) setStoredMetaAccount(wanted, name);
      window.history.replaceState(window.history.state, "", clean);
    })();
    return () => { cancelled = true; };
  }, []);

  return <CreativesContext.Provider value={{ metaAccountId, metaAccountName }}>{children}</CreativesContext.Provider>;
}

export function useCreativesContext(): CreativesContextValue {
  const ctx = useContext(CreativesContext);
  if (!ctx) throw new Error("useCreativesContext must be used within CreativesProvider");
  return ctx;
}
