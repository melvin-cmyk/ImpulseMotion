"use client";

import { useEffect, useState } from "react";
import { ChevronDown, Building2 } from "lucide-react";
import { useCreativesContext } from "@/lib/creatives-context";

interface AdAccount {
  id: string;
  name: string;
  currency?: string;
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

    fetch("/api/meta/accounts")
      .then((r) => (r.ok ? r.json() : null))
      .then((data: AdAccount[] | null) => {
        if (!data || data.length === 0) return;
        setAccounts(data);

        // Reconcile stored selection against the ACL-filtered list.
        // If the stored account isn't allowed (or nothing was stored), auto-select
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
      })
      .catch(() => {});
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
