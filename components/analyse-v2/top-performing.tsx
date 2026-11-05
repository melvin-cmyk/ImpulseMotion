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

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useSession } from "next-auth/react";
import { useRouter, useSearchParams } from "next/navigation";
import { BarChart3, CalendarDays, Check, ChevronDown, ChevronRight, LayoutGrid, LineChart as LineIcon, ListFilter, Loader2, MoreHorizontal, Pencil, Plus, RefreshCw, Settings, Sparkles, X } from "lucide-react";
import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis, Legend } from "recharts";
import { useCreativesContext } from "@/lib/creatives-context";
import type { AdsFilters, AdsGroupRow, AdsQuery, AdsQueryResult, DailyPoint, GroupBy, MetricKey } from "@/lib/ads-warehouse/query";
import type { AdFormat } from "@/lib/ads-warehouse/types";
import { METRICS, METRIC_BY_KEY, fmtMetric } from "@/lib/ads-warehouse/metrics-ui";
import { TABLE_COLUMNS, VIEW_TEMPLATES, type ViewConfig, type ViewMode } from "@/lib/ads-warehouse/views";
import { lastFullDays, prevRange, type DateRange } from "@/lib/date-ranges";
import { normalizeAct } from "@/lib/use-account-list";
import { AdCard } from "./ad-card";
import { Leaderboard } from "./leaderboard";
import { OpportunitiesPanel } from "./opportunities-panel";
import { opportunitiesOf, OPPORTUNITY_LABEL } from "@/lib/ads-warehouse/opportunities";
import { LaunchFunnel, defaultGoal, funnelRows, type FunnelGoal, type FunnelStage } from "./launch-funnel";
import type { MediaRatio } from "./ad-media";
import { AdsTable, RANK_SWATCH } from "./ads-table";
import { FilterChip, MenuItem, MenuLabel, PILL, Popover } from "./pill";
import { CreateReportModal } from "./create-report";
import { SharePopover } from "./share-popover";
import { PresetMenu, type TeamPreset } from "./preset-menu";
import { GroupsEditor } from "./groups-editor";
import { ThemesPanel } from "./themes-panel";
import { FormatsPanel } from "./formats-panel";
import { InspoPanel } from "./inspo";
import { AdsBar } from "./ads-bar";
import { AdDrawer } from "./ad-drawer";
import { tagKeyLabel } from "./shared";
import { ReportSidebar, type AnalyseSection, type SavedView } from "./report-sidebar";
import { CopilotPanel } from "./copilot-panel";
import { PlaybookPanel } from "./playbook";
import { AgentsPanel } from "./agents";
import { OrganicPanel } from "./organic";
import { GlossaryPanel } from "./glossary";
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
const LINE_COLORS = ["var(--ui-accent)", "#f59e0b", "#10b981", "#3b82f6", "#ec4899", "#14b8a6", "#f97316", "#a3e635"];
const LAST_VIEW = "impulsemotion.analyse.lastView";
const RATIO_KEY = "impulsemotion.analyse.cardRatio";
const ratioListeners = new Set<() => void>();
function subscribeRatio(f: () => void) { ratioListeners.add(f); return () => { ratioListeners.delete(f); }; }
function readRatio(): MediaRatio { const v = localStorage.getItem(RATIO_KEY); return v === "4:5" || v === "1:1" ? v : "9:16"; }

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
  // ?view=<template id> (links from Slack, e.g. view=fatigue) opens that template.
  const initialTemplate = VIEW_TEMPLATES.find((t) => t.id === params.get("view")) ?? VIEW_TEMPLATES[0];
  const [config, setConfig] = useState<ViewConfig>(initialTemplate.config);
  const [activeId, setActiveId] = useState<string>(`tpl:${initialTemplate.id}`);
  const [baseline, setBaseline] = useState<ViewConfig>(initialTemplate.config);
  const dirty = !same(config, baseline);
  const patch = (p: Partial<ViewConfig>) => setConfig((c) => ({ ...c, ...p }));
  const patchFilters = (p: Partial<AdsFilters>) => setConfig((c) => ({ ...c, filters: { ...c.filters, ...p } }));
  const apply = (id: string, cfg: ViewConfig) => { setConfig(cfg); setBaseline(cfg); setActiveId(id); try { localStorage.setItem(LAST_VIEW, id); } catch { /* ignore */ } };

  const [search, setSearch] = useState("");
  const [showAddFilter, setShowAddFilter] = useState<null | "menu" | `tag:${string}` | "spend" | "launch" | "campaign" | "name">(null);
  const [open, setOpen] = useState<AdsGroupRow | null>(null);
  const linkedOpened = useRef<string | null>(null);
  // Launch analysis (reports with a launch window): funnel tab + goal edited for the current accounts.
  const [funnelStage, setFunnelStage] = useState<FunnelStage>("launched");
  const [goalEdit, setGoalEdit] = useState<{ scope: string; goal: FunnelGoal } | null>(null);
  // Card media frame (Motion's card setting), remembered per browser.
  const ratio = useSyncExternalStore(subscribeRatio, readRatio, () => "9:16" as MediaRatio);
  const setRatio = (r: MediaRatio) => { try { localStorage.setItem(RATIO_KEY, r); } catch { /* ignore */ } ratioListeners.forEach((f) => f()); };
  const [syncing, setSyncing] = useState(false);
  const [copilot, setCopilot] = useState<{ open: boolean; prompt: string | null }>({ open: false, prompt: null });
  // « Créas » (the client's own ads) or « Concurrents » (its competitors' ads in the Meta Ad Library); ?tab=concurrents opens the latter.
  const [section, setSection] = useState<AnalyseSection>(() => (params.get("tab") === "concurrents" ? "competitors" : params.get("tab") === "leaderboard" ? "leaderboard" : params.get("tab") === "opportunites" ? "opportunities" : params.get("tab") === "themes" ? "themes" : params.get("tab") === "formats" ? "formats" : params.get("tab") === "inspo" ? "inspo" : params.get("tab") === "playbook" ? "playbook" : params.get("tab") === "glossaire" ? "glossary" : params.get("tab") === "agents" ? "agents" : params.get("tab") === "organique" ? "organic" : "ads"));
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
    return { platforms: Array.from(new Set(acc.map((a) => a.platform))), accountIds: Array.from(new Set(acc.map((a) => a.id))), accounts: acc, range, compare: config.compare ? prevRange(range) : null, groupBy: config.groupBy, customGroups: config.groupBy === "custom" ? config.customGroups : undefined, filters: f, sort: config.sort, limit: 120 } as AdsQuery & { accounts: typeof acc };
  }, [hasAccounts, accounts, activeAccounts, config.filters, config.compare, config.groupBy, config.customGroups, config.sort, search, launchAfter, range]);

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
  async function saveView(name: string, emoji: string, cfg: ViewConfig = config) {
    if (!accountKey) return;
    const r = await fetch("/api/ads/views", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accountKey, name, emoji, config: cfg }) });
    if (r.ok) { const { id } = (await r.json()) as { id: string }; await loadSaved(); setConfig(cfg); setActiveId(id); setBaseline(cfg); setSection("ads"); }
  }
  async function updateView(id: string) { await fetch(`/api/ads/views/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ config }) }); setBaseline(config); await loadSaved(); }
  async function renameView(id: string, name: string, emoji: string) { await fetch(`/api/ads/views/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, emoji }) }); await loadSaved(); }
  async function deleteView(id: string) { await fetch(`/api/ads/views/${id}`, { method: "DELETE" }); if (activeId === id) apply(`tpl:${VIEW_TEMPLATES[0].id}`, VIEW_TEMPLATES[0].config); await loadSaved(); }

  // ── Derived ──
  const noWarehouse = result && result.rows.length === 0 && result.coverage.accounts === 0;
  // « Copier le lien » of the creative modal: ?creative=<group key> reopens it once the rows are loaded.
  const creativeParam = params.get("creative");
  useEffect(() => {
    if (!creativeParam || !result || linkedOpened.current === creativeParam) return;
    const linked = result.rows.find((r) => r.key === creativeParam);
    if (!linked) return;
    linkedOpened.current = creativeParam;
    queueMicrotask(() => setOpen(linked));
  }, [creativeParam, result]);
  function clearCreativeParam() {
    if (!params.get("creative")) return;
    const u = new URL(window.location.href); u.searchParams.delete("creative"); window.history.replaceState(null, "", u.toString());
  }
  const goalScope = accounts.map((a) => `${a.platform}:${a.id}`).join(",");
  const funnelGoal = result && config.launchDays ? (goalEdit?.scope === goalScope ? goalEdit.goal : defaultGoal(result.benchmark, result.spendThreshold, result.goal)) : null;
  const rows = result ? (funnelGoal ? funnelRows(result.rows, funnelGoal, funnelStage) : result.rows) : [];
  // 🚩 on the cards of the launch analysis (Motion: suggested iterations on scaled creatives).
  const flags = result && funnelGoal ? opportunitiesOf(result.rows.filter((r) => r.metrics.spend >= funnelGoal.spend), funnelGoal.spend) : null;
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

  // ── Motion layout state ──
  const [createOpen, setCreateOpen] = useState(false);
  const [groupsOpen, setGroupsOpen] = useState(false);
  // Team column presets (Motion's saved presets); the default one gives its columns to reports without their own.
  const [presets, setPresets] = useState<TeamPreset[]>([]);
  const loadPresets = useCallback(() => { fetch("/api/ads/presets").then((r) => (r.ok ? r.json() : { presets: [] })).then((j: { presets: TeamPreset[] }) => setPresets(j.presets ?? [])).catch(() => undefined); }, []);
  useEffect(() => { queueMicrotask(loadPresets); }, [loadPresets]);
  const defaultPreset = presets.find((p) => p.isDefault);
  const [shared, setShared] = useState(false);
  const baseColumns = (config.columns?.length ? config.columns : defaultPreset?.columns.length ? defaultPreset.columns : TABLE_COLUMNS).filter((k) => !(k === "roas" && result?.benchmark.roasUnavailable));
  const columns = [...visibleMetrics.filter((k) => !baseColumns.includes(k)), ...baseColumns];
  // Motion: the cards / bars show the rows ticked in the table (top 8 by default).
  const selectedKeys = checked.size ? checked : new Set(rows.slice(0, 8).map((r) => r.key));
  const shownRows = rows.filter((r) => selectedKeys.has(r.key));
  const toggleChartMetric = (k: MetricKey) => {
    if (config.metrics.includes(k)) patch({ metrics: config.metrics.filter((x) => x !== k) });
    else if (config.metrics.length < 6) patch({ metrics: [...config.metrics, k] });
  };
  const groupNoun = config.groupBy === "ad" ? { one: "annonce", many: "annonces" } : { one: "groupe", many: "groupes" };
  const periodLabel = config.since && config.until ? `${fmtShort(range.since)} – ${fmtShort(range.until)}` : `${config.days} derniers jours`;
  const customNames = (config.customGroups ?? []).map((g) => g.name);
  const groupLabel = config.groupBy === "custom" ? (customNames.length > 2 ? `${customNames.slice(0, 2).join(", ")}, +${customNames.length - 2}` : customNames.join(", ") || "Groupes personnalisés") : GROUPS.find((g) => g.value === config.groupBy)?.label ?? (config.groupBy.startsWith("tag:") ? tagKeyLabel(config.groupBy.slice(4)) : config.groupBy);
  const platforms = (["meta", "google", "tiktok"] as const).filter((p) => accounts.some((a) => a.platform === p));
  const platformName = (p: string) => (p === "meta" ? "Meta" : p === "google" ? "Google" : "TikTok");
  const sectionTitle = section === "organic" ? `🌱 Organique${clientName ? ` ${clientName}` : ""}` : section === "agents" ? `🤖 Agents IA${clientName ? ` ${clientName}` : ""}` : section === "glossary" ? "🏷️ Glossaire" : section === "playbook" ? `📘 Playbook${clientName ? ` ${clientName}` : ""}` : section === "inspo" ? "📌 Inspiration" : section === "formats" ? "🎨 Formats visuels" : section === "themes" ? "💬 Thèmes de message" : section === "competitors" ? "🥊 Concurrents" : section === "leaderboard" ? "🏆 Leaderboard" : section === "opportunities" ? "🚩 Opportunités" : title;
  const sectionText = section === "organic" ? "Les posts Facebook non sponsorisés du client : ce qui engage, et ce qui mérite d'être sponsorisé." : section === "agents" ? "Des analyses que l'IA mène pour toi sur les vrais chiffres du client : brief, fatigue, angles inexploités, et sur chaque créa." : section === "glossary" ? "Les tags IA des créas du client : ce qui dépense, et les corrections de l'équipe (renommer, fusionner, retirer)." : section === "playbook" ? "Ce que l'équipe a appris sur les créas du client : à valider, à garder, et relu par l'IA avant chaque analyse." : section === "inspo" ? "Les boards de pubs qui inspirent : concurrents de la bibliothèque Meta et créas du client, avec vos notes." : section === "formats" ? "Compare les formats visuels pour savoir quel style fait passer le message." : section === "themes" ? "Les promesses que portent les créas du client, et celles qui marchent." : section === "competitors" ? "Leurs pubs en ce moment dans la bibliothèque Meta : garde une créa comme template en un clic." : section === "leaderboard" ? "Suis les évolutions de performance et les meilleures créas de la semaine." : section === "opportunities" ? "Les petits changements qui peuvent débloquer les créas qui marchent déjà." : subtitle;
  function internalUrl() {
    const u = new URL(window.location.href);
    if (client) u.searchParams.set("client", client.clientId);
    return u.toString();
  }
  async function share() {
    try { await navigator.clipboard.writeText(internalUrl()); setShared(true); setTimeout(() => setShared(false), 1500); } catch { /* clipboard refused */ }
  }

  return (
    <div className={`flex h-full min-h-0 ${copilot.open ? "pr-[400px]" : ""}`}>
      <ReportSidebar clientLabel={clientName} section={section} onSection={setSection} accountKey={accountKey} saved={saved} loading={savedLoading} activeId={activeId} onPick={apply} onCreate={() => setCreateOpen(true)} onRename={renameView} onDelete={deleteView} />

      <div className="flex-1 min-w-0 flex flex-col min-h-0">
        {/* ── Top bar (Motion: report name · freshness · source · Save · Share · ⋯) ── */}
        <div className="h-14 shrink-0 border-b border-ui-line flex items-center gap-2 px-5">
          <div className="flex-1 min-w-0 text-sm text-ui-fg truncate">{sectionTitle.replace(/^\S+\s/, "")}{section === "ads" && dirty && <span className="ml-2 text-xs text-ui-muted">· modifié</span>}</div>
          {section === "ads" && result?.coverage.until && (
            <span className={`hidden md:inline-flex items-center gap-1.5 text-sm ${result.coverage.errors ? "text-red-300" : "text-ui-muted"}`} title={`Données au ${result.coverage.until}${result.coverage.since ? `, historique depuis le ${result.coverage.since}` : ""}${result.coverage.errors ? ` · synchro en erreur sur ${result.coverage.errors} compte(s)` : ""}${result.coverage.loading ? " · historique en cours" : ""}`}>
              données au {fmtShort(result.coverage.until)}
              {isAdmin && <button type="button" onClick={syncNow} disabled={syncing} title="Synchroniser maintenant (admin)" className="hover:text-ui-fg disabled:opacity-50"><RefreshCw className={`w-3.5 h-3.5 ${syncing ? "animate-spin" : ""}`} /></button>}
            </span>
          )}
          {section === "ads" && platforms.length > 0 && (
            <Popover width={200} align="right" trigger={({ toggle }) => (
              <button type="button" onClick={toggle} className={`${PILL} bg-ui-accent-soft border-ui-accent text-ui-accent-ink`} title="Sources de données du rapport">
                {platforms.filter((p) => !platformsOff.has(p)).map(platformName).join(" + ") || "Aucune source"}<ChevronDown className="w-3.5 h-3.5 text-ui-accent-ink" />
              </button>
            )}>
              <MenuLabel>Sources</MenuLabel>
              {platforms.map((p) => (
                <label key={p} className="h-8 flex items-center gap-2 rounded-lg px-2.5 text-sm text-ui-fg hover:bg-ui-raised cursor-pointer">
                  <input type="checkbox" className="accent-ui-accent" checked={!platformsOff.has(p)} onChange={() => setPlatformsOff((s) => { const n = new Set(s); if (n.has(p)) n.delete(p); else if (activeAccounts.filter((a) => a.platform !== p).length) n.add(p); return n; })} />
                  {platformName(p)}
                </label>
              ))}
            </Popover>
          )}
          {section === "ads" && (
            <button type="button" disabled={!accountKey || (!!activeSaved && !dirty)} onClick={() => { if (activeSaved && dirty) void updateView(activeSaved.id); else setCreateOpen(true); }} className={PILL} title={activeSaved ? "Enregistrer les modifications du rapport" : "Enregistrer la vue comme rapport du client"}>Enregistrer</button>
          )}
          {section === "ads" ? (
            <SharePopover accountKey={accountKey} internalUrl={internalUrl} buildBody={() => (query ? {
              ...query, limit: 60, title: title.replace(/^\S+\s/, ""), emoji: title.split(" ")[0] || "🏆", description: sectionText, clientName: clientName ?? "", accountKey,
              metrics: visibleMetrics, columns, cardKeys: Array.from(selectedKeys), ratio,
            } : null)} />
          ) : (
            <button type="button" onClick={() => void share()} className="h-8 inline-flex items-center gap-1.5 rounded-[10px] bg-ui-inverse px-3 text-sm font-medium text-ui-on-inverse hover:opacity-90">{shared ? <><Check className="w-3.5 h-3.5" />Lien copié</> : "Copier le lien"}</button>
          )}
          <Popover width={220} align="right" trigger={({ toggle }) => <button type="button" onClick={toggle} className={`${PILL} px-2`} aria-label="Plus d'actions"><MoreHorizontal className="w-4 h-4" /></button>}>
            {(close) => (<>
              <MenuItem disabled={!accountKey} onClick={() => { close(); void saveView(`${title.replace(/^\S+\s/, "")} (copie)`, title.split(" ")[0] || "🏆"); }}>Dupliquer le rapport</MenuItem>
              {activeSaved && <MenuItem onClick={() => { close(); if (confirm(`Supprimer le rapport « ${activeSaved.name} » ?`)) void deleteView(activeSaved.id); }}>Supprimer le rapport</MenuItem>}
              {isAdmin && <MenuItem disabled={syncing} onClick={() => { close(); void syncNow(); }}>Synchroniser les données</MenuItem>}
              <MenuItem onClick={() => { close(); setCopilot({ open: true, prompt: null }); }}>Ouvrir le copilote</MenuItem>
            </>)}
          </Popover>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto">
          <div className="mx-auto w-full max-w-[1040px] px-6 pt-14 pb-16">
            {/* ── Title (Motion: emoji + name 28 px, grey description) ── */}
            <h1 className="text-[28px] leading-9 font-medium text-ui-fg">{sectionTitle}</h1>
            {sectionText && <p className="mt-1 text-base text-ui-fg2">{sectionText}</p>}
            {client && <p className="mt-1 text-sm text-ui-muted">{client.name}</p>}

            {section === "competitors" ? <div className="mt-8 -mx-6"><CompetitorsPanel key={client?.clientId ?? "none"} clientId={client?.clientId ?? null} clientName={clientName} /></div>
              : section === "leaderboard" ? <div className="mt-8 -mx-6">{query ? <Leaderboard query={query} clientId={client?.clientId ?? null} /> : <Empty title="Choisis un client" text="Le classement se calcule sur le client sélectionné en haut à gauche." />}</div>
              : section === "glossary" ? <div className="mt-8 -mx-6">{query ? <GlossaryPanel key={accountKey ?? "none"} query={query} currency={result?.currency ?? null} onOpenValue={(key, value) => { setSection("ads"); patchFilters({ tags: { ...(config.filters.tags ?? {}), [key]: value } }); }} /> : <Empty title="Choisis un client" text="Le glossaire est propre à chaque client : choisis-le en haut à gauche." />}</div>
              : section === "organic" ? <div className="mt-8 -mx-6">{query ? <OrganicPanel key={accountKey ?? "none"} query={query} accountKey={accountKey} clientName={clientName} /> : <Empty title="Choisis un client" text="Les posts organiques sont ceux des Pages du client : choisis-le en haut à gauche." />}</div>
              : section === "agents" ? <div className="mt-8 -mx-6">{accountKey ? <AgentsPanel key={accountKey} accountKey={accountKey} query={query} clientName={clientName} /> : <Empty title="Choisis un client" text="Les agents travaillent sur un client : choisis-le en haut à gauche." />}</div>
              : section === "playbook" ? <div className="mt-8 -mx-6">{accountKey ? <PlaybookPanel key={accountKey} accountKey={accountKey} query={query} clientName={clientName} /> : <Empty title="Choisis un client" text="Le playbook est propre à chaque client : choisis-le en haut à gauche." />}</div>
              : section === "inspo" ? <div className="mt-8 -mx-6"><InspoPanel clientId={client?.clientId ?? null} clientName={clientName} /></div>
              : section === "formats" ? <div className="mt-8 -mx-6">{query ? <FormatsPanel query={query} onOpenFormat={(name) => { setSection("ads"); patchFilters({ tags: { ...(config.filters.tags ?? {}), "ai:format": name } }); }} /> : <Empty title="Choisis un client" text="Les formats se calculent sur le client sélectionné en haut à gauche." />}</div>
              : section === "themes" ? <div className="mt-8 -mx-6">{query && accountKey ? <ThemesPanel query={query} accountKey={accountKey} onOpenTheme={(name) => { setSection("ads"); patchFilters({ tags: { ...(config.filters.tags ?? {}), "ai:msg": name } }); }} /> : <Empty title="Choisis un client" text="Les thèmes se calculent sur le client sélectionné en haut à gauche." />}</div>
              : section === "opportunities" ? <div className="mt-8 -mx-6">{query ? <OpportunitiesPanel query={query} currency={result?.currency ?? null} clientName={clientName ?? ""} /> : <Empty title="Choisis un client" text="Les opportunités se calculent sur le client sélectionné en haut à gauche." />}</div>
              : (<>
              {/* ── Controls (Motion: period → Group by → filter chips → Add filter) ── */}
              <div className="mt-10 flex items-center gap-2 flex-wrap">
                <Popover width={280} trigger={({ toggle }) => (
                  <button type="button" onClick={toggle} className={PILL}><CalendarDays className="w-4 h-4 text-ui-fg2" />{periodLabel}{config.compare && <span className="text-ui-muted font-normal">vs période précédente</span>}<ChevronDown className="w-3.5 h-3.5 text-ui-muted" /></button>
                )}>
                  {(close) => (<>
                    {PERIODS.map((d) => <MenuItem key={d} active={!config.since && config.days === d} onClick={() => { patch({ days: d, since: undefined, until: undefined }); close(); }}>{d} derniers jours</MenuItem>)}
                    <MenuLabel>Dates</MenuLabel>
                    <div className="flex items-center gap-1 px-2.5 pb-2">
                      <input type="date" value={range.since} max={range.until} onChange={(e) => patch({ since: e.target.value, until: range.until })} className="flex-1 h-8 rounded-lg border border-ui-line bg-ui-card px-1.5 text-xs text-ui-fg" />
                      <span className="text-ui-muted">→</span>
                      <input type="date" value={range.until} min={range.since} onChange={(e) => patch({ since: range.since, until: e.target.value })} className="flex-1 h-8 rounded-lg border border-ui-line bg-ui-card px-1.5 text-xs text-ui-fg" />
                    </div>
                    <div className="border-t border-ui-line mt-1 pt-1">
                      <label className="h-8 flex items-center gap-2 rounded-lg px-2.5 text-sm text-ui-fg hover:bg-ui-raised cursor-pointer"><input type="checkbox" className="accent-ui-accent" checked={config.compare} onChange={(e) => patch({ compare: e.target.checked })} />Comparer à la période précédente</label>
                    </div>
                  </>)}
                </Popover>
                <Popover width={260} trigger={({ toggle }) => (
                  <span className="inline-flex items-center gap-1">
                    <button type="button" onClick={toggle} className={PILL}><span className="text-ui-fg2 font-normal">{config.groupBy === "custom" ? "Comparaison" : "Regrouper par"}</span>{groupLabel}<ChevronDown className="w-3.5 h-3.5 text-ui-muted" /></button>
                    {config.groupBy === "custom" && <button type="button" onClick={() => setGroupsOpen(true)} className={`${PILL} px-2`} title="Modifier les groupes"><Pencil className="w-3.5 h-3.5" /></button>}
                  </span>
                )}>
                  {(close) => (<div className="max-h-96 overflow-y-auto">
                    {GROUPS.map((g) => <MenuItem key={g.value} hint={g.hint} active={config.groupBy === g.value} onClick={() => { patch({ groupBy: g.value }); close(); }}>{g.label}</MenuItem>)}
                    <MenuLabel>Comparatif</MenuLabel>
                    <MenuItem active={config.groupBy === "custom"} hint="Compare des groupes que tu définis (mots dans le nom d'annonce ou de campagne)" onClick={() => { close(); setGroupsOpen(true); }}>Groupes personnalisés…</MenuItem>
                    {result?.tagKeys.some((t) => t.key.startsWith("ai:")) && <MenuLabel>Tags IA</MenuLabel>}
                    {result?.tagKeys.filter((t) => t.key.startsWith("ai:")).map((t) => <MenuItem key={t.key} active={config.groupBy === `tag:${t.key}`} onClick={() => { patch({ groupBy: `tag:${t.key}` }); close(); }}><span className="flex-1">{tagKeyLabel(t.key)}</span><span className="text-xs text-ui-muted">{t.count}</span></MenuItem>)}
                    {result?.tagKeys.some((t) => !t.key.startsWith("ai:")) && <MenuLabel>Convention de nommage</MenuLabel>}
                    {result?.tagKeys.filter((t) => !t.key.startsWith("ai:")).map((t) => <MenuItem key={t.key} active={config.groupBy === `tag:${t.key}`} onClick={() => { patch({ groupBy: `tag:${t.key}` }); close(); }}><span className="flex-1">{t.key}</span><span className="text-xs text-ui-muted">{t.count}</span></MenuItem>)}
                  </div>)}
                </Popover>
                {chips.map((c) => <FilterChip key={c.id} label={c.label} onClear={c.clear} />)}
                {search.trim() && <FilterChip label={`Nom contient « ${search.trim()} »`} onClear={() => setSearch("")} />}
                <Popover width={280} open={!!showAddFilter} onOpenChange={(v) => setShowAddFilter(v ? "menu" : null)} trigger={({ toggle }) => (
                  <button type="button" onClick={toggle} className={PILL}><ListFilter className="w-4 h-4 text-ui-fg2" />Ajouter un filtre</button>
                )}>
                  <div className="text-sm">
                    {showAddFilter === "menu" && (<div className="max-h-[420px] overflow-y-auto">
                      <MenuItem onClick={() => setShowAddFilter("name")}>Nom de l&apos;annonce</MenuItem>
                      <MenuItem onClick={() => setShowAddFilter("campaign")}>Nom de campagne ou d&apos;ad set</MenuItem>
                      <MenuItem onClick={() => setShowAddFilter("launch")}>Date de lancement</MenuItem>
                      <MenuItem onClick={() => setShowAddFilter("spend")}>Performance : dépense minimale</MenuItem>
                      <MenuLabel>Type d&apos;annonce</MenuLabel>
                      <div className="px-2.5 pb-1 flex flex-wrap gap-1">{(["Video", "Image", "Carousel"] as AdFormat[]).map((fm) => <button key={fm} type="button" onClick={() => toggleFormat(fm)} className={`h-7 rounded-lg border px-2 text-xs ${f.formats?.includes(fm) ? "border-ui-accent bg-ui-accent-soft text-ui-accent-ink" : "border-ui-line text-ui-fg2 hover:text-ui-fg"}`}>{fm === "Video" ? "Vidéo" : fm === "Image" ? "Image" : "Carrousel"}</button>)}<button type="button" onClick={() => patchFilters({ dynamic: f.dynamic === true ? undefined : true })} className={`h-7 rounded-lg border px-2 text-xs ${f.dynamic === true ? "border-ui-accent bg-ui-accent-soft text-ui-accent-ink" : "border-ui-line text-ui-fg2 hover:text-ui-fg"}`}>Dynamic</button></div>
                      <MenuLabel>Statut</MenuLabel>
                      <div className="px-2.5 pb-1 flex gap-1">{([["", "Toutes"], ["active", "Actives"], ["inactive", "En pause"]] as const).map(([v, l]) => <button key={v} type="button" onClick={() => patchFilters({ status: (v || undefined) as AdsFilters["status"] })} className={`h-7 rounded-lg border px-2 text-xs ${(f.status ?? "") === v ? "border-ui-accent bg-ui-accent-soft text-ui-accent-ink" : "border-ui-line text-ui-fg2 hover:text-ui-fg"}`}>{l}</button>)}</div>
                      {facets.some((fa) => fa.key.startsWith("ai:")) && <MenuLabel>Tags IA</MenuLabel>}
                      {facets.filter((fa) => fa.key.startsWith("ai:")).map((fa) => <MenuItem key={fa.key} onClick={() => setShowAddFilter(`tag:${fa.key}`)}><span className="flex-1">{tagKeyLabel(fa.key)}</span><ChevronRight className="w-3.5 h-3.5 text-ui-muted" /></MenuItem>)}
                      {facets.some((fa) => !fa.key.startsWith("ai:")) && <MenuLabel>Convention de nommage</MenuLabel>}
                      {facets.filter((fa) => !fa.key.startsWith("ai:")).slice(0, 16).map((fa) => <MenuItem key={fa.key} onClick={() => setShowAddFilter(`tag:${fa.key}`)}><span className="flex-1">{fa.key}</span><ChevronRight className="w-3.5 h-3.5 text-ui-muted" /></MenuItem>)}
                    </div>)}
                    {showAddFilter === "name" && <div className="p-2 space-y-2"><div className="text-ui-fg2">Nom de l&apos;annonce contient</div><input autoFocus defaultValue={search} onKeyDown={(e) => { if (e.key === "Enter") { setSearch((e.target as HTMLInputElement).value.trim()); setShowAddFilter(null); } }} className="w-full h-8 rounded-lg border border-ui-line bg-ui-card px-2 text-ui-fg" placeholder="ex. UGC puis Entrée" /></div>}
                    {showAddFilter === "spend" && <div className="p-2 space-y-2"><div className="text-ui-fg2">Dépense supérieure à</div><input type="number" min={0} autoFocus defaultValue={f.minSpend ?? ""} onKeyDown={(e) => { if (e.key === "Enter") { patchFilters({ minSpend: Number((e.target as HTMLInputElement).value) || undefined }); setShowAddFilter(null); } }} className="w-full h-8 rounded-lg border border-ui-line bg-ui-card px-2 text-ui-fg" placeholder="ex. 100 puis Entrée" /></div>}
                    {showAddFilter === "launch" && <div>{LAUNCH.map((o) => <MenuItem key={o.v} active={(config.launchDays ?? 0) === o.v} onClick={() => { patch({ launchDays: o.v }); setShowAddFilter(null); }}>{o.l}</MenuItem>)}</div>}
                    {showAddFilter === "campaign" && <div className="p-2 space-y-2"><div className="text-ui-fg2">Nom de campagne ou d&apos;ad set contient</div><input autoFocus defaultValue={f.campaignContains ?? ""} onKeyDown={(e) => { if (e.key === "Enter") { patchFilters({ campaignContains: (e.target as HTMLInputElement).value.trim() || undefined }); setShowAddFilter(null); } }} className="w-full h-8 rounded-lg border border-ui-line bg-ui-card px-2 text-ui-fg" placeholder="ex. retargeting puis Entrée" /></div>}
                    {showAddFilter?.startsWith("tag:") && (() => { const k = showAddFilter.slice(4); const fa = facets.find((x) => x.key === k); return (
                      <div className="max-h-80 overflow-y-auto">
                        <MenuLabel>{tagKeyLabel(k)} est…</MenuLabel>
                        {(fa?.values ?? []).map((v) => <MenuItem key={v.value} onClick={() => { patchFilters({ tags: { ...(f.tags ?? {}), [k]: v.value } }); setShowAddFilter(null); }}><span className="flex-1 truncate">{v.value}</span><span className="text-xs text-ui-muted">{v.count}</span></MenuItem>)}
                      </div>
                    ); })()}
                    {showAddFilter && showAddFilter !== "menu" && <div className="border-t border-ui-line mt-1 pt-1"><MenuItem onClick={() => setShowAddFilter("menu")}>← Tous les filtres</MenuItem></div>}
                  </div>
                </Popover>
                {loading && <Loader2 className="w-4 h-4 animate-spin text-ui-muted" />}
                {error && <span className="text-sm text-red-400">{error}</span>}
              </div>

              {/* ── AI prompts (Motion: « Ask me anything » + 3 suggestions) ── */}
              {result && result.rows.length > 0 && (
                <div className="mt-4 flex items-center gap-2 flex-wrap">
                  {COPILOT_SUGGESTIONS.map((sg) => (
                    <button key={sg.id} type="button" onClick={() => setCopilot({ open: true, prompt: sg.prompt || null })} className="h-11 inline-flex items-center gap-2 rounded-full bg-ui-card px-4 text-sm text-ui-fg hover:bg-ui-raised">
                      {sg.id === "ask" ? <MessageSquare className="w-4 h-4 text-ui-fg2" /> : <Sparkles className="w-4 h-4 text-ui-accent-ink" />}{sg.label}
                    </button>
                  ))}
                </div>
              )}

              {!hasAccounts && <Empty title="Choisis un client" text="Analyse Ads lit l'entrepôt créa du client sélectionné (en haut à gauche, ⌘K, ou le bouton Analyse Ads de la liste des clients)." />}
              {hasAccounts && noWarehouse && (
                <Empty title={`${clientName ?? "Ce client"} n'est pas encore synchronisé`} text="L'entrepôt se remplit automatiquement (30 jours d'abord, puis l'historique).">
                  {isAdmin && <button type="button" onClick={syncNow} disabled={syncing} className="mt-3 inline-flex items-center gap-2 rounded-[10px] bg-ui-inverse px-3 h-8 text-sm text-ui-on-inverse disabled:opacity-50">{syncing ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />} Synchroniser maintenant (≈ 1 min)</button>}
                </Empty>
              )}

              {hasAccounts && result && !noWarehouse && (<>
                {funnelGoal && result.rows.length > 0 && (
                  <div className="mt-6"><LaunchFunnel rows={result.rows} goal={funnelGoal} onGoal={(g) => setGoalEdit({ scope: goalScope, goal: g })} stage={funnelStage} onStage={setFunnelStage} launchedSince={launchAfter} currency={result.currency} /></div>
                )}

                {/* ── Chart card (Motion: + AI tags · + Add metric · numbered chips · ⚙ · cards | bars | line) ── */}
                <section className="mt-6 rounded-xl border border-ui-line bg-ui-card p-4">
                  <div className="flex items-start gap-2">
                    <div className="flex-1 flex items-center gap-2 flex-wrap">
                      <button type="button" onClick={() => patch({ showTags: !config.showTags })} className={`${PILL} ${config.showTags ? "border-ui-accent text-ui-accent-ink" : ""}`} title="Afficher les tags IA sur les cartes"><Plus className="w-4 h-4" />Tags IA</button>
                      <Popover width={300} trigger={({ toggle }) => <button type="button" onClick={toggle} disabled={config.metrics.length >= 6} className={PILL} title={config.metrics.length >= 6 ? "6 métriques au maximum : retire-en une" : "Ajouter une métrique"}><Plus className="w-4 h-4" />Ajouter une métrique</button>}>
                        <MetricPicker selected={config.metrics} onToggle={toggleChartMetric} />
                      </Popover>
                      {visibleMetrics.map((k, i) => (
                        <span key={k} className="h-8 inline-flex items-center gap-1.5 rounded-[10px] border border-ui-line bg-ui-card pl-1.5 pr-1 text-sm font-medium text-ui-fg">
                          <span className={`w-[18px] h-[18px] rounded-[5px] text-[11px] font-medium flex items-center justify-center ${RANK_SWATCH[i % RANK_SWATCH.length]}`}>{i + 1}</span>
                          <button type="button" onClick={() => onSort(k)} title={`${METRIC_BY_KEY[k]?.hint ?? ""} — trier`} className={config.sort.key === k ? "text-ui-fg underline underline-offset-4 decoration-gray-600" : ""}>{METRIC_BY_KEY[k]?.label ?? k}</button>
                          <button type="button" onClick={() => toggleChartMetric(k)} className="p-0.5 rounded text-ui-muted hover:text-ui-fg" aria-label="Retirer"><X className="w-3.5 h-3.5" /></button>
                        </span>
                      ))}
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <Popover width={200} align="right" trigger={({ toggle }) => <button type="button" onClick={toggle} className={`${PILL} px-2 border-transparent bg-transparent`} title="Réglages des cartes"><Settings className="w-4 h-4 text-ui-fg2" /></button>}>
                        <MenuLabel>Format des visuels</MenuLabel>
                        {(["9:16", "4:5", "1:1"] as const).map((r) => <MenuItem key={r} active={ratio === r} onClick={() => setRatio(r)}>{r === "9:16" ? "Vertical 9:16" : r === "4:5" ? "Portrait 4:5" : "Carré 1:1"}</MenuItem>)}
                      </Popover>
                      <div className="h-8 flex items-center rounded-[10px] border border-ui-line p-0.5">
                        {([["cards", LayoutGrid, "Cartes"], ["bar", BarChart3, "Barres"], ["chart", LineIcon, "Courbe"]] as const).map(([v, Icon, l]) => (
                          <button key={v} type="button" onClick={() => patch({ view: v as ViewMode })} title={l} className={`h-full px-2 rounded-lg ${(config.view === "table" ? "cards" : config.view) === v ? "bg-ui-raised text-ui-fg" : "text-ui-muted hover:text-ui-fg"}`}><Icon className="w-4 h-4" /></button>
                        ))}
                      </div>
                    </div>
                  </div>

                  <div className="mt-4">
                    {result.rows.length === 0 && <Empty title="Aucune annonce pour ta recherche" text="Essaie une autre période ou retire un filtre." />}
                    {result.rows.length > 0 && rows.length === 0 && <Empty title={funnelStage === "winners" ? "Pas encore de gagnante" : funnelStage === "opportunities" ? "Pas d'opportunité" : "Aucune créa scalée"} text={funnelStage === "winners" ? "Aucune créa lancée n'a encore atteint l'objectif après avoir été scalée. Ajuste l'objectif ou élargis la fenêtre de lancement." : "Rien à montrer sur cette étape pour l'instant."} />}
                    {rows.length > 0 && shownRows.length === 0 && <Empty title="Aucune ligne sélectionnée" text="Coche des lignes dans le tableau pour les afficher ici." />}
                    {shownRows.length > 0 && (config.view === "cards" || config.view === "table") && (
                      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                        {shownRows.map((r) => <AdCard key={r.key} row={r} metrics={visibleMetrics.slice(0, 6)} benchmark={result.benchmark} currency={result.currency} compare={config.compare} signals={!!config.launchDays} ratio={ratio} showTags={!!config.showTags} flag={flags?.get(r.key) ? OPPORTUNITY_LABEL[flags.get(r.key)!.type] : null} onOpen={setOpen} />)}
                      </div>
                    )}
                    {shownRows.length > 0 && config.view === "bar" && <AdsBar rows={shownRows} metrics={visibleMetrics} benchmark={result.benchmark} currency={result.currency} />}
                    {rows.length > 0 && config.view === "chart" && (
                      <div className="space-y-3">
                        <div className="flex items-center gap-2 text-sm text-ui-fg2">
                          <span>Métrique</span>
                          <select value={chartMetric} onChange={(e) => setChartMetric(e.target.value as MetricKey)} className="h-8 rounded-[10px] border border-ui-line bg-ui-card px-2 text-ui-fg">{METRICS.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}</select>
                          <span className="text-xs text-ui-muted">Coche jusqu&apos;à 8 lignes dans le tableau ; sans sélection, la courbe montre tout le compte.</span>
                        </div>
                        <div className="h-80">
                          {chartData.data.length === 0 ? <div className="h-full flex items-center justify-center text-ui-muted text-xs"><Loader2 className="w-4 h-4 animate-spin mr-2" /> Chargement…</div> : (
                            <ResponsiveContainer width="100%" height="100%">
                              <LineChart data={chartData.data} margin={{ top: 8, right: 16, left: -8, bottom: 0 }}>
                                <XAxis dataKey="date" tick={{ fontSize: 11, fill: "var(--ui-muted)" }} tickLine={false} axisLine={false} tickFormatter={(d: string) => fmtShort(d)} />
                                <YAxis tick={{ fontSize: 11, fill: "var(--ui-muted)" }} tickLine={false} axisLine={false} />
                                <Tooltip contentStyle={{ background: "var(--ui-card)", border: "1px solid var(--ui-line-strong)", fontSize: 12 }} formatter={(v, name) => [fmtMetric(chartMetric, Number(v ?? 0), result.currency), labelOf(String(name))]} />
                                <Legend formatter={(v: string) => <span className="text-xs text-ui-fg2">{labelOf(v).slice(0, 40)}</span>} />
                                {chartData.want.map((k, i) => <Line key={k} type="monotone" dataKey={k} stroke={LINE_COLORS[i % LINE_COLORS.length]} strokeWidth={2} dot={false} connectNulls />)}
                              </LineChart>
                            </ResponsiveContainer>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                </section>

                {/* ── Table card (Motion: Custom ⌄ · Table settings ⌄ · + AI tags · + Add metric) ── */}
                {rows.length > 0 && (
                  <section className="mt-4 rounded-xl border border-ui-line bg-ui-card overflow-hidden">
                    <div className="flex items-center gap-2 flex-wrap p-4 border-b border-ui-line">
                      <PresetMenu columns={config.columns} metrics={visibleMetrics} team={presets} onApply={(cols, mets) => patch({ columns: cols, ...(mets ? { metrics: mets } : {}) })} onReload={loadPresets} />
                      <Popover width={260} trigger={({ toggle }) => <button type="button" onClick={toggle} className={PILL}><Settings className="w-4 h-4 text-ui-fg2" />Paramètres du tableau<ChevronDown className="w-3.5 h-3.5 text-ui-muted" /></button>}>
                        <label className="h-8 flex items-center gap-2 rounded-lg px-2.5 text-sm text-ui-fg hover:bg-ui-raised cursor-pointer"><input type="checkbox" className="accent-ui-accent" checked={config.compare} onChange={(e) => patch({ compare: e.target.checked })} />Variation vs période précédente</label>
                        <MenuItem onClick={() => setChecked(() => new Set(rows.map((r) => r.key)))}>Tout sélectionner</MenuItem>
                        <MenuItem onClick={() => setChecked(() => new Set())}>Revenir au top 8</MenuItem>
                      </Popover>
                      <button type="button" onClick={() => patch({ showTags: !config.showTags })} className={`${PILL} ${config.showTags ? "border-ui-accent text-ui-accent-ink" : ""}`}><Plus className="w-4 h-4" />Tags IA</button>
                      <Popover width={300} trigger={({ toggle }) => <button type="button" onClick={toggle} className={PILL}><Plus className="w-4 h-4" />Ajouter une métrique</button>}>
                        <MetricPicker selected={columns} onToggle={(k) => { const cur = config.columns?.length ? config.columns : TABLE_COLUMNS; patch({ columns: cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k] }); }} />
                      </Popover>
                      <span className="ml-auto text-xs text-ui-muted">{result.total} {result.total > 1 ? groupNoun.many : groupNoun.one} · {fmtShort(range.since)} → {fmtShort(range.until)}{result.benchmark.estimated ? " · * valeur estimée" : ""}</span>
                    </div>
                    <AdsTable rows={rows} columns={columns} chartMetrics={visibleMetrics} onToggleChartMetric={toggleChartMetric} benchmark={result.benchmark} benchmarkPrevious={result.benchmarkPrevious} currency={result.currency} compare={config.compare} sort={config.sort} onSort={onSort}
                      selected={selectedKeys} onSelect={(k, on) => setChecked(() => { const n = new Set(selectedKeys); if (on) n.add(k); else n.delete(k); return n; })} onSelectAll={(on) => setChecked(() => (on ? new Set(rows.map((r) => r.key)) : new Set(["__none__"])))} onOpen={setOpen} signals={!!config.launchDays} groupNoun={groupNoun} />
                  </section>
                )}
              </>)}
            </>)}
          </div>
        </div>
      </div>

      {groupsOpen && <GroupsEditor initial={config.customGroups ?? []} onClose={() => setGroupsOpen(false)} onApply={(groups) => { patch({ groupBy: "custom", customGroups: groups, view: config.view === "cards" || config.view === "table" ? "cards" : config.view }); setGroupsOpen(false); }} />}
      {createOpen && <CreateReportModal current={config} onClose={() => setCreateOpen(false)} onCreate={(name, emoji, cfg) => saveView(name, emoji, cfg)} />}

      {copilot.open && query && <CopilotPanel query={query} accountKey={accountKey ?? ""} clientParam={client?.clientId ?? null} groupLabel={groupLabel} clientName={clientName} initialPrompt={copilot.prompt} onClose={() => setCopilot({ open: false, prompt: null })} />}

      {open && query && result && <AdDrawer row={open} query={query} benchmark={result.benchmark} currency={result.currency} clientId={client?.clientId ?? null} accountKey={accountKey} onClose={() => { setOpen(null); clearCreativeParam(); }} onAsk={(p) => { setOpen(null); clearCreativeParam(); setCopilot({ open: true, prompt: p || null }); }} />}
    </div>
  );
}

const fmtShort = (d: string) => new Date(d + "T00:00:00Z").toLocaleDateString("fr-FR", { day: "numeric", month: "short", timeZone: "UTC" });

/** Motion's « Add metric » menu: search + every metric, ticked when used. */
function MetricPicker({ selected, onToggle }: { selected: MetricKey[]; onToggle: (k: MetricKey) => void }) {
  const [q, setQ] = useState("");
  const list = METRICS.filter((m) => !q.trim() || m.label.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <div>
      <div className="p-1"><input value={q} onChange={(e) => setQ(e.target.value)} autoFocus placeholder="Rechercher…" className="w-full h-8 rounded-lg border border-ui-line bg-ui-card px-2.5 text-sm text-ui-fg placeholder:text-ui-muted" /></div>
      <div className="max-h-80 overflow-y-auto">
        {list.map((m) => (
          <label key={m.key} title={m.hint} className="h-8 flex items-center gap-2 rounded-lg px-2.5 text-sm text-ui-fg hover:bg-ui-raised cursor-pointer">
            <input type="checkbox" className="accent-ui-accent" checked={selected.includes(m.key)} onChange={() => onToggle(m.key)} />
            <span className="flex-1">{m.label}</span>{m.video && <span className="text-[11px] text-ui-muted">vidéo</span>}
          </label>
        ))}
      </div>
    </div>
  );
}

function Empty({ title, text, children }: { title: string; text: string; children?: React.ReactNode }) {
  return (
    <div className="my-10 mx-auto max-w-md text-center">
      <div className="text-base font-medium text-ui-fg">{title}</div>
      <p className="mt-1 text-sm text-ui-fg2">{text}</p>
      {children}
    </div>
  );
}
