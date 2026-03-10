"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { Plus, FileText, Calendar, Layers, Trash2, ArrowRight, Share2 } from "lucide-react";
import { getReports, deleteReport, Report } from "@/lib/reports-store";

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function ReportCard({ report, onDelete }: { report: Report; onDelete: (id: string) => void }) {
  const [confirming, setConfirming] = useState(false);

  function handleDelete(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (confirming) {
      onDelete(report.id);
    } else {
      setConfirming(true);
      setTimeout(() => setConfirming(false), 2500);
    }
  }

  return (
    <Link
      href={`/reports/${report.id}`}
      className="group relative bg-[#111118] border border-gray-800 rounded-2xl overflow-hidden hover:border-violet-700/60 hover:shadow-xl hover:shadow-violet-900/20 transition-all duration-200 flex flex-col"
    >
      {/* Thumbnail / header strip */}
      <div className="h-28 bg-gradient-to-br from-violet-900/40 via-purple-900/20 to-[#111118] flex items-center justify-center border-b border-gray-800 relative">
        <FileText className="w-10 h-10 text-violet-500/50" />
        <div className="absolute top-2 right-2">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-violet-400 bg-violet-500/10 border border-violet-500/20 px-2 py-0.5 rounded-full">
            Report
          </span>
        </div>
      </div>

      {/* Body */}
      <div className="p-4 flex-1 flex flex-col gap-2">
        <h3 className="text-sm font-semibold text-white truncate group-hover:text-violet-300 transition-colors">
          {report.title}
        </h3>
        {report.description && (
          <p className="text-xs text-gray-500 line-clamp-2">{report.description}</p>
        )}

        <div className="flex flex-wrap gap-x-4 gap-y-1.5 mt-auto pt-2 border-t border-gray-800">
          <span className="flex items-center gap-1.5 text-[11px] text-gray-500">
            <Calendar className="w-3 h-3" />
            {formatDate(report.dateRange.from)} – {formatDate(report.dateRange.to)}
          </span>
          <span className="flex items-center gap-1.5 text-[11px] text-gray-500">
            <Layers className="w-3 h-3" />
            {report.creativeIds.length} creative{report.creativeIds.length !== 1 ? "s" : ""}
          </span>
        </div>

        <div className="flex items-center justify-between mt-2">
          <span className="text-[10px] text-gray-600">Created {formatDate(report.createdAt)}</span>
          <div className="flex items-center gap-2">
            <button
              onClick={handleDelete}
              className={`p-1 rounded-lg transition-colors ${
                confirming
                  ? "bg-red-500/20 text-red-400"
                  : "text-gray-600 hover:text-red-400 hover:bg-red-500/10"
              }`}
              title={confirming ? "Click again to confirm delete" : "Delete report"}
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
            <ArrowRight className="w-4 h-4 text-gray-600 group-hover:text-violet-400 transition-colors" />
          </div>
        </div>
      </div>
    </Link>
  );
}

export default function ReportsPage() {
  const [reports, setReports] = useState<Report[]>([]);

  useEffect(() => {
    setReports(getReports());
  }, []);

  function handleDelete(id: string) {
    deleteReport(id);
    setReports(getReports());
  }

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Share2 className="w-5 h-5 text-violet-400" />
            <h1 className="text-2xl font-bold text-white">Reports</h1>
          </div>
          <p className="text-gray-400 text-sm mt-0.5">
            {reports.length === 0
              ? "No reports yet"
              : `${reports.length} saved report${reports.length !== 1 ? "s" : ""}`}
          </p>
        </div>
        <Link
          href="/reports/new"
          className="flex items-center gap-2 px-4 py-2 bg-violet-600 hover:bg-violet-500 text-white text-sm font-medium rounded-xl transition-colors"
        >
          <Plus className="w-4 h-4" />
          Create Report
        </Link>
      </div>

      {/* Empty state */}
      {reports.length === 0 && (
        <div className="flex flex-col items-center justify-center h-72 border border-dashed border-gray-800 rounded-2xl gap-4">
          <div className="w-14 h-14 rounded-2xl bg-violet-500/10 flex items-center justify-center">
            <FileText className="w-7 h-7 text-violet-500/60" />
          </div>
          <div className="text-center">
            <p className="text-gray-400 font-medium">No reports yet</p>
            <p className="text-gray-600 text-sm mt-1">
              Create your first report to share creative analytics
            </p>
          </div>
          <Link
            href="/reports/new"
            className="flex items-center gap-2 px-4 py-2 bg-violet-600 hover:bg-violet-500 text-white text-sm font-medium rounded-xl transition-colors"
          >
            <Plus className="w-4 h-4" />
            Create Report
          </Link>
        </div>
      )}

      {/* Grid */}
      {reports.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {reports.map((report) => (
            <ReportCard key={report.id} report={report} onDelete={handleDelete} />
          ))}
        </div>
      )}
    </div>
  );
}
