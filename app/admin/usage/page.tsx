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

type Totals = { messages: number; inputTokens: number; cacheWriteTokens: number; cacheReadTokens: number; outputTokens: number };
type FeatureUsage = Totals & { feature: string; provider: string; model: string; turns: number; avgTokensPerMessage: number };
const FEATURE_LABEL: Record<string, string> = {
  client_bot: "Bots clients",
  console: "Console /ai",
  copilot: "Copilote dashboard",
  report: "Rapport IA (rédaction)",
  report_chat: "Chat rapport",
  creative_analysis: "Analyse créas",
  recommend: "Plan d'action alertes",
  hq_context: "Contexte HQ client",
  alert_compose: "Rédaction d'alerte (IA)",
  alert_ai: "Alertes IA (scan quotidien)",
};
type ClientUsage = {
  key: string;
  clientName: string;
  clientKey: string | null;
  billable: Totals;
  staff: Totals;
  users: Array<{ email: string; role: string } & Totals>;
};

const int = (n: number) => n.toLocaleString("fr-FR");

function currentMonth(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
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
