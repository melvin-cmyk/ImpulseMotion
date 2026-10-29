"use client";

/**
 * Analyse Ads v2 — Motion-style report on the creative warehouse.
 *
 * Layout: [report sidebar: client's saved reports + templates] [report].
 * A report = ViewConfig (period, compare, group by, filters, metrics, view,
 * sort). Templates are built in (lib/ads-warehouse/views.ts); the consultant
 * saves their own per client account (AnalyseView). Everything reads
 * /api/ads/query — no live platform call.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSession } from "next-auth/react";
import { useRouter, useSearchParams } from "next/navigation";
import { BarChart3, ChevronDown, LayoutGrid, LineChart as LineIcon, Loader2, Plus, RefreshCw, Search, Table as TableIcon, X } from "lucide-react";
import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis, Legend } from "recharts";
import { useCreativesContext } from "@/lib/creatives-context";
import { AccountPicker } from "@/components/account-picker";
import type { AdsFilters, AdsGroupRow, AdsQuery, AdsQueryResult, DailyPoint, GroupBy, MetricKey } from "@/lib/ads-warehouse/query";
import type { AdFormat } from "@/lib/ads-warehouse/types";
import { METRICS, METRIC_BY_KEY, PRESETS, fmtMetric } from "@/lib/ads-warehouse/metrics-ui";
import { VIEW_TEMPLATES, type ViewConfig, type ViewMode } from "@/lib/ads-warehouse/views";
import { lastFullDays, prevRange, type DateRange } from "@/lib/date-ranges";
import { normalizeAct } from "@/lib/use-account-list";
import { AdCard } from "./ad-card";
import { AdsTable } from "./ads-table";
import { AdsBar } from "./ads-bar";
import { AdDrawer } from "./ad-drawer";
import { tagKeyLabel } from "./shared";
import { ReportSidebar, type SavedView } from "./report-sidebar";
import { CopilotPanel } from "./copilot-panel";
import { CompetitorsPanel } from "./competitors-panel";
import { COPILOT_SUGGESTIONS } from "@/lib/ads-warehouse/copilot";
import { MessageSquare } from "lucide-react";

type SortKey = MetricKey | "name" | "adCount" | "launch";
type Result = AdsQueryResult & { tagKeys: Array<{ key: string; count: number }> };
type Facets = Array<{ key: string; count: number; values: Array<{ value: string; count: number }> }>;

const GROUPS: Array<{ value: GroupBy; label: string; hint: string }> = [
  { value: "creative", label: "Créa", hint: "Un même visuel, toutes annonces confondues" },
  { value: "ad", label: "Annonce", hint: "Une ligne par annonce" },
  { value: "campaign", label: "Campagne", hint: "" },
  { value: "adset", label: "Ad set", hint: "" },
  { value: "format", label: "Format", hint: "Vidéo / Image / Carrousel" },
  { value: "landing", label: "Landing page", hint: "URL de destination" },
  { value: "copy", label: "Texte", hint: "Texte principal" },
  { value: "title", label: "Titre", hint: "Titre / accroche" },
  { value: "launch_week", label: "Semaine de lancement", hint: "" },
];
const PERIODS = [7, 14, 30, 60, 90, 180];
const LAUNCH = [{ v: 0, l: "Toutes" }, { v: 7, l: "7 derniers jours" }, { v: 14, l: "14 derniers jours" }, { v: 30, l: "30 derniers jours" }, { v: 90, l: "90 derniers jours" }];
const CHIP_COLORS = ["bg-violet-500/20 text-violet-200 border-violet-500/40", "bg-rose-500/20 text-rose-200 border-rose-500/40", "bg-emerald-500/20 text-emerald-200 border-emerald-500/40", "bg-amber-500/20 text-amber-200 border-amber-500/40", "bg-sky-500/20 text-sky-200 border-sky-500/40", "bg-pink-500/20 text-pink-200 border-pink-500/40", "bg-teal-500/20 text-teal-200 border-teal-500/40", "bg-orange-500/20 text-orange-200 border-orange-500/40"];
const LINE_COLORS = ["#8b5cf6", "#f59e0b", "#10b981", "#3b82f6", "#ec4899", "#14b8a6", "#f97316", "#a3e635"];
const LAST_VIEW = "impulsemotion.analyse.lastView";

const tz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return undefined; } };
const iso = (d: Date) => d.toISOString().slice(0, 10);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function TopPerforming() {
  const { data: session } = useSession();
  const isAdmin = session?.role === "admin";
  const { metaAccountId, metaAccountName } = useCreativesContext();
  const params = useSearchParams();
  const router = useRouter();
  const threadParam = params.get("thread");
  const [threadClient, setThreadClient] = useState<{ thread: string; clientParam: string | null } | null>(null);
  const clientParam = params.get("client") ?? threadClient?.clientParam ?? null;
  const metaId = metaAccountId ? normalizeAct(metaAccountId).replace(/^act_/, "") : null;

  // The client behind the selected Meta account (GET /api/clients) brings its
  // Google customer and TikTok advertisers: one report, every platform.
  const [clientsState, setClientsState] = useState<Array<{ id: string; clientId: string; aliasIds: string[]; name: string; metaAccountId: string | null; accounts: Array<{ platform: "meta" | "google" | "tiktok"; id: string; name: string }> }> | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/clients").then((r) => (r.ok ? r.json() : { clients: [] })).then((j: { clients: typeof clientsState }) => { if (!cancelled) setClientsState(j.clients ?? []); }).catch(() => { if (!cancelled) setClientsState([]); });
    return () => { cancelled = true; };
  }, []);
  // Selected client: ?client=<id> (from the Clients list / cockpit, works for Google-only or TikTok-only clients)
  // or, by default, the client behind the Meta account chosen in the picker.
  const client = useMemo(() => {
    if (!clientsState) return null;
    if (clientParam) return clientsState.find((c) => c.clientId === clientParam || c.id === clientParam || c.aliasIds.includes(clientParam)) ?? null;
    return metaId ? clientsState.find((c) => (c.metaAccountId ?? "").replace(/^act_/, "") === metaId) ?? null : null;
  }, [clientsState, clientParam, metaId]);
  const accountId = client?.metaAccountId ? client.metaAccountId.replace(/^act_/, "") : clientParam ? null : metaId;
  const accountKey = client ? `client:${client.clientId}` : accountId ? `meta:${accountId}` : null;
  const clientName = client?.name ?? metaAccountName ?? null;
  const accounts = useMemo(() => {
    if (client) return client.accounts.map((a) => ({ platform: a.platform, id: a.id }));
    return accountId ? [{ platform: "meta" as const, id: accountId }] : [];
  }, [accountId, client]);
  const hasAccounts = accounts.length > 0;
  const [platformsOff, setPlatformsOff] = useState<Set<string>>(new Set());
  // Memoised: a new array on every render would rebuild the query and refetch the report on each click (copilot, drawer…).
  const activeAccounts = useMemo(() => accounts.filter((a) => !platformsOff.has(a.platform)), [accounts, platformsOff]);

  // ── Report configuration (one object = one report) ──
  const [config, setConfig] = useState<ViewConfig>(VIEW_TEMPLATES[0].config);
  const [activeId, setActiveId] = useState<string>(`tpl:${VIEW_TEMPLATES[0].id}`);
  const [baseline, setBaseline] = useState<ViewConfig>(VIEW_TEMPLATES[0].config);
  const dirty = !same(config, baseline);
  const patch = (p: Partial<ViewConfig>) => setConfig((c) => ({ ...c, ...p }));
  const patchFilters = (p: Partial<AdsFilters>) => setConfig((c) => ({ ...c, filters: { ...c.filters, ...p } }));
  const apply = (id: string, cfg: ViewConfig) => { setConfig(cfg); setBaseline(cfg); setActiveId(id); try { localStorage.setItem(LAST_VIEW, id); } catch { /* ignore */ } };

  const [search, setSearch] = useState("");
  const [showMetrics, setShowMetrics] = useState(false);
  const [showAddFilter, setShowAddFilter] = useState<null | "menu" | `tag:${string}` | "spend" | "launch" | "campaign">(null);
  const [open, setOpen] = useState<AdsGroupRow | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [copilot, setCopilot] = useState<{ open: boolean; prompt: string | null }>({ open: false, prompt: null });
  // « Créas » (the client's own ads) or « Concurrents » (its competitors' ads in the Meta Ad Library); ?tab=concurrents opens the latter.
  const [section, setSection] = useState<"ads" | "competitors">(() => (params.get("tab") === "concurrents" ? "competitors" : "ads"));
  // ?thread=<id> (the « réponse prête » notice): open the client of that thread and its copilot.
  useEffect(() => {
    if (!threadParam || threadClient?.thread === threadParam) return;
    let cancelled = false;
    fetch(`/api/ads/copilot?threadId=${encodeURIComponent(threadParam)}`).then((r) => (r.ok ? r.json() : null)).then((j: { clientParam?: string | null } | null) => {
      if (cancelled) return;
      queueMicrotask(() => {
      setThreadClient({ thread: threadParam, clientParam: j?.clientParam ?? null });
      setCopilot({ open: true, prompt: null });
      router.replace(j?.clientParam ? `/analyse?client=${encodeURIComponent(j.clientParam)}` : "/analyse");
      });
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [threadParam, threadClient, router]);


  // ── Saved reports ──
  const [savedState, setSavedState] = useState<{ key: string; views: SavedView[] }>({ key: "", views: [] });
  const saved = savedState.key === accountKey ? savedState.views : [];
  const [savedLoading, setSavedLoading] = useState(false);
  const loadSaved = useCallback(async () => {
    if (!accountKey) return;
    setSavedLoading(true);
    try { const r = await fetch(`/api/ads/views?accountKey=${accountKey}`); setSavedState({ key: accountKey, views: r.ok ? ((await r.json()) as { views: SavedView[] }).views : [] }); } finally { setSavedLoading(false); }
  }, [accountKey]);
  useEffect(() => { queueMicrotask(() => { void loadSaved(); }); }, [loadSaved]);

  // ── Query ──
  const range = useMemo<DateRange>(() => (config.since && config.until ? { since: config.since, until: config.until } : lastFullDays(config.days, { tz: tz() })), [config.since, config.until, config.days]);
  const [today] = useState(() => iso(new Date()));
  const launchAfter = useMemo(() => { if (!config.launchDays) return null; const d = new Date(today + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() - config.launchDays); return iso(d); }, [config.launchDays, today]);
  const query = useMemo<AdsQuery | null>(() => {
    if (!hasAccounts) return null;
    const f: AdsFilters = { ...config.filters };
    if (search.trim()) f.nameContains = search.trim();
    if (launchAfter && !f.launchedAfter) f.launchedAfter = launchAfter;
    const acc = activeAccounts.length ? activeAccounts : accounts;
    return { platforms: Array.from(new Set(acc.map((a) => a.platform))), accountIds: Array.from(new Set(acc.map((a) => a.id))), accounts: acc, range, compare: config.compare ? prevRange(range) : null, groupBy: config.groupBy, filters: f, sort: config.sort, limit: 120 } as AdsQuery & { accounts: typeof acc };
  }, [hasAccounts, accounts, activeAccounts, config.filters, config.compare, config.groupBy, config.sort, search, launchAfter, range]);

  const [loadedResult, setResult] = useState<Result | null>(null);
  const result = query ? loadedResult : null;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const load = useCallback(async (q: AdsQuery) => {
    setLoading(true); setError(null);
    try {
      const res = await fetch("/api/ads/query", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(q) });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `Erreur ${res.status}`);
      setResult(await res.json());
    } catch (e) { setError(e instanceof Error ? e.message : "Erreur"); } finally { setLoading(false); }
  }, []);
  useEffect(() => {
    if (!query) return;
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => void load(query), 250);
    return () => { if (debounce.current) clearTimeout(debounce.current); };
  }, [query, load]);

  // ── Facets (naming-convention values) ──
  const [facetsState, setFacets] = useState<{ key: string; facets: Facets } | null>(null);
  const facets = facetsState && facetsState.key === accountKey ? facetsState.facets : [];
  useEffect(() => {
    if (!hasAccounts || !accountKey) return;
    let cancelled = false;
    fetch("/api/ads/facets", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ platforms: Array.from(new Set(accounts.map((a) => a.platform))), accounts, range: { since: "2020-01-01", until: "2020-01-02" } }) })
      .then((r) => (r.ok ? r.json() : { keys: [] })).then((j: { keys: Facets }) => { if (!cancelled) setFacets({ key: accountKey, facets: j.keys ?? [] }); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [hasAccounts, accountKey, accounts]);

  // ── Curve view ──
  const checkScope = `${config.groupBy}|${accountKey ?? ""}`;
  const [checkedState, setCheckedState] = useState<{ scope: string; set: Set<string> }>({ scope: checkScope, set: new Set() });
  const checked = useMemo(() => (checkedState.scope === checkScope ? checkedState.set : new Set<string>()), [checkedState, checkScope]);
  const setChecked = (fn: (s: Set<string>) => Set<string>) => setCheckedState((c) => ({ scope: checkScope, set: fn(c.scope === checkScope ? c.set : new Set()) }));
  const seriesScope = JSON.stringify([accountKey, config.groupBy, range, config.compare, config.filters, search, launchAfter]);
  const [seriesState, setSeriesState] = useState<{ scope: string; map: Record<string, DailyPoint[]> }>({ scope: seriesScope, map: {} });
  const series = useMemo<Record<string, DailyPoint[]>>(() => (seriesState.scope === seriesScope ? seriesState.map : {}), [seriesState, seriesScope]);
  const [chartMetric, setChartMetric] = useState<MetricKey>("spend");
  useEffect(() => {
    if (config.view !== "chart" || !query) return;
    const keys = Array.from(checked).slice(0, 8);
    const want = keys.length ? keys : ["__all__"];
    const missing = want.filter((k) => !series[k]);
    if (!missing.length) return;
    let cancelled = false;
    (async () => {
      const out: Record<string, DailyPoint[]> = {};
      await Promise.all(missing.map(async (k) => {
        const res = await fetch("/api/ads/daily", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...query, key: k === "__all__" ? null : k }) });
        out[k] = res.ok ? (((await res.json()) as { points: DailyPoint[] }).points ?? []) : [];
      }));
      if (!cancelled) setSeriesState((s) => ({ scope: seriesScope, map: { ...(s.scope === seriesScope ? s.map : {}), ...out } }));
    })();
    return () => { cancelled = true; };
  }, [config.view, checked, query, series, seriesScope]);
  const chartData = useMemo(() => {
    const keys = Array.from(checked).slice(0, 8);
    const want = keys.length ? keys : ["__all__"];
    const byDate = new Map<string, Record<string, number | string>>();
    for (const k of want) for (const p of series[k] ?? []) { const row = byDate.get(p.date) ?? { date: p.date }; row[k] = p.metrics[chartMetric]; byDate.set(p.date, row); }
    return { want, data: Array.from(byDate.values()).sort((a, b) => String(a.date).localeCompare(String(b.date))) };
  }, [checked, series, chartMetric]);
  const labelOf = (k: string) => (k === "__all__" ? "Tout le compte" : result?.rows.find((r) => r.key === k)?.label ?? k);

  // ── Actions ──
  const onSort = (key: SortKey) => patch({ sort: config.sort.key === key ? { key, dir: config.sort.dir === "asc" ? "desc" : "asc" } : { key, dir: key === "name" || key === "launch" ? "asc" : METRIC_BY_KEY[key as MetricKey]?.higherBetter === false ? "asc" : "desc" } });
  const toggleFormat = (f: AdFormat) => { const cur = new Set(config.filters.formats ?? []); if (cur.has(f)) cur.delete(f); else cur.add(f); patchFilters({ formats: cur.size ? Array.from(cur) : undefined }); };
  async function syncNow() {
    if (!hasAccounts) return;
    setSyncing(true);
    try {
      for (const p of Array.from(new Set(accounts.map((a) => a.platform)))) await fetch("/api/admin/ads-sync", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accountIds: accounts.filter((a) => a.platform === p).map((a) => a.id), platforms: [p] }) });
      if (query) await load(query);
    } finally { setSyncing(false); }
  }
  async function saveView(name: string, emoji: string) {
    if (!accountKey) return;
    const r = await fetch("/api/ads/views", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accountKey, name, emoji, config }) });
    if (r.ok) { const { id } = (await r.json()) as { id: string }; await loadSaved(); setActiveId(id); setBaseline(config); }
  }
  async function updateView(id: string) { await fetch(`/api/ads/views/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ config }) }); setBaseline(config); await loadSaved(); }
  async function renameView(id: string, name: string, emoji: string) { await fetch(`/api/ads/views/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, emoji }) }); await loadSaved(); }
  async function deleteView(id: string) { await fetch(`/api/ads/views/${id}`, { method: "DELETE" }); if (activeId === id) apply(`tpl:${VIEW_TEMPLATES[0].id}`, VIEW_TEMPLATES[0].config); await loadSaved(); }

  // ── Derived ──
  const noWarehouse = result && result.rows.length === 0 && result.coverage.accounts === 0;
  const visibleMetrics = config.metrics.filter((k) => !(k === "roas" && result?.benchmark.roasUnavailable));
  const activeTemplate = VIEW_TEMPLATES.find((t) => `tpl:${t.id}` === activeId);
  const activeSaved = saved.find((v) => v.id === activeId);
  const title = activeSaved ? `${activeSaved.emoji} ${activeSaved.name}` : activeTemplate ? `${activeTemplate.emoji} ${activeTemplate.name}` : "Rapport";
  const subtitle = activeTemplate?.description ?? (activeSaved ? `Rapport enregistré${activeSaved.createdByName ? ` par ${activeSaved.createdByName}` : ""}` : "");
  const f = config.filters;
  const chips: Array<{ id: string; label: string; clear: () => void }> = [];
  for (const fmt of f.formats ?? []) chips.push({ id: `fmt:${fmt}`, label: `Format : ${fmt === "Video" ? "Vidéo" : fmt === "Image" ? "Image" : "Carrousel"}`, clear: () => toggleFormat(fmt) });
  if (f.dynamic === true) chips.push({ id: "dyn", label: "Dynamic seulement", clear: () => patchFilters({ dynamic: undefined }) });
  if (f.minSpend) chips.push({ id: "spend", label: `Dépense > ${f.minSpend}`, clear: () => patchFilters({ minSpend: undefined }) });
  if (config.launchDays) chips.push({ id: "launch", label: `Lancées : ${LAUNCH.find((l) => l.v === config.launchDays)?.l ?? config.launchDays + " j"}`, clear: () => patch({ launchDays: 0 }) });
  if (f.status) chips.push({ id: "status", label: f.status === "active" ? "Actives seulement" : "En pause seulement", clear: () => patchFilters({ status: undefined }) });
  if (f.campaignContains) chips.push({ id: "camp", label: `Campagne contient « ${f.campaignContains} »`, clear: () => patchFilters({ campaignContains: undefined }) });
  for (const [k, v] of Object.entries(f.tags ?? {})) chips.push({ id: `tag:${k}`, label: `${tagKeyLabel(k)} = ${v}`, clear: () => { const t = { ...(f.tags ?? {}) }; delete t[k]; patchFilters({ tags: Object.keys(t).length ? t : undefined }); } });

  return (
    <div className={`flex min-h-full ${copilot.open ? "pr-[400px]" : ""}`}>
      <ReportSidebar accountKey={accountKey} saved={saved} loading={savedLoading} activeId={activeId} dirty={dirty} onPick={apply} onSave={saveView} onUpdate={updateView} onRename={renameView} onDelete={deleteView} />

      <div className="flex-1 min-w-0 flex flex-col">
        {/* ── Header ── */}
        <div className="px-6 pt-4 pb-2 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-lg font-semibold text-white truncate">{section === "competitors" ? "Concurrents" : title}{section === "ads" && dirty && <span className="ml-2 text-[10px] font-normal text-amber-400 align-middle">modifié</span>}</h1>
            <p className="text-xs text-gray-500">{client ? <span className="text-gray-300">{client.name}</span> : null}{section === "competitors" ? (client ? " · leurs pubs en ce moment dans la bibliothèque Meta" : "") : <>{client && subtitle ? " · " : ""}{subtitle}</>}</p>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex items-center rounded-lg border border-gray-800 bg-gray-900 p-0.5">
              {([["ads", "Créas du client"], ["competitors", "Concurrents"]] as const).map(([v, l]) => (
                <button key={v} type="button" onClick={() => setSection(v)} className={`px-2.5 py-1 rounded-md text-xs ${section === v ? "bg-violet-600 text-white" : "text-gray-400 hover:text-white"}`}>{l}</button>
              ))}
            </div>
            {section === "ads" && accounts.length > 1 && (
              <div className="flex items-center rounded-lg border border-gray-800 bg-gray-900 p-0.5" title="Plateformes incluses dans le rapport">
                {(["meta", "google", "tiktok"] as const).filter((p) => accounts.some((a) => a.platform === p)).map((p) => (
                  <button key={p} type="button" onClick={() => setPlatformsOff((s) => { const n = new Set(s); if (n.has(p)) n.delete(p); else if (activeAccounts.filter((a) => a.platform !== p).length) n.add(p); return n; })} className={`px-2 py-1 rounded-md text-xs ${platformsOff.has(p) ? "text-gray-500 line-through" : p === "meta" ? "bg-blue-500/15 text-blue-200" : p === "google" ? "bg-emerald-500/15 text-emerald-200" : "bg-violet-500/15 text-violet-200"}`}>{p === "meta" ? "Meta" : p === "google" ? "Google" : "TikTok"}</button>
                ))}
              </div>
            )}
            <AccountPicker />
          </div>
        </div>

        {section === "competitors" ? <CompetitorsPanel key={client?.clientId ?? "none"} clientId={client?.clientId ?? null} clientName={clientName} /> : (<>
        {/* ── Control bar ── */}
        <div className="px-6 py-2 flex items-center gap-2 flex-wrap">
          <div className="flex items-center rounded-lg border border-gray-800 bg-gray-900 p-0.5">
            {PERIODS.map((d) => <button key={d} type="button" onClick={() => patch({ days: d, since: undefined, until: undefined })} className={`px-2 py-1 rounded-md text-xs ${!config.since && config.days === d ? "bg-violet-600 text-white" : "text-gray-400 hover:text-white"}`}>{d} j</button>)}
            <input type="date" value={range.since} max={range.until} onChange={(e) => patch({ since: e.target.value, until: range.until })} className="ml-1 bg-transparent text-[11px] text-gray-300 px-1" title="Début" />
            <span className="text-gray-600 text-[11px]">→</span>
            <input type="date" value={range.until} min={range.since} onChange={(e) => patch({ since: range.since, until: e.target.value })} className="bg-transparent text-[11px] text-gray-300 px-1" title="Fin" />
          </div>
          <label className={`inline-flex items-center gap-1.5 rounded-lg border px-2 py-1 text-xs cursor-pointer ${config.compare ? "border-violet-500/60 bg-violet-500/10 text-violet-200" : "border-gray-800 bg-gray-900 text-gray-400 hover:text-white"}`} title="Comparer à la période précédente de même durée">
            <input type="checkbox" checked={config.compare} onChange={(e) => patch({ compare: e.target.checked })} className="accent-violet-500" /> Comparer
          </label>
          <div className="relative">
            <select value={config.groupBy} onChange={(e) => patch({ groupBy: e.target.value as GroupBy })} className="appearance-none rounded-lg border border-gray-800 bg-gray-900 pl-2 pr-7 py-1.5 text-xs text-gray-200" title="Regrouper par">
              <optgroup label="Regrouper par">{GROUPS.map((g) => <option key={g.value} value={g.value} title={g.hint}>{g.label}</option>)}</optgroup>
              {result?.tagKeys.some((t) => t.key.startsWith("ai:")) ? <optgroup label="Tags IA">{result.tagKeys.filter((t) => t.key.startsWith("ai:")).map((t) => <option key={t.key} value={`tag:${t.key}`}>{tagKeyLabel(t.key)} ({t.count})</option>)}</optgroup> : null}
              {result?.tagKeys.some((t) => !t.key.startsWith("ai:")) ? <optgroup label="Convention de nommage">{result.tagKeys.filter((t) => !t.key.startsWith("ai:")).map((t) => <option key={t.key} value={`tag:${t.key}`}>{t.key} ({t.count})</option>)}</optgroup> : null}
            </select>
            <ChevronDown className="w-3 h-3 text-gray-500 absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none" />
          </div>
          {chips.map((c) => (
            <span key={c.id} className="inline-flex items-center gap-1 rounded-lg border border-violet-500/40 bg-violet-500/10 px-2 py-1 text-xs text-violet-100">{c.label}<button type="button" onClick={c.clear} className="text-violet-300 hover:text-white" aria-label="Retirer"><X className="w-3 h-3" /></button></span>
          ))}
          <div className="relative">
            <button type="button" onClick={() => setShowAddFilter((v) => (v ? null : "menu"))} className="inline-flex items-center gap-1.5 rounded-lg border border-gray-800 bg-gray-900 px-2 py-1.5 text-xs text-gray-300 hover:text-white"><Plus className="w-3.5 h-3.5" /> Ajouter un filtre</button>
            {showAddFilter && (
              <div className="absolute left-0 mt-1 w-72 rounded-xl border border-gray-800 bg-gray-950 shadow-xl p-2 z-30 text-xs">
                {showAddFilter === "menu" && (
                  <div className="space-y-0.5">
                    <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-gray-500">Format</div>
                    <div className="px-2 pb-1 flex gap-1">{(["Video", "Image", "Carousel"] as AdFormat[]).map((fm) => <button key={fm} type="button" onClick={() => toggleFormat(fm)} className={`rounded-md border px-2 py-0.5 ${f.formats?.includes(fm) ? "border-violet-500/60 bg-violet-500/10 text-violet-200" : "border-gray-800 text-gray-400 hover:text-white"}`}>{fm === "Video" ? "Vidéo" : fm === "Image" ? "Image" : "Carrousel"}</button>)}<button type="button" onClick={() => patchFilters({ dynamic: f.dynamic === true ? undefined : true })} className={`rounded-md border px-2 py-0.5 ${f.dynamic === true ? "border-violet-500/60 bg-violet-500/10 text-violet-200" : "border-gray-800 text-gray-400 hover:text-white"}`}>Dynamic</button></div>
                    <button type="button" onClick={() => setShowAddFilter("spend")} className="w-full text-left px-2 py-1.5 rounded-md hover:bg-gray-800 text-gray-200">Dépense minimale…</button>
                    <button type="button" onClick={() => setShowAddFilter("launch")} className="w-full text-left px-2 py-1.5 rounded-md hover:bg-gray-800 text-gray-200">Date de lancement…</button>
                    <button type="button" onClick={() => setShowAddFilter("campaign")} className="w-full text-left px-2 py-1.5 rounded-md hover:bg-gray-800 text-gray-200">Campagne ou ad set contient…</button>
                    <div className="px-2 pt-1 text-[10px] uppercase tracking-wide text-gray-500">Statut</div>
                    <div className="px-2 pb-1 flex gap-1">{([["", "Toutes"], ["active", "Actives"], ["inactive", "En pause"]] as const).map(([v, l]) => <button key={v} type="button" onClick={() => patchFilters({ status: (v || undefined) as AdsFilters["status"] })} className={`rounded-md border px-2 py-0.5 ${(f.status ?? "") === v ? "border-violet-500/60 bg-violet-500/10 text-violet-200" : "border-gray-800 text-gray-400 hover:text-white"}`}>{l}</button>)}</div>
                    {facets.some((fa) => fa.key.startsWith("ai:")) && <div className="px-2 pt-1 text-[10px] uppercase tracking-wide text-gray-500">Tags IA</div>}
                    {facets.filter((fa) => fa.key.startsWith("ai:")).map((fa) => <button key={fa.key} type="button" onClick={() => setShowAddFilter(`tag:${fa.key}`)} className="w-full text-left px-2 py-1 rounded-md hover:bg-gray-800 text-gray-200 flex justify-between"><span>{tagKeyLabel(fa.key)}</span><span className="text-gray-600">{fa.values.length} valeurs</span></button>)}
                    {facets.some((fa) => !fa.key.startsWith("ai:")) && <div className="px-2 pt-1 text-[10px] uppercase tracking-wide text-gray-500">Convention de nommage</div>}
                    {facets.filter((fa) => !fa.key.startsWith("ai:")).slice(0, 12).map((fa) => <button key={fa.key} type="button" onClick={() => setShowAddFilter(`tag:${fa.key}`)} className="w-full text-left px-2 py-1 rounded-md hover:bg-gray-800 text-gray-200 flex justify-between"><span>{fa.key}</span><span className="text-gray-600">{fa.values.length} valeurs</span></button>)}
                  </div>
                )}
                {showAddFilter === "spend" && <div className="p-2 space-y-2"><div className="text-gray-400">Dépense minimale sur la période</div><input type="number" min={0} autoFocus defaultValue={f.minSpend ?? ""} onKeyDown={(e) => { if (e.key === "Enter") { patchFilters({ minSpend: Number((e.target as HTMLInputElement).value) || undefined }); setShowAddFilter(null); } }} className="w-full bg-gray-900 border border-gray-800 rounded-md px-2 py-1 text-white" placeholder="ex. 100 puis Entrée" /></div>}
                {showAddFilter === "launch" && <div className="p-1">{LAUNCH.map((o) => <button key={o.v} type="button" onClick={() => { patch({ launchDays: o.v }); setShowAddFilter(null); }} className={`w-full text-left px-2 py-1.5 rounded-md hover:bg-gray-800 ${config.launchDays === o.v ? "text-violet-200" : "text-gray-200"}`}>{o.l}</button>)}</div>}
                {showAddFilter === "campaign" && <div className="p-2 space-y-2"><div className="text-gray-400">Nom de campagne ou d&apos;ad set contient</div><input autoFocus defaultValue={f.campaignContains ?? ""} onKeyDown={(e) => { if (e.key === "Enter") { patchFilters({ campaignContains: (e.target as HTMLInputElement).value.trim() || undefined }); setShowAddFilter(null); } }} className="w-full bg-gray-900 border border-gray-800 rounded-md px-2 py-1 text-white" placeholder="ex. retargeting puis Entrée" /></div>}
                {showAddFilter.startsWith("tag:") && (() => { const k = showAddFilter.slice(4); const fa = facets.find((x) => x.key === k); return (
                  <div className="p-1 max-h-72 overflow-y-auto">
                    <div className="px-2 py-1 text-gray-400">{tagKeyLabel(k)} est…</div>
                    {(fa?.values ?? []).map((v) => <button key={v.value} type="button" onClick={() => { patchFilters({ tags: { ...(f.tags ?? {}), [k]: v.value } }); setShowAddFilter(null); }} className="w-full text-left px-2 py-1 rounded-md hover:bg-gray-800 text-gray-200 flex justify-between"><span className="truncate">{v.value}</span><span className="text-gray-600 ml-2">{v.count}</span></button>)}
                  </div>
                ); })()}
                <div className="flex justify-between px-2 pt-1 border-t border-gray-800 mt-1"><button type="button" onClick={() => setShowAddFilter("menu")} className="text-gray-500 hover:text-white">← Filtres</button><button type="button" onClick={() => setShowAddFilter(null)} className="text-gray-500 hover:text-white">Fermer</button></div>
              </div>
            )}
          </div>
          <div className="relative ml-auto">
            <Search className="w-3.5 h-3.5 text-gray-500 absolute left-2 top-1/2 -translate-y-1/2" />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Nom contient…" className="w-44 rounded-lg border border-gray-800 bg-gray-900 pl-7 pr-2 py-1.5 text-xs text-gray-200 placeholder:text-gray-600 focus:outline-none focus:border-violet-500" />
          </div>
        </div>

        {/* ── Provenance ── */}
        <div className="px-6 pb-2 text-[11px] text-gray-500 flex items-center gap-2 flex-wrap">
          {loading && !result && <Loader2 className="w-3 h-3 animate-spin" />}
          {result && (
            <>
              <span>{result.total} {config.groupBy === "ad" ? "annonces" : "groupes"} · {range.since} → {range.until}{config.compare ? " · vs période précédente" : ""}</span>
              {result.coverage.until && <span>· données au {result.coverage.until}{result.coverage.since ? ` (historique depuis le ${result.coverage.since})` : ""}</span>}
              {result.coverage.loading && <span className="text-gray-500" title="Le remplissage de l'historique (12 mois) continue en tâche de fond ; les 30 derniers jours sont complets">· historique en cours</span>}
              {result.coverage.missing > 0 && result.coverage.accounts > 0 && <span className="text-gray-500" title="Comptes de la sélection pas encore passés par la synchronisation">· {result.coverage.missing} compte{result.coverage.missing > 1 ? "s" : ""} pas encore synchronisé{result.coverage.missing > 1 ? "s" : ""}</span>}
              {result.coverage.errors > 0 && <span className="text-red-400" title="La dernière synchronisation a échoué sur ces comptes ; le passage suivant réessaie">· synchro en erreur sur {result.coverage.errors} compte{result.coverage.errors > 1 ? "s" : ""}</span>}
              {result.benchmark.estimated && <span>· * valeur estimée via panier moyen</span>}
              {isAdmin && <button type="button" onClick={syncNow} disabled={syncing} className="inline-flex items-center gap-1 text-gray-400 hover:text-white disabled:opacity-50" title="Relire la plateforme maintenant (admin)"><RefreshCw className={`w-3 h-3 ${syncing ? "animate-spin" : ""}`} /> Synchroniser</button>}
            </>
          )}
          {error && <span className="text-red-400">{error}</span>}
        </div>

        {/* ── Copilot suggestions (once data is on screen) ── */}
        {result && result.rows.length > 0 && (
          <div className="px-6 pb-3 flex items-center gap-2 flex-wrap">
            {COPILOT_SUGGESTIONS.map((sg) => (
              <button key={sg.id} type="button" onClick={() => setCopilot({ open: true, prompt: sg.prompt || null })} className="inline-flex items-center gap-1.5 rounded-full border border-gray-800 bg-gray-900 px-3 py-1.5 text-xs text-gray-300 hover:border-violet-500/50 hover:text-white">
                {sg.id === "ask" ? <MessageSquare className="w-3.5 h-3.5 text-violet-300" /> : <span className="text-violet-300">✦</span>} {sg.label}
              </button>
            ))}
          </div>
        )}

        {/* ── Report card ── */}
        <div className="px-6 pb-8 flex-1">
          {!hasAccounts && <Empty title="Choisis un client" text="Analyse Ads lit l'entrepôt créa du client sélectionné (bouton en haut à droite, ⌘K, ou le bouton Analyse Ads de la liste des clients)." />}
          {hasAccounts && noWarehouse && (
            <Empty title={`${clientName ?? "Ce client"} n'est pas encore synchronisé`} text="L'entrepôt se remplit automatiquement (30 jours d'abord, puis l'historique).">
              {isAdmin && <button type="button" onClick={syncNow} disabled={syncing} className="mt-3 inline-flex items-center gap-2 rounded-lg bg-violet-600 hover:bg-violet-500 px-3 py-1.5 text-sm text-white disabled:opacity-50">{syncing ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />} Synchroniser maintenant (≈ 1 min)</button>}
            </Empty>
          )}
          {hasAccounts && result && !noWarehouse && (
            <div className="rounded-2xl border border-gray-800 bg-gray-900/60 p-3 space-y-3">
              {/* metric chips + view switch */}
              <div className="flex items-center gap-1.5 flex-wrap">
                <div className="relative">
                  <button type="button" onClick={() => setShowMetrics((v) => !v)} className="inline-flex items-center gap-1 rounded-lg border border-gray-800 bg-gray-900 px-2 py-1 text-xs text-gray-300 hover:text-white"><Plus className="w-3 h-3" /> Métrique</button>
                  {showMetrics && (
                    <div className="absolute left-0 mt-1 w-72 rounded-xl border border-gray-800 bg-gray-950 shadow-xl p-3 z-30">
                      <div className="flex items-center justify-between mb-2"><span className="text-[10px] uppercase tracking-wide text-gray-500">Presets</span><button type="button" onClick={() => setShowMetrics(false)} className="text-gray-500 hover:text-white"><X className="w-3.5 h-3.5" /></button></div>
                      <div className="flex flex-wrap gap-1 mb-3">{PRESETS.map((p) => <button key={p.id} type="button" onClick={() => patch({ metrics: p.keys })} className="rounded-md border border-gray-800 px-2 py-0.5 text-[11px] text-gray-300 hover:border-violet-500/50">{p.label}</button>)}</div>
                      <div className="max-h-64 overflow-y-auto space-y-0.5">
                        {METRICS.map((m) => (
                          <label key={m.key} className="flex items-center gap-2 text-xs text-gray-300 py-0.5 cursor-pointer" title={m.hint}>
                            <input type="checkbox" className="accent-violet-500" checked={config.metrics.includes(m.key)} onChange={(e) => patch({ metrics: e.target.checked ? [...config.metrics, m.key] : config.metrics.filter((k) => k !== m.key) })} />
                            {m.label}{m.video ? <span className="text-[10px] text-gray-600">vidéo</span> : null}
                          </label>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
                {visibleMetrics.map((k, i) => (
                  <button key={k} type="button" onClick={() => onSort(k)} title={`${METRIC_BY_KEY[k]?.hint ?? ""} — cliquer pour trier`} className={`inline-flex items-center gap-1.5 rounded-lg border px-2 py-1 text-xs ${CHIP_COLORS[i % CHIP_COLORS.length]} ${config.sort.key === k ? "ring-1 ring-white/40" : ""}`}>
                    <span className="w-4 h-4 rounded bg-black/30 text-[10px] flex items-center justify-center">{i + 1}</span>{METRIC_BY_KEY[k]?.label ?? k}
                    <span onClick={(e) => { e.stopPropagation(); patch({ metrics: config.metrics.filter((x) => x !== k) }); }} className="opacity-50 hover:opacity-100" aria-label="Retirer"><X className="w-3 h-3" /></span>
                  </button>
                ))}
                <div className="ml-auto flex items-center rounded-lg border border-gray-800 bg-gray-900 p-0.5">
                  {([["cards", LayoutGrid, "Cartes"], ["table", TableIcon, "Tableau"], ["bar", BarChart3, "Barres"], ["chart", LineIcon, "Courbe"]] as const).map(([v, Icon, l]) => (
                    <button key={v} type="button" onClick={() => patch({ view: v as ViewMode })} title={l} className={`p-1.5 rounded-md ${config.view === v ? "bg-violet-600 text-white" : "text-gray-400 hover:text-white"}`}><Icon className="w-3.5 h-3.5" /></button>
                  ))}
                </div>
              </div>

              {result.rows.length === 0 && <Empty title="Rien sur cette période" text="Aucune annonce ne correspond aux filtres. Élargis la période ou retire un filtre." />}
              {result.rows.length > 0 && config.view === "cards" && (
                <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-3">
                  {result.rows.map((r) => <AdCard key={r.key} row={r} metrics={visibleMetrics.slice(0, 6)} benchmark={result.benchmark} currency={result.currency} compare={config.compare} signals={!!config.launchDays} onOpen={setOpen} />)}
                </div>
              )}
              {result.rows.length > 0 && config.view === "bar" && <AdsBar rows={result.rows} metrics={visibleMetrics} benchmark={result.benchmark} currency={result.currency} />}
              {result.rows.length > 0 && config.view === "chart" && (
                <div className="space-y-3">
                  <div className="flex items-center gap-2 text-xs text-gray-400">
                    <span>Métrique</span>
                    <select value={chartMetric} onChange={(e) => setChartMetric(e.target.value as MetricKey)} className="rounded-md border border-gray-800 bg-gray-900 px-2 py-1 text-gray-200">{METRICS.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}</select>
                    <span className="text-gray-600">· coche jusqu&apos;à 8 lignes dans le tableau ; sans sélection, la courbe montre tout le compte.</span>
                  </div>
                  <div className="h-80 rounded-2xl border border-gray-800 bg-gray-900 p-3">
                    {chartData.data.length === 0 ? <div className="h-full flex items-center justify-center text-gray-500 text-xs"><Loader2 className="w-4 h-4 animate-spin mr-2" /> Chargement…</div> : (
                      <ResponsiveContainer width="100%" height="100%">
                        <LineChart data={chartData.data} margin={{ top: 8, right: 16, left: -8, bottom: 0 }}>
                          <XAxis dataKey="date" tick={{ fontSize: 10, fill: "#6b7280" }} tickLine={false} axisLine={false} tickFormatter={(d: string) => new Date(d + "T00:00:00Z").toLocaleDateString("fr-FR", { day: "numeric", month: "short", timeZone: "UTC" })} />
                          <YAxis tick={{ fontSize: 10, fill: "#6b7280" }} tickLine={false} axisLine={false} />
                          <Tooltip contentStyle={{ background: "#111827", border: "1px solid #374151", fontSize: 11 }} formatter={(v, name) => [fmtMetric(chartMetric, Number(v ?? 0), result.currency), labelOf(String(name))]} />
                          <Legend formatter={(v: string) => <span className="text-[11px] text-gray-300">{labelOf(v).slice(0, 40)}</span>} />
                          {chartData.want.map((k, i) => <Line key={k} type="monotone" dataKey={k} stroke={LINE_COLORS[i % LINE_COLORS.length]} strokeWidth={2} dot={false} connectNulls />)}
                        </LineChart>
                      </ResponsiveContainer>
                    )}
                  </div>
                </div>
              )}
              {result.rows.length > 0 && (config.view === "table" || config.view === "chart" || config.view === "bar") && (
                <AdsTable rows={result.rows} metrics={visibleMetrics} benchmark={result.benchmark} benchmarkPrevious={result.benchmarkPrevious} currency={result.currency} compare={config.compare} sort={config.sort} onSort={onSort} checked={checked} onCheck={(k, on) => setChecked((s) => { const n = new Set(s); if (on) n.add(k); else n.delete(k); return n; })} onOpen={setOpen} signals={!!config.launchDays} />
              )}
            </div>
          )}
        </div>
        </>)}
      </div>

      {copilot.open && query && <CopilotPanel query={query} accountKey={accountKey ?? ""} clientParam={client?.clientId ?? null} groupLabel={GROUPS.find((g) => g.value === config.groupBy)?.label ?? config.groupBy} clientName={clientName} initialPrompt={copilot.prompt} onClose={() => setCopilot({ open: false, prompt: null })} />}

      {open && query && result && <AdDrawer row={open} query={query} benchmark={result.benchmark} currency={result.currency} onClose={() => setOpen(null)} />}
    </div>
  );
}

function Empty({ title, text, children }: { title: string; text: string; children?: React.ReactNode }) {
  return (
    <div className="my-10 mx-auto max-w-md text-center">
      <div className="text-base font-semibold text-white">{title}</div>
      <p className="mt-1 text-sm text-gray-400">{text}</p>
      {children}
    </div>
  );
}
