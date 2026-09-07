"use client";

import { useEffect, useState, useCallback, use } from "react";
import Link from "next/link";
import { Card, Pill } from "@/components/ui/surface";

type BotSources = { meta?: boolean; google?: boolean; ga4PropertyId?: string; data?: boolean };
type Dashboard = {
  id: string;
  name: string;
  metaAccountId: string | null;
  googleCustomerId: string | null;
  ownerEmail: string | null;
};
type Bot = {
  id: string;
  enabled: boolean;
  name: string;
  clientKey: string;
  businessContext: string;
  sources: BotSources;
  lastIngestAt: string | null;
  lastIngestRows: number | null;
  updatedAt: string;
};
type Access = { userId: string; email: string | null; name: string | null; role: string; createdAt: string };
type Payload = {
  dashboard: Dashboard;
  bot: Bot | null;
  accesses: Access[];
  ingestConfigured: boolean;
  suggestedClientKey: string;
};

type FormState = {
  enabled: boolean;
  name: string;
  clientKey: string;
  businessContext: string;
  sources: BotSources;
};

const inputCls =
  "px-3 py-2 rounded-lg text-sm bg-gray-950 border border-gray-800 text-white focus:border-violet-500 focus:outline-none";
const sectionTitleCls = "text-sm font-bold uppercase tracking-wider mb-3 text-violet-300";
const primaryBtnCls =
  "px-4 py-2 rounded-lg font-semibold text-sm bg-violet-600 hover:bg-violet-500 text-white transition-colors disabled:opacity-50";
const secondaryBtnCls =
  "px-4 py-2 rounded-lg font-semibold text-sm bg-violet-500/10 hover:bg-violet-500/20 text-violet-300 border border-violet-500/30 transition-colors disabled:opacity-50";
const dangerBtnCls =
  "text-xs px-2 py-1 rounded bg-red-500/10 hover:bg-red-500/20 text-red-300 border border-red-500/30 transition-colors";

const CONTEXT_HELP =
  "Ce que le bot doit savoir du client : produits et gammes, positionnement, KPI cibles (ROAS, CPA, panier moyen), saisonnalité, canaux, vocabulaire interne, ce qu'il ne doit pas aborder…";

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" });
}

function formToState(bot: Bot | null, dashboard: Dashboard, suggestedClientKey: string): FormState {
  if (bot) {
    return {
      enabled: bot.enabled,
      name: bot.name,
      clientKey: bot.clientKey,
      businessContext: bot.businessContext,
      sources: { ...bot.sources },
    };
  }
  return {
    enabled: false,
    name: "Assistant",
    clientKey: suggestedClientKey,
    businessContext: "",
    sources: {
      meta: Boolean(dashboard.metaAccountId),
      google: Boolean(dashboard.googleCustomerId),
      data: false,
    },
  };
}

function CopyButton({ value, label = "Copier" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          setCopied(false);
        }
      }}
      className="text-[11px] px-2 py-0.5 rounded border border-gray-700 text-gray-300 hover:text-white hover:border-gray-500 transition-colors"
    >
      {copied ? "Copié" : label}
    </button>
  );
}

export default function AdminBotDetailPage({ params }: { params: Promise<{ dashboardId: string }> }) {
  const { dashboardId } = use(params);
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [form, setForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  const [accessEmail, setAccessEmail] = useState("");
  const [accessName, setAccessName] = useState("");
  const [accessBusy, setAccessBusy] = useState(false);
  const [accessError, setAccessError] = useState<string | null>(null);
  const [lastGranted, setLastGranted] = useState<{ email: string; password?: string; created: boolean } | null>(null);

  const [tokenBusy, setTokenBusy] = useState(false);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [issuedToken, setIssuedToken] = useState<{ token: string; ingestUrl: string } | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/admin/bots/${dashboardId}`);
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      setLoadError(json.error || "Erreur API");
      setLoading(false);
      return;
    }
    const payload = json as Payload;
    setData(payload);
    setForm((prev) => prev ?? formToState(payload.bot, payload.dashboard, payload.suggestedClientKey));
    setLoading(false);
  }, [dashboardId]);

  useEffect(() => {
    load();
  }, [load]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!form) return;
    setSaving(true);
    setSaveStatus(null);
    const res = await fetch(`/api/admin/bots/${dashboardId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        enabled: form.enabled,
        name: form.name,
        clientKey: form.clientKey,
        businessContext: form.businessContext,
        sources: form.sources,
      }),
    });
    const json = await res.json().catch(() => ({}));
    setSaving(false);
    if (!res.ok) {
      setSaveStatus({ tone: "error", text: json.error || "Enregistrement échoué" });
      return;
    }
    setSaveStatus({ tone: "ok", text: "Enregistré" });
    setData((prev) =>
      prev
        ? { ...prev, bot: json.bot, accesses: json.accesses, ingestConfigured: json.ingestConfigured }
        : prev,
    );
    setForm(formToState(json.bot, data!.dashboard, json.bot.clientKey));
  }

  async function grantAccess(e: React.FormEvent) {
    e.preventDefault();
    setAccessBusy(true);
    setAccessError(null);
    const res = await fetch(`/api/admin/bots/${dashboardId}/access`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: accessEmail, name: accessName || undefined }),
    });
    const json = await res.json().catch(() => ({}));
    setAccessBusy(false);
    if (!res.ok) {
      setAccessError(json.error || "Erreur");
      return;
    }
    setLastGranted({ email: json.user.email, password: json.tempPassword, created: Boolean(json.created) });
    setAccessEmail("");
    setAccessName("");
    load();
  }

  async function revokeAccess(userId: string, email: string | null) {
    if (!confirm(`Retirer l'accès de ${email ?? userId} ?`)) return;
    const res = await fetch(`/api/admin/bots/${dashboardId}/access/${userId}`, { method: "DELETE" });
    if (res.ok) load();
  }

  async function issueToken() {
    if (data?.ingestConfigured && !confirm("Régénérer le token révoque l'ancien : n8n devra être mis à jour. Continuer ?")) return;
    setTokenBusy(true);
    setTokenError(null);
    const res = await fetch(`/api/admin/bots/${dashboardId}/ingest-token`, { method: "POST" });
    const json = await res.json().catch(() => ({}));
    setTokenBusy(false);
    if (!res.ok) {
      setTokenError(json.error || "Erreur");
      return;
    }
    setIssuedToken({ token: json.token, ingestUrl: json.ingestUrl });
    setData((prev) => (prev ? { ...prev, ingestConfigured: true } : prev));
  }

  if (loading) return <div className="text-sm text-gray-500">Chargement…</div>;
  if (loadError || !data || !form) return <div className="text-sm text-red-400">{loadError ?? "Client introuvable"}</div>;

  const { dashboard, bot, accesses } = data;
  const sources = form.sources;

  return (
    <div className="space-y-8">
      <div>
        <Link href="/admin/bots" className="text-xs text-gray-400 hover:text-white hover:underline">
          ← Bots clients
        </Link>
        <div className="flex items-start justify-between gap-4 mt-2 flex-wrap">
          <div>
            <h1 className="text-2xl font-bold text-white">{dashboard.name}</h1>
            <div className="text-xs mt-1 text-gray-500 flex items-center gap-2 flex-wrap">
              <span>{dashboard.ownerEmail ?? "—"}</span>
              {!bot ? <Pill>Non configuré</Pill> : bot.enabled ? <Pill tone="emerald">Actif</Pill> : <Pill tone="amber">Inactif</Pill>}
              {dashboard.metaAccountId && <Pill tone="blue">Meta {dashboard.metaAccountId}</Pill>}
              {dashboard.googleCustomerId && <Pill tone="blue">Google {dashboard.googleCustomerId}</Pill>}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Link href={`/portfolio/${dashboard.id}`} className={secondaryBtnCls}>
              Fiche client
            </Link>
            {bot && (
              <Link
                href={`/bot/${bot.id}`}
                className={primaryBtnCls}
                title={bot.enabled ? undefined : "Le bot est inactif : activez-le pour le tester"}
              >
                Tester le bot
              </Link>
            )}
          </div>
        </div>
      </div>

      <section>
        <h2 className={sectionTitleCls}>Configuration</h2>
        <Card padded>
          <form onSubmit={save} className="flex flex-col gap-4">
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
                className="accent-violet-500 w-4 h-4"
              />
              <span className="text-sm text-white font-medium">Bot activé</span>
              <span className="text-xs text-gray-500">Désactivé : invisible pour les clients, même avec un accès.</span>
            </label>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <label className="flex flex-col gap-1">
                <span className="text-xs text-gray-400">Nom affiché</span>
                <input
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  required
                  maxLength={80}
                  className={inputCls}
                  placeholder="Assistant"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs text-gray-400">
                  Clé client <span className="text-gray-600">(client_key de l&apos;entrepôt e-commerce)</span>
                </span>
                <input
                  type="text"
                  value={form.clientKey}
                  onChange={(e) => setForm({ ...form, clientKey: e.target.value.toLowerCase() })}
                  required
                  pattern="[a-z0-9][a-z0-9_-]{1,39}"
                  title="2 à 40 caractères : minuscules, chiffres, - ou _"
                  className={`${inputCls} font-mono`}
                  placeholder="lpev"
                />
              </label>
            </div>

            <label className="flex flex-col gap-1">
              <span className="text-xs text-gray-400">Contexte métier</span>
              <textarea
                value={form.businessContext}
                onChange={(e) => setForm({ ...form, businessContext: e.target.value })}
                rows={12}
                maxLength={20000}
                className={`${inputCls} min-h-[220px] leading-relaxed`}
                placeholder={CONTEXT_HELP}
              />
              <span className="text-[11px] text-gray-500">{CONTEXT_HELP}</span>
            </label>

            <fieldset className="flex flex-col gap-2">
              <legend className="text-xs text-gray-400 mb-1">Sources accessibles au bot</legend>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                <SourceToggle
                  checked={Boolean(sources.meta)}
                  onChange={(v) => setForm({ ...form, sources: { ...sources, meta: v } })}
                  label="Meta Ads"
                  hint={dashboard.metaAccountId ? `Compte ${dashboard.metaAccountId}` : "Aucun compte Meta sur ce dashboard"}
                  disabled={!dashboard.metaAccountId}
                />
                <SourceToggle
                  checked={Boolean(sources.google)}
                  onChange={(v) => setForm({ ...form, sources: { ...sources, google: v } })}
                  label="Google Ads"
                  hint={dashboard.googleCustomerId ? `Compte ${dashboard.googleCustomerId}` : "Aucun compte Google Ads sur ce dashboard"}
                  disabled={!dashboard.googleCustomerId}
                />
                <SourceToggle
                  checked={Boolean(sources.data)}
                  onChange={(v) => setForm({ ...form, sources: { ...sources, data: v } })}
                  label="Données e-commerce"
                  hint="Commandes réelles (entrepôt client_data, alimenté par n8n)"
                />
                <label className="flex flex-col gap-1 bg-gray-950 border border-gray-800 rounded-lg px-3 py-2">
                  <span className="text-sm text-white">GA4</span>
                  <input
                    type="text"
                    value={sources.ga4PropertyId ?? ""}
                    onChange={(e) => {
                      const v = e.target.value.trim();
                      const next = { ...sources };
                      if (v) next.ga4PropertyId = v;
                      else delete next.ga4PropertyId;
                      setForm({ ...form, sources: next });
                    }}
                    className={`${inputCls} !py-1 text-xs font-mono`}
                    placeholder="Property ID (ex : 123456789) — vide = désactivé"
                  />
                </label>
              </div>
            </fieldset>

            <div className="flex items-center gap-3">
              <button type="submit" disabled={saving} className={primaryBtnCls}>
                {saving ? "Enregistrement…" : bot ? "Enregistrer" : "Créer le bot"}
              </button>
              {saveStatus && (
                <span className={`text-xs ${saveStatus.tone === "ok" ? "text-emerald-400" : "text-red-400"}`}>
                  {saveStatus.text}
                </span>
              )}
              {bot && <span className="text-[11px] text-gray-600">Modifié le {formatDate(bot.updatedAt)}</span>}
            </div>
          </form>
        </Card>
      </section>

      <section>
        <h2 className={sectionTitleCls}>Accès</h2>
        {!bot ? (
          <p className="text-sm text-gray-500">Créez le bot pour pouvoir donner des accès.</p>
        ) : (
          <div className="flex flex-col gap-3">
            <p className="text-xs text-gray-500">
              Les admins et consultants ont accès à tous les bots actifs. Les accès ci-dessous concernent les clients.
            </p>

            {lastGranted && (
              <Card padded className="border-emerald-900/40 bg-emerald-500/5">
                <div className="text-sm font-semibold text-emerald-300 mb-1">
                  {lastGranted.created ? "Compte créé et accès accordé" : "Accès accordé"}
                </div>
                <div className="text-xs text-gray-300">
                  Email : <code className="text-white">{lastGranted.email}</code>
                </div>
                {lastGranted.password ? (
                  <>
                    <div className="text-xs text-gray-300 mt-0.5 flex items-center gap-2">
                      Mot de passe temporaire :
                      <code className="px-2 py-0.5 rounded bg-gray-950 text-white">{lastGranted.password}</code>
                      <CopyButton value={lastGranted.password} />
                    </div>
                    <div className="text-xs mt-2 text-gray-500">Notez-le maintenant — il ne sera plus affiché.</div>
                  </>
                ) : (
                  <div className="text-xs mt-1 text-gray-500">Utilisateur déjà existant : ses identifiants sont inchangés.</div>
                )}
                <button onClick={() => setLastGranted(null)} className="mt-2 text-xs text-gray-400 hover:text-white underline">
                  Fermer
                </button>
              </Card>
            )}

            {accesses.length === 0 ? (
              <p className="text-sm text-gray-500">Aucun accès client.</p>
            ) : (
              accesses.map((a) => (
                <Card key={a.userId} padded className="!p-3 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3 min-w-0">
                    <Pill tone={a.role === "client" ? "default" : "blue"}>{a.role}</Pill>
                    <div className="min-w-0">
                      <div className="text-sm text-white truncate">{a.email ?? a.userId}</div>
                      <div className="text-[11px] text-gray-500">
                        {a.name ? `${a.name} · ` : ""}accès depuis le {formatDate(a.createdAt)}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Link href={`/admin/users/${a.userId}`} className="text-xs text-gray-400 hover:text-white underline">
                      Fiche
                    </Link>
                    <button onClick={() => revokeAccess(a.userId, a.email)} className={dangerBtnCls}>
                      Retirer
                    </button>
                  </div>
                </Card>
              ))
            )}

            <Card padded>
              <form onSubmit={grantAccess} className="flex flex-col gap-3">
                <div className="text-xs text-gray-400">
                  Donner accès à un email — si l&apos;utilisateur n&apos;existe pas, un compte client est créé avec un mot de passe temporaire.
                </div>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  <input
                    type="email"
                    value={accessEmail}
                    onChange={(e) => setAccessEmail(e.target.value)}
                    required
                    placeholder="email@client.com"
                    className={`${inputCls} md:col-span-2`}
                  />
                  <input
                    type="text"
                    value={accessName}
                    onChange={(e) => setAccessName(e.target.value)}
                    placeholder="Nom (optionnel, si création)"
                    className={inputCls}
                  />
                </div>
                {accessError && <p className="text-xs text-red-400">{accessError}</p>}
                <button type="submit" disabled={accessBusy} className={`${secondaryBtnCls} self-start`}>
                  {accessBusy ? "Attribution…" : "Donner accès"}
                </button>
              </form>
            </Card>
          </div>
        )}
      </section>

      <section>
        <h2 className={sectionTitleCls}>Alimentation des données e-commerce</h2>
        {!bot ? (
          <p className="text-sm text-gray-500">Créez le bot pour générer un token d&apos;ingestion.</p>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <Card padded className="!p-3">
                <div className="text-[11px] text-gray-500 uppercase tracking-wide">Token d&apos;ingestion</div>
                <div className="text-sm text-white mt-1">
                  {data.ingestConfigured ? <Pill tone="emerald">Configuré</Pill> : <Pill tone="amber">Aucun</Pill>}
                </div>
              </Card>
              <Card padded className="!p-3">
                <div className="text-[11px] text-gray-500 uppercase tracking-wide">Dernier ingest</div>
                <div className="text-sm text-white mt-1">{formatDate(bot.lastIngestAt)}</div>
              </Card>
              <Card padded className="!p-3">
                <div className="text-[11px] text-gray-500 uppercase tracking-wide">Lignes reçues</div>
                <div className="text-sm text-white mt-1">{bot.lastIngestRows ?? "—"}</div>
              </Card>
            </div>

            {issuedToken && (
              <Card padded className="border-emerald-900/40 bg-emerald-500/5">
                <div className="text-sm font-semibold text-emerald-300 mb-2">Token généré — à copier dans n8n</div>
                <div className="text-xs text-gray-300 flex items-center gap-2 flex-wrap">
                  URL :
                  <code className="px-2 py-0.5 rounded bg-gray-950 text-white break-all">{issuedToken.ingestUrl}</code>
                  <CopyButton value={issuedToken.ingestUrl} />
                </div>
                <div className="text-xs text-gray-300 mt-1 flex items-center gap-2 flex-wrap">
                  Header :
                  <code className="px-2 py-0.5 rounded bg-gray-950 text-white break-all">Authorization: Bearer {issuedToken.token}</code>
                  <CopyButton value={issuedToken.token} label="Copier le token" />
                </div>
                <div className="text-xs mt-2 text-gray-500">
                  Body JSON <code>{"{ rows: [...] }"}</code> (max 2000 lignes par appel). Le token ne sera plus affiché.
                </div>
                <button onClick={() => setIssuedToken(null)} className="mt-2 text-xs text-gray-400 hover:text-white underline">
                  Fermer
                </button>
              </Card>
            )}

            <div className="flex items-center gap-3">
              <button type="button" onClick={issueToken} disabled={tokenBusy} className={secondaryBtnCls}>
                {tokenBusy ? "Génération…" : data.ingestConfigured ? "Régénérer le token d'ingestion" : "Générer un token d'ingestion"}
              </button>
              {tokenError && <span className="text-xs text-red-400">{tokenError}</span>}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

function SourceToggle({
  checked,
  onChange,
  label,
  hint,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <label
      className={`flex items-center gap-3 bg-gray-950 border border-gray-800 rounded-lg px-3 py-2 ${
        disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer hover:border-gray-700"
      }`}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="accent-violet-500 w-4 h-4"
      />
      <span className="min-w-0">
        <span className="block text-sm text-white">{label}</span>
        {hint && <span className="block text-[11px] text-gray-500 truncate">{hint}</span>}
      </span>
    </label>
  );
}
