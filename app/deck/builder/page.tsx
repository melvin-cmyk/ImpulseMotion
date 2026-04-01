"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import {
  Building2,
  Calendar,
  Loader2,
  ChevronRight,
  LayoutDashboard,
  Target,
  Users,
  TrendingUp,
  MessageSquare,
  DollarSign,
} from "lucide-react";
import { getAvailablePeriods, type DeckClient, type DeckPeriod } from "@/lib/deck-data";

const SECTION_OPTIONS = [
  { id: "overview", label: "Résumé global", description: "Highlights, tableau consolidé toutes plateformes", icon: LayoutDashboard, defaultOn: true },
  { id: "meta", label: "Meta Ads", description: "KPIs, campagnes, top créatifs Facebook/Instagram", icon: Target, defaultOn: true },
  { id: "google", label: "Google Ads", description: "KPIs, campagnes Search/Shopping/Display", icon: TrendingUp, defaultOn: true },
  { id: "nc", label: "Nouveaux clients", description: "Acquisition NC, CP-NC, % NC par plateforme", icon: Users, defaultOn: false },
  { id: "learnings", label: "Learnings & next steps", description: "Enseignements du mois et plan d'actions", icon: MessageSquare, defaultOn: false },
];

export default function DeckBuilderPage() {
  const router = useRouter();
  const periods = getAvailablePeriods();

  const [clients, setClients] = useState<DeckClient[]>([]);
  const [loadingClients, setLoadingClients] = useState(true);
  const [selectedClientId, setSelectedClientId] = useState("");
  const [selectedPeriod, setSelectedPeriod] = useState(periods[1]?.month ?? periods[0]?.month ?? "");
  const [sections, setSections] = useState<Record<string, boolean>>(
    Object.fromEntries(SECTION_OPTIONS.map((s) => [s.id, s.defaultOn]))
  );
  const [context, setContext] = useState("");
  const [metaBudget, setMetaBudget] = useState("");
  const [googleBudget, setGoogleBudget] = useState("");

  useEffect(() => {
    fetch("/api/deck/clients")
      .then((r) => r.json())
      .then((data: { clients?: DeckClient[]; needsAuth?: boolean }) => {
        if (data.needsAuth) {
          router.push("/login");
          return;
        }
        const list = data.clients ?? [];
        setClients(list);
        if (list.length > 0) setSelectedClientId(list[0].id);
      })
      .catch(console.error)
      .finally(() => setLoadingClients(false));
  }, [router]);

  const selectedClient = clients.find((c) => c.id === selectedClientId);
  const selectedPeriodObj = periods.find((p) => p.month === selectedPeriod);

  function clientLabel(c: DeckClient): string {
    if (c.platform === "google") return `${c.name} (${c.googleCustomerId}) — Google Ads`;
    if (c.platform === "both") return `${c.name} — Meta + Google Ads`;
    return `${c.name} — Meta Ads`;
  }

  function handleGenerate() {
    if (!selectedClientId || !selectedPeriod) return;

    const enabledSections = Object.entries(sections)
      .filter(([, on]) => on)
      .map(([id]) => id)
      .join(",");

    const params = new URLSearchParams({
      clientId: selectedClientId,
      period: selectedPeriod,
      sections: enabledSections,
    });
    if (context.trim()) params.set("context", context.trim());
    if (metaBudget) params.set("metaBudget", metaBudget);
    if (googleBudget) params.set("googleBudget", googleBudget);

    router.push(`/deck?${params.toString()}`);
  }

  const canGenerate = !!selectedClientId && !!selectedPeriod && Object.values(sections).some(Boolean);

  return (
    <div className="min-h-screen bg-gray-50 p-6">
      <div className="max-w-2xl mx-auto">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-gray-900">Deck Builder</h1>
          <p className="text-sm text-gray-500 mt-1">Configure ton rapport mensuel avant génération</p>
        </div>

        <div className="space-y-4">
          {/* Client */}
          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <label className="flex items-center gap-2 text-sm font-semibold text-gray-700 mb-3">
              <Building2 size={16} className="text-blue-500" />
              Compte publicitaire
            </label>
            {loadingClients ? (
              <div className="flex items-center gap-2 text-sm text-gray-400">
                <Loader2 size={14} className="animate-spin" />
                Chargement des comptes…
              </div>
            ) : (
              <select
                value={selectedClientId}
                onChange={(e) => setSelectedClientId(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              >
                {clients.length === 0 && <option value="">— Aucun compte disponible —</option>}
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {clientLabel(c)}
                  </option>
                ))}
              </select>
            )}
          </div>

          {/* Period */}
          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <label className="flex items-center gap-2 text-sm font-semibold text-gray-700 mb-3">
              <Calendar size={16} className="text-blue-500" />
              Période
            </label>
            <select
              value={selectedPeriod}
              onChange={(e) => setSelectedPeriod(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            >
              {periods.map((p) => (
                <option key={p.month} value={p.month}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>

          {/* Sections */}
          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <p className="text-sm font-semibold text-gray-700 mb-4">Sections à inclure</p>
            <div className="space-y-3">
              {SECTION_OPTIONS.map((s) => {
                const Icon = s.icon;
                return (
                  <label
                    key={s.id}
                    className="flex items-start gap-3 cursor-pointer group"
                  >
                    <input
                      type="checkbox"
                      checked={sections[s.id] ?? false}
                      onChange={(e) => setSections((prev) => ({ ...prev, [s.id]: e.target.checked }))}
                      className="mt-0.5 h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <Icon size={14} className="text-gray-400 group-hover:text-blue-500 transition-colors" />
                        <span className="text-sm font-medium text-gray-800">{s.label}</span>
                      </div>
                      <p className="text-xs text-gray-400 mt-0.5">{s.description}</p>
                    </div>
                  </label>
                );
              })}
            </div>
          </div>

          {/* Contexte métier */}
          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <label className="flex items-center gap-2 text-sm font-semibold text-gray-700 mb-3">
              <MessageSquare size={16} className="text-blue-500" />
              Contexte métier
              <span className="text-xs font-normal text-gray-400">(optionnel)</span>
            </label>
            <textarea
              value={context}
              onChange={(e) => setContext(e.target.value)}
              placeholder="Ex: Promo lancée le 15 mars, objectif Black Friday, nouveau créatif UGC testé en semaine 2…"
              rows={3}
              className="w-full border border-gray-300 rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 resize-none placeholder:text-gray-300"
            />
          </div>

          {/* Budgets */}
          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <label className="flex items-center gap-2 text-sm font-semibold text-gray-700 mb-4">
              <DollarSign size={16} className="text-blue-500" />
              Budget prévisionnel
              <span className="text-xs font-normal text-gray-400">(optionnel)</span>
            </label>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-xs text-gray-500 mb-1 block">Meta Ads (€)</label>
                <input
                  type="number"
                  value={metaBudget}
                  onChange={(e) => setMetaBudget(e.target.value)}
                  placeholder="Ex: 5000"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>
              <div>
                <label className="text-xs text-gray-500 mb-1 block">Google Ads (€)</label>
                <input
                  type="number"
                  value={googleBudget}
                  onChange={(e) => setGoogleBudget(e.target.value)}
                  placeholder="Ex: 3000"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>
            </div>
          </div>

          {/* Summary + CTA */}
          {selectedClient && selectedPeriodObj && (
            <div className="bg-blue-50 rounded-xl border border-blue-100 p-4 text-sm text-blue-700">
              <strong>{selectedClient.name}</strong> — {selectedPeriodObj.label} —{" "}
              {Object.values(sections).filter(Boolean).length} section(s) sélectionnée(s)
            </div>
          )}

          <button
            onClick={handleGenerate}
            disabled={!canGenerate}
            className="w-full flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-200 disabled:text-gray-400 text-white font-semibold py-3.5 rounded-xl transition-colors text-sm"
          >
            Générer le deck
            <ChevronRight size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}
