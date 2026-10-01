"use client";

/**
 * New routine: the client, the accounts the routine may use, a name. The
 * routine is created as a draft, then the page of the routine opens on the
 * conversation with the AI. The accounts are fixed here for good: the AI and
 * every run are limited to them.
 *
 * With a Meta account, the Facebook Page that will publish the ads is picked
 * in the list of those the account can promote (read only): it is handed to
 * the AI, which no longer has to ask for it. Optional.
 *
 * « Sans client (routine libre) »: no dashboard, no account of its own. Such a
 * routine reads Google Sheets, or the accounts of several clients (or of all
 * the clients of the consultant's scope) through its read steps, and sends
 * messages; it never creates ads. An optional label stands for the client's
 * name in the lists.
 */

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, Loader2 } from "lucide-react";
import { Card, PageHeader } from "@/components/ui/surface";
import { exampleByKey } from "@/components/routines/routine-model";

interface ClientOption {
  id: string;
  name: string;
  metaAccountId: string | null;
  googleCustomerId: string | null;
}

interface PageOption { id: string; name: string }

const FIELD = "w-full bg-gray-950 border border-gray-800 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-violet-500 disabled:opacity-60";

export default function NewRoutinePage() {
  const router = useRouter();
  const example = exampleByKey(useSearchParams().get("exemple"));

  const [clients, setClients] = useState<ClientOption[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [clientId, setClientId] = useState("");
  /** "client": the routine of one client; "free": no client of its own. */
  const [mode, setMode] = useState<"client" | "free">("client");
  const [label, setLabel] = useState("");
  const [useMeta, setUseMeta] = useState(true);
  const [useGoogle, setUseGoogle] = useState(true);
  const [name, setName] = useState(example?.name ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Pages of the Meta account they were read for; `error` when the list could not be read. */
  const [pages, setPages] = useState<{ account: string; list: PageOption[]; complete: boolean; error: string | null } | null>(null);
  const [pageId, setPageId] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetch("/api/reports/clients")
      .then(async (r) => {
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(body.error ?? `Erreur ${r.status}`);
        return body;
      })
      .then((j) => {
        if (cancelled) return;
        const list: ClientOption[] = (Array.isArray(j.clients) ? j.clients : [])
          .filter((c: ClientOption) => c && typeof c.id === "string" && typeof c.name === "string")
          .map((c: ClientOption) => ({ id: c.id, name: c.name, metaAccountId: c.metaAccountId ?? null, googleCustomerId: c.googleCustomerId ?? null }));
        setClients(list);
      })
      .catch((e) => { if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, []);

  const client = useMemo(() => (mode === "client" ? clients?.find((c) => c.id === clientId) ?? null : null), [clients, clientId, mode]);
  const free = mode === "free";
  const meta = client?.metaAccountId && useMeta ? client.metaAccountId : null;
  const google = client?.googleCustomerId && useGoogle ? client.googleCustomerId : null;
  // An example that creates ads has no use without a Meta account.
  const needsMeta = example?.key === "creas" && !!client && !meta;

  // The Pages the chosen Meta account can promote. Read only; a failure leaves the form usable.
  useEffect(() => {
    if (!meta) return;
    let cancelled = false;
    fetch(`/api/routines/pages?metaAccountId=${encodeURIComponent(meta)}`)
      .then(async (r) => {
        const body = await r.json().catch(() => ({}));
        if (cancelled) return;
        const list: PageOption[] = (Array.isArray(body.pages) ? body.pages : [])
          .filter((p: PageOption) => p && typeof p.id === "string" && typeof p.name === "string");
        setPages({ account: meta, list, complete: body.complete !== false, error: r.ok ? null : String(body.error ?? `Erreur ${r.status}`) });
      })
      .catch((e) => { if (!cancelled) setPages({ account: meta, list: [], complete: true, error: e instanceof Error ? e.message : String(e) }); });
    return () => { cancelled = true; };
  }, [meta]);
  const pagesOfAccount = meta && pages?.account === meta ? pages : null;
  const chosenPage = pagesOfAccount?.list.find((p) => p.id === pageId) ?? null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || (!client && !free) || !name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      if (!client) {
        // Free routine: no dashboard and no account; what it reads is said by its steps.
        const res = await fetch("/api/routines", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: name.trim(), ...(label.trim() ? { clientName: label.trim() } : {}) }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error ?? `Erreur ${res.status}`);
        const id = body.routine?.id;
        if (typeof id !== "string") throw new Error("Réponse illisible du serveur");
        router.push(`/routines/${id}${example ? `?exemple=${example.key}` : ""}`);
        return;
      }
      // A client without dashboard is listed as "account:…": the routine then hangs on its accounts alone.
      const dashboardId = client.id.startsWith("account:") ? undefined : client.id;
      const res = await fetch("/api/routines", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          clientName: client.name,
          ...(dashboardId ? { dashboardId } : {}),
          ...(meta ? { metaAccountId: meta } : {}),
          ...(google ? { googleCustomerId: google } : {}),
          ...(meta && chosenPage ? { pageId: chosenPage.id } : {}),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.account ? `Le compte ${body.account} n'est pas dans votre périmètre.` : body.error ?? `Erreur ${res.status}`);
      const id = body.routine?.id;
      if (typeof id !== "string") throw new Error("Réponse illisible du serveur");
      router.push(`/routines/${id}${example ? `?exemple=${example.key}` : ""}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <div className="p-4 sm:p-6 max-w-2xl mx-auto space-y-6">
      <Link href="/routines" className="inline-flex items-center gap-1.5 text-xs text-gray-400 hover:text-white">
        <ArrowLeft className="w-3.5 h-3.5" /> Routines
      </Link>
      <PageHeader
        title="Nouvelle routine"
        subtitle={example ? `Exemple choisi : ${example.title.toLowerCase()}. Vous pourrez l'ajuster avec l'IA.` : "Choisissez un client et ses comptes, ou une routine libre ; vous décrirez ensuite la routine à l'IA."}
      />

      <fieldset className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <legend className="sr-only">Pour qui travaille la routine</legend>
        {([
          ["client", "Pour un client", "Ses comptes Meta, Google Ads et TikTok ; seule une routine de client peut créer des publicités."],
          ["free", "Sans client (routine libre)", "Pour n'importe quoi : un Google Sheet, plusieurs clients ou tous ceux de l'agence, un résumé IA, Slack ou e-mail."],
        ] as const).map(([value, title, text]) => (
          <label key={value} className={`flex items-start gap-2 rounded-lg border px-3 py-2 cursor-pointer ${mode === value ? "border-violet-500 bg-violet-950/20" : "border-gray-800 bg-gray-950/50"}`}>
            <input type="radio" name="routine-mode" value={value} checked={mode === value} onChange={() => { setMode(value); setPageId(""); }} disabled={busy} className="accent-violet-600 mt-1" />
            <span className="min-w-0">
              <span className="block text-sm text-gray-200 font-medium">{title}</span>
              <span className="block text-[11px] text-gray-500">{text}</span>
            </span>
          </label>
        ))}
      </fieldset>

      {!free && loadError && (
        <Card padded className="border-red-900/40">
          <p className="text-sm text-red-400">La liste des clients n&apos;a pas pu être chargée ({loadError}).</p>
          <button type="button" onClick={() => window.location.reload()} className="mt-2 text-xs underline text-gray-300">Recharger la page</button>
        </Card>
      )}

      {!free && clients === null && !loadError && (
        <div className="flex items-center gap-2 text-gray-500 text-sm"><Loader2 className="w-4 h-4 animate-spin" /> Chargement des clients…</div>
      )}

      {!free && clients !== null && clients.length === 0 && (
        <Card padded>
          <p className="text-sm text-gray-400">
            Aucun client disponible. Créez d&apos;abord un dashboard client dans <Link href="/d" className="text-violet-400">Dashboards clients</Link>.
          </p>
        </Card>
      )}

      {(free || (clients !== null && clients.length > 0)) && (
        <Card padded>
          <form onSubmit={submit} className="space-y-5">
            {free && (
              <div>
                <label htmlFor="routine-label" className="block text-xs font-semibold text-gray-300 mb-1">Libellé <span className="font-normal text-gray-500">(facultatif)</span></label>
                <input
                  id="routine-label"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  maxLength={120}
                  disabled={busy}
                  placeholder="Ex. : Portefeuille, Équipe e-commerce"
                  className={FIELD}
                />
                <p className="text-[11px] text-gray-500 mt-1">
                  Remplace le nom du client dans la liste des routines. La routine n&apos;a aucun compte à elle : ses étapes de lecture
                  nomment les clients qu&apos;elles lisent (ou tous les clients de l&apos;agence : 40 comptes au plus par exécution, les plus
                  dépensiers d&apos;abord), relus à chaque exécution dans votre périmètre. Elle ne crée pas de publicités, et ses messages
                  partent dans un canal Slack interne de l&apos;agence ou à des adresses @impulse-analytics.com, jamais chez un client.
                </p>
                {example?.key === "creas" && (
                  <p className="text-xs text-amber-300 mt-1.5">Cet exemple crée des publicités : il lui faut un client et son compte Meta Ads.</p>
                )}
              </div>
            )}

            {!free && (
            <div>
              <label htmlFor="routine-client" className="block text-xs font-semibold text-gray-300 mb-1">Client</label>
              <select
                id="routine-client"
                value={clientId}
                onChange={(e) => { setClientId(e.target.value); setUseMeta(true); setUseGoogle(true); setPageId(""); }}
                disabled={busy}
                required
                className={FIELD}
              >
                <option value="">Choisir un client…</option>
                {(clients ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            )}

            {client && (
              <fieldset>
                <legend className="block text-xs font-semibold text-gray-300 mb-1">Comptes que la routine peut utiliser</legend>
                <div className="space-y-2">
                  {client.metaAccountId ? (
                    <label className="flex items-start gap-2 text-sm text-gray-300 bg-gray-950/50 border border-gray-800 rounded-lg px-3 py-2">
                      <input type="checkbox" checked={useMeta} onChange={(e) => setUseMeta(e.target.checked)} disabled={busy} className="accent-violet-600 mt-1" />
                      <span className="min-w-0">
                        Meta Ads <span className="font-mono text-xs text-gray-400 break-all">{client.metaAccountId}</span>
                        <span className="block text-[11px] text-gray-500">Lecture des performances ; création de publicités en pause si la routine le prévoit.</span>
                      </span>
                    </label>
                  ) : (
                    <p className="text-xs text-gray-500 bg-gray-950/50 border border-gray-800 rounded-lg px-3 py-2">Pas de compte Meta Ads lié à ce client.</p>
                  )}
                  {client.googleCustomerId ? (
                    <label className="flex items-start gap-2 text-sm text-gray-300 bg-gray-950/50 border border-gray-800 rounded-lg px-3 py-2">
                      <input type="checkbox" checked={useGoogle} onChange={(e) => setUseGoogle(e.target.checked)} disabled={busy} className="accent-violet-600 mt-1" />
                      <span className="min-w-0">
                        Google Ads <span className="font-mono text-xs text-gray-400 break-all">{client.googleCustomerId}</span>
                        <span className="block text-[11px] text-gray-500">Lecture seule.</span>
                      </span>
                    </label>
                  ) : (
                    <p className="text-xs text-gray-500 bg-gray-950/50 border border-gray-800 rounded-lg px-3 py-2">Pas de compte Google Ads lié à ce client.</p>
                  )}
                  {!client.id.startsWith("account:") && (
                    <p className="text-xs text-gray-500 bg-gray-950/50 border border-gray-800 rounded-lg px-3 py-2">
                      TikTok Ads : les comptes TikTok rattachés à ce client (carte « Sources de données » de sa fiche) sont lus à chaque exécution, en lecture seule.
                    </p>
                  )}
                </div>
                <p className="text-[11px] text-gray-500 mt-1.5">
                  Ces comptes sont fixés à la création : l&apos;IA et chaque exécution y sont limitées. Une étape peut aussi lire d&apos;autres clients de votre périmètre si vous le demandez à l&apos;IA.
                </p>
                {needsMeta && (
                  <p className="text-xs text-amber-300 mt-1.5">Cet exemple crée des publicités : il lui faut un compte Meta Ads.</p>
                )}
              </fieldset>
            )}

            {meta && (
              <div>
                <label htmlFor="routine-page" className="block text-xs font-semibold text-gray-300 mb-1">Page Facebook qui publiera les publicités <span className="font-normal text-gray-500">(facultatif)</span></label>
                {!pagesOfAccount && (
                  <div className="flex items-center gap-2 text-gray-500 text-xs"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Lecture des Pages du compte…</div>
                )}
                {pagesOfAccount && pagesOfAccount.list.length > 0 && (
                  <select id="routine-page" value={chosenPage ? pageId : ""} onChange={(e) => setPageId(e.target.value)} disabled={busy} className={FIELD}>
                    <option value="">Ne pas choisir maintenant</option>
                    {pagesOfAccount.list.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.id})</option>)}
                  </select>
                )}
                {pagesOfAccount && pagesOfAccount.list.length === 0 && (
                  <p className="text-xs text-gray-500 bg-gray-950/50 border border-gray-800 rounded-lg px-3 py-2">
                    {pagesOfAccount.error
                      ? `La liste des Pages n'a pas pu être lue (${pagesOfAccount.error}). Vous pourrez donner la Page à l'IA.`
                      : "Aucune Page à promouvoir n'est rattachée à ce compte. Vous pourrez donner la Page à l'IA."}
                  </p>
                )}
                <p className="text-[11px] text-gray-500 mt-1">
                  Utile seulement si la routine crée des publicités : la Page est transmise à l&apos;IA, qui n&apos;aura pas à vous la demander.
                  {pagesOfAccount && !pagesOfAccount.complete ? " La liste est incomplète : ce compte a plus de 200 Pages." : ""}
                </p>
              </div>
            )}

            <div>
              <label htmlFor="routine-name" className="block text-xs font-semibold text-gray-300 mb-1">Nom de la routine</label>
              <input
                id="routine-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={120}
                required
                disabled={busy}
                placeholder="Ex. : Point hebdo Slack"
                className={FIELD}
              />
              <p className="text-[11px] text-gray-500 mt-1">L&apos;IA pourra proposer un nom plus précis avec la routine.</p>
            </div>

            {error && <div className="text-sm text-red-400 break-words">{error}</div>}

            <div className="flex flex-wrap items-center gap-3">
              <button
                type="submit"
                disabled={busy || (!client && !free) || (free && example?.key === "creas") || !name.trim()}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-sm font-semibold disabled:opacity-50"
              >
                {busy && <Loader2 className="w-4 h-4 animate-spin" />}
                {busy ? "Création…" : "Créer et décrire la routine"}
              </button>
              <Link href="/routines" className="text-sm text-gray-400 hover:text-white">Annuler</Link>
            </div>
          </form>
        </Card>
      )}
    </div>
  );
}
