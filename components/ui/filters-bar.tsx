"use client";

/**
 * FiltersBar
 *
 * A combined filter bar for the Creatives page.
 * - Campaign dropdown: fetches from GET /api/meta/campaigns
 * - Status filter: ACTIVE, PAUSED, ALL (ad-level status from Meta)
 *
 * Note: the "Status" here refers to the Meta ad delivery status
 * (ACTIVE / PAUSED), not the computed creative performance status
 * (Winner / Loser / Fatigued / Active) which is handled separately in the
 * creatives page.
 */

import { useEffect, useState } from "react";
import { useCreativesContext } from "@/lib/creatives-context";
import { Layers, Activity } from "lucide-react";

interface Campaign {
  id: string;
  name: string;
  status: string;
}

export type AdStatus = "ALL" | "ACTIVE" | "PAUSED";

interface FiltersBarProps {
  accountId: string | null;
  /** Currently active ad-status filter */
  adStatus: AdStatus;
  /** Called when the ad-status selection changes */
  onAdStatusChange: (status: AdStatus) => void;
}

const STATUS_OPTIONS: { value: AdStatus; label: string }[] = [
  { value: "ALL", label: "All" },
  { value: "ACTIVE", label: "Active" },
  { value: "PAUSED", label: "Paused" },
];

export function FiltersBar({
  accountId,
  adStatus,
  onAdStatusChange,
}: FiltersBarProps) {
  const { campaignId, setCampaignId } = useCreativesContext();
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!accountId) {
      setCampaigns([]);
      return;
    }
    setLoading(true);
    setError(null);
    fetch(`/api/meta/campaigns?accountId=${encodeURIComponent(accountId)}`)
      .then((r) => r.json())
      .then((data) => {
        if (Array.isArray(data)) {
          setCampaigns(data as Campaign[]);
        } else if (data?.error) {
          setError(data.error);
        }
      })
      .catch((err) => setError(err?.message ?? "Failed to load campaigns"))
      .finally(() => setLoading(false));
  }, [accountId]);

  return (
    <div className="flex flex-wrap items-center gap-3">
      {/* Campaign Dropdown */}
      {accountId && (
        <div className="flex items-center gap-2 bg-gray-900 border border-gray-800 rounded-xl px-3 py-2">
          <Layers className="w-4 h-4 text-gray-500 shrink-0" />
          <span className="text-gray-500 text-sm shrink-0">Campaign:</span>
          {loading ? (
            <span className="text-gray-600 text-sm">Loading…</span>
          ) : error ? (
            <span className="text-red-400 text-sm truncate max-w-[180px]">
              {error}
            </span>
          ) : campaigns.length === 0 ? (
            <span className="text-gray-600 text-sm">No campaigns</span>
          ) : (
            <select
              value={campaignId ?? ""}
              onChange={(e) => setCampaignId(e.target.value || null)}
              className="bg-transparent text-gray-300 text-sm outline-none cursor-pointer max-w-[220px]"
            >
              <option value="">All campaigns</option>
              {campaigns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {c.status !== "ACTIVE" ? ` (${c.status})` : ""}
                </option>
              ))}
            </select>
          )}
        </div>
      )}

      {/* Status Filter */}
      <div className="flex items-center gap-2 bg-gray-900 border border-gray-800 rounded-xl px-3 py-2">
        <Activity className="w-4 h-4 text-gray-500 shrink-0" />
        <span className="text-gray-500 text-sm shrink-0">Status:</span>
        <div className="flex gap-1">
          {STATUS_OPTIONS.map(({ value, label }) => (
            <button
              key={value}
              onClick={() => onAdStatusChange(value)}
              className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-colors ${
                adStatus === value
                  ? "bg-violet-600 text-white"
                  : "text-gray-400 hover:text-white hover:bg-gray-800"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
