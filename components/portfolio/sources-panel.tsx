"use client";

/**
 * « Sources de données » card of the client sheet (staff): legacy Meta / Google
 * links (read-only, edited on the dashboard itself) + stored sources (HubSpot,
 * TikTok Ads) with status / last sync / error, an add-HubSpot form (test then
 * save), an add-TikTok form (the account is looked up at TikTok and its name
 * shown before it can be attached) and a remove button.
 * Talks to /api/dashboards/[id]/sources*.
 */

import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, Database, Loader2, Plus, Trash2, XCircle } from "lucide-react";
import { Pill, Section } from "@/components/ui/surface";
import type { DashboardSourceRef } from "@/lib/sources";
import type { TikTokAdvertiser } from "@/lib/tiktok-accounts";

type Toast = { message: string; tone: "error" | "ok" };
type TestResult =
  | { ok: true; portalId: string; hubDomain: string | null; scopesOk: boolean; missingScopes: string[] }
  | { ok: false; error: string };
type TikTokCheck =
  | { ok: true; advertiser: TikTokAdvertiser; alreadyOn: string[] }
  | { ok: false; error: string };

const KIND_LABEL: Record<DashboardSourceRef["kind"], string> = { meta: "Meta Ads", google: "Google Ads", hubspot: "HubSpot", tiktok: "TikTok Ads" };
const KIND_TONE: Record<DashboardSourceRef["kind"], "blue" | "emerald" | "amber" | "violet"> = { meta: "blue", google: "emerald", hubspot: "amber", tiktok: "violet" };
const STATUS: Record<DashboardSourceRef["status"], { label: string; tone: "emerald" | "red" | "default" }> = {
  active: { label: "Active", tone: "emerald" },
  error: { label: "Erreur", tone: "red" },
  disabled: { label: "Désactivée", tone: "default" },
};

const fmtDateTime = (iso: string) => new Date(iso).toLocaleString("fr-FR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

const btn = "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border bg-gray-900 border-gray-800 text-gray-300 hover:text-white hover:border-gray-700 transition-colors disabled:opacity-50 disabled:pointer-events-none";
const btnPrimary = "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-violet-600 hover:bg-violet-500 text-white disabled:opacity-50 disabled:pointer-events-none";
const field = "w-full bg-gray-950 border border-gray-800 rounded-lg px-2.5 py-1.5 text-xs text-white placeholder:text-gray-600 focus:outline-none focus:border-violet-500 disabled:opacity-60";

/** Currency and timezone of a stored TikTok account, as kept at the time it was attached. */
function tiktokDetails(config: Record<string, unknown>): string {
  return [config.currency, config.timezone].filter((v): v is string => typeof v === "string" && v !== "").join(" · ");
}

async function readError(res: Response): Promise<string> {
  const body = await res.json().catch(() => ({}));
  return typeof body.error === "string" ? body.error : `Erreur ${res.status}`;
}

export function SourcesPanel({ dashboardId, onToast }: { dashboardId: string; onToast?: (t: Toast) => void }) {
  const [sources, setSources] = useState<DashboardSourceRef[] | null>(null);
  const [secretsConfigured, setSecretsConfigured] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [token, setToken] = useState("");
  const [label, setLabel] = useState("");
  const [test, setTest] = useState<TestResult | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [showTikTok, setShowTikTok] = useState(false);
  const [advertiserId, setAdvertiserId] = useState("");
  const [tiktokCheck, setTikTokCheck] = useState<TikTokCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [attaching, setAttaching] = useState(false);

  const notify = useCallback((t: Toast) => { if (onToast) onToast(t); else if (t.tone === "error") setError(t.message); }, [onToast]);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(`/api/dashboards/${dashboardId}/sources`, { cache: "no-store" });
      if (!res.ok) throw new Error(await readError(res));
      const json = await res.json() as { sources: DashboardSourceRef[]; secretsConfigured: boolean };
      setSources(json.sources);
      setSecretsConfigured(json.secretsConfigured);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erreur");
      setSources((s) => s ?? []);
    }
  }, [dashboardId]);

  useEffect(() => { void load(); }, [load]);

  function resetForm() { setShowForm(false); setToken(""); setLabel(""); setTest(null); }

  async function runTest(): Promise<TestResult | null> {
    const t = token.trim();
    if (!t) { notify({ message: "Saisissez le token d'app privée HubSpot", tone: "error" }); return null; }
    setTesting(true);
    setTest(null);
    try {
      const res = await fetch(`/api/dashboards/${dashboardId}/sources/test`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: t }),
      });
      if (!res.ok) throw new Error(await readError(res));
      const r = await res.json() as TestResult;
      setTest(r);
      return r;
    } catch (e) {
      const r: TestResult = { ok: false, error: e instanceof Error ? e.message : "Erreur" };
      setTest(r);
      return r;
    } finally {
      setTesting(false);
    }
  }

  async function save() {
    const t = token.trim();
    if (!t) { notify({ message: "Saisissez le token d'app privée HubSpot", tone: "error" }); return; }
    setSaving(true);
    try {
      const res = await fetch(`/api/dashboards/${dashboardId}/sources`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "hubspot", token: t, label: label.trim() || undefined, ...(test?.ok ? { portalId: test.portalId } : {}) }),
      });
      if (!res.ok) throw new Error(await readError(res));
      const json = await res.json() as { source: DashboardSourceRef; test: { scopesOk: boolean; missingScopes: string[] } | null };
      const warn = json.test && !json.test.scopesOk ? ` — scopes manquants : ${json.test.missingScopes.join(", ")}` : "";
      notify({ message: `Source HubSpot ${json.source.externalId} enregistrée${warn}`, tone: warn ? "error" : "ok" });
      resetForm();
      await load();
    } catch (e) {
      notify({ message: `Impossible d'enregistrer la source : ${e instanceof Error ? e.message : "erreur"}`, tone: "error" });
    } finally {
      setSaving(false);
    }
  }

  function resetTikTok() { setShowTikTok(false); setAdvertiserId(""); setTikTokCheck(null); }

  async function checkTikTok() {
    const id = advertiserId.trim();
    if (!id) { notify({ message: "Saisissez l'identifiant du compte TikTok Ads", tone: "error" }); return; }
    setChecking(true);
    setTikTokCheck(null);
    try {
      const res = await fetch(`/api/dashboards/${dashboardId}/sources`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "tiktok", advertiserId: id }),
      });
      if (!res.ok) throw new Error(await readError(res));
      const json = await res.json() as { check: { advertiser: TikTokAdvertiser; alreadyOn: string[] } };
      setTikTokCheck({ ok: true, ...json.check });
    } catch (e) {
      setTikTokCheck({ ok: false, error: e instanceof Error ? e.message : "Erreur" });
    } finally {
      setChecking(false);
    }
  }

  async function attachTikTok() {
    if (!tiktokCheck?.ok) return;
    setAttaching(true);
    try {
      // The id sent is the one of the account shown, not what the field holds now.
      const res = await fetch(`/api/dashboards/${dashboardId}/sources`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "tiktok", advertiserId: tiktokCheck.advertiser.id, confirm: true }),
      });
      if (!res.ok) throw new Error(await readError(res));
      const json = await res.json() as { source: DashboardSourceRef };
      notify({ message: `Compte TikTok Ads « ${json.source.label ?? json.source.externalId} » rattaché à ce client`, tone: "ok" });
      resetTikTok();
      await load();
    } catch (e) {
      notify({ message: `Impossible de rattacher le compte TikTok Ads : ${e instanceof Error ? e.message : "erreur"}`, tone: "error" });
    } finally {
      setAttaching(false);
    }
  }

  async function remove(s: DashboardSourceRef) {
    if (!s.id) return;
    const name = `${KIND_LABEL[s.kind]} ${s.label ? `« ${s.label} » ` : ""}(${s.externalId})`;
    const consequence = s.kind === "tiktok"
      ? "L'IA de ce client ne lira plus ce compte."
      : "Le token sera effacé ; les widgets CRM de ce client n'auront plus de données.";
    if (!window.confirm(`Supprimer la source ${name} ?\n${consequence}`)) return;
    setRemoving(s.id);
    try {
      const res = await fetch(`/api/dashboards/${dashboardId}/sources/${s.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(await readError(res));
      notify({ message: `Source ${name} supprimée`, tone: "ok" });
      await load();
    } catch (e) {
      notify({ message: `Suppression impossible : ${e instanceof Error ? e.message : "erreur"}`, tone: "error" });
    } finally {
      setRemoving(null);
    }
  }

  const hasHubspot = !!sources?.some((s) => s.kind === "hubspot");
  const canAdd = secretsConfigured && !showForm;
  const tiktokAlreadyHere = tiktokCheck?.ok && !!sources?.some((s) => s.kind === "tiktok" && s.externalId === tiktokCheck.advertiser.id);

  return (
    <Section
      title="Sources de données"
      icon={<Database className="w-4 h-4 text-violet-400" />}
      action={sources && (
        <div className="flex items-center justify-end gap-2 flex-wrap">
          <button type="button" className={btn} disabled={showTikTok} onClick={() => setShowTikTok(true)}>
            <Plus className="w-3.5 h-3.5" /> Ajouter TikTok Ads
          </button>
          <button type="button" className={btn} disabled={!canAdd} onClick={() => setShowForm(true)} title={secretsConfigured ? undefined : "SOURCE_SECRETS_KEY non configurée"}>
            <Plus className="w-3.5 h-3.5" /> {hasHubspot ? "Remplacer le token HubSpot" : "Ajouter HubSpot"}
          </button>
        </div>
      )}
    >
      {!secretsConfigured && (
        <div className="mx-4 mt-3 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-200">
          Clé de chiffrement <code className="text-amber-100">SOURCE_SECRETS_KEY</code> non configurée sur le serveur : impossible d&apos;enregistrer un token HubSpot.
        </div>
      )}
      {error && <div className="mx-4 mt-3 text-xs text-red-400">{error}</div>}

      {sources === null ? (
        <div className="px-4 py-6 text-xs text-gray-500 inline-flex items-center gap-2"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Chargement des sources…</div>
      ) : sources.length === 0 ? (
        <div className="px-4 py-6 text-xs text-gray-500">Aucune source : ce client n&apos;est lié ni à un compte publicitaire ni à un CRM.</div>
      ) : (
        <div className="divide-y divide-gray-800">
          {sources.map((s) => {
            const st = STATUS[s.status];
            const details = s.kind === "tiktok" ? tiktokDetails(s.config) : "";
            return (
              <div key={s.id ?? `${s.kind}:${s.externalId}`} className="px-4 py-2.5 flex items-center gap-3">
                <Pill tone={KIND_TONE[s.kind]} className="shrink-0 w-24 text-center">{KIND_LABEL[s.kind]}</Pill>
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-white truncate">
                    {s.label ? <>{s.label} <span className="text-gray-500">· {s.externalId}</span></> : s.externalId}
                  </div>
                  <div className="text-[11px] text-gray-500 truncate">
                    {s.legacy ? "Lié sur le dashboard (lecture seule ici)" : s.kind === "tiktok" ? (
                      <>
                        Lu par l&apos;IA de ce client{details ? ` · ${details}` : ""}
                        {s.lastError && <span className="text-red-400"> · {s.lastError}</span>}
                      </>
                    ) : (
                      <>
                        {s.hasSecret ? "Token chiffré" : "Aucun token"}
                        {s.lastSyncAt ? ` · dernière synchro ${fmtDateTime(s.lastSyncAt)}` : " · jamais synchronisée"}
                        {s.lastError && <span className="text-red-400"> · {s.lastError}</span>}
                      </>
                    )}
                  </div>
                </div>
                {!s.legacy && <Pill tone={st.tone}>{st.label}</Pill>}
                {!s.legacy && s.id && (
                  <button type="button" onClick={() => remove(s)} disabled={removing === s.id} className="text-gray-500 hover:text-red-400 disabled:opacity-50" title="Supprimer la source">
                    {removing === s.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {showForm && (
        <form className="border-t border-gray-800 px-4 py-3 space-y-2" onSubmit={(e) => { e.preventDefault(); void save(); }}>
          <div className="text-xs text-gray-400">
            Token d&apos;<strong className="text-gray-300">app privée</strong> HubSpot du client (Paramètres → Intégrations → Applications privées ; scopes CRM contacts / deals / pipelines en lecture). Il est chiffré en base et jamais réaffiché.
          </div>
          <div className="grid sm:grid-cols-[1fr_200px] gap-2">
            <input type="password" autoComplete="off" spellCheck={false} placeholder="pat-eu1-…" value={token} onChange={(e) => { setToken(e.target.value); setTest(null); }} disabled={saving} className={`${field} font-mono`} />
            <input type="text" placeholder="Libellé (optionnel)" value={label} onChange={(e) => setLabel(e.target.value)} disabled={saving} className={field} />
          </div>
          {test && (
            <div className={`text-xs inline-flex items-start gap-1.5 ${test.ok ? (test.scopesOk ? "text-emerald-300" : "text-amber-300") : "text-red-400"}`}>
              {test.ok ? <CheckCircle2 className="w-3.5 h-3.5 mt-0.5 shrink-0" /> : <XCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />}
              <span>
                {test.ok
                  ? <>Connexion OK — portail {test.portalId}{test.hubDomain ? ` (${test.hubDomain})` : ""}{test.scopesOk ? "" : ` — scopes manquants : ${test.missingScopes.join(", ")}`}</>
                  : <>Connexion refusée — {test.error}</>}
              </span>
            </div>
          )}
          <div className="flex items-center gap-2 flex-wrap">
            <button type="button" className={btn} onClick={() => void runTest()} disabled={testing || saving || !token.trim()}>
              {testing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null} Tester la connexion
            </button>
            <button type="submit" className={btnPrimary} disabled={saving || testing || !token.trim() || (test !== null && !test.ok)}>
              {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null} Enregistrer
            </button>
            <button type="button" className="text-xs text-gray-500 hover:text-white" onClick={resetForm} disabled={saving}>Annuler</button>
          </div>
        </form>
      )}

      {showTikTok && (
        <form className="border-t border-gray-800 px-4 py-3 space-y-2" onSubmit={(e) => { e.preventDefault(); void checkTikTok(); }}>
          <div className="text-xs text-gray-400">
            <strong className="text-gray-300">Identifiant du compte TikTok Ads</strong> du client : il se lit dans TikTok Ads Manager, en haut à droite sous le nom du compte, ou dans l&apos;adresse de la page après <code className="text-gray-300">aadvid=</code>. Le compte est d&apos;abord retrouvé chez TikTok : vérifiez que son nom est bien celui de ce client avant de le rattacher.
          </div>
          <input type="text" inputMode="numeric" autoComplete="off" spellCheck={false} placeholder="7123456789012345678" aria-label="Identifiant du compte TikTok Ads" value={advertiserId} onChange={(e) => { setAdvertiserId(e.target.value); setTikTokCheck(null); }} disabled={checking || attaching} className={`${field} font-mono sm:max-w-xs`} />
          {tiktokCheck && (
            <div className={`text-xs flex items-start gap-1.5 ${tiktokCheck.ok ? "text-emerald-300" : "text-red-400"}`}>
              {tiktokCheck.ok ? <CheckCircle2 className="w-3.5 h-3.5 mt-0.5 shrink-0" /> : <XCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />}
              <span>
                {tiktokCheck.ok
                  ? <>Compte « {tiktokCheck.advertiser.name} »{tiktokCheck.advertiser.currency ? ` · ${tiktokCheck.advertiser.currency}` : ""}{tiktokCheck.advertiser.timezone ? ` · ${tiktokCheck.advertiser.timezone}` : ""}</>
                  : tiktokCheck.error}
              </span>
            </div>
          )}
          {tiktokCheck?.ok && tiktokCheck.alreadyOn.length > 0 && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-200">
              Ce compte est déjà rattaché à {tiktokCheck.alreadyOn.length > 1 ? "d'autres clients" : "un autre client"} : {tiktokCheck.alreadyOn.map((n) => `« ${n} »`).join(", ")}. Ne le rattachez ici que s&apos;il appartient aussi à ce client.
            </div>
          )}
          {tiktokAlreadyHere && (
            <div className="text-xs text-gray-400">Ce compte est déjà rattaché à ce client : son nom sera simplement mis à jour.</div>
          )}
          <div className="flex items-center gap-2 flex-wrap">
            <button type="submit" className={btn} disabled={checking || attaching || !advertiserId.trim()}>
              {checking ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null} Vérifier
            </button>
            <button type="button" className={btnPrimary} onClick={() => void attachTikTok()} disabled={attaching || checking || !tiktokCheck?.ok}>
              {attaching ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null} Rattacher ce compte
            </button>
            <button type="button" className="text-xs text-gray-500 hover:text-white" onClick={resetTikTok} disabled={attaching}>Annuler</button>
          </div>
        </form>
      )}
    </Section>
  );
}
