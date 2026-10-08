"use client";

/**
 * Rubrique « Persona » of the Rapports IA space (staff only): the personas the
 * agency memory (HQ) holds for a client — projects/{slug}/brain/recherche/personas.md —
 * and the way to build them the HQ way: the consultant gives the customers'
 * words (reviews), the AI derives 5 to 7 prioritised avatars and the message
 * matrix (grid of HQ's skill analyse-avatar), the consultant corrects and
 * confirms, and only then is the file written to HQ with their name.
 * Without reviews the AI only writes marked hypotheses (HQ rule).
 */

import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";
import Link from "next/link";
import { CheckCircle2, FileText, Loader2, RefreshCw, Sparkles, Trash2, Upload, Users } from "lucide-react";
import { Card, Pill } from "@/components/ui/surface";
import { AiMarkdown } from "@/components/ai/ai-markdown";

type Frontmatter = { statut: "manquant" | "brouillon" | "a_confirmer" | "confirme"; source: string; maj: string; confirme_par: string; rafraichir_tous_les: string };
type HqPersona = { slug: string; path: string; frontmatter: Frontmatter; body: string; etag: string | null; lastModified: string | null; stale: boolean };
type Draft = { id: string; markdown: string; kind: string; inputs: { reviewsChars?: number; reviewsSource?: string; hqFiles?: string[]; ads?: number; notes?: string; hasExisting?: boolean }; createdAt: string; updatedAt: string };
type Data = { slug: string | null; hq: HqPersona | null; draft: Draft | null; warning: string | null; refreshDays: number };

const STATUS_LABEL: Record<Frontmatter["statut"], { label: string; tone: "default" | "violet" | "emerald" | "amber" | "red" | "blue" }> = {
  manquant: { label: "Manquant", tone: "default" },
  brouillon: { label: "Brouillon", tone: "blue" },
  a_confirmer: { label: "À confirmer", tone: "amber" },
  confirme: { label: "Confirmé", tone: "emerald" },
};

const MD_CLASS = "prose prose-invert prose-sm max-w-none text-gray-300";
const ACCEPTED = ".txt,.csv,.md,.json,.tsv,text/plain,text/csv,text/markdown,application/json";
const MAX_FILE_BYTES = 2 * 1024 * 1024;

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("fr-FR");
}

export function PersonaPanel({ dashboardId }: { dashboardId: string }) {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Generation form
  const [reviews, setReviews] = useState("");
  const [reviewsSource, setReviewsSource] = useState("");
  const [notes, setNotes] = useState("");
  const [generating, setGenerating] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const fileRef = useRef<HTMLInputElement | null>(null);

  // Editor (draft or HQ body being corrected)
  const [editing, setEditing] = useState<{ from: "draft" | "hq"; markdown: string } | null>(null);
  const [writing, setWriting] = useState<null | "a_confirmer" | "confirme">(null);
  const [showHq, setShowHq] = useState(true);

  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await fetch(`/api/dashboards/${dashboardId}/persona`);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? `Erreur ${r.status}`);
      setData(j);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [dashboardId]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!generating) return;
    const started = Date.now();
    setElapsed(0);
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(t);
  }, [generating]);

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    if (f.size > MAX_FILE_BYTES) { setError("Fichier trop lourd (2 Mo maximum). Collez un extrait, ou exportez en texte."); return; }
    try {
      const text = await f.text();
      setReviews((prev) => (prev.trim() ? `${prev.trim()}\n\n${text}` : text));
      if (!reviewsSource.trim()) setReviewsSource(f.name);
      setError(null);
    } catch {
      setError("Fichier illisible : collez le texte des avis.");
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const generate = async () => {
    if (generating) return;
    if (data?.draft && !window.confirm("Un brouillon existe déjà : le remplacer par une nouvelle génération ?")) return;
    setGenerating(true);
    setError(null);
    setNotice(null);
    try {
      const r = await fetch(`/api/dashboards/${dashboardId}/persona`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reviews, reviewsSource, notes }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? `Erreur ${r.status}`);
      setData((d) => (d ? { ...d, draft: j.draft } : d));
      setEditing(null);
      setNotice(j.draft?.kind === "hypothese"
        ? "Avis insuffisants : l'IA a rédigé des hypothèses de personas, à confirmer avec de vrais avis clients avant d'en faire la base d'un livrable."
        : "Brouillon rédigé. Relisez-le, corrigez, puis confirmez pour l'écrire dans HQ.");
      if (j.adsWarning) setNotice((n) => `${n ?? ""} ${j.adsWarning}`.trim());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setGenerating(false);
    }
  };

  const write = async (statut: "a_confirmer" | "confirme") => {
    if (!data?.slug || writing) return;
    const markdown = editing?.markdown ?? data.draft?.markdown ?? data.hq?.body ?? "";
    if (markdown.trim().length < 200) { setError("Rien à écrire : générez un brouillon d'abord."); return; }
    const question = statut === "confirme"
      ? "Confirmer ces personas et les écrire dans HQ avec votre nom ? Ils serviront de base aux rapports, briefs et wordings de ce client."
      : "Enregistrer ce texte dans HQ en statut « à confirmer » ?";
    if (!window.confirm(question)) return;
    setWriting(statut);
    setError(null);
    try {
      const r = await fetch(`/api/dashboards/${dashboardId}/persona`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ markdown, statut, etag: data.hq?.etag ?? null }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.status === 409) {
        setData((d) => (d ? { ...d, hq: j.hq ?? d.hq } : d));
        throw new Error(j.error ?? "Le fichier a changé dans HQ.");
      }
      if (!r.ok) throw new Error(j.error ?? `Erreur ${r.status}`);
      setEditing(null);
      setData((d) => (d ? { ...d, hq: j.hq, draft: null } : d));
      setNotice(statut === "confirme" ? "Personas confirmés et écrits dans HQ." : "Enregistré dans HQ, en attente de confirmation.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setWriting(null);
    }
  };

  const dropDraft = async () => {
    if (!data?.draft || !window.confirm("Supprimer ce brouillon ? (HQ n'est pas touché)")) return;
    await fetch(`/api/dashboards/${dashboardId}/persona`, { method: "DELETE" }).catch(() => undefined);
    setEditing(null);
    setData((d) => (d ? { ...d, draft: null } : d));
  };

  if (error && !data) return <p className="text-sm text-red-300">{error}</p>;
  if (!data) return <p className="text-sm text-gray-500 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Lecture du dossier HQ…</p>;

  const hq = data.hq;
  const draft = data.draft;
  const status = hq ? STATUS_LABEL[hq.frontmatter.statut] : null;
  const busy = generating || !!writing;

  return (
    <div className="space-y-4">
      <Card padded>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <Users className="w-4 h-4 text-violet-300" />
          <span className="text-white font-semibold">Personas</span>
          {status && <Pill tone={status.tone}>{status.label}</Pill>}
          {hq?.stale && <Pill tone="amber">À rafraîchir (plus de {data.refreshDays} j)</Pill>}
          <span className="text-xs text-gray-500">
            {data.slug
              ? <>Fichier HQ <code className="text-gray-400">projects/{data.slug}/brain/recherche/personas.md</code>{hq?.frontmatter.maj ? <>, mis à jour le {fmtDate(hq.frontmatter.maj)}</> : null}{hq?.frontmatter.confirme_par ? <>, confirmé par {hq.frontmatter.confirme_par}</> : null}.</>
              : <>Aucun dossier HQ rattaché : <Link href={`/portfolio/${dashboardId}`} className="text-violet-300 hover:text-white">renseigner le slug HQ dans la fiche client</Link> pour lire et écrire les personas.</>}
          </span>
        </div>
        <p className="text-xs text-gray-500 mt-2">
          Méthode HQ (skills client-brain et analyse-avatar) : les personas se déduisent de ce que les clients disent. Déposez des avis, l&apos;IA dérive 5 à 7 avatars priorisés et la matrice persona × message × preuve × objection, vous corrigez et confirmez. Sans avis, l&apos;IA n&apos;écrit que des hypothèses marquées comme telles.
        </p>
        {data.warning && <p className="text-xs text-amber-300 mt-2">{data.warning}</p>}
      </Card>

      {error && <div className="text-sm text-red-300 bg-red-950/40 border border-red-900/50 rounded-xl px-4 py-3">{error}</div>}
      {notice && <div className="text-sm text-emerald-200 bg-emerald-950/30 border border-emerald-900/50 rounded-xl px-4 py-3 flex justify-between gap-3"><span>{notice}</span><button type="button" onClick={() => setNotice(null)} className="text-gray-500 hover:text-white">✕</button></div>}

      {/* Draft written by the AI, or an edit in progress */}
      {(draft || editing) && (
        <Card padded>
          <div className="flex flex-wrap items-center gap-3 text-sm mb-3">
            <Sparkles className="w-4 h-4 text-violet-300" />
            <span className="text-white font-semibold">{editing?.from === "hq" ? "Correction du fichier HQ" : "Brouillon de l'IA"}</span>
            {draft && !editing && <Pill tone={draft.kind === "hypothese" ? "amber" : "blue"}>{draft.kind === "hypothese" ? "Hypothèses (sans avis)" : "Personas"}</Pill>}
            {draft && !editing && (
              <span className="text-xs text-gray-500">
                {fmtDate(draft.updatedAt)} · avis : {draft.inputs.reviewsChars ? `${Math.round(draft.inputs.reviewsChars / 1000)} k car.${draft.inputs.reviewsSource ? ` (${draft.inputs.reviewsSource})` : ""}` : "aucun"} · fichiers HQ lus : {draft.inputs.hqFiles?.length ?? 0} · créas Meta : {draft.inputs.ads ?? 0}
              </span>
            )}
            <div className="ml-auto flex flex-wrap gap-2">
              {!editing && draft && (
                <button type="button" onClick={() => setEditing({ from: "draft", markdown: draft.markdown })} className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-gray-800 hover:bg-gray-700 text-gray-200">Modifier</button>
              )}
              {editing && (
                <button type="button" onClick={() => setEditing(null)} className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-gray-800 hover:bg-gray-700 text-gray-200">Annuler</button>
              )}
              {data.slug && (
                <>
                  <button type="button" disabled={busy} onClick={() => write("a_confirmer")} className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-gray-800 hover:bg-gray-700 text-gray-200 disabled:opacity-50 inline-flex items-center gap-1">
                    {writing === "a_confirmer" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FileText className="w-3.5 h-3.5" />} Enregistrer dans HQ (à confirmer)
                  </button>
                  <button type="button" disabled={busy} onClick={() => write("confirme")} className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-50 inline-flex items-center gap-1">
                    {writing === "confirme" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />} Confirmer et écrire dans HQ
                  </button>
                </>
              )}
              {draft && !editing && (
                <button type="button" disabled={busy} onClick={dropDraft} className="px-2 py-1.5 rounded-lg text-xs text-gray-500 hover:text-red-300 inline-flex items-center gap-1" title="Supprimer le brouillon"><Trash2 className="w-3.5 h-3.5" /></button>
              )}
            </div>
          </div>
          {editing ? (
            <textarea
              value={editing.markdown}
              onChange={(e) => setEditing({ ...editing, markdown: e.target.value })}
              rows={28}
              spellCheck={false}
              className="w-full bg-gray-950 border border-gray-800 rounded-xl px-3 py-2 text-xs font-mono text-gray-200 focus:outline-none focus:border-violet-600"
            />
          ) : draft ? (
            <AiMarkdown content={draft.markdown} filesBase={null} className={`${MD_CLASS} bg-gray-950/60 border border-gray-800 rounded-xl px-4 py-3`} />
          ) : null}
        </Card>
      )}

      {/* Generation */}
      <Card padded>
        <div className="flex flex-wrap items-center gap-3 text-sm mb-3">
          <Sparkles className="w-4 h-4 text-violet-300" />
          <span className="text-white font-semibold">{hq ? "Regénérer ou compléter avec l'IA" : "Générer avec l'IA"}</span>
          <span className="text-xs text-gray-500">L&apos;IA lit aussi le dossier HQ du client (langage client, voix, contexte, concurrents) et les textes des créas Meta des 90 derniers jours.</span>
        </div>
        <div className="grid gap-3 md:grid-cols-[2fr_1fr]">
          <div className="space-y-2">
            <label className="text-xs text-gray-400 flex items-center justify-between">
              <span>Avis clients (Trustpilot, Google, Amazon, App Store, SAV, verbatims d&apos;appels…)</span>
              <span className="text-gray-600">{reviews.length ? `${reviews.length.toLocaleString("fr-FR")} car.` : ""}</span>
            </label>
            <textarea
              value={reviews}
              onChange={(e) => setReviews(e.target.value)}
              rows={8}
              placeholder="Collez ici les avis bruts (un avis par ligne ou par paragraphe), ou déposez un export .txt / .csv. Plus il y en a, plus les personas sont solides : 1 500 caractères minimum pour sortir du mode « hypothèses »."
              className="w-full bg-gray-950 border border-gray-800 rounded-xl px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-violet-600"
            />
            <div className="flex flex-wrap items-center gap-2">
              <input ref={fileRef} type="file" accept={ACCEPTED} onChange={onFile} className="hidden" id={`persona-file-${dashboardId}`} />
              <label htmlFor={`persona-file-${dashboardId}`} className="cursor-pointer px-3 py-1.5 rounded-lg text-xs font-semibold bg-gray-800 hover:bg-gray-700 text-gray-200 inline-flex items-center gap-1"><Upload className="w-3.5 h-3.5" /> Déposer un export (.txt, .csv, .md)</label>
              <input
                value={reviewsSource}
                onChange={(e) => setReviewsSource(e.target.value)}
                placeholder="Provenance (ex. Trustpilot, 320 avis, 2026)"
                className="flex-1 min-w-[200px] bg-gray-950 border border-gray-800 rounded-lg px-3 py-1.5 text-xs text-gray-200 focus:outline-none focus:border-violet-600"
              />
            </div>
          </div>
          <div className="space-y-2">
            <label className="text-xs text-gray-400">Consignes (facultatif)</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={8}
              placeholder="Ex. : se concentrer sur l'offre B2B ; le persona « parent » est déjà validé, ne pas le refaire ; marché FR + BE…"
              className="w-full bg-gray-950 border border-gray-800 rounded-xl px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-violet-600"
            />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3 mt-3">
          <button type="button" disabled={busy} onClick={generate} className="px-4 py-2 rounded-lg text-sm font-semibold bg-violet-600 hover:bg-violet-500 text-white disabled:opacity-50 inline-flex items-center gap-2">
            {generating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
            {generating ? `Rédaction en cours… ${elapsed} s` : hq ? "Regénérer un brouillon" : "Générer un brouillon"}
          </button>
          {!reviews.trim() && <span className="text-xs text-amber-300">Sans avis, le résultat sera marqué « hypothèses » et ne pourra pas être confirmé comme persona.</span>}
          {generating && <span className="text-xs text-gray-500">Comptez 2 à 4 minutes. Le brouillon n&apos;est pas écrit dans HQ tant que vous ne le confirmez pas.</span>}
        </div>
      </Card>

      {/* What HQ holds today */}
      {hq && (
        <Card padded>
          <div className="flex flex-wrap items-center gap-3 text-sm mb-3">
            <FileText className="w-4 h-4 text-violet-300" />
            <span className="text-white font-semibold">Dans HQ aujourd&apos;hui</span>
            {status && <Pill tone={status.tone}>{status.label}</Pill>}
            {hq.frontmatter.source && <span className="text-xs text-gray-500">source : {hq.frontmatter.source}</span>}
            <div className="ml-auto flex flex-wrap gap-2">
              <button type="button" onClick={() => void load()} className="px-2 py-1.5 rounded-lg text-xs text-gray-400 hover:text-white inline-flex items-center gap-1" title="Relire HQ"><RefreshCw className="w-3.5 h-3.5" /></button>
              <button type="button" onClick={() => setShowHq((v) => !v)} className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-gray-800 hover:bg-gray-700 text-gray-200">{showHq ? "Replier" : "Afficher"}</button>
              {!editing && (
                <button type="button" disabled={busy} onClick={() => setEditing({ from: "hq", markdown: hq.body })} className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-gray-800 hover:bg-gray-700 text-gray-200 disabled:opacity-50">Corriger</button>
              )}
              {hq.frontmatter.statut !== "confirme" && !editing && !draft && (
                <button type="button" disabled={busy} onClick={() => write("confirme")} className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-50 inline-flex items-center gap-1">
                  {writing === "confirme" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />} Confirmer tel quel
                </button>
              )}
            </div>
          </div>
          {showHq && <AiMarkdown content={hq.body} filesBase={null} className={`${MD_CLASS} bg-gray-950/60 border border-gray-800 rounded-xl px-4 py-3`} />}
        </Card>
      )}

      {!hq && data.slug && !draft && (
        <p className="text-xs text-gray-500">Aucun fichier personas.md dans le dossier HQ de ce client pour l&apos;instant.</p>
      )}
    </div>
  );
}
