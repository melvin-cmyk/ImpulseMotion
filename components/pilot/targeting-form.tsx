"use client";

/**
 * Pilotage — « Ciblage » of a Meta ad set: the spec as Meta holds it now, a
 * few things edited by hand (age, genders, countries, audiences included and
 * excluded, placements, Advantage+ audience) and, unfolded, the whole JSON
 * for what the form does not show. The change goes to the panel « Modifier »
 * like any other: preview read on Meta, confirmation, HQ. Nothing is sent here.
 */

import { useEffect, useMemo, useState } from "react";
import { Loader2, X } from "lucide-react";
import {
  COUNTRIES_FR, PLATFORM_FR_META, PUBLISHER_PLATFORMS, editsOf, readTargeting, summarizeTargeting, targetingDiff, withTargetingEdits, type Targeting, type TargetingEdits,
} from "@/lib/pilot/targeting";

type Audience = { id: string; name: string; subtype: string; size: number | null; ready: boolean };
const input = "bg-gray-950 border border-gray-800 rounded-lg px-2.5 py-1.5 text-sm text-white outline-none focus:border-violet-500";

export function TargetingForm({ clientId, accountId, adsetId, adsetName, onCancel, onDone }: {
  clientId: string;
  accountId: string;
  adsetId: string;
  adsetName: string;
  onCancel: () => void;
  onDone: (targetingJson: string, label: string) => void;
}) {
  const [base, setBase] = useState<Targeting | null>(null);
  const [audiences, setAudiences] = useState<Audience[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [edits, setEdits] = useState<TargetingEdits>({});
  const [advanced, setAdvanced] = useState(false);
  const [raw, setRaw] = useState("");
  const [rawError, setRawError] = useState<string | null>(null);
  const [countryInput, setCountryInput] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/pilot/targeting?clientId=${encodeURIComponent(clientId)}&accountId=${encodeURIComponent(accountId)}&adsetId=${encodeURIComponent(adsetId)}`)
      .then(async (r) => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error ?? `Erreur ${r.status}`); return j; })
      .then((j) => { if (cancelled) return; setBase(j.targeting ?? {}); setAudiences(j.audiences ?? []); setRaw(JSON.stringify(j.targeting ?? {}, null, 2)); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, [clientId, accountId, adsetId]);

  const current = useMemo(() => (base ? editsOf(base) : null), [base]);
  const value = useMemo<ReturnType<typeof editsOf>>(() => ({ ...(current ?? editsOf({})), ...edits } as ReturnType<typeof editsOf>), [current, edits]);
  const after = useMemo(() => {
    if (!base) return null;
    if (advanced) { try { return JSON.parse(raw) as Targeting; } catch { return null; } }
    return withTargetingEdits(base, edits);
  }, [base, edits, advanced, raw]);
  const diff = useMemo(() => (base && after ? targetingDiff(base, after) : []), [base, after]);
  const audienceName = (id: string) => audiences.find((a) => a.id === id)?.name ?? `#${id}`;

  function submit() {
    if (!after) { setRawError("JSON invalide."); return; }
    const read = readTargeting(after);
    if (!read.ok) { setRawError(read.error); return; }
    if (!diff.length) { setRawError("Rien n'a changé."); return; }
    onDone(JSON.stringify(read.targeting), `Ensemble « ${adsetName} » : ciblage — ${diff.join(" ; ")}`);
  }

  const toggle = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

  return (
    <div className="fixed inset-0 z-40 bg-black/60 flex items-start justify-center overflow-y-auto p-4" onClick={onCancel}>
      <div className="w-full max-w-2xl bg-gray-900 border border-gray-700 rounded-2xl p-5 my-6 space-y-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="text-white font-semibold">Ciblage — « {adsetName} »</h3>
          <button type="button" onClick={onCancel} className="text-gray-400 hover:text-white" aria-label="Fermer"><X className="w-4 h-4" /></button>
        </div>
        {error && <p className="text-sm text-red-300">{error}</p>}
        {!base && !error && <p className="text-sm text-gray-500 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Lecture du ciblage sur Meta…</p>}
        {base && current && (
          <>
            <p className="text-xs text-gray-400">Aujourd&apos;hui : {summarizeTargeting(base).join(" · ")}</p>
            <div className="grid sm:grid-cols-2 gap-3 text-sm">
              <label className="space-y-1">
                <span className="text-xs text-gray-400">Âge</span>
                <div className="flex items-center gap-2">
                  <input type="number" min={13} max={65} value={value.ageMin} onChange={(e) => setEdits({ ...edits, ageMin: Number(e.target.value) })} className={`${input} w-20`} />
                  <span className="text-gray-500">à</span>
                  <input type="number" min={13} max={65} value={value.ageMax} onChange={(e) => setEdits({ ...edits, ageMax: Number(e.target.value) })} className={`${input} w-20`} />
                </div>
              </label>
              <div className="space-y-1">
                <span className="text-xs text-gray-400">Genre</span>
                <div className="flex gap-2">
                  {([[[], "Tous"], [[1], "Hommes"], [[2], "Femmes"]] as Array<[number[], string]>).map(([g, l]) => (
                    <button key={l} type="button" onClick={() => setEdits({ ...edits, genders: g })} className={`px-2.5 py-1 rounded-md border text-xs ${JSON.stringify(value.genders) === JSON.stringify(g) ? "border-violet-500 text-white" : "border-gray-800 text-gray-400 hover:text-white"}`}>{l}</button>
                  ))}
                </div>
              </div>
            </div>
            <div className="space-y-1 text-sm">
              <span className="text-xs text-gray-400">Pays (les régions, villes et lieux déjà ciblés sont gardés)</span>
              <div className="flex flex-wrap gap-1.5">
                {value.countries.map((c) => (
                  <button key={c} type="button" onClick={() => setEdits({ ...edits, countries: value.countries.filter((x) => x !== c) })} className="px-2 py-0.5 rounded-md bg-violet-500/15 border border-violet-500/40 text-xs text-white">{COUNTRIES_FR[c] ?? c} ×</button>
                ))}
                <select value={countryInput} onChange={(e) => { if (e.target.value) setEdits({ ...edits, countries: [...new Set([...value.countries, e.target.value])] }); setCountryInput(""); }} className={`${input} py-0.5 text-xs`}>
                  <option value="">+ ajouter un pays</option>
                  {Object.entries(COUNTRIES_FR).filter(([c]) => !value.countries.includes(c)).map(([c, n]) => <option key={c} value={c}>{n}</option>)}
                </select>
              </div>
            </div>
            <div className="grid sm:grid-cols-2 gap-3 text-sm">
              {([["customAudiences", "Audiences incluses"], ["excludedCustomAudiences", "Audiences exclues"]] as const).map(([key, label]) => (
                <div key={key} className="space-y-1">
                  <span className="text-xs text-gray-400">{label}</span>
                  <div className="max-h-40 overflow-y-auto rounded-lg border border-gray-800 divide-y divide-gray-800/60">
                    {value[key].filter((id) => !audiences.some((a) => a.id === id)).map((id) => (
                      <label key={id} className="flex items-center gap-2 px-2 py-1 text-xs text-gray-300"><input type="checkbox" checked onChange={() => setEdits({ ...edits, [key]: toggle(value[key], id) })} /> {audienceName(id)}</label>
                    ))}
                    {audiences.map((a) => (
                      <label key={a.id} className={`flex items-center gap-2 px-2 py-1 text-xs ${a.ready ? "text-gray-300" : "text-gray-600"}`} title={a.ready ? `${a.subtype}${a.size !== null ? ` · ~${a.size.toLocaleString("fr-FR")}` : ""}` : "Audience trop petite ou indisponible"}>
                        <input type="checkbox" checked={value[key].includes(a.id)} onChange={() => setEdits({ ...edits, [key]: toggle(value[key], a.id) })} /> <span className="truncate">{a.name}</span>
                      </label>
                    ))}
                    {!audiences.length && <p className="px-2 py-1 text-xs text-gray-500">Aucune audience personnalisée sur ce compte.</p>}
                  </div>
                </div>
              ))}
            </div>
            <div className="grid sm:grid-cols-2 gap-3 text-sm">
              <div className="space-y-1">
                <span className="text-xs text-gray-400">Placements</span>
                <label className="flex items-center gap-2 text-xs text-gray-300"><input type="radio" checked={value.publisherPlatforms === null} onChange={() => setEdits({ ...edits, publisherPlatforms: null })} /> Automatiques (Advantage+)</label>
                <label className="flex items-center gap-2 text-xs text-gray-300"><input type="radio" checked={value.publisherPlatforms !== null} onChange={() => setEdits({ ...edits, publisherPlatforms: value.publisherPlatforms ?? ["facebook", "instagram"] })} /> Manuels :</label>
                {value.publisherPlatforms !== null && (
                  <div className="flex flex-wrap gap-2 pl-5">
                    {PUBLISHER_PLATFORMS.map((p) => (
                      <label key={p} className="flex items-center gap-1 text-xs text-gray-300"><input type="checkbox" checked={value.publisherPlatforms!.includes(p)} onChange={() => setEdits({ ...edits, publisherPlatforms: toggle(value.publisherPlatforms!, p) })} /> {PLATFORM_FR_META[p]}</label>
                    ))}
                  </div>
                )}
              </div>
              <label className="flex items-center gap-2 text-xs text-gray-300 self-start mt-5"><input type="checkbox" checked={value.advantageAudience} onChange={(e) => setEdits({ ...edits, advantageAudience: e.target.checked })} /> Audience Advantage+ (Meta élargit au-delà du ciblage)</label>
            </div>
            <div className="space-y-1">
              <button type="button" onClick={() => { setAdvanced(!advanced); if (!advanced) setRaw(JSON.stringify(withTargetingEdits(base, edits), null, 2)); }} className="text-xs text-gray-400 hover:text-white">{advanced ? "← Revenir au formulaire" : "Mode expert : le JSON complet (intérêts, positions, langues…)"}</button>
              {advanced && <textarea value={raw} onChange={(e) => { setRaw(e.target.value); setRawError(null); }} rows={14} spellCheck={false} className={`${input} w-full font-mono text-xs`} />}
            </div>
            <div className="rounded-lg border border-gray-800 px-3 py-2 text-xs">
              <span className="text-gray-500">Ce qui changera : </span>
              {diff.length ? <span className="text-gray-200">{diff.join(" ; ")}</span> : <span className="text-gray-500">rien pour le moment</span>}
            </div>
            {rawError && <p className="text-xs text-red-300">{rawError}</p>}
            <div className="flex items-center gap-3">
              <button type="button" onClick={submit} disabled={!diff.length} className="px-3 py-1.5 rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-sm disabled:opacity-40">Ajouter aux modifications</button>
              <button type="button" onClick={onCancel} className="text-sm text-gray-400 hover:text-white">Annuler</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
