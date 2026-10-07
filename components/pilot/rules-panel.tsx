"use client";

/**
 * Pilotage — the automatic rules of a client: « when <metric> of <object>
 * over <days> days is <op> <threshold>, do <action> ». Checked once a day by
 * the cron; a rule that fires acts through Pilotage (journal, HQ, J+7/J+14)
 * as the person who wrote it. « Vérifier maintenant » reads the figures
 * without acting.
 */

import { useEffect, useState } from "react";
import { Loader2, Plus, Trash2, Zap } from "lucide-react";
import { Pill } from "@/components/ui/surface";
import { PLATFORM_FR } from "@/lib/pilot/ops";
import { RULE_ACTIONS, RULE_ACTION_FR, RULE_DAYS, RULE_METRICS, RULE_METRIC_FR, describeRule, type RuleAction, type RuleMetric } from "@/lib/pilot/rules";
import type { PilotClient, TreeRow } from "@/components/pilot/model";
import { readJson } from "@/components/pilot/model";

interface Rule {
  id: string; platform: string; accountId: string; accountName: string; currency: string; createdByName: string; name: string; enabled: boolean;
  objectType: string; objectId: string | null; objectName: string | null; metric: string; op: string; threshold: number; days: number; minConversions: number;
  action: string; actionValue: number | null; cooldownDays: number; notifyChannel: string | null; lastCheckedAt: string | null; lastFiredAt: string | null; lastResult: string | null;
}
type Check = { objectId: string; name: string; value: number | null; fires: boolean; reason: string; cooled: boolean };

const input = "bg-gray-950 border border-gray-700 rounded-md px-2 py-1 text-sm text-white";
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("fr-FR", { timeZone: "Europe/Paris", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "jamais");

export function RulesPanel({ client, account, campaigns, adsets }: { client: PilotClient; account: { platform: string; accountId: string } | null; campaigns: TreeRow[]; adsets: TreeRow[] }) {
  const [rules, setRules] = useState<Rule[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [checks, setChecks] = useState<Record<string, Check[] | string>>({});
  const [f, setF] = useState({ name: "", objectType: "campaign", objectId: "", metric: "cpa" as RuleMetric, op: "gt", threshold: "", days: 7, minConversions: 5, action: "notify" as RuleAction, actionValue: "-20", cooldownDays: 3, notifyChannel: "" });

  const load = () => fetch(`/api/pilot/rules?clientId=${encodeURIComponent(client.id)}`)
    .then(async (r) => { const j = await readJson<{ rules?: Rule[] }>(r); if (!r.ok) throw new Error(j.error ?? `Erreur ${r.status}`); return j.rules ?? []; })
    .then(setRules).catch((e) => setError(e instanceof Error ? e.message : String(e)));
  useEffect(() => { void load(); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client.id]);

  async function create() {
    if (!account) return;
    setBusy("create");
    setError(null);
    try {
      const object = f.objectId ? [...campaigns, ...adsets].find((r) => r.id === f.objectId) : null;
      const res = await fetch("/api/pilot/rules", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ clientId: client.id, platform: account.platform, accountId: account.accountId, ...f, objectId: f.objectId || null, objectName: object?.name ?? null, threshold: f.threshold, actionValue: f.action === "budget_pct" ? f.actionValue : null, notifyChannel: f.notifyChannel || null }) });
      const j = await readJson<{ rule?: Rule }>(res);
      if (!res.ok || !j.rule) throw new Error(j.error ?? `Erreur ${res.status}`);
      setRules((list) => [j.rule!, ...(list ?? [])]);
      setOpen(false);
      setF({ ...f, name: "", threshold: "" });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function toggle(rule: Rule) {
    const res = await fetch(`/api/pilot/rules/${rule.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: !rule.enabled }) });
    const j = await readJson<{ rule?: Rule }>(res);
    if (res.ok && j.rule) setRules((list) => (list ?? []).map((r) => (r.id === rule.id ? j.rule! : r)));
  }
  async function remove(rule: Rule) {
    if (!window.confirm(`Supprimer la règle « ${rule.name} » ?`)) return;
    const res = await fetch(`/api/pilot/rules/${rule.id}`, { method: "DELETE" });
    if (res.ok) setRules((list) => (list ?? []).filter((r) => r.id !== rule.id));
  }
  async function check(rule: Rule) {
    setBusy(`check:${rule.id}`);
    try {
      const res = await fetch(`/api/pilot/rules/${rule.id}/check`, { method: "POST" });
      const j = await readJson<{ checks?: Check[] }>(res);
      setChecks((c) => ({ ...c, [rule.id]: res.ok && j.checks ? j.checks : (j.error ?? `Erreur ${res.status}`) }));
    } finally {
      setBusy(null);
    }
  }

  const objects = f.objectType === "campaign" ? campaigns : adsets;
  const canCreate = !!account && account.platform !== "tiktok";

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-gray-400">Vérifiées chaque matin vers 9 h (heure de Paris). Une règle agit comme vous : aperçu, envoi, journal, HQ, bilan. Au plus 25 objets par déclenchement, puis repos de quelques jours.</span>
        <span className="flex-1" />
        {canCreate && <button type="button" onClick={() => setOpen(!open)} className="flex items-center gap-1 px-2 py-1 rounded-md border border-gray-700 text-gray-200 hover:border-violet-500"><Plus className="w-3.5 h-3.5" /> Nouvelle règle sur ce compte</button>}
      </div>
      {open && account && (
        <form onSubmit={(e) => { e.preventDefault(); void create(); }} className="rounded-xl border border-violet-500/40 bg-violet-500/5 p-3 space-y-2 text-sm">
          <div className="grid sm:grid-cols-2 gap-2">
            <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Nom de la règle (ex. CPA trop haut sur la prospection)" className={input} required />
            <input value={f.notifyChannel} onChange={(e) => setF({ ...f, notifyChannel: e.target.value })} placeholder="Canal Slack à prévenir (facultatif, ex. #c_client)" className={input} />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-gray-400">Si</span>
            <select value={f.metric} onChange={(e) => setF({ ...f, metric: e.target.value as RuleMetric })} className={input}>{RULE_METRICS.map((m) => <option key={m} value={m}>{RULE_METRIC_FR[m]}</option>)}</select>
            <span className="text-gray-400">de</span>
            <select value={f.objectType} onChange={(e) => setF({ ...f, objectType: e.target.value, objectId: "" })} className={input}><option value="campaign">campagne</option><option value="adset">{account.platform === "meta" ? "ensemble" : "groupe d'annonces"}</option></select>
            <select value={f.objectId} onChange={(e) => setF({ ...f, objectId: e.target.value })} className={`${input} max-w-[16rem]`}>
              <option value="">chaque {f.objectType === "campaign" ? "campagne" : "ensemble / groupe"} du compte</option>
              {objects.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
            <span className="text-gray-400">sur</span>
            <select value={f.days} onChange={(e) => setF({ ...f, days: Number(e.target.value) })} className={input}>{RULE_DAYS.map((d) => <option key={d} value={d}>{d} j</option>)}</select>
            <select value={f.op} onChange={(e) => setF({ ...f, op: e.target.value })} className={input}><option value="gt">dépasse</option><option value="lt">passe sous</option></select>
            <input value={f.threshold} onChange={(e) => setF({ ...f, threshold: e.target.value })} placeholder="seuil" inputMode="decimal" className={`${input} w-24`} required />
            <span className="text-gray-400">→</span>
            <select value={f.action} onChange={(e) => setF({ ...f, action: e.target.value as RuleAction })} className={input}>{RULE_ACTIONS.map((a) => <option key={a} value={a}>{RULE_ACTION_FR[a]}</option>)}</select>
            {f.action === "budget_pct" && <input value={f.actionValue} onChange={(e) => setF({ ...f, actionValue: e.target.value })} inputMode="decimal" className={`${input} w-20`} title="Variation en % (−20 = −20 %)" />}
          </div>
          <div className="flex flex-wrap items-center gap-3 text-xs text-gray-400">
            {(f.metric === "cpa" || f.metric === "roas") && <label className="flex items-center gap-1">au moins <input type="number" min={0} value={f.minConversions} onChange={(e) => setF({ ...f, minConversions: Number(e.target.value) })} className={`${input} w-16 py-0.5`} /> conversions sur la fenêtre</label>}
            <label className="flex items-center gap-1">repos après déclenchement <input type="number" min={1} max={60} value={f.cooldownDays} onChange={(e) => setF({ ...f, cooldownDays: Number(e.target.value) })} className={`${input} w-16 py-0.5`} /> jours</label>
            <span className="flex-1" />
            <button type="submit" disabled={busy === "create"} className="px-3 py-1.5 rounded-lg bg-violet-600 hover:bg-violet-500 text-white disabled:opacity-40">{busy === "create" ? "…" : "Créer la règle"}</button>
            <button type="button" onClick={() => setOpen(false)} className="hover:text-white">Annuler</button>
          </div>
        </form>
      )}
      {error && <p className="text-sm text-red-300">{error}</p>}
      {rules === null && !error && <p className="text-sm text-gray-500 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Lecture des règles…</p>}
      {rules && !rules.length && <p className="text-sm text-gray-500">Aucune règle automatique pour ce client.</p>}
      {rules && rules.length > 0 && (
        <ul className="divide-y divide-gray-800">
          {rules.map((r) => {
            const c = checks[r.id];
            return (
              <li key={r.id} className="py-3 space-y-1.5">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <button type="button" onClick={() => void toggle(r)} className={`w-9 h-5 rounded-full relative transition ${r.enabled ? "bg-violet-600" : "bg-gray-700"}`} title={r.enabled ? "Active — cliquer pour suspendre" : "Suspendue — cliquer pour activer"}><span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition ${r.enabled ? "left-4" : "left-0.5"}`} /></button>
                  <span className="text-white font-medium">{r.name}</span>
                  <Pill className="text-[10px]">{PLATFORM_FR[r.platform] ?? r.platform} · {r.accountName || r.accountId}</Pill>
                  <span className="text-gray-400 text-xs">{describeRule({ metric: r.metric as RuleMetric, op: r.op as "gt" | "lt", threshold: r.threshold, days: r.days, action: r.action as RuleAction, actionValue: r.actionValue, objectType: r.objectType as "campaign" | "adset", objectName: r.objectName }, r.currency)}</span>
                  <span className="flex-1" />
                  <button type="button" disabled={busy !== null} onClick={() => void check(r)} className="text-xs text-gray-400 hover:text-white flex items-center gap-1">{busy === `check:${r.id}` ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5" />} Vérifier maintenant</button>
                  <button type="button" onClick={() => void remove(r)} className="text-xs text-gray-500 hover:text-red-300" aria-label="Supprimer"><Trash2 className="w-3.5 h-3.5" /></button>
                </div>
                <p className="text-[11px] text-gray-500">par {r.createdByName} · dernière vérification {when(r.lastCheckedAt)} · dernier déclenchement {when(r.lastFiredAt)}{r.notifyChannel ? ` · Slack ${r.notifyChannel}` : ""}{r.lastResult ? ` — ${r.lastResult}` : ""}</p>
                {typeof c === "string" && <p className="text-xs text-amber-300">{c}</p>}
                {Array.isArray(c) && (
                  <ul className="text-xs space-y-0.5 pl-3">
                    {c.length === 0 && <li className="text-gray-500">Aucun objet lu sur la fenêtre.</li>}
                    {c.slice(0, 12).map((x) => <li key={x.objectId} className={x.fires ? "text-amber-300" : "text-gray-400"}>{x.fires ? "● " : "○ "}{x.name} — {x.reason}{x.fires && x.cooled ? " (en repos)" : ""}</li>)}
                    {c.length > 12 && <li className="text-gray-600">… {c.length - 12} autres</li>}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
