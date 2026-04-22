"use client";

import { useEffect, useState } from "react";
import { ChevronDown, Building2 } from "lucide-react";
import { useCreativesContext } from "@/lib/creatives-context";

interface AdAccount {
  id: string;
  name: string;
  currency?: string;
}

// sessionStorage cache so full page reloads on many routes don't each
// hit /me/adaccounts — Meta rate-limits aggressively when a System User
// fans this out across many concurrent page loads.
const CACHE_KEY = "impulse_meta_accounts_cache_v1";
const CACHE_TTL_MS = 10 * 60 * 1000;

function readCache(): AdAccount[] | null {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const { t, data } = JSON.parse(raw) as { t: number; data: AdAccount[] };
    if (Date.now() - t > CACHE_TTL_MS) return null;
    return data;
  } catch {
    return null;
  }
}

function writeCache(data: AdAccount[]) {
  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify({ t: Date.now(), data }));
  } catch {}
}

async function fetchAccounts(): Promise<AdAccount[] | null> {
  // One retry on 5xx — Meta /me/adaccounts flaps under load.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch("/api/meta/accounts");
      if (res.ok) return await res.json();
      if (res.status < 500) return null;
    } catch {
      // network error — retry
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return null;
}

export function AccountSwitcher() {
  const { refetch } = useCreativesContext();
  const [accounts, setAccounts] = useState<AdAccount[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [selectedName, setSelectedName] = useState<string>("");
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let storedId = "";
    const stored = localStorage.getItem("impulse_meta_account");
    if (stored) {
      try {
        const data = JSON.parse(stored);
        storedId = data.accountId ?? "";
        setSelectedId(storedId);
        setSelectedName(data.accountName ?? "");
      } catch {}
    }

    function reconcile(data: AdAccount[]) {
      setAccounts(data);
      // If the stored selection isn't allowed (or nothing was stored), auto-select
      // the first allowed account so data loads without manual picker interaction.
      const normalize = (id: string) => id.replace(/^act_/, "");
      const isAllowed = storedId
        ? data.some((a) => normalize(a.id) === normalize(storedId))
        : false;
      if (!isAllowed) {
        const first = data[0];
        setSelectedId(first.id);
        setSelectedName(first.name);
        localStorage.setItem(
          "impulse_meta_account",
          JSON.stringify({ accountId: first.id, accountName: first.name })
        );
        refetch();
      }
    }

    const cached = readCache();
    if (cached && cached.length > 0) {
      reconcile(cached);
      return;
    }

    fetchAccounts().then((data) => {
      if (!data || data.length === 0) return;
      writeCache(data);
      reconcile(data);
    });
  }, [refetch]);

  if (!selectedId && accounts.length === 0) return null;

  function handleSelect(account: AdAccount) {
    setSelectedId(account.id);
    setSelectedName(account.name);
    localStorage.setItem(
      "impulse_meta_account",
      JSON.stringify({ accountId: account.id, accountName: account.name })
    );
    setOpen(false);
    refetch();
  }

  const displayName = selectedName || selectedId || "Compte";

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 text-sm text-gray-300 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-lg px-3 py-1.5 transition-colors"
      >
        <Building2 className="w-3.5 h-3.5 text-violet-400 shrink-0" />
        <span className="max-w-[160px] truncate">{displayName}</span>
        <ChevronDown className="w-3.5 h-3.5 text-gray-500 shrink-0" />
      </button>

      {open && accounts.length > 0 && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setOpen(false)}
          />
          <div className="absolute left-0 top-full mt-1 z-50 min-w-[220px] bg-gray-900 border border-gray-700 rounded-xl shadow-xl overflow-hidden">
            <div className="px-3 py-2 text-xs text-gray-500 border-b border-gray-800">
              Changer de compte Meta
            </div>
            {accounts.map((account) => (
              <button
                key={account.id}
                onClick={() => handleSelect(account)}
                className={`w-full text-left px-3 py-2.5 text-sm flex items-center gap-2 hover:bg-gray-800 transition-colors ${
                  account.id === selectedId ? "text-violet-400 bg-gray-800/50" : "text-gray-300"
                }`}
              >
                <span className="flex-1 truncate">{account.name}</span>
                {account.currency && (
                  <span className="text-xs text-gray-500 shrink-0">{account.currency}</span>
                )}
                {account.id === selectedId && (
                  <span className="w-1.5 h-1.5 rounded-full bg-violet-400 shrink-0" />
                )}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
