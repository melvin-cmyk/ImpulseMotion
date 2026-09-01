"use client";

/**
 * « Attribution HubSpot » card of the client sheet (/portfolio/[id]), rendered
 * under the SourcesPanel only when the API returned `crm` (or a CRM error):
 * diagnostic (contacts, % source, % paid, % UTM, % matched, level + explanation,
 * recommendations), per-source table, top campaigns, refresh button.
 */

import { Link2, Loader2, RefreshCw } from "lucide-react";
import { Section } from "@/components/ui/surface";
import {
  CrmCampaignTable, CrmDiagnosticBlock, CrmErrorBox, CrmFreshness, CrmLevelBadge, CrmPartialBanner, CrmSkeleton, CrmSourceTable,
} from "@/components/portfolio/crm-shared";
import type { CrmAttributionData } from "@/components/portfolio/crm-types";

const TOP_CAMPAIGNS = 10;

export function CrmAttributionCard({
  crm, error, currency, loading, refreshing, onRefresh, className,
}: {
  /** undefined = no HubSpot source (card hidden) ; null = loading */
  crm: CrmAttributionData | null | undefined;
  /** errors.crm from the sheet API — readable HubSpot error */
  error?: string | null;
  currency?: string | null;
  loading?: boolean;
  refreshing?: boolean;
  onRefresh?: () => void;
  className?: string;
}) {
  const isLoading = crm === null || (!!loading && !crm);
  if (crm === undefined && !error && !isLoading) return null;
  const cur = crm?.currency ?? currency ?? null;
  const noContacts = !!crm && crm.diagnostic.contactsTotal === 0;
  const busy = !!refreshing || isLoading;

  return (
    <Section
      title="Attribution HubSpot"
      icon={<Link2 className="w-4 h-4 text-violet-400" />}
      className={className}
      tone={error ? "critical" : crm?.partial ? "warning" : "default"}
      action={
        <div className="flex items-center gap-2">
          {crm && <CrmLevelBadge level={crm.level} />}
          {crm && <CrmFreshness fetchedAt={crm.fetchedAt} className="hidden sm:inline" />}
          {onRefresh && (
            <button
              type="button"
              onClick={onRefresh}
              disabled={busy}
              className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-gray-800 bg-gray-900 text-xs text-gray-300 hover:text-white hover:border-gray-700 disabled:opacity-50 disabled:cursor-not-allowed"
              title="Recharger depuis HubSpot (ignore le cache)"
            >
              {refreshing ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
              {refreshing ? "Actualisation…" : "Actualiser"}
            </button>
          )}
        </div>
      }
    >
      <div className={`p-4 space-y-4 ${refreshing ? "opacity-60" : ""}`}>
        {error && <CrmErrorBox message={error} />}
        {isLoading && !error && <CrmSkeleton rows={5} />}
        {crm && (
          <>
            <CrmPartialBanner partial={crm.partial} warnings={crm.warnings} />
            {noContacts ? (
              <div className="space-y-3">
                <div className="flex items-center gap-2 flex-wrap">
                  <CrmLevelBadge level={0} withTitle />
                  <span className="text-sm text-gray-400">Aucun contact sur la période</span>
                </div>
                <p className="text-xs text-gray-500">Aucun contact HubSpot n&apos;a été créé sur la période sélectionnée : élargissez la plage de dates ou vérifiez que le formulaire du site alimente bien ce portail.</p>
                {crm.diagnostic.recommendations.length > 0 && <CrmDiagnosticBlock diagnostic={crm.diagnostic} />}
              </div>
            ) : (
              <>
                <CrmDiagnosticBlock diagnostic={crm.diagnostic} />
                {crm.bySource.length > 0 && (
                  <div>
                    <div className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide mb-1.5">Par source d&apos;origine</div>
                    <div className="rounded-xl border border-gray-800 overflow-hidden">
                      <CrmSourceTable rows={crm.bySource} currency={cur} />
                    </div>
                  </div>
                )}
                <div>
                  <div className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide mb-1.5">
                    Top campagnes (utm_campaign){crm.byCampaign.length > TOP_CAMPAIGNS ? ` · ${TOP_CAMPAIGNS} sur ${crm.byCampaign.length}` : ""}
                  </div>
                  <div className="rounded-xl border border-gray-800 overflow-hidden">
                    <CrmCampaignTable rows={crm.byCampaign} currency={cur} limit={TOP_CAMPAIGNS} />
                  </div>
                </div>
                <p className="text-[11px] text-gray-600">
                  CPL = dépense pub de la source / campagne ÷ contacts créés · ROAS réel = montant des deals gagnés ÷ dépense pub (à comparer au ROAS plateforme, basé sur les conversions déclarées).
                </p>
              </>
            )}
          </>
        )}
      </div>
    </Section>
  );
}
