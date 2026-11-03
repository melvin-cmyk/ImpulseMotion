"use client";

/**
 * Creative details — Motion's full-screen creative modal: the ad as large as
 * possible on the left (official preview / YouTube / visual), and on the right
 * the tabs Aperçu (spend, launch, status, thought starters, AI tags grouped
 * like Motion: Visuel / Persona / Message / Hook, naming tags, copy, ad
 * breakdown), Performance (metrics vs account, day by day) and Notes.
 */

import { useEffect, useMemo, useState } from "react";
import { BookmarkPlus, Check, ExternalLink, Lightbulb, Link2, Loader2, MessageSquare, Pencil, Search, Sparkles, X } from "lucide-react";
import Link from "next/link";
import { Area, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { AdsGroupRow, AdsQuery, DailyPoint, MetricKey, Metrics } from "@/lib/ads-warehouse/query";
import { METRICS, METRIC_BY_KEY, TONE_CLASS, deltaPct, deltaTone, fmtMetric, toneVs } from "@/lib/ads-warehouse/metrics-ui";
import { FORMAT_LABEL, ScoreGauge, StatusDot, TrendText, isActive, relativeDay } from "./shared";
import { AdStage } from "./ad-preview";
import { DemographicsPane } from "./demographics-pane";
import { SaveToBoard } from "./inspo";
import { AddToPlaybook } from "./playbook";
import { CommentsPane } from "./comments-pane";
import { TagEditor } from "./glossary";
import type { GlossaryKey } from "@/lib/ads-warehouse/glossary-labels";
import { adImageSrc } from "./shared";
import { AI_TAG_LABELS } from "@/lib/ads-warehouse/ai-tags-labels";
import { AdNotes } from "./ad-notes";

interface Props {
  row: AdsGroupRow;
  query: AdsQuery;
  benchmark: Metrics;
  currency: string | null;
  onClose: () => void;
  /** Opens the Analyse Ads copilot with a prompt about this creative (thought starters). */
  onAsk?: (prompt: string) => void;
  /** Client (registry id), for « Ajouter à un board ». */
  clientId?: string | null;
  /** Report key (client:… | meta:…), for « Ajouter au playbook ». */
  accountKey?: string | null;
}

/** Motion's AI tag families, mapped onto our ai:* keys. */
const TAG_GROUPS: Array<{ title: string; keys: Array<keyof typeof AI_TAG_LABELS> }> = [
  { title: "Visuel", keys: ["ai:type", "ai:format"] },
  { title: "Persona", keys: ["ai:audience"] },
  { title: "Message", keys: ["ai:theme", "ai:season", "ai:offer"] },
  { title: "Hook", keys: ["ai:hook", "ai:headline"] },
];
const CHIP = ["bg-sky-500/15 text-sky-200", "bg-rose-500/15 text-rose-200", "bg-violet-500/15 text-violet-200", "bg-amber-500/15 text-amber-200", "bg-emerald-500/15 text-emerald-200"];

const fmtDay = (d: string) => new Date(d + "T00:00:00Z").toLocaleDateString("fr-FR", { day: "numeric", month: "short", timeZone: "UTC" });

export function AdDrawer({ row, query, benchmark, currency, onClose, onAsk, clientId, accountKey }: Props) {
  const [loaded, setLoaded] = useState<{ key: string; points: DailyPoint[] } | null>(null);
  const [metric, setMetric] = useState<MetricKey>("cpc");
  const [tab, setTab] = useState<"apercu" | "performance" | "audience" | "commentaires" | "notes">("apercu");
  const [copied, setCopied] = useState(false);
  const [showAllTags, setShowAllTags] = useState(false);
  const ad = row.sample;
  // « Garder comme template » → the swipe file of the client (Créas), picture and texts from the warehouse.
  const [kept, setKept] = useState<{ busy: boolean; id?: string; clientId?: string | null; error?: string }>({ busy: false });
  async function keepAsTemplate() {
    if (!ad || kept.busy) return;
    setKept({ busy: true });
    try {
      const res = await fetch("/api/creas/templates", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source: "own", adId: `${ad.platform}:${ad.adId}` }) });
      const j = (await res.json().catch(() => ({}))) as { template?: { id: string; clientId: string | null }; error?: string };
      if (!res.ok || !j.template) throw new Error(j.error ?? `Erreur ${res.status}`);
      setKept({ busy: false, id: j.template.id, clientId: j.template.clientId });
    } catch (e) {
      setKept({ busy: false, error: e instanceof Error ? e.message : "Impossible" });
    }
  }
  const points = loaded && loaded.key === row.key ? loaded.points : null;

  useEffect(() => {
    let cancelled = false;
    fetch("/api/ads/daily", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...query, key: row.key }) })
      .then((r) => (r.ok ? r.json() : { points: [] }))
      .then((j: { points: DailyPoint[] }) => { if (!cancelled) setLoaded({ key: row.key, points: j.points ?? [] }); })
      .catch(() => { if (!cancelled) setLoaded({ key: row.key, points: [] }); });
    return () => { cancelled = true; };
  }, [query, row.key]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const chart = useMemo(() => (points ?? []).map((p) => ({ date: fmtDay(p.date), spend: p.metrics.spend, m: p.metrics[metric] })), [points, metric]);
  const shown: MetricKey[] = ["spend", "impressions", "ctr", "cpc", "cpm", "conversions", "cpa", "cvr", "roas", "hookRate", "holdRate", "p100Rate"];

  const shownPerf = shown.filter((k) => !(METRIC_BY_KEY[k].video && ad && ad.format !== "Video" && row.metrics.videoPlays === 0));
  // Tags fixed in this sheet (TagEditor) show at once, before the report reloads.
  const [tagEdits, setTagEdits] = useState<Record<string, string | null>>({});
  const [editTags, setEditTags] = useState(false);
  const tags: Record<string, string> = Object.fromEntries(Object.entries({ ...(ad?.tags ?? {}), ...tagEdits }).filter(([, v]) => v)) as Record<string, string>;
  const naming = Object.entries(tags).filter(([k]) => !k.startsWith("ai:") && !/^(s|t)\d+$/.test(k));
  const name = row.label;
  const thoughts: Array<{ icon: typeof Search; label: string; prompt: string }> = [
    { icon: Search, label: "Analyser cette pub", prompt: `Analyse la créa « ${name} » : ce qui marche, ce qui ne marche pas (hook, message, visuel, CTA) et pourquoi, chiffres à l'appui face à la moyenne du compte.` },
    { icon: Lightbulb, label: "Me donner de nouvelles idées de hook à partir de cette pub", prompt: `Propose 10 nouvelles accroches (3 premières secondes / titre) pour itérer sur la créa « ${name} », en gardant ce qui fonctionne.` },
    { icon: Sparkles, label: "Des idées folles à partir de cette pub", prompt: `Donne-moi 5 concepts créatifs audacieux, très différents, inspirés de la créa « ${name} ».` },
    { icon: MessageSquare, label: "Demande-moi n'importe quoi", prompt: "" },
  ];
  async function copyLink() {
    const u = new URL(window.location.href);
    u.searchParams.set("creative", row.key);
    try { await navigator.clipboard.writeText(u.toString()); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard refused */ }
  }

  return (
    <div className="fixed inset-0 z-40" role="dialog" aria-modal="true" aria-label="Détails de la créa">
      <div className="absolute inset-0 bg-black/70" onClick={onClose} />
      <div className="absolute inset-2.5 rounded-xl border border-gray-800 bg-gray-950 flex flex-col overflow-hidden">
        {/* Top bar */}
        <div className="flex items-center gap-3 px-4 h-14 border-b border-gray-800 shrink-0">
          <div className="min-w-0 flex-1">
            <div className="text-[11px] text-gray-500 truncate">{ad ? `${ad.platform === "meta" ? "Meta" : ad.platform === "google" ? "Google" : ad.platform === "tiktok" ? "TikTok" : ad.platform} · ${row.key}` : row.key}</div>
            <div className="flex items-center gap-2 min-w-0"><StatusDot status={ad?.status} /><h2 className="text-sm font-semibold text-white truncate" title={name}>{name}</h2></div>
          </div>
          <span className="hidden md:inline-flex items-center rounded-lg border border-gray-800 px-2.5 py-1.5 text-xs text-gray-300">{fmtDay(query.range.since)} – {fmtDay(query.range.until)}</span>
          {ad && (kept.id ? (
            <Link href={`/creas?client=${kept.clientId ?? ""}&tab=templates&template=${kept.id}`} className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-emerald-500/15 text-emerald-200 border border-emerald-500/30 hover:text-white" title="Ouvrir dans Créas">Template gardé → Créas</Link>
          ) : (
            <button type="button" onClick={() => void keepAsTemplate()} disabled={kept.busy} className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium border border-gray-700 text-gray-200 hover:text-white hover:border-violet-500/50 disabled:opacity-50" title={kept.error ?? "Garder cette créa comme template (swipe file du client) : l'IA en lit la structure, puis « Copier à la marque », FigCraft ou PhotoCraft"}>
              {kept.busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <BookmarkPlus className="w-3.5 h-3.5" />} {kept.busy ? "Lecture…" : kept.error ? "Réessayer" : "Garder comme template"}
            </button>
          ))}
          {ad && <AddToPlaybook accountKey={accountKey ?? null} source="creative" defaultTitle="" refInfo={{ creativeKey: row.key, platform: ad.platform, adId: ad.adId, label: name.slice(0, 200), imageUrl: adImageSrc(ad) ?? null, linkUrl: `/analyse?creative=${encodeURIComponent(row.key)}` }} />}
          {ad && <SaveToBoard clientId={clientId ?? null} payload={() => ({ source: "own", ref: `${ad.platform}:${ad.adId}`, brand: ad.campaignName ?? ad.name, title: ad.title, body: ad.body, imageUrl: adImageSrc(ad) ?? null, linkUrl: `${window.location.origin}/analyse?creative=${encodeURIComponent(row.key)}` })} />}
          <button type="button" onClick={() => void copyLink()} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-white text-gray-900 hover:bg-gray-200">{copied ? <Check className="w-3.5 h-3.5" /> : <Link2 className="w-3.5 h-3.5" />}{copied ? "Lien copié" : "Copier le lien"}</button>
          <button type="button" onClick={onClose} className="p-1.5 rounded-md text-gray-400 hover:text-white hover:bg-gray-800" aria-label="Fermer"><X className="w-5 h-5" /></button>
        </div>

        <div className="flex-1 min-h-0 flex">
          {/* Stage */}
          <div className="flex-1 min-w-0 p-6 flex">{ad ? <AdStage key={ad.adId} ad={ad} /> : null}</div>

          {/* Side panel */}
          <aside className="w-[500px] max-w-[45vw] shrink-0 border-l border-gray-800 flex flex-col min-h-0">
            <div className="px-4 flex gap-4 border-b border-gray-800 shrink-0">
              {([["apercu", "Aperçu"], ["performance", "Performance"], ...(ad?.platform === "meta" ? [["audience", "Audience"] as const, ["commentaires", "Commentaires"] as const] : []), ["notes", "Notes"]] as const).map(([id, l]) => (
                <button key={id} type="button" onClick={() => setTab(id)} className={`py-3 text-sm border-b-2 -mb-px ${tab === id ? "border-white text-white" : "border-transparent text-gray-400 hover:text-white"}`}>{l}</button>
              ))}
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
              {tab === "apercu" && <>
                <div className="flex flex-wrap gap-1.5">
                  <span className="rounded-md bg-gray-800 px-2 py-0.5 text-xs text-gray-200">{ad ? FORMAT_LABEL[ad.format] ?? ad.format : "—"}</span>
                  {ad?.dynamic && <span className="rounded-md bg-violet-500/15 px-2 py-0.5 text-xs text-violet-200">Dynamic</span>}
                  {row.adCount > 1 && <span className="rounded-md bg-gray-800 px-2 py-0.5 text-xs text-gray-300">{row.adCount} annonces</span>}
                </div>
                <div className="rounded-xl border border-gray-800">
                  <div className="px-4 py-3">
                    <div className="text-xs text-gray-500" title={METRIC_BY_KEY.spend.hint}>Dépenses</div>
                    <div className="text-2xl font-semibold text-white tabular-nums">{fmtMetric("spend", row.metrics.spend, currency)}</div>
                    {row.trend && <div className="text-xs mt-0.5"><TrendText trend={row.trend} /> <span className="text-gray-500">· {fmtMetric("spend", row.trend.last7, currency)} sur les 7 derniers jours</span></div>}
                  </div>
                  <div className="grid grid-cols-2 border-t border-gray-800">
                    <div className="px-4 py-2.5 border-r border-gray-800"><div className="text-xs text-gray-500">Lancement</div><div className="text-sm text-white">{row.launch ? relativeDay(row.launch) : "—"}</div></div>
                    <div className="px-4 py-2.5"><div className="text-xs text-gray-500">Statut</div><div className="text-sm text-white flex items-center gap-1.5"><StatusDot status={ad?.status} />{isActive(ad?.status) ? "Active" : "Inactive"}</div></div>
                  </div>
                  <div className="grid grid-cols-4 border-t border-gray-800">
                    {(["hookScore", "watchScore", "clickScore", "convertScore"] as MetricKey[]).map((k) => (
                      <div key={k} className="px-3 py-2.5 border-r last:border-r-0 border-gray-800" title={METRIC_BY_KEY[k].hint}>
                        <div className="text-[11px] text-gray-500">{METRIC_BY_KEY[k].label}</div>
                        <div className="text-sm"><ScoreGauge value={row.metrics[k]} /></div>
                      </div>
                    ))}
                  </div>
                </div>

                {onAsk && (
                  <div>
                    <h3 className="text-sm font-semibold text-white mb-1.5">Pistes de réflexion</h3>
                    <div className="space-y-0.5">
                      {thoughts.map((t) => (
                        <button key={t.label} type="button" onClick={() => onAsk(t.prompt)} className="w-full flex items-center gap-2.5 rounded-lg px-2 py-2 text-left text-sm text-gray-200 hover:bg-gray-900">
                          <t.icon className="w-4 h-4 text-violet-300 shrink-0" />{t.label}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {editTags && ad ? (
                  <div className="rounded-xl border border-violet-500/40 p-4">
                    <div className="text-sm font-semibold text-white mb-2">Corriger les tags de la créa</div>
                    <TagEditor query={query} adIds={Array.from(new Set([ad, ...row.ads].map((a) => `${a.platform}:${a.adId}`)))} keys={TAG_GROUPS.flatMap((g) => g.keys) as GlossaryKey[]} tags={tags} onSaved={(k, v) => setTagEdits((t) => ({ ...t, [k]: v }))} onClose={() => setEditTags(false)} />
                  </div>
                ) : (
                <div className="rounded-xl border border-gray-800 p-4 relative">
                  {ad && <button type="button" onClick={() => setEditTags(true)} title="Corriger les tags IA de cette créa" className="absolute top-3 right-3 z-10 p-1 rounded-md text-gray-500 hover:text-white hover:bg-gray-800"><Pencil className="w-3.5 h-3.5" /></button>}
                  <div className={`space-y-3 ${showAllTags ? "" : "max-h-56 overflow-hidden"}`}>
                    {TAG_GROUPS.map((g) => (
                      <div key={g.title}>
                        <div className="text-sm font-semibold text-white mb-1">{g.title}</div>
                        {g.keys.map((k, i) => {
                          const v = tags[k];
                          return (
                            <div key={k} className="flex items-start gap-3 py-0.5 text-xs">
                              <span className="w-32 shrink-0 text-gray-500">{AI_TAG_LABELS[k]}</span>
                              {v && !/indéterminé|^aucune?$/i.test(v) ? <span className="flex flex-wrap gap-1">{v.split(/\s*\|\s*/).map((x, j) => <span key={x} className={`rounded-md px-1.5 py-0.5 ${CHIP[(i + j) % CHIP.length]}`}>{x}</span>)}</span> : <span className="text-gray-600">—</span>}
                            </div>
                          );
                        })}
                      </div>
                    ))}
                  </div>
                  {!showAllTags && <div className="absolute inset-x-0 bottom-0 h-16 rounded-b-xl bg-gradient-to-t from-gray-950 to-transparent flex items-end justify-center pb-2"><button type="button" onClick={() => setShowAllTags(true)} className="text-xs text-gray-300 hover:text-white">Voir plus</button></div>}
                </div>
                )}

                {naming.length > 0 && (
                  <div className="rounded-xl border border-gray-800 p-4">
                    <div className="text-sm font-semibold text-white mb-2">Convention de nommage</div>
                    <div className="flex flex-wrap gap-1">{naming.map(([k, v]) => <span key={k} className="rounded-md bg-gray-800 px-1.5 py-0.5 text-xs text-gray-200"><span className="text-gray-500">{k} </span>{v}</span>)}</div>
                  </div>
                )}

                {(ad?.title || ad?.body || ad?.landingUrl) && (
                  <div className="rounded-xl border border-gray-800 p-4 space-y-2 text-xs">
                    {ad?.title && <div><div className="text-gray-500">Titre</div><div className="text-gray-200">{ad.title}</div></div>}
                    {ad?.body && <div><div className="text-gray-500">Texte</div><div className="text-gray-300 whitespace-pre-line max-h-56 overflow-y-auto">{ad.body}</div></div>}
                    {ad?.landingUrl && <div><div className="text-gray-500">Landing page</div><a href={ad.landingUrl} target="_blank" rel="noopener noreferrer" className="text-violet-300 hover:text-white break-all inline-flex items-center gap-1">{ad.landingUrl.replace(/^https?:\/\//, "").slice(0, 70)} <ExternalLink className="w-3 h-3" /></a></div>}
                    {ad?.previewUrl && <a href={ad.previewUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-gray-400 hover:text-white">{ad.platform === "google" ? "Voir sur YouTube" : "Voir dans la bibliothèque Meta"} <ExternalLink className="w-3 h-3" /></a>}
                  </div>
                )}

                {row.ads.length > 1 && (
                  <div>
                    <div className="text-sm font-semibold text-white mb-2">Détail par annonce <span className="font-normal text-gray-500">· {row.adCount}</span></div>
                    <div className="rounded-xl border border-gray-800 divide-y divide-gray-800">
                      {row.ads.map((a) => (
                        <div key={a.adId} className="flex items-center justify-between gap-3 px-3 py-2 text-xs">
                          <div className="min-w-0 flex items-center gap-2">
                            <StatusDot status={a.status} />
                            <div className="min-w-0">
                              <div className="text-gray-200 truncate" title={a.name}>{a.name}</div>
                              <div className="text-[10px] text-gray-500 truncate">{a.adsetName ?? a.campaignName ?? a.adId}{a.createdTime ? ` · ${new Date(a.createdTime + "T00:00:00Z").toLocaleDateString("fr-FR")}` : ""}{isActive(a.status) ? "" : " · en pause"}</div>
                            </div>
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            <span className="tabular-nums text-gray-300">{fmtMetric("spend", a.spend, currency)}</span>
                            {a.previewUrl && <a href={a.previewUrl} target="_blank" rel="noopener noreferrer" className="text-gray-500 hover:text-white" title="Ouvrir"><ExternalLink className="w-3 h-3" /></a>}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>}

              {tab === "performance" && <>
                {row.metrics.video3s > 0 && (() => {
                  const steps = [["Impressions", 100, 100], ["3 s", row.metrics.hookRate, benchmark.hookRate], ["25 %", row.metrics.p25Rate, benchmark.p25Rate], ["50 %", row.metrics.p50Rate, benchmark.p50Rate], ["75 %", row.metrics.p75Rate, benchmark.p75Rate], ["100 %", row.metrics.p100Rate, benchmark.p100Rate]] as const;
                  const data = steps.map(([step, v, b]) => ({ step, v, b }));
                  const worst = steps.slice(1).map(([step, v], i) => ({ step, drop: (i === 0 ? 100 : steps[i][1]) - v })).sort((a, b) => b.drop - a.drop)[0];
                  return (
                    <div className="rounded-xl border border-gray-800 p-3">
                      <div className="flex items-baseline justify-between"><div className="text-sm font-semibold text-white">Rétention de la vidéo</div><div className="text-[11px] text-gray-500">% des impressions · pointillés = moyenne du compte</div></div>
                      <div className="h-40 mt-2">
                        <ResponsiveContainer width="100%" height="100%">
                          <ComposedChart data={data} margin={{ top: 6, right: 8, left: -18, bottom: 0 }}>
                            <XAxis dataKey="step" tick={{ fontSize: 10, fill: "#6b7280" }} tickLine={false} axisLine={false} />
                            <YAxis tick={{ fontSize: 10, fill: "#6b7280" }} tickLine={false} axisLine={false} scale="sqrt" domain={[0, 100]} />
                            <Tooltip contentStyle={{ background: "#111827", border: "1px solid #374151", fontSize: 11 }} formatter={(v, name) => [`${Number(v ?? 0).toLocaleString("fr-FR", { maximumFractionDigits: 2 })} %`, String(name) === "v" ? "Cette créa" : "Moyenne du compte"]} />
                            <Area type="monotone" dataKey="v" stroke="#8b5cf6" fill="#8b5cf6" fillOpacity={0.15} strokeWidth={2} />
                            <Line type="monotone" dataKey="b" stroke="#9ca3af" strokeWidth={1.5} strokeDasharray="4 3" dot={false} />
                          </ComposedChart>
                        </ResponsiveContainer>
                      </div>
                      {worst && worst.step !== "3 s" && <div className="mt-1 text-xs text-gray-400">La plus forte perte se fait avant {worst.step} de la vidéo.</div>}
                      {worst && worst.step === "3 s" && <div className="mt-1 text-xs text-gray-400">La plus forte perte se fait dans les 3 premières secondes : c&apos;est l&apos;accroche qui compte.</div>}
                    </div>
                  );
                })()}
                <div className="text-xs text-gray-500">Période {fmtDay(query.range.since)} → {fmtDay(query.range.until)}{query.compare ? ` · vs ${fmtDay(query.compare.since)} → ${fmtDay(query.compare.until)}` : ""}</div>
                <div className="grid grid-cols-2 gap-2">
                  {shownPerf.map((k) => {
                    const def = METRIC_BY_KEY[k];
                    const v = row.metrics[k];
                    const d = row.previous ? deltaPct(v, row.previous[k]) : null;
                    return (
                      <div key={k} className="rounded-xl border border-gray-800 p-2.5">
                        <div className="text-[11px] text-gray-500" title={def.hint}>{def.label}</div>
                        <div className={`inline-block mt-0.5 rounded-md p-1 text-sm font-semibold tabular-nums ${TONE_CLASS[toneVs(k, v, benchmark[k])]}`}>{fmtMetric(k, v, currency, row.metrics)}</div>
                        <div className="text-[11px] text-gray-500">moy. {fmtMetric(k, benchmark[k], currency, benchmark)}{d !== null && <span className={`ml-1 ${deltaTone(k, d) === "good" ? "text-emerald-400" : deltaTone(k, d) === "bad" ? "text-red-400" : ""}`}>{d > 0 ? "+" : ""}{d.toLocaleString("fr-FR", { maximumFractionDigits: 0 })} %</span>}</div>
                      </div>
                    );
                  })}
                </div>
                <div className="flex items-center justify-between">
                  <div className="text-xs text-gray-500">Jour par jour — dépenses et</div>
                  <select value={metric} onChange={(e) => setMetric(e.target.value as MetricKey)} className="bg-gray-900 border border-gray-800 rounded-md px-2 py-1 text-xs text-gray-200">
                    {METRICS.filter((m) => m.key !== "spend").map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
                  </select>
                </div>
                <div className="h-52 rounded-xl border border-gray-800 p-2">
                  {points === null ? <div className="h-full flex items-center justify-center text-gray-500 text-xs"><Loader2 className="w-4 h-4 animate-spin mr-2" /> Chargement…</div> : chart.length === 0 ? <div className="h-full flex items-center justify-center text-gray-500 text-xs">Aucune livraison sur la période.</div> : (
                    <ResponsiveContainer width="100%" height="100%">
                      <ComposedChart data={chart} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
                        <XAxis dataKey="date" tick={{ fontSize: 10, fill: "#6b7280" }} tickLine={false} axisLine={false} />
                        <YAxis yAxisId="l" tick={{ fontSize: 10, fill: "#6b7280" }} tickLine={false} axisLine={false} />
                        <YAxis yAxisId="r" orientation="right" tick={{ fontSize: 10, fill: "#6b7280" }} tickLine={false} axisLine={false} />
                        <Tooltip contentStyle={{ background: "#111827", border: "1px solid #374151", fontSize: 11 }} formatter={(v, name) => [String(name) === "spend" ? fmtMetric("spend", Number(v ?? 0), currency) : fmtMetric(metric, Number(v ?? 0), currency), String(name) === "spend" ? "Dépenses" : METRIC_BY_KEY[metric].label]} />
                        <Area yAxisId="l" type="monotone" dataKey="spend" stroke="#8b5cf6" fill="#8b5cf6" fillOpacity={0.15} strokeWidth={2} />
                        <Line yAxisId="r" type="monotone" dataKey="m" stroke="#f59e0b" strokeWidth={2} dot={false} strokeDasharray="4 3" />
                      </ComposedChart>
                    </ResponsiveContainer>
                  )}
                </div>
              </>}

              {tab === "audience" && ad?.platform === "meta" && <DemographicsPane accountId={ad.accountId} adIds={(row.ads.length ? row.ads : [ad]).filter((a) => a.platform === "meta").map((a) => a.adId)} range={query.range} currency={currency} />}
              {tab === "commentaires" && ad?.platform === "meta" && <CommentsPane adIds={(row.ads.length ? row.ads : [ad]).filter((a) => a.platform === "meta").map((a) => a.adId)} />}
              {tab === "notes" && ad && <AdNotes platform={ad.platform} adId={ad.adId} />}
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
