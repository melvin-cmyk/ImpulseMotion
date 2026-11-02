"use client";

/**
 * Motion's Opportunities page for one client: suggested iterations on scaled
 * creatives, grouped by week, with the tabs Actives / Terminées / Archivées,
 * "Mark as completed", "Archive / Restore opportunity", the performance when
 * the opportunity was identified, and a detail with strengths, weaknesses and
 * the AI suggestion (rated 👍 / 👎). Opportunities expire after 30 days.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Archive, Check, ChevronDown, ChevronRight, Info, Loader2, MoreHorizontal, RotateCcw, Sparkles, ThumbsDown, ThumbsUp, X } from "lucide-react";
import type { AdsQuery } from "@/lib/ads-warehouse/query";
import type { AdSample } from "@/lib/ads-warehouse/query";
import type { OpportunityItem } from "@/lib/ads-warehouse/opportunities-store";
import { OPPORTUNITY_LABEL, OPPORTUNITY_TTL_DAYS, type OpportunityStatus } from "@/lib/ads-warehouse/opportunities";
import { fmtMetric } from "@/lib/ads-warehouse/metrics-ui";
import { ScoreGauge, StatusDot, adImageSrc, colorFor, relativeDay } from "./shared";
import { AdStage } from "./ad-preview";

const TABS: Array<{ id: OpportunityStatus; label: string; empty: { title: string; text: string } }> = [
  { id: "active", label: "Actives", empty: { title: "Les opportunités apparaîtront ici", text: "Reviens plus tard : elles sont détectées sur les créas qui prennent du budget." } },
  { id: "completed", label: "Terminées", empty: { title: "Aucune opportunité terminée", text: "Les opportunités marquées comme terminées apparaîtront ici." } },
  { id: "archived", label: "Archivées", empty: { title: "Aucune opportunité archivée", text: "Les opportunités archivées apparaîtront ici." } },
];

function weekStart(iso: string): string {
  const d = new Date(iso); d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}
const fmtDay = (d: string) => new Date(d + "T00:00:00Z").toLocaleDateString("fr-FR", { day: "numeric", month: "short", timeZone: "UTC" });

function sampleOf(o: OpportunityItem): AdSample {
  return {
    platform: o.platform, accountId: o.accountId, adId: o.adId, name: o.ad?.name ?? o.title, status: o.ad?.status ?? null,
    format: (o.ad?.format ?? "Unknown") as AdSample["format"], dynamic: false, thumbnailUrl: o.ad?.thumbnailUrl ?? null, imageUrl: o.ad?.imageUrl ?? null,
    videoId: o.ad?.videoId ?? null, previewUrl: null, title: o.ad?.title ?? null, body: o.ad?.body ?? null, landingUrl: null, createdTime: null,
    campaignName: null, adsetName: null, tags: {}, spend: o.metrics.spend ?? 0,
  };
}

function PerfAtAssignment({ o, currency }: { o: OpportunityItem; currency: string | null }) {
  const m = o.metrics;
  return (
    <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs">
      <span className="text-gray-500">Dépenses</span><span className="text-right text-gray-200 tabular-nums">{fmtMetric("spend", m.spend ?? 0, currency)}</span>
      {m.cpa > 0 && <><span className="text-gray-500">CPA</span><span className="text-right text-gray-200 tabular-nums">{fmtMetric("cpa", m.cpa, currency)}</span></>}
      {m.roas > 0 && <><span className="text-gray-500">ROAS</span><span className="text-right text-gray-200 tabular-nums">{fmtMetric("roas", m.roas, currency)}</span></>}
      <span className="text-gray-500">Hook score</span><span className="text-right"><ScoreGauge value={m.hookScore ?? 0} /></span>
      <span className="text-gray-500">Watch score</span><span className="text-right"><ScoreGauge value={m.watchScore ?? 0} /></span>
      <span className="text-gray-500">Click score</span><span className="text-right"><ScoreGauge value={m.clickScore ?? 0} /></span>
      <span className="text-gray-500">Convert score</span><span className="text-right"><ScoreGauge value={m.convertScore ?? 0} /></span>
    </div>
  );
}

interface Props { query: AdsQuery; currency: string | null; clientName: string }

export function OpportunitiesPanel({ query, currency, clientName }: Props) {
  const [tab, setTab] = useState<OpportunityStatus>("active");
  const body = useMemo(() => ({ platforms: query.platforms, accounts: query.accounts, accountIds: query.accountIds, range: { since: query.range.until, until: query.range.until } }), [query.platforms, query.accounts, query.accountIds, query.range.until]);
  const key = JSON.stringify(body) + tab;
  const [state, setState] = useState<{ key: string; items: OpportunityItem[] | null; error: string | null } | null>(null);
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const [detail, setDetail] = useState<OpportunityItem | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const current = state && state.key === key ? state : null;

  useEffect(() => {
    let cancelled = false;
    fetch("/api/ads/opportunities", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, status: tab, refresh: tab === "active" }) })
      .then(async (r) => (r.ok ? ((await r.json()) as { items: OpportunityItem[] }) : Promise.reject(new Error((await r.json().catch(() => ({}))).error ?? `Erreur ${r.status}`))))
      .then((j) => { if (!cancelled) setState({ key, items: j.items, error: null }); })
      .catch((e: Error) => { if (!cancelled) setState({ key, items: null, error: e.message }); });
    return () => { cancelled = true; };
  }, [body, tab, key]);

  const setStatus = useCallback(async (o: OpportunityItem, status: OpportunityStatus) => {
    setMenu(null);
    const res = await fetch(`/api/ads/opportunities/${o.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status }) });
    if (res.ok) setState((s) => (s ? { ...s, items: (s.items ?? []).filter((x) => x.id !== o.id) } : s));
    if (detail?.id === o.id) setDetail(null);
  }, [detail]);

  const buckets = useMemo(() => {
    const map = new Map<string, OpportunityItem[]>();
    for (const o of current?.items ?? []) { const w = weekStart(o.assignedAt); map.set(w, [...(map.get(w) ?? []), o]); }
    return Array.from(map.entries()).sort((a, b) => b[0].localeCompare(a[0]));
  }, [current]);
  const emptyCopy = TABS.find((t) => t.id === tab)!.empty;

  return (
    <div className="px-6 pb-10">
      <div className="flex gap-6">
        <div className="flex-1 min-w-0">
          <div className="flex gap-4 border-b border-gray-800 mb-4">
            {TABS.map((t) => (
              <button key={t.id} type="button" onClick={() => setTab(t.id)} className={`py-2 text-sm border-b-2 -mb-px ${tab === t.id ? "border-white text-white" : "border-transparent text-gray-400 hover:text-white"}`}>{t.label}</button>
            ))}
          </div>
          {!current ? <div className="py-16 flex items-center justify-center gap-2 text-sm text-gray-400"><Loader2 className="w-4 h-4 animate-spin" /> Recherche des opportunités…</div>
            : current.error ? <div className="py-16 text-center text-sm text-red-300">Opportunités indisponibles : {current.error}</div>
            : buckets.length === 0 ? (
              <div className="py-16 text-center">
                <Sparkles className="w-6 h-6 mx-auto text-gray-600" />
                <div className="mt-2 text-sm font-medium text-white">{emptyCopy.title}</div>
                <div className="text-xs text-gray-500">{emptyCopy.text}</div>
              </div>
            ) : (
              <div className="space-y-3">
                {buckets.map(([w, items]) => {
                  const end = new Date(w + "T00:00:00Z"); end.setUTCDate(end.getUTCDate() + 6);
                  const isClosed = closed.has(w);
                  return (
                    <div key={w} className="rounded-2xl border border-gray-800 bg-gray-900">
                      <button type="button" onClick={() => setClosed((s) => { const n = new Set(s); if (n.has(w)) n.delete(w); else n.add(w); return n; })} className="w-full flex items-center gap-2 px-4 py-3 text-left">
                        {isClosed ? <ChevronRight className="w-4 h-4 text-gray-500" /> : <ChevronDown className="w-4 h-4 text-gray-500" />}
                        <span className="text-sm font-medium text-white">{fmtDay(w)} – {fmtDay(end.toISOString().slice(0, 10))}</span>
                        <span className="text-xs text-gray-500">{items.length}</span>
                      </button>
                      {!isClosed && (
                        <ul className="border-t border-gray-800 divide-y divide-gray-800">
                          {items.map((o) => {
                            const img = adImageSrc(sampleOf(o));
                            return (
                              <li key={o.id} className="group flex items-center gap-3 px-4 py-2.5 hover:bg-gray-800/30">
                                <button type="button" onClick={() => setDetail(o)} className="flex items-center gap-3 min-w-0 flex-1 text-left">
                                  {/* eslint-disable-next-line @next/next/no-img-element -- platform CDNs */}
                                  {img ? <img src={img} alt="" className="w-10 h-10 rounded-md object-cover bg-gray-800 shrink-0" /> : <span className={`w-10 h-10 rounded-md bg-gradient-to-br ${colorFor(o.creativeKey)} shrink-0`} />}
                                  <span className="min-w-0">
                                    <span className="flex items-center gap-1.5"><StatusDot status={o.ad?.status} /><span className="text-sm text-white truncate" title={o.title}>{o.title}</span></span>
                                    <span className="text-xs text-gray-500">{relativeDay(o.assignedAt.slice(0, 10))} · <span className="text-gray-300">{OPPORTUNITY_LABEL[o.type]}</span></span>
                                  </span>
                                </button>
                                <span className="relative hidden md:block group/perf">
                                  <span className="inline-flex items-center gap-1.5 rounded-md border border-gray-800 px-2 py-1 text-xs text-gray-300 tabular-nums">{fmtMetric("spend", o.metrics.spend ?? 0, currency)}<Info className="w-3 h-3 text-gray-500" /></span>
                                  <span className="absolute right-0 top-full mt-1 z-20 hidden group-hover/perf:block w-64 rounded-xl border border-gray-700 bg-gray-950 p-3 shadow-xl">
                                    <span className="block text-[11px] text-gray-500 mb-1.5">Performance au moment de la détection</span>
                                    <PerfAtAssignment o={o} currency={currency} />
                                  </span>
                                </span>
                                {tab === "active" && <button type="button" onClick={() => void setStatus(o, "completed")} title="Marquer comme terminée" className="p-1.5 rounded-md text-gray-400 hover:text-emerald-300 hover:bg-gray-800"><Check className="w-4 h-4" /></button>}
                                {tab === "completed" && <span className="inline-flex items-center gap-1 text-xs text-emerald-300"><Check className="w-3.5 h-3.5" />Terminée{o.statusByName ? ` · ${o.statusByName}` : ""}</span>}
                                <span className="relative">
                                  <button type="button" onClick={() => setMenu(menu === o.id ? null : o.id)} className="p-1.5 rounded-md text-gray-400 hover:text-white hover:bg-gray-800" aria-label="Plus"><MoreHorizontal className="w-4 h-4" /></button>
                                  {menu === o.id && (
                                    <span className="absolute right-0 top-full mt-1 z-20 w-56 rounded-xl border border-gray-700 bg-gray-950 p-1 shadow-xl block">
                                      {tab === "archived"
                                        ? <button type="button" onClick={() => void setStatus(o, "active")} className="w-full flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-gray-200 hover:bg-gray-800"><RotateCcw className="w-4 h-4" />Restaurer l&apos;opportunité</button>
                                        : <button type="button" onClick={() => void setStatus(o, "archived")} className="w-full flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-gray-200 hover:bg-gray-800"><Archive className="w-4 h-4" />Archiver l&apos;opportunité</button>}
                                      {tab === "completed" && <button type="button" onClick={() => void setStatus(o, "active")} className="w-full flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-gray-200 hover:bg-gray-800"><RotateCcw className="w-4 h-4" />Remettre en actives</button>}
                                    </span>
                                  )}
                                </span>
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </div>
                  );
                })}
                <p className="pt-2 text-center text-xs text-gray-500">Tu es arrivé au bout. Les opportunités expirent après {OPPORTUNITY_TTL_DAYS} jours.</p>
              </div>
            )}
        </div>

        <aside className="hidden xl:block w-72 shrink-0">
          <div className="rounded-2xl border border-gray-800 bg-gray-900 p-4 sticky top-4">
            <Sparkles className="w-5 h-5 text-violet-300" />
            <h2 className="mt-2 text-sm font-medium text-white">Comment sont créées les opportunités ?</h2>
            <p className="mt-1 text-xs leading-relaxed text-gray-400">Les opportunités de {clientName || "ce client"} sont créées à partir des scores de chaque créa qui a pris du budget : hook score, watch score, click score, convert score.<br /><br />On repère l&apos;étape faible quand les autres tiennent : un petit changement (première image, accroche, corps de la vidéo, appel à l&apos;action) peut apporter un gros gain.</p>
          </div>
        </aside>
      </div>

      {detail && <OpportunityDetail o={detail} currency={currency} onClose={() => setDetail(null)} onStatus={(s) => void setStatus(detail, s)} onSuggestion={(o) => { setDetail(o); setState((st) => (st ? { ...st, items: (st.items ?? []).map((x) => (x.id === o.id ? o : x)) } : st)); }} />}
    </div>
  );
}

function OpportunityDetail({ o, currency, onClose, onStatus, onSuggestion }: { o: OpportunityItem; currency: string | null; onClose: () => void; onStatus: (s: OpportunityStatus) => void; onSuggestion: (o: OpportunityItem) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  async function suggest() {
    setBusy(true); setError(null);
    try {
      const res = await fetch(`/api/ads/opportunities/${o.id}/suggest`, { method: "POST" });
      const j = (await res.json().catch(() => ({}))) as { suggestion?: OpportunityItem["aiSuggestion"]; error?: string };
      if (!res.ok || !j.suggestion) throw new Error(j.error ?? `Erreur ${res.status}`);
      onSuggestion({ ...o, aiSuggestion: j.suggestion, aiScore: null });
    } catch (e) { setError(e instanceof Error ? e.message : "Impossible"); } finally { setBusy(false); }
  }
  async function rate(score: 1 | -1) {
    const next = o.aiScore === score ? null : score;
    const res = await fetch(`/api/ads/opportunities/${o.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ aiScore: next }) });
    if (res.ok) onSuggestion({ ...o, aiScore: next });
  }
  return (
    <div className="fixed inset-0 z-40" role="dialog" aria-modal="true" aria-label="Opportunité">
      <div className="absolute inset-0 bg-black/70" onClick={onClose} />
      <div className="absolute inset-2.5 rounded-xl border border-gray-800 bg-gray-950 flex flex-col overflow-hidden">
        <div className="flex items-center gap-3 px-4 h-14 border-b border-gray-800 shrink-0">
          <div className="min-w-0 flex-1">
            <div className="text-[11px] text-gray-500">{OPPORTUNITY_LABEL[o.type]} · détectée {relativeDay(o.assignedAt.slice(0, 10))}</div>
            <h2 className="text-sm font-semibold text-white truncate" title={o.title}>{o.title}</h2>
          </div>
          {o.status === "active" && <button type="button" onClick={() => onStatus("completed")} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-white text-gray-900 hover:bg-gray-200"><Check className="w-3.5 h-3.5" />Marquer comme terminée</button>}
          <button type="button" onClick={onClose} className="p-1.5 rounded-md text-gray-400 hover:text-white hover:bg-gray-800" aria-label="Fermer"><X className="w-5 h-5" /></button>
        </div>
        <div className="flex-1 min-h-0 flex">
          <div className="flex-1 min-w-0 p-6 flex"><AdStage ad={sampleOf(o)} /></div>
          <aside className="w-[500px] max-w-[45vw] shrink-0 border-l border-gray-800 overflow-y-auto p-4 space-y-4">
            <div>
              <span className="inline-block rounded-md bg-violet-500/15 px-2 py-0.5 text-xs text-violet-200">🚩 {OPPORTUNITY_LABEL[o.type]}</span>
              <p className="mt-2 text-sm leading-relaxed text-gray-200">{o.description}</p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-xl border border-gray-800 p-3">
                <div className="text-xs font-semibold text-emerald-300 mb-1">Forces</div>
                <ul className="space-y-1 text-xs text-gray-300">{o.strengths.map((x) => <li key={x}>• {x}</li>)}</ul>
              </div>
              <div className="rounded-xl border border-gray-800 p-3">
                <div className="text-xs font-semibold text-red-300 mb-1">Faiblesses</div>
                <ul className="space-y-1 text-xs text-gray-300">{o.weaknesses.map((x) => <li key={x}>• {x}</li>)}</ul>
              </div>
            </div>
            <div className="rounded-xl border border-gray-800 p-3">
              <div className="text-xs text-gray-500 mb-2">Performance au moment de la détection</div>
              <PerfAtAssignment o={o} currency={currency} />
            </div>
            <div className="rounded-xl border border-gray-800 p-3">
              <div className="flex items-center justify-between mb-2">
                <div className="text-sm font-semibold text-white flex items-center gap-1.5"><Sparkles className="w-4 h-4 text-violet-300" />Suggestion de l&apos;IA</div>
                {o.aiSuggestion && (
                  <div className="flex items-center gap-1">
                    <button type="button" onClick={() => void rate(1)} title="Utile" className={`p-1 rounded-md ${o.aiScore === 1 ? "text-emerald-300 bg-emerald-500/15" : "text-gray-500 hover:text-white"}`}><ThumbsUp className="w-3.5 h-3.5" /></button>
                    <button type="button" onClick={() => void rate(-1)} title="Pas utile" className={`p-1 rounded-md ${o.aiScore === -1 ? "text-red-300 bg-red-500/15" : "text-gray-500 hover:text-white"}`}><ThumbsDown className="w-3.5 h-3.5" /></button>
                  </div>
                )}
              </div>
              {o.aiSuggestion ? (
                <div className="space-y-3">
                  {o.aiSuggestion.currentAttractionSummary && <div><div className="text-xs text-gray-500">Ce qui attire aujourd&apos;hui</div><p className="text-sm text-gray-200">{o.aiSuggestion.currentAttractionSummary}</p></div>}
                  <ol className="space-y-2">
                    {o.aiSuggestion.changes.map((c, i) => (
                      <li key={i} className="rounded-lg bg-gray-900 p-2.5">
                        <div className="text-sm font-medium text-white">{i + 1}. {c.summary}</div>
                        <div className="text-xs leading-relaxed text-gray-300">{c.actionableChange}</div>
                      </li>
                    ))}
                  </ol>
                  <button type="button" onClick={() => void suggest()} disabled={busy} className="text-xs text-gray-400 hover:text-white disabled:opacity-50">{busy ? "Nouvelle suggestion…" : "Générer une autre suggestion"}</button>
                </div>
              ) : (
                <button type="button" onClick={() => void suggest()} disabled={busy} className="w-full inline-flex items-center justify-center gap-1.5 rounded-lg border border-violet-500/40 px-3 py-2 text-sm text-violet-200 hover:bg-violet-500/10 disabled:opacity-50">
                  {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}{busy ? "L'IA prépare 3 changements…" : "Proposer des changements"}
                </button>
              )}
              {error && <div className="mt-2 text-xs text-red-300">{error}</div>}
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
