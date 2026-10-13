"use client";

/**
 * Nouveau dashboard du staff : décrit à l'IA (le copilote construit la page
 * à partir du brief), à partir d'un modèle livré avec l'application, ou collé
 * depuis Claude (jeux de données JSON + paramètres + page HTML).
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, ClipboardPaste, LayoutTemplate, Loader2, Sparkles } from "lucide-react";
import { Card, PageHeader } from "@/components/ui/surface";
import { FIELD, MONO_FIELD, PRIMARY_BUTTON, SMALL_BUTTON, apiErrorText, parseJsonField, type TemplateInfo } from "@/components/staff-dashboards/model";
import { STAFF_DASHBOARDS_DRIVE_FOLDER_URL } from "@/lib/staff-dashboards/drive";

type Tab = "ai" | "template" | "import";

const BRIEF_PLACEHOLDER = `Ex. : Pacing budget Google Ads du client Liferay (compte 973-316-6788, en USD) par marché : dépensé depuis le 1er vs budget du mois (onglet Pays du Google Sheet https://docs.google.com/spreadsheets/d/…), projection fin de mois, alertes de sous/sur-pacing, tableau des campagnes avec budget/jour recommandé.`;

const DATASETS_PLACEHOLDER = `{
  "g_spend": {
    "title": "…",
    "description": "…",
    "source": { "kind": "query", "connector": "n8n google ads", "tool": "Custom_GAQL_Query", "args": { … } }
  }
}`;

export default function NewStaffDashboardPage() {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("ai");
  const [brief, setBrief] = useState("");
  const [templates, setTemplates] = useState<TemplateInfo[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ text: string; details: string[] } | null>(null);

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [datasetsText, setDatasetsText] = useState("");
  const [paramsText, setParamsText] = useState("");
  const [html, setHtml] = useState("");
  const [shared, setShared] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/staff-dashboards")
      .then(async (r) => {
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(apiErrorText(body, r.status));
        return body;
      })
      .then((j) => {
        if (cancelled) return;
        const list = (Array.isArray(j.templates) ? j.templates : []) as TemplateInfo[];
        setTemplates(list.filter((t) => t && typeof t.key === "string"));
      })
      .catch((e) => { if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, []);

  async function create(payload: Record<string, unknown>, key: string, after?: (id: string) => void) {
    setBusy(key);
    setError(null);
    try {
      const res = await fetch("/api/staff-dashboards", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        const details = Array.isArray(body.errors) ? body.errors.filter((x: unknown): x is string => typeof x === "string") : [];
        setError({ text: typeof body.error === "string" ? body.error : `Erreur ${res.status}`, details });
        return;
      }
      if (typeof body.id !== "string") { setError({ text: "Réponse illisible du serveur", details: [] }); return; }
      after?.(body.id);
      router.push(after ? `/dashboards/${body.id}?copilot=1` : `/dashboards/${body.id}`);
    } catch (e) {
      setError({ text: e instanceof Error ? e.message : String(e), details: [] });
    } finally {
      setBusy(null);
    }
  }

  const datasetsParsed = parseJsonField("Jeux de données", datasetsText);
  const paramsParsed = parseJsonField("Paramètres", paramsText);
  const canImport = !!title.trim() && !datasetsParsed.error && !paramsParsed.error && !busy;

  function submitImport(e: React.FormEvent) {
    e.preventDefault();
    if (!canImport) return;
    void create({
      title: title.trim(),
      description: description.trim(),
      datasets: datasetsParsed.value ?? {},
      params: paramsParsed.value ?? {},
      html,
      shared,
    }, "import");
  }

  const canDescribe = !!title.trim() && brief.trim().length >= 10 && !busy;

  function submitDescribe(e: React.FormEvent) {
    e.preventDefault();
    if (!canDescribe) return;
    const text = brief.trim();
    // Le dashboard naît vide ; le brief part au copilote dès l'ouverture de la page
    // (sessionStorage : pas d'adresse interminable, lu une seule fois).
    void create({ title: title.trim(), description: description.trim(), html: "", shared }, "ai", (id) => {
      try { sessionStorage.setItem(`staff-dashboard-brief:${id}`, text); } catch { /* stockage indisponible */ }
    });
  }

  const TABS: Array<{ key: Tab; label: string; icon: React.ElementType }> = [
    { key: "ai", label: "Décrire à l'IA", icon: Sparkles },
    { key: "template", label: "Partir d'un modèle", icon: LayoutTemplate },
    { key: "import", label: "Importer depuis Claude", icon: ClipboardPaste },
  ];

  return (
    <div className="p-4 sm:p-6 max-w-4xl mx-auto space-y-5">
      <Link href="/dashboards" className="inline-flex items-center gap-1.5 text-xs text-gray-400 hover:text-white">
        <ArrowLeft className="w-3.5 h-3.5" /> Mes dashboards
      </Link>
      <PageHeader title="Nouveau dashboard" subtitle="Décrit à l'IA, à partir d'un modèle prêt à l'emploi, ou collé depuis Claude." />

      <div role="tablist" aria-label="Mode de création" className="flex gap-1">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => { setTab(t.key); setError(null); }}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium whitespace-nowrap transition-colors ${tab === t.key ? "bg-violet-600 text-white" : "text-gray-400 hover:text-gray-100 hover:bg-gray-800"}`}
          >
            <t.icon className="w-3.5 h-3.5" /> {t.label}
          </button>
        ))}
      </div>

      {error && (
        <div role="alert" className="text-sm text-red-300 bg-red-950/30 border border-red-900/50 rounded-xl px-4 py-3">
          <p>{error.text}</p>
          {error.details.length > 1 && (
            <ul className="list-disc pl-5 mt-1 text-xs text-red-300/90 space-y-0.5">
              {error.details.map((d, i) => <li key={i}>{d}</li>)}
            </ul>
          )}
        </div>
      )}

      {tab === "ai" && (
        <form onSubmit={submitDescribe} className="space-y-4">
          <Card padded className="space-y-4">
            <div className="text-xs text-gray-400 leading-relaxed bg-gray-950/50 border border-gray-800 rounded-lg px-3 py-2">
              Décrivez la page comme à un collègue : le client et ses comptes (identifiant Google Ads, act_… Meta, annonceur TikTok), les Google Sheets à lire (lien + onglet, partagés avec data@impulse-analytics.com), les indicateurs, alertes et tableaux attendus.
              Le copilote s&apos;ouvre sur le dashboard, interroge les vraies sources, puis construit les jeux de données et la page directement, comme un artefact : vous itérez avec lui, chaque version est gardée.
              {STAFF_DASHBOARDS_DRIVE_FOLDER_URL && (
                <>
                  {" "}Des fichiers à lui faire lire (CSV, Excel, Sheets) ? Déposez-les dans le{" "}
                  <a href={STAFF_DASHBOARDS_DRIVE_FOLDER_URL} target="_blank" rel="noreferrer" className="text-violet-300 underline decoration-dotted hover:text-white">dossier Drive des dashboards</a>
                  {" "}et nommez-les dans le brief.
                </>
              )}
            </div>
            <label className="block">
              <span className="text-xs font-medium text-gray-300">Titre <span className="text-red-400">*</span></span>
              <input value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={120} className={`${FIELD} mt-1`} placeholder="Liferay – Pilotage budget par marché" />
            </label>
            <label className="block">
              <span className="text-xs font-medium text-gray-300">Description <span className="text-gray-500 font-normal">(facultatif)</span></span>
              <input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} className={`${FIELD} mt-1`} placeholder="Ce que la page montre, pour qui." />
            </label>
            <label className="block">
              <span className="text-xs font-medium text-gray-300">Brief pour l&apos;IA <span className="text-red-400">*</span></span>
              <textarea value={brief} onChange={(e) => setBrief(e.target.value)} rows={8} maxLength={20000} className={`${FIELD} mt-1 min-h-[160px]`} placeholder={BRIEF_PLACEHOLDER} />
            </label>
            <label className="flex items-center gap-2 text-xs text-gray-300 w-fit">
              <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} className="accent-violet-600" />
              Partager avec toute l&apos;équipe (lecture)
            </label>
          </Card>
          <div className="flex items-center gap-3">
            <button type="submit" disabled={!canDescribe} className={PRIMARY_BUTTON}>
              {busy === "ai" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />} Créer et ouvrir le copilote
            </button>
            {(!title.trim() || brief.trim().length < 10) && <span className="text-xs text-gray-500">Un titre et un brief sont requis.</span>}
          </div>
        </form>
      )}

      {tab === "template" && (
        <Card padded className="space-y-3">
          <h2 className="text-sm font-semibold text-white">Modèles livrés avec l&apos;application</h2>
          {loadError && <p className="text-sm text-red-400">Les modèles n&apos;ont pas pu être chargés ({loadError}).</p>}
          {templates === null && !loadError && (
            <div className="flex items-center gap-2 text-gray-500 text-sm"><Loader2 className="w-4 h-4 animate-spin" /> Chargement…</div>
          )}
          {templates !== null && templates.length === 0 && <p className="text-sm text-gray-400">Aucun modèle disponible.</p>}
          <div className="grid grid-cols-1 gap-3">
            {templates?.map((t) => (
              <Card key={t.key} padded className="bg-gray-950/50 flex flex-col sm:flex-row sm:items-center gap-3">
                <div className="min-w-0 flex-1">
                  <h3 className="text-sm font-semibold text-white">{t.title}</h3>
                  <p className="text-xs text-gray-400 mt-1 leading-relaxed">{t.description}</p>
                </div>
                <button
                  type="button"
                  disabled={!!busy}
                  onClick={() => void create({ template: t.key }, t.key)}
                  className={`${SMALL_BUTTON} bg-violet-600 hover:bg-violet-500 text-white shrink-0`}
                >
                  {busy === t.key ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null} Créer à partir de ce modèle
                </button>
              </Card>
            ))}
          </div>
        </Card>
      )}

      {tab === "import" && (
        <form onSubmit={submitImport} className="space-y-4">
          <Card padded className="space-y-4">
            <div className="text-xs text-gray-400 leading-relaxed bg-gray-950/50 border border-gray-800 rounded-lg px-3 py-2">
              Dans Claude (type Dashboard), demandez : « Donne-moi le contenu de chaque datasets/&lt;id&gt;, de dash/params et de files/index.html » puis collez ici.
              Connecteurs reconnus : n8n google ads / Google Ads, mcp facebook / Meta, n8n google spreadsheet / Google Sheets, GA4, TikTok, Merchant Center.
            </div>

            <label className="block">
              <span className="text-xs font-medium text-gray-300">Titre <span className="text-red-400">*</span></span>
              <input value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={120} className={`${FIELD} mt-1`} placeholder="Pacing budget — Cours Legendre" />
            </label>

            <label className="block">
              <span className="text-xs font-medium text-gray-300">Description <span className="text-gray-500 font-normal">(facultatif)</span></span>
              <input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} className={`${FIELD} mt-1`} placeholder="Ce que la page montre, pour qui." />
            </label>

            <label className="block">
              <span className="text-xs font-medium text-gray-300">Jeux de données (JSON)</span>
              <textarea value={datasetsText} onChange={(e) => setDatasetsText(e.target.value)} rows={10} spellCheck={false} className={`${MONO_FIELD} mt-1`} placeholder={DATASETS_PLACEHOLDER} />
              {datasetsParsed.error && <span className="block text-xs text-red-400 mt-1">{datasetsParsed.error}</span>}
            </label>

            <label className="block">
              <span className="text-xs font-medium text-gray-300">Paramètres (JSON, facultatif)</span>
              <textarea value={paramsText} onChange={(e) => setParamsText(e.target.value)} rows={3} spellCheck={false} className={`${MONO_FIELD} mt-1`} placeholder={'{ "region": null }'} />
              {paramsParsed.error && <span className="block text-xs text-red-400 mt-1">{paramsParsed.error}</span>}
            </label>

            <label className="block">
              <span className="text-xs font-medium text-gray-300">Page (HTML)</span>
              <span className="block text-[11px] text-gray-500">Le contenu de files/index.html : style, balisage et scripts. Elle tourne dans un cadre isolé avec le runtime <code>dash</code>.</span>
              <textarea value={html} onChange={(e) => setHtml(e.target.value)} rows={14} spellCheck={false} maxLength={262144} className={`${MONO_FIELD} mt-1 min-h-[300px]`} placeholder={"<style>…</style>\n<div class=\"grid\">…</div>\n<script>dash.onData(() => { … });</script>"} />
            </label>

            <label className="flex items-center gap-2 text-xs text-gray-300 w-fit">
              <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} className="accent-violet-600" />
              Partager avec toute l&apos;équipe (lecture)
            </label>
          </Card>

          <div className="flex items-center gap-3">
            <button type="submit" disabled={!canImport} className={PRIMARY_BUTTON}>
              {busy === "import" ? <Loader2 className="w-4 h-4 animate-spin" /> : null} Créer le dashboard
            </button>
            {!title.trim() && <span className="text-xs text-gray-500">Un titre est requis.</span>}
          </div>
        </form>
      )}
    </div>
  );
}
