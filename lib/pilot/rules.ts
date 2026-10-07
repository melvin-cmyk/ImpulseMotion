/**
 * Pilotage — automatic rules: « when <metric> of <object> over <days> days is
 * <op> <threshold>, do <action> ». Evaluated once a day by the cron on the
 * figures the alerts already read (lib/alert-entities.ts, lib/alert-google.ts),
 * and acting through the very path of a consultant: an action prepared
 * (checked against the platform), sent, journalled, written in HQ, judged at
 * J+7 / J+14. A rule that fired waits `cooldownDays` before firing again on
 * the same object. Slack is told when a channel is given.
 */

import { prisma } from "@/lib/prisma";
import { fetchEntityMetrics } from "@/lib/alert-entities";
import { fetchGoogleEntityMetrics } from "@/lib/alert-google";
import type { ComputedMetrics } from "@/lib/alerts";
import { sendSlackMessage } from "@/lib/routines/notify";
import { pilotAdapter } from "@/lib/pilot/adapters";
import { executeAction, prepareAction, resolveAccount, withPilotGuard, type PilotSession } from "@/lib/pilot/service";
import { currencyOffset, money, type PilotRequest } from "@/lib/pilot/ops";

export const RULE_METRICS = ["cpa", "roas", "spend", "conversions", "ctr", "cpc"] as const;
export type RuleMetric = (typeof RULE_METRICS)[number];
export const RULE_METRIC_FR: Record<RuleMetric, string> = { cpa: "CPA", roas: "ROAS", spend: "Dépense", conversions: "Conversions", ctr: "CTR", cpc: "CPC" };
export const RULE_DAYS = [1, 7, 14, 30] as const;
export const RULE_ACTIONS = ["pause", "budget_pct", "notify"] as const;
export type RuleAction = (typeof RULE_ACTIONS)[number];
export const RULE_ACTION_FR: Record<RuleAction, string> = { pause: "mettre en pause", budget_pct: "changer le budget de x %", notify: "prévenir seulement" };

export interface RuleInput {
  name: string;
  platform: "meta" | "google";
  accountId: string;
  objectType: "campaign" | "adset";
  objectId: string | null;
  objectName: string | null;
  metric: RuleMetric;
  op: "gt" | "lt";
  threshold: number;
  days: number;
  minConversions: number;
  action: RuleAction;
  actionValue: number | null;
  cooldownDays: number;
  notifyChannel: string | null;
  enabled: boolean;
}

/** Reads a rule from a request body; the reason in French when it is not one. */
export function readRule(raw: unknown): { ok: true; rule: RuleInput } | { ok: false; error: string } {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const name = String(r.name ?? "").trim().slice(0, 120);
  if (!name) return { ok: false, error: "Donnez un nom à la règle." };
  const platform = r.platform === "meta" || r.platform === "google" ? r.platform : null;
  if (!platform) return { ok: false, error: "Plateforme inconnue (Meta ou Google Ads)." };
  const objectType = r.objectType === "campaign" || r.objectType === "adset" ? r.objectType : null;
  if (!objectType) return { ok: false, error: "La règle porte sur des campagnes ou des ensembles / groupes." };
  const objectId = typeof r.objectId === "string" && /^\d{1,25}$/.test(r.objectId) ? r.objectId : null;
  const metric = (RULE_METRICS as readonly string[]).includes(String(r.metric)) ? (r.metric as RuleMetric) : null;
  if (!metric) return { ok: false, error: "Indicateur inconnu." };
  const op = r.op === "gt" || r.op === "lt" ? r.op : null;
  if (!op) return { ok: false, error: "Comparaison inconnue (supérieur ou inférieur)." };
  const threshold = Number(String(r.threshold ?? "").replace(",", "."));
  if (!Number.isFinite(threshold) || threshold < 0) return { ok: false, error: "Seuil invalide." };
  const days = Number(r.days);
  if (!(RULE_DAYS as readonly number[]).includes(days)) return { ok: false, error: "Fenêtre : 1, 7, 14 ou 30 jours." };
  const action = (RULE_ACTIONS as readonly string[]).includes(String(r.action)) ? (r.action as RuleAction) : null;
  if (!action) return { ok: false, error: "Action inconnue." };
  const actionValue = action === "budget_pct" ? Number(String(r.actionValue ?? "").replace(",", ".")) : null;
  if (action === "budget_pct" && (!Number.isFinite(actionValue) || actionValue === 0 || (actionValue as number) < -90 || (actionValue as number) > 100)) return { ok: false, error: "Variation de budget entre −90 % et +100 %, différente de 0." };
  const minConversions = Number.isFinite(Number(r.minConversions)) ? Math.max(0, Math.min(1000, Math.round(Number(r.minConversions)))) : 5;
  const cooldownDays = Number.isFinite(Number(r.cooldownDays)) ? Math.max(1, Math.min(60, Math.round(Number(r.cooldownDays)))) : 3;
  const notifyChannel = typeof r.notifyChannel === "string" && r.notifyChannel.trim() ? r.notifyChannel.trim().slice(0, 80) : null;
  return { ok: true, rule: { name, platform, accountId: String(r.accountId ?? ""), objectType, objectId, objectName: typeof r.objectName === "string" ? r.objectName.slice(0, 400) : null, metric, op, threshold, days, minConversions, action, actionValue, cooldownDays, notifyChannel, enabled: r.enabled !== false } };
}

export const metricValue = (m: ComputedMetrics, metric: RuleMetric): number | null => {
  switch (metric) {
    case "cpa": return m.conversions > 0 ? m.cpa : null;
    case "roas": return m.roasAvailable && m.spend > 0 ? m.roas : null;
    case "spend": return m.spend;
    case "conversions": return m.conversions;
    case "ctr": return m.ctr;
    case "cpc": return m.spend > 0 && m.ctr >= 0 ? (m as ComputedMetrics & { cpc?: number }).cpc ?? null : null;
  }
};

/** Pure: whether the figures of one object fire the rule, with the reason. */
export function ruleFires(rule: Pick<RuleInput, "metric" | "op" | "threshold" | "minConversions">, m: ComputedMetrics): { fires: boolean; value: number | null; reason: string } {
  const value = metricValue(m, rule.metric);
  if (value === null) return { fires: false, value, reason: `${RULE_METRIC_FR[rule.metric]} non mesurable` };
  if ((rule.metric === "cpa" || rule.metric === "roas") && m.conversions < rule.minConversions) return { fires: false, value, reason: `${m.conversions} conversion(s), moins que ${rule.minConversions}` };
  const fires = rule.op === "gt" ? value > rule.threshold : value < rule.threshold;
  return { fires, value, reason: `${RULE_METRIC_FR[rule.metric]} ${fmt(rule.metric, value)} ${rule.op === "gt" ? ">" : "<"} ${fmt(rule.metric, rule.threshold)}` };
}

const fmt = (metric: RuleMetric, v: number) => (metric === "roas" ? `${v.toFixed(2)}×` : metric === "ctr" ? `${v.toFixed(2)} %` : metric === "conversions" ? v.toLocaleString("fr-FR", { maximumFractionDigits: 1 }) : v.toLocaleString("fr-FR", { maximumFractionDigits: 2 }));

/** « Si le CPA sur 7 j dépasse 40, mettre en pause » — the rule in one line. */
export function describeRule(r: Pick<RuleInput, "metric" | "op" | "threshold" | "days" | "action" | "actionValue" | "objectType" | "objectName">, currency = "EUR"): string {
  const money$ = (v: number) => money(Math.round(v * currencyOffset(currency)), currency);
  const th = r.metric === "cpa" || r.metric === "spend" || r.metric === "cpc" ? money$(r.threshold) : fmt(r.metric, r.threshold);
  const on = r.objectName ? `« ${r.objectName} »` : r.objectType === "campaign" ? "chaque campagne" : "chaque ensemble / groupe";
  const act = r.action === "pause" ? "mettre en pause" : r.action === "budget_pct" ? `budget ${(r.actionValue ?? 0) > 0 ? "+" : ""}${r.actionValue} %` : "prévenir";
  return `Si ${RULE_METRIC_FR[r.metric]} de ${on} sur ${r.days} j ${r.op === "gt" ? "dépasse" : "passe sous"} ${th} → ${act}`;
}

type RuleRow = NonNullable<Awaited<ReturnType<typeof prisma.pilotRule.findUnique>>>;

export interface RuleCheck { objectId: string; name: string; value: number | null; fires: boolean; reason: string; cooled: boolean }

/** The figures of the rule's objects now, and which ones fire. No action. */
export async function checkRule(rule: RuleRow, now: Date = new Date()): Promise<RuleCheck[]> {
  const window = `${rule.days}d`;
  const level = rule.objectType === "campaign" ? "campaign" : rule.platform === "meta" ? "adset" : "ad_group";
  const read = rule.platform === "meta" ? await fetchEntityMetrics(rule.accountId, level as "campaign" | "adset", window) : await fetchGoogleEntityMetrics(rule.accountId, level as "campaign" | "ad_group", window);
  const recent = rule.lastFiredAt && now.getTime() - rule.lastFiredAt.getTime() < rule.cooldownDays * 86_400_000;
  return read.entities
    .filter((e) => !rule.objectId || e.id === rule.objectId)
    .map((e) => { const f = ruleFires({ metric: rule.metric as RuleMetric, op: rule.op as "gt" | "lt", threshold: rule.threshold, minConversions: rule.minConversions }, e.current); return { objectId: e.id, name: e.name, value: f.value, fires: f.fires, reason: f.reason, cooled: !!recent }; });
}

export interface RulesPassSummary { checked: number; fired: number; acted: number; failed: number }

/** The daily pass: every enabled rule not checked today. */
export async function runPilotRules(now: Date = new Date(), budgetMs = 120_000): Promise<RulesPassSummary> {
  const started = Date.now();
  const summary: RulesPassSummary = { checked: 0, fired: 0, acted: 0, failed: 0 };
  const since = new Date(now.getTime() - 20 * 60 * 60 * 1000);
  const rules = await prisma.pilotRule.findMany({ where: { enabled: true, OR: [{ lastCheckedAt: null }, { lastCheckedAt: { lt: since } }] }, orderBy: { lastCheckedAt: "asc" }, take: 50 });
  for (const rule of rules) {
    if (Date.now() - started > budgetMs) break;
    try {
      const checks = await checkRule(rule, now);
      const firing = checks.filter((c) => c.fires);
      summary.checked++;
      let note = firing.length ? `${firing.length} objet(s) au-delà du seuil : ${firing.slice(0, 5).map((c) => `${c.name} (${c.reason})`).join(" ; ")}` : `Rien à signaler (${checks.length} objet(s) lus).`;
      if (firing.length && !firing[0].cooled) {
        summary.fired++;
        const acted = await actOnRule(rule, firing, now);
        note = `${note} → ${acted}`;
        if (/envoy|prévenu/i.test(acted)) summary.acted++; else summary.failed++;
        await prisma.pilotRule.update({ where: { id: rule.id }, data: { lastCheckedAt: now, lastFiredAt: now, lastResult: note.slice(0, 2000) } });
      } else {
        if (firing.length) note = `${note} (règle en attente : déclenchée il y a moins de ${rule.cooldownDays} j)`;
        await prisma.pilotRule.update({ where: { id: rule.id }, data: { lastCheckedAt: now, lastResult: note.slice(0, 2000) } });
      }
    } catch (e) {
      summary.failed++;
      await prisma.pilotRule.update({ where: { id: rule.id }, data: { lastCheckedAt: now, lastResult: `Lecture impossible : ${(e instanceof Error ? e.message : String(e)).slice(0, 300)}` } }).catch(() => {});
    }
  }
  return summary;
}

/** What the rule does once fired: the action through Pilotage (as its author), and the Slack word. */
async function actOnRule(rule: RuleRow, firing: RuleCheck[], now: Date): Promise<string> {
  const session: PilotSession = { userId: rule.createdById };
  const line = `Règle « ${rule.name} » : ${firing.map((c) => `${c.name} — ${c.reason}`).join(" ; ")}`;
  let outcome = "prévenu seulement";
  if (rule.action !== "notify") {
    const resolved = await resolveAccount(session, rule.alertClientId, rule.accountId, rule.platform);
    if (!resolved.ok) return `action refusée : ${resolved.error}`;
    const adapter = pilotAdapter(rule.platform)!;
    const requests: PilotRequest[] = [];
    const skipped: string[] = [];
    for (const c of firing.slice(0, 25)) {
      if (rule.action === "pause") { requests.push({ kind: "set_status", objectType: rule.objectType as "campaign" | "adset", objectId: c.objectId, value: "PAUSED" }); continue; }
      // Budget ± x %: on the budget the object carries now.
      let state: Awaited<ReturnType<typeof adapter.readObject>> = null;
      try { state = await adapter.readObject(resolved.account.digits, c.objectId, rule.objectType as "campaign" | "adset", rule.currency); } catch { state = null; }
      const budget = state?.dailyBudget ?? state?.lifetimeBudget ?? null;
      if (!state || !budget || state.budgetLock) { skipped.push(c.name); continue; }
      const next = Math.round(budget * (1 + (rule.actionValue ?? 0) / 100));
      if (next < currencyOffset(rule.currency) || next === budget) { skipped.push(c.name); continue; }
      requests.push({ kind: state.dailyBudget ? "set_daily_budget" : "set_lifetime_budget", objectType: rule.objectType as "campaign" | "adset", objectId: c.objectId, value: next / currencyOffset(rule.currency) });
    }
    if (!requests.length) outcome = `rien à envoyer${skipped.length ? ` (sans budget modifiable : ${skipped.join(", ")})` : ""}`;
    else {
      const prepared = await prepareAction(session, { alertClientId: rule.alertClientId, accountId: rule.accountId, platform: rule.platform, requests, why: line.slice(0, 1900), goal: { metric: rule.metric === "cpc" ? "cpc" : rule.metric, target: rule.threshold, note: "règle automatique" } });
      if (!prepared.ok) outcome = `aperçu refusé : ${prepared.error}${prepared.errors?.length ? ` (${prepared.errors.join(" ; ")})` : ""}`;
      else {
        await prisma.pilotAction.update({ where: { id: prepared.action.id }, data: { ruleId: rule.id } });
        const sent = await executeAction(session, prepared.action.id, { why: line.slice(0, 1900), hqProject: prepared.action.hqProject, confirmDouble: true }, now);
        outcome = sent.ok ? `envoyé (${sent.action.operations.filter((o) => o.status === "done").length}/${sent.action.operations.length} appliqué(s))` : `envoi refusé : ${sent.error}`;
      }
    }
  }
  if (rule.notifyChannel) {
    try {
      await withPilotGuard(`rule:${rule.id}:${now.getTime()}`, (guard) => sendSlackMessage(guard, { channel: rule.notifyChannel!, text: `:robot_face: *${rule.clientName}* — ${line}\n→ ${outcome}`, routine: { id: rule.id, name: rule.name } }));
    } catch (e) {
      outcome += ` ; Slack non prévenu (${(e instanceof Error ? e.message : String(e)).slice(0, 120)})`;
    }
  }
  return outcome;
}
