"use client";

/**
 * Compact grid of the ads inside an aggregated group (copy variant, landing
 * page, adset…). Clicking a card opens the creative drawer.
 */

import type { Creative } from "@/lib/creative-types";
import { CreativeThumbnail } from "@/components/creative-thumbnail";
import { PlatformBadge } from "@/components/platform-badge";
import { StatusBadge } from "@/components/status-badge";
import { RoasValue } from "@/components/roas-value";
import { fmtPct } from "@/lib/creative-format";
import { useMoney } from "@/lib/creatives-context";

interface GroupAdsListProps {
  creatives: Creative[];
  onSelect: (c: Creative) => void;
  /** Sort ads by spend desc (default true) */
  sortBySpend?: boolean;
}

export function GroupAdsList({ creatives, onSelect, sortBySpend = true }: GroupAdsListProps) {
  const money = useMoney();
  const items = sortBySpend ? [...creatives].sort((a, b) => b.spend - a.spend) : creatives;
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
      {items.map((c) => (
        <div
          key={c.id}
          className="bg-gray-950/60 border border-gray-800 rounded-xl overflow-hidden hover:border-gray-700 transition-colors"
        >
          <CreativeThumbnail
            format={c.format}
            thumbnailColor={c.thumbnailColor}
            thumbnailUrl={c.thumbnailUrl}
            videoUrl={c.videoUrl}
            videoId={c.videoId}
            className="h-24"
          />
          <button
            type="button"
            onClick={() => onSelect(c)}
            className="w-full text-left p-2.5 space-y-1.5"
            title={c.name}
          >
            <p className="text-xs text-gray-200 truncate">{c.name}</p>
            <div className="flex items-center gap-1.5 flex-wrap">
              <PlatformBadge platform={c.platform} />
              <StatusBadge status={c.status} />
              <span className="text-[10px] text-gray-500">{c.format}</span>
            </div>
            <div className="flex items-center justify-between text-[11px] text-gray-400">
              <span>{money(c.spend)}</span>
              <span>CTR {fmtPct(c.ctr)}</span>
              <RoasValue value={c.spend > 0 && !c.roasUnavailable ? c.roas : null} estimated={c.roasEstimated && !c.roasUnavailable} tone />
            </div>
          </button>
        </div>
      ))}
    </div>
  );
}
