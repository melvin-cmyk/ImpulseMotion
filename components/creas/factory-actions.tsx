"use client";

/**
 * Fabrique de statics — what follows the sorting of a grid:
 *   VariationRunDialog  « Variations sur les gardées » : a persona, a season or a consigne → a new run (kind variation)
 *                       whose copies go through validation again, each visual made with its kept one as reference.
 *   PublishDialog       « Publier les gardées » : account, ad set, Page, one primary text and one link → the PREVIEW
 *                       (one Pilotage action, one ad per kept visual, title = its copy, checked on Meta, nothing sent)
 *                       → ONE confirmation → every ad created PAUSED, journaled in HQ.
 */

import { useEffect, useState } from "react";
import { Check, Loader2, Send, Sparkles } from "lucide-react";
import { Modal } from "./dialogs";
import { BTN, BTN_PRIMARY, FIELD, type FactoryRun } from "./shared";

export function VariationRunDialog({ run, onClose, onCreated }: { run: FactoryRun; onClose: () => void; onCreated: (r: FactoryRun, error?: string) => void }) {
  const [persona, setPersona] = useState("");
  const [season, setSeason] = useState("");
  const [instructions, setInstructions] = useState("");
  const [perTemplate, setPerTemplate] = useState(2);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function create() {
    setBusy(true); setError(null);
    try {
      const res = await fetch(`/api/creas/factory/${run.id}/variations`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ persona, season, instructions, perTemplate }) });
      const j = (await res.json().catch(() => ({}))) as { run?: FactoryRun; error?: string };
      if (!res.ok || !j.run) throw new Error(j.error ?? `Erreur ${res.status}`);
      onCreated(j.run, j.error);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  return (
    <Modal title={`Variations sur les ${run.kept} gardée${run.kept > 1 ? "s" : ""}`} onClose={onClose}>
      <div className="space-y-3 text-xs" data-factory-variation>
        <p className="text-gray-400">Même marque, mêmes templates : l&apos;IA décline les copys des visuels gardés pour une autre persona ou une autre saison. Vous les validez, puis chaque visuel est refait à partir du visuel gardé.</p>
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-gray-400">Persona<input value={persona} onChange={(e) => setPersona(e.target.value)} placeholder="Ex. : parents de lycéens en Terminale" className={FIELD} /></label>
          <label className="flex flex-col gap-1 text-gray-400">Saison / moment<input value={season} onChange={(e) => setSeason(e.target.value)} placeholder="Ex. : Noël, rentrée, bac blanc" className={FIELD} /></label>
        </div>
        <label className="flex flex-col gap-1 text-gray-400">Consigne (facultatif)<textarea value={instructions} onChange={(e) => setInstructions(e.target.value)} rows={2} className={`${FIELD} resize-y`} placeholder="Ex. : ton plus chaleureux, pas de prix" /></label>
        <label className="flex items-center gap-2 text-gray-400">Copys par template
          <select value={perTemplate} onChange={(e) => setPerTemplate(Number(e.target.value))} className={FIELD}>{[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}</select>
        </label>
        {error && <p className="text-rose-300">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={BTN}>Annuler</button>
          <button type="button" onClick={() => void create()} disabled={busy || (!persona.trim() && !season.trim() && !instructions.trim())} className={BTN_PRIMARY} data-factory-variation-create>{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />} {busy ? "L'IA écrit les copys…" : "Proposer les copys"}</button>
        </div>
      </div>
    </Modal>
  );
}

interface Targets {
  writesOpen: boolean;
  accounts: Array<{ id: string; name: string }>;
  adsets: Array<{ accountId: string; adsetId: string; adset: string; campaign: string; status: string | null; spend30: number }>;
  pages: Array<{ id: string; name: string }>;
  instagram: Array<{ id: string; name: string }>;
  defaults: { primaryText: string; linkUrl: string; from: string | null };
  hqProject: string | null;
  kept: Array<{ assetId: string; headline: string; subline: string; image: string | null; published: boolean }>;
}
interface ActionOp { id: string; objectName: string; line: string; status: string; error: string | null; readBack: string | number | null }
interface Action { id: string; status: string; operations: ActionOp[]; notes?: string[]; hqProject: string | null; hqError: string | null }

const CTAS = ["LEARN_MORE", "SHOP_NOW", "SIGN_UP", "CONTACT_US", "GET_QUOTE", "BOOK_TRAVEL", "SUBSCRIBE", "APPLY_NOW", "ORDER_NOW", "GET_OFFER", "DOWNLOAD"];
const CTA_FR: Record<string, string> = { LEARN_MORE: "En savoir plus", SHOP_NOW: "Acheter", SIGN_UP: "S'inscrire", CONTACT_US: "Nous contacter", GET_QUOTE: "Demander un devis", BOOK_TRAVEL: "Réserver", SUBSCRIBE: "S'abonner", APPLY_NOW: "Postuler", ORDER_NOW: "Commander", GET_OFFER: "Profiter de l'offre", DOWNLOAD: "Télécharger" };

export function PublishDialog({ run, onClose, onPublished }: { run: FactoryRun; onClose: () => void; onPublished: (message: string) => void }) {
  const [targets, setTargets] = useState<Targets | null>(null);
  const [account, setAccount] = useState("");
  const [adset, setAdset] = useState("");
  const [page, setPage] = useState("");
  const [instagram, setInstagram] = useState("");
  const [primaryText, setPrimaryText] = useState("");
  const [linkUrl, setLinkUrl] = useState("");
  const [cta, setCta] = useState("LEARN_MORE");
  const [picked, setPicked] = useState<string[]>([]);
  const [why, setWhy] = useState("");
  const [preview, setPreview] = useState<Action | null>(null);
  const [busy, setBusy] = useState<"load" | "preview" | "send" | null>("load");
  const [error, setError] = useState<string | null>(null);

  async function loadTargets(acc?: string) {
    setBusy("load"); setError(null);
    try {
      const res = await fetch(`/api/creas/factory/${run.id}/publish${acc ? `?account=${acc}` : ""}`, { cache: "no-store" });
      const j = (await res.json().catch(() => ({}))) as { targets?: Targets; error?: string };
      if (!res.ok || !j.targets) throw new Error(j.error ?? `Erreur ${res.status}`);
      const t = j.targets;
      setTargets(t);
      setAccount((a) => a || acc || t.accounts[0]?.id || "");
      setPage(t.pages.length === 1 ? t.pages[0].id : "");
      setInstagram(t.instagram.length === 1 ? t.instagram[0].id : "");
      setPrimaryText((p) => p || t.defaults.primaryText);
      setLinkUrl((l) => l || t.defaults.linkUrl);
      setPicked((p) => (p.length ? p : t.kept.filter((k) => !k.published).slice(0, 12).map((k) => k.assetId)));
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  }
  useEffect(() => { queueMicrotask(() => void loadTargets()); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function post(body: Record<string, unknown>) {
    const res = await fetch(`/api/creas/factory/${run.id}/publish`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = (await res.json().catch(() => ({}))) as { action?: Action; error?: string };
    if (!res.ok || !j.action) throw new Error(j.error ?? `Erreur ${res.status}`);
    return j.action;
  }
  async function doPreview() {
    setBusy("preview"); setError(null);
    try { setPreview(await post({ accountId: account, adsetId: adset, pageId: page, instagramUserId: instagram || undefined, primaryText, linkUrl, callToAction: cta, assetIds: picked, why })); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  }
  async function send() {
    if (!preview) return;
    setBusy("send"); setError(null);
    try {
      const done = await post({ confirm: true, actionId: preview.id, why });
      setPreview(done);
      const ok = done.operations.filter((o) => o.status === "done").length;
      onPublished(`${ok} publicité${ok > 1 ? "s" : ""} créée${ok > 1 ? "s" : ""} EN PAUSE sur Meta${done.hqProject ? `, consignée${ok > 1 ? "s" : ""} dans HQ (projects/${done.hqProject})` : ""}.`);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  }

  const adsets = targets?.adsets.filter((a) => !account || a.accountId === account) ?? [];
  const sent = preview && preview.status !== "draft";
  return (
    <Modal title="Publier les gardées sur Meta (en pause)" onClose={onClose} wide>
      <div className="space-y-3 text-xs" data-factory-publish>
        {busy === "load" && !targets && <p className="text-gray-500 inline-flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Lecture des comptes, ensembles et Pages…</p>}
        {targets && !targets.writesOpen && <p className="text-amber-300">Les écritures Meta ne sont pas ouvertes sur cette application : l&apos;aperçu marche, l&apos;envoi sera refusé.</p>}
        {targets && !targets.accounts.length && <p className="text-amber-300">Ce client n&apos;a pas de compte Meta rattaché.</p>}
        {targets && targets.accounts.length > 0 && !preview && (
          <>
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="flex flex-col gap-1 text-gray-400">Compte
                <select value={account} onChange={(e) => { setAccount(e.target.value); setAdset(""); void loadTargets(e.target.value); }} className={FIELD}>{targets.accounts.map((a) => <option key={a.id} value={a.id}>{a.name} · act_{a.id}</option>)}</select>
              </label>
              <label className="flex flex-col gap-1 text-gray-400">Ensemble de publicités
                <select value={adset} onChange={(e) => setAdset(e.target.value)} className={FIELD} data-factory-publish-adset><option value="">Choisir…</option>{adsets.map((a) => <option key={a.adsetId} value={a.adsetId}>{a.campaign ? `${a.campaign} › ` : ""}{a.adset}{a.spend30 ? ` · ${a.spend30.toLocaleString("fr-FR")} € / 30 j` : " · sans dépense 30 j"}</option>)}</select>
              </label>
              <label className="flex flex-col gap-1 text-gray-400">Page Facebook
                <select value={page} onChange={(e) => setPage(e.target.value)} className={FIELD}><option value="">Choisir…</option>{targets.pages.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
              </label>
              <label className="flex flex-col gap-1 text-gray-400">Compte Instagram
                <select value={instagram} onChange={(e) => setInstagram(e.target.value)} className={FIELD}><option value="">Aucun (celui de la Page)</option>{targets.instagram.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
              </label>
            </div>
            <label className="flex flex-col gap-1 text-gray-400">Texte principal (le même pour toutes){targets.defaults.from && primaryText === targets.defaults.primaryText ? <span className="text-gray-500">repris de la pub la plus dépensée sur 30 jours : « {targets.defaults.from} »</span> : null}
              <textarea value={primaryText} onChange={(e) => setPrimaryText(e.target.value)} rows={3} className={`${FIELD} resize-y`} />
            </label>
            <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
              <label className="flex flex-col gap-1 text-gray-400">Lien de destination<input value={linkUrl} onChange={(e) => setLinkUrl(e.target.value)} placeholder="https://…" className={FIELD} /></label>
              <label className="flex flex-col gap-1 text-gray-400">Bouton<select value={cta} onChange={(e) => setCta(e.target.value)} className={FIELD}>{CTAS.map((c) => <option key={c} value={c}>{CTA_FR[c]}</option>)}</select></label>
            </div>
            <div>
              <p className="text-gray-400 mb-1">Visuels gardés — titre de chaque pub = son copy ({picked.length} coché{picked.length > 1 ? "s" : ""}, 12 au plus)</p>
              <ul className="grid gap-2 grid-cols-3 sm:grid-cols-6">
                {targets.kept.map((k) => { const on = picked.includes(k.assetId); return (
                  <li key={k.assetId}>
                    <button type="button" onClick={() => setPicked((p) => (on ? p.filter((x) => x !== k.assetId) : p.length < 12 ? [...p, k.assetId] : p))} className={`relative w-full rounded-lg overflow-hidden border-2 ${on ? "border-violet-500" : "border-gray-800"}`} title={k.headline}>
                      {k.image && <img src={k.image} alt="" className="w-full aspect-square object-cover" />}
                      {on && <span className="absolute top-1 left-1 w-4 h-4 rounded bg-violet-600 text-white inline-flex items-center justify-center"><Check className="w-3 h-3" /></span>}
                      {k.published && <span className="absolute bottom-1 left-1 text-[9px] px-1 rounded bg-emerald-600/80 text-white">déjà publiée</span>}
                    </button>
                  </li>
                ); })}
              </ul>
              {!targets.kept.length && <p className="text-amber-300">Aucun visuel gardé dans cette fabrique.</p>}
            </div>
            <label className="flex flex-col gap-1 text-gray-400">Pourquoi (écrit dans HQ)<input value={why} onChange={(e) => setWhy(e.target.value)} placeholder="Ex. : tester les angles témoignage de la fabrique" className={FIELD} /></label>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={onClose} className={BTN}>Annuler</button>
              <button type="button" onClick={() => void doPreview()} disabled={!!busy || !adset || !page || !picked.length || !primaryText.trim() || !/^https:\/\//.test(linkUrl)} className={BTN_PRIMARY} data-factory-publish-preview>{busy === "preview" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} {busy === "preview" ? "Vérification sur Meta…" : `Aperçu des ${picked.length} publicités`}</button>
            </div>
          </>
        )}
        {preview && (
          <div className="space-y-2" data-factory-publish-summary>
            <p className="text-sm text-gray-200">{sent ? "Résultat de l'envoi" : `${preview.operations.length} publicité${preview.operations.length > 1 ? "s" : ""} prête${preview.operations.length > 1 ? "s" : ""} — rien n'est encore envoyé`}</p>
            <ul className="divide-y divide-gray-800 border border-gray-800 rounded-lg max-h-72 overflow-auto">
              {preview.operations.map((o) => (
                <li key={o.id} className="px-2.5 py-1.5 flex items-start gap-2">
                  <span className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded ${o.status === "done" ? "bg-emerald-600/30 text-emerald-200" : o.status === "failed" ? "bg-rose-600/30 text-rose-200" : "bg-gray-800 text-gray-300"}`}>{o.status === "done" ? "créée (en pause)" : o.status === "failed" ? "échec" : "à créer"}</span>
                  <span className="text-gray-300">{o.line}{o.error ? <span className="text-rose-300"> — {o.error}</span> : null}</span>
                </li>
              ))}
            </ul>
            {preview.notes?.map((n) => <p key={n} className="text-gray-500">{n}</p>)}
            {!sent && (
              <div className="rounded-lg border border-sky-500/30 bg-sky-500/5 p-2.5 text-sky-100/90 space-y-1">
                <p className="font-medium text-sky-100">À la confirmation</p>
                <ol className="list-decimal list-inside space-y-0.5">
                  <li>Les {preview.operations.length} publicités sont créées sur Meta, toutes EN PAUSE : rien n&apos;est dépensé avant leur activation.</li>
                  <li>L&apos;envoi est consigné dans {targets?.hqProject ? <code>HQ projects/{targets.hqProject}</code> : "HQ (dossier du client à choisir : ce client n'en a pas)"} et dans le Pilotage du client.</li>
                </ol>
              </div>
            )}
            <div className="flex justify-end gap-2">
              {!sent && <button type="button" onClick={() => setPreview(null)} className={BTN}>Modifier</button>}
              {!sent ? <button type="button" onClick={() => void send()} disabled={!!busy} className={BTN_PRIMARY} data-factory-publish-confirm>{busy === "send" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />} Confirmer et créer en pause</button>
                : <button type="button" onClick={onClose} className={BTN_PRIMARY}>Fermer</button>}
            </div>
          </div>
        )}
        {error && <p className="text-rose-300 whitespace-pre-wrap">{error}</p>}
      </div>
    </Modal>
  );
}
