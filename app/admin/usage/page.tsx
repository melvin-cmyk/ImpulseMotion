"use client";

/**
 * Admin — Bedrock usage per client, by month, to bill by usage.
 * Only the private client bots run on Bedrock, so this is their ledger.
 * Token counts are Bedrock's own, split in the four kinds AWS prices apart
 * (input, cache write, cache read, output); pricing is left to the admin.
 * "Facturable" = messages sent by client logins; staff tests are shown apart.
 */

import { Fragment, useEffect, useMemo, useState } from "react";
import { PageHeader, Card, Kpi, Pill } from "@/components/ui/surface";
import { MaxAccountsPanel } from "@/components/admin/max-accounts";

type Totals = { messages: number; inputTokens: number; cacheWriteTokens: number; cacheReadTokens: number; outputTokens: number };
type Quota = {
  fiveHour: { utilization: number; resetsAt: string | null } | null;
  sevenDay: { utilization: number; resetsAt: string | null } | null;
  checkedAt: string | null;
  error: string | null;
  level: number;
  warnPct: number;
  switchPct: number;
  fallbackActive: boolean;
  fallbackEnabled: boolean;
  exhaustedUntil: string | null;
  bedrockModel: string;
  subscriptionModel: string;
};
type FeatureUsage = Totals & { feature: string; provider: string; model: string; turns: number; avgTokensPerMessage: number };
const FEATURE_LABEL: Record<string, string> = {
  client_bot: "Bots clients",
  console: "Console /ai",
  copilot: "Copilote dashboard",
  report: "Rapport IA (rédaction)",
  report_chat: "Chat rapport",
  creative_analysis: "Analyse créas",
  analyse_copilot: "Copilote Analyse Ads",
  mo: "Mo (assistant vocal)",
  creas_template: "Lecture de templates (Créas)",
  creas_copy: "Fabrique de statics (copys)",
  ai_tagging: "Tags IA des créas",
  recommend: "Plan d'action alertes",
  hq_context: "Contexte HQ client",
  alert_compose: "Rédaction d'alerte (IA)",
  alert_ai: "Alertes IA (scan quotidien)",
  auto_alert: "Alertes automatiques (lecture IA)",
  guide: "Guide de l'application",
  routine_compose: "Routines (création avec l'IA)",
  routine_ai_step: "Routines (synthèse IA à l'exécution)",
  client_alert_compose: "Alertes (création avec l'IA)",
  pilot_assistant: "Pilotage (modifications avec l'IA)",
  persona: "Personas client (HQ)",
  design_copilot: "Design (copilote FigCraft)",
};
type ProfileUsage = Totals & {
  key: string;
  email: string | null;
  name: string | null;
  role: string;
  tokens: number;
  share: number;
  costUsd: number;
  subscriptionTokens: number;
  bedrockTokens: number;
  features: Array<Totals & { feature: string; tokens: number }>;
};
const ROLE_LABEL: Record<string, string> = { admin: "Admin", consultant: "Consultant", client: "Client", staff: "Équipe", system: "Automatique" };
type ClientUsage = {
  key: string;
  clientName: string;
  clientKey: string | null;
  billable: Totals;
  staff: Totals;
  users: Array<{ email: string; role: string } & Totals>;
};

const int = (n: number) => n.toLocaleString("fr-FR");

type MoPathStats = { path: string; turns: number; p50FirstCardMs: number | null; p90FirstCardMs: number | null; p50TotalMs: number | null; misunderstood: number };
type MoMeasures =
  | { days: number; summary: { turns: number; byPath: MoPathStats[]; withoutModelPct: number | null; misunderstoodPct: number | null; asksAbandoned: number; actionsByDay: Array<{ day: string; userId: string; actions: number; kinds: Record<string, number> }> }; people: Record<string, string> }
  | { days: number; error: string };
const MO_PATH_LABEL: Record<string, string> = { nav: "Navigation (sans modèle)", quick: "Chemin rapide (entrepôt, sans modèle)", act: "Action sur une carte (sans modèle)", model: "Modèle (Sonnet)", ask: "Question de Mo (puces)" };
/** Targets of spec §6: quick / act p50 < 3 s, model p50 < 10 s to the first card. */
const MO_TARGET_MS: Record<string, number> = { nav: 1000, quick: 3000, act: 3000, model: 10_000 };
const MO_KIND_LABEL: Record<string, string> = { verdict: "verdicts", publish_prepare: "publications préparées", publish_confirm: "publications confirmées", upload: "fichiers déposés", drive: "envois Drive", open_editor: "ouvertures éditeur", more_like_this: "visuels générés", generate_creatives: "visuels générés", keep_template: "templates gardés" };
const secs = (ms: number | null) => (ms === null ? "—" : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} s`);

/** « Mo : vitesse et compréhension » — the measures of spec §6 over the last 7 days (table MoTurn). */
function MoMeasuresBlock({ mo }: { mo: MoMeasures | null }) {
  const body = !mo ? <Card padded><p className="text-sm text-gray-500">Chargement…</p></Card>
    : "error" in mo ? <Card padded><p className="text-sm text-amber-300">Mesures indisponibles : {mo.error}</p><p className="text-xs text-gray-500 mt-1">La table MoTurn arrive avec la migration 20261028230000_mo_turn (déployée au prochain build).</p></Card>
    : mo.summary.turns === 0 ? <Card padded><p className="text-sm text-gray-400">Aucun tour de Mo sur les {mo.days} derniers jours.</p></Card>
    : (() => {
      const s = mo.summary;
      const days = [...new Set(s.actionsByDay.map((a) => a.day))].sort((a, b) => (a < b ? 1 : -1)).slice(0, 7);
      const people = [...new Set(s.actionsByDay.map((a) => a.userId))].sort((a, b) => (mo.people[a] ?? a).localeCompare(mo.people[b] ?? b, "fr"));
      const cell = (day: string, userId: string) => s.actionsByDay.find((a) => a.day === day && a.userId === userId);
      return (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
            <Kpi label="Tours de Mo" value={int(s.turns)} sub={`${mo.days} derniers jours`} />
            <Kpi label="Compris sans modèle" value={s.withoutModelPct === null ? "—" : `${s.withoutModelPct} %`} sub="navigation + chemin rapide + actions · cible 75 %" accent="emerald" />
            <Kpi label="Mal compris" value={s.misunderstoodPct === null ? "—" : `${s.misunderstoodPct.toLocaleString("fr-FR")} %`} sub={`reformulation < 60 s, « non », carte retirée, 👎, question sans réponse (${s.asksAbandoned}) · cible < 10 %`} accent="amber" />
            <Kpi label="Première carte (chemin rapide)" value={secs(s.byPath.find((p) => p.path === "quick")?.p50FirstCardMs ?? null)} sub="médiane · cible < 3 s" />
          </div>
          <Card className="overflow-x-auto">
            <table className="w-full text-sm" data-mo-measures>
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wide text-gray-500 border-b border-gray-800">
                  <th className="px-4 py-3 font-medium">Chemin</th>
                  <th className="px-4 py-3 font-medium text-right">Tours</th>
                  <th className="px-4 py-3 font-medium text-right">Première carte p50</th>
                  <th className="px-4 py-3 font-medium text-right">p90</th>
                  <th className="px-4 py-3 font-medium text-right">Réponse complète p50</th>
                  <th className="px-4 py-3 font-medium text-right">Mal compris</th>
                  <th className="px-4 py-3 font-medium">Cible</th>
                </tr>
              </thead>
              <tbody>
                {s.byPath.filter((p) => p.turns > 0).map((p) => {
                  const target = MO_TARGET_MS[p.path];
                  const ok = target !== undefined && p.p50FirstCardMs !== null ? p.p50FirstCardMs <= target : null;
                  return (
                    <tr key={p.path} className="border-b border-gray-800/60">
                      <td className="px-4 py-3 text-white font-medium">{MO_PATH_LABEL[p.path] ?? p.path}</td>
                      <td className="px-4 py-3 text-right text-gray-300 tabular-nums">{int(p.turns)}</td>
                      <td className={`px-4 py-3 text-right tabular-nums font-semibold ${ok === null ? "text-gray-300" : ok ? "text-emerald-300" : "text-amber-300"}`}>{secs(p.p50FirstCardMs)}</td>
                      <td className="px-4 py-3 text-right text-gray-300 tabular-nums">{secs(p.p90FirstCardMs)}</td>
                      <td className="px-4 py-3 text-right text-gray-400 tabular-nums">{secs(p.p50TotalMs)}</td>
                      <td className="px-4 py-3 text-right text-gray-300 tabular-nums">{p.misunderstood}{p.turns ? <span className="text-gray-500"> · {Math.round((p.misunderstood / p.turns) * 100)} %</span> : null}</td>
                      <td className="px-4 py-3 text-xs text-gray-500">{target !== undefined ? `p50 < ${secs(target)}` : p.path === "ask" ? "puce cliquée = compris" : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Card>
          <div>
            <h3 className="text-sm font-semibold text-white">Travail réel : actions par jour et par consultant</h3>
            <p className="text-xs text-gray-500 mb-2">Verdicts, publications préparées / confirmées, fichiers déposés, visuels générés, envois Drive — la preuve que Mo est l&apos;endroit où l&apos;on travaille.</p>
            {s.actionsByDay.length === 0 ? <Card padded><p className="text-sm text-gray-400">Aucune action sur la période.</p></Card> : (
              <Card className="overflow-x-auto">
                <table className="w-full text-sm" data-mo-actions>
                  <thead>
                    <tr className="text-left text-[11px] uppercase tracking-wide text-gray-500 border-b border-gray-800">
                      <th className="px-4 py-3 font-medium">Consultant</th>
                      {days.map((d) => <th key={d} className="px-4 py-3 font-medium text-right">{new Date(`${d}T12:00:00Z`).toLocaleDateString("fr-FR", { weekday: "short", day: "2-digit", month: "2-digit" })}</th>)}
                      <th className="px-4 py-3 font-medium text-right">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {people.map((u) => {
                      const total = s.actionsByDay.filter((a) => a.userId === u).reduce((t, a) => t + a.actions, 0);
                      return (
                        <tr key={u} className="border-b border-gray-800/60">
                          <td className="px-4 py-3 text-white font-medium">{mo.people[u] ?? u}</td>
                          {days.map((d) => { const c = cell(d, u); return <td key={d} className="px-4 py-3 text-right text-gray-300 tabular-nums" title={c ? Object.entries(c.kinds).map(([k, n]) => `${n} ${MO_KIND_LABEL[k] ?? k}`).join(", ") : ""}>{c ? int(c.actions) : <span className="text-gray-700">·</span>}</td>; })}
                          <td className="px-4 py-3 text-right font-semibold text-white tabular-nums">{int(total)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </Card>
            )}
          </div>
        </>
      );
    })();
  return (
    <section className="space-y-3" data-mo-block>
      <div>
        <h2 className="text-base font-semibold text-white">Mo : vitesse et compréhension</h2>
        <p className="text-xs text-gray-500">
          Les 7 derniers jours, tous consultants. « Première carte » = de l&apos;envoi à la première carte pleine (mesuré dans le navigateur) ; « compris sans modèle » = part des demandes résolues par la navigation, le chemin rapide et les actions ; « mal compris » = reformulation dans la minute, « non / pas ça », carte retirée dans les 30 s, 👎 ou question de Mo restée sans réponse. La part des tours modèle en session reprise se lit dans le journal du relay (journalctl -u impulsemotion-relay), pas ici.
        </p>
      </div>
      {body}
    </section>
  );
}

function currentMonth(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function QuotaBar({ label, window, warn, limit }: { label: string; window: Quota["fiveHour"]; warn: number; limit: number }) {
  const pct = Math.max(0, Math.min(100, Math.round(window?.utilization ?? 0)));
  const tone = pct >= limit ? "bg-red-500" : pct >= warn ? "bg-amber-400" : "bg-emerald-500";
  const resets = window?.resetsAt ? new Date(window.resetsAt).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—";
  return (
    <Card padded>
      <div className="text-[11px] uppercase tracking-wider text-gray-500 font-semibold">{label}</div>
      <div className="mt-1 text-2xl font-bold text-white tabular-nums">{pct} %</div>
      <div className="mt-2 h-2 rounded-full bg-gray-800 overflow-hidden">
        <div className={`h-full ${tone}`} style={{ width: `${pct}%` }} />
      </div>
      <div className="text-xs text-gray-500 mt-2">remise à zéro {resets}</div>
    </Card>
  );
}

function TokenCells({ t, className }: { t: Totals; className: string }) {
  return (
    <>
      <td className={className}>{int(t.messages)}</td>
      <td className={className}>{int(t.inputTokens)}</td>
      <td className={className}>{int(t.cacheWriteTokens)}</td>
      <td className={className}>{int(t.cacheReadTokens)}</td>
      <td className={className}>{int(t.outputTokens)}</td>
    </>
  );
}

export default function AdminUsagePage() {
  const [month, setMonth] = useState(currentMonth);
  const [clients, setClients] = useState<ClientUsage[]>([]);
  const [features, setFeatures] = useState<FeatureUsage[]>([]);
  const [profiles, setProfiles] = useState<ProfileUsage[]>([]);
  const [openProfile, setOpenProfile] = useState<string | null>(null);
  const [quota, setQuota] = useState<Quota | null>(null);
  const [quotaError, setQuotaError] = useState<string | null>(null);
  const [mo, setMo] = useState<MoMeasures | null>(null);

  useEffect(() => {
    fetch("/api/admin/quota")
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `Erreur ${res.status}`);
        setQuota(data);
      })
      .catch((e) => setQuotaError(e instanceof Error ? e.message : "Erreur"));
  }, []);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openKey, setOpenKey] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/admin/usage?month=${month}`)
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `Erreur ${res.status}`);
        setClients(data.clients ?? []);
        setFeatures(data.features ?? []);
        setProfiles(data.profiles ?? []);
        setMo(data.mo ?? null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Erreur"))
      .finally(() => setLoading(false));
  }, [month]);

  const total = useMemo(
    () =>
      clients.reduce(
        (t, c) => ({
          messages: t.messages + c.billable.messages,
          input: t.input + c.billable.inputTokens + c.billable.cacheWriteTokens + c.billable.cacheReadTokens,
          output: t.output + c.billable.outputTokens,
        }),
        { messages: 0, input: 0, output: 0 },
      ),
    [clients],
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Consommation IA"
        subtitle="Ce qui tourne sur Amazon Bedrock — les bots privés des clients — par client et par mois, pour facturer à l'usage."
        action={
          <div className="flex items-center gap-2">
            <input
              type="month" value={month} max={currentMonth()} onChange={(e) => {
                if (!e.target.value) return;
                setLoading(true);
                setError(null);
                setMonth(e.target.value);
              }}
              className="px-3 py-2 rounded-lg text-sm bg-gray-950 border border-gray-800 text-white focus:border-violet-500 focus:outline-none"
            />
            <a
              href={`/api/admin/usage?month=${month}&format=csv`}
              className="px-3 py-2 rounded-lg text-xs font-semibold bg-violet-600 hover:bg-violet-500 text-white transition-colors"
            >
              Export CSV
            </a>
          </div>
        }
      />

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Kpi label="Messages facturables" value={int(total.messages)} sub="envoyés par des comptes clients" />
        <Kpi label="Tokens envoyés au modèle" value={int(total.input)} sub="entrée + cache écrit + cache lu" accent="emerald" />
        <Kpi label="Tokens générés" value={int(total.output)} sub="sortie" accent="amber" />
      </div>

      <p className="text-xs text-gray-500">
        Compteurs renvoyés par Bedrock à chaque réponse. AWS facture les quatre types à des prix différents
        (le cache écrit coûte plus cher que l&apos;entrée, le cache lu beaucoup moins) : ils restent séparés pour ton calcul.
        Les tests faits par un admin ou un consultant sont comptés à part.
      </p>

      {error && <p className="text-sm text-red-400">{error}</p>}
      {loading && <p className="text-sm text-gray-500">Chargement…</p>}
      {!loading && !error && clients.length === 0 && (
        <Card padded>
          <p className="text-sm text-gray-400">Aucune consommation Bedrock ce mois-ci.</p>
          <p className="text-xs text-gray-500 mt-1">Le suivi démarre à la première réponse d&apos;un bot client.</p>
        </Card>
      )}

      <section className="space-y-2">
        <h2 className="text-base font-semibold text-white">Abonnement Claude Max</h2>
        <p className="text-xs text-gray-500">
          Utilisation de l&apos;abonnement qui fait tourner les chats, rapports et analyses. Au-delà du seuil de bascule, le relay envoie les chats de l&apos;équipe sur un autre compte Claude Max jusqu&apos;à la remise à zéro de la fenêtre. Amazon Bedrock reste réservé aux bots clients.
        </p>
        {quotaError && <Card padded><p className="text-sm text-red-400">Quota indisponible : {quotaError}</p></Card>}
        {quota && (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <QuotaBar label="Fenêtre 5 heures" window={quota.fiveHour} warn={quota.warnPct} limit={quota.switchPct} />
            <QuotaBar label="Fenêtre 7 jours" window={quota.sevenDay} warn={quota.warnPct} limit={quota.switchPct} />
            <Card padded>
              <div className="text-[11px] uppercase tracking-wider text-gray-500 font-semibold">Mode actuel</div>
              <div className={`mt-1 text-lg font-bold ${quota.fallbackActive ? "text-amber-300" : "text-emerald-300"}`}>
                {quota.fallbackActive ? "Autre compte Claude Max (bascule)" : "Abonnement Claude"}
              </div>
              <div className="text-xs text-gray-500 mt-1">
                {quota.fallbackActive
                  ? `Compte saturé : l'équipe passe sur un autre compte Claude Max, retour ${quota.exhaustedUntil ? `vers ${new Date(quota.exhaustedUntil).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}` : "à la prochaine fenêtre"}`
                  : `Bascule sur un autre compte Claude Max à ${quota.switchPct} % · un seul message Slack, quand le quota est atteint`}
              </div>
              {quota.checkedAt && <div className="text-[11px] text-gray-600 mt-2">vérifié à {new Date(quota.checkedAt).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}{quota.error ? ` · erreur : ${quota.error}` : ""}</div>}
            </Card>
          </div>
        )}
      </section>

      <MaxAccountsPanel warnPct={quota?.warnPct ?? 80} switchPct={quota?.switchPct ?? 95} />

      <MoMeasuresBlock mo={mo} />

      <section className="space-y-2">
        <h2 className="text-base font-semibold text-white">Où partent les tokens (toutes surfaces)</h2>
        <p className="text-xs text-gray-500">
          Toutes les sessions IA du mois, abonnement compris : par surface, modèle et effort. « Tokens / message » = poids moyen d&apos;une réponse,
          tous compteurs confondus — c&apos;est le chiffre à faire baisser.
        </p>
        {features.length === 0 ? (
          <Card padded><p className="text-sm text-gray-400">Aucune session enregistrée ce mois-ci.</p></Card>
        ) : (
          <Card className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wide text-gray-500 border-b border-gray-800">
                  <th className="px-4 py-3 font-medium">Surface</th>
                  <th className="px-4 py-3 font-medium">Modèle</th>
                  <th className="px-4 py-3 font-medium text-right">Messages</th>
                  <th className="px-4 py-3 font-medium text-right">Entrée</th>
                  <th className="px-4 py-3 font-medium text-right">Cache écrit</th>
                  <th className="px-4 py-3 font-medium text-right">Cache lu</th>
                  <th className="px-4 py-3 font-medium text-right">Sortie</th>
                  <th className="px-4 py-3 font-medium text-right">Tokens / message</th>
                  <th className="px-4 py-3 font-medium text-right">Tours / message</th>
                </tr>
              </thead>
              <tbody>
                {features.map((f) => (
                  <tr key={`${f.feature}|${f.provider}|${f.model}`} className="border-b border-gray-800/60">
                    <td className="px-4 py-3 text-white font-medium">{FEATURE_LABEL[f.feature] ?? f.feature}</td>
                    <td className="px-4 py-3 text-gray-400 text-xs">{f.model}<span className="text-gray-600"> · {f.provider === "bedrock" ? "Bedrock" : "abonnement"}</span></td>
                    <TokenCells t={f} className="px-4 py-3 text-right text-gray-300" />
                    <td className="px-4 py-3 text-right text-amber-300 tabular-nums">{int(f.avgTokensPerMessage)}</td>
                    <td className="px-4 py-3 text-right text-gray-500 tabular-nums">{f.messages ? (f.turns / f.messages).toFixed(1) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </section>

      <section className="space-y-2">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 className="text-base font-semibold text-white">Consommation par profil</h2>
            <p className="text-xs text-gray-500">
              Ce que chaque personne a consommé ce mois-ci, toutes surfaces confondues. « Automatique » = ce que l&apos;application lance seule
              (rapports programmés, alertes). Cliquez sur une ligne pour le détail par surface.
            </p>
          </div>
          {profiles.length > 0 && (
            <a href={`/api/admin/usage?month=${month}&format=csv&by=profile`} className="rounded-lg border border-gray-800 bg-gray-900 px-3 py-1.5 text-xs font-medium text-gray-300 hover:bg-gray-800">
              Exporter en CSV
            </a>
          )}
        </div>
        {profiles.length === 0 ? (
          <Card padded><p className="text-sm text-gray-400">Aucune session enregistrée ce mois-ci.</p></Card>
        ) : (
          <Card className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wide text-gray-500 border-b border-gray-800">
                  <th className="px-4 py-3 font-medium">Profil</th>
                  <th className="px-4 py-3 font-medium">Rôle</th>
                  <th className="px-4 py-3 font-medium text-right">Messages</th>
                  <th className="px-4 py-3 font-medium text-right">Entrée</th>
                  <th className="px-4 py-3 font-medium text-right">Cache écrit</th>
                  <th className="px-4 py-3 font-medium text-right">Cache lu</th>
                  <th className="px-4 py-3 font-medium text-right">Sortie</th>
                  <th className="px-4 py-3 font-medium text-right">Total tokens</th>
                  <th className="px-4 py-3 font-medium">Part du mois</th>
                </tr>
              </thead>
              <tbody>
                {profiles.map((p) => {
                  const isOpen = openProfile === p.key;
                  const label = p.key === "system" ? "Automatique" : p.name || p.email || "Profil inconnu";
                  return (
                    <Fragment key={p.key}>
                      <tr className="border-b border-gray-800/60 hover:bg-gray-900/60">
                        <td className="px-4 py-3">
                          <button type="button" onClick={() => setOpenProfile(isOpen ? null : p.key)} aria-expanded={isOpen} className="text-left">
                            <span className="font-medium text-white">{isOpen ? "▾" : "▸"} {label}</span>
                            {p.email && p.name && <span className="block text-[11px] text-gray-500">{p.email}</span>}
                          </button>
                        </td>
                        <td className="px-4 py-3 text-xs text-gray-400">{ROLE_LABEL[p.role] ?? p.role}</td>
                        <TokenCells t={p} className="px-4 py-3 text-right text-gray-300 tabular-nums" />
                        <td className="px-4 py-3 text-right font-semibold text-white tabular-nums">{int(p.tokens)}</td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <div className="h-1.5 w-24 overflow-hidden rounded-full bg-gray-800">
                              <div className="h-full bg-violet-500" style={{ width: `${Math.max(1, Math.round(p.share * 100))}%` }} />
                            </div>
                            <span className="text-xs text-gray-400 tabular-nums">{Math.round(p.share * 100)} %</span>
                          </div>
                          {p.bedrockTokens > 0 && <span className="text-[10px] text-amber-300">dont {int(p.bedrockTokens)} sur Bedrock</span>}
                        </td>
                      </tr>
                      {isOpen && p.features.map((f) => (
                        <tr key={`${p.key}|${f.feature}`} className="border-b border-gray-800/40 bg-gray-950/60 text-xs">
                          <td className="px-4 py-2 pl-9 text-gray-300">{FEATURE_LABEL[f.feature] ?? f.feature}</td>
                          <td className="px-4 py-2" />
                          <TokenCells t={f} className="px-4 py-2 text-right text-gray-400 tabular-nums" />
                          <td className="px-4 py-2 text-right text-gray-200 tabular-nums">{int(f.tokens)}</td>
                          <td className="px-4 py-2 text-gray-500 tabular-nums">{p.tokens ? Math.round((f.tokens / p.tokens) * 100) : 0} % de ce profil</td>
                        </tr>
                      ))}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </Card>
        )}
      </section>

      <h2 className="text-base font-semibold text-white">Bedrock — facturation par client</h2>
      {clients.length > 0 && (
        <Card className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-gray-500 border-b border-gray-800">
                <th className="px-4 py-3 font-medium">Client</th>
                <th className="px-4 py-3 font-medium text-right">Messages</th>
                <th className="px-4 py-3 font-medium text-right">Entrée</th>
                <th className="px-4 py-3 font-medium text-right">Cache écrit</th>
                <th className="px-4 py-3 font-medium text-right">Cache lu</th>
                <th className="px-4 py-3 font-medium text-right">Sortie</th>
                <th className="px-4 py-3 font-medium text-right">Tests staff (msg)</th>
              </tr>
            </thead>
            <tbody>
              {clients.map((c) => (
                <Fragment key={c.key}>
                  <tr
                    onClick={() => setOpenKey(openKey === c.key ? null : c.key)}
                    className="border-b border-gray-800/60 hover:bg-gray-800/40 cursor-pointer"
                  >
                    <td className="px-4 py-3 text-white font-medium">
                      {c.clientName}
                      {c.clientKey && <span className="ml-2 text-xs text-gray-500">{c.clientKey}</span>}
                    </td>
                    <TokenCells t={c.billable} className="px-4 py-3 text-right text-gray-300" />
                    <td className="px-4 py-3 text-right text-gray-500">{int(c.staff.messages)}</td>
                  </tr>
                  {openKey === c.key &&
                    c.users.map((u) => (
                      <tr key={`${c.key}:${u.email}`} className="border-b border-gray-800/40 bg-gray-950/60 text-xs">
                        <td className="px-4 py-2 pl-8 text-gray-400">
                          {u.email} <Pill tone={u.role === "client" ? "blue" : "default"} className="ml-1">{u.role === "client" ? "client" : `${u.role} · non facturé`}</Pill>
                        </td>
                        <TokenCells t={u} className="px-4 py-2 text-right text-gray-400" />
                        <td className="px-4 py-2" />
                      </tr>
                    ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
