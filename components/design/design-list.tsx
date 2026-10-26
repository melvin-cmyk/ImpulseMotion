"use client";

/**
 * /design — the agency's design files: create one (name, artboard, client),
 * open it, rename or delete it (owner or admin).
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2, PenTool, Plus, Trash2, Users } from "lucide-react";
import { Card, PageHeader, Pill } from "@/components/ui/surface";
import { PageHelp } from "@/components/ui/page-help";
import { FIELD, PRIMARY_BUTTON, SMALL_BUTTON, apiErrorText, dateLabel } from "@/components/staff-dashboards/model";
import { DESIGN_PRESETS, type DesignListItem, type DesignPresetKey } from "@/lib/design/model";

interface ClientOption { id: string; name: string }

export function DesignList() {
  const router = useRouter();
  const [designs, setDesigns] = useState<DesignListItem[] | null>(null);
  const [clients, setClients] = useState<ClientOption[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [preset, setPreset] = useState<DesignPresetKey>("square");
  const [clientId, setClientId] = useState("");
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/design", { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(apiErrorText(json, res.status));
      setDesigns(json.designs as DesignListItem[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erreur");
      setDesigns([]);
    }
  }, []);

  useEffect(() => {
    void Promise.resolve().then(() => load());
    fetch("/api/dashboards", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { dashboards: [] }))
      .then((j) => {
        const list = (Array.isArray(j) ? j : j.dashboards ?? []) as Array<{ id: string; name: string }>;
        setClients(list.map((d) => ({ id: d.id, name: d.name })).sort((a, b) => a.name.localeCompare(b.name, "fr")));
      })
      .catch(() => undefined);
  }, [load]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || creating) return;
    setCreating(true);
    setError(null);
    try {
      const res = await fetch("/api/design", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), preset, clientDashboardId: clientId || null }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(apiErrorText(json, res.status));
      router.push(`/design/${json.design.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Création impossible");
      setCreating(false);
    }
  }

  async function remove(d: DesignListItem) {
    if (!confirm(`Supprimer le design « ${d.name} » ? Le fichier est retiré du serveur et son éditeur se ferme pour tout le monde.`)) return;
    setDeleting(d.id);
    setError(null);
    try {
      const res = await fetch(`/api/design/${d.id}`, { method: "DELETE" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(apiErrorText(json, res.status));
      setDesigns((prev) => (prev ?? []).filter((x) => x.id !== d.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Suppression impossible");
    } finally {
      setDeleting(null);
    }
  }

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <PageHeader title="Design" subtitle="Un vrai éditeur de maquettes (FigCraft) dans ImpulseMotion, où l'IA dessine avec vous : bannières, déclinaisons, visuels de campagne, exportés en PNG, SVG ou PDF." />
      <PageHelp
        title="Comment ça marche"
        description="Chaque design est un fichier partagé en direct : vous le modifiez dans l'éditeur, le copilote IA y travaille en même temps depuis le panneau de droite."
        steps={[
          "Créez un design : un nom, un format de planche, et le client s'il y en a un (son brief HQ guide l'IA).",
          "Dans l'éditeur, cliquez sur « Join » à l'ouverture : le fichier s'affiche et reste synchronisé.",
          "Demandez au copilote : « une bannière 1080×1080 pour la promo de rentrée, 3 déclinaisons », déposez vos visuels (logo, photos) pour qu'il les place.",
          "Exportez (PNG ×2, SVG, PDF) depuis les boutons en haut, ou directement depuis l'éditeur.",
        ]}
        tip="Les designs sont visibles par toute l'équipe ; seul leur créateur (ou un admin) les renomme ou les supprime."
      />

      <Card padded>
        <form onSubmit={create} className="grid gap-3 md:grid-cols-[1fr_1fr_1fr_auto] items-end">
          <label className="block">
            <span className="block text-xs text-gray-400 mb-1">Nom du design</span>
            <input className={FIELD} value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex. Promo rentrée — bannières Meta" maxLength={120} required />
          </label>
          <label className="block">
            <span className="block text-xs text-gray-400 mb-1">Planche de départ</span>
            <select className={FIELD} value={preset} onChange={(e) => setPreset(e.target.value as DesignPresetKey)}>
              {DESIGN_PRESETS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="block text-xs text-gray-400 mb-1">Client (facultatif)</span>
            <select className={FIELD} value={clientId} onChange={(e) => setClientId(e.target.value)}>
              <option value="">— Agence / sans client —</option>
              {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          <button type="submit" className={PRIMARY_BUTTON} disabled={creating || !name.trim()}>
            {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
            Nouveau design
          </button>
        </form>
      </Card>

      {error && <div className="text-sm text-red-300 bg-red-950/40 border border-red-900/60 rounded-lg px-3 py-2">{error}</div>}

      {designs === null ? (
        <div className="text-sm text-gray-500 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Chargement…</div>
      ) : designs.length === 0 ? (
        <Card padded className="text-sm text-gray-400">Aucun design pour l’instant. Créez-en un ci-dessus.</Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {designs.map((d) => (
            <Card key={d.id} padded interactive className="flex flex-col gap-2">
              <Link href={`/design/${d.id}`} className="flex items-start gap-3 group">
                <div className="w-9 h-9 rounded-lg bg-violet-600/20 border border-violet-800/60 flex items-center justify-center shrink-0">
                  <PenTool className="w-4 h-4 text-violet-300" />
                </div>
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-white truncate group-hover:text-violet-200">{d.name}</div>
                  <div className="text-xs text-gray-500 truncate">
                    {d.ownerName || d.ownerEmail || "—"} · modifié {dateLabel(d.updatedAt)}
                  </div>
                </div>
              </Link>
              <div className="flex items-center justify-between gap-2 mt-1">
                {d.clientName ? <Pill tone="violet"><Users className="w-3 h-3" /> {d.clientName}</Pill> : <Pill>Agence</Pill>}
                {d.canManage && (
                  <button type="button" onClick={() => remove(d)} disabled={deleting === d.id} className={`${SMALL_BUTTON} text-red-300 hover:bg-red-950/50`} title="Supprimer">
                    {deleting === d.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                  </button>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
