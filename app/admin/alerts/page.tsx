"use client";

import { useEffect, useMemo, useState, useCallback } from "react";
import { useSession } from "next-auth/react";
import { Section, PageHeader, Pill, Card } from "@/components/ui/surface";
import {
  type AlertDraft,
  type AlertRuleExt,
  AlertRuleFields,
  CONDITIONS,
  ComposeBlock,
  EMPTY_DRAFT,
  PlatformSwitch,
  applyProposal,
  draftToBody,
  ruleMode,
  ruleTitle,
  withPlatform,
} from "@/components/alerts/alert-rule-form";
import { AlertEventsList, RuleDetails, RuleKindPills } from "@/components/alerts/alert-rule-list";

function NotifyPills({ json }: { json?: string }) {
  let n: { slackChannel?: string; emails?: string[] } = {};
  try { n = json ? JSON.parse(json) : {}; } catch { n = {}; }
  if (!n.slackChannel && !(n.emails && n.emails.length)) return null;
  return (
    <span className="inline-flex items-center gap-1 ml-1" title={[n.slackChannel, ...(n.emails ?? [])].filter(Boolean).join(" · ")}>
      {n.slackChannel && <Pill tone="blue">Slack {n.slackChannel}</Pill>}
      {n.emails && n.emails.length > 0 && <Pill tone="blue">{n.emails.length} e-mail{n.emails.length > 1 ? "s" : ""}</Pill>}
    </span>
  );
}

type Rule = AlertRuleExt & {
  id: string;
  userId: string;
  clientId: string | null;
  platform: string;
  enabled: boolean;
  notifyJson?: string;
  lastTriggeredAt: string | null;
  user: { email: string | null; name: string | null };
  _count: { events: number };
};

type ClientUser = {
  id: string;
  email: string | null;
  name: string | null;
  role?: string;
  adAccounts: { platform: string; accountId: string; label: string | null }[];
};

const inputCls =
  "mt-1 w-full px-3 py-2 rounded-lg text-sm bg-gray-950 border border-gray-800 text-white focus:border-violet-500 focus:outline-none";
const labelSpanCls = "text-xs text-gray-400";
const primaryBtnCls =
  "px-4 py-2 rounded-lg font-semibold text-sm bg-violet-600 hover:bg-violet-500 text-white transition-colors";
const secondaryBtnCls =
  "px-3 py-2 rounded-lg text-sm font-medium bg-violet-500/10 hover:bg-violet-500/20 text-violet-300 border border-violet-500/30 transition-colors";

export default function AdminAlertsPage() {
  const { data: session } = useSession();
  // Only admins manage logins & ACL (/api/admin/users is admin-only). A
  // consultant arms alerts for themselves, on their own assigned accounts —
  // asking them to pick a client login would show an empty, unusable select.
  const isAdmin = session?.role === "admin";
  const [rules, setRules] = useState<Rule[]>([]);
  const [users, setUsers] = useState<ClientUser[]>([]);
  const [ownAccounts, setOwnAccounts] = useState<{ platform: string; accountId: string; label: string | null }[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [formUserId, setFormUserId] = useState("");
  const [formAccountId, setFormAccountId] = useState("");
  // Metric / condition / threshold / window / notify + the new level / filter /
  // mode / prompt / label all live in one draft shared with the /me page.
  const [draft, setDraft] = useState<AlertDraft>(EMPTY_DRAFT);
  const patchDraft = useCallback((patch: Partial<AlertDraft>) => setDraft((d) => ({ ...d, ...patch })), []);
  const [eventsKey, setEventsKey] = useState(0);
  const [error, setError] = useState<string | null>(null);
  // TODO (Lot F4): rules are still attached to a login + raw account id; redesign "per dashboard" (client = ad account).

  const load = useCallback(async () => {
    try {
      const [r, u] = await Promise.all([
        fetch("/api/admin/alerts").then((res) => (res.ok ? res.json() : { rules: [] })).catch(() => ({ rules: [] })),
        isAdmin
          ? fetch("/api/admin/users").then((res) => (res.ok ? res.json() : { users: [] })).catch(() => ({ users: [] }))
          : fetch("/api/me/accounts").then((res) => (res.ok ? res.json() : { accounts: [] })).catch(() => ({ accounts: [] })),
      ]);
      setRules(Array.isArray(r?.rules) ? r.rules : []);
      if (isAdmin) {
        setUsers((Array.isArray(u?.users) ? u.users : []).map((x: ClientUser) => ({ ...x, adAccounts: Array.isArray(x.adAccounts) ? x.adAccounts : [] })));
      } else {
        setOwnAccounts(Array.isArray(u?.accounts) ? u.accounts : []);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Chargement impossible");
    } finally {
      setLoading(false);
    }
  }, [isAdmin]);

  useEffect(() => {
    // Wait for the session: the role decides which sources we load.
    if (session === undefined) return;
    load();
  }, [load, session]);

  const selectedUser = users.find((u) => u.id === formUserId);
  // Accounts offered in the form: the selected consultant's (admin) or one's
  // own, restricted to the chosen platform (clientId = that platform's account id).
  const accountOptions = (isAdmin ? (selectedUser?.adAccounts ?? []) : ownAccounts).filter((a) => a.platform === draft.platform);

  const accountPool = useMemo(
    () => (isAdmin ? users.flatMap((u) => u.adAccounts ?? []) : ownAccounts),
    [isAdmin, users, ownAccounts],
  );
  const accountLabelFor = useCallback(
    (clientId: string) => accountPool.find((a) => a.accountId === clientId)?.label ?? clientId,
    [accountPool],
  );
  // Events don't carry the platform → resolved from the accounts we already hold.
  const accountPlatformFor = useCallback(
    (clientId: string) => accountPool.find((a) => a.accountId === clientId)?.platform ?? null,
    [accountPool],
  );

  function changePlatform(platform: AlertDraft["platform"]) {
    setDraft((d) => withPlatform(d, platform));
    setFormAccountId("");
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const res = await fetch("/api/admin/alerts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: isAdmin ? formUserId : session?.userId,
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
    setFormUserId("");
    setFormAccountId("");
    setDraft(EMPTY_DRAFT);
    load();
  }

  async function handleToggle(r: Rule) {
    await fetch(`/api/admin/alerts/${r.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: !r.enabled }),
    });
    load();
  }

  async function handleDelete(id: string) {
    if (!confirm("Supprimer cette règle ?")) return;
    await fetch(`/api/admin/alerts/${id}`, { method: "DELETE" });
    load();
  }

  async function runScan() {
    setError(null);
    try {
      const res = await fetch("/api/cron/alerts");
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(res.status === 401 ? "Scan manuel non autorisé depuis le navigateur (le cron utilise CRON_SECRET) — il tourne automatiquement à 08h UTC." : (data.error ?? `Erreur ${res.status}`));
        return;
      }
      alert(`${data.scanned ?? 0} règle(s) scannée(s), ${data.triggered ?? 0} déclenchée(s).${data.skipped?.length ? `\nIgnorées : ${data.skipped.join(" · ")}` : ""}`);
      load();
      setEventsKey((k) => k + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Scan impossible");
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Alertes"
        subtitle="Détection proactive d'anomalies sur Meta Ads et Google Ads (ROAS, CPA, CTR, dépenses, fréquence)."
        action={
          <div className="flex gap-2">
            <button onClick={runScan} className={secondaryBtnCls}>
              Scanner maintenant
            </button>
            <button onClick={() => setShowCreate((s) => !s)} className={primaryBtnCls}>
              + Nouvelle règle
            </button>
          </div>
        }
      />

      {showCreate && (
        <Card padded>
          <form onSubmit={handleCreate} className="space-y-3">
            <ComposeBlock
              text={draft.description}
              onTextChange={(description) => patchDraft({ description })}
              accountId={formAccountId || null}
              platform={draft.platform}
              onProposal={(proposal, text) => {
                // A proposal may switch platform: the account picked for the other one no longer applies.
                if (proposal.platform && proposal.platform !== draft.platform) setFormAccountId("");
                setDraft((d) => applyProposal(d, proposal, text));
              }}
              classes={{ input: inputCls, label: labelSpanCls }}
            />
            <div className="grid grid-cols-2 gap-3">
              {isAdmin && (
                <label className="block">
                  <span className={labelSpanCls}>Consultant</span>
                  <select
                    value={formUserId}
                    onChange={(e) => { setFormUserId(e.target.value); setFormAccountId(""); }}
                    required
                    className={inputCls}
                  >
                    <option value="">— Sélectionner —</option>
                    {users
                      .filter((u) => (u.adAccounts ?? []).length > 0)
                      .sort((a, b) => Number(a.role === "client") - Number(b.role === "client") || (a.email ?? "").localeCompare(b.email ?? ""))
                      .map((u) => (
                        <option key={u.id} value={u.id}>{u.email ?? u.id}{u.role === "client" ? " (client)" : ""}</option>
                      ))}
                  </select>
                </label>
              )}
              <PlatformSwitch value={draft.platform} onChange={changePlatform} classes={{ input: inputCls, label: labelSpanCls }} />
              <label className="block">
                <span className={labelSpanCls}>{isAdmin ? "Compte (vide = tous)" : "Compte"}</span>
                <select
                  value={formAccountId}
                  onChange={(e) => setFormAccountId(e.target.value)}
                  disabled={isAdmin && !selectedUser}
                  required={!isAdmin}
                  className={`${inputCls} disabled:opacity-50`}
                >
                  {/* An account-agnostic rule spans every account of the platform → admins only. */}
                  <option value="">{isAdmin ? `Tous (${draft.platform === "google" ? "Google Ads" : "Meta Ads"})` : "— Sélectionner —"}</option>
                  {accountOptions.map((a) => (
                    <option key={a.accountId} value={a.accountId}>{a.label ?? a.accountId}</option>
                  ))}
                </select>
              </label>
              <AlertRuleFields draft={draft} onChange={patchDraft} classes={{ input: inputCls, label: labelSpanCls }} />
            </div>
            <div className="flex gap-2 justify-end">
              <button type="button" onClick={() => setShowCreate(false)} className="px-3 py-1.5 rounded-lg text-sm text-gray-400 hover:text-white">
                Annuler
              </button>
              <button type="submit" className={primaryBtnCls.replace("py-2", "py-1.5")}>
                Créer
              </button>
            </div>
          </form>
        </Card>
      )}

      {error && <p className="text-sm text-red-400">{error}</p>}

      {loading ? (
        <p className="text-gray-400">Chargement…</p>
      ) : rules.length === 0 ? (
        <Card padded className="text-center text-gray-500 border-dashed space-y-2">
          <p>Aucune règle d&apos;alerte configurée — le cockpit n&apos;affichera donc aucune alerte.</p>
          <p className="text-xs">Exemple : ROAS Meta en dessous de 1,5 sur 7 jours, ou mot-clé Google à plus de 100 € sans conversion. Les règles ROAS sont ignorées quand le revenu est indisponible.</p>
          <button onClick={() => setShowCreate(true)} className={primaryBtnCls}>+ Créer une première règle</button>
        </Card>
      ) : (
        <div className="space-y-2">
          {rules.map((r) => (
            <Card key={r.id} padded className="flex items-center justify-between">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <Pill className="font-mono">{ruleTitle(r)}</Pill>
                  <RuleKindPills rule={r} />
                  {ruleMode(r) !== "ai" && (
                    <>
                      <span className="text-sm text-gray-400">
                        {CONDITIONS.find((c) => c.value === r.condition)?.label ?? r.condition}
                      </span>
                      <span className="font-semibold text-white">
                        {r.threshold}{r.condition === "drop_pct" ? "%" : ""}
                      </span>
                    </>
                  )}
                  <Pill tone="violet">{r.window}</Pill>
                  <NotifyPills json={r.notifyJson} />
                  <Pill tone={r.enabled ? "emerald" : "default"}>{r.enabled ? "actif" : "désactivé"}</Pill>
                </div>
                <div className="text-xs mt-1 text-gray-400">
                  {r.user?.email ?? r.userId} · {r.clientId ?? "tous comptes"} · {r._count.events} déclenchement{r._count.events > 1 ? "s" : ""}
                  {r.lastTriggeredAt && <> · dernier : {new Date(r.lastTriggeredAt).toLocaleString("fr-FR")}</>}
                </div>
                <RuleDetails rule={r} />
              </div>
              <div className="flex gap-2 shrink-0">
                <button onClick={() => handleToggle(r)} className="text-xs px-2 py-1 rounded text-gray-400 hover:text-white">
                  {r.enabled ? "Désactiver" : "Activer"}
                </button>
                <button onClick={() => handleDelete(r.id)} className="text-xs px-2 py-1 rounded text-red-400 hover:text-red-300">
                  Supprimer
                </button>
              </div>
            </Card>
          ))}
        </div>
      )}

      <Section title="Derniers déclenchements" bodyClassName="px-4 py-2">
        <AlertEventsList refreshKey={eventsKey} accountLabel={accountLabelFor} accountPlatform={accountPlatformFor} />
      </Section>
    </div>
  );
}
