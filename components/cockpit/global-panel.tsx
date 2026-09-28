"use client";

/**
 * Global Cockpit — diagnostic of one client: why it is flagged, the overall
 * reading, each account, how it evolved over the previous builds, and the
 * team's follow-up (saved as it is typed).
 */

import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import type { ClientRow, PlatformRow } from "@/lib/cockpit/engine";
import type { EvolutionPoint } from "@/lib/cockpit/build";
import type { CockpitActionView } from "@/lib/cockpit/view";
import { SEVERITY_LABEL, TXT, cause, kpiText, modeLabel, money, noKpi, spendText, type MoneyOptions, type PeriodWords } from "@/lib/cockpit/display";
import { Badges, Chip, Muted, PaceGauge, SeverityBadge, Spark, Tag } from "@/components/cockpit/global-parts";

const COMPONENT: Record<string, string> = { cpm: "CPM", ctr: "CTR", cvr: "CVR", aov: "AOV" };

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-gray-800/70 py-2 text-sm first:border-t-0">
      <span className="text-xs text-gray-500">{label}</span>
      <span className="flex flex-wrap items-center justify-end gap-1.5 tabular-nums">{children}</span>
    </div>
  );
}

function PlatformBlock({ c, v, starts, o, words }: { c: ClientRow; v: PlatformRow; starts: string[]; o: MoneyOptions; words: PeriodWords }) {
  return (
    <section className="rounded-xl border border-gray-800 bg-gray-900/60 p-3">
      <h4 className="mb-1 flex flex-wrap items-center gap-1.5 text-sm font-semibold text-white">
        <Tag className={v.plat === "meta" ? "bg-blue-500/20 text-blue-300" : "bg-emerald-500/20 text-emerald-300"}>{v.plat === "meta" ? "M" : "G"}</Tag>
        {v.label}
        {c.kpi_mode === "mixte" && <Muted>· {modeLabel(v.mode)}</Muted>}
      </h4>
      {v.err ? (
        <p className="text-xs text-red-300">Compte illisible : {v.err}</p>
      ) : (
        <>
          <Row label={words.spend}>
            <b className="text-white">{money(v.spend, v.ccy, o)}</b>
            <Chip d={v.spend_d} kind="spend" label={words.base} />
            <Chip d={v.spend_d_wow} kind="spend" label={words.prev} />
          </Row>
          {v.mode === "brand" ? (
            <Row label="KPI"><Muted>{TXT.brandDetail}</Muted></Row>
          ) : (
            <Row label={v.mode === "roas" ? "ROAS" : "CPA"}>
              <b className="text-white">{kpiText(v.kpi, v.mode, v.ccy, o)}</b>
              {v.zero_conv ? <Tag className="bg-red-500/20 text-red-300">0 conv</Tag>
                : v.low_vol ? <Muted>{TXT.lowVol} · {Math.round(v.conv)} conv</Muted>
                : <><Chip d={v.kpi_d} kind="perf" label={words.base} mode={v.mode} /><Chip d={v.kpi_d_wow} kind="perf" label={words.prev} mode={v.mode} /></>}
            </Row>
          )}
          <Row label={`Funnel vs ${words.moy.toLowerCase()}`}>
            {v.diag ? Object.entries(v.diag).map(([k, d]) => {
              const bad = k === "cpm" ? d > 0.10 : d < -0.10;
              const good = k === "cpm" ? d < -0.10 : d > 0.10;
              return (
                <span key={k} className={`text-xs ${bad ? "text-red-300" : good ? "text-emerald-300" : "text-gray-400"}`}>
                  {COMPONENT[k]} {d > 0 ? "+" : ""}{Math.round(d * 100)}%
                </span>
              );
            }) : <Muted>{TXT.noData}</Muted>}
          </Row>
          <Row label="Rythme budgétaire"><PaceGauge p={v.pacing} /></Row>
          <Row label={words.spark}><Spark weeks={v.weeks} starts={starts} width={200} height={30} /></Row>
        </>
      )}
    </section>
  );
}

const field = "w-full rounded-lg border border-gray-800 bg-gray-950 px-2.5 py-1.5 text-sm text-white focus:border-violet-500 focus:outline-none";

export function DiagnosticPanel({
  client, starts, words, evolution, action, o, onClose, onSaved,
}: {
  client: ClientRow & { missing?: string[] };
  starts: string[];
  words: PeriodWords;
  evolution: EvolutionPoint[];
  action: CockpitActionView | null;
  o: MoneyOptions;
  onClose: () => void;
  onSaved: (key: string, action: CockpitActionView) => void;
}) {
  const c = client;
  const r = c.blended;
  const ca = cause(c);
  const [draft, setDraft] = useState({ state: action?.state ?? "", owner: action?.owner ?? "", due: action?.due ?? "", note: action?.note ?? "" });
  const [saving, setSaving] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const closeRef = useRef<HTMLButtonElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.removeEventListener("keydown", onKey); document.body.style.overflow = overflow; };
  }, [onClose]);

  function update(patch: Partial<typeof draft>) {
    const next = { ...draft, ...patch };
    setDraft(next);
    setSaving("saving");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/cockpit/global/actions/${c.key}`, {
          method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(next),
        });
        if (!res.ok) throw new Error(String(res.status));
        const json = await res.json();
        onSaved(c.key, json.action);
        setSaving("saved");
      } catch { setSaving("error"); }
    }, 600);
  }

  // One point per day is enough to read a trend: the last build of each day.
  const days = new Map<string, EvolutionPoint>();
  for (const p of evolution) days.set(p.at.slice(0, 10), p);
  const history = [...days.values()].slice(-10);

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/60" onClick={onClose} aria-hidden />
      <aside role="dialog" aria-modal="true" aria-labelledby="cockpit-panel-title" className="fixed inset-y-0 right-0 z-50 flex w-full max-w-xl flex-col border-l border-gray-800 bg-gray-950 shadow-2xl">
        <header className="border-b border-gray-800 px-5 py-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <span className="text-[11px] font-semibold uppercase tracking-wider text-violet-400">Diagnostic</span>
              <h2 id="cockpit-panel-title" className="text-lg font-semibold text-white">{c.name}</h2>
            </div>
            <button ref={closeRef} type="button" onClick={onClose} aria-label="Fermer le diagnostic" className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-800 hover:text-white">
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1"><Badges c={c} /> <SeverityBadge severity={c.alert.severity} /></div>
        </header>

        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
          <section>
            <h4 className="text-sm font-semibold text-white">{c.alert.reason}</h4>
            {c.alert.next_action && <p className="mt-0.5 text-sm text-gray-400">{c.alert.next_action}</p>}
          </section>

          <section className="rounded-xl border border-gray-800 bg-gray-900/60 p-3">
            <h4 className="mb-1 text-sm font-semibold text-white">
              Vue d&apos;ensemble — {c.kpi_mode === "mixte" ? TXT.mixte : modeLabel(c.kpi_mode)}{c.ccy ? ` · ${c.ccy}` : ""}
            </h4>
            <Row label={words.spend}>
              <b className="text-white">{spendText(c, o)}</b>
              <Chip d={r.spend_d} kind="spend" label={words.base} />
              <Chip d={r.spend_d_wow} kind="spend" label={words.prev} />
            </Row>
            {c.kpi_mode === "brand" ? <Row label="KPI"><Muted>{TXT.brandDetail}</Muted></Row>
              : c.kpi_mode === "mixte" ? null : (
                <Row label={c.kpi_mode === "roas" ? "ROAS" : "CPA"}>
                  <b className="text-white">{kpiText(r.kpi, c.kpi_mode, c.ccy, o)}</b>
                  {r.low_vol ? <Muted>{TXT.lowVol} · {Math.round(r.conv)} conv · KPI non significatif</Muted>
                    : <><Chip d={r.kpi_d} kind="perf" label={words.base} mode={c.kpi_mode} /><Chip d={r.kpi_d_wow} kind="perf" label={words.prev} mode={c.kpi_mode} /></>}
                </Row>
              )}
            {(c.target_roas || c.target_cpl) && !noKpi(c.kpi_mode) && (
              <Row label="Objectif (feuille budgets)">
                {c.kpi_mode === "roas" && c.target_roas ? <span>ROAS ≥ {String(c.target_roas).replace(".", ",")}x</span> : null}
                {c.kpi_mode === "cpa" && c.target_cpl ? <span>CPL ≤ {money(c.target_cpl, c.ccy, o)}</span> : null}
              </Row>
            )}
            <Row label="Signal du funnel (hypothèse)">
              {ca ? <span><b className="text-red-300">{ca.txt}</b> <Muted>({ca.where})</Muted></span> : <Muted>{TXT.noCause}</Muted>}
            </Row>
            <Row label="Rythme budgétaire"><PaceGauge p={c.pacing} /></Row>
            <Row label={`${words.spark} (dépenses)`}><Spark weeks={r.weeks} starts={starts} width={240} height={34} /></Row>
          </section>

          <section className="space-y-2">
            <h4 className="text-sm font-semibold text-white">Performance par canal</h4>
            {Object.values(c.platforms).map((v) => <PlatformBlock key={v.key} c={c} v={v} starts={starts} o={o} words={words} />)}
          </section>

          {history.length > 1 && (
            <section className="rounded-xl border border-gray-800 bg-gray-900/60 p-3">
              <h4 className="mb-2 text-sm font-semibold text-white">Évolution du niveau</h4>
              <ol className="space-y-1.5">
                {[...history].reverse().map((p) => (
                  <li key={p.at} className="flex items-center gap-2 text-xs text-gray-400">
                    <span className="w-12 shrink-0 tabular-nums text-gray-500">{new Date(p.at).toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" })}</span>
                    <SeverityBadge severity={p.severity} label={SEVERITY_LABEL[p.severity]} />
                    <span className="truncate">{p.reason}</span>
                  </li>
                ))}
              </ol>
            </section>
          )}

          <section className="space-y-2 rounded-xl border border-gray-800 bg-gray-900/60 p-3">
            <div className="flex items-center justify-between">
              <h4 className="text-sm font-semibold text-white">Plan d&apos;action</h4>
              <span className={`text-[11px] ${saving === "error" ? "text-red-300" : "text-gray-500"}`} aria-live="polite">
                {saving === "saving" ? "Enregistrement…" : saving === "saved" ? "Enregistré" : saving === "error" ? "Non enregistré — réessayez" : ""}
              </span>
            </div>
            <label className="block text-xs text-gray-400">Statut
              <select value={draft.state} onChange={(e) => update({ state: e.target.value })} className={`${field} mt-1`}>
                <option value="">Aucune action planifiée</option>
                <option value="todo">À faire</option>
                <option value="doing">En cours</option>
                <option value="done">Résolue</option>
              </select>
            </label>
            <div className="grid grid-cols-2 gap-2">
              <label className="block text-xs text-gray-400">Responsable
                <input type="text" value={draft.owner} placeholder="Prénom" onChange={(e) => update({ owner: e.target.value })} className={`${field} mt-1`} />
              </label>
              <label className="block text-xs text-gray-400">Échéance
                <input type="date" value={draft.due} onChange={(e) => update({ due: e.target.value })} className={`${field} mt-1`} />
              </label>
            </div>
            <label className="block text-xs text-gray-400">Note
              <textarea value={draft.note} rows={3} placeholder="Contexte, décision, next step…" onChange={(e) => update({ note: e.target.value })} className={`${field} mt-1 resize-y`} />
            </label>
            {action?.updatedBy && <p className="text-[11px] text-gray-600">Dernière modification : {action.updatedBy}, {new Date(action.updatedAt).toLocaleDateString("fr-FR")}</p>}
          </section>
        </div>
      </aside>
    </>
  );
}
