"use client";

/**
 * Provenance banner for the Analyse Ads section (rendered once in the shared
 * layout, above every page):
 *   - "Démo" when no account is connected (mock data)
 *   - otherwise "Meta · données au HH:MM · N créas · devise · période (X j)
 *     [· aujourd'hui partiel][· liste tronquée]" + an "Actualiser" button
 *     that re-reads Meta (bypasses the server cache).
 */

import { RefreshCw, AlertTriangle, Database, FlaskConical } from "lucide-react";
import { useCreativesContext } from "@/lib/creatives-context";
import { fmtTime, fmtMoney } from "@/lib/creative-format";
import { describeRange } from "@/lib/date-ranges";

export function DataBanner() {
  const { isConnected, meta, creatives, isLoading, error, refetch, dateRange, currency } = useCreativesContext();

  if (!isConnected) {
    return (
      <div className="flex items-center gap-2 px-4 py-1.5 border-b border-gray-800 bg-gray-950 text-[11px]">
        <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 border border-amber-500/30 text-amber-300 px-2 py-0.5 font-semibold">
          <FlaskConical className="w-3 h-3" /> Démo
        </span>
        <span className="text-gray-500">Données fictives — sélectionne un compte Meta pour voir tes créas.</span>
      </div>
    );
  }

  const range = meta?.range ?? dateRange;
  const { days, partialDay: localPartial } = describeRange(range, { tz: meta?.timezone });
  const partialDay = meta?.partialDay ?? localPartial;
  const sum = creatives.reduce((s, c) => s + c.spend, 0);
  const totals = meta?.accountTotals;
  const delta = totals && totals.spend > 0 ? Math.abs(sum - totals.spend) / totals.spend : null;

  const parts: string[] = ["Meta"];
  if (isLoading) parts.push("chargement…");
  else if (meta) {
    parts.push(`données au ${fmtTime(meta.fetchedAt)}`);
    parts.push(`${creatives.length} créa${creatives.length > 1 ? "s" : ""}`);
    if (meta.currency) parts.push(meta.currency);
    parts.push(`${range.since} → ${range.until} (${days} j)`);
    if (partialDay) parts.push("aujourd'hui partiel");
    if (meta.truncated) parts.push("liste tronquée");
  } else {
    parts.push(`${range.since} → ${range.until} (${days} j)`);
  }

  return (
    <div className="flex items-center gap-2 px-4 py-1.5 border-b border-gray-800 bg-gray-950 text-[11px] flex-wrap">
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 px-2 py-0.5 font-semibold">
        <Database className="w-3 h-3" /> Données réelles
      </span>
      <span className="text-gray-400">{parts.join(" · ")}</span>
      {meta && totals && !isLoading && (
        <span className="text-gray-600" title="Somme des dépenses des créas listées vs total du compte sur la même période (Meta account insights)">
          · Σ {fmtMoney(sum, currency)} vs compte {fmtMoney(totals.spend, currency)}
          {delta !== null && delta > 0.005 ? <span className="text-amber-400"> (écart {(delta * 100).toFixed(1)} %)</span> : null}
        </span>
      )}
      {meta?.truncated && (
        <span className="inline-flex items-center gap-1 text-amber-400" title="Plus de 5 000 annonces sur la période : la liste est incomplète.">
          <AlertTriangle className="w-3 h-3" />
        </span>
      )}
      {error && <span className="text-red-400 truncate max-w-[40ch]" title={error}>{error}</span>}
      <button
        type="button"
        onClick={() => refetch({ refresh: true })}
        disabled={isLoading}
        className="ml-auto inline-flex items-center gap-1 rounded-md border border-gray-800 bg-gray-900 px-2 py-0.5 text-gray-300 hover:text-white hover:border-gray-700 disabled:opacity-50 transition-colors"
        title="Relire Meta (ignore le cache serveur)"
      >
        <RefreshCw className={`w-3 h-3 ${isLoading ? "animate-spin" : ""}`} /> Actualiser
      </button>
    </div>
  );
}
