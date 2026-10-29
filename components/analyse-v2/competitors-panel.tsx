"use client";

/**
 * Analyse Ads › « Concurrents » — the client's competitors (saved by the
 * consultants, named in the HQ brief, or suggested by the AI when those give
 * fewer than 3: /api/competitors, lib/competitors.ts) and, for the one
 * chosen, the ads it runs now in the Meta Ad Library (/api/creas/ad-library,
 * 15-20 s, cached 10 min on the relay). Each ad can be kept as a template of
 * the client (Créas swipe file, /api/creas/templates).
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { BookmarkPlus, Check, ExternalLink, Loader2, Plus, RefreshCw, Sparkles, X } from "lucide-react";
import { ORIGIN_LABEL, brandKey, type Competitor } from "@/lib/competitors-core";

interface LibraryAd {
  id: string; pageName: string; bodies: string[]; titles: string[]; snapshotUrl: string | null; startedAt: string | null;
  platforms: string[]; imageUrl?: string | null; videoUrl?: string | null; domain?: string | null;
}
interface ListState { competitors: Competitor[]; needsSuggestions: boolean; suggestedAt: string | null; hqBrief: boolean; warning?: string }
interface AdsState { ads: LibraryAd[]; total?: number | null; brandAds?: number | null; error?: string }
type Kept = Record<string, { busy?: boolean; id?: string; error?: string }>;

const ORIGIN_CLASS: Record<Competitor["origin"], string> = {
  saved: "bg-violet-500/15 text-violet-200 border-violet-500/30",
  hq: "bg-emerald-500/15 text-emerald-200 border-emerald-500/30",
  suggested: "bg-amber-500/10 text-amber-200 border-amber-500/30",
};

const startedLabel = (s: string | null) => (!s ? "" : /^\d{4}-\d{2}-\d{2}/.test(s) ? `depuis le ${new Date(s).toLocaleDateString("fr-FR")}` : `depuis le ${s}`);
const libraryLink = (ad: LibraryAd) => ad.snapshotUrl ?? `https://www.facebook.com/ads/library/?id=${ad.id}`;

export function CompetitorsPanel({ clientId, clientName }: { clientId: string | null; clientName: string | null }) {
  const [list, setList] = useState<{ client: string; data: ListState } | null>(null);
  const [loading, setLoading] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const [ads, setAds] = useState<Record<string, AdsState | "loading">>({});
  const [kept, setKept] = useState<Kept>({});
  const data = list && list.client === clientId ? list.data : null;

  const call = useCallback(async (init: { method?: string; query?: string; body?: unknown }) => {
    if (!clientId) return;
    const res = await fetch(`/api/competitors?client=${encodeURIComponent(clientId)}${init.query ?? ""}`, init.method === "POST" ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(init.body) } : { method: init.method ?? "GET" });
    const j = (await res.json().catch(() => ({}))) as ListState & { error?: string };
    if (!res.ok) throw new Error(j.error ?? `Erreur ${res.status}`);
    setList({ client: clientId, data: j });
    return j;
  }, [clientId]);

  // The list at once (no AI), then the AI's suggestions when saved + HQ give fewer than 3 and none is cached.
  useEffect(() => {
    if (!clientId) return;
    let cancelled = false;
    queueMicrotask(() => { if (!cancelled) { setLoading(true); setError(null); } });
    (async () => {
      try {
        const first = await call({});
        if (cancelled || !first?.needsSuggestions) return;
        setSuggesting(true);
        await call({ query: "&suggest=1" });
      } catch (e) { if (!cancelled) setError(e instanceof Error ? e.message : "Erreur"); }
      finally { if (!cancelled) { setLoading(false); setSuggesting(false); } }
    })();
    return () => { cancelled = true; };
  }, [clientId, call]);

  const current = data?.competitors.find((c) => brandKey(c.name) === brandKey(picked ?? "")) ?? data?.competitors[0] ?? null;
  const currentAds = current ? ads[brandKey(current.name)] : undefined;

  const searchAds = useCallback(async (name: string, force = false) => {
    const k = brandKey(name);
    if (!force && ads[k]) return;
    setAds((s) => ({ ...s, [k]: "loading" }));
    try {
      const res = await fetch(`/api/creas/ad-library?q=${encodeURIComponent(name)}`);
      const j = (await res.json().catch(() => ({}))) as AdsState;
      setAds((s) => ({ ...s, [k]: { ads: j.ads ?? [], total: j.total, brandAds: j.brandAds, error: j.error ?? (res.ok ? undefined : `Erreur ${res.status}`) } }));
    } catch { setAds((s) => ({ ...s, [k]: { ads: [], error: "Bibliothèque Meta injoignable." } })); }
  }, [ads]);

  // The chosen competitor's ads are read once it is on screen (one search at a time: the relay's Chromium is shared).
  useEffect(() => {
    if (!current || currentAds) return;
    queueMicrotask(() => { void searchAds(current.name); });
  }, [current, currentAds, searchAds]);

  async function add(name: string) {
    const n = name.trim();
    if (!n) return;
    try { await call({ method: "POST", body: { client: clientId, name: n } }); setDraft(""); setPicked(n); }
    catch (e) { setError(e instanceof Error ? e.message : "Erreur"); }
  }
  async function remove(name: string) {
    try { await call({ method: "DELETE", query: `&name=${encodeURIComponent(name)}` }); if (picked && brandKey(picked) === brandKey(name)) setPicked(null); }
    catch (e) { setError(e instanceof Error ? e.message : "Erreur"); }
  }
  async function resuggest() {
    setSuggesting(true); setError(null);
    try { await call({ query: "&suggest=force" }); } catch (e) { setError(e instanceof Error ? e.message : "Erreur"); } finally { setSuggesting(false); }
  }
  async function keep(ad: LibraryAd, brand: string) {
    if (kept[ad.id]?.busy || kept[ad.id]?.id) return;
    setKept((s) => ({ ...s, [ad.id]: { busy: true } }));
    try {
      const res = await fetch("/api/creas/templates", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: "competitor", clientId: clientId ?? undefined, brand: ad.pageName || brand, title: ad.titles[0], body: ad.bodies[0], sourceRef: `adlib:${ad.id}`, sourceUrl: libraryLink(ad), ...(ad.imageUrl ? { imageUrl: ad.imageUrl } : {}) }),
      });
      const j = (await res.json().catch(() => ({}))) as { template?: { id: string }; error?: string };
      if (!res.ok || !j.template) throw new Error(j.error ?? `Erreur ${res.status}`);
      setKept((s) => ({ ...s, [ad.id]: { id: j.template!.id } }));
    } catch (e) { setKept((s) => ({ ...s, [ad.id]: { error: e instanceof Error ? e.message : "Impossible" } })); }
  }

  if (!clientId) return <div className="my-10 mx-auto max-w-md text-center"><div className="text-base font-semibold text-white">Choisis un client</div><p className="mt-1 text-sm text-gray-400">Les concurrents se rangent par client : choisis-en un (⌘K ou la liste des clients).</p></div>;

  const suggestedOnly = !!data && data.competitors.length > 0 && data.competitors.every((c) => c.origin === "suggested");
  return (
    <div className="px-6 pb-8 flex-1 flex gap-4 min-h-0">
      {/* ── The list ── */}
      <aside className="w-64 shrink-0 space-y-3">
        <div className="rounded-2xl border border-gray-800 bg-gray-900/60 p-3 space-y-2">
          <div className="flex items-center justify-between">
            <div className="text-[10px] uppercase tracking-wide text-gray-500">Concurrents de {clientName ?? "ce client"}</div>
            {loading && <Loader2 className="w-3.5 h-3.5 animate-spin text-gray-500" />}
          </div>
          {data && !data.competitors.length && !suggesting && <p className="text-xs text-gray-500">Aucun concurrent connu{data.hqBrief ? " (le brief HQ n'en nomme pas)" : ""}. Ajoute-en un ci-dessous.</p>}
          <ul className="space-y-1">
            {data?.competitors.map((c) => {
              const on = current && brandKey(current.name) === brandKey(c.name);
              return (
                <li key={c.name} className={`group flex items-center gap-1.5 rounded-lg border px-2 py-1.5 text-xs cursor-pointer ${on ? "border-violet-500/60 bg-violet-500/10 text-white" : "border-gray-800 text-gray-300 hover:text-white hover:border-gray-700"}`} onClick={() => setPicked(c.name)}>
                  <span className="flex-1 min-w-0 truncate" title={c.name}>{c.name}</span>
                  <span className={`shrink-0 rounded border px-1 text-[9px] ${ORIGIN_CLASS[c.origin]}`} title={c.origin === "suggested" ? "Proposé par l'IA d'après le site, les textes des pubs et le brief du client : à confirmer" : c.origin === "hq" ? "Nommé dans la fiche HQ du client" : "Ajouté par un consultant"}>{ORIGIN_LABEL[c.origin]}</span>
                  {c.origin === "suggested" && <button type="button" onClick={(e) => { e.stopPropagation(); void add(c.name); }} className="shrink-0 text-gray-500 hover:text-emerald-300" title="Confirmer ce concurrent (il reste dans la liste du client)"><Check className="w-3.5 h-3.5" /></button>}
                  <button type="button" onClick={(e) => { e.stopPropagation(); void remove(c.name); }} className="shrink-0 text-gray-600 hover:text-red-300 opacity-0 group-hover:opacity-100" title="Retirer de la liste de ce client" aria-label={`Retirer ${c.name}`}><X className="w-3.5 h-3.5" /></button>
                </li>
              );
            })}
          </ul>
          {suggesting && <div className="flex items-center gap-1.5 text-[11px] text-amber-200/80"><Loader2 className="w-3 h-3 animate-spin" /> L&apos;IA cherche des concurrents probables…</div>}
          <form className="flex items-center gap-1.5 pt-1" onSubmit={(e) => { e.preventDefault(); void add(draft); }}>
            <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Ajouter une marque…" maxLength={60} className="flex-1 min-w-0 rounded-md border border-gray-800 bg-gray-950 px-2 py-1 text-xs text-gray-200 placeholder:text-gray-600" />
            <button type="submit" disabled={!draft.trim()} className="rounded-md border border-gray-800 p-1 text-gray-300 hover:text-white disabled:opacity-40" aria-label="Ajouter"><Plus className="w-3.5 h-3.5" /></button>
          </form>
          {data && (data.suggestedAt || suggestedOnly || data.competitors.filter((c) => c.origin !== "suggested").length < 3) && (
            <button type="button" onClick={() => void resuggest()} disabled={suggesting} className="inline-flex items-center gap-1 text-[11px] text-gray-500 hover:text-white disabled:opacity-50" title="Demander à l'IA d'autres concurrents probables">
              <Sparkles className="w-3 h-3" /> Nouvelles suggestions
            </button>
          )}
          {data?.warning && <p className="text-[11px] text-amber-300">{data.warning}</p>}
          {error && <p className="text-[11px] text-red-400">{error}</p>}
        </div>
        <p className="text-[11px] text-gray-600 leading-snug">« suggéré par l&apos;IA » : à vérifier, ✓ le confirme. La liste sert aussi à Mo (« que font les concurrents de {clientName ?? "X"} »).</p>
      </aside>

      {/* ── The chosen competitor's ads ── */}
      <section className="flex-1 min-w-0">
        {!current ? null : (
          <div className="rounded-2xl border border-gray-800 bg-gray-900/60 p-3 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="text-sm font-semibold text-white truncate">Pubs de {current.name} en ce moment</div>
                <div className="text-[11px] text-gray-500">
                  Bibliothèque publicitaire Meta · France
                  {currentAds && currentAds !== "loading" && !currentAds.error ? ` · ${currentAds.ads.length} affichées${currentAds.total ? ` sur ${currentAds.total}` : ""}${currentAds.brandAds === 0 && currentAds.ads.length ? " (la marque n'apparaît pas comme annonceur : pubs qui la citent)" : ""}` : ""}
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <a href={`https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=FR&q=${encodeURIComponent(current.name)}&search_type=keyword_unordered`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-[11px] text-gray-400 hover:text-white">Ouvrir dans Meta <ExternalLink className="w-3 h-3" /></a>
                <button type="button" onClick={() => void searchAds(current.name, true)} disabled={currentAds === "loading"} className="p-1 rounded-md text-gray-400 hover:text-white disabled:opacity-40" title="Relire la bibliothèque"><RefreshCw className="w-3.5 h-3.5" /></button>
              </div>
            </div>
            {currentAds === "loading" || !currentAds ? (
              <div className="py-16 flex items-center justify-center text-gray-500 text-xs"><Loader2 className="w-4 h-4 animate-spin mr-2" /> Lecture de la bibliothèque Meta (15-20 s)…</div>
            ) : currentAds.error && !currentAds.ads.length ? (
              <p className="text-xs text-amber-300 whitespace-pre-wrap">{currentAds.error}</p>
            ) : !currentAds.ads.length ? (
              <p className="py-10 text-center text-xs text-gray-500">Aucune pub active trouvée pour « {current.name} » en France.</p>
            ) : (
              <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-3">
                {currentAds.ads.map((ad) => {
                  const k = kept[ad.id];
                  return (
                    <div key={ad.id} className="rounded-xl border border-gray-800 bg-gray-950 overflow-hidden flex flex-col">
                      <a href={libraryLink(ad)} target="_blank" rel="noopener noreferrer" className="relative block aspect-[4/5] bg-black/40">
                        {ad.imageUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={`/api/media/proxy-image?url=${encodeURIComponent(ad.imageUrl)}`} alt="" className="absolute inset-0 w-full h-full object-cover" loading="lazy" />
                        ) : <div className="absolute inset-0 flex items-center justify-center text-[11px] text-gray-600">Pas d&apos;aperçu</div>}
                        {ad.videoUrl && <span className="absolute top-1.5 left-1.5 rounded bg-black/70 px-1.5 py-0.5 text-[10px] text-white">Vidéo</span>}
                      </a>
                      <div className="p-2 flex-1 flex flex-col gap-1 text-[11px]">
                        <div className="text-gray-200 font-medium truncate" title={ad.pageName}>{ad.pageName || current.name}</div>
                        <div className="text-gray-500">{[startedLabel(ad.startedAt), ad.platforms.join(", "), ad.domain ?? ""].filter(Boolean).join(" · ")}</div>
                        {ad.titles[0] && <div className="text-gray-300 line-clamp-1" title={ad.titles[0]}>{ad.titles[0]}</div>}
                        {ad.bodies[0] && <div className="text-gray-400 line-clamp-3" title={ad.bodies[0]}>{ad.bodies[0]}</div>}
                        <div className="mt-auto pt-1.5 flex items-center justify-between gap-1">
                          <a href={libraryLink(ad)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-gray-500 hover:text-white">Voir <ExternalLink className="w-3 h-3" /></a>
                          {k?.id ? (
                            <Link href={`/creas?client=${clientId}&tab=templates&template=${k.id}`} className="rounded-md border border-emerald-500/30 bg-emerald-500/15 px-2 py-1 text-emerald-200 hover:text-white">Gardé → Créas</Link>
                          ) : (
                            <button type="button" onClick={() => void keep(ad, current.name)} disabled={k?.busy} title={k?.error ?? "Garder cette pub comme template du client (Créas) : l'IA en lit la structure"} className="inline-flex items-center gap-1 rounded-md border border-violet-500/40 px-2 py-1 text-violet-200 hover:text-white hover:bg-violet-500/10 disabled:opacity-50">
                              {k?.busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <BookmarkPlus className="w-3 h-3" />} {k?.busy ? "Lecture…" : k?.error ? "Réessayer" : "Garder comme template"}
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
