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
import { PilotJournal } from "@/components/pilot/journal";
import { PilotAssistant } from "@/components/pilot/assistant-panel";
import { PLATFORM_FR } from "@/lib/pilot/ops";
import { changeKey, readJson, type PendingChange, type PilotActionView, type PilotClient, type TreeRow } from "@/components/pilot/model";

const plain = (v: string) => v.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

type Platform = "meta" | "google";
type AccountRef = { platform: Platform; accountId: string };
const refKey = (a: AccountRef | null) => (a ? `${a.platform}:${a.accountId}` : "");

type Structure = { campaigns: TreeRow[]; adsets: TreeRow[]; truncated: boolean; account: { id: string; name: string; currency: string }; hqProject: string | null; writesOpen: boolean };

function accountsSummary(c: PilotClient): string {
  const n = (p: Platform) => c.accounts.filter((a) => a.platform === p).length;
  return (["meta", "google"] as const).filter((p) => n(p)).map((p) => `${n(p)} ${PLATFORM_FR[p]}`).join(" + ");
}

export function PilotPage() {
  const [clients, setClients] = useState<PilotClient[] | null>(null);
  const [clientsError, setClientsError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [client, setClient] = useState<PilotClient | null>(null);
  const [account, setAccount] = useState<AccountRef | null>(null);
  const modifyRef = useRef<HTMLDivElement>(null);
  const [structure, setStructure] = useState<Structure | null>(null);
  const [structureError, setStructureError] = useState<string | null>(null);
  const [loadingStructure, setLoadingStructure] = useState(false);
  const [pending, setPending] = useState<PendingChange[]>([]);
  const [preview, setPreview] = useState<PilotActionView | null>(null);
  const [journal, setJournal] = useState<PilotActionView[]>([]);
  const [loadingJournal, setLoadingJournal] = useState(false);

  useEffect(() => {
    fetch("/api/pilot/clients")
      .then(async (r) => { const j = await readJson<{ clients?: PilotClient[] }>(r); if (!r.ok) throw new Error(j.error ?? `Erreur ${r.status}`); return j.clients ?? []; })
      .then(setClients)
      .catch((e) => setClientsError(e instanceof Error ? e.message : String(e)));
  }, []);

  const loadStructure = useCallback(async (clientId: string, ref: AccountRef) => {
    setLoadingStructure(true);
    setStructureError(null);
    try {
      const res = await fetch(`/api/pilot/structure?clientId=${encodeURIComponent(clientId)}&accountId=${encodeURIComponent(ref.accountId)}&platform=${ref.platform}`);
      const j = await readJson<Structure>(res);
      if (!res.ok) throw new Error(j.error ?? `Erreur ${res.status}`);
      setStructure(j);
    } catch (e) {
      setStructure(null);
      setStructureError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingStructure(false);
    }
  }, []);

  const loadJournal = useCallback(async (clientId: string) => {
    setLoadingJournal(true);
    try {
      const res = await fetch(`/api/pilot/actions?clientId=${encodeURIComponent(clientId)}`);
      const j = await readJson<{ actions?: PilotActionView[] }>(res);
      if (res.ok) setJournal(j.actions ?? []);
    } finally {
      setLoadingJournal(false);
    }
  }, []);

  function pick(c: PilotClient) {
    setClient(c);
    setQuery("");
    setPending([]);
    setPreview(null);
    setStructure(null);
    // Meta first, as before; a client with Google Ads only opens on Google.
    const first = c.accounts.find((a) => a.platform === "meta") ?? c.accounts[0];
    const ref = first ? { platform: first.platform, accountId: first.accountId } : null;
    setAccount(ref);
    if (ref) void loadStructure(c.id, ref);
    void loadJournal(c.id);
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
  }

  /** A proposal of the AI, prepared: its account is shown, and its preview waits in « Modifier ». */
  function takePrepared(action: PilotActionView) {
    if (!client) return;
    const a = client.accounts.find((x) => x.platform === action.platform && x.accountId.replace(/^act_/, "").replace(/-/g, "").replace(/^0+/, "") === action.accountId.replace(/^0+/, ""));
    if (a && refKey(a) !== refKey(account)) {
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

  const found = useMemo(() => {
    if (!clients) return [];
    const q = plain(query.trim());
    return clients.filter((c) => !q || plain(c.name).includes(q)).slice(0, 12);
  }, [clients, query]);

  return (
    <div className="p-4 md:p-6 max-w-7xl mx-auto space-y-5">
      <PageHeader
        title="Pilotage"
        subtitle="Modifiez les comptes Meta et Google Ads de vos clients, à la main ou en parlant à l'IA. Chaque changement est montré avant d'être envoyé, puis consigné dans le dossier HQ du client avec votre nom."
      />

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
              <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Chercher un client" className="bg-transparent text-sm text-white outline-none flex-1" />
            </label>
            {clientsError && <p className="text-sm text-red-300 mt-3">{clientsError}</p>}
            {!clients && !clientsError && <p className="text-sm text-gray-500 mt-3 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Lecture des clients…</p>}
            {clients && (
              <ul className="mt-3 grid sm:grid-cols-2 lg:grid-cols-3 gap-2">
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
          <PilotAssistant client={client} focus={account} onPrepared={takePrepared} />
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
                  pending={pending}
                  onAdd={add}
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
                onSent={() => {
                  void loadJournal(client.id);
                  void loadStructure(client.id, account);
                }}
              />
            </Section>
          </div>
        </div>
      )}

      {client && (
        <Section title="Journal des modifications">
          <PilotJournal
            actions={journal}
            loading={loadingJournal}
            onUndo={(draft) => { setPreview(draft); window.scrollTo({ top: 0, behavior: "smooth" }); }}
            onChanged={(a) => setJournal((list) => list.map((x) => (x.id === a.id ? a : x)))}
          />
        </Section>
      )}
    </div>
  );
}
