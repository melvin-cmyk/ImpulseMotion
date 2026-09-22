"use client";

/**
 * Staff-only editing UI for a client dashboard: add / edit / remove / reorder
 * widgets and rebind the dashboard's accounts. Pure API-driven — every action
 * calls /api/dashboards/* then triggers a reload.
 */

import { useEffect, useState } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical } from "lucide-react";
import { Card } from "@/components/ui/surface";
import { WidgetFrame } from "@/components/dashboard/renderers";
import {
  WIDGET_TYPES, WIDGET_TYPE_INFO, KPI_METRICS, SERIES_METRICS, TABLE_KINDS, WIDGET_WIDTHS,
  DEMOGRAPHICS_METRICS, GEO_DEVICE_DIMENSIONS, CONVERSION_WIDGET_TYPES, META_ACTIONS_MAX,
  type ResolvedWidget, type WidgetType,
} from "@/lib/dashboard-types";
import { CONVERSION_PRESETS } from "@/lib/meta-actions";

const inputCls =
  "px-3 py-2 rounded-lg text-sm bg-gray-950 border border-gray-800 text-white focus:border-violet-500 focus:outline-none";
const btnCls =
  "px-3 py-1.5 rounded-lg text-xs font-semibold bg-gray-800 hover:bg-gray-700 text-gray-200 transition-colors disabled:opacity-50";
const primaryBtnCls =
  "px-3 py-1.5 rounded-lg text-xs font-semibold bg-violet-600 hover:bg-violet-500 text-white transition-colors disabled:opacity-50";

interface WidgetFormState {
  type: WidgetType;
  title: string;
  width: string;
  metric: string;
  source: string;
  kind: string;
  limit: number;
  markdown: string;
  /** "" = réglage du compte */
  conversionEvent: string;
  /** meta_actions: types sélectionnés ([] = toutes) */
  actions: string[];
}

const emptyForm: WidgetFormState = {
  type: "kpi", title: "", width: "half", metric: "spend", source: "meta",
  kind: "campaigns", limit: 10, markdown: "", conversionEvent: "", actions: [],
};

const isConversionType = (t: WidgetType) => (CONVERSION_WIDGET_TYPES as readonly string[]).includes(t);

/** The conversion picker only makes sense when the widget reads Meta. */
function readsMeta(f: WidgetFormState): boolean {
  if (!isConversionType(f.type)) return false;
  if (["kpi", "funnel", "timeseries", "table", "geo_device"].includes(f.type)) return f.source !== "google";
  return true;
}

const CRM_ATTRIBUTION: WidgetType = "crm_attribution";
const isCrmType = (t: WidgetType) => t === "crm_funnel" || t === CRM_ATTRIBUTION;

function formToConfig(f: WidgetFormState): Record<string, unknown> {
  const base = typedConfig(f);
  // "" is sent on purpose: PATCH merges configs, so it clears a previous override.
  return isConversionType(f.type) ? { ...base, conversionEvent: readsMeta(f) ? f.conversionEvent : "" } : base;
}

function typedConfig(f: WidgetFormState): Record<string, unknown> {
  switch (f.type) {
    case "crm_funnel": return {};
    case "crm_attribution": return { limit: Math.min(Math.max(f.limit || 10, 1), 50) };
    case "kpi": return { metric: f.metric, source: f.source };
    case "timeseries": return { metric: f.metric, source: f.source === "combined" ? "meta" : f.source };
    case "table": return { kind: f.kind, source: f.source === "combined" ? "google" : f.source, limit: f.limit };
    case "top_creatives": return { limit: f.limit };
    case "platform_table":
    case "pacing": return {};
    case "text": return { markdown: f.markdown };
    case "funnel": return { source: f.source };
    case "demographics":
      return { metric: ["spend", "purchases", "clicks"].includes(f.metric) ? f.metric : "spend" };
    case "geo_device":
      return { source: f.source === "combined" ? "meta" : f.source, dimension: String(f.kind === "country" ? "country" : "device") };
    case "alerts": return { limit: Math.min(f.limit, 20) };
    case "meta_actions": return { actions: f.actions, limit: Math.min(Math.max(f.limit || 15, 1), 50) };
  }
}

function widgetToForm(w: ResolvedWidget): WidgetFormState {
  const c = w.config;
  return {
    type: w.type as WidgetType,
    title: w.title ?? "",
    width: w.width,
    metric: String(c.metric ?? "spend"),
    source: String(c.source ?? "meta"),
    // geo_device stores its dimension in `dimension`; reuse the shared `kind` slot.
    kind: String(c.kind ?? c.dimension ?? "campaigns"),
    limit: Number(c.limit ?? 10),
    markdown: String(c.markdown ?? ""),
    conversionEvent: typeof c.conversionEvent === "string" ? c.conversionEvent : "",
    actions: Array.isArray(c.actions) ? c.actions.map(String) : [],
  };
}

interface MetaActionsCatalog {
  accountDefaultLabel: string;
  actions: Array<{ actionType: string; label: string; count: number }>;
}

/** Action types of the dashboard's Meta account on the period (staff API). */
function useMetaActions(dashboardId: string, enabled: boolean, range?: { since: string; until: string }) {
  const [catalog, setCatalog] = useState<MetaActionsCatalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const since = range?.since ?? "";
  const until = range?.until ?? "";
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const q = since && until ? `?since=${since}&until=${until}` : "";
    fetch(`/api/dashboards/${dashboardId}/meta-actions${q}`)
      .then(async (r) => {
        const body = await r.json().catch(() => ({}));
        if (cancelled) return;
        if (r.ok) { setCatalog(body); setError(null); } else setError(body.error ?? `Erreur ${r.status}`);
      })
      .catch(() => { if (!cancelled) setError("Actions Meta indisponibles"); });
    return () => { cancelled = true; };
  }, [dashboardId, enabled, since, until]);
  return { catalog, error };
}

const fmtCount = (n: number) => n.toLocaleString("fr-FR", { maximumFractionDigits: 1 });

function ConversionSelect({ value, onChange, catalog }: {
  value: string;
  onChange: (v: string) => void;
  catalog: MetaActionsCatalog | null;
}) {
  const known = new Set(catalog?.actions.map((a) => `custom:${a.actionType}`) ?? []);
  const isPreset = CONVERSION_PRESETS.some((p) => p.value === value);
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className={inputCls + " max-w-72"} title="Action de conversion Meta comptée par ce widget">
      <option value="">Conversion : réglage du compte{catalog ? ` (${catalog.accountDefaultLabel})` : ""}</option>
      {CONVERSION_PRESETS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
      {value && !isPreset && !known.has(value) && <option value={value}>{value.replace(/^custom:/, "")}</option>}
      {catalog && catalog.actions.length > 0 && (
        <optgroup label="Actions du compte sur la période">
          {catalog.actions.map((a) => (
            <option key={a.actionType} value={`custom:${a.actionType}`}>
              {a.label} — {fmtCount(a.count)}
            </option>
          ))}
        </optgroup>
      )}
    </select>
  );
}

function ActionsChecklist({ selected, onChange, catalog, error }: {
  selected: string[];
  onChange: (v: string[]) => void;
  catalog: MetaActionsCatalog | null;
  error: string | null;
}) {
  if (error) return <div className="text-xs text-amber-400/90 mt-3">{error}</div>;
  if (!catalog) return <div className="text-xs text-gray-500 mt-3">Chargement des actions Meta…</div>;
  // Selected types absent from the period stay listed so they can be unticked.
  const rows = [
    ...catalog.actions,
    ...selected.filter((t) => !catalog.actions.some((a) => a.actionType === t)).map((t) => ({ actionType: t, label: t, count: 0 })),
  ];
  const toggle = (t: string) =>
    onChange(selected.includes(t) ? selected.filter((x) => x !== t) : [...selected, t].slice(0, META_ACTIONS_MAX));
  return (
    <div className="mt-3">
      <div className="flex items-center justify-between text-[11px] text-gray-500 mb-1">
        <span>
          {selected.length === 0
            ? "Aucune sélection : toutes les actions du compte (doublons retirés), triées par volume."
            : `${selected.length} action(s) affichée(s), dans l'ordre de sélection.`}
        </span>
        {selected.length > 0 && (
          <button type="button" onClick={() => onChange([])} className="text-violet-400 hover:text-violet-300">Tout décocher</button>
        )}
      </div>
      <div className="max-h-56 overflow-y-auto rounded-lg border border-gray-800 divide-y divide-gray-800/60">
        {rows.length === 0 && <div className="text-xs text-gray-500 px-3 py-2">Aucune action Meta sur la période.</div>}
        {rows.map((a) => (
          <label key={a.actionType} className="flex items-center gap-2 px-3 py-1.5 text-xs cursor-pointer hover:bg-gray-800/40">
            <input type="checkbox" checked={selected.includes(a.actionType)} onChange={() => toggle(a.actionType)} className="accent-violet-500" />
            <span className="text-gray-200 flex-1 truncate" title={a.actionType}>{a.label}</span>
            <span className="text-gray-600 truncate max-w-48 hidden sm:inline">{a.actionType}</span>
            <span className="text-gray-400 tabular-nums w-16 text-right">{fmtCount(a.count)}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

export function WidgetForm({
  dashboardId, widget, range, pageId, onDone, onCancel,
}: {
  dashboardId: string;
  widget: ResolvedWidget | null; // null = creating
  /** Period shown on the dashboard — the action pickers list what happened on it. */
  range?: { since: string; until: string };
  /** Page (tab) a new widget lands on; null = first page. */
  pageId?: string | null;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState<WidgetFormState>(widget ? widgetToForm(widget) : emptyForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<WidgetFormState>) => setForm((f) => ({ ...f, ...patch }));
  const showConversion = readsMeta(form);
  const { catalog, error: actionsError } = useMetaActions(dashboardId, showConversion || form.type === "meta_actions", range);

  async function save() {
    setSaving(true);
    setError(null);
    const payload = {
      type: form.type,
      title: form.title || null,
      width: form.width,
      config: formToConfig(form),
    };
    const res = widget
      ? await fetch(`/api/dashboards/${dashboardId}/widgets/${widget.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: payload.title ?? "", width: payload.width, config: payload.config }),
        })
      : await fetch(`/api/dashboards/${dashboardId}/widgets`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...payload, pageId: pageId ?? null }),
        });
    setSaving(false);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? `Erreur ${res.status}`);
      return;
    }
    onDone();
  }

  const metricOptions = form.type === "kpi" ? KPI_METRICS : SERIES_METRICS;

  return (
    <Card padded className="border-violet-800/60">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-white">
          {widget ? "Modifier le widget" : "Ajouter un widget"}
        </h3>
        <button type="button" onClick={onCancel} className="text-xs text-gray-500 hover:text-gray-300">Annuler</button>
      </div>
      <div className="flex flex-wrap gap-3">
        {!widget && (
          <select value={form.type} onChange={(e) => set({ type: e.target.value as WidgetType })} className={inputCls}>
            {WIDGET_TYPES.map((t) => <option key={t} value={t}>{WIDGET_TYPE_INFO[t].label}</option>)}
          </select>
        )}
        <input
          placeholder="Titre (optionnel)"
          value={form.title}
          onChange={(e) => set({ title: e.target.value })}
          className={inputCls + " w-52"}
        />
        <select value={form.width} onChange={(e) => set({ width: e.target.value })} className={inputCls}>
          {WIDGET_WIDTHS.map((w) => (
            <option key={w} value={w}>{w === "third" ? "1/3" : w === "half" ? "1/2" : "Pleine largeur"}</option>
          ))}
        </select>

        {(form.type === "kpi" || form.type === "timeseries") && (
          <select value={form.metric} onChange={(e) => set({ metric: e.target.value })} className={inputCls}>
            {metricOptions.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        )}
        {(form.type === "kpi" || form.type === "funnel") && (
          <select value={form.source} onChange={(e) => set({ source: e.target.value })} className={inputCls}>
            <option value="meta">Meta</option>
            <option value="google">Google</option>
            <option value="combined">Meta + Google</option>
          </select>
        )}
        {form.type === "demographics" && (
          <select
            value={(DEMOGRAPHICS_METRICS as readonly string[]).includes(form.metric) ? form.metric : "spend"}
            onChange={(e) => set({ metric: e.target.value })}
            className={inputCls}
            title="Métrique"
          >
            <option value="spend">Dépenses</option>
            <option value="purchases">Conversions</option>
            <option value="clicks">Clics</option>
          </select>
        )}
        {form.type === "geo_device" && (
          <>
            <select
              value={form.source === "google" ? "google" : "meta"}
              onChange={(e) =>
                // Google n'expose pas la répartition pays : on force la dimension appareil.
                set({ source: e.target.value, ...(e.target.value === "google" && form.kind === "country" ? { kind: "device" } : {}) })
              }
              className={inputCls}
            >
              <option value="meta">Meta</option>
              <option value="google">Google</option>
            </select>
            <select
              value={form.kind === "country" ? "country" : "device"}
              onChange={(e) => set({ kind: e.target.value })}
              className={inputCls}
              title="Dimension"
            >
              {GEO_DEVICE_DIMENSIONS.map((dim) => (
                <option key={dim} value={dim} disabled={dim === "country" && form.source === "google"}>
                  {dim === "device" ? "Par appareil" : "Par pays"}
                </option>
              ))}
            </select>
          </>
        )}
        {(form.type === "timeseries" || form.type === "table") && (
          <select value={form.source} onChange={(e) => set({ source: e.target.value })} className={inputCls}>
            <option value="meta">Meta</option>
            <option value="google">Google</option>
          </select>
        )}
        {form.type === "table" && (
          <select value={form.kind} onChange={(e) => set({ kind: e.target.value })} className={inputCls}>
            {TABLE_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
        )}
        {showConversion && (
          <ConversionSelect value={form.conversionEvent} onChange={(v) => set({ conversionEvent: v })} catalog={catalog} />
        )}
        {form.type === "meta_actions" && form.actions.length === 0 && (
          <input
            type="number" min={1} max={50}
            value={form.limit}
            onChange={(e) => set({ limit: Number(e.target.value) })}
            className={inputCls + " w-20"}
            title="Nombre d'actions affichées"
          />
        )}
        {(form.type === "table" || form.type === "top_creatives" || form.type === "alerts" || form.type === CRM_ATTRIBUTION) && (
          <input
            type="number" min={1} max={form.type === "table" ? 30 : form.type === "alerts" ? 20 : form.type === CRM_ATTRIBUTION ? 50 : 10}
            value={form.limit}
            onChange={(e) => set({ limit: Number(e.target.value) })}
            className={inputCls + " w-20"}
            title={form.type === "alerts" ? "Nombre d'alertes" : form.type === CRM_ATTRIBUTION ? "Nombre de campagnes affichées" : "Nombre de lignes"}
          />
        )}
        {isCrmType(form.type) && (
          <span className="text-[11px] text-gray-500 self-center">Nécessite une source HubSpot connectée (fiche client → Sources de données).</span>
        )}
      </div>
      {form.type === "meta_actions" && (
        <ActionsChecklist selected={form.actions} onChange={(v) => set({ actions: v })} catalog={catalog} error={actionsError} />
      )}
      {form.type === "text" && (
        <textarea
          placeholder="Markdown…"
          value={form.markdown}
          onChange={(e) => set({ markdown: e.target.value })}
          rows={5}
          className={inputCls + " w-full mt-3 font-mono text-xs"}
        />
      )}
      {error && <div className="text-xs text-red-400 mt-2">{error}</div>}
      <div className="mt-3">
        <button type="button" onClick={save} disabled={saving} className={primaryBtnCls}>
          {saving ? "Enregistrement…" : widget ? "Enregistrer" : "Ajouter"}
        </button>
      </div>
    </Card>
  );
}

export function DashboardSettingsForm({
  dashboard, onDone, onCancel,
}: {
  dashboard: { id: string; userId: string; name: string; metaAccountId: string | null; googleCustomerId: string | null };
  onDone: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(dashboard.name);
  const [metaId, setMetaId] = useState(dashboard.metaAccountId ?? "");
  const [googleId, setGoogleId] = useState(dashboard.googleCustomerId ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setError(null);
    const res = await fetch(`/api/dashboards/${dashboard.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        metaAccountId: metaId.trim() || null,
        googleCustomerId: googleId.trim() || null,
      }),
    });
    setSaving(false);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? `Erreur ${res.status}`);
      return;
    }
    onDone();
  }

  return (
    <Card padded className="border-violet-800/60">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-white">Réglages du dashboard</h3>
        <button type="button" onClick={onCancel} className="text-xs text-gray-500 hover:text-gray-300">Annuler</button>
      </div>
      <div className="flex flex-wrap gap-3">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nom" className={inputCls + " w-48"} />
        <input value={metaId} onChange={(e) => setMetaId(e.target.value)} placeholder="Compte Meta (act_…)" className={inputCls + " w-48"} />
        <input value={googleId} onChange={(e) => setGoogleId(e.target.value)} placeholder="Customer Google Ads" className={inputCls + " w-48"} />
      </div>
      <p className="text-[11px] text-gray-500 mt-2">
        Les accès (consultants, clients, bot) se gèrent par un admin depuis la liste des dashboards.
        Changer de compte met à jour les droits de toutes les personnes rattachées.
      </p>
      {error && <div className="text-xs text-red-400 mt-2">{error}</div>}
      <div className="mt-3 flex items-center gap-2">
        <button type="button" onClick={save} disabled={saving} className={primaryBtnCls}>
          {saving ? "Enregistrement…" : "Enregistrer"}
        </button>
        <button
          type="button"
          disabled={saving}
          onClick={async () => {
            if (!confirm("Remplacer tous les widgets par le set par défaut ? Les widgets actuels seront supprimés.")) return;
            setSaving(true);
            const res = await fetch(`/api/dashboards/${dashboard.id}/reset`, { method: "POST" });
            setSaving(false);
            if (res.ok) onDone();
            else setError("Échec de la réinitialisation");
          }}
          className={btnCls}
        >
          Réinitialiser les widgets par défaut
        </button>
      </div>
    </Card>
  );
}

/**
 * Edit-mode widget card: a sortable grid item (dnd-kit) with a grip handle
 * placed next to the edit controls. Must be rendered inside the page's
 * DndContext + SortableContext.
 */
export function SortableWidgetFrame({ widget, children, editControls }: {
  widget: ResolvedWidget;
  children: React.ReactNode;
  editControls?: React.ReactNode;
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id: widget.id });
  // Neutralise the scale rectSortingStrategy applies when the target slot has
  // a different width (full/half/third): only translate the card.
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform ? { ...transform, scaleX: 1, scaleY: 1 } : null),
    transition,
  };
  const handle = (
    <button
      type="button"
      ref={setActivatorNodeRef}
      {...attributes}
      {...listeners}
      className="p-1 rounded-lg text-gray-500 hover:text-gray-200 hover:bg-gray-800 cursor-grab active:cursor-grabbing touch-none transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500"
      title="Glisser pour réordonner (ou Espace + flèches)"
      aria-label={`Réordonner le widget ${widget.title ?? ""}`.trim()}
    >
      <GripVertical className="w-4 h-4" aria-hidden="true" />
    </button>
  );
  return (
    <WidgetFrame
      widget={widget}
      sortableRef={setNodeRef}
      sortableStyle={style}
      dragging={isDragging}
      editControls={
        <div className="flex items-center gap-1">
          {handle}
          {editControls}
        </div>
      }
    >
      {children}
    </WidgetFrame>
  );
}

export function EditControls({
  dashboardId, widget, orderedIds, onReorder, onChanged, onEdit,
}: {
  dashboardId: string;
  widget: ResolvedWidget;
  orderedIds: string[];
  /** Shared reorder path (same as drag & drop): optimistic + PUT { order }. */
  onReorder: (nextIds: string[]) => Promise<unknown> | void;
  onChanged: () => void;
  onEdit: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const idx = orderedIds.indexOf(widget.id);

  // Keyboard / accessibility fallback for drag & drop — one code path.
  async function move(dir: -1 | 1) {
    const target = idx + dir;
    if (target < 0 || target >= orderedIds.length) return;
    const next = [...orderedIds];
    [next[idx], next[target]] = [next[target], next[idx]];
    setBusy(true);
    try {
      await onReorder(next);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!confirm("Supprimer ce widget ?")) return;
    setBusy(true);
    await fetch(`/api/dashboards/${dashboardId}/widgets/${widget.id}`, { method: "DELETE" });
    setBusy(false);
    onChanged();
  }

  return (
    <div className="flex items-center gap-1">
      <button type="button" onClick={() => move(-1)} disabled={busy || idx <= 0} className={btnCls} title="Monter">↑</button>
      <button type="button" onClick={() => move(1)} disabled={busy || idx >= orderedIds.length - 1} className={btnCls} title="Descendre">↓</button>
      <button type="button" onClick={onEdit} disabled={busy} className={btnCls} title="Modifier">✎</button>
      <button type="button" onClick={remove} disabled={busy} className={btnCls + " hover:bg-red-900/50"} title="Supprimer">✕</button>
    </div>
  );
}
