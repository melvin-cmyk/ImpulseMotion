"use client";

import { useEffect, useState, useCallback } from "react";
import {
  type AlertDraft,
  type AlertRuleExt,
  AlertRuleFields,
  CONDITIONS,
  ComposeBlock,
  EMPTY_DRAFT,
  applyProposal,
  draftToBody,
  ruleMode,
  ruleTitle,
} from "@/components/alerts/alert-rule-form";
import { AlertEventsList, RuleDetails, RuleKindPills } from "@/components/alerts/alert-rule-list";

function notifyLabel(json?: string): string | null {
  let n: { slackChannel?: string; emails?: string[] } = {};
  try { n = json ? JSON.parse(json) : {}; } catch { n = {}; }
  const parts = [n.slackChannel ? `Slack ${n.slackChannel}` : null, n.emails?.length ? `${n.emails.length} e-mail${n.emails.length > 1 ? "s" : ""}` : null].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

type Rule = AlertRuleExt & {
  id: string;
  clientId: string | null;
  platform: string;
  enabled: boolean;
  lastTriggeredAt: string | null;
  _count: { events: number };
  notifyJson?: string;
};

type Account = { platform: string; accountId: string; label: string | null };

const inputCls = "mt-1 w-full px-3 py-2 rounded-lg text-sm bg-black/40 border border-gray-800 text-white";
const labelCls = "text-xs text-gray-400";

export default function MeAlertsPage() {
  const [rules, setRules] = useState<Rule[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [formAccountId, setFormAccountId] = useState("");
  // Metric / condition / threshold / window / notify + level / filter / mode /
  // prompt / label in one draft shared with the admin page.
  const [draft, setDraft] = useState<AlertDraft>(EMPTY_DRAFT);
  const patchDraft = useCallback((patch: Partial<AlertDraft>) => setDraft((d) => ({ ...d, ...patch })), []);
  const [eventsKey, setEventsKey] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [r, a] = await Promise.all([
        fetch("/api/me/alerts").then((res) => (res.ok ? res.json() : { rules: [] })).catch(() => ({ rules: [] })),
        fetch("/api/me/accounts").then((res) => (res.ok ? res.json() : { accounts: [] })).catch(() => ({ accounts: [] })),
      ]);
      setRules(Array.isArray(r?.rules) ? r.rules : []);
      setAccounts(Array.isArray(a?.accounts) ? a.accounts : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Chargement impossible");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const accountLabelFor = useCallback(
    (clientId: string) => accounts.find((a) => a.accountId === clientId)?.label ?? clientId,
    [accounts],
  );

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const res = await fetch("/api/me/alerts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientId: formAccountId || null,
        ...draftToBody(draft),
      }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? "Création échouée");
      return;
    }
    setShowCreate(false);
    setFormAccountId("");
    setDraft(EMPTY_DRAFT);
    setEventsKey((k) => k + 1);
    load();
  }

  async function handleToggle(r: Rule) {
    await fetch(`/api/me/alerts/${r.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: !r.enabled }),
    });
    load();
  }

  async function handleDelete(id: string) {
    if (!confirm("Supprimer cette règle ?")) return;
    await fetch(`/api/me/alerts/${id}`, { method: "DELETE" });
    load();
  }

  return (
    <div className="p-6 space-y-4 max-w-4xl mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Mes alertes</h1>
          <p className="text-sm text-gray-400 mt-1">
            Détection proactive d&apos;anomalies sur tes comptes.
          </p>
        </div>
        <button
          onClick={() => setShowCreate((s) => !s)}
          className="px-4 py-2 rounded-lg font-semibold text-sm bg-gradient-to-br from-violet-600 to-purple-600 text-white"
        >
          + Nouvelle règle
        </button>
      </div>

      {showCreate && (
        <form onSubmit={handleCreate} className="p-5 rounded-xl space-y-3 bg-gray-900 border border-gray-800">
          <ComposeBlock
            text={draft.description}
            onTextChange={(description) => patchDraft({ description })}
            accountId={formAccountId || null}
            onProposal={(proposal, text) => setDraft((d) => applyProposal(d, proposal, text))}
            classes={{ input: inputCls, label: labelCls }}
          />
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className={labelCls}>Compte (vide = tous mes comptes)</span>
              <select
                value={formAccountId}
                onChange={(e) => setFormAccountId(e.target.value)}
                className={inputCls}
              >
                <option value="">Tous</option>
                {accounts.filter((a) => a.platform === "meta").map((a) => (
                  <option key={a.accountId} value={a.accountId}>{a.label ?? a.accountId}</option>
                ))}
              </select>
            </label>
            <AlertRuleFields draft={draft} onChange={patchDraft} classes={{ input: inputCls, label: labelCls }} />
          </div>
          {error && <p className="text-sm text-red-400">{error}</p>}
          <div className="flex gap-2 justify-end">
            <button type="button" onClick={() => setShowCreate(false)} className="px-3 py-1.5 rounded-lg text-sm text-gray-400">
              Annuler
            </button>
            <button type="submit" className="px-4 py-1.5 rounded-lg text-sm font-semibold bg-gradient-to-br from-violet-600 to-purple-600 text-white">
              Créer
            </button>
          </div>
        </form>
      )}

      {error && !showCreate && <p className="text-sm text-red-400">{error}</p>}

      {loading ? (
        <p className="text-gray-400">Chargement…</p>
      ) : rules.length === 0 ? (
        <div className="text-center py-12 text-gray-500 border border-dashed border-gray-800 rounded-2xl space-y-2">
          <p>Aucune règle d&apos;alerte configurée.</p>
          <p className="text-xs">Exemple : ROAS en dessous de 1,5 sur 7 jours.</p>
          <button onClick={() => setShowCreate(true)} className="px-4 py-2 rounded-lg font-semibold text-sm bg-gradient-to-br from-violet-600 to-purple-600 text-white">+ Créer une première règle</button>
        </div>
      ) : (
        <div className="space-y-2">
          {rules.map((r) => (
            <div key={r.id} className="p-4 rounded-xl bg-gray-900 border border-gray-800 flex items-center justify-between">
              <div className="flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-mono text-xs px-1.5 py-0.5 rounded bg-gray-800">
                    {ruleTitle(r)}
                  </span>
                  <RuleKindPills rule={r} />
                  {ruleMode(r) !== "ai" && (
                    <>
                      <span className="text-sm text-gray-400">
                        {CONDITIONS.find((c) => c.value === r.condition)?.label ?? r.condition}
                      </span>
                      <span className="font-semibold text-white">{r.threshold}{r.condition === "drop_pct" ? "%" : ""}</span>
                    </>
                  )}
                  <span className="text-xs px-1.5 py-0.5 rounded bg-violet-500/15 text-violet-300">{r.window}</span>
                  {notifyLabel(r.notifyJson) && <span className="text-xs px-1.5 py-0.5 rounded bg-sky-500/15 text-sky-300">{notifyLabel(r.notifyJson)}</span>}
                  {r.enabled ? (
                    <span className="text-xs px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-300 ml-2">actif</span>
                  ) : (
                    <span className="text-xs px-2 py-0.5 rounded bg-gray-800 text-gray-400 ml-2">désactivé</span>
                  )}
                </div>
                <div className="text-xs mt-1 text-gray-500">
                  {r.clientId ?? "tous mes comptes"} · {r._count.events} déclenchement{r._count.events > 1 ? "s" : ""}
                  {r.lastTriggeredAt && <> · dernier : {new Date(r.lastTriggeredAt).toLocaleString("fr-FR")}</>}
                </div>
                <RuleDetails rule={r} />
              </div>
              <div className="flex gap-2">
                <button onClick={() => handleToggle(r)} className="text-xs px-2 py-1 text-gray-400 hover:text-white">
                  {r.enabled ? "Désactiver" : "Activer"}
                </button>
                <button onClick={() => handleDelete(r.id)} className="text-xs px-2 py-1 text-red-400 hover:text-red-300">
                  Supprimer
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <section className="rounded-xl bg-gray-900 border border-gray-800">
        <header className="px-4 py-3 border-b border-gray-800">
          <h2 className="text-sm font-semibold text-white">Derniers déclenchements</h2>
        </header>
        <div className="px-4 py-2">
          <AlertEventsList refreshKey={eventsKey} accountLabel={accountLabelFor} />
        </div>
      </section>
    </div>
  );
}
