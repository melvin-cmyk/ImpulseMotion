"use client";

/**
 * Staff-only editing UI for a client dashboard: add / edit / remove / reorder
 * widgets and rebind the dashboard's accounts. Pure API-driven — every action
 * calls /api/dashboards/* then triggers a reload.
 */

import { useState } from "react";
import { Card } from "@/components/ui/surface";
import {
  WIDGET_TYPES, WIDGET_TYPE_INFO, KPI_METRICS, SERIES_METRICS, TABLE_KINDS, WIDGET_WIDTHS,
  type ResolvedWidget, type WidgetType,
} from "@/lib/dashboard-types";

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
}

const emptyForm: WidgetFormState = {
  type: "kpi", title: "", width: "half", metric: "spend", source: "meta",
  kind: "campaigns", limit: 10, markdown: "",
};

function formToConfig(f: WidgetFormState): Record<string, unknown> {
  switch (f.type) {
    case "kpi": return { metric: f.metric, source: f.source };
    case "timeseries": return { metric: f.metric, source: f.source === "combined" ? "meta" : f.source };
    case "table": return { kind: f.kind, source: f.source === "combined" ? "google" : f.source, limit: f.limit };
    case "top_creatives": return { limit: f.limit };
    case "pacing": return {};
    case "text": return { markdown: f.markdown };
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
    kind: String(c.kind ?? "campaigns"),
    limit: Number(c.limit ?? 10),
    markdown: String(c.markdown ?? ""),
  };
}

export function WidgetForm({
  dashboardId, widget, onDone, onCancel,
}: {
  dashboardId: string;
  widget: ResolvedWidget | null; // null = creating
  onDone: () => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState<WidgetFormState>(widget ? widgetToForm(widget) : emptyForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<WidgetFormState>) => setForm((f) => ({ ...f, ...patch }));

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
          body: JSON.stringify(payload),
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
        {form.type === "kpi" && (
          <select value={form.source} onChange={(e) => set({ source: e.target.value })} className={inputCls}>
            <option value="meta">Meta</option>
            <option value="google">Google</option>
            <option value="combined">Meta + Google</option>
          </select>
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
        {(form.type === "table" || form.type === "top_creatives") && (
          <input
            type="number" min={1} max={form.type === "table" ? 30 : 10}
            value={form.limit}
            onChange={(e) => set({ limit: Number(e.target.value) })}
            className={inputCls + " w-20"}
            title="Nombre de lignes"
          />
        )}
      </div>
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
  dashboard: { id: string; name: string; metaAccountId: string | null; googleCustomerId: string | null };
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
        Les comptes doivent figurer dans l&apos;ACL du client — sinon les widgets afficheront « compte non autorisé ».
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

export function EditControls({
  dashboardId, widget, orderedIds, onChanged, onEdit,
}: {
  dashboardId: string;
  widget: ResolvedWidget;
  orderedIds: string[];
  onChanged: () => void;
  onEdit: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const idx = orderedIds.indexOf(widget.id);

  async function move(dir: -1 | 1) {
    const target = idx + dir;
    if (target < 0 || target >= orderedIds.length) return;
    const next = [...orderedIds];
    [next[idx], next[target]] = [next[target], next[idx]];
    setBusy(true);
    await fetch(`/api/dashboards/${dashboardId}/widgets`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ order: next }),
    });
    setBusy(false);
    onChanged();
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
