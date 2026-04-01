"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  Building2,
  Calendar,
  Loader2,
  Sparkles,
  ChevronDown,
  Info,
} from "lucide-react";
import { getAvailablePeriods, type DeckClient, type DeckPeriod } from "@/lib/deck-data";

export default function DeckBuilderPage() {
  const router = useRouter();
  const periods = getAvailablePeriods();

  const [clients, setClients] = useState<DeckClient[]>([]);
  const [clientsLoading, setClientsLoading] = useState(true);
  const [selectedClient, setSelectedClient] = useState<DeckClient | null>(null);
  const [selectedPeriod, setSelectedPeriod] = useState<DeckPeriod>(periods[1] ?? periods[0]);
  const [context, setContext] = useState("");
  const [googleIdOverride, setGoogleIdOverride] = useState("");

  useEffect(() => {
    fetch("/api/deck/clients")
      .then((r) => r.json())
      .then((data: { clients: DeckClient[]; needsAuth?: boolean }) => {
        if (data.clients && data.clients.length > 0) {
          setClients(data.clients);
          setSelectedClient(data.clients[0]);
        }
      })
      .catch(() => {})
      .finally(() => setClientsLoading(false));
  }, []);

  function handleGenerate() {
    if (!selectedClient || !selectedPeriod) return;
    const url = new URL("/deck", window.location.origin);
    url.searchParams.set("client", selectedClient.id);
    url.searchParams.set("period", selectedPeriod.month);
    if (context.trim()) url.searchParams.set("context", context.trim());
    if (googleIdOverride.trim()) url.searchParams.set("googleId", googleIdOverride.trim());
    url.searchParams.set("mode", "ai");
    router.push(url.pathname + url.search);
  }

  const platformLabel = (platform: DeckClient["platform"]) => {
    if (platform === "both") return "Meta + Google Ads";
    if (platform === "google") return "Google Ads";
    return "Meta Ads";
  };

  const clientDisplayName = (client: DeckClient) => {
    const id = client.googleCustomerId || client.metaAccountId || "";
    const formatted = id ? ` (${id})` : "";
    return `${client.name}${formatted}`;
  };

  return (
    <div className="min-h-screen bg-gray-950 text-white flex flex-col items-center justify-center p-6">
      <div className="w-full max-w-xl">
        {/* Header */}
        <div className="mb-8">
          <div className="flex items-center gap-2 mb-2">
            <Sparkles className="w-5 h-5 text-purple-400" />
            <span className="text-sm font-medium text-purple-400 uppercase tracking-wider">Deck Builder</span>
          </div>
          <h1 className="text-2xl font-bold text-white">Configurer votre deck</h1>
          <p className="text-gray-400 text-sm mt-1">Sélectionnez le client et la période, ajoutez du contexte pour des slides plus pertinentes.</p>
        </div>

        {/* Client selector */}
        <div className="mb-5">
          <label className="block text-sm font-medium text-gray-300 mb-2">
            <Building2 className="w-4 h-4 inline mr-1.5 -mt-0.5" />
            Client
          </label>
          {clientsLoading ? (
            <div className="flex items-center gap-2 text-gray-400 text-sm py-3">
              <Loader2 className="w-4 h-4 animate-spin" />
              Chargement des comptes…
            </div>
          ) : clients.length === 0 ? (
            <div className="text-sm text-red-400 py-3">Aucun compte disponible. Vérifiez votre connexion Meta.</div>
          ) : (
            <div className="relative">
              <select
                className="w-full bg-gray-900 border border-gray-700 rounded-lg px-4 py-3 text-white text-sm appearance-none focus:outline-none focus:ring-2 focus:ring-purple-500 pr-10"
                value={selectedClient?.id ?? ""}
                onChange={(e) => {
                  const c = clients.find((cl) => cl.id === e.target.value);
                  if (c) setSelectedClient(c);
                }}
              >
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {clientDisplayName(c)} — {platformLabel(c.platform)}
                  </option>
                ))}
              </select>
              <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
            </div>
          )}

          {/* Google ID override for meta-only accounts */}
          {selectedClient && selectedClient.platform === "meta" && (
            <div className="mt-3">
              <label className="block text-xs text-gray-500 mb-1.5 flex items-center gap-1">
                <Info className="w-3 h-3" />
                Google Ads Customer ID (optionnel — si ce client a aussi Google Ads)
              </label>
              <input
                type="text"
                placeholder="ex: 123-456-7890"
                value={googleIdOverride}
                onChange={(e) => setGoogleIdOverride(e.target.value)}
                className="w-full bg-gray-900 border border-gray-700 rounded-lg px-4 py-2.5 text-white text-sm placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-purple-500"
              />
            </div>
          )}
        </div>

        {/* Period selector */}
        <div className="mb-5">
          <label className="block text-sm font-medium text-gray-300 mb-2">
            <Calendar className="w-4 h-4 inline mr-1.5 -mt-0.5" />
            Période
          </label>
          <div className="relative">
            <select
              className="w-full bg-gray-900 border border-gray-700 rounded-lg px-4 py-3 text-white text-sm appearance-none focus:outline-none focus:ring-2 focus:ring-purple-500 pr-10"
              value={selectedPeriod.month}
              onChange={(e) => {
                const p = periods.find((p) => p.month === e.target.value);
                if (p) setSelectedPeriod(p);
              }}
            >
              {periods.map((p) => (
                <option key={p.month} value={p.month}>
                  {p.label}
                </option>
              ))}
            </select>
            <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
          </div>
        </div>

        {/* Context */}
        <div className="mb-8">
          <label className="block text-sm font-medium text-gray-300 mb-2">
            <Sparkles className="w-4 h-4 inline mr-1.5 -mt-0.5" />
            Contexte métier
            <span className="text-gray-500 font-normal ml-2">(optionnel)</span>
          </label>
          <textarea
            rows={4}
            placeholder="Ex: On a lancé une promo -30% du 10 au 20. L'objectif principal est l'acquisition. Budget augmenté de 20% vs le mois dernier…"
            value={context}
            onChange={(e) => setContext(e.target.value)}
            className="w-full bg-gray-900 border border-gray-700 rounded-lg px-4 py-3 text-white text-sm placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-purple-500 resize-none"
          />
          <p className="text-xs text-gray-500 mt-1.5">Ce contexte est transmis à l&apos;IA pour générer des slides plus pertinentes et personnalisées.</p>
        </div>

        {/* CTA */}
        <button
          onClick={handleGenerate}
          disabled={!selectedClient || clientsLoading}
          className="w-full flex items-center justify-center gap-2 bg-purple-600 hover:bg-purple-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-semibold py-3.5 px-6 rounded-xl transition-colors text-sm"
        >
          <Sparkles className="w-4 h-4" />
          Générer le deck avec l&apos;IA
          <ArrowRight className="w-4 h-4" />
        </button>

        <p className="text-center text-xs text-gray-600 mt-3">
          Redirige vers /deck et génère automatiquement les slides IA
        </p>
      </div>
    </div>
  );
}
