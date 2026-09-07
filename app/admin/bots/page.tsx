"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { PageHeader, Pill, Card } from "@/components/ui/surface";

type BotSummary = {
  id: string;
  enabled: boolean;
  name: string;
  clientKey: string;
  accessCount: number;
  lastIngestAt: string | null;
};
type DashboardRow = {
  id: string;
  name: string;
  metaAccountId: string | null;
  googleCustomerId: string | null;
  ownerEmail: string | null;
  bot: BotSummary | null;
};

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" });
}

export default function AdminBotsPage() {
  const [rows, setRows] = useState<DashboardRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "active" | "inactive" | "none">("all");

  useEffect(() => {
    fetch("/api/admin/bots")
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || "Erreur API");
        setRows(data.dashboards || []);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Erreur"))
      .finally(() => setLoading(false));
  }, []);

  const filtered = rows.filter((r) => {
    if (filter === "all") return true;
    if (filter === "none") return !r.bot;
    if (filter === "active") return Boolean(r.bot?.enabled);
    return Boolean(r.bot) && !r.bot?.enabled;
  });
  const activeCount = rows.filter((r) => r.bot?.enabled).length;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Bots clients"
        subtitle="Un assistant IA privé par client : contexte métier, sources de données, accès par email, alimentation e-commerce."
      />

      <div className="flex items-center gap-2 text-xs">
        {(
          [
            ["all", `Tous (${rows.length})`],
            ["active", `Actifs (${activeCount})`],
            ["inactive", "Inactifs"],
            ["none", "Non configurés"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => setFilter(value)}
            className={`px-2.5 py-1 rounded-md font-medium transition-colors ${
              filter === value ? "bg-violet-600 text-white" : "text-gray-400 hover:bg-gray-800 hover:text-white"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {loading ? (
        <p className="text-sm text-gray-500">Chargement…</p>
      ) : error ? (
        <p className="text-sm text-red-400">{error}</p>
      ) : filtered.length === 0 ? (
        <p className="text-sm text-gray-500">Aucun client dans cette catégorie.</p>
      ) : (
        <Card className="overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[11px] uppercase tracking-wide text-gray-500 border-b border-gray-800">
                <th className="text-left px-4 py-2.5 font-medium">Client</th>
                <th className="text-left px-4 py-2.5 font-medium">Bot</th>
                <th className="text-left px-4 py-2.5 font-medium">Clé</th>
                <th className="text-right px-4 py-2.5 font-medium">Accès</th>
                <th className="text-left px-4 py-2.5 font-medium">Dernier ingest</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr key={r.id} className="border-b border-gray-800/60 last:border-0 hover:bg-gray-800/30">
                  <td className="px-4 py-2.5">
                    <div className="text-white font-medium">{r.name}</div>
                    <div className="text-[11px] text-gray-500">{r.ownerEmail ?? "—"}</div>
                  </td>
                  <td className="px-4 py-2.5">
                    {!r.bot ? (
                      <Pill>Non configuré</Pill>
                    ) : r.bot.enabled ? (
                      <Pill tone="emerald">Actif</Pill>
                    ) : (
                      <Pill tone="amber">Inactif</Pill>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    {r.bot ? <code className="text-xs text-gray-300">{r.bot.clientKey}</code> : <span className="text-gray-600">—</span>}
                  </td>
                  <td className="px-4 py-2.5 text-right text-gray-300">{r.bot ? r.bot.accessCount : "—"}</td>
                  <td className="px-4 py-2.5 text-gray-400 text-xs">{r.bot ? formatDate(r.bot.lastIngestAt) : "—"}</td>
                  <td className="px-4 py-2.5 text-right">
                    <Link
                      href={`/admin/bots/${r.id}`}
                      className="text-xs font-medium px-3 py-1.5 rounded-lg bg-violet-500/10 hover:bg-violet-500/20 text-violet-300 border border-violet-500/30 transition-colors"
                    >
                      {r.bot ? "Configurer" : "Créer"}
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
