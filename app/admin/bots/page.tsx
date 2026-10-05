"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertTriangle, Search } from "lucide-react";
import { PageHeader, Pill, Card, Section } from "@/components/ui/surface";
import type { BotClientAccount, BotClientRow, BotDashboard, BotListCounts, BotPlatform } from "@/lib/bot-clients";

type Payload = { clients: BotClientRow[]; orphans: BotDashboard[]; counts: BotListCounts };
type Activity = "active" | "dormant" | "all";
type YesNo = "all" | "with" | "without";
type Choice = { clientId: string; meta: string; google: string };

const PLATFORM: Record<BotPlatform, { label: string; cls: string }> = {
  meta: { label: "Meta", cls: "text-blue-300" },
  google: { label: "Google Ads", cls: "text-emerald-300" },
};

const inputCls =
  "px-3 py-2 rounded-lg text-sm bg-gray-950 border border-gray-800 text-white focus:border-violet-500 focus:outline-none";
const primaryBtnCls =
  "px-3 py-1.5 rounded-lg font-semibold text-xs bg-violet-600 hover:bg-violet-500 text-white transition-colors whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed";
const secondaryBtnCls =
  "text-xs font-medium px-3 py-1.5 rounded-lg bg-violet-500/10 hover:bg-violet-500/20 text-violet-300 border border-violet-500/30 transition-colors whitespace-nowrap";
const ghostBtnCls =
  "px-3 py-1.5 rounded-lg text-xs font-medium bg-gray-900 hover:bg-gray-800 text-gray-300 border border-gray-800 transition-colors";
const chipCls = "inline-flex max-w-full items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] leading-5";
const GRID = "lg:grid lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1.7fr)_minmax(0,2.2fr)_auto] lg:gap-4";

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" });
}

const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;
const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

function conflictText(a: BotClientAccount): string {
  return a.conflicts
    .map((c) => (c.dashboardName ? `${c.client.name} (${c.bot ? "bot du " : ""}dashboard « ${c.dashboardName} »)` : c.client.name))
    .join(", ");
}

function AccountChip({ account }: { account: BotClientAccount }) {
  const shared = account.conflicts.length > 0;
  return (
    <span
      className={`${chipCls} ${shared ? "border-amber-500/50 bg-amber-500/10" : "border-gray-800 bg-gray-950/50"}`}
      title={`${PLATFORM[account.platform].label} · ${account.name} · ${account.accountId}${shared ? ` — aussi chez ${conflictText(account)}` : ""}`}
    >
      <span className={`font-semibold shrink-0 ${PLATFORM[account.platform].cls}`}>{PLATFORM[account.platform].label}</span>
      <span className="text-gray-200 truncate">{account.name}</span>
      <span className="text-gray-600 font-mono shrink-0">{account.accountId}</span>
    </span>
  );
}

function Filter<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: ReadonlyArray<readonly [T, string]>; onChange: (v: T) => void }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[11px] uppercase tracking-wide text-gray-500">{label}</span>
      <div className="flex items-center gap-0.5 rounded-lg border border-gray-800 bg-gray-900 p-0.5">
        {options.map(([v, text]) => (
          <button
            key={v}
            type="button"
            aria-pressed={value === v}
            onClick={() => onChange(v)}
            className={`px-2 py-1 rounded-md text-xs font-medium transition-colors whitespace-nowrap ${
              value === v ? "bg-violet-600 text-white" : "text-gray-400 hover:bg-gray-800 hover:text-white"
            }`}
          >
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Un dashboard et son bot : ce que le bot lit, son état, le lien vers son réglage. */
function DashboardLine({ dashboard, accounts, owner }: { dashboard: BotDashboard; accounts: BotClientAccount[]; owner?: string }) {
  const bot = dashboard.bot;
  const reads = (["meta", "google"] as const).flatMap((platform) => {
    const id = platform === "meta" ? dashboard.metaAccountId : dashboard.googleCustomerId;
    if (!id) return [];
    const known = accounts.find((a) => a.platform === platform && a.accountId === id);
    return [{ platform, id, name: known?.name ?? id }];
  });
  return (
    <li className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1.5 rounded-lg border border-gray-800/60 bg-gray-950/40 px-3 py-2">
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <Link href={`/d/${dashboard.id}`} className="text-sm text-white hover:text-violet-300 truncate" title="Ouvrir le dashboard">
            {dashboard.name}
          </Link>
          {!bot ? <Pill>Aucun bot</Pill> : bot.enabled ? <Pill tone="emerald">Bot actif</Pill> : <Pill tone="amber">Bot inactif</Pill>}
        </div>
        <p className="text-[11px] text-gray-500">
          {reads.length
            ? reads.map((r) => `${PLATFORM[r.platform].label} · ${r.name}`).join("  —  ")
            : "Aucun compte lié"}
          {owner && ` · propriétaire : ${owner}`}
        </p>
        {bot && (
          <p className="text-[11px] text-gray-400">
            <code className="text-gray-300">{bot.clientKey}</code>
            {" · "}
            {bot.accessCount ? plural(bot.accessCount, "accès client", "accès clients") : "aucun accès client"}
            {bot.lastIngestAt && ` · dernière ingestion le ${formatDate(bot.lastIngestAt)}`}
          </p>
        )}
        {dashboard.otherClients.length > 0 && (
          <p className="flex items-start gap-1 text-[11px] text-amber-300">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />
            Ce dashboard lit aussi un compte de {dashboard.otherClients.map((o) => o.name).join(", ")}.
          </p>
        )}
      </div>
      <Link href={`/admin/bots/${dashboard.id}`} className={secondaryBtnCls}>
        {bot ? "Régler le bot" : "Ouvrir un bot"}
      </Link>
    </li>
  );
}

export default function AdminBotsPage() {
  const router = useRouter();
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [query, setQuery] = useState("");
  const [activity, setActivity] = useState<Activity>("active");
  const [withBot, setWithBot] = useState<YesNo>("all");
  const [withBoard, setWithBoard] = useState<YesNo>("all");

  const [choice, setChoice] = useState<Choice | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // « Créer » from the panel of /bot arrives with ?q=<client>: show that client, active or dormant.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get("q");
    if (q) { setQuery(q); setActivity("all"); }
  }, []);

  useEffect(() => {
    fetch("/api/admin/bots")
      .then(async (res) => {
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json.error || "Erreur API");
        setData({ clients: json.clients ?? [], orphans: json.orphans ?? [], counts: json.counts });
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Erreur"))
      .finally(() => setLoading(false));
  }, []);

  const clients = useMemo(() => data?.clients ?? [], [data]);
  const filtered = useMemo(() => {
    const q = fold(query.trim());
    return clients.filter((c) => {
      if (activity !== "all" && c.dormant !== (activity === "dormant")) return false;
      const bot = c.dashboards.some((d) => d.bot);
      if (withBot !== "all" && bot !== (withBot === "with")) return false;
      if (withBoard !== "all" && (c.dashboards.length > 0) !== (withBoard === "with")) return false;
      if (!q) return true;
      // Le nom du client, celui d'un de ses comptes ou de ses dashboards, ou un numéro de compte.
      return [c.name, ...c.accounts.flatMap((a) => [a.name, a.accountId]), ...c.dashboards.map((d) => d.name)].some((s) => fold(s).includes(q));
    });
  }, [clients, query, activity, withBot, withBoard]);

  const counts = data?.counts;

  function startChoice(c: BotClientRow) {
    const only = (platform: BotPlatform) => {
      const list = c.accounts.filter((a) => a.platform === platform);
      return list.length === 1 ? list[0].accountId : "";
    };
    setCreateError(null);
    setChoice({ clientId: c.id, meta: only("meta"), google: only("google") });
  }

  async function openBot() {
    if (!choice || (!choice.meta && !choice.google)) return;
    setCreating(true);
    setCreateError(null);
    try {
      const res = await fetch("/api/admin/bots", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId: choice.clientId, metaAccountId: choice.meta || null, googleCustomerId: choice.google || null }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.dashboardId) throw new Error(json.error || `Erreur ${res.status}`);
      router.push(`/admin/bots/${json.dashboardId}`);
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : "Erreur");
      setCreating(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Bots clients"
        subtitle="Tous les clients de l'agence, leurs comptes liés et leur assistant IA privé. Un bot ne lit que les comptes du dashboard auquel il est rattaché."
      />

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <label className="relative w-full sm:w-64">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-500" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Rechercher un client, un compte…"
            aria-label="Rechercher un client"
            className={`${inputCls} w-full pl-8`}
          />
        </label>
        <Filter
          label="Activité"
          value={activity}
          onChange={setActivity}
          options={[
            ["active", `Actifs${counts ? ` (${counts.active})` : ""}`],
            ["dormant", `Dormants${counts ? ` (${counts.dormant})` : ""}`],
            ["all", `Tous${counts ? ` (${counts.clients})` : ""}`],
          ]}
        />
        <Filter label="Bot" value={withBot} onChange={setWithBot} options={[["all", "Tous"], ["with", "Avec"], ["without", "Sans"]]} />
        <Filter label="Dashboard" value={withBoard} onChange={setWithBoard} options={[["all", "Tous"], ["with", "Avec"], ["without", "Sans"]]} />
      </div>

      {loading ? (
        <p className="text-sm text-gray-500">Chargement…</p>
      ) : error ? (
        <p className="text-sm text-red-400">{error}</p>
      ) : (
        <>
          <p className="text-xs text-gray-500">
            {plural(filtered.length, "client affiché", "clients affichés")} sur {clients.length}
            {activity === "active" && counts && counts.dormant > 0 && (
              <>
                {" · "}
                <button type="button" onClick={() => setActivity("all")} className="text-violet-300 hover:text-violet-200 underline underline-offset-2">
                  {plural(counts.dormant, "client dormant masqué", "clients dormants masqués")}
                </button>{" "}
                (aucune dépense depuis dix jours)
              </>
            )}
          </p>

          {filtered.length === 0 ? (
            <p className="text-sm text-gray-500">Aucun client ne correspond à ces filtres.</p>
          ) : (
            <Card className="overflow-hidden">
              <div className={`hidden ${GRID} px-4 py-2.5 text-[11px] uppercase tracking-wide text-gray-500 font-medium border-b border-gray-800`}>
                <span>Client</span>
                <span>Comptes liés</span>
                <span>Dashboards et bots</span>
                <span className="w-32" />
              </div>
              <ul>
                {filtered.map((c) => {
                  const bots = c.dashboards.filter((d) => d.bot);
                  const open = choice?.clientId === c.id;
                  return (
                    <li key={c.id} className="border-b border-gray-800/60 last:border-0">
                      <div className={`${GRID} space-y-3 lg:space-y-0 px-4 py-3 hover:bg-gray-800/20`}>
                        <div className="min-w-0 space-y-1.5">
                          <div className="text-white font-medium break-words">{c.name}</div>
                          <div className="flex flex-wrap gap-1.5">
                            {bots.length === 0 ? (
                              <Pill>Aucun bot</Pill>
                            ) : bots.some((d) => d.bot?.enabled) ? (
                              <Pill tone="emerald">{bots.length > 1 ? `${bots.length} bots` : "Bot actif"}</Pill>
                            ) : (
                              <Pill tone="amber">Bot inactif</Pill>
                            )}
                            {c.dormant && <Pill tone="blue">Dormant</Pill>}
                          </div>
                        </div>

                        <div className="min-w-0 space-y-1.5">
                          <div className="flex flex-wrap gap-1.5">
                            {c.accounts.map((a) => <AccountChip key={`${a.platform}:${a.accountId}`} account={a} />)}
                            {bots.map((d) => d.bot?.sources.ga4PropertyId && (
                              <span key={`ga4:${d.id}`} className={`${chipCls} border-gray-800 bg-gray-950/50`} title={`Propriété GA4 lue par le bot du dashboard « ${d.name} »`}>
                                <span className="font-semibold text-amber-300">GA4</span>
                                <span className="text-gray-600 font-mono">{d.bot.sources.ga4PropertyId}</span>
                              </span>
                            ))}
                            {bots.map((d) => d.bot?.sources.data && (
                              <span key={`data:${d.id}`} className={`${chipCls} border-gray-800 bg-gray-950/50`} title={`Entrepôt e-commerce « ${d.bot.clientKey} »`}>
                                <span className="font-semibold text-violet-300">E-commerce</span>
                                <span className="text-gray-400">{d.bot.lastIngestAt ? `reçu le ${formatDate(d.bot.lastIngestAt)}` : "rien reçu"}</span>
                              </span>
                            ))}
                          </div>
                          {c.accounts.filter((a) => a.conflicts.length).map((a) => (
                            <p key={`w:${a.platform}:${a.accountId}`} className="flex items-start gap-1 text-[11px] text-amber-300">
                              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />
                              <span>{PLATFORM[a.platform].label} {a.accountId} figure aussi chez {conflictText(a)}.</span>
                            </p>
                          ))}
                        </div>

                        <div className="min-w-0">
                          {c.dashboards.length === 0 ? (
                            <p className="text-xs text-gray-500">Aucun dashboard</p>
                          ) : (
                            <div className="space-y-1.5">
                              <p className="text-[11px] text-gray-500">{plural(c.dashboards.length, "dashboard", "dashboards")}</p>
                              <ul className="space-y-1.5">
                                {c.dashboards.map((d) => <DashboardLine key={d.id} dashboard={d} accounts={c.accounts} />)}
                              </ul>
                            </div>
                          )}
                        </div>

                        <div className="lg:w-32 lg:text-right">
                          {c.dashboards.length === 0 && !open && (
                            <button type="button" onClick={() => startChoice(c)} className={primaryBtnCls}>
                              Ouvrir un bot
                            </button>
                          )}
                        </div>
                      </div>

                      {open && choice && (
                        <div className="mx-4 mb-3 rounded-xl border border-violet-500/30 bg-violet-500/5 p-4 space-y-3">
                          <div>
                            <p className="text-sm font-semibold text-white">Ouvrir un bot à {c.name}</p>
                            <p className="text-xs text-gray-400 mt-0.5">
                              Un dashboard est créé à votre nom pour ce client, sans aucun accès client. Le bot ne lira que les comptes choisis ici.
                            </p>
                          </div>
                          <div className="grid gap-3 sm:grid-cols-2">
                            {(["meta", "google"] as const).map((platform) => {
                              const list = c.accounts.filter((a) => a.platform === platform);
                              if (!list.length) return null;
                              return (
                                <label key={platform} className="block text-xs text-gray-400 space-y-1">
                                  <span>Compte {PLATFORM[platform].label}{list.length > 1 && ` — ${list.length} comptes, un seul par bot`}</span>
                                  <select
                                    value={choice[platform]}
                                    onChange={(e) => setChoice({ ...choice, [platform]: e.target.value })}
                                    className={`${inputCls} w-full`}
                                  >
                                    <option value="">{list.length > 1 ? "Choisir un compte…" : "Ne pas lire ce compte"}</option>
                                    {list.map((a) => (
                                      <option key={a.accountId} value={a.accountId} disabled={a.conflicts.length > 0}>
                                        {a.name} ({a.accountId}){a.conflicts.length > 0 ? " — partagé avec un autre client" : ""}
                                      </option>
                                    ))}
                                  </select>
                                </label>
                              );
                            })}
                          </div>
                          {createError && <p className="text-xs text-red-400">{createError}</p>}
                          <div className="flex flex-wrap gap-2">
                            <button type="button" onClick={openBot} disabled={creating || (!choice.meta && !choice.google)} className={primaryBtnCls}>
                              {creating ? "Création…" : "Créer le dashboard et régler le bot"}
                            </button>
                            <button type="button" onClick={() => setChoice(null)} disabled={creating} className={ghostBtnCls}>
                              Annuler
                            </button>
                          </div>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </Card>
          )}

          {data && data.orphans.length > 0 && (
            <Section
              title={`Dashboards hors liste (${data.orphans.length})`}
              bodyClassName="p-4 space-y-3"
            >
              <p className="text-xs text-gray-500">
                Leurs comptes n&apos;appartiennent à aucun client connu : compte devenu illisible, ou dashboard sans compte.
              </p>
              <ul className="space-y-1.5">
                {data.orphans.map((d) => <DashboardLine key={d.id} dashboard={d} accounts={[]} owner={d.ownerEmail ?? "—"} />)}
              </ul>
            </Section>
          )}
        </>
      )}
    </div>
  );
}
