"use client";

/**
 * Fabrique de statics — the grid of one run: every visual with garder / couper
 * (→ HQ, the existing verdict), « plus comme ça », « template d'origine »
 * (side-by-side panel: template picture + the copy used), feedback on this
 * ad / this template / this run (CreativeFeedback + one HQ journal line per
 * run, announced before the click), filters à trier / gardées / coupées,
 * counters kept / cut on the run.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, Check, Columns2, ExternalLink, Loader2, MessageSquare, PenTool, Scissors, Sparkles, Wand2, X } from "lucide-react";
import { Pill } from "@/components/ui/surface";
import { FACTORY_KIND_LABEL, RUN_STATUS_LABEL, type FeedbackLevel } from "@/lib/creas/model";
import { BTN, BTN_PRIMARY, FIELD, aspect, usd, when, type Asset, type ClientOption, type FactoryCopy, type FactoryRun, type Feedback, type Template } from "./shared";
import { runGenerationPasses } from "./factory-wizard";

type Verdict = "all" | "todo" | "keep" | "cut";

export type Editor = "figcraft" | "photocraft";

export function FactoryGrid({ runId, client, onBack, onOpenTemplate, onOpenIn, onVariation, onNotice, onError, onAssetsChanged, onRunChanged }: {
  runId: string; client: ClientOption; onBack: () => void; onOpenTemplate: (t: Template) => void; onOpenIn: (editor: Editor, src: { assetId?: string; templateId?: string }) => void; onVariation: (a: Asset) => void;
  onNotice: (m: string) => void; onError: (m: string | null) => void; onAssetsChanged: (assets: Asset[]) => void; onRunChanged: (run: FactoryRun) => void;
}) {
  const [run, setRun] = useState<FactoryRun | null>(null);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [feedback, setFeedback] = useState<Feedback[]>([]);
  const [verdict, setVerdict] = useState<Verdict>("all");
  const [templateFilter, setTemplateFilter] = useState<string>("all");
  const [open, setOpen] = useState<Asset | null>(null);
  const [resuming, setResuming] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(`/api/creas/factory/${runId}`, { cache: "no-store" });
    const j = (await res.json().catch(() => ({}))) as { run?: FactoryRun; assets?: Asset[]; templates?: Template[]; feedback?: Feedback[]; error?: string };
    if (!res.ok || !j.run) { onError(j.error ?? `Erreur ${res.status}`); return; }
    setRun(j.run); setAssets(j.assets ?? []); setTemplates(j.templates ?? []); setFeedback(j.feedback ?? []);
  }, [runId, onError]);
  useEffect(() => { queueMicrotask(() => { void load(); }); }, [load]);

  const copyOf = useCallback((a: Asset): FactoryCopy | null => run?.copies.find((c) => c.id === a.copyId) ?? null, [run]);
  const templateOf = useCallback((id: string | null) => templates.find((t) => t.id === id) ?? null, [templates]);
  const shown = useMemo(() => assets.filter((a) => (verdict === "all" ? true : verdict === "keep" ? a.feedback === "keep" : verdict === "cut" ? a.feedback === "cut" : !a.feedback)).filter((a) => templateFilter === "all" || a.templateId === templateFilter), [assets, verdict, templateFilter]);

  async function setAssetVerdict(a: Asset, feedbackValue: "keep" | "cut" | null, note?: string) {
    const res = await fetch(`/api/studio/assets/${a.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ feedback: feedbackValue, ...(note !== undefined ? { feedbackNote: note } : {}) }) });
    const j = (await res.json().catch(() => ({}))) as { asset?: Asset; hq?: { ok: boolean; error?: string }; error?: string };
    if (!res.ok || !j.asset) { onError(j.error ?? `Erreur ${res.status}`); return; }
    const next = assets.map((x) => (x.id === j.asset!.id ? j.asset! : x));
    setAssets(next); onAssetsChanged([j.asset]);
    setOpen((o) => (o?.id === j.asset!.id ? j.asset! : o));
    if (feedbackValue || note) onNotice(j.hq?.ok ? "Retour enregistré et noté dans la mémoire HQ du client." : `Retour enregistré${j.hq?.error ? ` (${j.hq.error})` : ""}.`);
    // Counters of the run (kept / cut, status) come back from the server.
    const r = await fetch(`/api/creas/factory/${runId}`, { cache: "no-store" }).then((x) => (x.ok ? x.json() : null)).catch(() => null) as { run?: FactoryRun } | null;
    if (r?.run) { setRun(r.run); onRunChanged(r.run); }
  }

  async function sendFeedback(level: FeedbackLevel, text: string, ids: { assetId?: string; templateId?: string }) {
    const res = await fetch("/api/creas/feedback", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ level, text, runId, clientId: client.clientId, ...ids }) });
    const j = (await res.json().catch(() => ({}))) as { feedback?: Feedback; hq?: { ok: boolean; error?: string }; error?: string };
    if (!res.ok || !j.feedback) { onError(j.error ?? `Erreur ${res.status}`); return false; }
    setFeedback((l) => [j.feedback!, ...l]);
    onNotice(j.hq?.ok ? `Retour enregistré et ajouté au journal HQ du client (entrée fabrique-${runId}).` : `Retour enregistré dans ImpulseMotion${j.hq?.error ? ` — HQ : ${j.hq.error}` : ""}.`);
    return true;
  }

  async function resume() {
    if (!run) return;
    setResuming(true); onError(null);
    const out = await runGenerationPasses(run.id, null, (p) => { setRun(p.run); onRunChanged(p.run); setAssets((l) => [...l, ...p.assets]); onAssetsChanged(p.assets); if (p.warn) onNotice(p.warn); });
    setResuming(false);
    if (!out.ok) onError(out.error); else onNotice(`${out.run.generated} visuels au total.`);
  }

  if (!run) return <p className="text-sm text-gray-500 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Lecture de la fabrique…</p>;
  const failed = run.settings.failed;
  const hqNote = client.hqSlug ? `journal HQ du client (projects/${client.hqSlug}, entrée fabrique-${run.id})` : "ImpulseMotion seulement (ce client n'a pas de dossier HQ rattaché)";

  return (
    <div className="space-y-4" data-factory-grid data-run={run.id}>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={onBack} className={BTN}><ArrowLeft className="w-4 h-4" /> Fabriques</button>
        <div className="min-w-0">
          <p className="text-sm text-white">Fabrique {FACTORY_KIND_LABEL[run.kind].toLowerCase()} du {when(run.createdAt)} <Pill className="ml-1 text-[10px]">{RUN_STATUS_LABEL[run.status]}</Pill></p>
          <p className="text-xs text-gray-400" data-factory-counters>{run.generated} généré{run.generated > 1 ? "s" : ""} sur {run.settings.n}{failed ? ` · ${failed} échec${failed > 1 ? "s" : ""}` : ""} · <span className="text-emerald-300">{run.kept} gardée{run.kept > 1 ? "s" : ""}</span> · <span className="text-rose-300">{run.cut} coupée{run.cut > 1 ? "s" : ""}</span> · {usd(run.costUsd)} dépensés{run.templateIds.length ? ` · ${run.templateIds.length} template${run.templateIds.length > 1 ? "s" : ""}` : ""} · {run.createdByName}</p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {run.driveLink && <a href={run.driveLink} target="_blank" rel="noopener noreferrer" className={BTN} data-factory-drive><ExternalLink className="w-4 h-4" /> Dossier Drive</a>}
          {run.remaining > 0 && <button type="button" onClick={() => void resume()} disabled={resuming} className={BTN_PRIMARY}>{resuming ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wand2 className="w-4 h-4" />} Reprendre ({run.remaining} restant{run.remaining > 1 ? "s" : ""})</button>}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs">
        {([["all", "Toutes"], ["todo", "À trier"], ["keep", "Gardées"], ["cut", "Coupées"]] as const).map(([v, l]) => (
          <button key={v} type="button" onClick={() => setVerdict(v)} className={`px-2.5 py-1 rounded-md border ${verdict === v ? "border-violet-500 text-white" : "border-gray-800 text-gray-400 hover:text-white"}`}>{l}</button>
        ))}
        <select value={templateFilter} onChange={(e) => setTemplateFilter(e.target.value)} className={`${FIELD} ml-2 max-w-[220px] py-1`}>
          <option value="all">Tous les templates</option>
          {run.templateIds.map((id, i) => <option key={id} value={id}>T{i + 1} · {templateOf(id)?.name ?? "template"}</option>)}
        </select>
      </div>

      {shown.length === 0 ? <p className="text-sm text-gray-500">{assets.length ? "Rien dans ce filtre." : run.status === "generating" ? "Les visuels arrivent…" : "Aucun visuel."}</p> : (
        <ul className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
          {shown.map((a) => { const c = copyOf(a); const t = templateOf(a.templateId); return (
            <li key={a.id} data-factory-asset={a.id} data-verdict={a.feedback ?? ""} className={`group rounded-xl border overflow-hidden bg-gray-950 ${a.feedback === "keep" ? "border-emerald-500/50" : a.feedback === "cut" ? "border-rose-500/40 opacity-70" : "border-gray-800 hover:border-violet-500/60"}`}>
              <button type="button" onClick={() => setOpen(a)} className="w-full text-left">
                <div className="relative bg-gray-900" style={{ aspectRatio: aspect(a.params.ratio) }}>
                  {a.url ? <img src={a.url} alt={a.prompt} className="w-full h-full object-cover" loading="lazy" /> : <div className="w-full h-full flex items-center justify-center text-xs text-gray-500">{a.status === "failed" ? "Échec" : "En cours…"}</div>}
                  <span className="absolute top-1.5 left-1.5"><Pill className="text-[10px]">{t?.name ?? "Template"}</Pill></span>
                  {a.feedback && <span className={`absolute top-1.5 right-1.5 w-6 h-6 rounded-full inline-flex items-center justify-center ${a.feedback === "keep" ? "bg-emerald-500 text-white" : "bg-rose-500 text-white"}`}>{a.feedback === "keep" ? <Check className="w-3.5 h-3.5" /> : <Scissors className="w-3.5 h-3.5" />}</span>}
                </div>
                <div className="px-2.5 py-2">
                  <p className="text-xs text-gray-200 line-clamp-2">{c?.headline ?? a.prompt}</p>
                  <p className="text-[10px] text-gray-500">{c?.angle ? `${c.angle} · ` : ""}{a.costUsd > 0 ? usd(a.costUsd) : "gratuit"}</p>
                </div>
              </button>
              <div className="flex items-center gap-1 px-2 pb-2 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                <button type="button" onClick={() => void setAssetVerdict(a, a.feedback === "keep" ? null : "keep")} data-action="keep" className={`flex-1 inline-flex items-center justify-center gap-1 px-2 py-1 rounded-md text-[11px] border ${a.feedback === "keep" ? "border-emerald-500 text-emerald-200" : "border-gray-800 text-gray-300 hover:text-white"}`}><Check className="w-3 h-3" /> Garder</button>
                <button type="button" onClick={() => void setAssetVerdict(a, a.feedback === "cut" ? null : "cut")} data-action="cut" className={`flex-1 inline-flex items-center justify-center gap-1 px-2 py-1 rounded-md text-[11px] border ${a.feedback === "cut" ? "border-rose-500 text-rose-200" : "border-gray-800 text-gray-300 hover:text-white"}`}><Scissors className="w-3 h-3" /> Couper</button>
                <button type="button" onClick={() => onVariation(a)} data-action="more" className="inline-flex items-center justify-center px-2 py-1 rounded-md text-[11px] border border-gray-800 text-gray-300 hover:text-white" title="Plus comme ça"><Sparkles className="w-3 h-3" /></button>
                <button type="button" onClick={() => setOpen(a)} data-action="template" className="inline-flex items-center justify-center px-2 py-1 rounded-md text-[11px] border border-gray-800 text-gray-300 hover:text-white" title="Template d'origine"><Columns2 className="w-3 h-3" /></button>
              </div>
              <div className="flex items-center gap-1 px-2 pb-2 -mt-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                <button type="button" onClick={() => onOpenIn("figcraft", { assetId: a.id })} data-action="figcraft" disabled={a.status !== "completed"} className="flex-1 inline-flex items-center justify-center gap-1 px-2 py-1 rounded-md text-[11px] border border-gray-800 text-gray-300 hover:text-white disabled:opacity-40" title="Ouvrir dans FigCraft (calques modifiables, copilote IA)"><PenTool className="w-3 h-3" /> FigCraft</button>
                <button type="button" onClick={() => onOpenIn("photocraft", { assetId: a.id })} data-action="photocraft" disabled={a.status !== "completed"} className="flex-1 inline-flex items-center justify-center gap-1 px-2 py-1 rounded-md text-[11px] border border-gray-800 text-gray-300 hover:text-white disabled:opacity-40" title="Ouvrir dans PhotoCraft (retouche)"><PenTool className="w-3 h-3" /> PhotoCraft</button>
              </div>
            </li>
          ); })}
        </ul>
      )}

      <RunFeedbackBox run={run} templates={templates} feedback={feedback} hqNote={hqNote} onSend={sendFeedback} />

      {open && (
        <SideBySide key={open.id} asset={open} copy={copyOf(open)} template={templateOf(open.templateId)} hqNote={hqNote} onClose={() => setOpen(null)}
          onVerdict={(f, note) => void setAssetVerdict(open, f, note)} onVariation={() => { onVariation(open); setOpen(null); }} onOpenTemplate={(t) => { onOpenTemplate(t); setOpen(null); }} onOpenIn={onOpenIn}
          onFeedback={(text) => sendFeedback("asset", text, { assetId: open.id })} />
      )}
    </div>
  );
}

// ── Feedback at run / template level ───────────────────────────────────────

function RunFeedbackBox({ run, templates, feedback, hqNote, onSend }: { run: FactoryRun; templates: Template[]; feedback: Feedback[]; hqNote: string; onSend: (level: FeedbackLevel, text: string, ids: { templateId?: string }) => Promise<boolean> }) {
  const [level, setLevel] = useState<"run" | "template">("run");
  const [templateId, setTemplateId] = useState(run.templateIds[0] ?? "");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const levelLabel = (f: Feedback) => (f.level === "run" ? "cette fabrique" : f.level === "template" ? `template « ${templates.find((t) => t.id === f.templateId)?.name ?? "?"} »` : f.level === "asset" ? "une pub" : "le client");
  return (
    <div className="rounded-xl border border-gray-800 p-3 space-y-2" data-factory-feedback>
      <div className="flex flex-wrap items-center gap-2 text-xs text-gray-400">
        <MessageSquare className="w-4 h-4" /> Retour sur
        <select value={level} onChange={(e) => setLevel(e.target.value as "run" | "template")} className={`${FIELD} py-1`}><option value="run">cette fabrique</option><option value="template">ce template</option></select>
        {level === "template" && <select value={templateId} onChange={(e) => setTemplateId(e.target.value)} className={`${FIELD} py-1 max-w-[240px]`}>{run.templateIds.map((id, i) => <option key={id} value={id}>T{i + 1} · {templates.find((t) => t.id === id)?.name ?? "template"}</option>)}</select>}
      </div>
      <div className="flex items-center gap-2">
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder={level === "run" ? "Ex. : le packaging est déformé sur 3 visuels, garder des fonds plus clairs" : "Ex. : ce template coupe le produit, à écarter pour les packshots"} className={`${FIELD} flex-1`} data-factory-feedback-text />
        <button type="button" disabled={busy || text.trim().length < 3} onClick={async () => { setBusy(true); const ok = await onSend(level, text.trim(), level === "template" ? { templateId } : {}); setBusy(false); if (ok) setText(""); }} className={BTN_PRIMARY} data-factory-feedback-send>{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} Enregistrer</button>
      </div>
      <p className="text-[11px] text-gray-500">Ce retour est gardé dans ImpulseMotion (relu par les prochaines fabriques) et écrit dans le {hqNote}.</p>
      {feedback.length > 0 && (
        <ul className="text-xs text-gray-300 space-y-1 pt-1 border-t border-gray-800" data-factory-feedback-list>
          {feedback.slice(0, 8).map((f) => <li key={f.id}><span className="text-gray-500">{when(f.createdAt)} · {f.createdByName} · {levelLabel(f)} :</span> {f.text}</li>)}
        </ul>
      )}
    </div>
  );
}

/** Feedback kept on a template (shown in the template drawer). */
export function TemplateFeedbackList({ templateId }: { templateId: string }) {
  const [list, setList] = useState<Feedback[] | null>(null);
  useEffect(() => { let cancelled = false; fetch(`/api/creas/feedback?templateId=${templateId}`, { cache: "no-store" }).then((r) => (r.ok ? r.json() : { feedback: [] })).then((j: { feedback: Feedback[] }) => { if (!cancelled) setList(j.feedback ?? []); }).catch(() => { if (!cancelled) setList([]); }); return () => { cancelled = true; }; }, [templateId]);
  if (!list || !list.length) return null;
  return (
    <div data-template-feedback>
      <div className="text-[10px] uppercase tracking-wide text-gray-500">Retours des consultants sur ce template</div>
      <ul className="text-sm text-gray-200 space-y-0.5">{list.slice(0, 6).map((f) => <li key={f.id}><span className="text-gray-500">{when(f.createdAt)} · {f.createdByName} :</span> {f.text}</li>)}</ul>
    </div>
  );
}

// ── Side by side: the visual, its template, the copy ───────────────────────

function SideBySide({ asset: a, copy, template, hqNote, onClose, onVerdict, onVariation, onOpenTemplate, onOpenIn, onFeedback }: { asset: Asset; copy: FactoryCopy | null; template: Template | null; hqNote: string; onClose: () => void; onVerdict: (f: "keep" | "cut" | null, note?: string) => void; onVariation: () => void; onOpenTemplate: (t: Template) => void; onOpenIn: (editor: Editor, src: { assetId?: string; templateId?: string }) => void; onFeedback: (text: string) => Promise<boolean> }) {
  const [note, setNote] = useState(a.feedbackNote ?? "");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); }; window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k); }, [onClose]);
  const p = a.params as { promptSent?: string };
  const an = template?.analysis;
  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" data-factory-side>
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <aside className="relative w-full max-w-3xl h-full bg-gray-950 border-l border-gray-800 overflow-y-auto">
        <div className="sticky top-0 z-10 flex items-center justify-between gap-3 px-4 py-3 bg-gray-950/95 border-b border-gray-800">
          <div className="text-sm font-semibold text-white truncate">Visuel et template d&apos;origine{template ? ` · ${template.name}` : ""}</div>
          <button type="button" onClick={onClose} className="p-1.5 rounded-md text-gray-400 hover:text-white hover:bg-gray-800" aria-label="Fermer"><X className="w-4 h-4" /></button>
        </div>
        <div className="p-4 space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <figure><figcaption className="text-[10px] uppercase tracking-wide text-gray-500 mb-1">Généré · {a.model}{a.costUsd ? ` · ${usd(a.costUsd)}` : ""}</figcaption>{a.url ? <img src={a.url} alt={a.prompt} className="w-full rounded-lg border border-gray-800" /> : <p className="text-xs text-gray-500">{a.error ?? "En cours…"}</p>}</figure>
            <figure><figcaption className="text-[10px] uppercase tracking-wide text-gray-500 mb-1">Template d&apos;origine{template?.brand ? ` · ${template.brand}` : ""}</figcaption>{template?.image ? <button type="button" onClick={() => onOpenTemplate(template)} className="block w-full" title="Ouvrir la fiche du template"><img src={template.image} alt={template.name} className="w-full rounded-lg border border-gray-800" /></button> : <p className="text-xs text-gray-500">Template sans image.</p>}</figure>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => onOpenIn("figcraft", { assetId: a.id })} disabled={a.status !== "completed"} className={BTN_PRIMARY} title="Le visuel reconstruit en calques modifiables (copilote IA)"><PenTool className="w-4 h-4" /> Ouvrir dans FigCraft</button>
            <button type="button" onClick={() => onOpenIn("photocraft", { assetId: a.id })} disabled={a.status !== "completed"} className={BTN} title="Retouche du visuel"><PenTool className="w-4 h-4" /> Ouvrir dans PhotoCraft</button>
            {template && <button type="button" onClick={() => onOpenIn("figcraft", { templateId: template.id })} disabled={!template.image} className={BTN} data-open-template-figcraft title="Le template lui-même, reconstruit en calques pour la marque"><PenTool className="w-4 h-4" /> Ouvrir ce template dans FigCraft</button>}
          </div>
          {an && (an.hook || an.structure || an.textZones.length > 0 || an.brief) && (
            <div className="rounded-lg border border-gray-800 p-3 text-sm space-y-1" data-factory-side-analysis>
              <div className="text-[10px] uppercase tracking-wide text-gray-500">Ce que l&apos;IA a lu dans le template</div>
              {an.hook && <p><span className="text-gray-500">Accroche :</span> <span className="text-gray-200">{an.hook}</span></p>}
              {an.structure && <p><span className="text-gray-500">Structure :</span> <span className="text-gray-200">{an.structure}</span></p>}
              {an.textZones.length > 0 && <p><span className="text-gray-500">Zones de texte :</span> <span className="text-gray-200">{an.textZones.map((z) => `${z.role}${z.text ? ` « ${z.text} »` : ""}`).join(" · ")}</span></p>}
              {an.style && <p><span className="text-gray-500">Style :</span> <span className="text-gray-200">{an.style}</span></p>}
              {an.brief && <p className="text-gray-300 whitespace-pre-wrap"><span className="text-gray-500">Brief :</span> {an.brief}</p>}
            </div>
          )}
          {copy && (
            <div className="rounded-lg border border-gray-800 p-3 text-sm" data-factory-side-copy>
              <div className="text-[10px] uppercase tracking-wide text-gray-500 mb-1">Copy utilisé</div>
              <p className="text-white font-medium">{copy.headline}</p>
              {copy.subline && <p className="text-gray-300">{copy.subline}</p>}
              {copy.cta && <p className="text-gray-400 text-xs mt-1">Bouton : {copy.cta}</p>}
              <p className="text-[11px] text-gray-500 mt-1">{copy.angle ? `Angle : ${copy.angle} · ` : ""}{copy.persona ? `Persona : ${copy.persona} · ` : ""}Source : {copy.voiceSource || "proposition"}{copy.editedByHuman ? " · modifié par le consultant" : ""}</p>
            </div>
          )}
          {p.promptSent && <details className="text-xs text-gray-500"><summary className="cursor-pointer hover:text-gray-300">Consigne envoyée au moteur</summary><p className="mt-1 whitespace-pre-wrap">{p.promptSent}</p></details>}
          <div className="rounded-lg border border-gray-800 p-3 space-y-2">
            <div className="text-xs text-gray-400">Votre verdict — il nourrit la mémoire HQ du client</div>
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" onClick={() => onVerdict(a.feedback === "keep" ? null : "keep", note)} className={`${BTN} ${a.feedback === "keep" ? "border-emerald-500 text-emerald-200" : ""}`}><Check className="w-4 h-4" /> Garder</button>
              <button type="button" onClick={() => onVerdict(a.feedback === "cut" ? null : "cut", note)} className={`${BTN} ${a.feedback === "cut" ? "border-rose-500 text-rose-200" : ""}`}><Scissors className="w-4 h-4" /> Couper</button>
              <button type="button" onClick={onVariation} className={BTN} disabled={a.status !== "completed"}><Sparkles className="w-4 h-4" /> Plus comme ça</button>
              {a.downloadUrl && <a href={a.downloadUrl} className={BTN}>Télécharger</a>}
            </div>
            <div className="flex items-center gap-2">
              <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Pourquoi ? (note du verdict)" className={`${FIELD} flex-1`} />
              <button type="button" onClick={() => onVerdict(a.feedback === "keep" || a.feedback === "cut" ? a.feedback : null, note)} className={BTN}>Noter</button>
            </div>
          </div>
          <div className="rounded-lg border border-gray-800 p-3 space-y-2">
            <div className="text-xs text-gray-400">Retour sur cette pub — pour la prochaine fabrique</div>
            <div className="flex items-center gap-2">
              <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Ex. : le logo est flou, le titre déborde" className={`${FIELD} flex-1`} data-factory-asset-feedback />
              <button type="button" disabled={busy || text.trim().length < 3} onClick={async () => { setBusy(true); const ok = await onFeedback(text.trim()); setBusy(false); if (ok) setText(""); }} className={BTN}>{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} Enregistrer</button>
            </div>
            <p className="text-[11px] text-gray-500">Écrit dans le {hqNote}.</p>
          </div>
        </div>
      </aside>
    </div>
  );
}
