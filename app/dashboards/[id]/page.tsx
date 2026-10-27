"use client";

/**
 * Un dashboard du staff : la page rendue dans son cadre isolé (DashFrame), le
 * panneau des sources tel que le runtime les décrit, et, pour le propriétaire
 * ou un admin, l'éditeur (titre, jeux de données, paramètres, page) et le partage.
 */

import { use, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Database, FolderOpen, Loader2, Maximize2, Minimize2, Pencil, RefreshCw, Sparkles, Trash2, Users } from "lucide-react";
import { Card, PageHeader, Pill } from "@/components/ui/surface";
import { DashFrame, type DashFrameHandle } from "@/components/staff-dashboards/dash-frame";
import { StaffCopilotPanel } from "@/components/staff-dashboards/copilot";
import { SHEETS_SHARE_EMAIL } from "@/lib/mcp-whitelist";
import { STAFF_DASHBOARDS_DRIVE_FOLDER_URL } from "@/lib/staff-dashboards/drive";
import { SourcesPicker } from "@/components/staff-dashboards/sources-picker";
import { sourceSummary, type StaffSource } from "@/lib/staff-dashboards/sources";
import {
  FIELD, MONO_FIELD, PRIMARY_BUTTON, SMALL_BUTTON, apiErrorText, dateLabel, ownerLabel, parseJsonField,
  type DashboardDetail, type FrameSource,
} from "@/components/staff-dashboards/model";

const STATUS: Record<string, { label: string; tone: "emerald" | "default" | "red" | "amber" }> = {
  ok: { label: "OK", tone: "emerald" },
  loading: { label: "Chargement", tone: "default" },
  error: { label: "Erreur", tone: "red" },
  declined: { label: "Hors périmètre", tone: "red" },
};

export default function StaffDashboardPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const frame = useRef<DashFrameHandle | null>(null);

  const [dashboard, setDashboard] = useState<DashboardDetail | null>(null);
  const [loadError, setLoadError] = useState<{ status: number; message: string } | null>(null);
  const [frameKey, setFrameKey] = useState(0);
  const [sources, setSources] = useState<FrameSource[]>([]);
  const [showSources, setShowSources] = useState(false);
  const [showEditor, setShowEditor] = useState(false);
  const [showCopilot, setShowCopilot] = useState(false);
  // Plein écran : l'API Fullscreen sur le bloc page + copilote ; à défaut (iOS), un calque fixe.
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [fullscreen, setFullscreen] = useState<"off" | "api" | "overlay">("off");
  // Brief de la création « Décrire à l'IA », déposé par /dashboards/new ; lu une fois.
  const [initialPrompt, setInitialPrompt] = useState<string | null>(null);
  const [busy, setBusy] = useState<"refresh" | "share" | "delete" | "save" | string | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string; details?: string[] } | null>(null);

  // Editor fields, filled from the loaded dashboard when the editor opens.
  const [eTitle, setETitle] = useState("");
  const [eDescription, setEDescription] = useState("");
  const [eDatasets, setEDatasets] = useState("");
  const [eParams, setEParams] = useState("");
  const [eHtml, setEHtml] = useState("");
  const [eSources, setESources] = useState<StaffSource[]>([]);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/staff-dashboards/${encodeURIComponent(id)}`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { setLoadError({ status: res.status, message: apiErrorText(body, res.status) }); return null; }
      const d = body.dashboard as DashboardDetail | undefined;
      if (!d || typeof d.id !== "string" || typeof d.html !== "string") { setLoadError({ status: 500, message: "Réponse illisible du serveur" }); return null; }
      setDashboard({ ...d, datasets: d.datasets && typeof d.datasets === "object" ? d.datasets : {}, params: d.params && typeof d.params === "object" ? d.params : {}, sources: Array.isArray(d.sources) ? d.sources : [] });
      setLoadError(null);
      return d;
    } catch (e) {
      setLoadError({ status: 0, message: e instanceof Error ? e.message : String(e) });
      return null;
    }
  }, [id]);

  useEffect(() => {
    const t = setTimeout(() => { void load(); }, 0);
    return () => clearTimeout(t);
  }, [load]);

  useEffect(() => {
    try {
      const key = `staff-dashboard-brief:${id}`;
      const brief = sessionStorage.getItem(key);
      if (brief) { sessionStorage.removeItem(key); setInitialPrompt(brief); setShowCopilot(true); return; }
      if (new URLSearchParams(window.location.search).get("copilot") === "1") setShowCopilot(true);
    } catch { /* stockage indisponible */ }
  }, [id]);

  useEffect(() => {
    const onChange = () => { if (!document.fullscreenElement) setFullscreen((f) => (f === "api" ? "off" : f)); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setFullscreen((f) => (f === "overlay" ? "off" : f)); };
    document.addEventListener("fullscreenchange", onChange);
    window.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("fullscreenchange", onChange); window.removeEventListener("keydown", onKey); };
  }, []);

  async function toggleFullscreen() {
    if (fullscreen !== "off") {
      if (fullscreen === "api" && document.fullscreenElement) { try { await document.exitFullscreen(); } catch { /* déjà sorti */ } }
      setFullscreen("off");
      return;
    }
    const el = stageRef.current;
    if (el?.requestFullscreen) {
      try { await el.requestFullscreen({ navigationUI: "hide" }); setFullscreen("api"); return; } catch { /* refusé : calque */ }
    }
    setFullscreen("overlay");
  }

  /** Après une proposition appliquée par le copilote : relire, puis recharger le cadre. */
  const reloadAfterApply = useCallback(async () => {
    await load();
    setSources([]);
    setFrameKey((k) => k + 1);
  }, [load]);

  function openEditor() {
    if (!dashboard) return;
    setETitle(dashboard.title);
    setEDescription(dashboard.description ?? "");
    setEDatasets(JSON.stringify(dashboard.datasets, null, 2));
    setEParams(JSON.stringify(dashboard.params, null, 2));
    setEHtml(dashboard.html);
    setESources(dashboard.sources);
    setNotice(null);
    setShowEditor(true);
  }

  async function refreshAll() {
    if (busy) return;
    setBusy("refresh");
    try { await frame.current?.refresh(); } finally { setBusy(null); }
  }

  async function refreshOne(sourceId: string) {
    if (busy) return;
    setBusy(`source:${sourceId}`);
    try { await frame.current?.refresh([sourceId]); } finally { setBusy(null); }
  }

  async function setShared(shared: boolean) {
    if (!dashboard || busy) return;
    setBusy("share");
    setNotice(null);
    try {
      const res = await fetch(`/api/staff-dashboards/${encodeURIComponent(id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shared }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(apiErrorText(body, res.status));
      setDashboard({ ...dashboard, shared });
      setNotice({ ok: true, text: shared ? "Dashboard partagé à toute l'équipe (lecture)." : "Dashboard redevenu privé." });
    } catch (e) {
      setNotice({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    if (!dashboard || busy) return;
    if (!window.confirm(`Supprimer le dashboard « ${dashboard.title} » ? Cette action est définitive.`)) return;
    setBusy("delete");
    setNotice(null);
    try {
      const res = await fetch(`/api/staff-dashboards/${encodeURIComponent(id)}`, { method: "DELETE" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(apiErrorText(body, res.status));
      router.push("/dashboards");
    } catch (e) {
      setNotice({ ok: false, text: e instanceof Error ? e.message : String(e) });
      setBusy(null);
    }
  }

  const datasetsParsed = parseJsonField("Jeux de données", eDatasets);
  const paramsParsed = parseJsonField("Paramètres", eParams);
  const canSave = !!eTitle.trim() && !datasetsParsed.error && !paramsParsed.error && !busy;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!canSave) return;
    setBusy("save");
    setNotice(null);
    try {
      const res = await fetch(`/api/staff-dashboards/${encodeURIComponent(id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: eTitle.trim(),
          description: eDescription.trim(),
          datasets: datasetsParsed.value ?? {},
          params: paramsParsed.value ?? {},
          html: eHtml,
          sources: eSources,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        const details = Array.isArray(body.errors) ? body.errors.filter((x: unknown): x is string => typeof x === "string") : [];
        setNotice({ ok: false, text: typeof body.error === "string" ? body.error : `Erreur ${res.status}`, details });
        return;
      }
      await load();
      setSources([]);
      setFrameKey((k) => k + 1);
      setShowEditor(false);
      setNotice({ ok: true, text: "Dashboard enregistré : la page a été rechargée." });
    } catch (err) {
      setNotice({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  }

  if (loadError && !dashboard) {
    return (
      <div className="p-4 sm:p-6 max-w-2xl mx-auto space-y-4">
        <Link href="/dashboards" className="inline-flex items-center gap-1.5 text-xs text-gray-400 hover:text-white"><ArrowLeft className="w-3.5 h-3.5" /> Mes dashboards</Link>
        <Card padded className="border-red-900/40">
          <p className="text-sm text-red-400">
            {loadError.status === 404 ? "Ce dashboard n'existe pas, a été supprimé, ou n'est pas partagé avec vous."
              : `Le dashboard n'a pas pu être chargé (${loadError.message}).`}
          </p>
          {loadError.status !== 404 && (
            <button type="button" onClick={() => void load()} className="mt-2 text-xs underline text-gray-300">Réessayer</button>
          )}
        </Card>
      </div>
    );
  }

  if (!dashboard) {
    return <div className="p-6 flex items-center gap-2 text-gray-500 text-sm"><Loader2 className="w-4 h-4 animate-spin" /> Chargement du dashboard…</div>;
  }

  const spinner = (key: string) => (busy === key ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null);

  return (
    <div className={`p-4 sm:p-6 max-w-[1600px] mx-auto space-y-5 ${showCopilot ? "sm:pr-[460px]" : ""}`}>
      <Link href="/dashboards" className="inline-flex items-center gap-1.5 text-xs text-gray-400 hover:text-white">
        <ArrowLeft className="w-3.5 h-3.5" /> Mes dashboards
      </Link>

      <div className="space-y-2">
        <PageHeader title={dashboard.title} subtitle={dashboard.description ?? undefined} />
        <div className="flex flex-wrap items-center gap-2 text-xs text-gray-400">
          {dashboard.shared ? <Pill tone={dashboard.mine ? "violet" : "blue"}>{dashboard.mine ? "Partagé à l'équipe" : "Partagé"}</Pill> : <Pill>Privé</Pill>}
          {!dashboard.mine && <span className="inline-flex items-center gap-1"><Users className="w-3.5 h-3.5" /> {ownerLabel(dashboard)}</span>}
          <span className="inline-flex items-center gap-1"><Database className="w-3.5 h-3.5" /> {Object.keys(dashboard.datasets).length} jeu{Object.keys(dashboard.datasets).length > 1 ? "x" : ""} de données</span>
          <span>Mis à jour le {dateLabel(dashboard.updatedAt)}</span>
        </div>
        {dashboard.sources.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5" aria-label="Sources choisies">
            {dashboard.sources.map((s) => <Pill key={s.kind} tone="violet">{sourceSummary(s)}</Pill>)}
          </div>
        )}
      </div>

      {/* Actions */}
      <Card padded className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => void refreshAll()} disabled={!!busy} className={`${SMALL_BUTTON} bg-violet-600 hover:bg-violet-500 text-white`}>
            {spinner("refresh") ?? <RefreshCw className="w-3.5 h-3.5" />} Actualiser les données
          </button>
          <button type="button" onClick={() => void toggleFullscreen()} className={`${SMALL_BUTTON} bg-gray-800 hover:bg-gray-700 text-gray-200`} title="Afficher la page seule, en plein écran (Échap pour sortir)">
            <Maximize2 className="w-3.5 h-3.5" /> Plein écran
          </button>
          <button
            type="button"
            onClick={() => setShowSources((v) => !v)}
            aria-pressed={showSources}
            className={`${SMALL_BUTTON} ${showSources ? "bg-gray-700 text-white" : "bg-gray-800 hover:bg-gray-700 text-gray-200"}`}
          >
            <Database className="w-3.5 h-3.5" /> Sources {sources.length ? `(${sources.length})` : ""}
          </button>
          {(dashboard?.driveFolderUrl ?? STAFF_DASHBOARDS_DRIVE_FOLDER_URL) && (
            <a href={dashboard?.driveFolderUrl ?? STAFF_DASHBOARDS_DRIVE_FOLDER_URL ?? "#"} target="_blank" rel="noreferrer" className={`${SMALL_BUTTON} bg-gray-800 hover:bg-gray-700 text-gray-200`} title={dashboard?.driveFolderUrl ? `Dossier Drive du client ${dashboard.driveClientName ?? ""} › Dashboards : déposez-y les fichiers (CSV, Excel, Sheets) que le copilote IA doit lire` : "Dossier Google Drive partagé : déposez-y les fichiers (CSV, Excel, Sheets) que le copilote IA doit lire"}>
              <FolderOpen className="w-3.5 h-3.5" /> Fichiers Drive
            </a>
          )}
          {dashboard.canEdit && (
            <>
              <button
                type="button"
                onClick={() => setShowCopilot((v) => !v)}
                aria-pressed={showCopilot}
                className={`${SMALL_BUTTON} ${showCopilot ? "bg-violet-700 text-white" : "bg-gray-800 hover:bg-gray-700 text-violet-200"}`}
              >
                <Sparkles className="w-3.5 h-3.5" /> Copilote IA
              </button>
              <button
                type="button"
                onClick={() => (showEditor ? setShowEditor(false) : openEditor())}
                aria-pressed={showEditor}
                className={`${SMALL_BUTTON} ${showEditor ? "bg-gray-700 text-white" : "bg-gray-800 hover:bg-gray-700 text-gray-200"}`}
              >
                <Pencil className="w-3.5 h-3.5" /> Modifier
              </button>
              <label className="inline-flex items-center gap-2 text-xs text-gray-300 cursor-pointer select-none">
                <button
                  type="button"
                  role="switch"
                  aria-checked={dashboard.shared}
                  disabled={!!busy}
                  onClick={() => void setShared(!dashboard.shared)}
                  className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors disabled:opacity-40 ${dashboard.shared ? "bg-violet-600" : "bg-gray-700"}`}
                >
                  <span className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${dashboard.shared ? "translate-x-4" : "translate-x-0.5"}`} />
                </button>
                Partager à l&apos;équipe {spinner("share")}
              </label>
              <button type="button" onClick={() => void remove()} disabled={!!busy} className={`${SMALL_BUTTON} bg-gray-900 border border-gray-800 hover:border-red-900 text-gray-400 hover:text-red-300 sm:ml-auto`}>
                {spinner("delete") ?? <Trash2 className="w-3.5 h-3.5" />} Supprimer
              </button>
            </>
          )}
        </div>
        {notice && (
          <div className={`text-xs break-words ${notice.ok ? "text-emerald-300" : "text-red-400"}`}>
            <p>{notice.text}</p>
            {notice.details && notice.details.length > 1 && (
              <ul className="list-disc pl-5 mt-1 space-y-0.5">{notice.details.map((d, i) => <li key={i}>{d}</li>)}</ul>
            )}
          </div>
        )}
      </Card>

      {/* Editor */}
      {dashboard.canEdit && showEditor && (
        <form onSubmit={save}>
          <Card padded className="space-y-4">
            <h2 className="text-sm font-semibold text-white">Modifier le dashboard</h2>
            <label className="block">
              <span className="text-xs font-medium text-gray-300">Titre <span className="text-red-400">*</span></span>
              <input value={eTitle} onChange={(e) => setETitle(e.target.value)} required maxLength={120} className={`${FIELD} mt-1`} />
            </label>
            <label className="block">
              <span className="text-xs font-medium text-gray-300">Description</span>
              <input value={eDescription} onChange={(e) => setEDescription(e.target.value)} maxLength={2000} className={`${FIELD} mt-1`} />
            </label>
            <div>
              <span className="text-xs font-medium text-gray-300">Sources</span>
              <span className="block text-[11px] text-gray-500 mb-2">Plateformes et comptes de la page : le copilote IA construit ses jeux de données dessus.</span>
              <SourcesPicker value={eSources} onChange={setESources} disabled={!!busy} />
            </div>
            <label className="block">
              <span className="text-xs font-medium text-gray-300">Jeux de données (JSON)</span>
              <textarea value={eDatasets} onChange={(e) => setEDatasets(e.target.value)} rows={12} spellCheck={false} className={`${MONO_FIELD} mt-1`} />
              {datasetsParsed.error && <span className="block text-xs text-red-400 mt-1">{datasetsParsed.error}</span>}
            </label>
            <label className="block">
              <span className="text-xs font-medium text-gray-300">Paramètres (JSON)</span>
              <textarea value={eParams} onChange={(e) => setEParams(e.target.value)} rows={4} spellCheck={false} className={`${MONO_FIELD} mt-1`} />
              {paramsParsed.error && <span className="block text-xs text-red-400 mt-1">{paramsParsed.error}</span>}
            </label>
            <label className="block">
              <span className="text-xs font-medium text-gray-300">Page (HTML)</span>
              <textarea value={eHtml} onChange={(e) => setEHtml(e.target.value)} rows={18} spellCheck={false} maxLength={262144} className={`${MONO_FIELD} mt-1 min-h-[300px]`} />
              <span className="block text-[11px] text-gray-500 mt-1">{eHtml.length.toLocaleString("fr-FR")} / 262 144 caractères</span>
            </label>
            <div className="flex flex-wrap items-center gap-3">
              <button type="submit" disabled={!canSave} className={PRIMARY_BUTTON}>
                {spinner("save")} Enregistrer
              </button>
              <button type="button" onClick={() => setShowEditor(false)} className={`${SMALL_BUTTON} bg-gray-800 hover:bg-gray-700 text-gray-200`}>Annuler</button>
            </div>
          </Card>
        </form>
      )}

      {/* Frame + Sources. Le bloc « stage » (page + copilote) est ce qui passe en plein écran. */}
      <div className={`grid grid-cols-1 gap-5 items-start ${showSources ? "lg:grid-cols-[minmax(0,1fr)_360px]" : ""}`}>
        <div
          ref={stageRef}
          className={fullscreen === "off"
            ? "min-w-0"
            : `bg-gray-950 overflow-y-auto ${fullscreen === "overlay" ? "fixed inset-0 z-50" : "w-full h-full"} ${showCopilot ? "sm:pr-[440px]" : ""}`}
        >
          {fullscreen !== "off" && (
            <div className="sticky top-0 z-10 flex items-center justify-between gap-3 px-4 py-2 bg-gray-950/95 border-b border-gray-800 text-xs text-gray-300">
              <span className="font-semibold text-white truncate">{dashboard.title}</span>
              <div className="flex items-center gap-2 shrink-0">
                <button type="button" onClick={() => void refreshAll()} disabled={!!busy} className={`${SMALL_BUTTON} bg-gray-800 hover:bg-gray-700 text-gray-200`}>
                  {spinner("refresh") ?? <RefreshCw className="w-3.5 h-3.5" />} Actualiser
                </button>
                {dashboard.canEdit && (
                  <button type="button" onClick={() => setShowCopilot((v) => !v)} className={`${SMALL_BUTTON} ${showCopilot ? "bg-violet-700 text-white" : "bg-gray-800 hover:bg-gray-700 text-violet-200"}`}>
                    <Sparkles className="w-3.5 h-3.5" /> Copilote
                  </button>
                )}
                <button type="button" onClick={() => void toggleFullscreen()} className={`${SMALL_BUTTON} bg-gray-800 hover:bg-gray-700 text-gray-200`}>
                  <Minimize2 className="w-3.5 h-3.5" /> Quitter le plein écran
                </button>
              </div>
            </div>
          )}
          <Card className={`min-w-0 ${fullscreen === "off" ? "p-3" : "p-4 border-0 rounded-none bg-transparent max-w-[1800px] mx-auto"}`}>
            <DashFrame
              key={frameKey}
              ref={frame}
              dashboardId={dashboard.id}
              title={dashboard.title}
              html={dashboard.html}
              datasets={dashboard.datasets}
              params={dashboard.params}
              onSources={setSources}
            />
          </Card>
          {dashboard.canEdit && showCopilot && (
            <StaffCopilotPanel
              dashboard={dashboard}
              onApplied={reloadAfterApply}
              onClose={() => setShowCopilot(false)}
              initialPrompt={initialPrompt}
              sheetsShareEmail={SHEETS_SHARE_EMAIL}
              flush={fullscreen !== "off"}
              driveFolderUrl={dashboard?.driveFolderUrl ?? STAFF_DASHBOARDS_DRIVE_FOLDER_URL}
            />
          )}
        </div>

        {showSources && (
          <Card className="min-w-0 lg:sticky lg:top-4">
            <div className="px-4 py-3 border-b border-gray-800 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-white flex items-center gap-2"><Database className="w-4 h-4 text-violet-400" /> Sources</h2>
              <button type="button" onClick={() => setShowSources(false)} className="text-xs text-gray-400 hover:text-white">Fermer</button>
            </div>
            <div className="p-3 space-y-2 max-h-[80vh] overflow-y-auto">
              {sources.length === 0 && <p className="text-xs text-gray-500">La page n&apos;a pas encore décrit ses sources.</p>}
              {sources.map((s) => {
                const st = STATUS[s.status] ?? { label: s.status, tone: "default" as const };
                const def = s.kind === "source" ? dashboard.datasets[s.id] : undefined;
                return (
                  <div key={s.id} className="bg-gray-950/50 border border-gray-800 rounded-xl p-3 space-y-1.5">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="text-xs font-mono text-white break-all">{s.id}</div>
                        {(s.title ?? def?.title) && <div className="text-xs text-gray-300 mt-0.5">{s.title ?? def?.title}</div>}
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <Pill tone={s.kind === "calc" ? "amber" : "violet"} className="text-[10px]">{s.kind === "calc" ? "calcul" : "source"}</Pill>
                        <Pill tone={st.tone} className="text-[10px]">{st.label}</Pill>
                      </div>
                    </div>
                    {(s.description ?? def?.description) && <p className="text-[11px] text-gray-400 leading-relaxed">{s.description ?? def?.description}</p>}
                    {s.message && <p className="text-[11px] text-red-300 break-words">{s.message}</p>}
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-gray-500">
                      {s.rows !== null && <span>{s.rows.toLocaleString("fr-FR")} ligne{s.rows > 1 ? "s" : ""}</span>}
                      {s.at && <span>Lu le {dateLabel(s.at)}</span>}
                    </div>
                    {def && (
                      <div className="text-[11px] text-gray-400 space-y-1">
                        <div><span className="text-gray-500">Connecteur :</span> <span className="font-mono text-gray-300">{def.source.connector}</span></div>
                        <div><span className="text-gray-500">Outil :</span> <span className="font-mono text-gray-300">{def.source.tool}</span></div>
                        <details>
                          <summary className="cursor-pointer text-gray-500 hover:text-gray-300">Arguments</summary>
                          <pre className="mt-1 text-[10px] leading-snug text-gray-300 bg-gray-950 border border-gray-800 rounded-lg p-2 overflow-x-auto whitespace-pre-wrap break-all">{JSON.stringify(def.source.args, null, 2)}</pre>
                        </details>
                      </div>
                    )}
                    {s.kind === "source" && (
                      <button type="button" onClick={() => void refreshOne(s.id)} disabled={!!busy} className={`${SMALL_BUTTON} bg-gray-800 hover:bg-gray-700 text-gray-200`}>
                        {spinner(`source:${s.id}`) ?? <RefreshCw className="w-3 h-3" />} Relancer
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}
