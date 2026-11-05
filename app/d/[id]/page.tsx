"use client";

/**
 * /d/[id] — a client steering dashboard.
 * Clients see the widget grid read-only; staff get an edit mode
 * (add / edit / reorder / remove widgets, dashboard settings).
 * Period lives in the URL (?days=7|30|90) so views are shareable.
 */

import { Fragment, useCallback, useEffect, useMemo, useState, use } from "react";
import { useSession } from "next-auth/react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, arrayMove, rectSortingStrategy, sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import { PilotLinksContext, WidgetBody, WidgetFrame } from "@/components/dashboard/renderers";
import { WidgetForm, DashboardSettingsForm, EditControls, InlineWidgetEditor, SortableWidgetFrame } from "@/components/dashboard/editor";
import { CopilotPanel } from "@/components/dashboard/copilot";
import { SHEETS_SHARE_EMAIL } from "@/lib/mcp-whitelist";
import { DEFAULT_PAGE_ID, type DashboardPageInfo, type ResolvedWidget } from "@/lib/dashboard-types";
import { PageForm, PageTabs } from "@/components/dashboard/pages";
import { PilotHistoryTab } from "@/components/pilot/history-tab";
import { describeRange, lastFullDays, prevRange } from "@/lib/date-ranges";

interface DashboardPayload {
  dashboard: { id: string; userId: string; name: string; metaAccountId: string | null; googleCustomerId: string | null; timezone?: string | null };
  since: string;
  until: string;
  rangeLabel?: string;
  partialDay?: boolean;
  error?: string;
  pages?: DashboardPageInfo[];
  activePageId?: string | null;
  widgets: ResolvedWidget[];
}

const NO_WIDGETS: ResolvedWidget[] = [];

const PERIODS = [
  { days: 7, label: "7 j" },
  { days: 30, label: "30 j" },
  { days: 90, label: "90 j" },
];

/** N FULL days ending yesterday — same rule as the portfolio (never today's partial day). */
function rangeFor(days: number): { since: string; until: string } {
  return lastFullDays(days);
}

/** Previous window of equal length — used to seed the custom comparison inputs. */
function prevWindowOf(since: string, until: string): { since: string; until: string } {
  return prevRange({ since, until });
}

export default function DashboardPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const searchParams = useSearchParams();
  const { data: session } = useSession();
  const isStaff = session?.role === "admin" || session?.role === "consultant";

  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const days = Number(searchParams.get("days") ?? 30) || 30;
  const sinceParam = searchParams.get("since");
  const untilParam = searchParams.get("until");
  const isCustom = !!(sinceParam && untilParam && DATE_RE.test(sinceParam) && DATE_RE.test(untilParam) && sinceParam <= untilParam);
  const range = useMemo(
    () => (isCustom ? { since: sinceParam as string, until: untilParam as string } : rangeFor(days)),
    [isCustom, sinceParam, untilParam, days],
  );

  const compareMode = searchParams.get("compare") ?? "prev";
  const pageParam = searchParams.get("page") ?? "";
  // Staff tab « Historique & impact » (changes made from Pilotage and their J+7 / J+14 analyses): not a page of widgets.
  const [showHistory, setShowHistory] = useState(() => searchParams.get("tab") === "history");
  const cmpSince = searchParams.get("cmpSince") ?? "";
  const cmpUntil = searchParams.get("cmpUntil") ?? "";
  const isCmpCustom = compareMode === "custom" && DATE_RE.test(cmpSince) && DATE_RE.test(cmpUntil) && cmpSince <= cmpUntil;

  const [payload, setPayload] = useState<DashboardPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editMode, setEditMode] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [showPageForm, setShowPageForm] = useState(false);
  const [pageNote, setPageNote] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [editingWidget, setEditingWidget] = useState<ResolvedWidget | null>(null);
  const [showCopilot, setShowCopilot] = useState(false);
  // Optimistic widget order (edit mode). Keyed on the payload's widgets array:
  // as soon as load() delivers a new payload the local order is dropped and the
  // server order wins, so the two can never drift.
  const [localOrder, setLocalOrder] = useState<{ source: ResolvedWidget[]; ids: string[] } | null>(null);

  const compareQuery =
    compareMode === "none" ? "&compare=none"
    : compareMode === "year" ? "&compare=year"
    : isCmpCustom ? `&compare=custom&cmpSince=${cmpSince}&cmpUntil=${cmpUntil}`
    : "";

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/dashboards/${id}?since=${range.since}&until=${range.until}${compareQuery}${pageParam ? `&page=${encodeURIComponent(pageParam)}` : ""}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `Erreur ${res.status}`);
      }
      setPayload(await res.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [id, range.since, range.until, compareQuery, pageParam]);

  useEffect(() => { load(); }, [load]);

  const sourceWidgets = payload?.widgets ?? NO_WIDGETS;
  const orderedIds = useMemo(() => {
    const serverIds = sourceWidgets.map((w) => w.id);
    if (!localOrder || localOrder.source !== sourceWidgets) return serverIds;
    // Defensive: keep only known ids, append anything the local order misses.
    const known = new Set(serverIds);
    const ids = localOrder.ids.filter((x) => known.has(x));
    for (const x of serverIds) if (!ids.includes(x)) ids.push(x);
    return ids;
  }, [sourceWidgets, localOrder]);
  const widgets = useMemo(() => {
    const byId = new Map(sourceWidgets.map((w) => [w.id, w] as const));
    return orderedIds.map((x) => byId.get(x)).filter((w): w is ResolvedWidget => !!w);
  }, [sourceWidgets, orderedIds]);

  /**
   * Single reorder path shared by drag & drop and the ↑/↓ buttons:
   * apply locally right away, persist with PUT { order }, revert on failure.
   * Resolves true on success. No refetch on success — the widget data is unchanged.
   */
  const reorder = useCallback(async (nextIds: string[]): Promise<boolean> => {
    if (!payload) return false;
    const prevIds = orderedIds;
    setLocalOrder({ source: sourceWidgets, ids: nextIds });
    try {
      const res = await fetch(`/api/dashboards/${payload.dashboard.id}/widgets`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ order: nextIds }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const msg = `Réorganisation impossible : ${body.error ?? `Erreur ${res.status}`}`;
        setLocalOrder({ source: sourceWidgets, ids: prevIds });
        if (res.status === 409) {
          // The server's widget list differs from ours (added/removed elsewhere):
          // resync, then surface the message (load() clears `error` on start).
          load().then(() => setError((cur) => cur ?? msg));
        } else {
          setError(msg);
        }
        return false;
      }
      return true;
    } catch (e) {
      setLocalOrder({ source: sourceWidgets, ids: prevIds });
      setError(`Réorganisation impossible : ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  }, [payload, orderedIds, sourceWidgets, load]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function onDragEnd({ active, over }: DragEndEvent) {
    if (!over || active.id === over.id) return;
    const from = orderedIds.indexOf(String(active.id));
    const to = orderedIds.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    void reorder(arrayMove(orderedIds, from, to));
  }

  function navigate(overrides: {
    days?: number; since?: string; until?: string;
    compare?: string; cmpSince?: string; cmpUntil?: string;
    page?: string | null;
  }) {
    const q = new URLSearchParams();
    // page (tab): keep the current one unless explicitly changed
    const pageId = overrides.page === undefined ? pageParam : overrides.page ?? "";
    if (pageId) q.set("page", pageId);
    // period
    if (overrides.since && overrides.until) {
      q.set("since", overrides.since);
      q.set("until", overrides.until);
    } else if (overrides.days) {
      q.set("days", String(overrides.days));
    } else if (isCustom) {
      q.set("since", range.since);
      q.set("until", range.until);
    } else {
      q.set("days", String(days));
    }
    // comparison
    const mode = overrides.compare ?? compareMode;
    if (mode !== "prev") q.set("compare", mode);
    if (mode === "custom") {
      const cs = overrides.cmpSince ?? cmpSince;
      const cu = overrides.cmpUntil ?? cmpUntil;
      if (cs) q.set("cmpSince", cs);
      if (cu) q.set("cmpUntil", cu);
    }
    router.replace(`/d/${id}?${q.toString()}`);
  }

  function setDays(d: number) {
    navigate({ days: d });
  }

  function setCustomRange(since: string, until: string) {
    if (!DATE_RE.test(since) || !DATE_RE.test(until) || since > until) return;
    navigate({ since, until });
  }

  const pages = payload?.pages ?? [];
  const activePageId = payload?.activePageId ?? null;

  async function renamePage(page: DashboardPageInfo) {
    const name = prompt("Nom de la page :", page.name);
    if (name === null || !name.trim() || name.trim() === page.name) return;
    const res = await fetch(`/api/dashboards/${id}/pages/${page.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: name.trim() }) });
    if (!res.ok) { const b = await res.json().catch(() => ({})); setError(b.error ?? `Erreur ${res.status}`); return; }
    load();
  }

  async function deletePage(page: DashboardPageInfo) {
    if (!confirm(`Supprimer la page « ${page.name} » ? Ses widgets reviennent sur la première page.`)) return;
    const res = await fetch(`/api/dashboards/${id}/pages/${page.id}`, { method: "DELETE" });
    if (!res.ok) { const b = await res.json().catch(() => ({})); setError(b.error ?? `Erreur ${res.status}`); return; }
    navigate({ page: null });
    load();
  }

  const onMutated = () => {
    setShowAdd(false);
    setEditingWidget(null);
    load();
  };

  return (
    <div className="max-w-[1440px] mx-auto px-4 sm:px-8 py-8 space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-3xl font-normal leading-tight text-ui-fg flex items-center gap-3">
            <Link href="/d" className="text-ui-muted hover:text-ui-fg2 text-xl transition-colors duration-150" title="Tous les comptes" aria-label="Tous les comptes">←</Link>
            {payload?.dashboard.name ?? "Pilotage"}
          </h1>
          <p className="text-sm text-ui-fg2 mt-2 flex items-center gap-3 flex-wrap">
            <span className="font-mono tabular-nums">{payload ? (payload.rangeLabel ?? describeRange({ since: payload.since, until: payload.until }).label) : describeRange(range).label}</span>
            {(payload ? payload.partialDay : describeRange(range).partialDay) && (
              <span className="text-xs text-ui-warn" title="La période inclut aujourd'hui : les chiffres du jour sont incomplets">
                aujourd&apos;hui partiel
              </span>
            )}
            <span className="text-xs text-ui-muted" title="Seules les personnes rattachées à ce dashboard par un admin (consultants, clients) y ont accès.">Espace privé</span>
            {isStaff && <span className="text-xs text-ui-muted">· vue client</span>}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-0.5 rounded-lg bg-ui-raised p-0.5" role="group" aria-label="Période">
            {PERIODS.map((p) => (
              <button
                key={p.days}
                type="button"
                onClick={() => setDays(p.days)}
                aria-pressed={!isCustom && days === p.days}
                className={`h-7 px-3 rounded-md text-xs font-mono tabular-nums transition-colors duration-150 ${
                  !isCustom && days === p.days ? "bg-ui-card text-ui-fg shadow-[inset_0_0_0_1px_var(--ui-line-strong)]" : "text-ui-fg2 hover:text-ui-fg"
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
          <div className={`h-8 flex items-center gap-1 rounded-lg border px-2 ${isCustom ? "border-ui-accent bg-ui-card" : "border-ui-line bg-ui-card"}`}>
            <input
              type="date"
              value={range.since}
              max={range.until}
              onChange={(e) => setCustomRange(e.target.value, range.until)}
              className="bg-transparent text-xs text-ui-fg2 focus:outline-none"
            />
            <span className="text-ui-muted text-xs">→</span>
            <input
              type="date"
              value={range.until}
              min={range.since}
              onChange={(e) => setCustomRange(range.since, e.target.value)}
              className="bg-transparent text-xs text-ui-fg2 focus:outline-none"
            />
          </div>
          <select
            value={compareMode}
            onChange={(e) => {
              const m = e.target.value;
              if (m === "custom") {
                const seed = prevWindowOf(range.since, range.until);
                navigate({ compare: "custom", cmpSince: seed.since, cmpUntil: seed.until });
              } else {
                navigate({ compare: m });
              }
            }}
            className="h-8 px-2 rounded-lg text-xs bg-ui-card border border-ui-line text-ui-fg2 focus:border-ui-accent focus:outline-none"
            title="Période de comparaison"
          >
            <option value="prev">vs période précédente</option>
            <option value="year">vs année précédente</option>
            <option value="custom">vs période au choix</option>
            <option value="none">sans comparaison</option>
          </select>
          {compareMode === "custom" && (
            <div className="flex items-center gap-1 rounded-lg border border-ui-line bg-ui-card px-2 py-1">
              <span className="text-xs text-ui-muted">vs</span>
              <input
                type="date"
                value={cmpSince}
                max={cmpUntil || undefined}
                onChange={(e) => navigate({ compare: "custom", cmpSince: e.target.value })}
                className="bg-transparent text-xs text-ui-fg2 focus:outline-none"
              />
              <span className="text-ui-muted text-xs">→</span>
              <input
                type="date"
                value={cmpUntil}
                min={cmpSince || undefined}
                onChange={(e) => navigate({ compare: "custom", cmpUntil: e.target.value })}
                className="bg-transparent text-xs text-ui-fg2 focus:outline-none"
              />
            </div>
          )}
          {isStaff && (
            <button
              type="button"
              onClick={() => setShowCopilot((v) => !v)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                showCopilot
                  ? "bg-ui-accent border-ui-accent text-ui-on-accent"
                  : "bg-ui-card border-ui-line text-ui-fg2 hover:text-ui-fg"
              }`}
            >
              Copilote
            </button>
          )}
          {isStaff && (
            <button
              type="button"
              onClick={() => { setEditMode((v) => !v); setShowAdd(false); setEditingWidget(null); setShowSettings(false); }}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                editMode
                  ? "bg-ui-accent border-ui-accent text-ui-on-accent"
                  : "bg-ui-card border-ui-line text-ui-fg2 hover:text-ui-fg"
              }`}
            >
              {editMode ? "Terminer" : "Modifier"}
            </button>
          )}
        </div>
      </div>

      {payload && (
        <PageTabs
          pages={pages}
          activePageId={activePageId}
          editing={isStaff && editMode}
          onSelect={(pid) => { setShowHistory(false); navigate({ page: pid }); }}
          extraTabs={isStaff ? [{ id: "history", label: "Historique & impact", active: showHistory, onSelect: () => { setShowHistory(true); setEditMode(false); } }] : []}
          onAdd={() => { setShowPageForm(true); setShowAdd(false); setEditingWidget(null); setShowSettings(false); }}
          onRename={renamePage}
          onDelete={deletePage}
        />
      )}
      {pageNote && (
        <div className="text-xs text-ui-fg2 bg-ui-raised rounded-lg px-3 py-2 flex items-start justify-between gap-3">
          <span>Note de l&apos;IA : {pageNote}</span>
          <button type="button" onClick={() => setPageNote(null)} className="text-ui-muted hover:text-ui-fg">✕</button>
        </div>
      )}

      {isStaff && editMode && (
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => { setShowAdd(true); setEditingWidget(null); setShowSettings(false); setShowPageForm(false); }}
            className="px-3 py-1.5 rounded-lg text-xs font-medium bg-ui-accent hover:brightness-110 text-ui-on-accent transition-[filter] duration-150"
          >
            + Ajouter un widget
          </button>
          <button
            type="button"
            onClick={() => { setShowSettings(true); setShowAdd(false); setEditingWidget(null); }}
            className="px-3 py-1.5 rounded-lg text-xs font-medium bg-ui-raised hover:bg-ui-line-strong text-ui-fg transition-colors"
          >
            Réglages
          </button>
        </div>
      )}

      {showPageForm && payload && (
        <PageForm
          dashboardId={payload.dashboard.id}
          onDone={(pid, note) => { setShowPageForm(false); setPageNote(note ?? null); navigate({ page: pid }); }}
          onCancel={() => setShowPageForm(false)}
        />
      )}
      {showAdd && payload && (
        <WidgetForm dashboardId={payload.dashboard.id} widget={null} range={range} pageId={activePageId === DEFAULT_PAGE_ID ? null : activePageId} onDone={onMutated} onCancel={() => setShowAdd(false)} />
      )}
      {showSettings && payload && (
        <DashboardSettingsForm
          dashboard={payload.dashboard}
          onDone={() => { setShowSettings(false); load(); }}
          onCancel={() => setShowSettings(false)}
        />
      )}

      {(error || payload?.error) && (
        <div className="text-sm text-ui-neg bg-ui-neg/10 rounded-xl px-4 py-3">{error ?? payload?.error}</div>
      )}

      {isStaff && showHistory ? (
        <PilotHistoryTab dashboardId={id} />
      ) : loading && !payload ? (
        <div className="grid grid-cols-6 gap-4">
          {[...Array(6)].map((_, i) => (
            <div key={i} className={`${i < 3 ? "lg:col-span-2" : "lg:col-span-3"} col-span-6 h-36 rounded-xl bg-ui-card border border-ui-line animate-pulse`} />
          ))}
        </div>
      ) : (
        (() => {
          const editing = isStaff && editMode && !!payload;
          const grid = (
            <PilotLinksContext.Provider value={isStaff}>
            <div className={`grid grid-cols-6 gap-4 ${loading ? "opacity-60" : ""}`}>
              {widgets.map((w) => {
                if (!editing || !payload) {
                  // Client view: untouched (no DnD wrapper, no handle).
                  return (
                    <WidgetFrame key={w.id} widget={w}>
                      <WidgetBody widget={w} />
                    </WidgetFrame>
                  );
                }
                const frame = (
                  <SortableWidgetFrame
                    key={w.id}
                    widget={w}
                    editControls={
                      <EditControls
                        dashboardId={payload.dashboard.id}
                        widget={w}
                        orderedIds={orderedIds}
                        onReorder={reorder}
                        onChanged={load}
                        onEdit={() => { setEditingWidget(w); setShowAdd(false); setShowSettings(false); }}
                      />
                    }
                  >
                    <WidgetBody widget={w} />
                  </SortableWidgetFrame>
                );
                // The edit form opens right above the widget being edited.
                if (editingWidget?.id !== w.id) return frame;
                return (
                  <Fragment key={w.id}>
                    <InlineWidgetEditor dashboardId={payload.dashboard.id} widget={editingWidget} range={range} onDone={onMutated} onCancel={() => setEditingWidget(null)} />
                    {frame}
                  </Fragment>
                );
              })}
              {widgets.length === 0 && !loading && (
                <div className="col-span-6 text-sm text-ui-muted bg-ui-card border border-ui-line rounded-xl px-5 py-8 text-center">
                  Ce dashboard n&apos;a pas encore de widget.
                  {isStaff ? " Passez en mode édition pour en ajouter." : " Votre consultant est en train de le préparer."}
                </div>
              )}
            </div>
            </PilotLinksContext.Provider>
          );
          if (!editing) return grid;
          return (
            <DndContext id={`dnd-${id}`} sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
              <SortableContext items={orderedIds} strategy={rectSortingStrategy}>
                {grid}
              </SortableContext>
            </DndContext>
          );
        })()
      )}

      {isStaff && showCopilot && payload && (
        <CopilotPanel
          sheetsShareEmail={SHEETS_SHARE_EMAIL}
          dashboardId={payload.dashboard.id}
          widgets={widgets}
          onApplied={load}
          onClose={() => setShowCopilot(false)}
        />
      )}
    </div>
  );
}
