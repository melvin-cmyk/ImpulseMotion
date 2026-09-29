"use client";

/**
 * « Lignes à vérifier »: the rows of the Sheet whose ad is in doubt (the
 * platform never answered, or answered something unexpected) and those given
 * up after their attempts. The routine never creates such a row again by
 * itself; a person looks in the Ads Manager and says what is there:
 *
 *   « La publicité existe »   with its id, read again by the server;
 *   « Rien n'a été créé »     the row leaves for one more attempt.
 *
 * Both are kept in the journal of the routine with who decided.
 */

import { useCallback, useEffect, useState } from "react";
import { Loader2, SearchCheck } from "lucide-react";
import { Pill } from "@/components/ui/surface";
import { dateTimeLabel, toItemsToCheck, type ItemToCheckView } from "@/components/routines/routine-model";

const FIELD = "bg-gray-950 border border-gray-800 rounded-lg px-2 py-1 text-xs text-gray-200 focus:outline-none focus:border-violet-500 w-44";
const BUTTON = "px-2.5 py-1 rounded-lg text-xs font-semibold disabled:opacity-40 disabled:cursor-not-allowed";

export function ItemsToCheck({ routineId, timezone, refreshKey, readOnly, onChanged }: {
  routineId: string; timezone: string | null; refreshKey: number; readOnly: boolean; onChanged: () => void;
}) {
  const [items, setItems] = useState<ItemToCheckView[] | null>(null);
  const [adIds, setAdIds] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/routines/${routineId}/items`);
      const body = await res.json().catch(() => ({}));
      if (res.ok) setItems(toItemsToCheck(body.items));
    } catch { /* the list is a help: the page stays usable without it */ }
  }, [routineId]);

  useEffect(() => {
    const t = setTimeout(() => { void load(); }, 0);
    return () => clearTimeout(t);
  }, [load, refreshKey]);

  async function decide(item: ItemToCheckView, outcome: "exists" | "retry") {
    if (busy) return;
    const adId = (adIds[item.id] ?? item.externalId ?? "").trim();
    if (outcome === "exists" && !/^\d{5,25}$/.test(adId)) { setNotice({ ok: false, text: "Donnez l'identifiant de la publicité, en chiffres, tel qu'il figure dans le Gestionnaire de publicités." }); return; }
    if (outcome === "retry" && !window.confirm(`Ligne « ${item.rowKey} » : confirmer que RIEN n'a été créé dans Meta ? La routine tentera de créer cette publicité à sa prochaine exécution.`)) return;
    setBusy(item.id);
    setNotice(null);
    try {
      const res = await fetch(`/api/routines/${routineId}/items/${item.id}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(outcome === "exists" ? { outcome, adId } : { outcome }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? `Erreur ${res.status}`);
      setNotice({
        ok: true,
        text: outcome === "retry" ? `Ligne « ${item.rowKey} » : elle sera retentée à la prochaine exécution.`
          : body.item?.status === "created" ? `Ligne « ${item.rowKey} » : publicité ${adId} rattachée, la ligne est close.`
          : `Ligne « ${item.rowKey} » : publicité ${adId} enregistrée. Elle est au statut ${body.item?.adStatus ?? "inconnu"} : la ligne reste à vérifier tant qu'elle n'est pas en pause.`,
      });
      await load();
      onChanged();
    } catch (e) {
      setNotice({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  }

  if (!items || items.length === 0) return notice ? <p className={`text-xs ${notice.ok ? "text-emerald-300" : "text-red-400"}`}>{notice.text}</p> : null;

  return (
    <div className="bg-gray-900 border border-amber-900/50 rounded-2xl">
      <div className="px-4 py-3 border-b border-gray-800 flex items-center gap-2">
        <SearchCheck className="w-4 h-4 text-amber-300" />
        <h2 className="text-sm font-semibold text-white">Lignes à vérifier ({items.length})</h2>
      </div>
      <p className="px-4 pt-3 text-xs text-gray-400">
        La routine ne recrée jamais ces lignes d&apos;elle-même. Regardez dans le Gestionnaire de publicités, puis dites ce qu&apos;il en est : votre réponse est gardée dans le journal de la routine.
      </p>
      <ul className="p-4 space-y-2">
        {items.map((item) => (
          <li key={item.id} className="bg-gray-950/50 border border-gray-800 rounded-xl px-3 py-2.5 space-y-1.5">
            <div className="flex flex-wrap items-center gap-1.5 text-xs">
              <span className="font-mono text-gray-200 break-all">{item.rowKey}</span>
              {item.label && <span className="text-gray-400 break-words">« {item.label} »</span>}
              <Pill tone={item.status === "abandoned" ? "red" : "amber"} className="text-[10px]">{item.status === "abandoned" ? `Abandonnée après ${item.attempts} tentatives` : "À vérifier"}</Pill>
              <span className="text-[11px] text-gray-600 ml-auto">{dateTimeLabel(item.updatedAt, timezone)}</span>
            </div>
            <div className="text-[11px] text-gray-500 break-words">
              {item.adsetId ? `Ensemble de publicités ${item.adsetId}` : "Ensemble de publicités inconnu"}
              {item.externalId ? ` · publicité connue : ${item.externalId}` : " · aucun identifiant de publicité connu"}
            </div>
            {item.error && <p className="text-xs text-amber-300 break-words">{item.error}</p>}
            {!readOnly && (
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <input
                  aria-label={`Identifiant de la publicité de la ligne ${item.rowKey}`}
                  inputMode="numeric"
                  placeholder="Identifiant de la publicité"
                  value={adIds[item.id] ?? item.externalId ?? ""}
                  onChange={(e) => setAdIds((v) => ({ ...v, [item.id]: e.target.value }))}
                  disabled={!!busy || !!item.externalId}
                  className={FIELD}
                />
                <button type="button" onClick={() => void decide(item, "exists")} disabled={!!busy} className={`${BUTTON} bg-violet-600 hover:bg-violet-500 text-white`}>
                  {busy === item.id ? <Loader2 className="w-3.5 h-3.5 animate-spin inline" /> : "J'ai vérifié : la publicité existe"}
                </button>
                {!item.externalId && (
                  <button type="button" onClick={() => void decide(item, "retry")} disabled={!!busy} className={`${BUTTON} bg-gray-800 hover:bg-gray-700 text-gray-200`}>
                    J&apos;ai vérifié : rien n&apos;a été créé, réessayer
                  </button>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
      {notice && <p className={`px-4 pb-3 text-xs break-words ${notice.ok ? "text-emerald-300" : "text-red-400"}`}>{notice.text}</p>}
    </div>
  );
}
