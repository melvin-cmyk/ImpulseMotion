"use client";

/**
 * « Tout le client » on the client's cockpit (/portfolio/[id]): every surface
 * of the app filtered on this client, its designs (FigCraft) and its Google
 * Drive folder (created on the first visit once the client has an ad account).
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle, BarChart3, Bot, ExternalLink, FileText, FolderOpen, Gauge, Images, Loader2, PenTool, Plus, RefreshCw, Repeat, Sparkles,
} from "lucide-react";
import { Section } from "@/components/ui/surface";
import type { DesignListItem } from "@/lib/design/model";

interface DriveFile { id: string; name: string; mimeType: string; bytes: number | null; modifiedTime: string | null; webViewLink: string | null; isFolder: boolean }
interface DriveState { folder: { id: string; name: string; url: string | null } | null; files: DriveFile[]; reason?: string; error?: string }

function fmtBytes(n: number | null): string {
  if (n == null) return "";
  if (n < 1024) return `${n} o`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} Ko`;
  return `${(n / 1024 / 1024).toFixed(1)} Mo`;
}
function when(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "" : d.toLocaleDateString("fr-FR", { day: "2-digit", month: "short", year: "numeric" });
}

export function ClientHub({ clientId, metaAccountId, isAdmin }: { clientId: string; metaAccountId: string | null; isAdmin: boolean }) {
  const [designs, setDesigns] = useState<DesignListItem[] | null>(null);
  // Créas: the latest visuals the AI made for this client (/creas?client=…).
  const [creas, setCreas] = useState<Array<{ id: string; url: string | null; prompt: string; feedback: string | null; params: { ratio?: string } }> | null>(null);
  const [drive, setDrive] = useState<DriveState | null>(null);
  const [driveBusy, setDriveBusy] = useState(false);

  const loadDrive = useCallback(async () => {
    setDriveBusy(true);
    try {
      const res = await fetch(`/api/clients/${clientId}/drive`, { cache: "no-store" });
      setDrive((await res.json()) as DriveState);
    } catch {
      setDrive({ folder: null, files: [], error: "Drive injoignable." });
    } finally {
      setDriveBusy(false);
    }
  }, [clientId]);

  useEffect(() => {
    let cancelled = false;
    void Promise.resolve().then(async () => {
      try {
        const res = await fetch(`/api/design?client=${encodeURIComponent(clientId)}`, { cache: "no-store" });
        const j = await res.json();
        if (!cancelled) setDesigns(res.ok ? (j.designs as DesignListItem[]) : []);
      } catch { if (!cancelled) setDesigns([]); }
      try {
        const cl = await fetch("/api/clients").then((r) => (r.ok ? r.json() : { clients: [] })) as { clients: Array<{ id: string; clientId: string; aliasIds?: string[]; dashboardId: string | null }> };
        const ref = cl.clients.find((c) => c.id === clientId || c.dashboardId === clientId || c.clientId === clientId || (c.aliasIds ?? []).includes(clientId));
        if (ref) {
          const res = await fetch(`/api/studio/assets?clientId=${ref.clientId}&origin=generated&take=12`, { cache: "no-store" });
          const j = await res.json().catch(() => ({ assets: [] }));
          if (!cancelled) setCreas(res.ok ? j.assets : []);
        } else if (!cancelled) setCreas([]);
      } catch { if (!cancelled) setCreas([]); }
      if (!cancelled) await loadDrive();
    });
    return () => { cancelled = true; };
  }, [clientId, loadDrive]);

  async function createFolder() {
    setDriveBusy(true);
    try {
      await fetch(`/api/clients/${clientId}/drive`, { method: "POST" });
      await loadDrive();
    } finally {
      setDriveBusy(false);
    }
  }

  const link = "flex items-center gap-2.5 rounded-lg border border-gray-800 bg-gray-900/60 hover:bg-gray-900 hover:border-gray-700 px-3 py-2.5 text-sm text-gray-200 transition-colors";
  const links: Array<{ href: string; label: string; hint: string; icon: React.ReactNode }> = [
    { href: `/d/${clientId}`, label: "Dashboard consultant", hint: "KPIs, widgets, pages", icon: <BarChart3 className="w-4 h-4 text-violet-300" /> },
    { href: `/analyse?client=${clientId}`, label: "Analyse Ads", hint: "créas Meta, Google, TikTok", icon: <Sparkles className="w-4 h-4 text-violet-300" /> },
    { href: `/reports?dashboardId=${clientId}`, label: "Rapports IA", hint: "rapports et personas", icon: <FileText className="w-4 h-4 text-violet-300" /> },
    { href: `/pilotage?dashboardId=${clientId}`, label: "Pilotage", hint: "modifications et impact", icon: <Gauge className="w-4 h-4 text-violet-300" /> },
    { href: `/me/alerts?dashboardId=${clientId}`, label: "Alertes", hint: "règles et historique", icon: <AlertTriangle className="w-4 h-4 text-violet-300" /> },
    { href: `/routines?dashboardId=${clientId}`, label: "Routines", hint: "automatisations", icon: <Repeat className="w-4 h-4 text-violet-300" /> },
    { href: `/creas?client=${clientId}`, label: "Créas", hint: "visuels IA, templates, concurrents", icon: <Images className="w-4 h-4 text-violet-300" /> },
    { href: `/design?client=${clientId}`, label: "Designs", hint: "visuels FigCraft", icon: <PenTool className="w-4 h-4 text-violet-300" /> },
    ...(isAdmin ? [{ href: `/admin/bots/${clientId}`, label: "Bot client", hint: "assistant privé, sources", icon: <Bot className="w-4 h-4 text-violet-300" /> }] : []),
  ];

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Section title="Tout le client" bodyClassName="p-3" className="lg:col-span-1">
        <div className="grid gap-2">
          {links.map((l) => (
            <Link key={l.href} href={l.href} className={link}>
              {l.icon}
              <span className="flex-1 min-w-0">
                <span className="block font-medium truncate">{l.label}</span>
                <span className="block text-[11px] text-gray-500 truncate">{l.hint}</span>
              </span>
              <ExternalLink className="w-3.5 h-3.5 text-gray-600" />
            </Link>
          ))}
        </div>
      </Section>

      <Section title="Créas" action={<Link href={`/creas?client=${clientId}`} className="text-xs text-violet-400 hover:text-white inline-flex items-center gap-1">Tout voir <ExternalLink className="w-3 h-3" /></Link>}>
        {creas === null ? (
          <div className="px-4 py-6 text-xs text-gray-500 flex items-center gap-2"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Chargement…</div>
        ) : creas.length === 0 ? (
          <div className="px-4 py-6 text-xs text-gray-500">Aucun visuel IA pour ce client. <Link href={`/creas?client=${clientId}&tab=templates`} className="text-violet-400">Partir d&apos;un template →</Link></div>
        ) : (
          <div className="grid grid-cols-3 gap-2 p-3">
            {creas.slice(0, 6).map((a) => (
              <Link key={a.id} href={`/creas?client=${clientId}&asset=${a.id}`} className={`relative rounded-lg overflow-hidden border bg-gray-900 aspect-square ${a.feedback === "keep" ? "border-emerald-500/50" : a.feedback === "cut" ? "border-rose-500/40 opacity-70" : "border-gray-800 hover:border-violet-500/60"}`} title={a.prompt}>
                {a.url ? <img src={a.url} alt={a.prompt} className="w-full h-full object-cover" loading="lazy" /> : null}
              </Link>
            ))}
          </div>
        )}
      </Section>

      <Section title="Designs" action={<Link href={`/design?client=${clientId}`} className="text-xs text-violet-400 hover:text-white inline-flex items-center gap-1"><Plus className="w-3 h-3" /> Nouveau</Link>}>
        {designs === null ? (
          <div className="px-4 py-6 text-xs text-gray-500 flex items-center gap-2"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Chargement…</div>
        ) : designs.length === 0 ? (
          <div className="px-4 py-6 text-xs text-gray-500">Aucun design pour ce client. <Link href={`/design?client=${clientId}`} className="text-violet-400">Créer le premier →</Link></div>
        ) : (
          <div className="divide-y divide-gray-800">
            {designs.slice(0, 8).map((d) => (
              <Link key={d.id} href={`/design/${d.id}`} className="flex items-center justify-between gap-3 px-4 py-2.5 hover:bg-gray-800/30">
                <div className="min-w-0">
                  <div className="text-sm text-white truncate">{d.name}</div>
                  <div className="text-[11px] text-gray-500 truncate">{d.ownerName || d.ownerEmail || "—"} · {when(d.updatedAt)}</div>
                </div>
                <PenTool className="w-3.5 h-3.5 text-gray-600 shrink-0" />
              </Link>
            ))}
          </div>
        )}
      </Section>

      <Section
        title="Dossier Drive"
        action={
          <div className="flex items-center gap-2">
            {drive?.folder?.url && <a href={drive.folder.url} target="_blank" rel="noopener noreferrer" className="text-xs text-violet-400 hover:text-white inline-flex items-center gap-1"><FolderOpen className="w-3 h-3" /> Ouvrir</a>}
            <button type="button" onClick={() => void loadDrive()} disabled={driveBusy} className="text-gray-500 hover:text-white" title="Actualiser"><RefreshCw className={`w-3.5 h-3.5 ${driveBusy ? "animate-spin" : ""}`} /></button>
          </div>
        }
      >
        {!drive ? (
          <div className="px-4 py-6 text-xs text-gray-500 flex items-center gap-2"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Chargement…</div>
        ) : drive.error ? (
          <div className="px-4 py-6 text-xs text-amber-300">{drive.error}</div>
        ) : !drive.folder ? (
          <div className="px-4 py-6 text-xs text-gray-500 space-y-2">
            <p>{drive.reason ?? "Pas encore de dossier."}</p>
            <button type="button" onClick={() => void createFolder()} disabled={driveBusy} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-gray-800 hover:bg-gray-700 text-gray-200 border border-gray-700 disabled:opacity-50">
              {driveBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FolderOpen className="w-3.5 h-3.5" />} Créer le dossier maintenant
            </button>
          </div>
        ) : drive.files.length === 0 ? (
          <div className="px-4 py-6 text-xs text-gray-500">Dossier « {drive.folder.name} » vide pour l’instant : les exports des designs y arrivent d’eux-mêmes, et l’équipe peut y déposer des fichiers.</div>
        ) : (
          <div className="divide-y divide-gray-800">
            {drive.files.slice(0, 10).map((f) => (
              <a key={f.id} href={f.webViewLink ?? "#"} target="_blank" rel="noopener noreferrer" className="flex items-center justify-between gap-3 px-4 py-2.5 hover:bg-gray-800/30">
                <div className="min-w-0 flex items-center gap-2">
                  {f.isFolder ? <FolderOpen className="w-3.5 h-3.5 text-amber-300 shrink-0" /> : <FileText className="w-3.5 h-3.5 text-gray-500 shrink-0" />}
                  <div className="min-w-0">
                    <div className="text-sm text-white truncate">{f.name}</div>
                    <div className="text-[11px] text-gray-500 truncate">{[when(f.modifiedTime), fmtBytes(f.bytes)].filter(Boolean).join(" · ")}</div>
                  </div>
                </div>
                <ExternalLink className="w-3.5 h-3.5 text-gray-600 shrink-0" />
              </a>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}
