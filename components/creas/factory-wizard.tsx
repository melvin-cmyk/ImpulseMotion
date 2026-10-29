"use client";

/**
 * Fabrique de statics — the three-step assistant of the « Fabrique » tab:
 *   1. templates (ticked in the swipe file) + kind + consultant's words + pasted reviews → the AI proposes the copies ;
 *   2. copies to tick / edit, each with its source, a « retour sur cette fournée » field ;
 *   3. how many visuals, engine, format → price line « N × 0,06 $ = … · reste aujourd'hui … » → generation by passes
 *      (≤ 12 images per call) with a progress bar, until nothing remains.
 */

import { useMemo, useState } from "react";
import { Check, Loader2, RefreshCw, Sparkles, Wand2 } from "lucide-react";

/** Visuals proposed by default and the most the screen offers: the point is the analysis and reusable bases, not volume (the code accepts more). */
export const DEFAULT_RUN_IMAGES = 8;
export const UI_MAX_RUN_IMAGES = 24;
import { Pill } from "@/components/ui/surface";
import { ContextPanel } from "./context-panel";
import { CONTEXT_SOURCE_LABEL, FACTORY_KIND_LABEL, type FactoryKind } from "@/lib/creas/model";
import { BTN, BTN_PRIMARY, FIELD, factoryPriceLine, usd, type Asset, type ClientOption, type Engine, type FactoryCopy, type FactoryRun, type QuotaInfo, type Template } from "./shared";

const KINDS: FactoryKind[] = ["offer", "evergreen", "iteration"];

export interface PassOutcome { run: FactoryRun; assets: Asset[]; remaining: number; failed: number; warn?: string }

/**
 * Calls the generate route until nothing remains (one pass = ≤ 12 images).
 * Reports every pass; stops on the first refusal (quota 429, error) with its
 * readable message, leaving the run resumable.
 */
export async function runGenerationPasses(runId: string, first: { n: number; engine: string; ratio: string; textless: boolean } | null, onPass: (o: PassOutcome) => void): Promise<{ ok: true; run: FactoryRun } | { ok: false; error: string; status: number; run?: FactoryRun }> {
  let body: Record<string, unknown> = first ?? {};
  let last: FactoryRun | undefined;
  for (let i = 0; i < 20; i++) {
    const res = await fetch(`/api/creas/factory/${runId}/generate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = (await res.json().catch(() => ({}))) as Partial<PassOutcome> & { error?: string };
    if (!res.ok || !j.run) return { ok: false, error: j.error ?? `Erreur ${res.status}`, status: res.status, ...(last ? { run: last } : {}) };
    last = j.run;
    onPass({ run: j.run, assets: j.assets ?? [], remaining: j.remaining ?? 0, failed: j.failed ?? 0, warn: j.warn });
    if (!j.remaining) return { ok: true, run: j.run };
    body = {};
  }
  return { ok: false, error: "Trop de passes : la fabrique reste reprenable.", status: 500, ...(last ? { run: last } : {}) };
}

export function FactoryWizard({ client, templates, engines, quota, preselected, run: initialRun, onRunChange, onAssets, onDone, onCancel, onNotice }: {
  client: ClientOption; templates: Template[]; engines: Engine[]; quota: QuotaInfo | null; preselected: string[]; run: FactoryRun | null;
  onRunChange: (run: FactoryRun) => void; onAssets: (assets: Asset[]) => void; onDone: (run: FactoryRun) => void; onCancel: () => void; onNotice: (m: string) => void;
}) {
  const [run, setRun] = useState<FactoryRun | null>(initialRun);
  const [step, setStep] = useState<1 | 2 | 3>(initialRun ? (initialRun.status === "copy_review" ? 2 : 3) : 1);
  const [error, setError] = useState<string | null>(null);
  const update = (r: FactoryRun) => { setRun(r); onRunChange(r); };
  return (
    <div className="rounded-2xl border border-gray-800 bg-gray-950 p-4 space-y-4" data-factory-wizard data-step={step}>
      <ol className="flex flex-wrap items-center gap-2 text-xs">
        {[[1, "Templates"], [2, "Copys à valider"], [3, "Génération"]].map(([n, l]) => (
          <li key={n} className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border ${step === n ? "border-violet-500 text-white bg-violet-500/10" : step > (n as number) ? "border-emerald-500/50 text-emerald-200" : "border-gray-800 text-gray-500"}`}>{step > (n as number) ? <Check className="w-3 h-3" /> : <span>{n}.</span>} {l}</li>
        ))}
        <li className="ml-auto"><button type="button" onClick={onCancel} className="text-gray-500 hover:text-white">Fermer</button></li>
      </ol>
      {error && <p className="text-sm text-rose-300 whitespace-pre-wrap" data-factory-error>{error}</p>}
      {step === 1 && <StepTemplates client={client} templates={templates} preselected={preselected} onError={setError} onCreated={(r, err) => { update(r); if (err) setError(err); setStep(2); }} />}
      {step === 2 && run && <StepCopies run={run} templates={templates} onError={setError} onUpdated={update} onValidated={(r) => { update(r); setError(null); setStep(3); }} />}
      {step === 3 && run && <StepGenerate run={run} templates={templates} engines={engines} quota={quota} onError={setError} onRun={update} onAssets={onAssets} onNotice={onNotice} onDone={onDone} onBack={() => setStep(2)} />}
    </div>
  );
}

// ── Step 1 ─────────────────────────────────────────────────────────────────

function StepTemplates({ client, templates, preselected, onError, onCreated }: { client: ClientOption; templates: Template[]; preselected: string[]; onError: (e: string | null) => void; onCreated: (run: FactoryRun, error?: string) => void }) {
  const usable = useMemo(() => templates.filter((t) => t.image), [templates]);
  const [picked, setPicked] = useState<string[]>(preselected.filter((id) => usable.some((t) => t.id === id)));
  const [kind, setKind] = useState<FactoryKind>("offer");
  const [perTemplate, setPerTemplate] = useState(4);
  const [instructions, setInstructions] = useState("");
  const [reviews, setReviews] = useState("");
  const [busy, setBusy] = useState(false);
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length < 12 ? [...p, id] : p));
  async function create() {
    if (!picked.length || busy) return;
    setBusy(true); onError(null);
    try {
      const res = await fetch("/api/creas/factory", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ clientId: client.clientId, templateIds: picked, kind, perTemplate, instructions, reviews }) });
      const j = (await res.json().catch(() => ({}))) as { run?: FactoryRun; error?: string };
      if (!res.ok || !j.run) throw new Error(j.error ?? `Erreur ${res.status}`);
      onCreated(j.run, j.error);
    } catch (e) { onError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  return (
    <div className="space-y-4">
      <div>
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm text-gray-200">Templates de la fabrique <span className="text-gray-500">— {picked.length} coché{picked.length > 1 ? "s" : ""} (12 max)</span></p>
          <div className="flex gap-2 text-xs"><button type="button" onClick={() => setPicked(usable.slice(0, 12).map((t) => t.id))} className="text-gray-400 hover:text-white">Tout cocher</button><button type="button" onClick={() => setPicked([])} className="text-gray-400 hover:text-white">Aucun</button></div>
        </div>
        {usable.length === 0 ? <p className="text-sm text-gray-500 mt-2">Aucun template avec image pour {client.name} : ajoutez-en depuis l&apos;onglet « Templates & concurrents ».</p> : (
          <ul className="mt-2 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {usable.map((t) => { const a = t.analysis; const on = picked.includes(t.id); return (
              <li key={t.id}>
                <button type="button" onClick={() => toggle(t.id)} data-factory-template={t.id} aria-pressed={on} className={`relative w-full text-left rounded-lg overflow-hidden border-2 flex gap-3 p-2 ${on ? "border-violet-500 bg-violet-500/5" : "border-gray-800 hover:border-gray-600"}`}>
                  <div className="w-24 shrink-0 aspect-[4/5] bg-gray-900 rounded-md overflow-hidden">{t.image && <img src={t.image} alt={t.name} className="w-full h-full object-cover" loading="lazy" />}</div>
                  <span className={`absolute top-1.5 left-1.5 w-5 h-5 rounded-md inline-flex items-center justify-center ${on ? "bg-violet-600 text-white" : "bg-black/60 text-transparent"}`}><Check className="w-3.5 h-3.5" /></span>
                  <div className="min-w-0 flex-1 space-y-0.5 text-[11px]">
                    <p className="text-sm text-gray-100 line-clamp-1">{t.brand ? `${t.brand} · ` : ""}{t.name}</p>
                    {a.hook && <p className="text-gray-300"><span className="text-gray-500">Accroche :</span> {a.hook}</p>}
                    {a.structure && <p className="text-gray-400 line-clamp-2"><span className="text-gray-500">Structure :</span> {a.structure}</p>}
                    {a.textZones.length > 0 && <p className="text-gray-400 line-clamp-2"><span className="text-gray-500">Zones de texte :</span> {a.textZones.map((z) => `${z.role}${z.text ? ` « ${z.text} »` : ""}`).join(" · ")}</p>}
                    {a.brief && <p className="text-gray-500 line-clamp-2" title={a.brief}><span>Brief :</span> {a.brief}</p>}
                    {!a.hook && !a.structure && <p className="text-amber-300">Pas encore lu par l&apos;IA (« Relire avec l&apos;IA » dans sa fiche).</p>}
                  </div>
                </button>
              </li>
            ); })}
          </ul>
        )}
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="flex flex-col gap-1 text-xs text-gray-400">Type de fabrique
          <select value={kind} onChange={(e) => setKind(e.target.value as FactoryKind)} className={FIELD}>{KINDS.map((k) => <option key={k} value={k}>{FACTORY_KIND_LABEL[k]}</option>)}</select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-gray-400">Propositions de copy par template
          <select value={perTemplate} onChange={(e) => setPerTemplate(Number(e.target.value))} className={FIELD}>{[2, 3, 4, 5, 6].map((k) => <option key={k} value={k}>{k}</option>)}</select>
        </label>
        <div className="text-xs text-gray-500 self-end pb-1">L&apos;IA lit aussi ce que disent les templates choisis, vos avis collés et vos consignes.</div>
      </div>
      <ContextPanel client={client} />
      <label className="flex flex-col gap-1 text-xs text-gray-400">Ce que vous voulez (offre, produit, ton — facultatif)
        <textarea value={instructions} onChange={(e) => setInstructions(e.target.value)} rows={2} placeholder={kind === "offer" ? "Ex. : rentrée, 1er cours offert, cible parents de collégiens" : "Ex. : mettre en avant le suivi personnalisé, ton rassurant"} className={`${FIELD} resize-y`} />
      </label>
      <label className="flex flex-col gap-1 text-xs text-gray-400">Avis clients collés (facultatif) — la voix des clients, reprise mot pour mot dans les copys
        <textarea value={reviews} onChange={(e) => setReviews(e.target.value)} rows={3} placeholder="Collez des avis Google, Trustpilot, des verbatims… (plus il y en a, mieux c'est)" className={`${FIELD} resize-y`} />
      </label>
      <div className="flex items-center justify-end gap-2">
        <button type="button" onClick={() => void create()} disabled={busy || !picked.length} className={BTN_PRIMARY} data-factory-propose>{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />} {busy ? "L'IA écrit les copys… (30 s à 1 min)" : `Proposer ${perTemplate * picked.length || ""} copys`}</button>
      </div>
    </div>
  );
}

// ── Step 2 ─────────────────────────────────────────────────────────────────

type Draft = Pick<FactoryCopy, "id" | "status" | "headline" | "subline" | "cta">;

function StepCopies({ run, templates, onError, onUpdated, onValidated }: { run: FactoryRun; templates: Template[]; onError: (e: string | null) => void; onUpdated: (r: FactoryRun) => void; onValidated: (r: FactoryRun) => void }) {
  // What the consultant changed, over the run's copies (a copy proposed by the AI is ticked by default).
  const [edits, setEdits] = useState<Record<string, Partial<Draft>>>({});
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState<"save" | "repropose" | null>(null);
  const draftOf = (c: FactoryCopy): Draft => ({ id: c.id, status: edits[c.id]?.status ?? (c.status === "rejected" ? "rejected" : "approved"), headline: edits[c.id]?.headline ?? c.headline, subline: edits[c.id]?.subline ?? c.subline, cta: edits[c.id]?.cta ?? c.cta });
  const drafts = run.copies.map(draftOf);
  const approvedCount = drafts.filter((d) => d.status === "approved").length;
  const byTemplate = useMemo(() => run.templateIds.map((id) => ({ template: templates.find((t) => t.id === id) ?? null, id, copies: run.copies.filter((c) => c.templateId === id) })), [run, templates]);
  const set = (id: string, patch: Partial<Draft>) => setEdits((d) => ({ ...d, [id]: { ...d[id], ...patch } }));
  const setAll = (status: "approved" | "rejected") => setEdits((d) => { const next = { ...d }; for (const c of run.copies) next[c.id] = { ...next[c.id], status }; return next; });
  const sourceSummary = run.sources.map((s) => (s.kind === "templates" ? `${s.ref.split(",").length} templates` : s.kind === "instructions" ? "vos consignes" : `${CONTEXT_SOURCE_LABEL[s.kind] ?? s.kind}${s.note ? ` (${s.note})` : ""} · ${s.chars} car.`)).join(" · ");

  async function save(then: "validate" | "repropose") {
    setBusy(then === "validate" ? "save" : "repropose"); onError(null);
    try {
      const copies = drafts.map((d) => { const o = run.copies.find((c) => c.id === d.id); return { id: d.id, status: d.status, ...(o && o.headline !== d.headline ? { headline: d.headline } : {}), ...(o && o.subline !== d.subline ? { subline: d.subline } : {}), ...(o && o.cta !== d.cta ? { cta: d.cta } : {}) }; });
      const res = await fetch(`/api/creas/factory/${run.id}/copies`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ copies, feedback: feedback.trim() || undefined, ...(then === "repropose" ? { repropose: true } : {}) }) });
      const j = (await res.json().catch(() => ({}))) as { run?: FactoryRun; error?: string; hq?: { ok: boolean; error?: string } };
      if (!res.ok || !j.run) throw new Error(j.error ?? `Erreur ${res.status}`);
      setFeedback(""); setEdits({});
      if (j.error) onError(j.error);
      if (then === "validate") onValidated(j.run); else onUpdated(j.run);
    } catch (e) { onError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  }

  return (
    <div className="space-y-4">
      <div className="text-xs text-gray-400">
        <span className="text-gray-200">{run.copies.length} copys proposés</span> pour {run.templateIds.length} template{run.templateIds.length > 1 ? "s" : ""} · contexte lu : {sourceSummary || "aucune source"} ·{" "}
        <details className="inline"><summary className="cursor-pointer inline hover:text-white">voir le contexte</summary><pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap rounded-lg border border-gray-800 p-2 text-[11px] text-gray-300">{run.contextMd}</pre></details>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-gray-300">{approvedCount} coché{approvedCount > 1 ? "s" : ""}</span>
        <button type="button" onClick={() => setAll("approved")} className="text-gray-400 hover:text-white">Tout cocher</button>
        <button type="button" onClick={() => setAll("rejected")} className="text-gray-400 hover:text-white">Tout décocher</button>
      </div>
      {byTemplate.map(({ template, id, copies }, ti) => (
        <section key={id} className="rounded-xl border border-gray-800 overflow-hidden">
          <header className="flex items-center gap-3 px-3 py-2 bg-gray-900/60">
            {template?.image && <img src={template.image} alt="" className="w-10 h-12 object-cover rounded-md border border-gray-800" />}
            <div className="min-w-0"><p className="text-sm text-white truncate">T{ti + 1} · {template?.name ?? "Template"}</p><p className="text-[11px] text-gray-500">{template?.brand ? `${template.brand} · ` : ""}{template?.analysis.hook || ""}{template?.analysis.textZones.length ? ` · zones : ${template.analysis.textZones.map((z) => z.role).join(", ")}` : ""}</p></div>
          </header>
          {copies.length === 0 ? <p className="px-3 py-2 text-xs text-gray-500">Aucune proposition pour ce template.</p> : (
            <ul className="divide-y divide-gray-800">
              {copies.map((c) => { const d = draftOf(c); return (
                <li key={c.id} data-factory-copy={c.id} data-approved={d.status === "approved"} className={`grid gap-2 px-3 py-2 sm:grid-cols-[auto_1fr] ${d.status === "approved" ? "" : "opacity-60"}`}>
                  <label className="pt-1.5"><input type="checkbox" checked={d.status === "approved"} onChange={(e) => set(c.id, { status: e.target.checked ? "approved" : "rejected" })} aria-label="Garder ce copy" /></label>
                  <div className="space-y-1.5">
                    <input value={d.headline} onChange={(e) => set(c.id, { headline: e.target.value })} className={`${FIELD} w-full font-medium`} aria-label="Titre" />
                    <div className="grid gap-1.5 sm:grid-cols-[1fr_180px]">
                      <input value={d.subline} onChange={(e) => set(c.id, { subline: e.target.value })} placeholder="Sous-titre (facultatif)" className={`${FIELD} w-full`} aria-label="Sous-titre" />
                      <input value={d.cta} onChange={(e) => set(c.id, { cta: e.target.value })} placeholder="Bouton" className={`${FIELD} w-full`} aria-label="Bouton" />
                    </div>
                    <p className="text-[11px] text-gray-500">{c.angle && <span>Angle : <span className="text-gray-300">{c.angle}</span> · </span>}{c.persona && <span>Persona : <span className="text-gray-300">{c.persona}</span> · </span>}Source : <span className="text-gray-300" data-copy-source>{c.voiceSource || "proposition"}</span>{c.editedByHuman || d.headline !== c.headline || d.subline !== c.subline || d.cta !== c.cta ? <Pill className="ml-2 text-[10px]">modifié</Pill> : null}</p>
                  </div>
                </li>
              ); })}
            </ul>
          )}
        </section>
      ))}
      <label className="flex flex-col gap-1 text-xs text-gray-400">Retour sur cette fournée (facultatif) — gardé pour les prochaines fabriques et ajouté au journal HQ du client
        <textarea value={feedback} onChange={(e) => setFeedback(e.target.value)} rows={2} placeholder="Ex. : jamais de -50 % sans mon accord, plus de citations à la première personne" className={`${FIELD} resize-y`} data-factory-run-feedback />
      </label>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <button type="button" onClick={() => void save("repropose")} disabled={!!busy} className={BTN}>{busy === "repropose" ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />} Reproposer les non cochés</button>
        <button type="button" onClick={() => void save("validate")} disabled={!!busy || !approvedCount} className={BTN_PRIMARY} data-factory-validate>{busy === "save" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} Valider {approvedCount} copy{approvedCount > 1 ? "s" : ""} →</button>
      </div>
    </div>
  );
}

// ── Step 3 ─────────────────────────────────────────────────────────────────

function StepGenerate({ run, templates, engines, quota, onError, onRun, onAssets, onNotice, onDone, onBack }: { run: FactoryRun; templates: Template[]; engines: Engine[]; quota: QuotaInfo | null; onError: (e: string | null) => void; onRun: (r: FactoryRun) => void; onAssets: (a: Asset[]) => void; onNotice: (m: string) => void; onDone: (r: FactoryRun) => void; onBack: () => void }) {
  const approved = run.copies.filter((c) => c.status === "approved");
  const falEngines = useMemo(() => engines.filter((e) => e.provider === "fal" && e.refs), [engines]);
  const [engine, setEngine] = useState(run.settings.engine);
  const chosen = falEngines.some((e) => e.id === engine) ? engine : falEngines[0]?.id ?? run.settings.engine;
  const unit = engines.find((e) => e.id === chosen)?.usd ?? 0.06;
  const [n, setN] = useState(run.settings.n || DEFAULT_RUN_IMAGES);
  const [ratio, setRatio] = useState(run.settings.ratio || "1:1");
  const [textless, setTextless] = useState(run.settings.textless);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; failed: number } | null>(run.settings.attempted ? { done: run.generated, failed: run.settings.failed } : null);
  const started = run.status === "generating" || run.status === "review" || run.status === "done";
  const price = factoryPriceLine(quota, unit, started ? run.settings.n : n);
  const tplNames = run.templateIds.map((id) => templates.find((t) => t.id === id)?.name ?? "template");

  async function generate(resume: boolean) {
    setBusy(true); onError(null);
    const total = resume ? run.settings.n : n;
    if (!resume) setProgress({ done: 0, failed: 0 });
    const out = await runGenerationPasses(run.id, resume ? null : { n, engine: chosen, ratio, textless }, (p) => {
      onRun(p.run); onAssets(p.assets);
      setProgress({ done: p.run.generated, failed: p.run.settings.failed });
      if (p.warn) onNotice(p.warn);
    });
    setBusy(false);
    if (!out.ok) { onError(out.error); if (out.run) onRun(out.run); return; }
    onNotice(`${out.run.generated} visuel${out.run.generated > 1 ? "s" : ""} généré${out.run.generated > 1 ? "s" : ""} sur ${total}${out.run.settings.failed ? ` (${out.run.settings.failed} en échec)` : ""}${out.run.driveLink ? " · copiés dans le Drive du client" : ""}.`);
    onDone(out.run);
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-200">{approved.length} copy{approved.length > 1 ? "s" : ""} validé{approved.length > 1 ? "s" : ""} sur {tplNames.length} template{tplNames.length > 1 ? "s" : ""} <span className="text-gray-500">({tplNames.join(", ")})</span>. Chaque visuel = un template × un copy validé, à tour de rôle — des bases à reprendre dans FigCraft, pas du volume ({UI_MAX_RUN_IMAGES} max ici).</p>
      {!started && (
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs text-gray-400">Visuels à générer
            <input type="number" min={1} max={UI_MAX_RUN_IMAGES} value={n} onChange={(e) => setN(Math.max(1, Math.min(UI_MAX_RUN_IMAGES, Math.round(Number(e.target.value) || 1))))} className={`${FIELD} w-24`} data-factory-n />
          </label>
          <label className="flex flex-col gap-1 text-xs text-gray-400">Moteur
            <select value={chosen} onChange={(e) => setEngine(e.target.value)} className={`${FIELD} max-w-[280px]`}>{falEngines.map((e) => <option key={e.id} value={e.id}>{e.label} · {e.usd} $</option>)}{!falEngines.length && <option value={chosen}>{chosen}</option>}</select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-gray-400">Format
            <select value={ratio} onChange={(e) => setRatio(e.target.value)} className={FIELD}>{[["1:1", "Carré 1:1"], ["3:4", "Portrait 3:4"], ["9:16", "Vertical 9:16"], ["16:9", "Paysage 16:9"], ["4:3", "Paysage 4:3"]].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
          </label>
          <label className="flex items-center gap-1.5 text-xs text-gray-400 pb-2"><input type="checkbox" checked={textless} onChange={(e) => setTextless(e.target.checked)} /> Sans texte (posés ensuite)</label>
        </div>
      )}
      <p className={`text-sm ${price.over ? "text-rose-300" : "text-gray-300"}`} data-factory-price>{price.over ? "Plafond du jour dépassé — " : ""}{price.text}</p>
      {progress && (
        <div className="space-y-1" data-factory-progress>
          <div className="h-2 rounded-full bg-gray-800 overflow-hidden"><div className="h-full bg-violet-500 transition-all" style={{ width: `${Math.min(100, Math.round(((progress.done + progress.failed) / Math.max(1, started ? run.settings.n : n)) * 100))}%` }} /></div>
          <p className="text-xs text-gray-400">{progress.done} / {started ? run.settings.n : n} visuel{progress.done > 1 ? "s" : ""} généré{progress.done > 1 ? "s" : ""}{progress.failed ? ` · ${progress.failed} en échec` : ""}{busy ? " · génération en cours (paquets de 4, 12 par passage)…" : run.remaining ? ` · ${run.remaining} restant${run.remaining > 1 ? "s" : ""}` : ""}</p>
        </div>
      )}
      <div className="flex flex-wrap items-center justify-end gap-2">
        {!started && <button type="button" onClick={onBack} disabled={busy} className={BTN}>← Copys</button>}
        {started && !run.remaining && <button type="button" onClick={() => onDone(run)} className={BTN}>Voir la grille</button>}
        {started && run.remaining > 0 && <button type="button" onClick={() => void generate(true)} disabled={busy} className={BTN_PRIMARY}>{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wand2 className="w-4 h-4" />} Reprendre ({run.remaining} restant{run.remaining > 1 ? "s" : ""})</button>}
        {!started && <button type="button" onClick={() => void generate(false)} disabled={busy || !approved.length || price.over} className={BTN_PRIMARY} data-factory-generate>{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wand2 className="w-4 h-4" />} {busy ? "Génération…" : `Générer ${n} visuel${n > 1 ? "s" : ""}`}</button>}
      </div>
      {price.over && !started && <p className="text-xs text-rose-300">Le plafond du jour ne permet pas cette fabrique : réduisez le nombre de visuels ou demandez à un admin de relever le quota (Admin → Quotas). Dépense du jour : équipe {usd(quota?.today.team.usd ?? 0)}, toi {usd(quota?.today.user.usd ?? 0)}.</p>}
    </div>
  );
}
