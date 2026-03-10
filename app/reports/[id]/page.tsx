"use client";

import { useState, useEffect, use } from "react";
import Link from "next/link";
import { useCreativesContext } from "@/lib/creatives-context";
import { getReport, Report } from "@/lib/reports-store";
import { Creative } from "@/lib/mock-data";
import { CreativeThumbnail } from "@/components/creative-thumbnail";
import {
  ArrowLeft,
  Share2,
  Check,
  Download,
  Calendar,
  DollarSign,
  MousePointerClick,
  TrendingUp,
  Layers,
  FileText,
} from "lucide-react";

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

// ── KPI Summary card ──────────────────────────────────────────────────────────

interface KpiCardProps {
  label: string;
  value: string;
  sub?: string;
  icon: React.ElementType;
  accent: string;
}

function KpiCard({ label, value, sub, icon: Icon, accent }: KpiCardProps) {
  return (
    <div className="bg-[#111118] border border-gray-800 rounded-2xl p-4 flex items-start gap-3">
      <div className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${accent}`}>
        <Icon className="w-4 h-4" />
      </div>
      <div>
        <p className="text-[11px] text-gray-500 uppercase tracking-wide font-medium">{label}</p>
        <p className="text-xl font-bold text-white mt-0.5">{value}</p>
        {sub && <p className="text-[11px] text-gray-500 mt-0.5">{sub}</p>}
      </div>
    </div>
  );
}

// ── Creative mini-card ────────────────────────────────────────────────────────

function CreativeMiniCard({ creative }: { creative: Creative }) {
  const roasColor =
    creative.roas >= 4
      ? "text-emerald-400"
      : creative.roas >= 2.5
      ? "text-blue-400"
      : creative.roas >= 1.5
      ? "text-amber-400"
      : "text-red-400";

  return (
    <div className="bg-[#111118] border border-gray-800 rounded-2xl overflow-hidden hover:border-violet-700/50 transition-colors">
      <div className="relative">
        <CreativeThumbnail
          format={creative.format}
          thumbnailColor={creative.thumbnailColor}
          thumbnailUrl={creative.thumbnailUrl}
          videoUrl={creative.videoUrl}
          videoId={creative.videoId}
          className="h-32"
        />
        <div className="absolute top-2 left-2">
          <span
            className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
              creative.platform === "Meta"
                ? "bg-blue-900/70 text-blue-300 border border-blue-800"
                : "bg-pink-900/70 text-pink-300 border border-pink-800"
            }`}
          >
            {creative.platform}
          </span>
        </div>
        <div className="absolute bottom-2 left-2 text-[10px] font-medium text-white/60 uppercase tracking-wide">
          {creative.format}
        </div>
      </div>

      <div className="p-3 space-y-2">
        <p className="text-xs font-mono text-gray-300 truncate" title={creative.name}>
          {creative.name}
        </p>
        <div className="grid grid-cols-3 gap-1 pt-2 border-t border-gray-800">
          <div className="flex flex-col items-center">
            <span className="text-[10px] text-gray-500 uppercase">Spend</span>
            <span className="text-xs font-semibold text-gray-200">
              ${(creative.spend / 1000).toFixed(1)}k
            </span>
          </div>
          <div className="flex flex-col items-center">
            <span className="text-[10px] text-gray-500 uppercase">ROAS</span>
            <span className={`text-xs font-semibold ${roasColor}`}>{creative.roas}x</span>
          </div>
          <div className="flex flex-col items-center">
            <span className="text-[10px] text-gray-500 uppercase">CTR</span>
            <span className="text-xs font-semibold text-gray-200">{creative.ctr}%</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Share button ──────────────────────────────────────────────────────────────

function ShareButton({ reportId }: { reportId: string }) {
  const [copied, setCopied] = useState(false);

  function handleShare() {
    const url = `${window.location.origin}/reports/${reportId}`;
    navigator.clipboard.writeText(url).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  }

  return (
    <button
      onClick={handleShare}
      className="flex items-center gap-2 px-4 py-2 bg-[#111118] border border-gray-700 hover:border-violet-500 text-gray-300 hover:text-violet-300 text-sm font-medium rounded-xl transition-colors"
    >
      {copied ? (
        <>
          <Check className="w-4 h-4 text-green-400" />
          <span className="text-green-400">Copied!</span>
        </>
      ) : (
        <>
          <Share2 className="w-4 h-4" />
          Share
        </>
      )}
    </button>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function ReportDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const [report, setReport] = useState<Report | null>(null);
  const [notFound, setNotFound] = useState(false);
  const { creatives } = useCreativesContext();

  useEffect(() => {
    const r = getReport(id);
    if (r) {
      setReport(r);
    } else {
      setNotFound(true);
    }
  }, [id]);

  if (notFound) {
    return (
      <div className="p-6 flex flex-col items-center justify-center h-64 gap-4">
        <FileText className="w-10 h-10 text-gray-600" />
        <p className="text-gray-400 font-medium">Report not found</p>
        <Link
          href="/reports"
          className="flex items-center gap-2 text-violet-400 hover:text-violet-300 text-sm transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Reports
        </Link>
      </div>
    );
  }

  if (!report) {
    return (
      <div className="p-6 text-center text-gray-600 text-sm">Loading report…</div>
    );
  }

  // Filter creatives that belong to this report
  const reportCreatives = creatives.filter((c) => report.creativeIds.includes(c.id));

  // KPI calculations
  const totalSpend = reportCreatives.reduce((s, c) => s + c.spend, 0);
  const avgCtr =
    reportCreatives.length > 0
      ? reportCreatives.reduce((s, c) => s + c.ctr, 0) / reportCreatives.length
      : 0;
  const roasCreatives = reportCreatives.filter((c) => c.roas > 0);
  const avgRoas =
    roasCreatives.length > 0
      ? roasCreatives.reduce((s, c) => s + c.roas, 0) / roasCreatives.length
      : 0;

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3 min-w-0">
          <Link
            href="/reports"
            className="mt-1 p-1.5 rounded-lg text-gray-500 hover:text-gray-300 hover:bg-gray-800 transition-colors shrink-0"
          >
            <ArrowLeft className="w-4 h-4" />
          </Link>
          <div className="min-w-0">
            <h1 className="text-2xl font-bold text-white truncate">{report.title}</h1>
            {report.description && (
              <p className="text-gray-400 text-sm mt-0.5">{report.description}</p>
            )}
            <div className="flex items-center gap-4 mt-1.5">
              <span className="flex items-center gap-1.5 text-xs text-gray-500">
                <Calendar className="w-3.5 h-3.5" />
                {formatDate(report.dateRange.from)} – {formatDate(report.dateRange.to)}
              </span>
              <span className="flex items-center gap-1.5 text-xs text-gray-500">
                <Layers className="w-3.5 h-3.5" />
                {report.creativeIds.length} creatives
              </span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <ShareButton reportId={report.id} />
          <button
            className="flex items-center gap-2 px-4 py-2 bg-[#111118] border border-gray-700 hover:border-gray-500 text-gray-400 hover:text-gray-200 text-sm font-medium rounded-xl transition-colors"
            title="PDF export (coming soon)"
          >
            <Download className="w-4 h-4" />
            PDF
          </button>
        </div>
      </div>

      {/* KPI Summary */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <KpiCard
          label="Total Spend"
          value={
            totalSpend >= 1000
              ? `$${(totalSpend / 1000).toFixed(1)}k`
              : `$${totalSpend.toFixed(0)}`
          }
          sub={`across ${reportCreatives.length} creatives`}
          icon={DollarSign}
          accent="bg-violet-500/20 text-violet-400"
        />
        <KpiCard
          label="Avg CTR"
          value={`${avgCtr.toFixed(2)}%`}
          sub="click-through rate"
          icon={MousePointerClick}
          accent="bg-blue-500/20 text-blue-400"
        />
        <KpiCard
          label="Avg ROAS"
          value={avgRoas > 0 ? `${avgRoas.toFixed(2)}x` : "—"}
          sub="return on ad spend"
          icon={TrendingUp}
          accent="bg-emerald-500/20 text-emerald-400"
        />
      </div>

      {/* Creatives grid */}
      <div>
        <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wide mb-3">
          Creatives in this Report
        </h2>

        {reportCreatives.length === 0 && (
          <div className="flex items-center justify-center h-40 border border-dashed border-gray-800 rounded-2xl text-gray-600 text-sm">
            No matching creatives found. They may have been removed from the feed.
          </div>
        )}

        {reportCreatives.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {reportCreatives.map((c) => (
              <CreativeMiniCard key={c.id} creative={c} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
