"use client";

/**
 * /dashboards/catalogue — « Métriques & dimensions » des dashboards du staff.
 *
 * Le catalogue de l'équipe (partagé par tous) : des métriques (formule sur les
 * champs d'une ligne, format) et des dimensions (champ lu tel quel, groupe
 * d'expression régulière, classement par motifs). Les pages les utilisent via
 * dash.metric / dash.dimension / dash.rollup, le copilote les connaît.
 * En bas, la référence des champs que les connecteurs renvoient.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, BookOpen, Check, Loader2, Pencil, Plus, Ruler, Tags, Trash2, X } from "lucide-react";
import { Card, PageHeader, Pill, Section } from "@/components/ui/surface";
import { FIELD, MONO_FIELD, PRIMARY_BUTTON, SECONDARY_BUTTON, SMALL_BUTTON, apiErrorText } from "@/components/staff-dashboards/model";
import { invalidateFrameCatalog } from "@/components/staff-dashboards/dash-frame";
import {
  CATALOG_PLATFORMS, CATALOG_PLATFORM_LABELS, DIMENSION_KINDS, DIMENSION_KIND_LABELS, METRIC_FORMATS, METRIC_FORMAT_LABELS,
  type CatalogPlatform, type DimensionKind, type DimensionRule, type MetricFormat, type StaffDimensionDef, type StaffMetricDef,
} from "@/lib/staff-dashboards/catalog-types";
import DashCatalog from "@/public/dash-catalog.js";

interface ReferenceField { name: string; label: string; kind: "metric" | "dimension"; note?: string }
interface ReferencePlatform { platform: string; title: string; tool: string; fields: ReferenceField[] }

const SELECT = `${FIELD} w-auto`;
const LABEL = "block text-[11px] uppercase tracking-wider text-gray-500 mb-1";

type MetricForm = { key: string; label: string; description: string; platform: CatalogPlatform; formula: string; format: MetricFormat; unit: string };
type MappingLine = { match: string; value: string; regex: boolean };
type DimensionForm = { key: string; label: string; description: string; platform: CatalogPlatform; field: string; kind: DimensionKind; pattern: string; group: string; values: MappingLine[]; fallback: string };

const EMPTY_METRIC: MetricForm = { key: "", label: "", description: "", platform: "any", formula: "", format: "number", unit: "" };
const EMPTY_DIMENSION: DimensionForm = { key: "", label: "", description: "", platform: "any", field: "", kind: "field", pattern: "", group: "1", values: [{ match: "", value: "", regex: false }], fallback: "Autre" };

function metricToForm(m: StaffMetricDef): MetricForm {
  return { key: m.key, label: m.label, description: m.description, platform: m.platform, formula: m.formula, format: m.format, unit: m.unit ?? "" };
}
function dimensionToForm(d: StaffDimensionDef): DimensionForm {
  return {
    key: d.key, label: d.label, description: d.description, platform: d.platform, field: d.field, kind: d.kind,
    pattern: d.rule.pattern ?? "", group: String(d.rule.group ?? 1),
    values: (d.rule.values?.length ? d.rule.values : [{ match: "", value: "" }]).map((v) => ({ match: v.match, value: v.value, regex: !!v.regex })),
    fallback: d.rule.fallback ?? "Autre",
  };
}
function dimensionRule(f: DimensionForm): DimensionRule {
  const rule: DimensionRule = { fallback: f.fallback.trim() || "Autre" };
  if (f.kind === "regex") { rule.pattern = f.pattern; rule.group = Number(f.group) || 1; }
  if (f.kind === "mapping") rule.values = f.values.filter((v) => v.match.trim() || v.value.trim()).map((v) => ({ match: v.match, value: v.value, ...(v.regex ? { regex: true } : {}) }));
  return rule;
}

/** Sample row the consultant can paste to try a formula or a rule (JSON). */
const SAMPLE_ROW = '{ "campaign_name": "FR - [PUR] Search", "spend": 1250.5, "impressions": 48000, "clicks": 960, "actions": [{ "action_type": "purchase", "value": "32" }] }';

function parseSample(text: string): unknown {
  try { return JSON.parse(text); } catch { return null; }
}

export default function CataloguePage() {
  const [metrics, setMetrics] = useState<StaffMetricDef[] | null>(null);
  const [dimensions, setDimensions] = useState<StaffDimensionDef[] | null>(null);
  const [reference, setReference] = useState<ReferencePlatform[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [sample, setSample] = useState(SAMPLE_ROW);
  const sampleRow = useMemo(() => parseSample(sample), [sample]);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/staff-dashboards/catalog", { cache: "no-store" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(apiErrorText(body, res.status));
      setMetrics(Array.isArray(body.metrics) ? body.metrics : []);
      setDimensions(Array.isArray(body.dimensions) ? body.dimensions : []);
      setReference(Array.isArray(body.reference) ? body.reference : []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erreur");
    }
  }, []);
  useEffect(() => { const t = setTimeout(() => { void load(); }, 0); return () => clearTimeout(t); }, [load]);

  const changed = useCallback(() => { invalidateFrameCatalog(); void load(); }, [load]);

  return (
    <div className="p-4 sm:p-6 max-w-6xl mx-auto space-y-6">
      <div className="flex flex-col gap-3">
        <Link href="/dashboards" className="inline-flex items-center gap-1.5 text-xs text-gray-400 hover:text-white w-fit"><ArrowLeft className="w-3.5 h-3.5" /> Mes dashboards</Link>
        <PageHeader
          title="Métriques & dimensions"
          subtitle="Le catalogue de l'équipe : des métriques (une formule sur les champs d'une ligne) et des dimensions (un champ, un extrait ou un classement). Les dashboards les utilisent avec dash.metric, dash.dimension et dash.rollup ; le copilote IA les connaît et s'en sert quand vous les nommez."
        />
      </div>

      {error && (
        <Card padded className="border-red-900/40">
          <p className="text-sm text-red-400">Le catalogue n&apos;a pas pu être chargé ({error}).</p>
          <button type="button" onClick={() => void load()} className="mt-2 text-xs underline text-gray-300">Réessayer</button>
        </Card>
      )}

      <Card padded className="bg-gray-950/50">
        <label className={LABEL}>Ligne d&apos;essai (JSON) — sert à tester une formule ou une règle avant de l&apos;enregistrer</label>
        <textarea value={sample} onChange={(e) => setSample(e.target.value)} rows={2} className={MONO_FIELD} spellCheck={false} />
        {sampleRow === null && <p className="text-[11px] text-amber-400 mt-1">JSON illisible : les essais sont désactivés.</p>}
      </Card>

      <MetricsSection metrics={metrics} sampleRow={sampleRow} onChanged={changed} />
      <DimensionsSection dimensions={dimensions} sampleRow={sampleRow} onChanged={changed} />
      <ReferenceSection reference={reference} />
    </div>
  );
}

// ── Métriques ───────────────────────────────────────────────────────────────

function MetricsSection({ metrics, sampleRow, onChanged }: { metrics: StaffMetricDef[] | null; sampleRow: unknown; onChanged: () => void }) {
  const [editing, setEditing] = useState<"new" | string | null>(null);
  return (
    <Section title="Métriques" icon={<Ruler className="w-4 h-4 text-violet-400" />} action={<button type="button" onClick={() => setEditing("new")} className={PRIMARY_BUTTON}><Plus className="w-4 h-4" /> Nouvelle métrique</button>}>
      <div className="space-y-3">
        {editing === "new" && <MetricEditor initial={EMPTY_METRIC} sampleRow={sampleRow} onCancel={() => setEditing(null)} onSaved={() => { setEditing(null); onChanged(); }} />}
        {metrics === null && <div className="flex items-center gap-2 text-gray-500 text-sm"><Loader2 className="w-4 h-4 animate-spin" /> Chargement…</div>}
        {metrics?.length === 0 && editing !== "new" && (
          <p className="text-sm text-gray-500">Aucune métrique pour l&apos;instant. Exemple : clé <code className="text-gray-300">cpa</code>, formule <code className="text-gray-300">spend / actions.purchase</code>, format Montant.</p>
        )}
        {metrics?.map((m) => (
          editing === m.id
            ? <MetricEditor key={m.id} id={m.id} initial={metricToForm(m)} sampleRow={sampleRow} onCancel={() => setEditing(null)} onSaved={() => { setEditing(null); onChanged(); }} />
            : <MetricRow key={m.id} metric={m} sampleRow={sampleRow} onEdit={() => setEditing(m.id)} onDeleted={onChanged} />
        ))}
      </div>
    </Section>
  );
}

function MetricRow({ metric: m, sampleRow, onEdit, onDeleted }: { metric: StaffMetricDef; sampleRow: unknown; onEdit: () => void; onDeleted: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const trial = useMemo(() => {
    if (!sampleRow) return null;
    try { return DashCatalog.format(m, DashCatalog.evaluate(m.formula, sampleRow), m.unit ?? "EUR"); } catch { return null; }
  }, [m, sampleRow]);
  async function remove() {
    if (!window.confirm(`Supprimer la métrique « ${m.label} » (${m.key}) ? Les pages qui l'utilisent afficheront une erreur.`)) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/staff-dashboards/catalog/metrics/${encodeURIComponent(m.id)}`, { method: "DELETE" });
      if (!res.ok) throw new Error(apiErrorText(await res.json().catch(() => ({})), res.status));
      onDeleted();
    } catch (e) { setErr(e instanceof Error ? e.message : "Erreur"); setBusy(false); }
  }
  return (
    <div className="rounded-xl border border-gray-800 bg-gray-950/40 px-4 py-3">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-white">{m.label}</span>
            <code className="text-xs text-violet-300 bg-violet-950/40 px-1.5 py-0.5 rounded">{m.key}</code>
            <Pill>{CATALOG_PLATFORM_LABELS[m.platform]}</Pill>
            <Pill>{METRIC_FORMAT_LABELS[m.format]}{m.unit ? ` ${m.unit}` : ""}</Pill>
          </div>
          <code className="block text-xs text-gray-300 mt-1.5 font-mono break-all">{m.formula}</code>
          {m.description && <p className="text-xs text-gray-500 mt-1">{m.description}</p>}
          <p className="text-[11px] text-gray-600 mt-1">
            Champs lus : {m.fields.join(", ")}{trial !== null ? <> · sur la ligne d&apos;essai : <span className="text-gray-300">{trial}</span></> : null}
            {m.ownerEmail ? ` · par ${m.ownerEmail}` : ""}
          </p>
          {err && <p className="text-xs text-red-400 mt-1">{err}</p>}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <button type="button" onClick={onEdit} className={`${SMALL_BUTTON} bg-gray-800 hover:bg-gray-700 text-gray-200`}><Pencil className="w-3.5 h-3.5" /> Modifier</button>
          <button type="button" onClick={() => void remove()} disabled={busy} className={`${SMALL_BUTTON} bg-gray-900 hover:bg-red-950 text-gray-400 hover:text-red-300 border border-gray-800`}><Trash2 className="w-3.5 h-3.5" /></button>
        </div>
      </div>
    </div>
  );
}

function MetricEditor({ id, initial, sampleRow, onCancel, onSaved }: { id?: string; initial: MetricForm; sampleRow: unknown; onCancel: () => void; onSaved: () => void }) {
  const [f, setF] = useState<MetricForm>(initial);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = (patch: Partial<MetricForm>) => setF((p) => ({ ...p, ...patch }));
  const check = useMemo(() => (f.formula.trim() ? DashCatalog.validateFormula(f.formula) : null), [f.formula]);
  const trial = useMemo(() => {
    if (!check?.ok || !sampleRow) return null;
    try { return DashCatalog.format({ format: f.format, unit: f.unit || null }, DashCatalog.evaluate(f.formula, sampleRow), f.unit || "EUR"); } catch { return null; }
  }, [check, f.formula, f.format, f.unit, sampleRow]);

  async function save() {
    setBusy(true); setErr(null);
    try {
      const res = await fetch(id ? `/api/staff-dashboards/catalog/metrics/${encodeURIComponent(id)}` : "/api/staff-dashboards/catalog/metrics", {
        method: id ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...f, unit: f.unit || null }),
      });
      if (!res.ok) throw new Error(apiErrorText(await res.json().catch(() => ({})), res.status));
      onSaved();
    } catch (e) { setErr(e instanceof Error ? e.message : "Erreur"); setBusy(false); }
  }

  return (
    <div className="rounded-xl border border-violet-800/60 bg-gray-950/60 px-4 py-4 space-y-3">
      <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto_auto_auto]">
        <div><label className={LABEL}>Clé (dans les pages)</label><input value={f.key} onChange={(e) => set({ key: e.target.value.toLowerCase() })} placeholder="cpa" className={MONO_FIELD} disabled={!!id} /></div>
        <div><label className={LABEL}>Libellé</label><input value={f.label} onChange={(e) => set({ label: e.target.value })} placeholder="Coût par achat" className={FIELD} /></div>
        <div><label className={LABEL}>Plateforme</label>
          <select value={f.platform} onChange={(e) => set({ platform: e.target.value as CatalogPlatform })} className={SELECT}>{CATALOG_PLATFORMS.map((p) => <option key={p} value={p}>{CATALOG_PLATFORM_LABELS[p]}</option>)}</select></div>
        <div><label className={LABEL}>Format</label>
          <select value={f.format} onChange={(e) => set({ format: e.target.value as MetricFormat })} className={SELECT}>{METRIC_FORMATS.map((p) => <option key={p} value={p}>{METRIC_FORMAT_LABELS[p]}</option>)}</select></div>
        <div><label className={LABEL}>Devise</label><input value={f.unit} onChange={(e) => set({ unit: e.target.value.toUpperCase() })} placeholder="EUR" maxLength={3} className={`${MONO_FIELD} w-20`} disabled={f.format !== "currency"} /></div>
      </div>
      <div>
        <label className={LABEL}>Formule — champs d&apos;une ligne, + − × ÷, parenthèses, abs, min, max, round(x, n), coalesce, pct(a, b), div(a, b) ; division par zéro = 0</label>
        <input value={f.formula} onChange={(e) => set({ formula: e.target.value })} placeholder="spend / actions.purchase" className={MONO_FIELD} spellCheck={false} />
        {check && !check.ok && <p className="text-xs text-amber-400 mt-1">{check.error}</p>}
        {check?.ok && <p className="text-[11px] text-gray-500 mt-1">Champs lus : {check.fields.join(", ")}{trial !== null ? <> · sur la ligne d&apos;essai : <span className="text-gray-200">{trial}</span></> : null}</p>}
      </div>
      <div><label className={LABEL}>Description (facultative, lue par le copilote)</label><input value={f.description} onChange={(e) => set({ description: e.target.value })} placeholder="Dépense divisée par les achats attribués (fenêtre 7 j clic / 1 j vue)" className={FIELD} /></div>
      {err && <p className="text-xs text-red-400">{err}</p>}
      <div className="flex items-center gap-2">
        <button type="button" onClick={() => void save()} disabled={busy || !f.key || !f.label || !check?.ok} className={PRIMARY_BUTTON}>{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} Enregistrer</button>
        <button type="button" onClick={onCancel} disabled={busy} className={SECONDARY_BUTTON}><X className="w-4 h-4" /> Annuler</button>
      </div>
    </div>
  );
}

// ── Dimensions ──────────────────────────────────────────────────────────────

function DimensionsSection({ dimensions, sampleRow, onChanged }: { dimensions: StaffDimensionDef[] | null; sampleRow: unknown; onChanged: () => void }) {
  const [editing, setEditing] = useState<"new" | string | null>(null);
  return (
    <Section title="Dimensions" icon={<Tags className="w-4 h-4 text-violet-400" />} action={<button type="button" onClick={() => setEditing("new")} className={PRIMARY_BUTTON}><Plus className="w-4 h-4" /> Nouvelle dimension</button>}>
      <div className="space-y-3">
        {editing === "new" && <DimensionEditor initial={EMPTY_DIMENSION} sampleRow={sampleRow} onCancel={() => setEditing(null)} onSaved={() => { setEditing(null); onChanged(); }} />}
        {dimensions === null && <div className="flex items-center gap-2 text-gray-500 text-sm"><Loader2 className="w-4 h-4 animate-spin" /> Chargement…</div>}
        {dimensions?.length === 0 && editing !== "new" && (
          <p className="text-sm text-gray-500">Aucune dimension pour l&apos;instant. Exemple : clé <code className="text-gray-300">verticale</code>, champ <code className="text-gray-300">campaign_name</code>, extrait par l&apos;expression <code className="text-gray-300">\[([A-Z]+)\]</code>.</p>
        )}
        {dimensions?.map((d) => (
          editing === d.id
            ? <DimensionEditor key={d.id} id={d.id} initial={dimensionToForm(d)} sampleRow={sampleRow} onCancel={() => setEditing(null)} onSaved={() => { setEditing(null); onChanged(); }} />
            : <DimensionRow key={d.id} dimension={d} sampleRow={sampleRow} onEdit={() => setEditing(d.id)} onDeleted={onChanged} />
        ))}
      </div>
    </Section>
  );
}

function describeRule(d: Pick<StaffDimensionDef, "field" | "kind" | "rule">): string {
  if (d.kind === "regex") return `groupe ${d.rule.group ?? 1} de /${d.rule.pattern}/ sur ${d.field}`;
  if (d.kind === "mapping") return `${d.field} classé : ${(d.rule.values ?? []).map((v) => `${v.regex ? `/${v.match}/` : `« ${v.match} »`} → ${v.value}`).join(", ")}`;
  return `valeur de ${d.field}`;
}

function DimensionRow({ dimension: d, sampleRow, onEdit, onDeleted }: { dimension: StaffDimensionDef; sampleRow: unknown; onEdit: () => void; onDeleted: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const trial = useMemo(() => { if (!sampleRow) return null; try { return DashCatalog.derive(d, sampleRow); } catch { return null; } }, [d, sampleRow]);
  async function remove() {
    if (!window.confirm(`Supprimer la dimension « ${d.label} » (${d.key}) ? Les pages qui l'utilisent afficheront une erreur.`)) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/staff-dashboards/catalog/dimensions/${encodeURIComponent(d.id)}`, { method: "DELETE" });
      if (!res.ok) throw new Error(apiErrorText(await res.json().catch(() => ({})), res.status));
      onDeleted();
    } catch (e) { setErr(e instanceof Error ? e.message : "Erreur"); setBusy(false); }
  }
  return (
    <div className="rounded-xl border border-gray-800 bg-gray-950/40 px-4 py-3">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-white">{d.label}</span>
            <code className="text-xs text-violet-300 bg-violet-950/40 px-1.5 py-0.5 rounded">{d.key}</code>
            <Pill>{CATALOG_PLATFORM_LABELS[d.platform]}</Pill>
            <Pill>{DIMENSION_KIND_LABELS[d.kind]}</Pill>
          </div>
          <p className="text-xs text-gray-300 mt-1.5 font-mono break-all">{describeRule(d)}{d.rule.fallback ? ` · sinon « ${d.rule.fallback} »` : ""}</p>
          {d.description && <p className="text-xs text-gray-500 mt-1">{d.description}</p>}
          <p className="text-[11px] text-gray-600 mt-1">{trial !== null ? <>Sur la ligne d&apos;essai : <span className="text-gray-300">{trial}</span></> : null}{d.ownerEmail ? ` · par ${d.ownerEmail}` : ""}</p>
          {err && <p className="text-xs text-red-400 mt-1">{err}</p>}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <button type="button" onClick={onEdit} className={`${SMALL_BUTTON} bg-gray-800 hover:bg-gray-700 text-gray-200`}><Pencil className="w-3.5 h-3.5" /> Modifier</button>
          <button type="button" onClick={() => void remove()} disabled={busy} className={`${SMALL_BUTTON} bg-gray-900 hover:bg-red-950 text-gray-400 hover:text-red-300 border border-gray-800`}><Trash2 className="w-3.5 h-3.5" /></button>
        </div>
      </div>
    </div>
  );
}

function DimensionEditor({ id, initial, sampleRow, onCancel, onSaved }: { id?: string; initial: DimensionForm; sampleRow: unknown; onCancel: () => void; onSaved: () => void }) {
  const [f, setF] = useState<DimensionForm>(initial);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = (patch: Partial<DimensionForm>) => setF((p) => ({ ...p, ...patch }));
  const def = useMemo(() => ({ field: f.field, kind: f.kind, rule: dimensionRule(f) }), [f]);
  const check = useMemo(() => (f.field.trim() ? DashCatalog.validateDimension(def) : null), [def, f.field]);
  const trial = useMemo(() => { if (!check?.ok || !sampleRow) return null; try { return DashCatalog.derive(def, sampleRow); } catch { return null; } }, [check, def, sampleRow]);
  const setLine = (i: number, patch: Partial<MappingLine>) => set({ values: f.values.map((v, j) => (j === i ? { ...v, ...patch } : v)) });

  async function save() {
    setBusy(true); setErr(null);
    try {
      const res = await fetch(id ? `/api/staff-dashboards/catalog/dimensions/${encodeURIComponent(id)}` : "/api/staff-dashboards/catalog/dimensions", {
        method: id ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: f.key, label: f.label, description: f.description, platform: f.platform, field: f.field, kind: f.kind, rule: dimensionRule(f) }),
      });
      if (!res.ok) throw new Error(apiErrorText(await res.json().catch(() => ({})), res.status));
      onSaved();
    } catch (e) { setErr(e instanceof Error ? e.message : "Erreur"); setBusy(false); }
  }

  return (
    <div className="rounded-xl border border-violet-800/60 bg-gray-950/60 px-4 py-4 space-y-3">
      <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto]">
        <div><label className={LABEL}>Clé (dans les pages)</label><input value={f.key} onChange={(e) => set({ key: e.target.value.toLowerCase() })} placeholder="verticale" className={MONO_FIELD} disabled={!!id} /></div>
        <div><label className={LABEL}>Libellé</label><input value={f.label} onChange={(e) => set({ label: e.target.value })} placeholder="Verticale" className={FIELD} /></div>
        <div><label className={LABEL}>Plateforme</label>
          <select value={f.platform} onChange={(e) => set({ platform: e.target.value as CatalogPlatform })} className={SELECT}>{CATALOG_PLATFORMS.map((p) => <option key={p} value={p}>{CATALOG_PLATFORM_LABELS[p]}</option>)}</select></div>
      </div>
      <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
        <div><label className={LABEL}>Champ source (chemin dans une ligne)</label><input value={f.field} onChange={(e) => set({ field: e.target.value })} placeholder="campaign.name" className={MONO_FIELD} spellCheck={false} /></div>
        <div><label className={LABEL}>Type</label>
          <select value={f.kind} onChange={(e) => set({ kind: e.target.value as DimensionKind })} className={SELECT}>{DIMENSION_KINDS.map((k) => <option key={k} value={k}>{DIMENSION_KIND_LABELS[k]}</option>)}</select></div>
      </div>
      {f.kind === "regex" && (
        <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
          <div><label className={LABEL}>Expression régulière (insensible à la casse) — le groupe capturé devient la valeur</label><input value={f.pattern} onChange={(e) => set({ pattern: e.target.value })} placeholder="\[([A-Z]+)\]" className={MONO_FIELD} spellCheck={false} /></div>
          <div><label className={LABEL}>Groupe</label><input value={f.group} onChange={(e) => set({ group: e.target.value })} className={`${MONO_FIELD} w-16`} inputMode="numeric" /></div>
        </div>
      )}
      {f.kind === "mapping" && (
        <div className="space-y-2">
          <label className={LABEL}>Motifs (contenu, ou expression régulière) → valeur ; le premier qui correspond gagne</label>
          {f.values.map((v, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2">
              <input value={v.match} onChange={(e) => setLine(i, { match: e.target.value })} placeholder="brand" className={`${MONO_FIELD} flex-1 min-w-[10rem]`} spellCheck={false} />
              <span className="text-gray-500">→</span>
              <input value={v.value} onChange={(e) => setLine(i, { value: e.target.value })} placeholder="Marque" className={`${FIELD} flex-1 min-w-[10rem]`} />
              <label className="inline-flex items-center gap-1 text-[11px] text-gray-400"><input type="checkbox" checked={v.regex} onChange={(e) => setLine(i, { regex: e.target.checked })} /> regex</label>
              <button type="button" aria-label="Retirer" onClick={() => set({ values: f.values.filter((_, j) => j !== i) })} className="text-gray-600 hover:text-red-400"><X className="w-4 h-4" /></button>
            </div>
          ))}
          <button type="button" onClick={() => set({ values: [...f.values, { match: "", value: "", regex: false }] })} className={`${SMALL_BUTTON} bg-gray-800 hover:bg-gray-700 text-gray-200`}><Plus className="w-3.5 h-3.5" /> Ajouter un motif</button>
        </div>
      )}
      {f.kind !== "field" && <div><label className={LABEL}>Valeur quand rien ne correspond</label><input value={f.fallback} onChange={(e) => set({ fallback: e.target.value })} className={`${FIELD} sm:w-64`} /></div>}
      <div><label className={LABEL}>Description (facultative, lue par le copilote)</label><input value={f.description} onChange={(e) => set({ description: e.target.value })} placeholder="La verticale entre crochets dans le nom de campagne" className={FIELD} /></div>
      {check && !check.ok && <p className="text-xs text-amber-400">{check.error}</p>}
      {check?.ok && trial !== null && <p className="text-[11px] text-gray-500">Sur la ligne d&apos;essai : <span className="text-gray-200">{trial}</span></p>}
      {err && <p className="text-xs text-red-400">{err}</p>}
      <div className="flex items-center gap-2">
        <button type="button" onClick={() => void save()} disabled={busy || !f.key || !f.label || !check?.ok} className={PRIMARY_BUTTON}>{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} Enregistrer</button>
        <button type="button" onClick={onCancel} disabled={busy} className={SECONDARY_BUTTON}><X className="w-4 h-4" /> Annuler</button>
      </div>
    </div>
  );
}

// ── Référence ───────────────────────────────────────────────────────────────

function ReferenceSection({ reference }: { reference: ReferencePlatform[] }) {
  const [open, setOpen] = useState<string | null>(null);
  if (!reference.length) return null;
  return (
    <Section title="Référence : les champs que les connecteurs renvoient" icon={<BookOpen className="w-4 h-4 text-violet-400" />}>
      <p className="text-xs text-gray-500 mb-3">Les noms à écrire dans une formule ou comme champ source (camelCase ou snake_case indifférent ; pour Google Ads, « metrics. » peut être omis). Les outils peuvent en renvoyer d&apos;autres : le copilote lit la réponse réelle avant d&apos;écrire un jeu.</p>
      <div className="space-y-2">
        {reference.map((p) => (
          <div key={p.platform} className="rounded-xl border border-gray-800">
            <button type="button" onClick={() => setOpen(open === p.platform ? null : p.platform)} className="w-full flex items-center justify-between px-4 py-2.5 text-left">
              <span className="text-sm font-semibold text-white">{p.title}</span>
              <span className="text-[11px] text-gray-500">{p.fields.length} champs · {open === p.platform ? "replier" : "déplier"}</span>
            </button>
            {open === p.platform && (
              <div className="px-4 pb-3">
                <p className="text-[11px] text-gray-500 mb-2">{p.tool}</p>
                <table className="w-full text-xs">
                  <tbody>
                    {p.fields.map((fl) => (
                      <tr key={fl.name} className="border-t border-gray-800/80">
                        <td className="py-1.5 pr-3 font-mono text-gray-200 whitespace-nowrap">{fl.name}</td>
                        <td className="py-1.5 pr-3 text-gray-300">{fl.label}</td>
                        <td className="py-1.5 pr-3"><Pill>{fl.kind === "metric" ? "métrique" : "dimension"}</Pill></td>
                        <td className="py-1.5 text-gray-500">{fl.note ?? ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        ))}
      </div>
    </Section>
  );
}
