"use client";

/**
 * Context bar of the Analyse Ads section (rendered once in the shared layout,
 * above every page). Everything that defines "what am I looking at" sits on
 * this single line:
 *   [Compte analysé ▾]  │  Démo / Données réelles · données au HH:MM · N créas
 *   · devise · période (X j) [· aujourd'hui partiel] [· liste tronquée]   [Actualiser]
 */

import { RefreshCw, AlertTriangle, Database, FlaskConical } from "lucide-react";
import { useCreativesContext } from "@/lib/creatives-context";
import { describeRange } from "@/lib/date-ranges";
import { AccountPicker } from "@/components/account-picker";

function fmtTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

function fmtMoney(n: number, currency: string | null): string {
  try {
    return new Intl.NumberFormat("fr-FR", { style: "currency", currency: currency ?? "EUR", maximumFractionDigits: 0 }).format(n);
  } catch {
    return `${Math.round(n)} ${currency ?? ""}`.trim();
  }
}

export function AnalyseContextBar() {
  const { isConnected, meta, creatives, isLoading, error, refetch, dateRange, currency } = useCreativesContext();

  return (
    <div className="flex items-center gap-3 px-4 py-2 border-b border-gray-800 bg-gray-950 text-[11px] flex-wrap">
      <AccountPicker />
      <span className="h-6 w-px bg-gray-800 hidden sm:block" aria-hidden />
      {isConnected ? <Provenance meta={meta} creatives={creatives} isLoading={isLoading} dateRange={dateRange} currency={currency} /> : (
        <>
          <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 border border-amber-500/30 text-amber-300 px-2 py-0.5 font-semibold">
            <FlaskConical className="w-3 h-3" /> Démo
          </span>
          <span className="text-gray-500">Données fictives — choisis un compte pour voir ses créas.</span>
        </>
      )}
      {error && <span className="text-red-400 truncate max-w-[40ch]" title={error}>{error}</span>}
      {isConnected && (
        <button
          type="button"
          onClick={() => refetch({ refresh: true })}
          disabled={isLoading}
          className="ml-auto inline-flex items-center gap-1 rounded-md border border-gray-800 bg-gray-900 px-2 py-1 text-gray-300 hover:text-white hover:border-gray-700 disabled:opacity-50 transition-colors"
          title="Relire Meta (ignore le cache serveur)"
        >
          <RefreshCw className={`w-3 h-3 ${isLoading ? "animate-spin" : ""}`} /> Actualiser
        </button>
      )}
    </div>
  );
}

type Ctx = ReturnType<typeof useCreativesContext>;

function Provenance({ meta, creatives, isLoading, dateRange, currency }: Pick<Ctx, "meta" | "creatives" | "isLoading" | "dateRange" | "currency">) {
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
    <>
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
    </>
  );
}
