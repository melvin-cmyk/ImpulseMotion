"use client";

/**
 * /design/[id] — the FigCraft editor on the design's file (iframe, joined with
 * the edit link) beside the design's AI thread. The AI's replies are detached
 * jobs (lib/ai-jobs.ts): the consultant keeps drawing while it works, and the
 * edits it makes show up in the editor as they happen.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Download, ExternalLink, Loader2, MessageSquare, Paperclip, PanelLeftClose, PanelLeftOpen, PanelRightClose, Pencil, Send, Square, Trash2, Users, X } from "lucide-react";
import { Pill } from "@/components/ui/surface";
import { AiMarkdown } from "@/components/ai/ai-markdown";
import { ModelPicker } from "@/components/ai/model-picker";
import { AiActivity } from "@/components/ai/activity";
import { useAiJobs } from "@/components/ai-jobs-watcher";
import { useSidebarCollapsed } from "@/lib/sidebar-state";
import { INITIAL_ACTIVITY, reduceActivity, type ActivityState } from "@/lib/ai-activity";
import { AI_JOB_FINISHED_EVENT, AI_JOB_STARTED_EVENT, followJob, stopJob, type JobEvent, type PublicAiJob } from "@/lib/ai-job-client";
import { DEFAULT_PREFS, fmtBytes, loadPrefs, prepareImage, readAsBase64, savePrefs, type AiPrefs, type ChatFile, type ChatImage } from "@/lib/ai-chat-shared";
import { FIELD, PRIMARY_BUTTON, SMALL_BUTTON, apiErrorText } from "@/components/staff-dashboards/model";
import { DESIGN_FILES_ACCEPT, DESIGN_FILES_UPLOAD_RE, type DesignDetail, type DesignMessage } from "@/lib/design/model";

const PREFS_KEY = "design-copilot:prefs";
const HINT_KEY = "design-copilot:join-hint";
const PANEL_KEY = "design-copilot:panel";
const MAX_UPLOAD_BYTES = 3 * 1024 * 1024;

type Run = { jobId: string; text: string; activity: ActivityState; startedAt: number; stopping?: boolean };
type Pending = { images: ChatImage[]; files: ChatFile[] };

function when(iso: string): string {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "" : d.toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" });
}

export function DesignPage({ id }: { id: string }) {
  const router = useRouter();
  const jobs = useAiJobs();
  const [menuCollapsed, toggleMenu] = useSidebarCollapsed();
  const [design, setDesign] = useState<DesignDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [run, setRun] = useState<Run | null>(null);
  const [foreignJob, setForeignJob] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState<Pending>({ images: [], files: [] });
  const [uploading, setUploading] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [prefs, setPrefs] = useState<AiPrefs>(DEFAULT_PREFS);
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [showHint, setShowHint] = useState(false);
  // The copilot panel can be folded away: the editor then takes the whole window.
  const [panelOpen, setPanelOpen] = useState(true);
  const [exporting, setExporting] = useState<string | null>(null);
  const follower = useRef<AbortController | null>(null);
  const threadEnd = useRef<HTMLDivElement | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const filesBase = `/api/design/${id}/files`;

  useEffect(() => {
    // Browser-only preferences, read after hydration (never during the render).
    let active = true;
    void Promise.resolve().then(() => {
      if (!active) return;
      setPrefs(loadPrefs(PREFS_KEY));
      try { setShowHint(localStorage.getItem(HINT_KEY) !== "0"); } catch { setShowHint(true); }
      try { setPanelOpen(localStorage.getItem(PANEL_KEY) !== "0"); } catch { /* fine */ }
    });
    return () => { active = false; };
  }, []);
  const updatePrefs = (patch: Partial<AiPrefs>) => setPrefs((p) => { const next = { ...p, ...patch }; savePrefs(PREFS_KEY, next); return next; });
  const togglePanel = () => setPanelOpen((v) => { const next = !v; try { localStorage.setItem(PANEL_KEY, next ? "1" : "0"); } catch { /* fine */ } return next; });
  const dismissHint = () => { setShowHint(false); try { localStorage.setItem(HINT_KEY, "0"); } catch { /* fine */ } };

  const load = useCallback(async (): Promise<{ detail: DesignDetail; jobOwner: boolean | null } | null> => {
    const res = await fetch(`/api/design/${id}`, { cache: "no-store" });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) { setLoadError(apiErrorText(json, res.status)); return null; }
    setDesign(json.design as DesignDetail);
    return { detail: json.design as DesignDetail, jobOwner: json.jobOwner as boolean | null };
  }, [id]);

  /** Follows a reply of ours; the thread is reloaded when it ends. */
  const follow = useCallback((jobId: string) => {
    if (follower.current) return;
    const ctl = new AbortController();
    follower.current = ctl;
    jobs.ignore(jobId);
    setRun({ jobId, text: "", activity: INITIAL_ACTIVITY, startedAt: Date.now() });
    const onEvent = (event: JobEvent) => {
      if (event.type === "job") return;
      setRun((r) => {
        if (!r || r.jobId !== jobId) return r;
        const next = { ...r, activity: reduceActivity(r.activity, event) };
        if (event.type === "delta" && typeof event.text === "string") next.text += event.text;
        else if (event.type === "content" && typeof event.text === "string" && !next.text) next.text = event.text;
        else if (event.type === "error") next.text += `\n\n**Erreur :** ${event.message}`;
        return next;
      });
    };
    void followJob(jobId, onEvent, ctl.signal)
      .then(async (outcome) => {
        if (outcome === "aborted") return;
        follower.current = null;
        if (outcome === "unknown") setError("Le suivi de la réponse a été perdu. Le fil se mettra à jour de lui-même.");
        setRun(null);
        await load().catch(() => undefined);
        jobs.refresh();
      })
      .catch((e) => {
        follower.current = null;
        setRun(null);
        setError(e instanceof Error ? e.message : "Suivi interrompu");
      });
  }, [jobs, load]);

  // First load: the thread, and a reply already being produced (ours → follow; someone else's → wait).
  useEffect(() => {
    let cancelled = false;
    void Promise.resolve().then(() => load()).then((r) => {
      if (cancelled || !r) return;
      if (r.detail.jobId) {
        if (r.jobOwner) follow(r.detail.jobId);
        else setForeignJob(r.detail.jobId);
      }
    }).catch((e) => { if (!cancelled) setLoadError(e instanceof Error ? e.message : "Erreur"); });
    return () => { cancelled = true; follower.current?.abort(); follower.current = null; };
  }, [load, follow]);

  // Someone else's reply: poll the thread until it is stored.
  useEffect(() => {
    if (!foreignJob) return;
    const t = setInterval(async () => {
      const r = await load().catch(() => null);
      if (r && r.detail.jobId !== foreignJob) setForeignJob(r.detail.jobId && !r.jobOwner ? r.detail.jobId : null);
    }, 5000);
    return () => clearInterval(t);
  }, [foreignJob, load]);

  // A reply of ours that ended while this page was not following it.
  useEffect(() => {
    const onFinished = (e: Event) => {
      const job = (e as CustomEvent<PublicAiJob>).detail;
      if (job?.surface === "design" && job.conversationId === id && !follower.current) void load().catch(() => undefined);
    };
    window.addEventListener(AI_JOB_FINISHED_EVENT, onFinished);
    return () => window.removeEventListener(AI_JOB_FINISHED_EVENT, onFinished);
  }, [id, load]);

  useEffect(() => { threadEnd.current?.scrollIntoView({ block: "end" }); }, [design?.messages.length, run?.text]);

  async function addFiles(list: FileList | File[]) {
    const all = Array.from(list);
    if (!all.length) return;
    setError(null);
    for (const f of all) {
      if (!DESIGN_FILES_UPLOAD_RE.test(f.name) && !f.type.startsWith("image/")) { setError("Formats acceptés : images, SVG, .figcraft, .fig, JSON, PDF."); continue; }
      if (f.size > MAX_UPLOAD_BYTES) { setError(`${f.name} : 3 Mo maximum.`); continue; }
      setUploading(f.name);
      try {
        // Every file goes to the design's workspace (the AI places it from uploads/);
        // a raster image is also shown to the model as a picture.
        const data = await readAsBase64(f);
        const res = await fetch(filesBase, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: f.name, data }) });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(apiErrorText(json, res.status));
        const file: ChatFile = { name: json.name ?? f.name, path: json.path, bytes: json.bytes ?? f.size };
        let image: ChatImage | null = null;
        if (/^image\/(png|jpeg|webp|gif)$/.test(f.type)) { try { image = await prepareImage(f); } catch { image = null; } }
        setPending((p) => ({ images: image && p.images.length < 4 ? [...p.images, image] : p.images, files: [...p.files.filter((x) => x.path !== file.path), file] }));
      } catch (e) {
        setError(e instanceof Error ? e.message : "Dépôt impossible");
      } finally {
        setUploading(null);
      }
    }
  }

  async function send(e?: React.FormEvent) {
    e?.preventDefault();
    const text = input.trim();
    if ((!text && !pending.files.length) || sending || run || foreignJob) return;
    setSending(true);
    setError(null);
    try {
      const res = await fetch(`/api/design/${id}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, images: pending.images, files: pending.files, model: prefs.model, effort: prefs.effort, account: prefs.account }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 409 && json.jobId) { setForeignJob(json.jobId); }
        throw new Error(apiErrorText(json, res.status));
      }
      setInput("");
      setPending({ images: [], files: [] });
      await load().catch(() => undefined);
      window.dispatchEvent(new Event(AI_JOB_STARTED_EVENT));
      follow(json.jobId as string);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Envoi impossible");
    } finally {
      setSending(false);
    }
  }

  async function stop() {
    if (!run) return;
    setRun((r) => (r ? { ...r, stopping: true } : r));
    try { await stopJob(run.jobId); } catch (e) { setError(e instanceof Error ? e.message : "Arrêt impossible"); }
  }

  async function rename() {
    const name = nameDraft.trim();
    if (!design || !name || name === design.name) { setRenaming(false); return; }
    try {
      const res = await fetch(`/api/design/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(apiErrorText(json, res.status));
      setDesign((d) => (d ? { ...d, name } : d));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Renommage impossible");
    } finally {
      setRenaming(false);
    }
  }

  async function remove() {
    if (!design || !confirm(`Supprimer « ${design.name} » ? Le fichier est retiré du serveur pour tout le monde.`)) return;
    try {
      const res = await fetch(`/api/design/${id}`, { method: "DELETE" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(apiErrorText(json, res.status));
      router.push("/design");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Suppression impossible");
    }
  }

  async function exportAs(format: "png" | "svg" | "pdf") {
    setExporting(format);
    setError(null);
    try {
      const res = await fetch(`/api/design/${id}/export?format=${format}&scale=${format === "png" ? 2 : 1}`);
      if (!res.ok) { const json = await res.json().catch(() => ({})); throw new Error(apiErrorText(json, res.status)); }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = (res.headers.get("content-disposition")?.match(/filename="([^"]+)"/)?.[1]) ?? `${design?.name ?? "design"}.${format}`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Export impossible");
    } finally {
      setExporting(null);
    }
  }

  const messages = useMemo(() => design?.messages ?? [], [design]);
  const busy = !!run || !!foreignJob || sending;

  if (loadError) {
    return (
      <div className="p-6 max-w-3xl mx-auto space-y-4">
        <Link href="/design" className="inline-flex items-center gap-1 text-sm text-gray-400 hover:text-white"><ArrowLeft className="w-4 h-4" /> Design</Link>
        <div className="text-sm text-red-300 bg-red-950/40 border border-red-900/60 rounded-lg px-3 py-2">{loadError}</div>
      </div>
    );
  }
  if (!design) return <div className="p-6 text-sm text-gray-500 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Chargement du design…</div>;

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-2.5 border-b border-gray-800 bg-gray-950/80 shrink-0 flex-wrap">
        <Link href="/design" className="inline-flex items-center gap-1 text-sm text-gray-400 hover:text-white"><ArrowLeft className="w-4 h-4" /> Design</Link>
        <div className="h-4 w-px bg-gray-800" />
        {renaming ? (
          <form onSubmit={(e) => { e.preventDefault(); void rename(); }} className="flex items-center gap-2">
            <input className={`${FIELD} w-72 py-1`} value={nameDraft} onChange={(e) => setNameDraft(e.target.value)} autoFocus maxLength={120} onBlur={() => void rename()} />
          </form>
        ) : (
          <button type="button" className="text-sm font-semibold text-white inline-flex items-center gap-2 group" onClick={() => { if (design.canManage) { setNameDraft(design.name); setRenaming(true); } }} title={design.canManage ? "Renommer" : undefined}>
            {design.name}
            {design.canManage && <Pencil className="w-3.5 h-3.5 text-gray-600 group-hover:text-gray-300" />}
          </button>
        )}
        {design.clientName ? <Pill tone="blue"><Users className="w-3 h-3" /> {design.clientName}</Pill> : <Pill>Agence</Pill>}
        <div className="ml-auto flex items-center gap-2 flex-wrap">
          {(["png", "svg", "pdf"] as const).map((f) => (
            <button key={f} type="button" onClick={() => void exportAs(f)} disabled={!!exporting} className={`${SMALL_BUTTON} bg-gray-800 hover:bg-gray-700 text-gray-200 border border-gray-700`} title={`Exporter la page en ${f.toUpperCase()}${f === "png" ? " (×2)" : ""}`}>
              {exporting === f ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />} {f.toUpperCase()}
            </button>
          ))}
          {design.editorUrl && (
            <a href={design.editorUrl} target="_blank" rel="noopener noreferrer" className={`${SMALL_BUTTON} bg-gray-800 hover:bg-gray-700 text-gray-200 border border-gray-700`} title="Ouvrir l'éditeur dans un onglet">
              <ExternalLink className="w-3.5 h-3.5" /> Plein écran
            </a>
          )}
          <button type="button" onClick={toggleMenu} className={`${SMALL_BUTTON} bg-gray-800 hover:bg-gray-700 text-gray-200 border border-gray-700`} title={menuCollapsed ? "Déployer le menu de gauche" : "Replier le menu de gauche"}>
            {menuCollapsed ? <PanelLeftOpen className="w-3.5 h-3.5" /> : <PanelLeftClose className="w-3.5 h-3.5" />} Menu
          </button>
          <button type="button" onClick={togglePanel} className={`${SMALL_BUTTON} bg-gray-800 hover:bg-gray-700 text-gray-200 border border-gray-700`} title={panelOpen ? "Masquer le copilote : l'éditeur prend toute la fenêtre" : "Afficher le copilote"}>
            {panelOpen ? <PanelRightClose className="w-3.5 h-3.5" /> : <MessageSquare className="w-3.5 h-3.5" />} {panelOpen ? "Plein éditeur" : "Copilote"}
          </button>
          {design.canManage && (
            <button type="button" onClick={() => void remove()} className={`${SMALL_BUTTON} text-red-300 hover:bg-red-950/50`} title="Supprimer le design">
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="mx-4 mt-2 text-sm text-red-300 bg-red-950/40 border border-red-900/60 rounded-lg px-3 py-2 flex items-start gap-2 shrink-0">
          <span className="flex-1">{error}</span>
          <button type="button" onClick={() => setError(null)} className="text-red-400 hover:text-red-200"><X className="w-4 h-4" /></button>
        </div>
      )}

      {/* Editor + copilot */}
      <div className="flex flex-1 min-h-0">
        <div className="flex-1 min-w-0 relative bg-[#2c2c2c]">
          {design.editorUrl ? (
            <iframe
              src={design.editorUrl}
              title={`Éditeur FigCraft — ${design.name}`}
              className="absolute inset-0 w-full h-full border-0"
              allow="fullscreen; clipboard-read; clipboard-write"
              allowFullScreen
            />
          ) : (
            <div className="absolute inset-0 flex items-center justify-center text-sm text-gray-400 p-6 text-center">
              L’éditeur n’est pas configuré (NEXT_PUBLIC_FIGCRAFT_URL). Prévenez un administrateur.
            </div>
          )}
          {showHint && design.editorUrl && (
            <div className="absolute top-3 left-1/2 -translate-x-1/2 bg-gray-950/95 border border-violet-800/70 text-gray-200 text-xs rounded-lg px-3 py-2 flex items-center gap-3 shadow-lg max-w-[90%]">
              <span>À l’ouverture, cliquez sur <strong>Join</strong> dans l’éditeur : le fichier partagé s’affiche et reste synchronisé avec le copilote.</span>
              <button type="button" onClick={dismissHint} className="text-gray-400 hover:text-white" aria-label="Fermer"><X className="w-3.5 h-3.5" /></button>
            </div>
          )}
        </div>

        <aside className={`w-[400px] shrink-0 border-l border-gray-800 bg-gray-950 flex-col min-h-0 ${panelOpen ? "flex" : "hidden"}`}>
          <div className="px-4 py-2.5 border-b border-gray-800 shrink-0">
            <div className="text-sm font-semibold text-white">Copilote design</div>
            <div className="text-xs text-gray-500">Il dessine dans le fichier à côté : demandez un visuel, une déclinaison, une correction.</div>
          </div>

          <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3 min-h-0">
            {messages.length === 0 && !run && (
              <div className="text-xs text-gray-500 space-y-2">
                <p>Exemples :</p>
                <ul className="list-disc pl-4 space-y-1">
                  <li>« Une bannière 1080×1080 pour la promo de rentrée : -30 % sur la gamme bio, CTA “J’en profite”. »</li>
                  <li>« Décline la planche en story 1080×1920 et en paysage 1200×628. »</li>
                  <li>« Place mon logo (déposé) en haut à gauche, rends le titre plus lisible. »</li>
                </ul>
              </div>
            )}
            {messages.map((m: DesignMessage, i: number) => (
              <div key={`${m.at}-${i}`} className={m.role === "user" ? "flex flex-col items-end" : ""}>
                {m.role === "user" ? (
                  <div className="max-w-[92%] bg-violet-600/20 border border-violet-800/50 rounded-xl px-3 py-2 text-sm text-gray-100 whitespace-pre-wrap break-words">
                    {m.content}
                    {m.files?.length ? <div className="mt-1 text-[11px] text-violet-200/80">{m.files.map((f) => f.name).join(", ")}</div> : null}
                  </div>
                ) : (
                  <AiMarkdown content={m.content} filesBase={filesBase} className="prose prose-invert prose-sm max-w-none text-gray-300 bg-gray-900 border border-gray-800 rounded-xl px-3 py-2 break-words" />
                )}
                <div className="text-[10px] text-gray-600 mt-0.5">{m.role === "user" ? (m.author || "vous") : "copilote"} · {when(m.at)}</div>
              </div>
            ))}
            {run && (
              <div>
                {run.text && <AiMarkdown content={run.text} filesBase={filesBase} className="prose prose-invert prose-sm max-w-none text-gray-300 bg-gray-900 border border-gray-800 rounded-xl px-3 py-2 break-words" />}
                <AiActivity state={run.stopping ? { ...run.activity, phase: "starting" } : run.activity} startedAt={run.startedAt} className={run.text ? "mt-2" : undefined} />
              </div>
            )}
            {foreignJob && (
              <div className="text-xs text-amber-300 bg-amber-950/30 border border-amber-900/50 rounded-lg px-3 py-2 flex items-center gap-2">
                <Loader2 className="w-3.5 h-3.5 animate-spin" /> Un autre consultant a une réponse en cours sur ce design. Le fil se mettra à jour à la fin.
              </div>
            )}
            <div ref={threadEnd} />
          </div>

          <form onSubmit={send} className="border-t border-gray-800 p-3 space-y-2 shrink-0" onDrop={(e) => { e.preventDefault(); void addFiles(e.dataTransfer.files); }} onDragOver={(e) => e.preventDefault()}>
            {(pending.files.length > 0 || uploading) && (
              <div className="flex flex-wrap gap-1.5">
                {pending.files.map((f) => (
                  <span key={f.path} className="inline-flex items-center gap-1 text-[11px] bg-gray-800 border border-gray-700 rounded px-1.5 py-0.5 text-gray-300">
                    {f.name} <span className="text-gray-500">{fmtBytes(f.bytes)}</span>
                    <button type="button" onClick={() => setPending((p) => ({ images: p.images, files: p.files.filter((x) => x.path !== f.path) }))} className="text-gray-500 hover:text-white"><X className="w-3 h-3" /></button>
                  </span>
                ))}
                {uploading && <span className="inline-flex items-center gap-1 text-[11px] text-gray-400"><Loader2 className="w-3 h-3 animate-spin" /> {uploading}</span>}
              </div>
            )}
            <textarea
              className={`${FIELD} resize-none h-20`}
              placeholder={foreignJob ? "Réponse en cours par un autre consultant…" : "Décrivez le visuel à créer ou la retouche à faire…"}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }}
              onPaste={(e) => { const files = Array.from(e.clipboardData?.files ?? []); if (files.length) { e.preventDefault(); void addFiles(files); } }}
              disabled={!!foreignJob}
            />
            <div className="flex items-center gap-2">
              <input ref={fileInput} type="file" multiple accept={DESIGN_FILES_ACCEPT} className="hidden" onChange={(e) => { if (e.target.files) void addFiles(e.target.files); e.target.value = ""; }} />
              <button type="button" onClick={() => fileInput.current?.click()} disabled={busy || !!uploading} className={`${SMALL_BUTTON} bg-gray-800 hover:bg-gray-700 text-gray-200 border border-gray-700`} title="Déposer un logo, une photo, un SVG…">
                <Paperclip className="w-3.5 h-3.5" />
              </button>
              <ModelPicker prefs={prefs} onChange={updatePrefs} disabled={busy} idPrefix="design-copilot" />
              <div className="ml-auto">
                {run ? (
                  <button type="button" onClick={() => void stop()} disabled={run.stopping} className={`${SMALL_BUTTON} bg-red-900/60 hover:bg-red-800/70 text-red-100 border border-red-800`}>
                    {run.stopping ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Square className="w-3.5 h-3.5" />} Arrêter
                  </button>
                ) : (
                  <button type="submit" disabled={busy || !!uploading || (!input.trim() && !pending.files.length)} className={PRIMARY_BUTTON}>
                    {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />} Envoyer
                  </button>
                )}
              </div>
            </div>
          </form>
        </aside>
      </div>
    </div>
  );
}
