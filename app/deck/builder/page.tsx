"use client";

import { useState, useEffect, useMemo } from "react";
import { useRouter } from "next/navigation";
import { signIn } from "next-auth/react";
import { Loader2, Presentation, ChevronRight, CheckSquare, Square, Clock, ExternalLink } from "lucide-react";
import { getAvailablePeriods, type DeckPeriod } from "@/lib/deck-data";
import type { DeckClientResult } from "@/app/api/deck/clients/route";
import type { DeckHistoryEntry } from "@/lib/deck-history-storage";

const SECTIONS = [
  { id: "global", label: "Vue globale (highlights, tableau, NC)", slideCount: 3 },
  { id: "google", label: "Google Ads (KPIs, campagnes, insights, next steps)", slideCount: 5 },
  { id: "meta", label: "Meta Ads (KPIs, campagnes, créatives, insights, next steps)", slideCount: 6 },
  { id: "budget", label: "Budget prévisionnel", slideCount: 2 },
  { id: "learnings", label: "Points Clés & recommandations globales", slideCount: 2 },
];

const STORAGE_KEY = "deck-builder-config-v1";

function formatPeriodRange(p: DeckPeriod): string {
  const start = new Date(p.startDate);
  const end = new Date(p.endDate);
  const fmt = (d: Date) => d.toLocaleDateString("fr-FR", { day: "2-digit", month: "short" });
  return `${fmt(start)} – ${fmt(end)}`;
}

export default function DeckBuilderPage() {
  const router = useRouter();
  const [clients, setClients] = useState<DeckClientResult[]>([]);
  const [loadingClients, setLoadingClients] = useState(true);
  const [clientsNeedAuth, setClientsNeedAuth] = useState(false);
  const [metaNeedsReconnect, setMetaNeedsReconnect] = useState(false);
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

  const periods = useMemo(() => getAvailablePeriods(), []);

  // Restore saved config from localStorage
  useEffect(() => {
    try {
      const raw = typeof window !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null;
      if (raw) {
        const saved = JSON.parse(raw) as {
          clientId?: string;
          period?: string;
          sections?: string[];
          context?: string;
          budgetMeta?: string;
          budgetGoogle?: string;
        };
        if (saved.clientId) setSelectedClientId(saved.clientId);
        if (saved.period) setSelectedPeriod(saved.period);
        if (saved.sections) setEnabledSections(new Set(saved.sections));
        if (saved.context) setContext(saved.context);
        if (saved.budgetMeta) setBudgetMeta(saved.budgetMeta);
        if (saved.budgetGoogle) setBudgetGoogle(saved.budgetGoogle);
      }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    fetch("/api/deck/clients")
      .then((r) => r.json())
      .then((d) => {
        if (d.needsAuth) { setClientsNeedAuth(true); return; }
        if (d.metaNeedsReconnect) setMetaNeedsReconnect(true);
        setClients(d.clients || []);
        if (d.clients?.length > 0) {
          // Only set default if nothing was restored from localStorage
          setSelectedClientId((cur) => cur || d.clients[0].id);
        }
      })
      .catch(() => setClients([]))
      .finally(() => setLoadingClients(false));

    setSelectedPeriod((cur) => {
      if (cur) return cur;
      const idx = periods.length > 1 ? 1 : 0;
      return periods[idx]?.month ?? "";
    });
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

  // Sync sections with client platform: drop hidden ones, never send "meta" for google-only client.
  useEffect(() => {
    if (!selectedClient) return;
    setEnabledSections((prev) => {
      const next = new Set(prev);
      if (selectedClient.platform === "meta") next.delete("google");
      if (selectedClient.platform === "google") next.delete("meta");
      return next;
    });
  }, [selectedClient]);

  // Persist config on every change
  useEffect(() => {
    if (!selectedClientId && !selectedPeriod) return;
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          clientId: selectedClientId,
          period: selectedPeriod,
          sections: Array.from(enabledSections),
          context,
          budgetMeta,
          budgetGoogle,
        })
      );
    } catch { /* ignore */ }
  }, [selectedClientId, selectedPeriod, enabledSections, context, budgetMeta, budgetGoogle]);

  const estimatedSlides = useMemo(() => {
    let n = 1; // cover
    SECTIONS.forEach((s) => {
      if (!enabledSections.has(s.id)) return;
      if (s.id === "google" && selectedClient?.platform === "meta") return;
      if (s.id === "meta" && selectedClient?.platform === "google") return;
      n += s.slideCount;
    });
    return n;
  }, [enabledSections, selectedClient]);

  const disabledReason =
    !selectedClientId ? "Sélectionne un client"
    : !selectedPeriod ? "Sélectionne une période"
    : enabledSections.size === 0 ? "Coche au moins une section"
    : null;

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
            ) : clientsNeedAuth ? (
              <div>
                <p className="text-sm text-red-400 mb-3">Session Meta expirée — reconnexion requise</p>
                <button
                  onClick={() => signIn("facebook", { callbackUrl: "/deck/builder" })}
                  className="inline-flex items-center gap-2 text-sm font-semibold px-4 py-2 rounded-xl text-white transition-all hover:opacity-90"
                  style={{ background: "#1877F2" }}
                >
                  Reconnecter Meta Ads
                </button>
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

          {/* Meta reconnect banner when token expired but Google accounts still available */}
          {metaNeedsReconnect && !clientsNeedAuth && (
            <div className="bg-amber-900/30 border border-amber-700/50 rounded-2xl px-4 py-3 flex items-center justify-between gap-4">
              <p className="text-sm text-amber-300">Token Meta Ads expiré — comptes Google Ads disponibles</p>
              <button
                onClick={() => signIn("facebook", { callbackUrl: "/deck/builder" })}
                className="shrink-0 inline-flex items-center gap-2 text-xs font-semibold px-3 py-1.5 rounded-xl text-white transition-all hover:opacity-90"
                style={{ background: "#1877F2" }}
              >
                Reconnecter Meta
              </button>
            </div>
          )}

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
                  {p.label} · {formatPeriodRange(p)}
                </option>
              ))}
            </select>
            <p className="mt-2 text-xs text-gray-500">Comparé automatiquement avec la période précédente (M-1)</p>
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
          <div>
            <button
              onClick={handleGenerate}
              disabled={!!disabledReason}
              title={disabledReason ?? undefined}
              className="w-full flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed rounded-2xl px-6 py-4 font-semibold text-base transition-colors"
            >
              Générer le deck (~{estimatedSlides} slides)
              <ChevronRight className="w-5 h-5" />
            </button>
            {disabledReason && (
              <p className="mt-2 text-xs text-amber-400 text-center">{disabledReason}</p>
            )}
          </div>

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
                      <button
                        key={entry.id}
                        type="button"
                        onClick={() => router.push(`/deck?historyId=${entry.id}`)}
                        className="w-full flex items-center justify-between gap-3 bg-gray-800 rounded-xl px-4 py-3 hover:bg-gray-700 transition-colors text-left"
                      >
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-white truncate">{entry.period || `${entry.startDate} – ${entry.endDate}`}</p>
                          <p className="text-xs text-gray-500">{dateStr} · {entry.slides.length} slides · {entry.platform}</p>
                        </div>
                        <span className="flex items-center gap-1.5 text-xs text-blue-400 shrink-0">
                          Voir
                          <ExternalLink className="w-3.5 h-3.5" />
                        </span>
                      </button>
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
