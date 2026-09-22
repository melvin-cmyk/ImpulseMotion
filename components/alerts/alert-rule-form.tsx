"use client";

import { useState } from "react";

/**
 * Shared model + form pieces for alert rules (admin & /me pages).
 * Contract: AlertRule carries level / filter / mode / prompt / label on top of
 * the historical metric / condition / threshold / window. Rules created before
 * that contract have none of these fields → treated as account-level "rule".
 */

export type AlertLevel = "account" | "campaign" | "adset" | "ad";
export type AlertMode = "rule" | "ai";
export type AlertFilter = { nameContains?: string; minSpend?: number };

/** Fields any rule row (GET) may carry — old rows have the optional ones missing. */
export type AlertRuleExt = {
  metric: string;
  condition: string;
  threshold: number;
  window: string;
  level?: string | null;
  mode?: string | null;
  prompt?: string | null;
  label?: string | null;
  filter?: AlertFilter | null;
  filterJson?: string | null;
};

export const LEVELS: { value: AlertLevel; label: string }[] = [
  { value: "account", label: "Compte entier" },
  { value: "campaign", label: "Campagne" },
  { value: "adset", label: "Ad set" },
  { value: "ad", label: "Créa" },
];
export const LEVEL_LABEL: Record<AlertLevel, string> = Object.fromEntries(LEVELS.map((l) => [l.value, l.label])) as Record<AlertLevel, string>;

export const METRICS = [
  { value: "roas", label: "ROAS" },
  { value: "cpa", label: "CPA" },
  { value: "ctr", label: "CTR" },
  { value: "spend", label: "Dépenses" },
  { value: "frequency", label: "Fréquence" },
];
export const CONDITIONS = [
  { value: "below", label: "en dessous de" },
  { value: "above", label: "au-dessus de" },
  { value: "drop_pct", label: "chute > x% vs période précédente" },
];
export const WINDOWS = [
  { value: "1d", label: "Hier" },
  { value: "7d", label: "7 derniers jours" },
  { value: "14d", label: "14 derniers jours" },
  { value: "30d", label: "30 derniers jours" },
];

export function ruleLevel(r: AlertRuleExt): AlertLevel {
  return (LEVELS.some((l) => l.value === r.level) ? r.level : "account") as AlertLevel;
}
export function ruleMode(r: AlertRuleExt): AlertMode {
  return r.mode === "ai" ? "ai" : "rule";
}
export function ruleFilter(r: AlertRuleExt): AlertFilter {
  if (r.filter && typeof r.filter === "object") return r.filter;
  if (r.filterJson) {
    try {
      const parsed = JSON.parse(r.filterJson);
      if (parsed && typeof parsed === "object") return parsed as AlertFilter;
    } catch {
      /* ignore malformed filter */
    }
  }
  return {};
}
export function filterSummary(f: AlertFilter): string | null {
  const parts: string[] = [];
  if (f.nameContains) parts.push(`nom contient "${f.nameContains}"`);
  if (typeof f.minSpend === "number" && f.minSpend > 0) parts.push(`dépense ≥ ${f.minSpend} €`);
  return parts.length ? parts.join(" · ") : null;
}
export function metricLabel(metric: string): string {
  return METRICS.find((m) => m.value === metric)?.label ?? metric;
}
/** Display name of a rule: its label, else the metric label (historical behaviour). */
export function ruleTitle(r: AlertRuleExt): string {
  const label = r.label?.trim();
  if (label) return label;
  return ruleMode(r) === "ai" ? "Alerte IA" : metricLabel(r.metric);
}

// ---------------------------------------------------------------------------
// Compose (POST /api/alerts/compose)
// ---------------------------------------------------------------------------

export type ComposeProposal =
  | {
      mode: "rule";
      label?: string | null;
      level?: AlertLevel;
      metric: string;
      condition: string;
      threshold: number;
      window?: string;
      filter?: AlertFilter | null;
      explanation?: string;
    }
  | {
      mode: "ai";
      label?: string | null;
      prompt: string;
      level?: AlertLevel;
      window?: string;
      explanation?: string;
    };

// ---------------------------------------------------------------------------
// Draft state shared by both create forms
// ---------------------------------------------------------------------------

export type AlertDraft = {
  /** Free text typed in « Décris ton alerte ». */
  description: string;
  mode: AlertMode;
  level: AlertLevel;
  metric: string;
  condition: string;
  /** Kept as a string so an empty / partial input never turns into NaN. */
  threshold: string;
  window: string;
  nameContains: string;
  minSpend: string;
  label: string;
  /** Condition evaluated by the AI (mode ai); also stored for rule mode as the original wording. */
  prompt: string;
  slack: string;
  emails: string;
};

export const EMPTY_DRAFT: AlertDraft = {
  description: "",
  mode: "rule",
  level: "account",
  metric: "roas",
  condition: "below",
  threshold: "2",
  window: "7d",
  nameContains: "",
  minSpend: "",
  label: "",
  prompt: "",
  slack: "",
  emails: "",
};

/** Fill the draft from an AI proposal; the consultant can still edit everything afterwards. */
export function applyProposal(d: AlertDraft, p: ComposeProposal, text: string): AlertDraft {
  const level = p.level && LEVELS.some((l) => l.value === p.level) ? p.level : d.level;
  const window = p.window && WINDOWS.some((w) => w.value === p.window) ? p.window : d.window;
  const label = p.label?.trim() ?? d.label;
  if (p.mode === "ai") {
    return { ...d, mode: "ai", level, window, label, prompt: p.prompt?.trim() || text.trim() };
  }
  return {
    ...d,
    mode: "rule",
    level,
    window,
    label,
    metric: METRICS.some((m) => m.value === p.metric) ? p.metric : d.metric,
    condition: CONDITIONS.some((c) => c.value === p.condition) ? p.condition : d.condition,
    threshold: typeof p.threshold === "number" && Number.isFinite(p.threshold) ? String(p.threshold) : d.threshold,
    nameContains: p.filter?.nameContains ?? "",
    minSpend: typeof p.filter?.minSpend === "number" ? String(p.filter.minSpend) : "",
    prompt: text.trim(),
  };
}

/**
 * Body fields shared by POST /api/admin/alerts and /api/me/alerts. The caller
 * adds userId / clientId. In AI mode metric/condition/threshold are omitted.
 */
export function draftToBody(d: AlertDraft): Record<string, unknown> {
  const minSpend = d.minSpend.trim() === "" ? NaN : Number(d.minSpend);
  const base: Record<string, unknown> = {
    platform: "meta",
    level: d.level,
    filter: {
      nameContains: d.nameContains.trim() || undefined,
      minSpend: Number.isFinite(minSpend) && minSpend > 0 ? minSpend : undefined,
    },
    mode: d.mode,
    prompt: d.prompt.trim() || null,
    label: d.label.trim() || null,
    window: d.window,
    notify: { slackChannel: d.slack.trim() || undefined, emails: d.emails.trim() || undefined },
  };
  if (d.mode === "ai") return base;
  return { ...base, metric: d.metric, condition: d.condition, threshold: Number(d.threshold) };
}

// ---------------------------------------------------------------------------
// UI pieces — styling injected by each page (admin: surface tokens, me: inline)
// ---------------------------------------------------------------------------

export type FieldClasses = { input: string; label: string };

type ComposeBlockProps = {
  text: string;
  onTextChange: (text: string) => void;
  accountId: string | null;
  onProposal: (proposal: ComposeProposal, text: string) => void;
  classes: FieldClasses;
};

export function ComposeBlock({ text, onTextChange, accountId, onProposal, classes }: ComposeBlockProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [explanation, setExplanation] = useState<string | null>(null);

  async function compose() {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    setExplanation(null);
    try {
      const res = await fetch("/api/alerts/compose", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: trimmed, accountId: accountId || null }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.proposal) {
        throw new Error(data?.error ?? `L'IA n'a pas pu proposer d'alerte (erreur ${res.status})`);
      }
      const proposal = data.proposal as ComposeProposal;
      onProposal(proposal, trimmed);
      setExplanation(proposal.explanation?.trim() || null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Proposition impossible");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-xl border border-violet-500/30 bg-violet-500/5 p-3 space-y-2">
      <label className="block">
        <span className={`${classes.label} font-semibold`}>Décris ton alerte</span>
        <textarea
          value={text}
          onChange={(e) => onTextChange(e.target.value)}
          rows={2}
          placeholder="Ex. : préviens-moi si une créa Meta dépense plus de 200 € sur 7 jours avec un CPA au-dessus de 30 €"
          className={`${classes.input} resize-y`}
        />
      </label>
      <div className="flex items-center gap-3 flex-wrap">
        <button
          type="button"
          onClick={compose}
          disabled={busy || !text.trim()}
          className="px-3 py-1.5 rounded-lg text-sm font-medium bg-violet-500/15 hover:bg-violet-500/25 text-violet-300 border border-violet-500/30 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {busy ? "L'IA lit ta demande…" : "Proposer avec l'IA"}
        </button>
        <span className="text-xs text-gray-500">Les champs ci-dessous sont pré-remplis — tu peux tout ajuster avant de créer.</span>
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
      {explanation && (
        <p className="text-xs text-violet-300 bg-violet-500/10 border border-violet-500/20 rounded-lg px-3 py-2">
          <span className="font-semibold">L&apos;IA propose :</span> {explanation}
        </p>
      )}
    </div>
  );
}

type AlertRuleFieldsProps = {
  draft: AlertDraft;
  onChange: (patch: Partial<AlertDraft>) => void;
  classes: FieldClasses;
};

/**
 * Every rule field except the account/user pickers, rendered as children of
 * the page's 2-column grid (fragment → each label is a grid item).
 */
export function AlertRuleFields({ draft, onChange, classes }: AlertRuleFieldsProps) {
  const ai = draft.mode === "ai";
  const switchBtn = (active: boolean) =>
    `px-3 py-1.5 text-sm font-medium transition-colors ${active ? "bg-violet-600 text-white" : "bg-transparent text-gray-400 hover:text-white"}`;

  function setMode(mode: AlertMode) {
    if (mode === draft.mode) return;
    // Entering AI mode: the free-text description becomes the evaluated condition.
    onChange(mode === "ai" && !draft.prompt.trim() ? { mode, prompt: draft.description.trim() } : { mode });
  }

  return (
    <>
      <div className="col-span-2 flex items-center gap-3 flex-wrap">
        <span className={classes.label}>Type d&apos;alerte</span>
        <div className="inline-flex rounded-lg border border-gray-800 overflow-hidden">
          <button type="button" onClick={() => setMode("rule")} className={switchBtn(!ai)} aria-pressed={!ai}>
            Règle classique
          </button>
          <button type="button" onClick={() => setMode("ai")} className={switchBtn(ai)} aria-pressed={ai}>
            Alerte IA
          </button>
        </div>
        {ai && <span className="text-xs text-gray-500">~1 appel IA léger par jour</span>}
      </div>

      <label className="block">
        <span className={classes.label}>Nom de l&apos;alerte (optionnel)</span>
        <input
          type="text"
          value={draft.label}
          onChange={(e) => onChange({ label: e.target.value })}
          placeholder="Ex. : CPA créas UGC"
          maxLength={80}
          className={classes.input}
        />
      </label>
      <label className="block">
        <span className={classes.label}>Niveau</span>
        <select value={draft.level} onChange={(e) => onChange({ level: e.target.value as AlertLevel })} className={classes.input}>
          {LEVELS.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
        </select>
      </label>

      {ai ? (
        <label className="block col-span-2">
          <span className={classes.label}>Condition évaluée chaque matin par l&apos;IA</span>
          <textarea
            value={draft.prompt}
            onChange={(e) => onChange({ prompt: e.target.value })}
            rows={3}
            required
            placeholder="Ex. : signale les créas dont le CPA dépasse 30 € alors qu'elles ont dépensé plus de 200 €"
            className={`${classes.input} resize-y`}
          />
          <span className="text-[11px] text-gray-500">L&apos;IA lit les données de la fenêtre choisie au niveau sélectionné et décide si l&apos;alerte doit partir. ~1 appel IA léger par jour.</span>
        </label>
      ) : (
        <>
          <label className="block">
            <span className={classes.label}>Métrique</span>
            <select value={draft.metric} onChange={(e) => onChange({ metric: e.target.value })} className={classes.input}>
              {METRICS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
          </label>
          <label className="block">
            <span className={classes.label}>Condition</span>
            <select value={draft.condition} onChange={(e) => onChange({ condition: e.target.value })} className={classes.input}>
              {CONDITIONS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
          </label>
          <label className="block">
            <span className={classes.label}>Seuil</span>
            <input
              type="number"
              step="0.1"
              value={draft.threshold}
              onChange={(e) => onChange({ threshold: e.target.value })}
              required
              className={classes.input}
            />
          </label>
        </>
      )}

      <label className="block">
        <span className={classes.label}>Fenêtre</span>
        <select value={draft.window} onChange={(e) => onChange({ window: e.target.value })} className={classes.input}>
          {WINDOWS.map((w) => <option key={w.value} value={w.value}>{w.label}</option>)}
        </select>
      </label>

      <label className="block">
        <span className={classes.label}>Filtre sur le nom (optionnel)</span>
        <input
          type="text"
          value={draft.nameContains}
          onChange={(e) => onChange({ nameContains: e.target.value })}
          placeholder="contient… (ex. UGC)"
          className={classes.input}
        />
      </label>
      <label className="block">
        <span className={classes.label}>Dépense minimum (optionnel)</span>
        <input
          type="number"
          min={0}
          step="1"
          value={draft.minSpend}
          onChange={(e) => onChange({ minSpend: e.target.value })}
          placeholder="ignore les éléments sous ce montant (€)"
          className={classes.input}
        />
      </label>

      <label className="block">
        <span className={classes.label}>Canal Slack (optionnel)</span>
        <input type="text" value={draft.slack} onChange={(e) => onChange({ slack: e.target.value })} placeholder="#alertes-client" className={classes.input} />
      </label>
      <label className="block">
        <span className={classes.label}>E-mails (optionnel)</span>
        <input type="text" value={draft.emails} onChange={(e) => onChange({ emails: e.target.value })} placeholder="prenom@impulse-analytics.com, …" className={classes.input} />
      </label>
    </>
  );
}
