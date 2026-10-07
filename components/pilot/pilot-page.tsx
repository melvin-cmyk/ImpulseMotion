"use client";

/**
 * Pilotage: a client, one of its Meta or Google Ads accounts, the account as
 * the platform holds it, the AI that reads all the client's accounts and
 * proposes changes, the changes chosen with their preview, and the journal of
 * what was done.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, RefreshCw, Search } from "lucide-react";
import { Card, PageHeader, Section } from "@/components/ui/surface";
import { StructureTree } from "@/components/pilot/structure-tree";
import { ChangePanel } from "@/components/pilot/change-panel";
import { HistoryTimeline, type SourceFilter } from "@/components/pilot/timeline";
import { ChangeChart, marksOf } from "@/components/pilot/change-chart";
import type { HistoryView, PlatformChangeView } from "@/lib/pilot/history";
import { PilotAssistant } from "@/components/pilot/assistant-panel";
import type { StudioPick } from "@/components/pilot/new-ad-form";
import { PLATFORM_FR } from "@/lib/pilot/ops";
import { changeKey, readJson, type PendingChange, type PilotActionView, type PilotClient, type TreeRow } from "@/components/pilot/model";
import { readPilotLink, type PilotLink } from "@/lib/pilot/deep-link";

const plain = (v: string) => v.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const digitsOf = (platform: string, id: string) => (platform === "meta" ? id.replace(/^act_/, "") : platform === "google" ? id.replace(/-/g, "").replace(/^0+/, "") : id).trim();

type Platform = "meta" | "google" | "tiktok";
type AccountRef = { platform: Platform; accountId: string };
const refKey = (a: AccountRef | null) => (a ? `${a.platform}:${a.accountId}` : "");

type Structure = { campaigns: TreeRow[]; adsets: TreeRow[]; negatives?: TreeRow[]; truncated: boolean; account: { id: string; name: string; currency: string }; hqProject: string | null; writesOpen: boolean };

function accountsSummary(c: PilotClient): string {
  const n = (p: Platform) => c.accounts.filter((a) => a.platform === p).length;
  return (["meta", "google", "tiktok"] as const).filter((p) => n(p)).map((p) => `${n(p)} ${PLATFORM_FR[p]}`).join(" + ");
}

export function PilotPage() {
  const [clients, setClients] = useState<PilotClient[] | null>(null);
  const [clientsError, setClientsError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [client, setClient] = useState<PilotClient | null>(null);
  const [account, setAccount] = useState<AccountRef | null>(null);
  const modifyRef = useRef<HTMLDivElement>(null);
  // « Pousser sur Meta » from the Studio créa: /pilotage?studioAsset=<id> — the visual waits for an ad set.
  const [studioPick, setStudioPick] = useState<StudioPick | null>(null);
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("studioAsset");
    if (!id) return;
    fetch(`/api/studio/assets/${encodeURIComponent(id)}`).then((r) => (r.ok ? r.json() : null)).then((j) => {
      const a = j?.asset;
      if (a?.kind === "image" && a.url) setStudioPick({ id: a.id, url: a.url, prompt: a.prompt, clientId: a.clientId ?? null });
    }).catch(() => {});
  }, []);
  // /pilotage?client=…&platform=…&account=…&object=…&do=…&prompt=…&step=…&preview=… (lib/pilot/deep-link.ts)
  const [link] = useState<PilotLink>(() => (typeof window === "undefined" ? {} : readPilotLink(window.location.search)));
  const linkUsed = useRef({ client: false, object: false, preview: false });
  const [structure, setStructure] = useState<Structure | null>(null);
  const [structureError, setStructureError] = useState<string | null>(null);
  const [loadingStructure, setLoadingStructure] = useState(false);
  const [pending, setPending] = useState<PendingChange[]>([]);
  const [preview, setPreview] = useState<PilotActionView | null>(null);
  const [journal, setJournal] = useState<PilotActionView[]>([]);
  const [changes, setChanges] = useState<PlatformChangeView[]>([]);
  const [series, setSeries] = useState<HistoryView["series"]>(null);
  const [syncInfo, setSyncInfo] = useState<HistoryView["sync"]>([]);
  const [loadingJournal, setLoadingJournal] = useState(false);
  const [historyDays, setHistoryDays] = useState(60);
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");

  useEffect(() => {
    fetch("/api/pilot/clients")
      .then(async (r) => { const j = await readJson<{ clients?: PilotClient[] }>(r); if (!r.ok) throw new Error(j.error ?? `Erreur ${r.status}`); return j.clients ?? []; })
      .then(setClients)
      .catch((e) => setClientsError(e instanceof Error ? e.message : String(e)));
  }, []);

  // Only the last account asked is shown: a slow answer for a previous account is dropped.
  const structureSeq = useRef(0);
  const loadStructure = useCallback(async (clientId: string, ref: AccountRef) => {
    const seq = ++structureSeq.current;
    setLoadingStructure(true);
    setStructureError(null);
    try {
      const res = await fetch(`/api/pilot/structure?clientId=${encodeURIComponent(clientId)}&accountId=${encodeURIComponent(ref.accountId)}&platform=${ref.platform}`);
      const j = await readJson<Structure>(res);
      if (seq !== structureSeq.current) return;
      if (!res.ok) throw new Error(j.error ?? `Erreur ${res.status}`);
      setStructure(j);
    } catch (e) {
      if (seq !== structureSeq.current) return;
      setStructure(null);
      setStructureError(e instanceof Error ? e.message : String(e));
    } finally {
      if (seq === structureSeq.current) setLoadingStructure(false);
    }
  }, []);

  // The visual's client is opened at once when it is known.
  const autoPicked = useRef(false);
  useEffect(() => {
    if (autoPicked.current || !studioPick?.clientId || !clients) return;
    const c = clients.find((x) => x.id === studioPick.clientId && x.accounts.some((a) => a.platform === "meta"));
    if (c) { autoPicked.current = true; pick(c); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [studioPick, clients]);

  // The history of the client: actions, the platforms' logs (read now when stale), the curve of the account shown.
  const historySeq = useRef(0);
  // The client of the link is opened at once (by id, else by one of its accounts).
  useEffect(() => {
    if (linkUsed.current.client || !clients) return;
    linkUsed.current.client = true;
    const byId = link.client ? clients.find((x) => x.id === link.client) : null;
    const byAccount = !byId && link.platform && link.account
      ? clients.find((x) => x.accounts.some((a) => a.platform === link.platform && digitsOf(a.platform, a.accountId) === digitsOf(link.platform!, link.account!)))
      : null;
    const c = byId ?? byAccount;
    if (!c) return;
    const wanted = link.platform && link.account ? c.accounts.find((a) => a.platform === link.platform && digitsOf(a.platform, a.accountId) === digitsOf(link.platform!, link.account!)) : null;
    pick(c, wanted ? { platform: wanted.platform, accountId: wanted.accountId } : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clients]);

  // The object of the link, once the account is read: shown, and its change put in « Modifier » (not sent).
  useEffect(() => {
    if (linkUsed.current.object || !structure || !link.object || !account) return;
    linkUsed.current.object = true;
    const row = (link.object.type === "campaign" ? structure.campaigns : link.object.type === "adset" ? structure.adsets : []).find((r) => r.id === link.object!.id);
    const label = row ? `${link.object.type === "campaign" ? "Campagne" : "Ensemble"} « ${row.name} »` : `${link.object.type} ${link.object.id}`;
    if (link.do === "pause" || link.do === "activate") {
      add({ kind: "set_status", objectType: link.object.type, objectId: link.object.id, value: link.do === "pause" ? "PAUSED" : "ACTIVE", label: `${label} → ${link.do === "pause" ? "en pause" : "active"}` });
    } else if (link.do === "budget" && link.value && row) {
      add({ kind: row.lifetimeBudget && !row.dailyBudget ? "set_lifetime_budget" : "set_daily_budget", objectType: link.object.type, objectId: link.object.id, value: link.value, label: `${label} → budget ${link.value}` });
    }
    setTimeout(() => document.getElementById(`pilot-object-${link.object!.id}`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 100);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structure]);

  // A prepared action named by the link (an undo from the dashboard): opened as the preview.
  useEffect(() => {
    if (linkUsed.current.preview || !link.preview || !journal.length) return;
    const a = journal.find((x) => x.id === link.preview && x.status === "draft" && x.mine);
    if (!a) return;
    linkUsed.current.preview = true;
    takePrepared(a);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [journal]);

  const loadJournal = useCallback(async (clientId: string, ref: AccountRef | null, days = historyDays, refresh = true) => {
    const seq = ++historySeq.current;
    setLoadingJournal(true);
    try {
      const q = new URLSearchParams({ clientId, days: String(days) });
      if (ref) { q.set("platform", ref.platform); q.set("accountId", ref.accountId); }
      if (refresh) q.set("refresh", "1");
      const res = await fetch(`/api/pilot/history?${q}`);
      const j = await readJson<HistoryView>(res);
      if (seq !== historySeq.current) return;
      if (res.ok) {
        setJournal(j.actions ?? []);
        setChanges(j.changes ?? []);
        setSeries(j.series ?? null);
        setSyncInfo(j.sync ?? []);
      }
    } finally {
      if (seq === historySeq.current) setLoadingJournal(false);
    }
  }, [historyDays]);

  function pick(c: PilotClient, wanted: AccountRef | null = null) {
    setClient(c);
    setQuery("");
    setPending([]);
    setPreview(null);
    setStructure(null);
    // The account asked, else Meta first; a client with Google Ads only opens on Google.
    const first = (wanted && c.accounts.find((a) => a.platform === wanted.platform && a.accountId === wanted.accountId)) ?? c.accounts.find((a) => a.platform === "meta") ?? c.accounts[0];
    const ref = first ? { platform: first.platform, accountId: first.accountId } : null;
    setAccount(ref);
    if (ref) void loadStructure(c.id, ref);
    void loadJournal(c.id, ref);
  }

  function pickAccount(key: string) {
    if (!client) return;
    const a = client.accounts.find((x) => refKey(x) === key);
    if (!a) return;
    const ref = { platform: a.platform, accountId: a.accountId };
    setAccount(ref);
    setPending([]);
    setPreview(null);
    setStructure(null);
    void loadStructure(client.id, ref);
    void loadJournal(client.id, ref, historyDays, false);
  }

  /** A proposal of the AI, prepared: its account is shown, and its preview waits in « Modifier ». */
  function takePrepared(action: PilotActionView) {
    if (!client) return;
    const a = client.accounts.find((x) => x.platform === action.platform && x.accountId.replace(/^act_/, "").replace(/-/g, "").replace(/^0+/, "") === action.accountId.replace(/^0+/, ""));
    if (!a) return;
    if (refKey(a) !== refKey(account)) {
      const ref = { platform: a.platform, accountId: a.accountId };
      setAccount(ref);
      setStructure(null);
      void loadStructure(client.id, ref);
    }
    setPending([]);
    setPreview(action);
    setTimeout(() => modifyRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
  }

  function add(change: PendingChange) {
    // One change per setting of an object: a new one replaces the previous.
    setPending((list) => [...list.filter((p) => changeKey(p) !== changeKey(change) && !(change.value === "DELETED" && p.objectId === change.objectId)), change]);
  }

  // Every client, active first: the search and the platform only narrow the list, nothing is cut.
  const [platformFilter, setPlatformFilter] = useState<"" | Platform>("");
  const found = useMemo(() => {
    if (!clients) return [];
    const q = plain(query.trim());
    return clients
      .filter((c) => !q || plain(c.name).includes(q) || c.accounts.some((a) => plain(a.name ?? "").includes(q) || a.accountId.includes(q)))
      .filter((c) => !platformFilter || c.accounts.some((a) => a.platform === platformFilter))
      .sort((a, b) => Number(a.dormant) - Number(b.dormant) || a.name.localeCompare(b.name, "fr"));
  }, [clients, query, platformFilter]);

  return (
    <div className="p-4 md:p-6 max-w-7xl mx-auto space-y-5">
      <PageHeader
        title="Pilotage"
        subtitle="Modifiez les comptes Meta, Google Ads et TikTok Ads de vos clients, à la main ou en parlant à l'IA. Chaque changement est montré avant d'être envoyé, puis consigné dans le dossier HQ du client avec votre nom."
      />

      {studioPick && (
        <div className="flex items-center gap-3 rounded-xl border border-violet-500/40 bg-violet-500/5 p-3">
          <img src={studioPick.url} alt="" className="w-14 h-14 rounded object-cover" />
          <p className="text-sm text-gray-200 flex-1">
            Visuel du Studio prêt à pousser sur Meta : choisissez le compte Meta, puis « Modifier » → « Nouvelle publicité » sur l&apos;ensemble de publicités voulu.
          </p>
          <button type="button" onClick={() => setStudioPick(null)} className="text-xs text-gray-400 hover:text-white">Ignorer</button>
        </div>
      )}

      <Card padded>
        {client ? (
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-white font-semibold">{client.name}</span>
            {client.accounts.length > 1 ? (
              <select value={refKey(account)} onChange={(e) => pickAccount(e.target.value)} className="bg-gray-950 border border-gray-700 rounded-lg px-2 py-1.5 text-sm text-white">
                {client.accounts.map((a) => <option key={refKey(a)} value={refKey(a)}>{PLATFORM_FR[a.platform]} · {a.name ?? a.accountId}</option>)}
              </select>
            ) : <span className="text-sm text-gray-400">{PLATFORM_FR[client.accounts[0]?.platform ?? "meta"]} · {client.accounts[0]?.name ?? client.accounts[0]?.accountId}</span>}
            <button type="button" onClick={() => client && account && void loadStructure(client.id, account)} className="text-xs text-gray-400 hover:text-white flex items-center gap-1">
              <RefreshCw className={`w-3.5 h-3.5 ${loadingStructure ? "animate-spin" : ""}`} /> Relire le compte
            </button>
            <button type="button" onClick={() => { setClient(null); setStructure(null); setPending([]); setPreview(null); setJournal([]); }} className="ml-auto text-xs text-gray-400 hover:text-white">Changer de client</button>
          </div>
        ) : (
          <div>
            <label className="flex items-center gap-2 bg-gray-950 border border-gray-800 rounded-lg px-3 py-2">
              <Search className="w-4 h-4 text-gray-500" />
              <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder={clients ? `Chercher parmi ${clients.length} clients (nom ou compte)` : "Chercher un client"} className="bg-transparent text-sm text-white outline-none flex-1" />
            </label>
            {clients && (
              <div className="flex flex-wrap items-center gap-2 mt-3 text-xs">
                {([["", "Tous"], ["meta", "Avec Meta"], ["google", "Avec Google Ads"], ["tiktok", "Avec TikTok"]] as const).map(([k, l]) => (
                  <button key={k} type="button" onClick={() => setPlatformFilter(k)} className={`px-2.5 py-1 rounded-md border ${platformFilter === k ? "border-violet-500 text-white" : "border-gray-800 text-gray-400 hover:text-white"}`}>{l}</button>
                ))}
                <span className="text-gray-500 ml-1">{found.length} client{found.length > 1 ? "s" : ""}</span>
              </div>
            )}
            {clientsError && <p className="text-sm text-red-300 mt-3">{clientsError}</p>}
            {!clients && !clientsError && <p className="text-sm text-gray-500 mt-3 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Lecture des clients…</p>}
            {clients && (
              <ul className="mt-3 grid sm:grid-cols-2 lg:grid-cols-3 gap-2 max-h-[60vh] overflow-y-auto pr-1">
                {found.map((c) => (
                  <li key={c.id}>
                    <button type="button" onClick={() => pick(c)} className="w-full text-left px-3 py-2 rounded-lg border border-gray-800 hover:border-violet-500/60 hover:bg-gray-800/40">
                      <span className="text-sm text-white">{c.name}</span>
                      <span className="block text-[11px] text-gray-500">{accountsSummary(c)}{c.dormant ? " · sans dépense récente" : ""}</span>
                    </button>
                  </li>
                ))}
                {!found.length && <li className="text-sm text-gray-500">Aucun client trouvé.</li>}
              </ul>
            )}
          </div>
        )}
      </Card>

      {client && (
        <Section title="Parler à l'IA">
          <PilotAssistant client={client} focus={account} onPrepared={takePrepared} initialPrompt={link.prompt ?? null} />
        </Section>
      )}

      {client && account && (
        <div ref={modifyRef} className="grid lg:grid-cols-[minmax(0,1fr)_380px] gap-5 items-start scroll-mt-4">
          <Section title={structure ? `${PLATFORM_FR[account.platform]} · compte « ${structure.account.name || structure.account.id} »` : "Compte"}>
            {loadingStructure && !structure && <p className="text-sm text-gray-500 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Lecture du compte sur {PLATFORM_FR[account.platform]}…</p>}
            {structureError && <p className="text-sm text-red-300">{structureError}</p>}
            {structure && (
              <>
                {structure.truncated && <p className="text-xs text-amber-300 mb-2">Compte très grand : seule une partie des campagnes est affichée.</p>}
                <StructureTree
                  key={`${client.id}:${refKey(account)}`}
                  clientId={client.id}
                  accountId={account.accountId}
                  platform={account.platform}
                  currency={structure.account.currency}
                  campaigns={structure.campaigns}
                  adsets={structure.adsets}
                  negatives={structure.negatives ?? []}
                  pending={pending}
                  onAdd={add}
                  studioPick={studioPick}
                />
              </>
            )}
          </Section>
          <div className="lg:sticky lg:top-4">
            <Section title="Modifier">
              <ChangePanel
                clientId={client.id}
                clientName={client.name}
                accountId={account.accountId}
                platform={account.platform}
                writesOpen={structure?.writesOpen ?? false}
                hqDefault={structure?.hqProject ?? null}
                pending={pending}
                onRemove={(i) => setPending((list) => list.filter((_, j) => j !== i))}
                onClear={() => setPending([])}
                preview={preview}
                onPreview={setPreview}
                onSent={(sent) => {
                  void loadJournal(client.id, account);
                  void loadStructure(client.id, account);
                  // Opened from a report's next step: the step is ticked, with the action that did it.
                  if (link.step && sent && (sent.status === "done" || sent.status === "partial")) {
                    void fetch(`/api/reports/${link.step.reportId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ stepDone: { id: link.step.stepId, done: true, pilotActionId: sent.id } }) }).catch(() => {});
                  }
                }}
              />
            </Section>
          </div>
        </div>
      )}

      {client && (
        <Section
          title="Historique & impact"
          action={(
            <div className="flex flex-wrap items-center gap-2 text-xs">
              {([["all", "Tout"], ["impulsemotion", "ImpulseMotion"], ["external", "Hors ImpulseMotion"], ["automated", "Automatique"]] as Array<[SourceFilter, string]>).map(([k, l]) => (
                <button key={k} type="button" onClick={() => setSourceFilter(k)} className={`px-2 py-1 rounded-md border ${sourceFilter === k ? "border-violet-500 text-white" : "border-gray-800 text-gray-400 hover:text-white"}`}>{l}</button>
              ))}
              <select value={historyDays} onChange={(e) => { const d = Number(e.target.value); setHistoryDays(d); void loadJournal(client.id, account, d, false); }} className="bg-gray-950 border border-gray-700 rounded-md px-2 py-1 text-gray-200">
                {[14, 30, 60, 90, 120].map((d) => <option key={d} value={d}>{d} jours</option>)}
              </select>
              <button type="button" onClick={() => void loadJournal(client.id, account)} className="text-gray-400 hover:text-white flex items-center gap-1">
                <RefreshCw className={`w-3.5 h-3.5 ${loadingJournal ? "animate-spin" : ""}`} /> Relire les journaux
              </button>
            </div>
          )}
        >
          <div className="space-y-4">
            {series && account && (
              <div>
                <p className="text-xs text-gray-500 mb-1">{PLATFORM_FR[account.platform]} · compte « {structure?.account.name || account.accountId} » — dépense et CPA par jour, avec chaque modification marquée.</p>
                {series.error ? <p className="text-xs text-amber-300">Courbe indisponible : {series.error}</p> : (
                  <ChangeChart
                    points={series.points}
                    currency={series.currency}
                    marks={marksOf([
                      ...journal.filter((a) => a.executedAt && a.platform === series.platform && a.accountId === series.accountId).map((a) => ({ at: a.executedAt!, source: "impulsemotion" as const, text: `${a.createdByName} : ${a.operations.map((o) => o.line).join(" ; ")}` })),
                      ...changes.filter((c) => c.platform === series.platform && c.accountId === series.accountId && !(c.pilotActionId && journal.some((a) => a.id === c.pilotActionId))).map((c) => ({ at: c.at, source: c.source, text: `${c.actorName} : ${c.line}` })),
                    ])}
                  />
                )}
              </div>
            )}
            {syncInfo.some((s) => s.lastError) && (
              <p className="text-xs text-amber-300">{syncInfo.filter((s) => s.lastError).map((s) => `${PLATFORM_FR[s.platform]} ${s.accountId} : ${s.lastError}`).join(" · ")}</p>
            )}
            {!syncInfo.length && !loadingJournal && <p className="text-xs text-gray-500">Les journaux des plateformes n&apos;ont pas encore été lus pour ce client.</p>}
            <HistoryTimeline
              actions={journal}
              changes={changes}
              loading={loadingJournal}
              filter={sourceFilter}
              onUndo={(draft) => { setPreview(draft); window.scrollTo({ top: 0, behavior: "smooth" }); }}
              onActionChanged={(a) => setJournal((list) => list.map((x) => (x.id === a.id ? a : x)))}
              onChangeChanged={(c) => setChanges((list) => list.map((x) => (x.id === c.id ? c : x)))}
            />
          </div>
        </Section>
      )}
    </div>
  );
}
