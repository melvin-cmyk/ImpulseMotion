"use client";

import { useState, useMemo } from "react";
import { Creative } from "@/lib/mock-data";
import { useCreativesContext } from "@/lib/creatives-context";
import { CreativeThumbnail } from "@/components/creative-thumbnail";
import { CreativeModal } from "@/components/creative-modal";
import { Rocket, Trophy, TrendingUp, TrendingDown, FlaskConical, Database, Wifi } from "lucide-react";

// ── Launch status types ───────────────────────────────────────────────────────

type LaunchStatus = "Winner" | "Scaling" | "Declining" | "Testing";

interface LaunchCreative {
  creative: Creative;
  launchStatus: LaunchStatus;
  launchDate: string;
  spendGrowthPct: number; // simulated seeded % growth
}

// ── Seeded pseudo-random for stable "growth" values ──────────────────────────

function seededRandom(seed: number): number {
  // Simple LCG
  const x = Math.sin(seed) * 10000;
  return x - Math.floor(x);
}

function getSpendGrowthPct(id: string): number {
  // Seed from character codes of the id
  const seed = id.split("").reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  return Math.round((seededRandom(seed) * 200 - 50) * 10) / 10; // -50% to +150%
}

// Simulate a launch date: spread creatives over the last 30 days
function getLaunchDate(id: string, index: number, total: number): string {
  const seed = id.split("").reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  // Mix index + seed for variety
  const daysAgo = Math.round(((seededRandom(seed + index) + index / total) / 2) * 30);
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString().split("T")[0];
}

// ── Compute launch status ─────────────────────────────────────────────────────

function computeLaunchStatus(
  creative: Creative,
  medianSpend: number,
  medianRoas: number,
  medianCtr: number,
  spendGrowthPct: number
): LaunchStatus {
  // Testing: spend < $50
  if (creative.spend < 50) return "Testing";

  // Declining: CTR < 0.5% OR Hook Rate < 20%
  if (creative.ctr < 0.5 || (creative.hookRate > 0 && creative.hookRate < 20)) {
    return "Declining";
  }

  // Winner: spend > median AND roas > median AND ctr > median
  if (
    creative.spend > medianSpend &&
    creative.roas > medianRoas &&
    creative.ctr > medianCtr
  ) {
    return "Winner";
  }

  // Scaling: spend in growth (simulated) AND performance OK (roas >= median OR ctr >= median)
  if (
    spendGrowthPct > 0 &&
    (creative.roas >= medianRoas || creative.ctr >= medianCtr)
  ) {
    return "Scaling";
  }

  // Default to Declining if nothing else matches
  return "Declining";
}

// ── Status config ─────────────────────────────────────────────────────────────

const STATUS_CONFIG: Record<
  LaunchStatus,
  { label: string; icon: React.ElementType; badgeClass: string; iconClass: string; borderClass: string }
> = {
  Winner: {
    label: "Winner",
    icon: Trophy,
    badgeClass: "bg-emerald-500/15 text-emerald-300 border border-emerald-500/30",
    iconClass: "text-emerald-400",
    borderClass: "border-emerald-800/40",
  },
  Scaling: {
    label: "Scaling",
    icon: TrendingUp,
    badgeClass: "bg-blue-500/15 text-blue-300 border border-blue-500/30",
    iconClass: "text-blue-400",
    borderClass: "border-blue-800/40",
  },
  Declining: {
    label: "Declining",
    icon: TrendingDown,
    badgeClass: "bg-red-500/15 text-red-300 border border-red-500/30",
    iconClass: "text-red-400",
    borderClass: "border-red-800/40",
  },
  Testing: {
    label: "Testing",
    icon: FlaskConical,
    badgeClass: "bg-amber-500/15 text-amber-300 border border-amber-500/30",
    iconClass: "text-amber-400",
    borderClass: "border-amber-800/40",
  },
};

// ── LaunchCard ────────────────────────────────────────────────────────────────

function LaunchCard({
  item,
  onClick,
}: {
  item: LaunchCreative;
  onClick: () => void;
}) {
  const { creative, launchStatus, launchDate, spendGrowthPct } = item;
  const config = STATUS_CONFIG[launchStatus];
  const Icon = config.icon;

  return (
    <div
      onClick={onClick}
      className={`bg-gray-900 border ${config.borderClass} rounded-2xl overflow-hidden hover:shadow-lg transition-all duration-200 cursor-pointer hover:scale-[1.01]`}
    >
      <div className="flex gap-4 p-4">
        {/* Thumbnail */}
        <div className="w-16 h-16 rounded-xl overflow-hidden shrink-0">
          <CreativeThumbnail
            format={creative.format}
            thumbnailColor={creative.thumbnailColor}
            thumbnailUrl={creative.thumbnailUrl}
            videoUrl={creative.videoUrl}
            videoId={creative.videoId}
            className="w-16 h-16"
          />
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0 space-y-2">
          <div className="flex items-start justify-between gap-2">
            <p className="text-sm font-mono text-gray-200 truncate" title={creative.name}>
              {creative.name}
            </p>
            <span className={`shrink-0 flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full ${config.badgeClass}`}>
              <Icon className={`w-3 h-3 ${config.iconClass}`} />
              {config.label}
            </span>
          </div>

          <p className="text-[11px] text-gray-500">
            Launched{" "}
            <span className="text-gray-400 font-medium">
              {new Date(launchDate).toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
                year: "numeric",
              })}
            </span>
          </p>

          {/* Metrics row */}
          <div className="flex items-center gap-4">
            <div className="text-center">
              <p className="text-[9px] text-gray-600 uppercase tracking-wide">Spend</p>
              <p className="text-xs font-bold text-gray-300">
                {creative.spend >= 1000
                  ? `$${(creative.spend / 1000).toFixed(1)}k`
                  : `$${creative.spend.toFixed(0)}`}
              </p>
            </div>
            <div className="text-center">
              <p className="text-[9px] text-gray-600 uppercase tracking-wide">CTR</p>
              <p className="text-xs font-bold text-gray-300">{creative.ctr.toFixed(2)}%</p>
            </div>
            <div className="text-center">
              <p className="text-[9px] text-gray-600 uppercase tracking-wide">ROAS</p>
              <p className="text-xs font-bold text-gray-300">
                {creative.roas > 0 ? `${creative.roas}x` : "—"}
              </p>
            </div>
            {launchStatus === "Scaling" && (
              <div className="text-center">
                <p className="text-[9px] text-gray-600 uppercase tracking-wide">Growth</p>
                <p className={`text-xs font-bold ${spendGrowthPct >= 0 ? "text-blue-400" : "text-red-400"}`}>
                  {spendGrowthPct >= 0 ? "+" : ""}{spendGrowthPct}%
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function LaunchPage() {
  const { creatives, isLoading: loading, isRealData } = useCreativesContext();
  const [selectedCreative, setSelectedCreative] = useState<Creative | null>(null);
  const [statusFilter, setStatusFilter] = useState<LaunchStatus | "All">("All");

  const launchCreatives = useMemo((): LaunchCreative[] => {
    if (creatives.length === 0) return [];

    const spends = creatives.map((c) => c.spend).sort((a, b) => a - b);
    const roasArr = creatives.map((c) => c.roas).sort((a, b) => a - b);
    const ctrArr = creatives.map((c) => c.ctr).sort((a, b) => a - b);

    const mid = (arr: number[]) =>
      arr.length % 2 !== 0
        ? arr[Math.floor(arr.length / 2)]
        : (arr[Math.floor(arr.length / 2) - 1] + arr[Math.floor(arr.length / 2)]) / 2;

    const medianSpend = mid(spends);
    const medianRoas = mid(roasArr);
    const medianCtr = mid(ctrArr);

    return creatives.map((creative, idx) => {
      const growth = getSpendGrowthPct(creative.id);
      const status = computeLaunchStatus(
        creative,
        medianSpend,
        medianRoas,
        medianCtr,
        growth
      );
      const launchDate = getLaunchDate(creative.id, idx, creatives.length);
      return {
        creative,
        launchStatus: status,
        launchDate,
        spendGrowthPct: growth,
      };
    });
  }, [creatives]);

  const filtered = useMemo(() => {
    let list =
      statusFilter === "All"
        ? launchCreatives
        : launchCreatives.filter((lc) => lc.launchStatus === statusFilter);
    // Sort by launch date descending (most recent first)
    return [...list].sort(
      (a, b) =>
        new Date(b.launchDate).getTime() - new Date(a.launchDate).getTime()
    );
  }, [launchCreatives, statusFilter]);

  // Count by status
  const counts = useMemo(() => {
    const c: Record<LaunchStatus, number> = {
      Winner: 0,
      Scaling: 0,
      Declining: 0,
      Testing: 0,
    };
    launchCreatives.forEach((lc) => c[lc.launchStatus]++);
    return c;
  }, [launchCreatives]);

  const statusOptions: (LaunchStatus | "All")[] = [
    "All",
    "Winner",
    "Scaling",
    "Declining",
    "Testing",
  ];

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-violet-500 to-purple-700 flex items-center justify-center">
            <Rocket className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-white">Launch Analysis</h1>
            <p className="text-gray-400 text-sm mt-0.5">
              Track recently launched creatives and their performance status
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 text-xs px-3 py-1.5 rounded-full border border-gray-800 bg-gray-900">
          {isRealData ? (
            <>
              <Wifi className="w-3 h-3 text-green-400" />
              <span className="text-green-400">Live data</span>
            </>
          ) : (
            <>
              <Database className="w-3 h-3 text-gray-500" />
              <span className="text-gray-500">Demo data</span>
            </>
          )}
        </div>
      </div>

      {/* Status counter row */}
      {!loading && (
        <div className="grid grid-cols-4 gap-3">
          {(["Winner", "Scaling", "Declining", "Testing"] as LaunchStatus[]).map((s) => {
            const cfg = STATUS_CONFIG[s];
            const Icon = cfg.icon;
            return (
              <div
                key={s}
                className={`bg-gray-900 border ${cfg.borderClass} rounded-2xl p-4 flex items-center gap-3`}
              >
                <div
                  className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${cfg.badgeClass}`}
                >
                  <Icon className={`w-4 h-4 ${cfg.iconClass}`} />
                </div>
                <div>
                  <p className="text-[11px] text-gray-500 uppercase tracking-wide font-medium">
                    {cfg.label}
                  </p>
                  <p className="text-xl font-bold text-white">{counts[s]}</p>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Status filter */}
      {!loading && (
        <div className="flex gap-1 bg-gray-900 border border-gray-800 rounded-xl p-1 w-fit">
          {statusOptions.map((s) => {
            const cfg = s !== "All" ? STATUS_CONFIG[s] : null;
            return (
              <button
                key={s}
                onClick={() => setStatusFilter(s)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                  statusFilter === s
                    ? "bg-violet-600 text-white"
                    : "text-gray-400 hover:text-white"
                }`}
              >
                {cfg && <cfg.icon className="w-3.5 h-3.5" />}
                {s}
                {s !== "All" && (
                  <span className="text-[10px] opacity-70">({counts[s as LaunchStatus]})</span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {loading && (
        <div className="text-center py-12 text-gray-500 text-sm">
          Loading creatives...
        </div>
      )}

      {/* Creative list */}
      {!loading && (
        <div className="space-y-3">
          {filtered.map((item) => (
            <LaunchCard
              key={item.creative.id}
              item={item}
              onClick={() => setSelectedCreative(item.creative)}
            />
          ))}
          {filtered.length === 0 && (
            <div className="flex items-center justify-center h-40 text-gray-600">
              No creatives with status &quot;{statusFilter}&quot;.
            </div>
          )}
        </div>
      )}

      {/* Modal */}
      <CreativeModal
        creative={selectedCreative}
        onClose={() => setSelectedCreative(null)}
      />
    </div>
  );
}
