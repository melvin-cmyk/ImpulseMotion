"use client";

import { useEffect, useState } from "react";
import { useCreativesContext } from "@/lib/creatives-context";
import { Layers, Activity } from "lucide-react";

interface Campaign {
  id: string;
  name: string;
  status: string;
}

export type CampaignStatusFilter = "ALL" | "ACTIVE" | "PAUSED";

export function CampaignFilter({ accountId }: { accountId: string | null }) {
  const { campaignId, setCampaignId, campaignStatus, setCampaignStatus } =
    useCreativesContext();
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!accountId) {
      setCampaigns([]);
      return;
    }
    setLoading(true);
    fetch(`/api/meta/campaigns?accountId=${encodeURIComponent(accountId)}`)
      .then((r) => r.json())
      .then((data) => {
        if (Array.isArray(data)) {
          setCampaigns(data as Campaign[]);
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [accountId]);

  if (!accountId) return null;

  // Status filter is always shown when there's an account
  const statusOptions: { value: CampaignStatusFilter; label: string }[] = [
    { value: "ALL", label: "All statuses" },
    { value: "ACTIVE", label: "Active" },
    { value: "PAUSED", label: "Paused" },
  ];

  return (
    <div className="flex items-center gap-2 flex-wrap">
      {/* Status filter */}
      <div className="flex items-center gap-2 bg-gray-900 border border-gray-800 rounded-xl px-3 py-2">
        <Activity className="w-4 h-4 text-gray-500 shrink-0" />
        <span className="text-gray-500 text-sm">Status:</span>
        <select
          value={campaignStatus ?? "ALL"}
          onChange={(e) =>
            setCampaignStatus(
              e.target.value === "ALL" ? null : (e.target.value as "ACTIVE" | "PAUSED")
            )
          }
          className="bg-transparent text-gray-300 text-sm outline-none cursor-pointer"
        >
          {statusOptions.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      {/* Campaign filter — only shown when campaigns are available */}
      {campaigns.length > 0 && (
        <div className="flex items-center gap-2 bg-gray-900 border border-gray-800 rounded-xl px-3 py-2">
          <Layers className="w-4 h-4 text-gray-500 shrink-0" />
          <span className="text-gray-500 text-sm">Campaign:</span>
          <select
            value={campaignId ?? ""}
            onChange={(e) => setCampaignId(e.target.value || null)}
            disabled={loading}
            className="bg-transparent text-gray-300 text-sm outline-none cursor-pointer max-w-[220px]"
          >
            <option value="">All campaigns</option>
            {campaigns.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.status && c.status !== "ACTIVE" ? ` (${c.status})` : ""}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}
