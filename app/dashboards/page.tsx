"use client";

/**
 * « Mes dashboards » (staff) : la liste des pages de pilotage personnelles de la
 * personne, plus celles que l'équipe partage. Jamais visibles des clients.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Database, LayoutDashboard, Loader2, Plus, Users } from "lucide-react";
import { Card, PageHeader, Pill } from "@/components/ui/surface";
import { PRIMARY_BUTTON, apiErrorText, dateLabel, ownerLabel, type DashboardListItem } from "@/components/staff-dashboards/model";

function NewButton() {
  return (
    <Link href="/dashboards/new" className={`${PRIMARY_BUTTON} shrink-0`}>
      <Plus className="w-4 h-4" /> Nouveau dashboard
    </Link>
  );
}

export default function StaffDashboardsPage() {
  const [dashboards, setDashboards] = useState<DashboardListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/staff-dashboards");
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(apiErrorText(body, res.status));
      const list = (Array.isArray(body.dashboards) ? body.dashboards : []) as DashboardListItem[];
      setDashboards(list.filter((d) => d && typeof d.id === "string"));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erreur");
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => { void load(); }, 0);
    return () => clearTimeout(t);
  }, [load]);

  const empty = dashboards !== null && dashboards.length === 0;

  return (
    <div className="p-4 sm:p-6 max-w-6xl mx-auto space-y-6">
      <div className="flex flex-col gap-3 sm:block">
        <PageHeader
          title="Mes dashboards"
          subtitle="Vos pages de pilotage personnelles : une page HTML libre sur les données du relay (Google Ads, Meta, TikTok, Google Sheets…), construite ici ou collée depuis Claude. Jamais visibles des clients."
          action={<span className="hidden sm:inline-flex"><NewButton /></span>}
        />
        <span className="sm:hidden"><NewButton /></span>
      </div>

      {error && (
        <Card padded className="border-red-900/40">
          <p className="text-sm text-red-400">Les dashboards n&apos;ont pas pu être chargés ({error}).</p>
          <button type="button" onClick={() => void load()} className="mt-2 text-xs underline text-gray-300">Réessayer</button>
        </Card>
      )}

      {dashboards === null && !error && (
        <div className="flex items-center gap-2 text-gray-500 text-sm"><Loader2 className="w-4 h-4 animate-spin" /> Chargement…</div>
      )}

      {empty && (
        <Card padded className="py-8">
          <div className="max-w-2xl mx-auto text-center">
            <LayoutDashboard className="w-8 h-8 text-violet-400 mx-auto mb-3" />
            <h2 className="text-base font-semibold text-white">Aucun dashboard pour l&apos;instant</h2>
            <p className="text-sm text-gray-400 mt-2 leading-relaxed">
              Un dashboard est une page HTML qui lit des jeux de données par le relay (un jeu = un appel d&apos;outil : Google Ads, Meta,
              TikTok, Google Sheets, GA4, Merchant Center) et les met en forme comme vous voulez. Il n&apos;est visible que de vous, ou de
              toute l&apos;équipe si vous le partagez.
            </p>
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 mt-6 max-w-3xl mx-auto">
            <Card padded className="bg-gray-950/50">
              <h3 className="text-sm font-semibold text-white">1. Partir d&apos;un modèle</h3>
              <p className="text-xs text-gray-400 mt-1 leading-relaxed">
                Un modèle livré avec l&apos;application (pacing budget par verticale, par exemple) : créé en un clic, puis adapté dans l&apos;éditeur.
              </p>
            </Card>
            <Card padded className="bg-gray-950/50">
              <h3 className="text-sm font-semibold text-white">2. Coller depuis Claude</h3>
              <p className="text-xs text-gray-400 mt-1 leading-relaxed">
                Un dashboard construit dans Claude (type Dashboard) : collez ses jeux de données (JSON) et sa page (files/index.html), il tourne ici tel quel.
              </p>
            </Card>
          </div>
          <div className="flex justify-center mt-6"><NewButton /></div>
        </Card>
      )}

      {dashboards !== null && !empty && (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {dashboards.map((d) => (
            <Link key={d.id} href={`/dashboards/${d.id}`} className="block">
              <Card padded interactive className="h-full">
                <div className="flex items-start justify-between gap-3">
                  <h3 className="text-sm font-semibold text-white break-words min-w-0">{d.title}</h3>
                  {d.shared && !d.mine && <Pill tone="blue" className="shrink-0">Partagé</Pill>}
                  {d.shared && d.mine && <Pill tone="violet" className="shrink-0">Partagé à l&apos;équipe</Pill>}
                </div>
                {d.description && <p className="text-xs text-gray-400 mt-1.5 leading-relaxed line-clamp-2">{d.description}</p>}
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-3 text-[11px] text-gray-500">
                  <span className="inline-flex items-center gap-1"><Database className="w-3.5 h-3.5" /> {d.datasetCount} source{d.datasetCount > 1 ? "s" : ""}</span>
                  {d.shared && !d.mine && <span className="inline-flex items-center gap-1"><Users className="w-3.5 h-3.5" /> {ownerLabel(d)}</span>}
                  <span>Mis à jour le {dateLabel(d.updatedAt)}</span>
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
