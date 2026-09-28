"use client";

import { useCallback, useEffect, useState } from "react";
import { PageHeader, Pill, Section } from "@/components/ui/surface";

type Topic = { id: string; label: string; hint: string };
type Frequency = { id: string; label: string };
type Channel = { id: string; name: string; isPrivate: boolean; isMember: boolean };
type Incident = { id: string; severity: string; title: string; detail: string; firstSeenAt: string; notifiedAt: string | null; notifyError: string | null };
type Config = { topics: Record<string, boolean>; frequency: string; weekdaysOnly: boolean };
type SlackStatus = "connected" | "public" | "absent" | "none" | "unknown";
type Client = {
  dashboardId: string;
  name: string;
  meta: boolean;
  google: boolean;
  enabled: boolean;
  slackChannel: string | null;
  slackChannelId: string | null;
  slackStatus: SlackStatus;
  slackPrivate: boolean | null;
  config: Config;
  incidents: Incident[];
};
type Payload = {
  clients: Client[];
  slack: { ok: boolean; error: string | null; total: number; free: Channel[] };
  topics: Topic[];
  frequencies: Frequency[];
};
type Suggestion = { dashboardId: string; client: string; channel: Channel; by: string };
type Finding = { severity: string; title: string; detail: string };
type ScanRun = { dashboardId: string; name: string; findings: Finding[]; announced: number; resolved: number; sent: boolean; errors: string[] };

const STATUS: Record<SlackStatus, { label: string; tone: "emerald" | "amber" | "red" | "default" | "blue"; help: string }> = {
  connected: { label: "Slack connecté", tone: "emerald", help: "Le bot est membre du canal." },
  public: { label: "Slack connecté (canal public)", tone: "emerald", help: "Le bot n'est pas membre mais peut écrire dans ce canal public." },
  absent: { label: "Bot absent du canal", tone: "red", help: "Le bot ne voit pas ce canal : canal privé où il n'a pas été invité, canal renommé ou archivé." },
  none: { label: "Aucun canal", tone: "default", help: "Les alertes de ce client restent dans ImpulseMotion." },
  unknown: { label: "État Slack inconnu", tone: "amber", help: "La liste des canaux Slack n'a pas pu être lue." },
};

const selectCls = "px-2.5 py-1.5 rounded-lg text-xs bg-gray-950 border border-gray-800 text-white focus:border-violet-500 focus:outline-none";
const btnCls = "px-3 py-1.5 rounded-lg text-xs font-medium bg-violet-500/10 hover:bg-violet-500/20 text-violet-300 border border-violet-500/30 transition-colors disabled:opacity-40 disabled:cursor-not-allowed";
const primaryBtnCls = "px-4 py-2 rounded-lg font-semibold text-sm bg-violet-600 hover:bg-violet-500 text-white transition-colors disabled:opacity-40";
const ghostBtnCls = "px-3 py-1.5 rounded-lg text-xs font-medium bg-gray-900 hover:bg-gray-800 text-gray-300 border border-gray-800 transition-colors disabled:opacity-40";

const since = (iso: string) => {
  const h = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 3_600_000));
  return h < 24 ? `depuis ${h} h` : `depuis ${Math.round(h / 24)} j`;
};

async function call(method: "PATCH" | "POST", body: Record<string, unknown>) {
  const res = await fetch("/api/admin/auto-alerts", { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? `Erreur ${res.status}`);
  return json;
}

export default function AutoAlertsPage() {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; tone: "ok" | "error" } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestion[] | null>(null);
  const [scan, setScan] = useState<ScanRun[] | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/auto-alerts", { cache: "no-store" });
      if (!res.ok) throw new Error(`Erreur ${res.status}`);
      setData(await res.json());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Chargement impossible");
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const act = useCallback(async (key: string, fn: () => Promise<string | void>) => {
    setBusy(key);
    setNotice(null);
    try {
      const text = await fn();
      if (text) setNotice({ text, tone: "ok" });
      await load();
    } catch (e) {
      setNotice({ text: e instanceof Error ? e.message : "Erreur", tone: "error" });
    } finally {
      setBusy(null);
    }
  }, [load]);

  if (error) return <p className="text-sm text-red-400">{error}</p>;
  if (!data) return <p className="text-sm text-gray-500">Chargement…</p>;

  const linked = data.clients.filter((c) => c.slackStatus === "connected" || c.slackStatus === "public").length;
  const openIncidents = data.clients.reduce((n, c) => n + c.incidents.length, 0);

  const setChannel = (c: Client, value: string) => act(`channel:${c.dashboardId}`, async () => {
    const ch = data.slack.free.find((x) => x.id === value);
    await call("PATCH", { dashboardId: c.dashboardId, slackChannel: ch ? ch.name : value || null, slackChannelId: ch?.id ?? null });
    return value ? `Canal enregistré pour ${c.name}` : `Canal retiré pour ${c.name}`;
  });
  const setConfig = (c: Client, patch: Partial<Config>) => act(`config:${c.dashboardId}`, async () => {
    await call("PATCH", { dashboardId: c.dashboardId, config: { ...c.config, ...patch } });
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Alertes automatiques"
        subtitle={<>Chaque compte est vérifié sans réglage : paiement, diffusion, créas, conversions, performance, budget. Le canal Slack du client ne reçoit un message que lorsque quelque chose change. {linked}/{data.clients.length} clients reliés à Slack · {openIncidents} point{openIncidents > 1 ? "s" : ""} en cours.</>}
        action={
          <div className="flex items-center gap-2">
            <button className={ghostBtnCls} disabled={!!busy || !data.slack.ok} onClick={() => act("suggest", async () => {
              const res = await call("POST", { action: "suggest" });
              setSuggestions(res.suggestions ?? []);
              return res.suggestions?.length ? undefined : "Aucun canal c_ ne correspond aux clients sans canal.";
            })}>
              {busy === "suggest" ? "Recherche…" : "Retrouver les canaux c_"}
            </button>
            <button className={primaryBtnCls} disabled={!!busy} onClick={() => act("scan", async () => {
              const res = await call("POST", { action: "scan" });
              setScan(res.runs ?? []);
              return `${res.scanned} clients vérifiés, ${res.messages} message${res.messages > 1 ? "s" : ""} Slack envoyé${res.messages > 1 ? "s" : ""}.`;
            })}>
              {busy === "scan" ? "Vérification…" : "Vérifier maintenant"}
            </button>
          </div>
        }
      />

      {!data.slack.ok && (
        <Section tone="warning" bodyClassName="p-4">
          <p className="text-sm text-amber-300">Slack n&apos;a pas pu être lu : {data.slack.error}</p>
        </Section>
      )}
      {notice && (
        <p className={`text-sm ${notice.tone === "ok" ? "text-emerald-400" : "text-red-400"}`}>{notice.text}</p>
      )}

      {suggestions && suggestions.length > 0 && (
        <Section
          title={`${suggestions.length} canal${suggestions.length > 1 ? "x" : ""} retrouvé${suggestions.length > 1 ? "s" : ""}`}
          action={
            <div className="flex items-center gap-2">
              <button className={ghostBtnCls} onClick={() => setSuggestions(null)}>Ignorer</button>
              <button className={btnCls} disabled={!!busy} onClick={() => act("apply", async () => {
                for (const s of suggestions) await call("PATCH", { dashboardId: s.dashboardId, slackChannel: s.channel.name, slackChannelId: s.channel.id });
                const n = suggestions.length;
                setSuggestions(null);
                return `${n} client${n > 1 ? "s" : ""} relié${n > 1 ? "s" : ""} à son canal.`;
              })}>Tout appliquer</button>
            </div>
          }
          bodyClassName="divide-y divide-gray-800"
        >
          {suggestions.map((s) => (
            <div key={s.dashboardId} className="px-4 py-2.5 flex items-center justify-between gap-3 text-sm">
              <span className="text-white">{s.client} <span className="text-gray-500">→</span> <span className="text-violet-300">#{s.channel.name}</span></span>
              <span className="flex items-center gap-2">
                <Pill tone={s.by === "nom identique" ? "emerald" : "amber"}>{s.by}</Pill>
                {s.channel.isPrivate && !s.channel.isMember && <Pill tone="red">bot à inviter</Pill>}
                <button className={btnCls} disabled={!!busy} onClick={() => act(`apply:${s.dashboardId}`, async () => {
                  await call("PATCH", { dashboardId: s.dashboardId, slackChannel: s.channel.name, slackChannelId: s.channel.id });
                  setSuggestions((list) => (list ?? []).filter((x) => x.dashboardId !== s.dashboardId));
                })}>Appliquer</button>
              </span>
            </div>
          ))}
        </Section>
      )}

      {scan && (
        <Section title="Résultat de la vérification" action={<button className={ghostBtnCls} onClick={() => setScan(null)}>Fermer</button>} bodyClassName="divide-y divide-gray-800">
          {scan.filter((r) => r.findings.length || r.errors.length).length === 0 && <p className="px-4 py-3 text-sm text-gray-400">Rien à signaler sur les comptes vérifiés.</p>}
          {scan.filter((r) => r.findings.length || r.errors.length).map((r) => (
            <div key={r.dashboardId} className="px-4 py-3 space-y-1">
              <p className="text-sm font-medium text-white">{r.name} {r.sent && <Pill tone="emerald">envoyé dans Slack</Pill>}</p>
              {r.findings.map((f, i) => (
                <p key={i} className="text-xs text-gray-300"><Pill tone={f.severity === "critical" ? "red" : "amber"}>{f.title}</Pill> <span className="ml-1">{f.detail}</span></p>
              ))}
              {r.errors.map((e, i) => <p key={i} className="text-xs text-gray-500">Lecture incomplète : {e}</p>)}
            </div>
          ))}
        </Section>
      )}

      <Section title="Clients" bodyClassName="divide-y divide-gray-800">
        {data.clients.length === 0 && <p className="px-4 py-3 text-sm text-gray-400">Aucun client relié à un compte publicitaire.</p>}
        {data.clients.map((c) => {
          const st = STATUS[c.slackStatus];
          const isOpen = open === c.dashboardId;
          const critical = c.incidents.filter((i) => i.severity === "critical").length;
          const options = [
            ...(c.slackChannelId || c.slackChannel ? [{ id: c.slackChannelId ?? c.slackChannel ?? "", name: (c.slackChannel ?? "").replace(/^#/, "") || (c.slackChannelId ?? "") }] : []),
            ...data.slack.free.map((f) => ({ id: f.id, name: f.name + (f.isPrivate && !f.isMember ? " (privé)" : "") })),
          ];
          return (
            <div key={c.dashboardId} className={c.enabled ? "" : "opacity-60"}>
              <div className="px-4 py-3 flex flex-wrap items-center gap-x-3 gap-y-2">
                <button className="text-left min-w-0 flex-1" onClick={() => setOpen(isOpen ? null : c.dashboardId)}>
                  <span className="text-sm font-medium text-white">{c.name}</span>
                  <span className="ml-2 text-[11px] text-gray-500">{[c.meta && "Meta", c.google && "Google"].filter(Boolean).join(" · ")}</span>
                  {c.incidents.length > 0 && (
                    <Pill tone={critical ? "red" : "amber"} className="ml-2">{c.incidents.length} point{c.incidents.length > 1 ? "s" : ""} en cours</Pill>
                  )}
                </button>
                <span title={st.help}><Pill tone={st.tone}>{st.label}</Pill></span>
                <select className={selectCls} value={c.slackChannelId ?? c.slackChannel ?? ""} disabled={!!busy} onChange={(e) => setChannel(c, e.target.value)} aria-label={`Canal Slack de ${c.name}`}>
                  <option value="">Aucun canal</option>
                  {options.map((o) => <option key={o.id} value={o.id}>#{o.name}</option>)}
                </select>
                {c.slackStatus === "public" && (
                  <button className={btnCls} disabled={!!busy} title="Le bot rejoint le canal public" onClick={() => act(`connect:${c.dashboardId}`, async () => { await call("POST", { action: "connect", dashboardId: c.dashboardId }); return `Le bot a rejoint le canal de ${c.name}.`; })}>
                    {busy === `connect:${c.dashboardId}` ? "Connexion…" : "Connecter"}
                  </button>
                )}
                {c.slackStatus === "absent" && (
                  <button className={btnCls} disabled={!!busy} title="À faire après avoir tapé /invite @BotAds dans le canal" onClick={() => act(`connect:${c.dashboardId}`, async () => { await call("POST", { action: "connect", dashboardId: c.dashboardId }); return `Le bot voit bien le canal de ${c.name}.`; })}>
                    {busy === `connect:${c.dashboardId}` ? "Vérification…" : "Vérifier"}
                  </button>
                )}
                {(c.slackStatus === "connected" || c.slackStatus === "public") && (
                  <button className={ghostBtnCls} disabled={!!busy} title="Envoie un message de test dans le canal" onClick={() => act(`test:${c.dashboardId}`, async () => { await call("POST", { action: "test", dashboardId: c.dashboardId }); return `Message de test envoyé dans le canal de ${c.name}.`; })}>
                    {busy === `test:${c.dashboardId}` ? "Envoi…" : "Tester"}
                  </button>
                )}
                <button className={ghostBtnCls} onClick={() => setOpen(isOpen ? null : c.dashboardId)}>{isOpen ? "Fermer" : "Régler"}</button>
              </div>

              {c.slackStatus === "absent" && (
                <p className="px-4 pb-3 -mt-1 text-xs text-red-300">
                  Canal privé : dans Slack, ouvrez {c.slackChannel ?? "le canal"} et tapez <code className="text-white">/invite @BotAds</code>, puis cliquez sur « Vérifier ».
                </p>
              )}

              {isOpen && (
                <div className="px-4 pb-4 grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <p className="text-xs text-gray-400">Sujets surveillés</p>
                    {data.topics.map((t) => (
                      <label key={t.id} className="flex items-start gap-2 text-sm text-gray-200">
                        <input type="checkbox" className="mt-1 accent-violet-500" checked={c.config.topics[t.id] !== false} disabled={!!busy}
                          onChange={(e) => setConfig(c, { topics: { ...c.config.topics, [t.id]: e.target.checked } })} />
                        <span>{t.label}<span className="block text-[11px] text-gray-500">{t.hint}</span></span>
                      </label>
                    ))}
                  </div>
                  <div className="space-y-3">
                    <label className="block text-xs text-gray-400">Récurrence
                      <select className={`${selectCls} mt-1 w-full`} value={c.config.frequency} disabled={!!busy} onChange={(e) => setConfig(c, { frequency: e.target.value })}>
                        {data.frequencies.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
                      </select>
                    </label>
                    <label className="flex items-center gap-2 text-sm text-gray-200">
                      <input type="checkbox" className="accent-violet-500" checked={c.config.weekdaysOnly} disabled={!!busy} onChange={(e) => setConfig(c, { weekdaysOnly: e.target.checked })} />
                      Du lundi au vendredi seulement
                    </label>
                    <label className="flex items-center gap-2 text-sm text-gray-200">
                      <input type="checkbox" className="accent-violet-500" checked={c.enabled} disabled={!!busy}
                        onChange={(e) => act(`enabled:${c.dashboardId}`, async () => { await call("PATCH", { dashboardId: c.dashboardId, autoAlerts: e.target.checked }); })} />
                      Surveillance active pour ce client
                    </label>
                    <button className={btnCls} disabled={!!busy} onClick={() => act(`scan:${c.dashboardId}`, async () => {
                      const res = await call("POST", { action: "scan", dashboardId: c.dashboardId });
                      setScan(res.runs ?? []);
                      return `${c.name} vérifié.`;
                    })}>
                      {busy === `scan:${c.dashboardId}` ? "Vérification…" : "Vérifier ce client maintenant"}
                    </button>
                  </div>
                  {c.incidents.length > 0 && (
                    <div className="md:col-span-2 space-y-1.5">
                      <p className="text-xs text-gray-400">Points en cours</p>
                      {c.incidents.map((i) => (
                        <p key={i.id} className="text-xs text-gray-300">
                          <Pill tone={i.severity === "critical" ? "red" : "amber"}>{i.title}</Pill>
                          <span className="ml-1">{i.detail}</span>
                          <span className="ml-1 text-gray-500">({since(i.firstSeenAt)}{i.notifiedAt ? ", envoyé dans Slack" : i.notifyError ? `, envoi échoué : ${i.notifyError}` : ", non envoyé"})</span>
                        </p>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </Section>
    </div>
  );
}
