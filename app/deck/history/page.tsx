"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Clock, ChevronRight, Trash2 } from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────

interface SlideSnapshot {
  id: string;
  label?: string;
  title?: string;
}

interface HistoryEntry {
  id: string;
  clientId: string;
  clientName: string;
  platform: string;
  period: string;
  startDate: string;
  endDate: string;
  slides: SlideSnapshot[];
  createdAt: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("fr-FR", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function groupByClient(entries: HistoryEntry[]): Map<string, HistoryEntry[]> {
  const map = new Map<string, HistoryEntry[]>();
  for (const entry of entries) {
    const list = map.get(entry.clientId) ?? [];
    list.push(entry);
    map.set(entry.clientId, list);
  }
  return map;
}

// ── Sub-components ────────────────────────────────────────────────────────────

interface EntryCardProps {
  entry: HistoryEntry;
  onLoad: (id: string) => void;
}

function EntryCard({ entry, onLoad }: EntryCardProps) {
  const firstTitle =
    entry.slides[0]?.title ?? entry.slides[0]?.label ?? "—";

  return (
    <div className="flex items-center justify-between gap-4 rounded-xl border border-[#1E293B] bg-[#0F172A] px-5 py-4 transition-colors hover:border-[#6366F1]/40">
      {/* Left info */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 mb-1">
          <Clock className="w-3.5 h-3.5 text-[#6366F1] flex-shrink-0" />
          <span className="text-xs text-slate-400">{formatDate(entry.createdAt)}</span>
          {entry.period && (
            <span className="ml-1 rounded-full bg-[#6366F1]/10 border border-[#6366F1]/20 px-2 py-0.5 text-[10px] text-[#6366F1] font-medium">
              {entry.period}
            </span>
          )}
        </div>
        <p className="text-sm text-slate-200 font-medium truncate">{firstTitle}</p>
        <p className="text-xs text-slate-500 mt-0.5">
          {entry.slides.length} slide{entry.slides.length !== 1 ? "s" : ""} &middot; {entry.platform}
        </p>
      </div>

      {/* Action */}
      <button
        onClick={() => onLoad(entry.id)}
        className="flex items-center gap-1 rounded-lg bg-[#6366F1] px-3 py-1.5 text-xs font-semibold text-white transition-opacity hover:opacity-90 flex-shrink-0"
      >
        Charger
        <ChevronRight className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function DeckHistoryPage() {
  const router = useRouter();

  const [clientId, setClientId] = useState("");
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);

  const fetchHistory = useCallback(async (id: string) => {
    if (!id.trim()) return;
    setLoading(true);
    setError(null);
    setSearched(false);
    try {
      const res = await fetch(`/api/deck/history?clientId=${encodeURIComponent(id.trim())}&limit=50`);
      if (!res.ok) {
        const json = (await res.json()) as { error?: string };
        throw new Error(json.error ?? `HTTP ${res.status}`);
      }
      const json = (await res.json()) as { entries: HistoryEntry[] };
      setEntries(json.entries ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
      setSearched(true);
    }
  }, []);

  const handleLoad = useCallback((id: string) => {
    router.push(`/deck?historyId=${encodeURIComponent(id)}`);
  }, [router]);

  const grouped = groupByClient(entries);

  return (
    <div className="min-h-screen bg-[#0F172A] text-slate-100 p-6 md:p-10">
      {/* Top nav */}
      <div className="mb-8">
        <a
          href="/deck"
          className="inline-flex items-center gap-1 text-xs text-slate-400 hover:text-slate-200 transition-colors"
        >
          ← Retour au deck
        </a>
      </div>

      {/* Header */}
      <div className="mb-8">
        <h1 className="text-2xl font-extrabold text-white">Historique des decks</h1>
        <p className="text-sm text-slate-400 mt-1">
          Retrouvez et rechargez les decks générés précédemment par client.
        </p>
      </div>

      {/* Search */}
      <div className="mb-8 flex gap-3">
        <input
          type="text"
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void fetchHistory(clientId); }}
          placeholder="ID client (ex: act_123456789)"
          className="flex-1 max-w-sm rounded-xl border border-[#1E293B] bg-[#1E293B] px-4 py-2.5 text-sm text-slate-100 placeholder-slate-500 outline-none focus:border-[#6366F1] transition-colors"
        />
        <button
          onClick={() => void fetchHistory(clientId)}
          disabled={loading || !clientId.trim()}
          className="rounded-xl bg-[#6366F1] px-5 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : "Rechercher"}
        </button>
      </div>

      {/* Error */}
      {error && (
        <div className="mb-6 rounded-xl border border-red-500/30 bg-red-500/10 px-5 py-4 text-sm text-red-400">
          {error}
        </div>
      )}

      {/* Results */}
      {searched && !loading && entries.length === 0 && (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <p className="text-slate-400 text-base mb-2">
            Aucun deck généré pour l&apos;instant — génère ton premier deck !
          </p>
          <a
            href="/deck"
            className="mt-4 inline-flex items-center gap-2 rounded-xl bg-[#6366F1] px-5 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90"
          >
            Créer un deck
          </a>
        </div>
      )}

      {grouped.size > 0 && (
        <div className="space-y-10">
          {Array.from(grouped.entries()).map(([cId, clientEntries]) => {
            const clientName = clientEntries[0]?.clientName ?? cId;
            return (
              <section key={cId}>
                <h2 className="text-base font-bold text-slate-100 mb-4 border-b border-[#1E293B] pb-2">
                  {clientName}
                  <span className="ml-2 text-xs font-normal text-slate-500">
                    ({clientEntries.length} deck{clientEntries.length !== 1 ? "s" : ""})
                  </span>
                </h2>
                <div className="space-y-3">
                  {clientEntries.map((entry) => (
                    <EntryCard key={entry.id} entry={entry} onLoad={handleLoad} />
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
