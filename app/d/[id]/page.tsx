"use client";

/**
 * /d/[id] — a client steering dashboard.
 * Clients see the widget grid read-only; staff get an edit mode
 * (add / edit / reorder / remove widgets, dashboard settings).
 * Period lives in the URL (?days=7|30|90) so views are shareable.
 */

import { useCallback, useEffect, useMemo, useState, use } from "react";
import { useSession } from "next-auth/react";
import { useRouter, useSearchParams } from "next/navigation";
import { WidgetBody, WidgetFrame } from "@/components/dashboard/renderers";
import { WidgetForm, DashboardSettingsForm, EditControls } from "@/components/dashboard/editor";
import { CopilotPanel } from "@/components/dashboard/copilot";
import type { ResolvedWidget } from "@/lib/dashboard-types";

interface DashboardPayload {
  dashboard: { id: string; userId: string; name: string; metaAccountId: string | null; googleCustomerId: string | null };
  since: string;
  until: string;
  widgets: ResolvedWidget[];
}

const PERIODS = [
  { days: 7, label: "7 j" },
  { days: 30, label: "30 j" },
  { days: 90, label: "90 j" },
];

function rangeFor(days: number): { since: string; until: string } {
  const fmt = (d: Date) => d.toISOString().split("T")[0];
  const until = new Date();
  const since = new Date();
  since.setDate(since.getDate() - days);
  return { since: fmt(since), until: fmt(until) };
}

/** Previous window of equal length — used to seed the custom comparison inputs. */
function prevWindowOf(since: string, until: string): { since: string; until: string } {
  const DAY = 86400000;
  const s = Date.parse(since + "T00:00:00Z");
  const u = Date.parse(until + "T00:00:00Z");
  const daysLen = Math.max(1, Math.round((u - s) / DAY) + 1);
  const fmt = (ms: number) => new Date(ms).toISOString().split("T")[0];
  return { since: fmt(s - daysLen * DAY), until: fmt(s - DAY) };
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
  const cmpSince = searchParams.get("cmpSince") ?? "";
  const cmpUntil = searchParams.get("cmpUntil") ?? "";
  const isCmpCustom = compareMode === "custom" && DATE_RE.test(cmpSince) && DATE_RE.test(cmpUntil) && cmpSince <= cmpUntil;

  const [payload, setPayload] = useState<DashboardPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editMode, setEditMode] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [editingWidget, setEditingWidget] = useState<ResolvedWidget | null>(null);
  const [showCopilot, setShowCopilot] = useState(false);

  const compareQuery =
    compareMode === "none" ? "&compare=none"
    : compareMode === "year" ? "&compare=year"
    : isCmpCustom ? `&compare=custom&cmpSince=${cmpSince}&cmpUntil=${cmpUntil}`
    : "";

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/dashboards/${id}?since=${range.since}&until=${range.until}${compareQuery}`);
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
  }, [id, range.since, range.until, compareQuery]);

  useEffect(() => { load(); }, [load]);

  const widgets = payload?.widgets ?? [];
  const orderedIds = widgets.map((w) => w.id);

  function navigate(overrides: {
    days?: number; since?: string; until?: string;
    compare?: string; cmpSince?: string; cmpUntil?: string;
  }) {
    const q = new URLSearchParams();
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

  const onMutated = () => {
    setShowAdd(false);
    setEditingWidget(null);
    load();
  };

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-white flex items-center gap-2">
            <a href="/d" className="text-gray-600 hover:text-gray-400" title="Tous les comptes">←</a>
            {payload?.dashboard.name ?? "Pilotage"}
            {isStaff && (
              <span className="text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full bg-blue-900/60 text-blue-300 border border-blue-800">
                Vue client
              </span>
            )}
          </h1>
          <p className="text-xs text-gray-500 mt-0.5">
            {payload ? `${payload.since} → ${payload.until}` : "…"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-lg border border-gray-800 overflow-hidden">
            {PERIODS.map((p) => (
              <button
                key={p.days}
                type="button"
                onClick={() => setDays(p.days)}
                className={`px-3 py-1.5 text-xs font-semibold transition-colors ${
                  !isCustom && days === p.days ? "bg-violet-600 text-white" : "bg-gray-900 text-gray-400 hover:text-white"
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
          <div className={`flex items-center gap-1 rounded-lg border px-2 py-1 ${isCustom ? "border-violet-600 bg-violet-950/40" : "border-gray-800 bg-gray-900"}`}>
            <input
              type="date"
              value={range.since}
              max={range.until}
              onChange={(e) => setCustomRange(e.target.value, range.until)}
              className="bg-transparent text-xs text-gray-300 focus:outline-none [color-scheme:dark]"
            />
            <span className="text-gray-600 text-xs">→</span>
            <input
              type="date"
              value={range.until}
              min={range.since}
              onChange={(e) => setCustomRange(range.since, e.target.value)}
              className="bg-transparent text-xs text-gray-300 focus:outline-none [color-scheme:dark]"
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
            className="px-2 py-1.5 rounded-lg text-xs bg-gray-900 border border-gray-800 text-gray-300 focus:border-violet-500 focus:outline-none"
            title="Période de comparaison"
          >
            <option value="prev">vs période précédente</option>
            <option value="year">vs année précédente</option>
            <option value="custom">vs période au choix</option>
            <option value="none">sans comparaison</option>
          </select>
          {compareMode === "custom" && (
            <div className="flex items-center gap-1 rounded-lg border border-gray-800 bg-gray-900 px-2 py-1">
              <span className="text-[10px] uppercase text-gray-600 font-semibold">vs</span>
              <input
                type="date"
                value={cmpSince}
                max={cmpUntil || undefined}
                onChange={(e) => navigate({ compare: "custom", cmpSince: e.target.value })}
                className="bg-transparent text-xs text-gray-300 focus:outline-none [color-scheme:dark]"
              />
              <span className="text-gray-600 text-xs">→</span>
              <input
                type="date"
                value={cmpUntil}
                min={cmpSince || undefined}
                onChange={(e) => navigate({ compare: "custom", cmpUntil: e.target.value })}
                className="bg-transparent text-xs text-gray-300 focus:outline-none [color-scheme:dark]"
              />
            </div>
          )}
          {isStaff && (
            <button
              type="button"
              onClick={() => setShowCopilot((v) => !v)}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors ${
                showCopilot
                  ? "bg-violet-600 border-violet-500 text-white"
                  : "bg-gray-900 border-gray-800 text-gray-300 hover:text-white"
              }`}
            >
              ✦ Copilote
            </button>
          )}
          {isStaff && (
            <button
              type="button"
              onClick={() => { setEditMode((v) => !v); setShowAdd(false); setEditingWidget(null); setShowSettings(false); }}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors ${
                editMode
                  ? "bg-violet-600 border-violet-500 text-white"
                  : "bg-gray-900 border-gray-800 text-gray-300 hover:text-white"
              }`}
            >
              {editMode ? "Terminer" : "Modifier"}
            </button>
          )}
        </div>
      </div>

      {isStaff && editMode && (
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => { setShowAdd(true); setEditingWidget(null); setShowSettings(false); }}
            className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-violet-600 hover:bg-violet-500 text-white transition-colors"
          >
            + Ajouter un widget
          </button>
          <button
            type="button"
            onClick={() => { setShowSettings(true); setShowAdd(false); setEditingWidget(null); }}
            className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-gray-800 hover:bg-gray-700 text-gray-200 transition-colors"
          >
            Réglages
          </button>
        </div>
      )}

      {showAdd && payload && (
        <WidgetForm dashboardId={payload.dashboard.id} widget={null} onDone={onMutated} onCancel={() => setShowAdd(false)} />
      )}
      {editingWidget && payload && (
        <WidgetForm dashboardId={payload.dashboard.id} widget={editingWidget} onDone={onMutated} onCancel={() => setEditingWidget(null)} />
      )}
      {showSettings && payload && (
        <DashboardSettingsForm
          dashboard={payload.dashboard}
          onDone={() => { setShowSettings(false); load(); }}
          onCancel={() => setShowSettings(false)}
        />
      )}

      {error && (
        <div className="text-sm text-red-400 bg-red-950/40 border border-red-900/50 rounded-xl px-4 py-3">{error}</div>
      )}

      {loading && !payload ? (
        <div className="grid grid-cols-6 gap-4">
          {[...Array(6)].map((_, i) => (
            <div key={i} className={`${i < 3 ? "lg:col-span-2" : "lg:col-span-3"} col-span-6 h-36 rounded-2xl bg-gray-900 border border-gray-800 animate-pulse`} />
          ))}
        </div>
      ) : (
        <div className={`grid grid-cols-6 gap-4 ${loading ? "opacity-60" : ""}`}>
          {widgets.map((w) => (
            <WidgetFrame
              key={w.id}
              widget={w}
              editControls={
                isStaff && editMode && payload ? (
                  <EditControls
                    dashboardId={payload.dashboard.id}
                    widget={w}
                    orderedIds={orderedIds}
                    onChanged={load}
                    onEdit={() => { setEditingWidget(w); setShowAdd(false); setShowSettings(false); }}
                  />
                ) : undefined
              }
            >
              <WidgetBody widget={w} />
            </WidgetFrame>
          ))}
          {widgets.length === 0 && !loading && (
            <div className="col-span-6 text-sm text-gray-500 bg-gray-900 border border-gray-800 rounded-2xl px-5 py-8 text-center">
              Ce dashboard n&apos;a pas encore de widget.
              {isStaff ? " Passez en mode édition pour en ajouter." : " Votre consultant le configure bientôt."}
            </div>
          )}
        </div>
      )}

      {isStaff && showCopilot && payload && (
        <CopilotPanel
          dashboardId={payload.dashboard.id}
          onApplied={load}
          onClose={() => setShowCopilot(false)}
        />
      )}
    </div>
  );
}
