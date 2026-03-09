import { mockReports, METRIC_LABELS, ReportMetric } from "@/lib/mock-reports";
import { mockCreatives } from "@/lib/mock-data";
import { Zap } from "lucide-react";

function formatDate(d: string) {
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function metricValue(creative: (typeof mockCreatives)[0], metric: ReportMetric): string {
  switch (metric) {
    case "roas": return `${creative.roas}x`;
    case "cpa": return `$${creative.cpa}`;
    case "ctr": return `${creative.ctr}%`;
    case "hookRate": return creative.hookRate > 0 ? `${creative.hookRate}%` : "—";
    case "holdRate": return creative.holdRate > 0 ? `${creative.holdRate}%` : "—";
    case "spend": return `$${(creative.spend / 1000).toFixed(1)}k`;
  }
}

function metricColor(creative: (typeof mockCreatives)[0], metric: ReportMetric): string {
  if (metric === "roas") {
    return creative.roas >= 3 ? "text-green-400" : creative.roas >= 2 ? "text-yellow-400" : "text-red-400";
  }
  return "text-gray-300";
}

export default async function SharePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const report = mockReports.find((r) => r.id === id);

  if (!report) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center text-gray-500">
        Report not found.
      </div>
    );
  }

  const creatives = mockCreatives.filter((c) => report.creativeIds.includes(c.id));

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      {/* Header */}
      <header className="border-b border-gray-800 px-8 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-gradient-to-br from-violet-500 to-purple-700 rounded-xl flex items-center justify-center">
            <Zap className="w-4 h-4 text-white" />
          </div>
          <span className="font-bold text-white">ImpulseMotion</span>
        </div>
        <span className="text-xs text-gray-500 bg-gray-900 border border-gray-800 px-3 py-1 rounded-full">
          Shared Report
        </span>
      </header>

      {/* Content */}
      <main className="max-w-4xl mx-auto px-8 py-10 space-y-8">
        {/* Title */}
        <div>
          <h1 className="text-3xl font-bold text-white">{report.name}</h1>
          <p className="text-gray-400 mt-1 text-sm">
            {formatDate(report.period.from)} — {formatDate(report.period.to)} ·{" "}
            {creatives.length} creatives
          </p>
        </div>

        {/* Summary stats */}
        <div className="grid grid-cols-3 gap-4">
          {[
            {
              label: "Avg ROAS",
              value: `${(creatives.reduce((s, c) => s + c.roas, 0) / creatives.length).toFixed(2)}x`,
              color: "text-green-400",
            },
            {
              label: "Avg CPA",
              value: `$${(creatives.reduce((s, c) => s + c.cpa, 0) / creatives.length).toFixed(0)}`,
              color: "text-gray-200",
            },
            {
              label: "Total Spend",
              value: `$${(creatives.reduce((s, c) => s + c.spend, 0) / 1000).toFixed(1)}k`,
              color: "text-gray-200",
            },
          ].map((stat) => (
            <div key={stat.label} className="bg-gray-900 border border-gray-800 rounded-xl p-4">
              <p className="text-xs text-gray-500 uppercase tracking-wide">{stat.label}</p>
              <p className={`text-2xl font-bold mt-1 ${stat.color}`}>{stat.value}</p>
            </div>
          ))}
        </div>

        {/* Table */}
        <div className="bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-gray-500 text-xs uppercase tracking-wide border-b border-gray-800">
                  <th className="text-left px-5 py-3">Creative</th>
                  <th className="text-left px-3 py-3">Platform</th>
                  <th className="text-left px-3 py-3">Status</th>
                  {report.metrics.map((m) => (
                    <th key={m} className="text-right px-3 py-3">
                      {METRIC_LABELS[m]}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {creatives
                  .sort((a, b) => b.roas - a.roas)
                  .map((c) => (
                    <tr key={c.id} className="border-b border-gray-800/50 hover:bg-gray-800/20">
                      <td className="px-5 py-3">
                        <span className="font-mono text-xs text-gray-300">{c.name}</span>
                      </td>
                      <td className="px-3 py-3">
                        <span
                          className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
                            c.platform === "Meta"
                              ? "bg-blue-900/70 text-blue-300 border border-blue-800"
                              : "bg-pink-900/70 text-pink-300 border border-pink-800"
                          }`}
                        >
                          {c.platform}
                        </span>
                      </td>
                      <td className="px-3 py-3">
                        <span className="text-xs">
                          {c.status === "Winner" ? "🏆" : c.status === "Loser" ? "❌" : c.status === "Fatigued" ? "⚠️" : "●"}{" "}
                          {c.status}
                        </span>
                      </td>
                      {report.metrics.map((m) => (
                        <td key={m} className={`text-right px-3 py-3 font-semibold ${metricColor(c, m)}`}>
                          {metricValue(c, m)}
                        </td>
                      ))}
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-gray-800 px-8 py-4 text-center text-xs text-gray-600">
        Powered by{" "}
        <span className="font-semibold text-gray-500">ImpulseMotion</span>
        {" "}· Ad Creative Analytics
      </footer>
    </div>
  );
}
