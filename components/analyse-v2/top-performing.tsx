"use client";

/**
 * Analyse Ads v2 — the "Top performing" report (Motion's workhorse) on the
 * creative warehouse. One bar says what you look at (account, period,
 * compare, group by, filters, metrics), three views (cards / table / curve),
 * a drawer per creative. Everything reads /api/ads/query — no live platform
 * call, so it answers in well under a second once the account is synced.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSession } from "next-auth/react";
import { BarChart3, LayoutGrid, LineChart as LineIcon, Loader2, RefreshCw, Search, SlidersHorizontal, Table as TableIcon, X } from "lucide-react";
import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis, Legend } from "recharts";
import { useCreativesContext } from "@/lib/creatives-context";
import { AccountPicker } from "@/components/account-picker";
import type { AdsFilters, AdsGroupRow, AdsQuery, AdsQueryResult, DailyPoint, GroupBy, MetricKey } from "@/lib/ads-warehouse/query";
import type { AdFormat } from "@/lib/ads-warehouse/types";
import { METRICS, METRIC_BY_KEY, PRESETS, fmtMetric } from "@/lib/ads-warehouse/metrics-ui";
import { lastFullDays, prevRange, type DateRange } from "@/lib/date-ranges";
import { normalizeAct } from "@/lib/use-account-list";
import { AdCard } from "./ad-card";
import { AdsTable } from "./ads-table";
import { AdDrawer } from "./ad-drawer";

type View = "cards" | "table" | "chart";
type SortKey = MetricKey | "name" | "adCount" | "launch";
type Result = AdsQueryResult & { tagKeys: Array<{ key: string; count: number }> };

const GROUPS: Array<{ value: GroupBy; label: string; hint: string }> = [
  { value: "creative", label: "Créa", hint: "Une ligne par visuel, toutes annonces confondues (même vidéo ou image dans plusieurs ad sets)" },
  { value: "ad", label: "Annonce", hint: "Une ligne par annonce" },
  { value: "campaign", label: "Campagne", hint: "" },
  { value: "adset", label: "Ad set", hint: "" },
  { value: "format", label: "Format", hint: "Vidéo / Image / Carrousel" },
  { value: "landing", label: "Landing page", hint: "URL de destination (sans paramètres)" },
  { value: "copy", label: "Texte", hint: "Texte principal de l'annonce" },
  { value: "title", label: "Titre", hint: "Titre / accroche" },
  { value: "launch_week", label: "Semaine de lancement", hint: "Cohortes par semaine de création" },
];
const PERIODS = [7, 14, 30, 60, 90, 180];
const LAUNCH = [{ v: 0, l: "Toutes" }, { v: 7, l: "7 derniers jours" }, { v: 14, l: "14 derniers jours" }, { v: 30, l: "30 derniers jours" }, { v: 90, l: "90 derniers jours" }];
const PRESET_STORAGE = "impulsemotion.analyse.metrics";
const COLORS = ["#8b5cf6", "#f59e0b", "#10b981", "#3b82f6", "#ec4899", "#14b8a6", "#f97316", "#a3e635"];

const tz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return undefined; } };
const iso = (d: Date) => d.toISOString().slice(0, 10);

export function TopPerforming() {
  const { data: session } = useSession();
  const isAdmin = session?.role === "admin";
  const { metaAccountId, metaAccountName } = useCreativesContext();
  const accountId = metaAccountId ? normalizeAct(metaAccountId).replace(/^act_/, "") : null;

  const [days, setDays] = useState(30);
  const [custom, setCustom] = useState<DateRange | null>(null);
  const [compare, setCompare] = useState(false);
  const [groupBy, setGroupBy] = useState<GroupBy>("creative");
  const [view, setView] = useState<View>("cards");
  const [filters, setFilters] = useState<AdsFilters>({});
  const [search, setSearch] = useState("");
  const [launch, setLaunch] = useState<{ days: number; after: string | null }>({ days: 0, after: null });
  const launchDays = launch.days;
  const setLaunchDays = (d: number) => setLaunch({ days: d, after: d > 0 ? iso(new Date(Date.now() - d * 86400_000)) : null });
  const [showFilters, setShowFilters] = useState(false);
  const [metrics, setMetrics] = useState<MetricKey[]>(() => {
    if (typeof window === "undefined") return PRESETS[0].keys;
    try { const raw = localStorage.getItem(PRESET_STORAGE); if (raw) { const arr = JSON.parse(raw) as MetricKey[]; if (Array.isArray(arr) && arr.length) return arr; } } catch { /* ignore */ }
    return PRESETS[0].keys;
  });
  const [showMetrics, setShowMetrics] = useState(false);
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({ key: "spend", dir: "desc" });
  const [loadedResult, setResult] = useState<Result | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<AdsGroupRow | null>(null);
  const [chartMetric, setChartMetric] = useState<MetricKey>("spend");
  const [syncing, setSyncing] = useState(false);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  const range = useMemo<DateRange>(() => custom ?? lastFullDays(days, { tz: tz() }), [custom, days]);
  const query = useMemo<AdsQuery | null>(() => {
    if (!accountId) return null;
    const f: AdsFilters = { ...filters };
    if (search.trim()) f.nameContains = search.trim();
    if (launch.after) f.launchedAfter = launch.after;
    return { platforms: ["meta"], accountIds: [accountId], range, compare: compare ? prevRange(range) : null, groupBy, filters: f, sort: { key: sort.key, dir: sort.dir }, limit: 120 };
  }, [accountId, filters, search, launch.after, range, compare, groupBy, sort]);

  const result = query ? loadedResult : null;
  // Selection and curves are scoped: a new axis / account forgets the ticks, a new period forgets the curves.
  const checkScope = `${groupBy}|${accountId ?? ""}`;
  const [checkedState, setCheckedState] = useState<{ scope: string; set: Set<string> }>({ scope: checkScope, set: new Set() });
  const checked = useMemo(() => (checkedState.scope === checkScope ? checkedState.set : new Set<string>()), [checkedState, checkScope]);
  const setChecked = (fn: (s: Set<string>) => Set<string>) => setCheckedState((c) => ({ scope: checkScope, set: fn(c.scope === checkScope ? c.set : new Set()) }));
  const seriesScope = JSON.stringify([accountId, groupBy, range, compare, filters, search, launch.after]);
  const [seriesState, setSeriesState] = useState<{ scope: string; map: Record<string, DailyPoint[]> }>({ scope: seriesScope, map: {} });
  const series = useMemo<Record<string, DailyPoint[]>>(() => (seriesState.scope === seriesScope ? seriesState.map : {}), [seriesState, seriesScope]);

  const load = useCallback(async (q: AdsQuery) => {
    setLoading(true); setError(null);
    try {
      const res = await fetch("/api/ads/query", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...q, accounts: q.accountIds.map((id) => ({ platform: "meta", id })) }) });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `Erreur ${res.status}`);
      setResult(await res.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erreur");
    } finally { setLoading(false); }
  }, []);

  useEffect(() => {
    if (!query) return;
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => void load(query), 250);
    return () => { if (debounce.current) clearTimeout(debounce.current); };
  }, [query, load]);

  useEffect(() => { try { localStorage.setItem(PRESET_STORAGE, JSON.stringify(metrics)); } catch { /* ignore */ } }, [metrics]);

  // Curve view: one daily series per checked group (max 8), or the whole selection.
  useEffect(() => {
    if (view !== "chart" || !query) return;
    const keys = Array.from(checked).slice(0, 8);
    const want = keys.length ? keys : ["__all__"];
    const missing = want.filter((k) => !series[k]);
    if (!missing.length) return;
    let cancelled = false;
    (async () => {
      const out: Record<string, DailyPoint[]> = {};
      await Promise.all(missing.map(async (k) => {
        const res = await fetch("/api/ads/daily", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...query, accounts: query.accountIds.map((id) => ({ platform: "meta", id })), key: k === "__all__" ? null : k }) });
        const j = res.ok ? ((await res.json()) as { points: DailyPoint[] }) : { points: [] };
        out[k] = j.points ?? [];
      }));
      if (!cancelled) setSeriesState((s) => ({ scope: seriesScope, map: { ...(s.scope === seriesScope ? s.map : {}), ...out } }));
    })();
    return () => { cancelled = true; };
  }, [view, checked, query, series, seriesScope]);

  const onSort = (key: SortKey) => setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: key === "name" || key === "launch" ? "asc" : METRIC_BY_KEY[key as MetricKey]?.higherBetter === false ? "asc" : "desc" }));
  const toggleFormat = (f: AdFormat) => setFilters((x) => { const cur = new Set(x.formats ?? []); if (cur.has(f)) cur.delete(f); else cur.add(f); return { ...x, formats: cur.size ? Array.from(cur) : undefined }; });
  const activeFilters = (filters.formats?.length ? 1 : 0) + (filters.minSpend ? 1 : 0) + (filters.status ? 1 : 0) + (typeof filters.dynamic === "boolean" ? 1 : 0) + (launchDays ? 1 : 0);

  async function syncNow() {
    if (!accountId) return;
    setSyncing(true);
    try {
      await fetch("/api/admin/ads-sync", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accountIds: [accountId], platforms: ["meta"] }) });
      if (query) await load(query);
    } finally { setSyncing(false); }
  }

  const chartData = useMemo(() => {
    const keys = Array.from(checked).slice(0, 8);
    const want = keys.length ? keys : ["__all__"];
    const byDate = new Map<string, Record<string, number | string>>();
    for (const k of want) for (const p of series[k] ?? []) {
      const row = byDate.get(p.date) ?? { date: p.date };
      row[k] = p.metrics[chartMetric];
      byDate.set(p.date, row);
    }
    return { want, data: Array.from(byDate.values()).sort((a, b) => String(a.date).localeCompare(String(b.date))) };
  }, [checked, series, chartMetric]);
  const labelOf = (k: string) => (k === "__all__" ? "Tout le compte" : result?.rows.find((r) => r.key === k)?.label ?? k);

  const noWarehouse = result && result.rows.length === 0 && result.coverage.accounts === 0;
  const visibleMetrics = metrics.filter((k) => !(METRIC_BY_KEY[k]?.key === "roas" && result?.benchmark.roasUnavailable));

  return (
    <div className="flex flex-col min-h-full">
      {/* ── Bar: what am I looking at ── */}
      <div className="sticky top-0 z-20 bg-gray-950/95 backdrop-blur border-b border-gray-800 px-4 py-2 flex items-center gap-2 flex-wrap">
        <AccountPicker />
        <span className="h-6 w-px bg-gray-800" />
        <div className="flex items-center rounded-lg border border-gray-800 bg-gray-900 p-0.5">
          {PERIODS.map((d) => (
            <button key={d} type="button" onClick={() => { setCustom(null); setDays(d); }} className={`px-2 py-1 rounded-md text-xs ${!custom && days === d ? "bg-violet-600 text-white" : "text-gray-400 hover:text-white"}`}>{d} j</button>
          ))}
          <input type="date" value={range.since} max={range.until} onChange={(e) => setCustom({ since: e.target.value, until: range.until })} className="ml-1 bg-transparent text-[11px] text-gray-300 px-1" title="Début" />
          <span className="text-gray-600 text-[11px]">→</span>
          <input type="date" value={range.until} min={range.since} onChange={(e) => setCustom({ since: range.since, until: e.target.value })} className="bg-transparent text-[11px] text-gray-300 px-1" title="Fin" />
        </div>
        <label className={`inline-flex items-center gap-1.5 rounded-lg border px-2 py-1 text-xs cursor-pointer ${compare ? "border-violet-500/60 bg-violet-500/10 text-violet-200" : "border-gray-800 bg-gray-900 text-gray-400 hover:text-white"}`} title="Comparer à la période précédente de même durée">
          <input type="checkbox" checked={compare} onChange={(e) => setCompare(e.target.checked)} className="accent-violet-500" /> Comparer
        </label>
        <select value={groupBy} onChange={(e) => setGroupBy(e.target.value as GroupBy)} className="rounded-lg border border-gray-800 bg-gray-900 px-2 py-1.5 text-xs text-gray-200" title="Regrouper par">
          <optgroup label="Regrouper par">{GROUPS.map((g) => <option key={g.value} value={g.value} title={g.hint}>{g.label}</option>)}</optgroup>
          {result?.tagKeys.length ? <optgroup label="Tag de nommage">{result.tagKeys.map((t) => <option key={t.key} value={`tag:${t.key}`}>{t.key} ({t.count})</option>)}</optgroup> : null}
        </select>
        <button type="button" onClick={() => setShowFilters((v) => !v)} className={`inline-flex items-center gap-1.5 rounded-lg border px-2 py-1.5 text-xs ${activeFilters ? "border-violet-500/60 text-violet-200 bg-violet-500/10" : "border-gray-800 bg-gray-900 text-gray-400 hover:text-white"}`}>
          <SlidersHorizontal className="w-3.5 h-3.5" /> Filtres{activeFilters ? ` (${activeFilters})` : ""}
        </button>
        <div className="relative">
          <Search className="w-3.5 h-3.5 text-gray-500 absolute left-2 top-1/2 -translate-y-1/2" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Nom contient…" className="w-44 rounded-lg border border-gray-800 bg-gray-900 pl-7 pr-2 py-1.5 text-xs text-gray-200 placeholder:text-gray-600 focus:outline-none focus:border-violet-500" />
        </div>
        <div className="ml-auto flex items-center gap-2">
          <div className="relative">
            <button type="button" onClick={() => setShowMetrics((v) => !v)} className="inline-flex items-center gap-1.5 rounded-lg border border-gray-800 bg-gray-900 px-2 py-1.5 text-xs text-gray-400 hover:text-white"><BarChart3 className="w-3.5 h-3.5" /> Métriques ({metrics.length})</button>
            {showMetrics && (
              <div className="absolute right-0 mt-1 w-72 rounded-xl border border-gray-800 bg-gray-950 shadow-xl p-3 z-30">
                <div className="flex items-center justify-between mb-2"><span className="text-[10px] uppercase tracking-wide text-gray-500">Presets</span><button type="button" onClick={() => setShowMetrics(false)} className="text-gray-500 hover:text-white"><X className="w-3.5 h-3.5" /></button></div>
                <div className="flex flex-wrap gap-1 mb-3">{PRESETS.map((p) => <button key={p.id} type="button" onClick={() => setMetrics(p.keys)} className="rounded-md border border-gray-800 px-2 py-0.5 text-[11px] text-gray-300 hover:border-violet-500/50">{p.label}</button>)}</div>
                <div className="text-[10px] uppercase tracking-wide text-gray-500 mb-1">Colonnes (6 max sur les cartes)</div>
                <div className="max-h-64 overflow-y-auto space-y-0.5">
                  {METRICS.map((m) => (
                    <label key={m.key} className="flex items-center gap-2 text-xs text-gray-300 py-0.5 cursor-pointer" title={m.hint}>
                      <input type="checkbox" className="accent-violet-500" checked={metrics.includes(m.key)} onChange={(e) => setMetrics((cur) => (e.target.checked ? [...cur, m.key] : cur.filter((k) => k !== m.key)))} />
                      {m.label}{m.video ? <span className="text-[10px] text-gray-600">vidéo</span> : null}
                    </label>
                  ))}
                </div>
              </div>
            )}
          </div>
          <div className="flex items-center rounded-lg border border-gray-800 bg-gray-900 p-0.5">
            {([["cards", LayoutGrid, "Cartes"], ["table", TableIcon, "Tableau"], ["chart", LineIcon, "Courbe"]] as const).map(([v, Icon, l]) => (
              <button key={v} type="button" onClick={() => setView(v)} title={l} className={`p-1.5 rounded-md ${view === v ? "bg-violet-600 text-white" : "text-gray-400 hover:text-white"}`}><Icon className="w-3.5 h-3.5" /></button>
            ))}
          </div>
        </div>
      </div>

      {showFilters && (
        <div className="px-4 py-2 border-b border-gray-800 bg-gray-950 flex items-center gap-3 flex-wrap text-xs">
          <span className="text-gray-500">Format</span>
          {(["Video", "Image", "Carousel"] as AdFormat[]).map((f) => (
            <button key={f} type="button" onClick={() => toggleFormat(f)} className={`rounded-md border px-2 py-0.5 ${filters.formats?.includes(f) ? "border-violet-500/60 bg-violet-500/10 text-violet-200" : "border-gray-800 text-gray-400 hover:text-white"}`}>{f === "Video" ? "Vidéo" : f === "Image" ? "Image" : "Carrousel"}</button>
          ))}
          <button type="button" onClick={() => setFilters((x) => ({ ...x, dynamic: x.dynamic === true ? undefined : true }))} className={`rounded-md border px-2 py-0.5 ${filters.dynamic === true ? "border-violet-500/60 bg-violet-500/10 text-violet-200" : "border-gray-800 text-gray-400 hover:text-white"}`} title="Dynamic creative / Advantage+ seulement">Dynamic</button>
          <span className="h-4 w-px bg-gray-800" />
          <span className="text-gray-500">Dépense min.</span>
          <input type="number" min={0} value={filters.minSpend ?? ""} onChange={(e) => setFilters((x) => ({ ...x, minSpend: e.target.value ? Number(e.target.value) : undefined }))} placeholder="0" className="w-20 rounded-md border border-gray-800 bg-gray-900 px-2 py-0.5 text-gray-200" />
          <span className="h-4 w-px bg-gray-800" />
          <span className="text-gray-500">Lancées</span>
          <select value={launchDays} onChange={(e) => setLaunchDays(Number(e.target.value))} className="rounded-md border border-gray-800 bg-gray-900 px-2 py-0.5 text-gray-200">{LAUNCH.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}</select>
          <span className="h-4 w-px bg-gray-800" />
          <select value={filters.status ?? ""} onChange={(e) => setFilters((x) => ({ ...x, status: (e.target.value || undefined) as AdsFilters["status"] }))} className="rounded-md border border-gray-800 bg-gray-900 px-2 py-0.5 text-gray-200">
            <option value="">Actives et en pause</option><option value="active">Actives seulement</option><option value="inactive">En pause seulement</option>
          </select>
          {activeFilters > 0 && <button type="button" onClick={() => { setFilters({}); setLaunchDays(0); }} className="text-gray-500 hover:text-white inline-flex items-center gap-1"><X className="w-3 h-3" /> Effacer</button>}
        </div>
      )}

      {/* ── Provenance line ── */}
      <div className="px-4 py-1.5 text-[11px] text-gray-500 flex items-center gap-2 flex-wrap">
        {loading && <Loader2 className="w-3 h-3 animate-spin" />}
        {result && (
          <>
            <span>{result.total} {groupBy === "ad" ? "annonces" : "groupes"} · {range.since} → {range.until}{compare ? " · comparé à la période précédente" : ""}</span>
            {result.coverage.until && <span>· entrepôt à jour au {result.coverage.until}{result.coverage.since ? ` (depuis le ${result.coverage.since})` : ""}</span>}
            {!result.coverage.complete && result.coverage.accounts > 0 && <span className="text-amber-400">· historique en cours de chargement</span>}
            {result.benchmark.estimated && <span>· * valeur estimée via panier moyen</span>}
            {isAdmin && <button type="button" onClick={syncNow} disabled={syncing} className="inline-flex items-center gap-1 text-gray-400 hover:text-white disabled:opacity-50" title="Relire la plateforme maintenant (admin)"><RefreshCw className={`w-3 h-3 ${syncing ? "animate-spin" : ""}`} /> Synchroniser</button>}
          </>
        )}
        {error && <span className="text-red-400">{error}</span>}
      </div>

      {/* ── Body ── */}
      <div className="px-4 pb-8 flex-1">
        {!accountId && <Empty title="Choisis un compte" text="Analyse Ads lit l'entrepôt créa du compte sélectionné. Choisis un client ci-dessus (ou ⌘K)." />}
        {accountId && noWarehouse && (
          <Empty title={`${metaAccountName ?? "Ce compte"} n'est pas encore synchronisé`} text="L'entrepôt se remplit automatiquement toutes les heures (30 jours d'abord, puis l'historique). Reviens dans une heure, ou lance la synchronisation maintenant si tu es admin.">
            {isAdmin && <button type="button" onClick={syncNow} disabled={syncing} className="mt-3 inline-flex items-center gap-2 rounded-lg bg-violet-600 hover:bg-violet-500 px-3 py-1.5 text-sm text-white disabled:opacity-50">{syncing ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />} Synchroniser maintenant (≈ 1 min)</button>}
          </Empty>
        )}
        {accountId && result && !noWarehouse && result.rows.length === 0 && <Empty title="Rien sur cette période" text="Aucune annonce ne correspond aux filtres. Élargis la période ou retire un filtre." />}

        {result && result.rows.length > 0 && view === "cards" && (
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-3">
            {result.rows.map((r) => <AdCard key={r.key} row={r} metrics={visibleMetrics.slice(0, 6)} benchmark={result.benchmark} currency={result.currency} compare={compare} onOpen={setOpen} />)}
          </div>
        )}
        {result && result.rows.length > 0 && view === "table" && (
          <AdsTable rows={result.rows} metrics={visibleMetrics} benchmark={result.benchmark} benchmarkPrevious={result.benchmarkPrevious} currency={result.currency} compare={compare} sort={sort} onSort={onSort} checked={checked} onCheck={(k, on) => setChecked((s) => { const n = new Set(s); if (on) n.add(k); else n.delete(k); return n; })} onOpen={setOpen} />
        )}
        {result && result.rows.length > 0 && view === "chart" && (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-xs text-gray-400">
              <span>Métrique</span>
              <select value={chartMetric} onChange={(e) => setChartMetric(e.target.value as MetricKey)} className="rounded-md border border-gray-800 bg-gray-900 px-2 py-1 text-gray-200">{METRICS.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}</select>
              <span className="text-gray-600">· coche jusqu&apos;à 8 lignes dans le tableau pour les comparer ; sans sélection, la courbe montre tout le compte.</span>
            </div>
            <div className="h-80 rounded-2xl border border-gray-800 bg-gray-900 p-3">
              {chartData.data.length === 0 ? <div className="h-full flex items-center justify-center text-gray-500 text-xs"><Loader2 className="w-4 h-4 animate-spin mr-2" /> Chargement…</div> : (
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={chartData.data} margin={{ top: 8, right: 16, left: -8, bottom: 0 }}>
                    <XAxis dataKey="date" tick={{ fontSize: 10, fill: "#6b7280" }} tickLine={false} axisLine={false} tickFormatter={(d: string) => new Date(d + "T00:00:00Z").toLocaleDateString("fr-FR", { day: "numeric", month: "short", timeZone: "UTC" })} />
                    <YAxis tick={{ fontSize: 10, fill: "#6b7280" }} tickLine={false} axisLine={false} />
                    <Tooltip contentStyle={{ background: "#111827", border: "1px solid #374151", fontSize: 11 }} formatter={(v, name) => [fmtMetric(chartMetric, Number(v ?? 0), result.currency), labelOf(String(name))]} />
                    <Legend formatter={(v: string) => <span className="text-[11px] text-gray-300">{labelOf(v).slice(0, 40)}</span>} />
                    {chartData.want.map((k, i) => <Line key={k} type="monotone" dataKey={k} stroke={COLORS[i % COLORS.length]} strokeWidth={2} dot={false} connectNulls />)}
                  </LineChart>
                </ResponsiveContainer>
              )}
            </div>
            <AdsTable rows={result.rows} metrics={visibleMetrics} benchmark={result.benchmark} benchmarkPrevious={result.benchmarkPrevious} currency={result.currency} compare={compare} sort={sort} onSort={onSort} checked={checked} onCheck={(k, on) => setChecked((s) => { const n = new Set(s); if (on) n.add(k); else n.delete(k); return n; })} onOpen={setOpen} />
          </div>
        )}
      </div>

      {open && query && result && <AdDrawer row={open} query={query} benchmark={result.benchmark} currency={result.currency} onClose={() => setOpen(null)} />}
    </div>
  );
}

function Empty({ title, text, children }: { title: string; text: string; children?: React.ReactNode }) {
  return (
    <div className="mt-10 mx-auto max-w-md text-center">
      <div className="text-base font-semibold text-white">{title}</div>
      <p className="mt-1 text-sm text-gray-400">{text}</p>
      {children}
    </div>
  );
}
