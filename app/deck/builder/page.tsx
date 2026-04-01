"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Presentation, ChevronRight, CheckSquare, Square, Clock, ExternalLink } from "lucide-react";
import { getAvailablePeriods, type DeckPeriod } from "@/lib/deck-data";
import type { DeckClientResult } from "@/app/api/deck/clients/route";
import type { DeckHistoryEntry } from "@/lib/deck-history-storage";

const SECTIONS = [
  { id: "global", label: "Vue globale (highlights, tableau, NC)" },
  { id: "google", label: "Google Ads (KPIs, campagnes, insights, next steps)" },
  { id: "meta", label: "Meta Ads (KPIs, campagnes, créatives, insights, next steps)" },
  { id: "budget", label: "Budget prévisionnel" },
  { id: "learnings", label: "Learnings & recommandations globales" },
];

export default function DeckBuilderPage() {
  const router = useRouter();
  const [clients, setClients] = useState<DeckClientResult[]>([]);
  const [loadingClients, setLoadingClients] = useState(true);
  const [selectedClientId, setSelectedClientId] = useState("");
  const [selectedPeriod, setSelectedPeriod] = useState("");
  const [enabledSections, setEnabledSections] = useState<Set<string>>(
    new Set(SECTIONS.map((s) => s.id))
  );
  const [context, setContext] = useState("");
  const [budgetMeta, setBudgetMeta] = useState("");
  const [budgetGoogle, setBudgetGoogle] = useState("");
  const [history, setHistory] = useState<DeckHistoryEntry[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);

  const periods = getAvailablePeriods();

  useEffect(() => {
    fetch("/api/deck/clients")
      .then((r) => r.json())
      .then((d) => {
        setClients(d.clients || []);
        if (d.clients?.length > 0) setSelectedClientId(d.clients[0].id);
      })
      .catch(() => setClients([]))
      .finally(() => setLoadingClients(false));

    if (periods.length > 1) setSelectedPeriod(periods[1].month);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Reload history when selected client changes
  useEffect(() => {
    if (!selectedClientId) { setHistory([]); return; }
    setLoadingHistory(true);
    fetch(`/api/deck/history?clientId=${encodeURIComponent(selectedClientId)}&limit=12`)
      .then((r) => r.json())
      .then((d) => setHistory(d.entries || []))
      .catch(() => setHistory([]))
      .finally(() => setLoadingHistory(false));
  }, [selectedClientId]);

  function toggleSection(id: string) {
    setEnabledSections((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function handleGenerate() {
    if (!selectedClientId || !selectedPeriod) return;

    const client = clients.find((c) => c.id === selectedClientId);
    if (!client) return;

    const params = new URLSearchParams({
      client: selectedClientId,
      period: selectedPeriod,
      sections: Array.from(enabledSections).join(","),
    });

    if (context.trim()) params.set("context", context.trim());

    // Encode budget in URL if specified
    const budgets: Record<string, string> = {};
    if (budgetMeta.trim()) budgets.meta = budgetMeta.trim();
    if (budgetGoogle.trim()) budgets.google = budgetGoogle.trim();
    if (Object.keys(budgets).length > 0) params.set("budgets", JSON.stringify(budgets));

    params.set("mode", "ai");
    router.push(`/deck?${params.toString()}`);
  }

  const selectedClient = clients.find((c) => c.id === selectedClientId);
  const platformHint = selectedClient?.platform === "google"
    ? "Google Ads uniquement"
    : selectedClient?.platform === "meta"
    ? "Meta Ads uniquement"
    : selectedClient?.platform === "both"
    ? "Meta Ads + Google Ads"
    : null;

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <div className="max-w-2xl mx-auto px-4 py-12">
        {/* Header */}
        <div className="flex items-center gap-3 mb-10">
          <div className="w-10 h-10 bg-blue-600 rounded-xl flex items-center justify-center">
            <Presentation className="w-5 h-5" />
          </div>
          <div>
            <h1 className="text-xl font-bold">Deck Builder</h1>
            <p className="text-sm text-gray-400">Configure ton rapport avant génération</p>
          </div>
        </div>

        <div className="space-y-6">
          {/* Client selection */}
          <div className="bg-gray-900 rounded-2xl p-6 border border-gray-800">
            <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wider mb-4">Client</h2>
            {loadingClients ? (
              <div className="flex items-center gap-2 text-gray-400">
                <Loader2 className="w-4 h-4 animate-spin" />
                <span className="text-sm">Chargement des comptes...</span>
              </div>
            ) : clients.length === 0 ? (
              <p className="text-sm text-gray-500">Aucun compte trouvé. Vérifie ta connexion Meta Ads.</p>
            ) : (
              <div className="space-y-2">
                <select
                  value={selectedClientId}
                  onChange={(e) => setSelectedClientId(e.target.value)}
                  className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-blue-500 text-white"
                >
                  {clients.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                      {c.platform === "both" ? " · Meta + Google" : c.platform === "google" ? " · Google Ads" : " · Meta Ads"}
                    </option>
                  ))}
                </select>
                {platformHint && (
                  <p className="text-xs text-gray-500 pl-1">{platformHint}</p>
                )}
              </div>
            )}
          </div>

          {/* Period */}
          <div className="bg-gray-900 rounded-2xl p-6 border border-gray-800">
            <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wider mb-4">Période</h2>
            <select
              value={selectedPeriod}
              onChange={(e) => setSelectedPeriod(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-blue-500 text-white"
            >
              {periods.map((p: DeckPeriod) => (
                <option key={p.month} value={p.month}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>

          {/* Sections */}
          <div className="bg-gray-900 rounded-2xl p-6 border border-gray-800">
            <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wider mb-4">Sections à inclure</h2>
            <div className="space-y-3">
              {SECTIONS.map((s) => {
                const enabled = enabledSections.has(s.id);
                // Hide google section if client is meta-only
                if (s.id === "google" && selectedClient?.platform === "meta") return null;
                // Hide meta section if client is google-only
                if (s.id === "meta" && selectedClient?.platform === "google") return null;
                return (
                  <button
                    key={s.id}
                    onClick={() => toggleSection(s.id)}
                    className="w-full flex items-center gap-3 text-left hover:bg-gray-800 rounded-xl p-3 -m-1 transition-colors"
                  >
                    {enabled
                      ? <CheckSquare className="w-4 h-4 text-blue-400 shrink-0" />
                      : <Square className="w-4 h-4 text-gray-500 shrink-0" />}
                    <span className={`text-sm ${enabled ? "text-white" : "text-gray-500"}`}>{s.label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Budget previsionnel */}
          <div className="bg-gray-900 rounded-2xl p-6 border border-gray-800">
            <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wider mb-1">Budget prévisionnel (optionnel)</h2>
            <p className="text-xs text-gray-500 mb-4">Pour comparer planifié vs réel dans les slides budget</p>
            <div className="grid grid-cols-2 gap-3">
              {(selectedClient?.platform !== "google") && (
                <div>
                  <label className="text-xs text-gray-400 block mb-1">Meta Ads (€)</label>
                  <input
                    type="number"
                    placeholder="ex: 5000"
                    value={budgetMeta}
                    onChange={(e) => setBudgetMeta(e.target.value)}
                    className="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-blue-500 text-white placeholder-gray-600"
                  />
                </div>
              )}
              {(selectedClient?.platform !== "meta") && (
                <div>
                  <label className="text-xs text-gray-400 block mb-1">Google Ads (€)</label>
                  <input
                    type="number"
                    placeholder="ex: 3000"
                    value={budgetGoogle}
                    onChange={(e) => setBudgetGoogle(e.target.value)}
                    className="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-blue-500 text-white placeholder-gray-600"
                  />
                </div>
              )}
            </div>
          </div>

          {/* Contexte metier */}
          <div className="bg-gray-900 rounded-2xl p-6 border border-gray-800">
            <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wider mb-1">Contexte métier (optionnel)</h2>
            <p className="text-xs text-gray-500 mb-4">Info utile pour l&apos;analyse IA : promo lancée, changement de stratégie, saisonnalité...</p>
            <textarea
              value={context}
              onChange={(e) => setContext(e.target.value)}
              rows={3}
              placeholder="ex: On a lancé une promo -20% du 15 au 22 du mois. Budget Google augmenté de 30%..."
              className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-blue-500 text-white placeholder-gray-600 resize-none"
            />
          </div>

          {/* CTA */}
          <button
            onClick={handleGenerate}
            disabled={!selectedClientId || !selectedPeriod || enabledSections.size === 0}
            className="w-full flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed rounded-2xl px-6 py-4 font-semibold text-base transition-colors"
          >
            Générer le deck
            <ChevronRight className="w-5 h-5" />
          </button>

          {/* Historique des decks */}
          {selectedClientId && (
            <div className="bg-gray-900 rounded-2xl p-6 border border-gray-800">
              <div className="flex items-center gap-2 mb-4">
                <Clock className="w-4 h-4 text-gray-400" />
                <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wider">Decks précédents</h2>
              </div>

              {loadingHistory ? (
                <div className="flex items-center gap-2 text-gray-500">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span className="text-sm">Chargement...</span>
                </div>
              ) : history.length === 0 ? (
                <p className="text-sm text-gray-600">Aucun deck sauvegardé pour ce client.</p>
              ) : (
                <div className="space-y-2">
                  {history.map((entry) => {
                    const date = new Date(entry.createdAt);
                    const dateStr = date.toLocaleDateString("fr-FR", { day: "2-digit", month: "short", year: "numeric" });
                    return (
                      <div
                        key={entry.id}
                        className="flex items-center justify-between gap-3 bg-gray-800 rounded-xl px-4 py-3 hover:bg-gray-750 transition-colors"
                      >
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-white truncate">{entry.period || `${entry.startDate} – ${entry.endDate}`}</p>
                          <p className="text-xs text-gray-500">{dateStr} · {entry.slides.length} slides · {entry.platform}</p>
                        </div>
                        <button
                          onClick={() => router.push(`/deck?historyId=${entry.id}`)}
                          className="flex items-center gap-1.5 text-xs text-blue-400 hover:text-blue-300 shrink-0 transition-colors"
                        >
                          Voir
                          <ExternalLink className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
