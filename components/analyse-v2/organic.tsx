"use client";

/**
 * Organique (Motion's « Organic »): the organic Facebook and Instagram posts
 * of the client over 90 days, their figures, the ones worth promoting (engage
 * ≥ 1.5× the account's median, not promoted yet), and a look at any public
 * Instagram business account (competitor) by its @username.
 */

import { useEffect, useMemo, useState } from "react";
import { ExternalLink, Instagram, Loader2, Megaphone, Play, Search } from "lucide-react";
import type { AdsQuery } from "@/lib/ads-warehouse/query";
import type { CompetitorIg, OrganicPost, OrganicResult } from "@/lib/ads-warehouse/organic";
import { AddToPlaybook } from "./playbook";

type Sort = "suggest" | "engagement" | "reach" | "recent";
const SORTS: Array<[Sort, string]> = [["suggest", "À sponsoriser d'abord"], ["engagement", "Taux d'engagement"], ["reach", "Portée"], ["recent", "Plus récents"]];
const KINDS: Record<OrganicPost["kind"], string> = { video: "Vidéo", photo: "Photo", carousel: "Carrousel", link: "Lien", text: "Texte", other: "Autre" };
const n = (v: number) => v.toLocaleString("fr-FR", { notation: v >= 10_000 ? "compact" : "standard", maximumFractionDigits: 1 });
const pct = (v: number) => `${(v * 100).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} %`;

export function OrganicPanel({ query, accountKey, clientName }: { query: AdsQuery; accountKey: string | null; clientName: string | null }) {
  const [data, setData] = useState<OrganicResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<Sort>("suggest");
  const [page, setPage] = useState<string>("all");
  const qKey = JSON.stringify([query.platforms, query.accountIds, query.accounts]);
  useEffect(() => {
    let live = true;
    queueMicrotask(() => { setData(null); setError(null); });
    fetch("/api/ads/organic", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(query) })
      .then(async (r) => { const j = (await r.json().catch(() => ({}))) as OrganicResult & { error?: string }; if (!r.ok) throw new Error(j.error ?? `Erreur ${r.status}`); return j; })
      .then((j) => { if (live) setData(j); })
      .catch((e: unknown) => { if (live) setError(e instanceof Error ? e.message : "Lecture impossible"); });
    return () => { live = false; };
  }, [qKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const posts = useMemo(() => {
    const list = (data?.posts ?? []).filter((p) => page === "all" || p.pageId === page);
    const by: Record<Sort, (a: OrganicPost, b: OrganicPost) => number> = {
      suggest: (a, b) => Number(b.suggest) - Number(a.suggest) || (b.vsMedian ?? 0) - (a.vsMedian ?? 0),
      engagement: (a, b) => b.engagementRate - a.engagementRate,
      reach: (a, b) => b.reach - a.reach,
      recent: (a, b) => b.createdAt.localeCompare(a.createdAt),
    };
    return [...list].sort(by[sort]);
  }, [data, page, sort]);

  if (error) return <div className="py-16 text-center text-sm text-red-300">{error}</div>;
  if (!data) return <div className="py-16 flex items-center justify-center gap-2 text-sm text-gray-400"><Loader2 className="w-4 h-4 animate-spin" /> Lecture des Pages Facebook…</div>;
  const readable = data.pages.filter((p) => p.readable);
  const blocked = data.pages.filter((p) => !p.readable);
  const toPromote = posts.filter((p) => p.suggest).length;
  return (
    <div className="px-6 pb-10 space-y-4">
      <p className="text-xs text-gray-500">Posts Facebook et Instagram organiques{clientName ? ` de ${clientName}` : ""} depuis le {new Date(data.since).toLocaleDateString("fr-FR")}. « À sponsoriser » = engagement au moins 1,5× la médiane du compte, portée correcte, pas encore sponsorisé.</p>
      {data.igId && <CompetitorLookup query={query} />}
      {blocked.length > 0 && <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">Compte{blocked.length > 1 ? "s" : ""} non lisible{blocked.length > 1 ? "s" : ""} : {blocked.map((p) => p.name).join(", ")} — à attribuer à l&apos;utilisateur système (Business Settings → Utilisateurs système → Ajouter des ressources → Pages ou Comptes Instagram).</div>}
      {!data.pages.length ? <div className="py-16 text-center text-sm text-gray-400">Aucune Page Facebook rattachée aux comptes Meta de ce client.</div> : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            {readable.length > 1 && (
              <select value={page} onChange={(e) => setPage(e.target.value)} className="h-8 bg-gray-900 border border-gray-800 rounded-lg px-2 text-xs text-gray-200">
                <option value="all">Tous les comptes</option>
                {readable.map((p) => <option key={p.id} value={p.id}>{p.platform === "instagram" ? "Instagram " : "Facebook "}{p.name}</option>)}
              </select>
            )}
            <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} className="h-8 bg-gray-900 border border-gray-800 rounded-lg px-2 text-xs text-gray-200">
              {SORTS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
            <span className="text-xs text-gray-500">{posts.length} posts · <span className="text-emerald-300">{toPromote} à sponsoriser</span></span>
          </div>
          {!posts.length ? <div className="py-12 text-center text-sm text-gray-400">Aucun post sur la période.</div> : (
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-4">
              {posts.map((p) => <PostCard key={p.id} post={p} accountKey={accountKey} />)}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function PostCard({ post: p, accountKey }: { post: OrganicPost; accountKey: string | null }) {
  const [more, setMore] = useState(false);
  return (
    <div className={`rounded-2xl border bg-gray-900 overflow-hidden flex flex-col ${p.suggest ? "border-emerald-500/40" : "border-gray-800"}`}>
      <div className="relative aspect-square bg-gray-950">
        {/* eslint-disable-next-line @next/next/no-img-element -- fbcdn, expiring URLs */}
        {p.picture ? <img src={p.picture} alt="" loading="lazy" className="absolute inset-0 w-full h-full object-cover" /> : <div className="absolute inset-0 flex items-center justify-center text-xs text-gray-600">{KINDS[p.kind]}</div>}
        {p.kind === "video" && <span className="absolute top-2 left-2 rounded-md bg-black/60 px-1.5 py-0.5 text-[11px] text-white inline-flex items-center gap-1"><Play className="w-3 h-3" />Vidéo</span>}
        {p.suggest && <span className="absolute top-2 right-2 rounded-md bg-emerald-500 px-1.5 py-0.5 text-[11px] font-medium text-white inline-flex items-center gap-1"><Megaphone className="w-3 h-3" />À sponsoriser</span>}
        {p.promoted && <span className="absolute top-2 right-2 rounded-md bg-violet-500/90 px-1.5 py-0.5 text-[11px] text-white">Sponsorisé</span>}
      </div>
      <div className="p-3 flex-1 flex flex-col gap-2">
        <div className="text-[11px] text-gray-500 flex items-center gap-1">{p.platform === "instagram" && <Instagram className="w-3 h-3" />}{p.pageName} · {new Date(p.createdAt).toLocaleDateString("fr-FR", { day: "numeric", month: "short" })}</div>
        {p.text && <p className={`text-sm text-gray-200 whitespace-pre-wrap break-words ${more ? "" : "line-clamp-3"}`} onClick={() => setMore((x) => !x)}>{p.text}</p>}
        <div className="grid grid-cols-3 gap-1 text-center mt-auto">
          <Stat label="Portée" value={n(p.reach)} />
          <Stat label="Engagement" value={p.reach ? pct(p.engagementRate) : "—"} hint={p.vsMedian !== null ? `${p.vsMedian.toLocaleString("fr-FR", { maximumFractionDigits: 1 })}× la médiane` : undefined} good={(p.vsMedian ?? 0) >= 1.5} />
          <Stat label={p.platform === "instagram" ? "Vues" : p.kind === "video" ? "Vues vidéo" : "Clics"} value={n(p.platform === "instagram" ? p.views : p.kind === "video" ? p.videoViews : p.clicks)} />
        </div>
        <div className="text-[11px] text-gray-500">{n(p.reactions)} {p.platform === "instagram" ? "j'aime" : "réactions"} · {n(p.comments)} commentaires · {n(p.shares)} partages{p.platform === "instagram" ? ` · ${n(p.saves)} enregistrements` : ""}</div>
        <div className="flex items-center justify-between gap-2 pt-1">
          {p.permalink ? <a href={p.permalink} target="_blank" rel="noreferrer" className="text-[11px] text-gray-400 hover:text-white inline-flex items-center gap-1"><ExternalLink className="w-3 h-3" />{p.platform === "instagram" ? "Instagram" : "Facebook"}</a> : <span />}
          <AddToPlaybook compact accountKey={accountKey} source="manual" defaultTitle={`Post organique : ${(p.text.split("\n")[0] || KINDS[p.kind]).slice(0, 100)}`} aiNote={`Post organique ${p.platform === "instagram" ? "Instagram" : "Facebook"} ${p.pageName} du ${p.createdAt.slice(0, 10)} — portée ${p.reach}, engagement ${pct(p.engagementRate)}${p.vsMedian !== null ? ` (${p.vsMedian.toFixed(1)}× la médiane de la Page)` : ""}, ${p.reactions} réactions, ${p.comments} commentaires, ${p.shares} partages.${p.text ? `\nTexte : ${p.text.slice(0, 400)}` : ""}`} refInfo={p.permalink ? { label: p.text.slice(0, 200), linkUrl: p.permalink, imageUrl: p.picture } : undefined} />
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, hint, good }: { label: string; value: string; hint?: string; good?: boolean }) {
  return (
    <div className="rounded-lg bg-gray-950 px-1 py-1.5" title={hint}>
      <div className={`text-sm font-semibold tabular-nums ${good ? "text-emerald-300" : "text-white"}`}>{value}</div>
      <div className="text-[10px] text-gray-500">{label}</div>
    </div>
  );
}

/** Any public Instagram business account (competitor, inspiration): its last 25 posts, best first. */
function CompetitorLookup({ query }: { query: AdsQuery }) {
  const [username, setUsername] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [res, setRes] = useState<CompetitorIg | null>(null);
  async function look() {
    const u = username.trim();
    if (!u || busy) return;
    setBusy(true); setError(null);
    try {
      const r = await fetch("/api/ads/organic/competitor", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...query, username: u }) });
      const j = (await r.json().catch(() => ({}))) as CompetitorIg & { error?: string };
      if (!r.ok) throw new Error(j.error ?? `Erreur ${r.status}`);
      setRes(j);
    } catch (e) { setError(e instanceof Error ? e.message : "Lecture impossible"); setRes(null); } finally { setBusy(false); }
  }
  const posts = res ? [...res.posts].sort((a, b) => (b.vsMedian ?? 0) - (a.vsMedian ?? 0)) : [];
  return (
    <div className="rounded-2xl border border-gray-800 bg-gray-900/50 p-4 space-y-3">
      <div className="text-sm font-semibold text-white flex items-center gap-1.5"><Instagram className="w-4 h-4" />Regarder un autre compte Instagram</div>
      <p className="text-xs text-gray-500">Concurrent ou inspiration : ses 25 derniers posts, les plus engageants d&apos;abord (j&apos;aime + commentaires ; la portée n&apos;est pas publique). Comptes professionnels seulement.</p>
      <form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); void look(); }}>
        <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="@nom_du_compte" className="w-64 h-8 rounded-lg border border-gray-800 bg-gray-900 px-2 text-sm text-white placeholder:text-gray-600" />
        <button type="submit" disabled={busy || !username.trim()} className="h-8 px-3 inline-flex items-center gap-1.5 rounded-lg bg-white text-xs font-medium text-gray-900 disabled:opacity-40">{busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />}Voir</button>
      </form>
      {error && <div className="text-xs text-red-300">{error}</div>}
      {res && (
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element -- Instagram CDN */}
            {res.picture && <img src={res.picture} alt="" className="w-10 h-10 rounded-full" />}
            <div>
              <div className="text-sm text-white font-medium">@{res.username}{res.name ? ` · ${res.name}` : ""}</div>
              <div className="text-xs text-gray-500">{n(res.followers)} abonnés · {n(res.mediaCount)} posts</div>
            </div>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-5 gap-3">
            {posts.map((p) => (
              <a key={p.id} href={p.permalink ?? undefined} target="_blank" rel="noreferrer" className={`rounded-xl border bg-gray-900 overflow-hidden block ${p.top ? "border-emerald-500/40" : "border-gray-800"}`}>
                <div className="relative aspect-square bg-gray-950">
                  {/* eslint-disable-next-line @next/next/no-img-element -- Instagram CDN */}
                  {p.picture ? <img src={p.picture} alt="" loading="lazy" className="absolute inset-0 w-full h-full object-cover" /> : <div className="absolute inset-0 flex items-center justify-center text-xs text-gray-600">{KINDS[p.kind]}</div>}
                  {p.top && <span className="absolute top-1.5 right-1.5 rounded bg-emerald-500 px-1.5 py-0.5 text-[10px] font-medium text-white">Top</span>}
                  {p.kind !== "photo" && <span className="absolute top-1.5 left-1.5 rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-white">{KINDS[p.kind]}</span>}
                </div>
                <div className="p-2 space-y-1">
                  <div className="text-[11px] text-gray-400 line-clamp-2">{p.text || "—"}</div>
                  <div className="text-[11px] text-gray-500">{n(p.likes)} j&apos;aime · {n(p.comments)} comm. · {new Date(p.createdAt).toLocaleDateString("fr-FR", { day: "numeric", month: "short" })}</div>
                  {p.vsMedian !== null && <div className={`text-[11px] ${p.top ? "text-emerald-300" : "text-gray-500"}`}>{p.vsMedian.toLocaleString("fr-FR", { maximumFractionDigits: 1 })}× sa médiane</div>}
                </div>
              </a>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
