"use client";

import { useEffect, useState } from "react";
import { TrendingUp, TrendingDown, Minus } from "lucide-react";
interface WoWPeriod {
  spend: number;
  cpa: number;
  ctr: number;
  cpm: number;
  roas: number;
}

interface WoWData {
  current: WoWPeriod;
  previous: WoWPeriod;
  currentRange: { since: string; until: string };
  previousRange: { since: string; until: string };
}

interface WoWBannerProps {
  accountId: string;
}

interface KpiDelta {
  label: string;
  current: number;
  previous: number;
  format: (v: number) => string;
  /** For CPA: lower is better. For all others: higher is better. */
  lowerIsBetter?: boolean;
}

function pctChange(current: number, previous: number): number {
  if (previous === 0) return 0;
  return ((current - previous) / previous) * 100;
}

function DeltaBadge({
  label,
  current,
  previous,
  format,
  lowerIsBetter = false,
}: KpiDelta) {
  const change = pctChange(current, previous);
  const absChange = Math.abs(change);

  // Determine if this is "good" or "bad" directionally
  const isPositive = lowerIsBetter ? change < 0 : change > 0;
  const isNegative = lowerIsBetter ? change > 0 : change < 0;
  const isNeutral = Math.abs(change) < 0.5; // less than 0.5% = neutral

  const colorClass = isNeutral
    ? "text-gray-400"
    : isPositive
    ? "text-emerald-400"
    : "text-red-400";

  const bgClass = isNeutral
    ? "bg-gray-800/50 border-gray-700/50"
    : isPositive
    ? "bg-emerald-950/50 border-emerald-800/40"
    : "bg-red-950/50 border-red-800/40";

  const Arrow = isNeutral ? Minus : isPositive ? TrendingUp : TrendingDown;

  const sign = change > 0 ? "+" : "";

  return (
    <div className={`flex flex-col gap-1.5 rounded-xl border px-4 py-3 ${bgClass}`}>
      <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-widest whitespace-nowrap">
        {label}
      </span>
      <div className="flex items-end gap-2">
        <span className="text-lg font-bold text-white">{format(current)}</span>
        <div className={`flex items-center gap-0.5 text-xs font-semibold pb-0.5 ${colorClass}`}>
          <Arrow className="w-3 h-3 shrink-0" />
          <span>
            {isNeutral ? "—" : `${sign}${absChange.toFixed(1)}%`}
          </span>
        </div>
      </div>
      <span className="text-[10px] text-gray-600">
        vs {format(previous)} (S-1)
      </span>
    </div>
  );
}

export function WoWBanner({ accountId }: WoWBannerProps) {
  const [data, setData] = useState<WoWData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!accountId) return;

    setLoading(true);
    fetch(`/api/meta/wow?accountId=${encodeURIComponent(accountId)}`)
      .then((r) => {
        if (r.status === 204) return null;
        if (!r.ok) throw new Error("WoW fetch failed");
        return r.json() as Promise<WoWData>;
      })
      .then((d) => {
        setData(d);
      })
      .catch(() => {
        setData(null);
      })
      .finally(() => setLoading(false));
  }, [accountId]);

  if (loading) {
    return (
      <div className="flex gap-3 overflow-x-auto pb-1">
        {[...Array(5)].map((_, i) => (
          <div
            key={i}
            className="h-[76px] w-32 shrink-0 rounded-xl bg-gray-900 border border-gray-800 animate-pulse"
          />
        ))}
      </div>
    );
  }

  if (!data) return null;

  const fmtCurrency = (v: number) =>
    v >= 1000 ? `$${(v / 1000).toFixed(1)}k` : `$${Math.round(v)}`;

  const kpis: KpiDelta[] = [
    {
      label: "Dépenses",
      current: data.current.spend,
      previous: data.previous.spend,
      format: fmtCurrency,
    },
    {
      label: "CPA",
      current: data.current.cpa,
      previous: data.previous.cpa,
      format: (v) => (v > 0 ? `$${v.toFixed(2)}` : "—"),
      lowerIsBetter: true,
    },
    {
      label: "CTR",
      current: data.current.ctr,
      previous: data.previous.ctr,
      format: (v) => `${v.toFixed(2)}%`,
    },
    {
      label: "CPM",
      current: data.current.cpm,
      previous: data.previous.cpm,
      format: (v) => `$${v.toFixed(2)}`,
      lowerIsBetter: true,
    },
    ...(data.current.roas > 0 || data.previous.roas > 0
      ? [
          {
            label: "ROAS",
            current: data.current.roas,
            previous: data.previous.roas,
            format: (v: number) => `${v.toFixed(2)}x`,
          } satisfies KpiDelta,
        ]
      : []),
  ];

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold text-gray-500 uppercase tracking-widest">
          Tendances semaine sur semaine
        </span>
        <span className="text-[10px] text-gray-700 bg-gray-900 border border-gray-800 rounded-full px-2 py-0.5">
          {data.currentRange.since} — {data.currentRange.until}
        </span>
      </div>
      <div className="flex gap-3 overflow-x-auto pb-1 scrollbar-thin">
        {kpis.map((kpi) => (
          <div key={kpi.label} className="shrink-0">
            <DeltaBadge {...kpi} />
          </div>
        ))}
      </div>
    </div>
  );
}
