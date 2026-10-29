"use client";

/**
 * /creas — the creatives of a client, in one place:
 *   « Créas »             every visual the AI made for the client (Studio, copies of templates, variations),
 *                         with the consultant's verdict (garder / couper + note → HQ) and the next moves
 *                         (textes & logo, FigCraft, PhotoCraft, Meta, plus comme ça).
 *   « Templates »         the swipe file: competitors' ads (capture, link, Meta Ad Library), the client's own
 *                         winners (Analyse Ads → « Garder comme template »), read by the AI → « Copier à la marque ».
 *   « Éléments de marque » logos and product photos kept as references for the copies.
 *   « Fabrique »          the statics factory: templates ticked → copies written by the AI and validated → a batch of
 *                         visuals → a grid with verdicts and feedback (components/creas/factory-*.tsx).
 * Deep links: ?client=<id>&tab=templates&template=<id> · ?asset=<id> · ?tab=fabrique&run=<id>.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { BookOpen, BookmarkPlus, Check, Download, ExternalLink, Factory, Images, Loader2, PenTool, Plus, RefreshCw, Scissors, Send, Sparkles, Trash2, Type, Wand2, X } from "lucide-react";
import { PageHeader, Pill } from "@/components/ui/surface";
import { TextEditor } from "@/components/studio/text-editor";
import { SOURCE_LABEL, shouldSuggestRetire } from "@/lib/creas/model";
import { AddTemplateDialog, CopyDialog, VariationDialog, BrandAssetUpload } from "./dialogs";
import { FactoryTab } from "./factory-tab";
import { PlaybookDialog } from "./playbook-dialog";
import { TemplateFeedbackList } from "./factory-grid";
import { BTN, BTN_PRIMARY, FIELD, ORIGIN_LABEL, aspect, matchClient, usd, when, type Asset, type ClientOption, type Engine, type QuotaInfo, type Template } from "./shared";

type Tab = "creas" | "templates" | "assets" | "fabrique";
type Verdict = "all" | "keep" | "cut" | "todo";

export function CreasPage() {
  const router = useRouter();
  const params = useSearchParams();
  const [clients, setClients] = useState<ClientOption[]>([]);
  const [client, setClient] = useState<ClientOption | null>(null);
  const [tab, setTab] = useState<Tab>((params.get("tab") as Tab) || "creas");
  const [assets, setAssets] = useState<Asset[] | null>(null);
  const [brandAssets, setBrandAssets] = useState<Asset[]>([]);
  const [templates, setTemplates] = useState<Template[] | null>(null);
  const [engines, setEngines] = useState<Engine[]>([]);
  const [quota, setQuota] = useState<QuotaInfo | null>(null);
  const [verdict, setVerdict] = useState<Verdict>("all");
  const [openAsset, setOpenAsset] = useState<Asset | null>(null);
  const [openTemplate, setOpenTemplate] = useState<Template | null>(null);
  const [adding, setAdding] = useState(false);
  const [studying, setStudying] = useState(false);
  const [copying, setCopying] = useState<Template | null>(null);
  const [varying, setVarying] = useState<Asset | null>(null);
  const [editing, setEditing] = useState<Asset | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Fabrique: templates ticked on the Templates tab, the run open in the URL.
  const [selected, setSelected] = useState<string[]>([]);
  const [preselected, setPreselected] = useState<string[]>([]);
  const [runId, setRunId] = useState<string | null>(params.get("run"));

  // Clients (registry): the one in the URL, else the first.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/clients").then((r) => (r.ok ? r.json() : { clients: [] })).then((j: { clients: ClientOption[] }) => {
      if (cancelled) return;
      const list = (j.clients ?? []).map((c) => ({ id: c.id, clientId: c.clientId, aliasIds: c.aliasIds ?? [], name: c.name, dashboardId: c.dashboardId ?? null, hqSlug: c.hqSlug ?? null }));
      setClients(list);
      setClient(matchClient(list, params.get("client")) ?? list[0] ?? null);
    }).catch(() => undefined);
    fetch("/api/studio/engines").then((r) => (r.ok ? r.json() : null)).then((j: { engines: Engine[] } | null) => { if (!cancelled && j) setEngines(j.engines); }).catch(() => undefined);
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadQuota = useCallback(() => { fetch("/api/studio/quota", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).then((j) => { if (j) setQuota(j); }).catch(() => undefined); }, []);
  useEffect(() => { loadQuota(); }, [loadQuota]);

  const load = useCallback(async (c: ClientOption) => {
    setError(null);
    const [a, b, t] = await Promise.all([
      fetch(`/api/studio/assets?clientId=${c.clientId}&origin=generated&take=200`, { cache: "no-store" }).then((r) => (r.ok ? r.json() : { assets: [] })).catch(() => ({ assets: [] })),
      fetch(`/api/studio/assets?clientId=${c.clientId}&origin=asset&take=60`, { cache: "no-store" }).then((r) => (r.ok ? r.json() : { assets: [] })).catch(() => ({ assets: [] })),
      fetch(`/api/creas/templates?client=${c.clientId}`, { cache: "no-store" }).then((r) => (r.ok ? r.json() : { templates: [] })).catch(() => ({ templates: [] })),
    ]);
    setAssets((a.assets ?? []) as Asset[]);
    setBrandAssets((b.assets ?? []) as Asset[]);
    setTemplates((t.templates ?? []) as Template[]);
  }, []);

  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    const current = client;
    queueMicrotask(() => {
      if (cancelled) return;
      setAssets(null); setTemplates(null);
      void load(current);
    });
    const url = new URLSearchParams(Array.from(params.entries()));
    url.set("client", client.id);
    router.replace(`/creas?${url.toString()}`);
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client?.id]);

  // The tab and the open fabrique live in the URL (deep links from HQ, Mo, Slack).
  // Shallow (no server round-trip): the page already has everything, only the address changes.
  const setRunUrl = useCallback((id: string | null) => {
    setRunId(id);
    const url = new URLSearchParams(window.location.search);
    url.set("tab", "fabrique");
    if (id) url.set("run", id); else url.delete("run");
    window.history.replaceState(null, "", `/creas?${url.toString()}`);
  }, []);
  function switchTab(t: Tab) {
    setTab(t);
    const url = new URLSearchParams(window.location.search);
    url.set("tab", t);
    if (t !== "fabrique") url.delete("run");
    window.history.replaceState(null, "", `/creas?${url.toString()}`);
  }

  // Deep links to a template or an asset, once loaded.
  useEffect(() => {
    const t = params.get("template"); const a = params.get("asset");
    queueMicrotask(() => {
      if (t && templates && !openTemplate) { const found = templates.find((x) => x.id === t); if (found) { setTab("templates"); setOpenTemplate(found); } }
      if (a && assets && !openAsset) { const found = assets.find((x) => x.id === a); if (found) setOpenAsset(found); }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templates, assets]);

  useEffect(() => { if (!notice) return; const t = setTimeout(() => setNotice(null), 6000); return () => clearTimeout(t); }, [notice]);

  const shownAssets = useMemo(() => (assets ?? []).filter((a) => verdict === "all" ? true : verdict === "keep" ? a.feedback === "keep" : verdict === "cut" ? a.feedback === "cut" : !a.feedback), [assets, verdict]);
  const templateName = useCallback((id: string | null) => (id ? templates?.find((t) => t.id === id)?.name ?? null : null), [templates]);

  async function setFeedback(a: Asset, feedback: "keep" | "cut" | null, note?: string) {
    const res = await fetch(`/api/studio/assets/${a.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ feedback, ...(note !== undefined ? { feedbackNote: note } : {}) }) });
    const j = (await res.json().catch(() => ({}))) as { asset?: Asset; hq?: { ok: boolean; error?: string }; error?: string };
    if (!res.ok || !j.asset) { setError(j.error ?? `Erreur ${res.status}`); return; }
    setAssets((l) => (l ?? []).map((x) => (x.id === j.asset!.id ? j.asset! : x)));
    setOpenAsset((o) => (o?.id === j.asset!.id ? j.asset! : o));
    if (feedback || note) setNotice(j.hq?.ok ? "Retour enregistré et noté dans la mémoire HQ du client." : `Retour enregistré${j.hq?.error ? ` (${j.hq.error})` : ""}.`);
  }

  async function openIn(editor: "figcraft" | "photocraft", src: { templateId?: string; assetId?: string }) {
    setError(null);
    const res = await fetch("/api/creas/open", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ editor, ...src, clientId: client?.dashboardId ?? client?.clientId }) });
    const j = (await res.json().catch(() => ({}))) as { designId?: string; ask?: string | null; error?: string };
    if (!res.ok || !j.designId) { setError(j.error ?? `Erreur ${res.status}`); return; }
    router.push(`/design/${j.designId}${j.ask ? `?ask=${encodeURIComponent(j.ask)}` : ""}`);
  }

  async function removeAsset(a: Asset) {
    if (!confirm("Retirer ce visuel ?")) return;
    const res = await fetch(`/api/studio/assets/${a.id}`, { method: "DELETE" });
    if (res.ok) { setAssets((l) => (l ?? []).filter((x) => x.id !== a.id)); setBrandAssets((l) => l.filter((x) => x.id !== a.id)); setOpenAsset(null); }
  }
  async function removeTemplate(t: Template) {
    if (!confirm("Retirer ce template du swipe file ? Les visuels déjà générés restent.")) return;
    const res = await fetch(`/api/creas/templates/${t.id}`, { method: "DELETE" });
    if (res.ok) { setTemplates((l) => (l ?? []).filter((x) => x.id !== t.id)); setOpenTemplate(null); }
  }
  async function retire(t: Template, retired: boolean) {
    const res = await fetch(`/api/creas/templates/${t.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ retired }) });
    const j = (await res.json().catch(() => ({}))) as { template?: Template; error?: string };
    if (!res.ok || !j.template) { setError(j.error ?? `Erreur ${res.status}`); return; }
    setTemplates((l) => (l ?? []).map((x) => (x.id === j.template!.id ? j.template! : x))); setOpenTemplate(j.template);
    setNotice(retired ? `« ${t.name} » ne sera plus proposé dans les nouvelles fabriques.` : `« ${t.name} » est de nouveau proposé dans les fabriques.`);
  }

  async function reanalyse(t: Template) {
    const res = await fetch(`/api/creas/templates/${t.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reanalyse: true }) });
    const j = (await res.json().catch(() => ({}))) as { template?: Template };
    if (res.ok && j.template) { setTemplates((l) => (l ?? []).map((x) => (x.id === j.template!.id ? j.template! : x))); setOpenTemplate(j.template); }
  }

  const tabBtn = (t: Tab, label: string, count?: number) => (
    <button key={t} type="button" onClick={() => switchTab(t)} data-tab={t} className={`px-3 py-1.5 rounded-lg text-sm border ${tab === t ? "bg-violet-600 border-violet-500 text-white" : "border-gray-800 text-gray-300 hover:text-white"}`}>{label}{typeof count === "number" ? <span className="ml-1.5 text-[11px] opacity-70">{count}</span> : null}</button>
  );

  return (
    <div className="p-4 md:p-6 max-w-7xl mx-auto space-y-5">
      <PageHeader
        title="Créas"
        subtitle="Tout ce que l'IA a créé pour un client, ses templates (concurrents et gagnantes) et ses éléments de marque. Chaque génération rappelle son prix."
        action={
          <div className="flex items-center gap-2">
            <select value={client?.id ?? ""} onChange={(e) => setClient(clients.find((c) => c.id === e.target.value) ?? null)} className={`${FIELD} max-w-[18rem]`}>
              {!clients.length && <option value="">Chargement…</option>}
              {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            {client && <Link href={`/portfolio/${client.id}`} className={BTN} title="Cockpit du client"><ExternalLink className="w-4 h-4" /> Client</Link>}
          </div>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        {tabBtn("creas", "Créas générées", assets?.length)}
        {tabBtn("templates", "Templates & concurrents", templates?.length)}
        {tabBtn("assets", "Éléments de marque", brandAssets.length)}
        {tabBtn("fabrique", "Fabrique")}
        <div className="ml-auto flex items-center gap-2">
          {quota && <span className="text-[11px] text-gray-500" title="Dépense du jour (jour de Paris) et plafonds posés par les admins">Aujourd&apos;hui : équipe {usd(quota.today.team.usd)}{quota.quotas.teamDailyUsd > 0 ? ` / ${usd(quota.quotas.teamDailyUsd)}` : ""} · toi {usd(quota.today.user.usd)}{quota.quotas.userDailyUsd > 0 ? ` / ${usd(quota.quotas.userDailyUsd)}` : ""}</span>}
          <button type="button" onClick={() => { if (client) void load(client); loadQuota(); }} className="text-gray-500 hover:text-white" title="Actualiser"><RefreshCw className="w-4 h-4" /></button>
          {tab === "templates" && <button type="button" onClick={() => setStudying(true)} className={BTN} data-playbook-open><BookOpen className="w-4 h-4" /> Étudier une marque</button>}
          {tab === "templates" && <button type="button" onClick={() => setAdding(true)} className={BTN_PRIMARY}><Plus className="w-4 h-4" /> Ajouter un template</button>}
          {tab === "creas" && <Link href={`/studio${client ? `?client=${client.clientId}` : ""}`} className={BTN}><Wand2 className="w-4 h-4" /> Studio</Link>}
        </div>
      </div>

      {notice && <p className="text-sm text-emerald-300">{notice}</p>}
      {error && <p className="text-sm text-rose-300">{error}</p>}

      {/* ── Créas ─────────────────────────────────────────────────────── */}
      {tab === "creas" && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            {([["all", "Toutes"], ["todo", "À trier"], ["keep", "Gardées"], ["cut", "Coupées"]] as const).map(([v, l]) => (
              <button key={v} type="button" onClick={() => setVerdict(v)} className={`px-2.5 py-1 rounded-md border ${verdict === v ? "border-violet-500 text-white" : "border-gray-800 text-gray-400 hover:text-white"}`}>{l}</button>
            ))}
          </div>
          {assets === null ? <p className="text-sm text-gray-500 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Lecture…</p>
          : shownAssets.length === 0 ? (
            <div className="rounded-xl border border-dashed border-gray-800 p-8 text-center text-sm text-gray-500 space-y-2">
              <Images className="w-6 h-6 mx-auto text-gray-600" />
              <p>{assets.length ? "Rien dans ce filtre." : `Aucun visuel généré pour ${client?.name ?? "ce client"} pour l'instant.`}</p>
              {!assets.length && <p>Commencez par un template (onglet « Templates & concurrents » → « Copier à la marque ») ou par le <Link href="/studio" className="text-violet-400">Studio</Link>.</p>}
            </div>
          ) : (
            <ul className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
              {shownAssets.map((a) => (
                <li key={a.id} className={`group rounded-xl border overflow-hidden bg-gray-950 ${a.feedback === "keep" ? "border-emerald-500/50" : a.feedback === "cut" ? "border-rose-500/40 opacity-70" : "border-gray-800 hover:border-violet-500/60"}`}>
                  <button type="button" onClick={() => setOpenAsset(a)} className="w-full text-left">
                    <div className="relative bg-gray-900" style={{ aspectRatio: aspect(a.params.ratio) }}>
                      {a.url ? (a.kind === "video" ? <video src={a.url} className="w-full h-full object-cover" muted loop playsInline onMouseEnter={(e) => void e.currentTarget.play()} onMouseLeave={(e) => e.currentTarget.pause()} /> : <img src={a.url} alt={a.prompt} className="w-full h-full object-cover" loading="lazy" />) : <div className="w-full h-full flex items-center justify-center text-xs text-gray-500">{a.status === "failed" ? "Échec" : "En cours…"}</div>}
                      <span className="absolute top-1.5 left-1.5"><Pill className="text-[10px]">{a.origin === "template" ? templateName(a.templateId) ?? "Template" : ORIGIN_LABEL[a.origin] ?? a.origin}</Pill></span>
                      {a.feedback && <span className={`absolute top-1.5 right-1.5 w-6 h-6 rounded-full inline-flex items-center justify-center ${a.feedback === "keep" ? "bg-emerald-500 text-white" : "bg-rose-500 text-white"}`}>{a.feedback === "keep" ? <Check className="w-3.5 h-3.5" /> : <Scissors className="w-3.5 h-3.5" />}</span>}
                    </div>
                    <div className="px-2.5 py-2">
                      <p className="text-xs text-gray-200 line-clamp-2">{a.prompt}</p>
                      <p className="text-[10px] text-gray-500">{a.createdByName} · {when(a.createdAt)}{a.costUsd > 0 ? ` · ${usd(a.costUsd)}` : ""}</p>
                    </div>
                  </button>
                  <div className="flex items-center gap-1 px-2 pb-2 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button type="button" onClick={() => void setFeedback(a, a.feedback === "keep" ? null : "keep")} className={`flex-1 inline-flex items-center justify-center gap-1 px-2 py-1 rounded-md text-[11px] border ${a.feedback === "keep" ? "border-emerald-500 text-emerald-200" : "border-gray-800 text-gray-300 hover:text-white"}`}><Check className="w-3 h-3" /> Garder</button>
                    <button type="button" onClick={() => void setFeedback(a, a.feedback === "cut" ? null : "cut")} className={`flex-1 inline-flex items-center justify-center gap-1 px-2 py-1 rounded-md text-[11px] border ${a.feedback === "cut" ? "border-rose-500 text-rose-200" : "border-gray-800 text-gray-300 hover:text-white"}`}><Scissors className="w-3 h-3" /> Couper</button>
                    {a.kind === "image" && <button type="button" onClick={() => setVarying(a)} className="inline-flex items-center justify-center px-2 py-1 rounded-md text-[11px] border border-gray-800 text-gray-300 hover:text-white" title="Plus comme ça"><Sparkles className="w-3 h-3" /></button>}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* ── Templates ─────────────────────────────────────────────────── */}
      {tab === "templates" && (
        templates === null ? <p className="text-sm text-gray-500 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Lecture…</p>
        : templates.length === 0 ? (
          <div className="rounded-xl border border-dashed border-gray-800 p-8 text-center text-sm text-gray-500 space-y-2">
            <BookmarkPlus className="w-6 h-6 mx-auto text-gray-600" />
            <p>Pas encore de template pour {client?.name ?? "ce client"}.</p>
            <p>Ajoutez une pub de concurrent (capture, lien, bibliothèque Meta) ou gardez une gagnante depuis <Link href={`/analyse?client=${client?.id ?? ""}`} className="text-violet-400">Analyse Ads</Link> (« Garder comme template »).</p>
            <button type="button" onClick={() => setAdding(true)} className={BTN_PRIMARY}><Plus className="w-4 h-4" /> Ajouter un template</button>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2 text-xs text-gray-400" data-template-selection>
              <span>Cochez des templates pour lancer une fabrique{selected.length ? ` — ${selected.length} sélectionné${selected.length > 1 ? "s" : ""}` : ""}.</span>
              {selected.length > 0 && <button type="button" onClick={() => setSelected([])} className="hover:text-white">Tout décocher</button>}
              {selected.length > 0 && <button type="button" onClick={() => { setPreselected(selected); setSelected([]); switchTab("fabrique"); }} className={`${BTN_PRIMARY} ml-auto`} data-factory-launch><Factory className="w-4 h-4" /> Lancer une fabrique ({selected.length})</button>}
            </div>
            <ul className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
              {templates.map((t) => (
                <li key={t.id} className={`relative rounded-xl border overflow-hidden bg-gray-950 ${selected.includes(t.id) ? "border-violet-500" : "border-gray-800 hover:border-violet-500/60"}`}>
                  <button type="button" onClick={() => setOpenTemplate(t)} className="w-full text-left">
                    <div className="relative bg-gray-900 aspect-[4/5]">
                      {t.image ? <img src={t.image} alt={t.name} className="w-full h-full object-cover" loading="lazy" /> : <div className="w-full h-full flex items-center justify-center text-xs text-gray-500 px-3 text-center">{t.title ?? "Sans image"}</div>}
                      <span className="absolute top-1.5 left-9"><Pill tone={t.source === "competitor" ? "amber" : t.source === "own" ? "emerald" : "default"} className="text-[10px]">{t.source === "competitor" && t.brand ? t.brand : SOURCE_LABEL[t.source]}</Pill></span>
                      {!t.clientId && <span className="absolute top-1.5 right-1.5"><Pill className="text-[10px]">Agence</Pill></span>}
                    </div>
                    <div className="px-2.5 py-2">
                      <p className="text-xs text-gray-200 line-clamp-2">{t.name}</p>
                      <p className="text-[10px] text-gray-500">{t.analysis.hook || "—"}{t.uses ? ` · ${t.uses} visuel${t.uses > 1 ? "s" : ""}` : ""}{t.kept + t.cut ? <> · <span className="text-emerald-300">{t.kept} gardée{t.kept > 1 ? "s" : ""}</span> / <span className="text-rose-300">{t.cut} coupée{t.cut > 1 ? "s" : ""}</span></> : null}</p>
                      {t.retiredAt ? <p className="text-[10px] text-amber-300">Écarté des fabriques</p> : shouldSuggestRetire(t) ? <p className="text-[10px] text-amber-300">Très coupé : à écarter ?</p> : null}
                    </div>
                  </button>
                  {t.image && (
                    <label className={`absolute top-1.5 left-1.5 w-6 h-6 rounded-md inline-flex items-center justify-center cursor-pointer ${selected.includes(t.id) ? "bg-violet-600 text-white" : "bg-black/60 text-gray-300 hover:text-white"}`} title="Sélectionner pour une fabrique">
                      <input type="checkbox" className="sr-only" checked={selected.includes(t.id)} onChange={(e) => setSelected((l) => (e.target.checked ? [...l, t.id] : l.filter((x) => x !== t.id)))} data-template-check={t.id} aria-label={`Sélectionner ${t.name}`} />
                      <Check className={`w-3.5 h-3.5 ${selected.includes(t.id) ? "" : "opacity-40"}`} />
                    </label>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )
      )}

      {/* ── Fabrique ──────────────────────────────────────────────────── */}
      {tab === "fabrique" && client && (
        templates === null ? <p className="text-sm text-gray-500 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Lecture…</p>
        : <FactoryTab key={client.id} client={client} templates={templates} engines={engines} quota={quota} initialRunId={runId} preselected={preselected} onPreselectedUsed={() => setPreselected([])}
            onRunUrl={setRunUrl} onNotice={setNotice} onError={setError} onOpenTemplate={(t) => setOpenTemplate(t)} onOpenIn={(editor, src) => void openIn(editor, src)} onVariation={(a) => setVarying(a)}
            onAssetsCreated={(created) => { setAssets((l) => { const list = l ?? []; const ids = new Set(created.map((a) => a.id)); return [...created.filter((a) => !list.some((x) => x.id === a.id)), ...list.map((x) => (ids.has(x.id) ? created.find((a) => a.id === x.id)! : x))]; }); }} onQuotaChanged={loadQuota} />
      )}

      {/* ── Brand assets ──────────────────────────────────────────────── */}
      {tab === "assets" && client && (
        <div className="space-y-3">
          <p className="text-xs text-gray-400">Logo, packshots, photos produit : ils sont envoyés en référence lors d&apos;une copie de template pour que le produit reste le vrai.</p>
          <BrandAssetUpload clientId={client.clientId} onCreated={(a) => setBrandAssets((l) => [a, ...l])} />
          {brandAssets.length ? (
            <ul className="grid grid-cols-3 sm:grid-cols-5 lg:grid-cols-8 gap-3">
              {brandAssets.map((a) => (
                <li key={a.id} className="group relative rounded-lg border border-gray-800 overflow-hidden bg-gray-900 aspect-square">
                  {a.url && <img src={a.url} alt={a.prompt} className="w-full h-full object-contain" />}
                  <span className="absolute bottom-0 inset-x-0 bg-black/60 text-[10px] text-gray-200 px-1.5 py-0.5 truncate">{a.prompt}</span>
                  <button type="button" onClick={() => void removeAsset(a)} className="absolute top-1 right-1 w-6 h-6 rounded-full bg-black/60 text-gray-300 hover:text-white opacity-0 group-hover:opacity-100 inline-flex items-center justify-center" aria-label="Retirer"><X className="w-3 h-3" /></button>
                </li>
              ))}
            </ul>
          ) : <p className="text-sm text-gray-500">Aucun élément de marque pour l&apos;instant.</p>}
        </div>
      )}

      {/* ── Asset drawer ──────────────────────────────────────────────── */}
      {openAsset && (
        <AssetDrawer key={openAsset.id} asset={openAsset} templateName={templateName(openAsset.templateId)} onClose={() => setOpenAsset(null)}
          onFeedback={(f, note) => void setFeedback(openAsset, f, note)} onVariation={() => setVarying(openAsset)} onEditText={() => setEditing(openAsset)}
          onOpenIn={(editor) => void openIn(editor, { assetId: openAsset.id })} onRemove={() => void removeAsset(openAsset)} />
      )}

      {/* ── Template drawer ───────────────────────────────────────────── */}
      {openTemplate && (
        <TemplateDrawer template={openTemplate} onClose={() => setOpenTemplate(null)} onCopy={() => setCopying(openTemplate)} onOpenIn={(editor) => void openIn(editor, { templateId: openTemplate.id })} onReanalyse={() => void reanalyse(openTemplate)} onRemove={() => void removeTemplate(openTemplate)} onRetire={(retired) => void retire(openTemplate, retired)}
          onFactory={() => { setPreselected([openTemplate.id]); setOpenTemplate(null); switchTab("fabrique"); }} />
      )}

      {studying && <PlaybookDialog client={client} onClose={() => setStudying(false)} onKept={(n) => { setStudying(false); if (client) void load(client); setNotice(`${n} template${n > 1 ? "s" : ""} gardé${n > 1 ? "s" : ""} depuis l'étude de la marque.`); }} />}
      {adding && <AddTemplateDialog client={client} clients={clients} onClose={() => setAdding(false)} onCreated={(t) => { setTemplates((l) => [t, ...(l ?? [])]); setAdding(false); setOpenTemplate(t); setNotice("Template gardé et lu par l'IA."); }} />}
      {copying && <CopyDialog template={copying} client={client} clients={clients} engines={engines} quota={quota} brandAssets={brandAssets} onClose={() => setCopying(null)}
        onDone={(created, message) => { setCopying(null); setOpenTemplate(null); setAssets((l) => [...created, ...(l ?? [])]); setTemplates((l) => (l ?? []).map((t) => (t.id === created[0]?.templateId ? { ...t, uses: t.uses + created.length } : t))); setTab("creas"); setVerdict("all"); setNotice(message); loadQuota(); if (created[0] && created[0].clientId !== client?.clientId) { const c = clients.find((x) => x.clientId === created[0].clientId); if (c) setClient(c); } }} />}
      {varying && <VariationDialog asset={varying} engines={engines} quota={quota} onClose={() => setVarying(null)} onDone={(created, message) => { setVarying(null); setOpenAsset(null); setAssets((l) => [...created, ...(l ?? [])]); setNotice(message); loadQuota(); }} />}
      {editing && <TextEditor asset={editing} onClose={() => setEditing(null)} onSaved={(a) => { setAssets((l) => [a as Asset, ...(l ?? [])]); setEditing(null); setOpenAsset(a as Asset); }} />}
    </div>
  );
}

// ── Drawers ───────────────────────────────────────────────────────────────

function Drawer({ title, onClose, children }: { title: React.ReactNode; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); }; window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k); }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <aside className="relative w-full max-w-2xl h-full bg-gray-950 border-l border-gray-800 overflow-y-auto">
        <div className="sticky top-0 z-10 flex items-center justify-between gap-3 px-4 py-3 bg-gray-950/95 border-b border-gray-800">
          <div className="min-w-0 text-sm font-semibold text-white truncate">{title}</div>
          <button type="button" onClick={onClose} className="p-1.5 rounded-md text-gray-400 hover:text-white hover:bg-gray-800" aria-label="Fermer"><X className="w-4 h-4" /></button>
        </div>
        <div className="p-4 space-y-4">{children}</div>
      </aside>
    </div>
  );
}

function AssetDrawer({ asset: a, templateName, onClose, onFeedback, onVariation, onEditText, onOpenIn, onRemove }: { asset: Asset; templateName: string | null; onClose: () => void; onFeedback: (f: "keep" | "cut" | null, note?: string) => void; onVariation: () => void; onEditText: () => void; onOpenIn: (editor: "figcraft" | "photocraft") => void; onRemove: () => void }) {
  // Remounted per asset (key) so the draft note starts from the stored one.
  const [note, setNote] = useState(a.feedbackNote ?? "");
  const p = a.params as { ratio?: string; engine?: string; promptSent?: string; templateName?: string };
  return (
    <Drawer title={<span>{a.clientName || "Sans client"} · {a.origin === "template" ? `depuis « ${templateName ?? p.templateName ?? "template"} »` : ORIGIN_LABEL[a.origin] ?? a.origin}</span>} onClose={onClose}>
      {a.url ? (a.kind === "video" ? <video src={a.url} controls className="max-h-[52vh] mx-auto rounded-lg" /> : <img src={a.url} alt={a.prompt} className="max-h-[52vh] mx-auto rounded-lg" />) : <p className="text-sm text-gray-400">{a.status === "failed" ? `Échec : ${a.error}` : "En cours de génération…"}</p>}
      <p className="text-sm text-gray-200 whitespace-pre-wrap">{a.prompt}</p>
      <p className="text-xs text-gray-500">{a.createdByName} · {when(a.createdAt)} · {a.model}{p.ratio ? ` · ${p.ratio}` : ""}{a.costUsd > 0 ? ` · ${usd(a.costUsd)}` : " · gratuit"}</p>
      {p.promptSent && <details className="text-xs text-gray-500"><summary className="cursor-pointer hover:text-gray-300">Consigne envoyée au moteur</summary><p className="mt-1 whitespace-pre-wrap">{p.promptSent}</p></details>}

      <div className="rounded-lg border border-gray-800 p-3 space-y-2">
        <div className="text-xs text-gray-400">Votre verdict — il nourrit la mémoire HQ du client (ce qui marche, ce qu&apos;on arrête)</div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => onFeedback(a.feedback === "keep" ? null : "keep", note)} className={`${BTN} ${a.feedback === "keep" ? "border-emerald-500 text-emerald-200" : ""}`}><Check className="w-4 h-4" /> Garder</button>
          <button type="button" onClick={() => onFeedback(a.feedback === "cut" ? null : "cut", note)} className={`${BTN} ${a.feedback === "cut" ? "border-rose-500 text-rose-200" : ""}`}><Scissors className="w-4 h-4" /> Couper</button>
          <button type="button" onClick={onVariation} className={BTN} disabled={a.kind !== "image" || a.status !== "completed"}><Sparkles className="w-4 h-4" /> Plus comme ça</button>
        </div>
        <div className="flex items-center gap-2">
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Pourquoi ? (ex. : hook trop faible, produit pas reconnaissable, à tester en story)" className={`${FIELD} flex-1`} />
          <button type="button" onClick={() => onFeedback(a.feedback === "keep" || a.feedback === "cut" ? a.feedback : null, note)} className={BTN}>Noter</button>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {a.downloadUrl && <a href={a.downloadUrl} className={BTN_PRIMARY}><Download className="w-4 h-4" /> Télécharger</a>}
        {a.kind === "image" && a.status === "completed" && <button type="button" onClick={onEditText} className={BTN}><Type className="w-4 h-4" /> Textes & logo</button>}
        {a.kind === "image" && a.status === "completed" && <button type="button" onClick={() => onOpenIn("figcraft")} className={BTN} title="Design FigCraft : calques modifiables, copilote IA"><PenTool className="w-4 h-4" /> FigCraft</button>}
        {a.kind === "image" && a.status === "completed" && <button type="button" onClick={() => onOpenIn("photocraft")} className={BTN} title="Retouche PhotoCraft"><PenTool className="w-4 h-4" /> PhotoCraft</button>}
        {a.kind === "image" && a.status === "completed" && <a href={`/pilotage?studioAsset=${a.id}`} className={BTN}><Send className="w-4 h-4" /> Pousser sur Meta</a>}
        {a.mine && <button type="button" onClick={onRemove} className="ml-auto inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm text-rose-300 hover:text-rose-200"><Trash2 className="w-4 h-4" /> Retirer</button>}
      </div>
    </Drawer>
  );
}

function TemplateDrawer({ template: t, onClose, onCopy, onOpenIn, onReanalyse, onRemove, onFactory, onRetire }: { template: Template; onClose: () => void; onCopy: () => void; onOpenIn: (editor: "figcraft" | "photocraft") => void; onReanalyse: () => void; onRemove: () => void; onFactory: () => void; onRetire: (retired: boolean) => void }) {
  const a = t.analysis;
  const [rereading, setRereading] = useState(false);
  const row = (label: string, value?: string | null) => (value ? <div><div className="text-[10px] uppercase tracking-wide text-gray-500">{label}</div><div className="text-sm text-gray-200">{value}</div></div> : null);
  return (
    <Drawer title={<span>{t.name} <span className="text-gray-500 font-normal">· {t.source === "competitor" && t.brand ? `concurrent ${t.brand}` : SOURCE_LABEL[t.source]}{t.clientName ? ` · ${t.clientName}` : " · agence"}</span></span>} onClose={onClose}>
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={onCopy} className={BTN_PRIMARY} disabled={!t.image} title={t.image ? "Génère des visuels à la marque du client à partir de ce template (références + éléments de marque)" : "Ce template n'a pas d'image"}><Wand2 className="w-4 h-4" /> Copier à la marque</button>
        <button type="button" onClick={onFactory} className={BTN} disabled={!t.image} title="Fabrique de statics : copys écrits par l'IA et validés, puis un lot de visuels"><Factory className="w-4 h-4" /> Lancer une fabrique</button>
        <button type="button" onClick={() => onOpenIn("figcraft")} className={BTN} disabled={!t.image} title="Reconstruit le template en calques modifiables (copilote IA)"><PenTool className="w-4 h-4" /> Modifier dans FigCraft</button>
        <button type="button" onClick={() => onOpenIn("photocraft")} className={BTN} disabled={!t.image} title="Retouche de l'image (copilote IA)"><PenTool className="w-4 h-4" /> Retoucher dans PhotoCraft</button>
      </div>
      {t.image ? <img src={t.image} alt={t.name} className="max-h-[48vh] mx-auto rounded-lg border border-gray-800" /> : <div className="rounded-lg border border-dashed border-gray-800 p-6 text-center text-xs text-gray-500">Sans image — {t.sourceUrl ? <a href={t.sourceUrl} target="_blank" rel="noopener noreferrer" className="text-violet-300 hover:text-white">voir la pub</a> : "ajoutez une capture pour la copier"}.</div>}
      {(t.title || t.body) && <div className="space-y-1">{t.title && <p className="text-sm text-white">{t.title}</p>}{t.body && <p className="text-xs text-gray-400 whitespace-pre-wrap">{t.body}</p>}</div>}
      <div className="grid gap-3 sm:grid-cols-2">
        {row("Accroche", a.hook)}{row("Style", a.style)}{row("Structure", a.structure)}{row("Appel à l'action", a.cta)}
        {a.textZones.length ? <div><div className="text-[10px] uppercase tracking-wide text-gray-500">Zones de texte</div><ul className="text-sm text-gray-200 space-y-0.5">{a.textZones.map((z, i) => <li key={i}><span className="text-gray-500">{z.role} :</span> {z.text || "—"}</li>)}</ul></div> : null}
        {a.palette.length ? <div><div className="text-[10px] uppercase tracking-wide text-gray-500">Palette</div><div className="flex flex-wrap gap-1.5 mt-1">{a.palette.map((c, i) => <span key={i} className="inline-flex items-center gap-1 text-[11px] text-gray-300"><span className="w-3.5 h-3.5 rounded-full border border-white/20" style={{ background: /^#|^rgb|^hsl/.test(c) ? c : undefined }} />{c}</span>)}</div></div> : null}
      </div>
      {row("Pourquoi ça marche", a.whyItWorks)}
      <TemplateFeedbackList templateId={t.id} />
      {a.brief && <div><div className="text-[10px] uppercase tracking-wide text-gray-500">Brief pour une autre marque</div><p className="text-sm text-gray-200 whitespace-pre-wrap">{a.brief}</p></div>}
      <div className="flex flex-wrap items-center gap-2 text-xs text-gray-500">
        <span>{t.createdByName} · {when(t.createdAt)}{t.uses ? ` · ${t.uses} visuel${t.uses > 1 ? "s" : ""} généré${t.uses > 1 ? "s" : ""}` : ""}{t.tags.length ? ` · ${t.tags.join(", ")}` : ""}</span>
        {t.sourceUrl && <a href={t.sourceUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-violet-300 hover:text-white">Source <ExternalLink className="w-3 h-3" /></a>}
        <button type="button" onClick={() => { setRereading(true); onReanalyse(); setTimeout(() => setRereading(false), 20000); }} disabled={rereading} className="inline-flex items-center gap-1 hover:text-white disabled:opacity-50">{rereading ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />} Relire avec l&apos;IA</button>
        {t.kept + t.cut > 0 && <span><span className="text-emerald-300">{t.kept} gardée{t.kept > 1 ? "s" : ""}</span> / <span className="text-rose-300">{t.cut} coupée{t.cut > 1 ? "s" : ""}</span></span>}
        {t.retiredAt
          ? <button type="button" onClick={() => onRetire(false)} className="inline-flex items-center gap-1 text-amber-300 hover:text-white" data-template-unretire>Écarté des fabriques — le remettre</button>
          : <button type="button" onClick={() => onRetire(true)} className={`inline-flex items-center gap-1 hover:text-white ${shouldSuggestRetire(t) ? "text-amber-300" : ""}`} title="Ne plus le proposer dans les nouvelles fabriques (il reste ici)" data-template-retire>{shouldSuggestRetire(t) ? "Très coupé : l'écarter des fabriques" : "Écarter des fabriques"}</button>}
        {t.mine && <button type="button" onClick={onRemove} className="ml-auto inline-flex items-center gap-1 text-rose-300 hover:text-rose-200"><Trash2 className="w-3.5 h-3.5" /> Retirer</button>}
      </div>
    </Drawer>
  );
}
