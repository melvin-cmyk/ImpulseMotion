"use client";

/**
 * Shared CRM (HubSpot) UI pieces used by the dashboard widgets
 * (components/dashboard/renderers.tsx) and the client-sheet card
 * (components/portfolio/crm-attribution-card.tsx): level badge, partial /
 * warnings banner, attribution diagnostic, per-source and per-campaign tables.
 * Every amount goes through fmtMoney(value, currency) — never a hard-coded €.
 */

import { AlertTriangle, Link2, Link2Off } from "lucide-react";
import { Pill } from "@/components/ui/surface";
import { fmtMoney, fmtNumber, fmtPct, fmtRoas, fmtTime } from "@/components/portfolio/format";
import type { CrmAttributionDiagnostic, CrmSource } from "@/lib/hubspot/types";
import {
  CRM_LEVEL_INFO, CRM_SOURCE_LABELS, pctOf,
  type CrmAttributionCampaignRow, type CrmAttributionSourceRow, type CrmLevel,
} from "@/components/portfolio/crm-types";

export const crmSourceLabel = (source: CrmSource, label?: string | null): string => label || CRM_SOURCE_LABELS[source] || source;

export function CrmLevelBadge({ level, withTitle, className }: { level: CrmLevel; withTitle?: boolean; className?: string }) {
  const info = CRM_LEVEL_INFO[level] ?? CRM_LEVEL_INFO[0];
  return (
    <Pill tone={info.tone} className={`cursor-help font-semibold tabular-nums ${className ?? ""}`}>
      <span title={`${info.title} — ${info.explanation}`}>{info.label}{withTitle ? ` · ${info.title}` : ""}</span>
    </Pill>
  );
}

/** "HubSpot · données au HH:MM" */
export function CrmFreshness({ fetchedAt, className }: { fetchedAt: string | null | undefined; className?: string }) {
  return (
    <span className={`text-[11px] text-gray-500 ${className ?? ""}`} title={fetchedAt ? new Date(fetchedAt).toLocaleString("fr-FR") : undefined}>
      HubSpot{fetchedAt ? ` · données au ${fmtTime(fetchedAt)}` : ""}
    </span>
  );
}

/** Amber banner when the snapshot is partial (or carries warnings). */
export function CrmPartialBanner({ partial, warnings, className }: { partial: boolean; warnings: string[]; className?: string }) {
  if (!partial && warnings.length === 0) return null;
  const detail = warnings.length > 0 ? warnings.join(" · ") : "certaines données HubSpot n'ont pas pu être chargées";
  return (
    <div className={`rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-200 flex items-start gap-2 ${className ?? ""}`}>
      <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0 text-amber-400" />
      <span>
        <span className="font-semibold">{partial ? "Données partielles" : "Avertissement"} :</span> {detail}
      </span>
    </div>
  );
}

/** Readable HubSpot error box (widget or card). */
export function CrmErrorBox({ message, className }: { message: string; className?: string }) {
  return (
    <div className={`rounded-lg border border-red-900/50 bg-red-950/30 px-3 py-2 text-xs text-red-200 flex items-start gap-2 ${className ?? ""}`}>
      <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0 text-red-400" />
      <span><span className="font-semibold">HubSpot indisponible :</span> {message}</span>
    </div>
  );
}

export function CrmSkeleton({ rows = 4, className }: { rows?: number; className?: string }) {
  return (
    <div className={`space-y-2 animate-pulse ${className ?? ""}`} aria-busy="true" aria-label="Chargement des données HubSpot">
      <div className="h-4 w-40 rounded bg-gray-800" />
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="h-6 rounded-md bg-gray-800/60" style={{ width: `${100 - i * 12}%` }} />
      ))}
    </div>
  );
}

const cellNum = "px-3 py-2 text-right tabular-nums";
const thBase = "px-3 py-2 text-[11px] font-semibold text-gray-500 uppercase tracking-wide whitespace-nowrap";

/** ROAS tint: ≥ 2 green, 0 < x < 1 red. */
export function roasTone(v: number | null): string {
  if (v === null || v <= 0) return "text-gray-500";
  if (v >= 2) return "text-emerald-400 font-semibold";
  if (v < 1) return "text-red-400";
  return "text-gray-200";
}

function Money({ value, currency, digits }: { value: number | null; currency: string | null; digits?: number }) {
  return <span className={value === null ? "text-gray-600" : ""}>{value === null ? "—" : fmtMoney(value, currency, digits === undefined ? {} : { digits })}</span>;
}

export function CrmSourceTable({ rows, currency, dense }: { rows: CrmAttributionSourceRow[]; currency: string | null; dense?: boolean }) {
  if (rows.length === 0) return <div className="px-3 py-4 text-xs text-gray-500">Aucune source d&apos;origine sur la période.</div>;
  const size = dense ? "text-xs" : "text-sm";
  return (
    <div className="overflow-x-auto">
      <table className={`w-full ${size} min-w-[640px]`}>
        <thead className="bg-gray-950/50">
          <tr>
            <th className={`${thBase} text-left`}>Source</th>
            <th className={`${thBase} text-right`}>Contacts</th>
            <th className={`${thBase} text-right`}>Qualifiés</th>
            <th className={`${thBase} text-right`}>Gagnés</th>
            <th className={`${thBase} text-right`}>CA gagné</th>
            <th className={`${thBase} text-right`}>Dépense</th>
            <th className={`${thBase} text-right`}>CPL</th>
            <th className={`${thBase} text-right`}>ROAS réel</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const paid = r.source === "PAID_SOCIAL" || r.source === "PAID_SEARCH";
            return (
              <tr key={r.source} className="border-t border-gray-800/60">
                <td className="px-3 py-2 text-gray-200 whitespace-nowrap">
                  <span className="inline-flex items-center gap-1.5">
                    {r.source === "PAID_SOCIAL" && <Pill tone="blue">Meta</Pill>}
                    {r.source === "PAID_SEARCH" && <Pill tone="emerald">Google</Pill>}
                    {crmSourceLabel(r.source, r.label)}
                  </span>
                </td>
                <td className={`${cellNum} text-white font-semibold`}>{fmtNumber(r.contacts)}</td>
                <td className={`${cellNum} text-gray-300`}>{fmtNumber(r.qualified)}</td>
                <td className={`${cellNum} text-gray-300`}>{fmtNumber(r.dealsWon)}</td>
                <td className={`${cellNum} text-gray-200`}><Money value={r.wonAmount} currency={currency} digits={0} /></td>
                <td className={`${cellNum} text-gray-300`} title={paid ? undefined : "Dépense connue uniquement pour le social payant (Meta) et la recherche payante (Google)"}>
                  <Money value={r.spend} currency={currency} digits={0} />
                </td>
                <td className={`${cellNum} text-gray-200`}><Money value={r.cpl} currency={currency} digits={2} /></td>
                <td className={`${cellNum} ${roasTone(r.realRoas)}`}>{r.realRoas === null ? "—" : fmtRoas(r.realRoas)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function MatchPill({ matched }: { matched: CrmAttributionCampaignRow["matched"] }) {
  if (!matched) {
    return (
      <Pill className="inline-flex items-center gap-1 text-gray-400" tone="default">
        <span title="Aucune campagne Meta / Google active ne porte ce nom : la dépense ne peut pas être rapprochée"><Link2Off className="w-3 h-3 inline" /> non rattachée</span>
      </Pill>
    );
  }
  return (
    <Pill tone={matched.platform === "meta" ? "blue" : "emerald"} className="inline-flex items-center gap-1">
      <span title={`Campagne ${matched.platform === "meta" ? "Meta" : "Google"} : ${matched.campaignName}`}>
        <Link2 className="w-3 h-3 inline" /> matchée {matched.platform === "meta" ? "Meta" : "Google"}
      </span>
    </Pill>
  );
}

export function CrmCampaignTable({ rows, currency, limit, dense }: { rows: CrmAttributionCampaignRow[]; currency: string | null; limit?: number; dense?: boolean }) {
  const shown = limit ? rows.slice(0, limit) : rows;
  if (shown.length === 0) return <div className="px-3 py-4 text-xs text-gray-500">Aucune campagne identifiée : les contacts ne portent pas d&apos;utm_campaign sur la période.</div>;
  const size = dense ? "text-xs" : "text-sm";
  return (
    <div className="overflow-x-auto">
      <table className={`w-full ${size} min-w-[720px]`}>
        <thead className="bg-gray-950/50">
          <tr>
            <th className={`${thBase} text-left`}>Campagne (utm)</th>
            <th className={`${thBase} text-left`}>Rattachement</th>
            <th className={`${thBase} text-right`}>Contacts</th>
            <th className={`${thBase} text-right`}>Qualifiés</th>
            <th className={`${thBase} text-right`}>Gagnés</th>
            <th className={`${thBase} text-right`}>CA gagné</th>
            <th className={`${thBase} text-right`}>Dépense</th>
            <th className={`${thBase} text-right`}>CPL</th>
            <th className={`${thBase} text-right`}>ROAS réel</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((r, i) => (
            <tr key={`${r.campaign}:${r.source}:${i}`} className="border-t border-gray-800/60">
              <td className="px-3 py-2 text-gray-200 max-w-[260px]">
                <div className="truncate" title={r.campaign}>{r.campaign}</div>
                <div className="text-[10px] text-gray-500 truncate">{crmSourceLabel(r.source)}</div>
              </td>
              <td className="px-3 py-2 whitespace-nowrap"><MatchPill matched={r.matched} /></td>
              <td className={`${cellNum} text-white font-semibold`}>{fmtNumber(r.contacts)}</td>
              <td className={`${cellNum} text-gray-300`}>{fmtNumber(r.qualified)}</td>
              <td className={`${cellNum} text-gray-300`}>{fmtNumber(r.dealsWon)}</td>
              <td className={`${cellNum} text-gray-200`}><Money value={r.wonAmount} currency={currency} digits={0} /></td>
              <td className={`${cellNum} text-gray-300`}><Money value={r.spend} currency={currency} digits={0} /></td>
              <td className={`${cellNum} text-gray-200`}><Money value={r.cpl} currency={currency} digits={2} /></td>
              <td className={`${cellNum} ${roasTone(r.realRoas)}`}>{r.realRoas === null ? "—" : fmtRoas(r.realRoas)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {limit && rows.length > limit && (
        <div className="px-3 py-1.5 text-[11px] text-gray-500">{rows.length - limit} autre{rows.length - limit > 1 ? "s" : ""} campagne{rows.length - limit > 1 ? "s" : ""} non affichée{rows.length - limit > 1 ? "s" : ""}.</div>
      )}
    </div>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "good" | "warn" | "bad" }) {
  const color = tone === "good" ? "text-emerald-400" : tone === "warn" ? "text-amber-400" : tone === "bad" ? "text-red-400" : "text-white";
  return (
    <div className="bg-gray-950/50 border border-gray-800 rounded-xl px-3 py-2 min-w-0">
      <div className="text-[10px] uppercase tracking-wider text-gray-500 font-semibold truncate">{label}</div>
      <div className={`text-base font-bold tabular-nums mt-0.5 ${color}`}>{value}</div>
      {sub && <div className="text-[10px] text-gray-500 truncate">{sub}</div>}
    </div>
  );
}

function ratioTone(pct: number | null): "good" | "warn" | "bad" | undefined {
  if (pct === null) return undefined;
  if (pct >= 70) return "good";
  if (pct >= 30) return "warn";
  return "bad";
}

/**
 * Attribution diagnostic: contact counts / coverage percentages + level verdict
 * + French recommendations (shown when level < 2 or when the API sends some).
 */
export function CrmDiagnosticBlock({ diagnostic, compact, className }: { diagnostic: CrmAttributionDiagnostic; compact?: boolean; className?: string }) {
  const d = diagnostic;
  const info = CRM_LEVEL_INFO[d.level] ?? CRM_LEVEL_INFO[0];
  const total = d.contactsTotal;
  const pSource = pctOf(d.withSource, total);
  const pPaid = pctOf(d.paidSource, total);
  const pUtm = pctOf(d.withUtmCampaign, total);
  const pMatched = pctOf(d.matchedToCampaign, d.withUtmCampaign > 0 ? d.withUtmCampaign : total);
  const showReco = d.recommendations.length > 0;
  return (
    <div className={`space-y-3 ${className ?? ""}`}>
      <div className="flex items-start gap-2 flex-wrap">
        <CrmLevelBadge level={d.level} withTitle />
        <p className="text-xs text-gray-400 flex-1 min-w-[200px]">{info.explanation}</p>
      </div>
      {total === 0 ? (
        <div className="text-xs text-gray-500">Aucun contact HubSpot créé sur la période.</div>
      ) : (
        <div className={`grid gap-2 ${compact ? "grid-cols-2 sm:grid-cols-3" : "grid-cols-2 md:grid-cols-5"}`}>
          <Stat label="Contacts" value={fmtNumber(total)} sub="créés sur la période" />
          <Stat label="Avec source" value={fmtPct(pSource, 0)} sub={`${fmtNumber(d.withSource)} contact${d.withSource > 1 ? "s" : ""}`} tone={ratioTone(pSource)} />
          <Stat label="Source payante" value={fmtPct(pPaid, 0)} sub={`${fmtNumber(d.paidSource)} via Meta / Google`} />
          <Stat label="Avec utm_campaign" value={fmtPct(pUtm, 0)} sub={d.utmProperty ? `propriété ${d.utmProperty}` : "aucune propriété UTM"} tone={ratioTone(pUtm)} />
          <Stat label="Matchés" value={fmtPct(pMatched, 0)} sub={`${fmtNumber(d.matchedToCampaign)} rattaché${d.matchedToCampaign > 1 ? "s" : ""} à une campagne connue`} tone={ratioTone(pMatched)} />
        </div>
      )}
      {showReco && (
        <div className="rounded-lg border border-violet-800/40 bg-violet-500/5 px-3 py-2">
          <div className="text-[11px] font-semibold text-violet-300 uppercase tracking-wide mb-1">Recommandations</div>
          <ul className="space-y-1 text-xs text-gray-300 list-disc pl-4">
            {d.recommendations.map((r, i) => <li key={i}>{r}</li>)}
          </ul>
        </div>
      )}
    </div>
  );
}
