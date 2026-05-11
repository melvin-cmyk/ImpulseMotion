"use client";

import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { Building2, ChevronDown, Search, AlertCircle, TrendingUp, TrendingDown, Command } from "lucide-react";
import { useCreativesContext } from "@/lib/creatives-context";

interface PreviewAccount {
  id: string;
  name: string;
  currency?: string;
  outOfScope: boolean;
  spend7d: number;
  roas7d: number;
  alertCount: number;
}

// Cache is keyed by userId so a list built for one user (e.g. admin) can never
// be served to another user after a sign-out/sign-in in the same tab.
const CACHE_PREFIX = "impulse_meta_accounts_preview_v2:";
const CACHE_TTL_MS = 5 * 60 * 1000;
const SELECTION_KEY = "impulse_meta_account";

function cacheKey(userId: string | null): string {
  return `${CACHE_PREFIX}${userId ?? "anon"}`;
}

function readCache(userId: string | null): PreviewAccount[] | null {
  try {
    const raw = sessionStorage.getItem(cacheKey(userId));
    if (!raw) return null;
    const { t, data } = JSON.parse(raw) as { t: number; data: PreviewAccount[] };
    if (Date.now() - t > CACHE_TTL_MS) return null;
    return data;
  } catch {
    return null;
  }
}

function writeCache(userId: string | null, data: PreviewAccount[]) {
  try {
    sessionStorage.setItem(cacheKey(userId), JSON.stringify({ t: Date.now(), data }));
  } catch { /* quota exceeded etc. — ignore */ }
}

function fmtMoney(n: number): string {
  if (n === 0) return "—";
  return new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(n);
}

export function AccountPicker({ userId }: { userId: string | null }) {
  const { refetch } = useCreativesContext();
  const [open, setOpen] = useState(false);
  const [accounts, setAccounts] = useState<PreviewAccount[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<string>("");
  const [selectedName, setSelectedName] = useState<string>("");
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Restore current selection from localStorage
  useEffect(() => {
    const stored = localStorage.getItem(SELECTION_KEY);
    if (stored) {
      try {
        const data = JSON.parse(stored);
        setSelectedId(data.accountId ?? "");
        setSelectedName(data.accountName ?? "");
      } catch { /* malformed — ignore */ }
    }
  }, []);

  const loadAccounts = useCallback(async (useCache = true): Promise<PreviewAccount[]> => {
    if (useCache) {
      const cached = readCache(userId);
      if (cached && cached.length > 0) {
        setAccounts(cached);
        return cached;
      }
    }
    setLoading(true);
    try {
      const res = await fetch("/api/me/accounts/preview");
      if (!res.ok) return [];
      const data = (await res.json()) as { accounts: PreviewAccount[] };
      setAccounts(data.accounts);
      writeCache(userId, data.accounts);
      return data.accounts;
    } catch {
      return [];
    } finally {
      setLoading(false);
    }
  }, [userId]);

  // Initial load to feed reconciliation (auto-select on fresh login)
  useEffect(() => {
    loadAccounts().then((data) => {
      if (data.length === 0) return;
      const normalize = (id: string) => id.replace(/^act_/, "");
      const storedId = (() => {
        try {
          const raw = localStorage.getItem(SELECTION_KEY);
          return raw ? JSON.parse(raw).accountId : "";
        } catch {
          return "";
        }
      })();
      const isAllowed = storedId
        ? data.some((a) => normalize(a.id) === normalize(storedId) && !a.outOfScope)
        : false;
      if (!isAllowed) {
        const first = data.find((a) => !a.outOfScope) ?? data[0];
        if (!first) return;
        setSelectedId(first.id);
        setSelectedName(first.name);
        localStorage.setItem(SELECTION_KEY, JSON.stringify({ accountId: first.id, accountName: first.name }));
        refetch();
      }
    });
  }, [loadAccounts, refetch]);

  // Cmd+K / Ctrl+K opens picker globally
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      } else if (e.key === "Escape" && open) {
        setOpen(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // Focus search on open, reset query
  useEffect(() => {
    if (open) {
      setQuery("");
      setHighlight(0);
      setTimeout(() => inputRef.current?.focus(), 0);
      // Refresh data when opening if cache is stale
      loadAccounts();
    }
  }, [open, loadAccounts]);

  const filtered = useMemo(() => {
    if (!query.trim()) return accounts;
    const q = query.toLowerCase();
    return accounts.filter(
      (a) => a.name.toLowerCase().includes(q) || a.id.includes(q),
    );
  }, [accounts, query]);

  function handleSelect(a: PreviewAccount) {
    if (a.outOfScope) return;
    setSelectedId(a.id);
    setSelectedName(a.name);
    localStorage.setItem(SELECTION_KEY, JSON.stringify({ accountId: a.id, accountName: a.name }));
    setOpen(false);
    refetch();
  }

  function handleKey(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const a = filtered[highlight];
      if (a) handleSelect(a);
    }
  }

  const displayName = selectedName || selectedId || "Sélectionner un compte";

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 text-sm text-gray-300 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-lg px-3 py-1.5 transition-colors"
      >
        <Building2 className="w-3.5 h-3.5 text-violet-400 shrink-0" />
        <span className="max-w-[200px] truncate">{displayName}</span>
        <kbd className="hidden md:inline-flex items-center gap-0.5 text-[10px] text-gray-500 bg-gray-900 border border-gray-800 rounded px-1 py-0.5 ml-1">
          <Command className="w-2.5 h-2.5" />K
        </kbd>
        <ChevronDown className="w-3.5 h-3.5 text-gray-500 shrink-0" />
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center p-4 pt-[10vh] bg-black/60 backdrop-blur-sm"
          onClick={() => setOpen(false)}
        >
          <div
            className="w-full max-w-2xl bg-gray-950 border border-gray-800 rounded-2xl shadow-2xl overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-800">
              <Search className="w-4 h-4 text-gray-500 shrink-0" />
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setHighlight(0);
                }}
                onKeyDown={handleKey}
                placeholder="Rechercher un compte…"
                className="flex-1 bg-transparent outline-none text-sm text-white placeholder:text-gray-500"
              />
              <span className="text-xs text-gray-600">{filtered.length} compte{filtered.length > 1 ? "s" : ""}</span>
            </div>

            <div className="max-h-[60vh] overflow-y-auto">
              {loading && accounts.length === 0 ? (
                <div className="px-4 py-12 text-center text-sm text-gray-500">Chargement…</div>
              ) : filtered.length === 0 ? (
                <div className="px-4 py-12 text-center text-sm text-gray-500">
                  Aucun compte ne correspond à "{query}".
                </div>
              ) : (
                <ul>
                  {filtered.map((a, i) => {
                    const active = i === highlight;
                    const isCurrent = a.id.replace(/^act_/, "") === selectedId.replace(/^act_/, "");
                    return (
                      <li key={a.id}>
                        <button
                          onClick={() => handleSelect(a)}
                          onMouseEnter={() => setHighlight(i)}
                          disabled={a.outOfScope}
                          className={`w-full text-left px-4 py-3 flex items-center gap-3 transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                            active ? "bg-violet-500/10" : ""
                          }`}
                        >
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className={`text-sm font-medium truncate ${isCurrent ? "text-violet-300" : "text-white"}`}>
                                {a.name}
                              </span>
                              {isCurrent && <span className="w-1.5 h-1.5 rounded-full bg-violet-400 shrink-0" />}
                              {a.outOfScope && (
                                <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-900/40 text-amber-300 shrink-0">hors BM</span>
                              )}
                              {a.alertCount > 0 && (
                                <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 shrink-0">
                                  <AlertCircle className="w-2.5 h-2.5" />
                                  {a.alertCount}
                                </span>
                              )}
                            </div>
                            <div className="text-xs text-gray-500 mt-0.5 truncate">{a.id}</div>
                          </div>
                          <div className="flex items-center gap-4 shrink-0 text-xs">
                            <div className="text-right">
                              <div className="text-gray-400">Spend 7j</div>
                              <div className="font-semibold text-white">{fmtMoney(a.spend7d)}</div>
                            </div>
                            <div className="text-right">
                              <div className="text-gray-400">ROAS</div>
                              <div className={`font-semibold inline-flex items-center gap-1 ${
                                a.roas7d === 0 ? "text-gray-600" : a.roas7d >= 2 ? "text-emerald-400" : "text-amber-400"
                              }`}>
                                {a.roas7d > 0 && (a.roas7d >= 2 ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />)}
                                {a.roas7d > 0 ? `${a.roas7d.toFixed(2)}x` : "—"}
                              </div>
                            </div>
                          </div>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            <div className="flex items-center justify-between px-4 py-2 border-t border-gray-800 text-[11px] text-gray-500">
              <div className="flex items-center gap-3">
                <span><kbd className="px-1 py-0.5 rounded bg-gray-800 text-gray-400">↑↓</kbd> naviguer</span>
                <span><kbd className="px-1 py-0.5 rounded bg-gray-800 text-gray-400">↵</kbd> sélectionner</span>
                <span><kbd className="px-1 py-0.5 rounded bg-gray-800 text-gray-400">esc</kbd> fermer</span>
              </div>
              <span>Trié par alertes puis spend 7j</span>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
