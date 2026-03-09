import {
  mockCreatives,
  getTotalSpend,
  getAvgRoas,
  getAvgCpa,
  getActiveCount,
  getTopByRoas,
} from "@/lib/mock-data";
import { DollarSign, TrendingUp, Target, Layers } from "lucide-react";

function StatCard({
  title,
  value,
  sub,
  icon: Icon,
  color,
}: {
  title: string;
  value: string;
  sub: string;
  icon: React.ElementType;
  color: string;
}) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5 flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="text-sm text-gray-400 font-medium">{title}</span>
        <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${color}`}>
          <Icon className="w-4 h-4 text-white" />
        </div>
      </div>
      <div>
        <p className="text-2xl font-bold text-white">{value}</p>
        <p className="text-xs text-gray-500 mt-1">{sub}</p>
      </div>
    </div>
  );
}

function PlatformBadge({ platform }: { platform: string }) {
  return (
    <span
      className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
        platform === "Meta"
          ? "bg-blue-900/60 text-blue-300"
          : "bg-pink-900/60 text-pink-300"
      }`}
    >
      {platform}
    </span>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    Winner: "bg-green-900/60 text-green-300",
    Loser: "bg-red-900/60 text-red-300",
    Fatigued: "bg-orange-900/60 text-orange-300",
    Active: "bg-blue-900/60 text-blue-300",
  };
  const icons: Record<string, string> = {
    Winner: "🏆",
    Loser: "❌",
    Fatigued: "⚠️",
    Active: "●",
  };
  return (
    <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${map[status] ?? ""}`}>
      {icons[status]} {status}
    </span>
  );
}

export default function DashboardPage() {
  const totalSpend = getTotalSpend();
  const avgRoas = getAvgRoas();
  const avgCpa = getAvgCpa();
  const activeCount = getActiveCount();
  const topCreatives = getTopByRoas(5);

  const metaCount = mockCreatives.filter((c) => c.platform === "Meta").length;
  const tiktokCount = mockCreatives.filter((c) => c.platform === "TikTok").length;

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Overview</h1>
          <p className="text-gray-400 text-sm mt-0.5">All creative performance — last 30 days</p>
        </div>
        <div className="flex gap-2">
          {["All", "Meta", "TikTok"].map((p) => (
            <button
              key={p}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                p === "All"
                  ? "bg-violet-600 text-white"
                  : "bg-gray-800 text-gray-400 hover:text-white hover:bg-gray-700"
              }`}
            >
              {p}
            </button>
          ))}
          <div className="w-px bg-gray-700 mx-1" />
          {["7d", "30d", "90d"].map((d) => (
            <button
              key={d}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                d === "30d"
                  ? "bg-violet-600 text-white"
                  : "bg-gray-800 text-gray-400 hover:text-white hover:bg-gray-700"
              }`}
            >
              {d}
            </button>
          ))}
        </div>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          title="Total Spend"
          value={`$${(totalSpend / 1000).toFixed(1)}k`}
          sub={`${metaCount} Meta · ${tiktokCount} TikTok creatives`}
          icon={DollarSign}
          color="bg-violet-600"
        />
        <StatCard
          title="Avg ROAS"
          value={`${avgRoas.toFixed(2)}x`}
          sub="Return on ad spend"
          icon={TrendingUp}
          color="bg-emerald-600"
        />
        <StatCard
          title="Avg CPA"
          value={`$${avgCpa.toFixed(2)}`}
          sub="Cost per acquisition"
          icon={Target}
          color="bg-orange-600"
        />
        <StatCard
          title="Active Creatives"
          value={`${activeCount}`}
          sub={`of ${mockCreatives.length} total`}
          icon={Layers}
          color="bg-blue-600"
        />
      </div>

      {/* Platform Breakdown */}
      <div className="grid grid-cols-2 gap-4">
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5">
          <h2 className="text-sm font-semibold text-gray-400 mb-4">Platform Split</h2>
          <div className="space-y-3">
            <div>
              <div className="flex justify-between text-sm mb-1">
                <span className="text-blue-300 font-medium">Meta</span>
                <span className="text-gray-400">{metaCount} creatives</span>
              </div>
              <div className="h-2 bg-gray-800 rounded-full overflow-hidden">
                <div
                  className="h-full bg-blue-500 rounded-full"
                  style={{ width: `${(metaCount / mockCreatives.length) * 100}%` }}
                />
              </div>
            </div>
            <div>
              <div className="flex justify-between text-sm mb-1">
                <span className="text-pink-300 font-medium">TikTok</span>
                <span className="text-gray-400">{tiktokCount} creatives</span>
              </div>
              <div className="h-2 bg-gray-800 rounded-full overflow-hidden">
                <div
                  className="h-full bg-pink-500 rounded-full"
                  style={{ width: `${(tiktokCount / mockCreatives.length) * 100}%` }}
                />
              </div>
            </div>
          </div>
        </div>

        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5">
          <h2 className="text-sm font-semibold text-gray-400 mb-4">Status Breakdown</h2>
          <div className="grid grid-cols-2 gap-3">
            {(["Winner", "Active", "Fatigued", "Loser"] as const).map((s) => {
              const count = mockCreatives.filter((c) => c.status === s).length;
              return (
                <div key={s} className="flex items-center gap-2">
                  <StatusBadge status={s} />
                  <span className="text-gray-300 font-semibold">{count}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Top Performers */}
      <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5">
        <h2 className="text-base font-semibold text-white mb-4">Top Performers by ROAS</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-gray-500 border-b border-gray-800">
                <th className="text-left pb-3 font-medium">#</th>
                <th className="text-left pb-3 font-medium">Creative</th>
                <th className="text-left pb-3 font-medium">Platform</th>
                <th className="text-left pb-3 font-medium">Status</th>
                <th className="text-right pb-3 font-medium">ROAS</th>
                <th className="text-right pb-3 font-medium">Spend</th>
                <th className="text-right pb-3 font-medium">CPA</th>
                <th className="text-right pb-3 font-medium">CTR</th>
              </tr>
            </thead>
            <tbody>
              {topCreatives.map((c, i) => (
                <tr
                  key={c.id}
                  className="border-b border-gray-800/50 hover:bg-gray-800/30 transition-colors"
                >
                  <td className="py-3 text-gray-500 font-mono">{i + 1}</td>
                  <td className="py-3">
                    <span className="text-white font-medium font-mono text-xs">{c.name}</span>
                  </td>
                  <td className="py-3">
                    <PlatformBadge platform={c.platform} />
                  </td>
                  <td className="py-3">
                    <StatusBadge status={c.status} />
                  </td>
                  <td className="py-3 text-right">
                    <span className="text-emerald-400 font-semibold">{c.roas}x</span>
                  </td>
                  <td className="py-3 text-right text-gray-300">
                    ${c.spend.toLocaleString()}
                  </td>
                  <td className="py-3 text-right text-gray-300">${c.cpa}</td>
                  <td className="py-3 text-right text-gray-300">{c.ctr}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
