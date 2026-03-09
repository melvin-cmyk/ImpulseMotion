"use client";

import { useState, useEffect } from "react";
import { METRIC_LABELS, ReportMetric } from "@/lib/mock-reports";
import { mockCreatives } from "@/lib/mock-data";
import { Share2, Copy, Eye, Plus, Check, ExternalLink, Trash2, Loader2 } from "lucide-react";

interface Report {
  id: string;
  name: string;
  createdAt: string;
  periodFrom: string;
  periodTo: string;
  creativeIds: string[];
  metrics: ReportMetric[];
  views: number;
}

function formatDate(d: string) {
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function CopyButton({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  const link = `${typeof window !== "undefined" ? window.location.origin : ""}/share/${id}`;

  const handleCopy = () => {
    navigator.clipboard.writeText(link).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <button
      onClick={handleCopy}
      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-300 text-xs font-medium transition-colors"
    >
      {copied ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
      {copied ? "Copied!" : "Copy link"}
    </button>
  );
}

function NewReportDialog({
  onClose,
  onAdd,
}: {
  onClose: () => void;
  onAdd: (r: Report) => void;
}) {
  const [name, setName] = useState("");
  const [from, setFrom] = useState(new Date(Date.now() - 30 * 86400000).toISOString().split("T")[0]);
  const [to, setTo] = useState(new Date().toISOString().split("T")[0]);
  const [selectedCreatives, setSelectedCreatives] = useState<string[]>([]);
  const [selectedMetrics, setSelectedMetrics] = useState<ReportMetric[]>(["roas", "cpa", "ctr", "spend"]);
  const [loading, setLoading] = useState(false);

  const toggleCreative = (id: string) =>
    setSelectedCreatives((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );

  const toggleMetric = (m: ReportMetric) =>
    setSelectedMetrics((prev) =>
      prev.includes(m) ? prev.filter((x) => x !== m) : [...prev, m]
    );

  const handleCreate = async () => {
    if (!name.trim() || selectedCreatives.length === 0 || selectedMetrics.length === 0) return;
    setLoading(true);
    try {
      const res = await fetch("/api/reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          periodFrom: from,
          periodTo: to,
          creativeIds: selectedCreatives,
          metrics: selectedMetrics,
        }),
      });
      if (res.ok) {
        const report = await res.json();
        onAdd(report);
        onClose();
      }
    } finally {
      setLoading(false);
    }
  };

  const allMetrics: ReportMetric[] = ["roas", "cpa", "ctr", "hookRate", "holdRate", "spend"];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="bg-gray-900 border border-gray-700 rounded-2xl w-full max-w-lg mx-4 shadow-2xl">
        <div className="p-5 border-b border-gray-800">
          <h2 className="text-lg font-bold text-white">New Report</h2>
          <p className="text-gray-400 text-sm mt-0.5">Create a shareable link for your team</p>
        </div>

        <div className="p-5 space-y-4 max-h-[60vh] overflow-y-auto">
          <div>
            <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1.5">
              Report Name
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Top Winners March 2025"
              className="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-sm text-gray-200 placeholder-gray-600 outline-none focus:border-violet-500 transition-colors"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1.5">From</label>
              <input
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                className="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-sm text-gray-200 outline-none focus:border-violet-500 transition-colors"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1.5">To</label>
              <input
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                className="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-sm text-gray-200 outline-none focus:border-violet-500 transition-colors"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">
              Metrics to include
            </label>
            <div className="flex flex-wrap gap-2">
              {allMetrics.map((m) => (
                <button
                  key={m}
                  onClick={() => toggleMetric(m)}
                  className={`px-3 py-1 rounded-lg text-xs font-medium border transition-colors ${
                    selectedMetrics.includes(m)
                      ? "bg-violet-600 border-violet-600 text-white"
                      : "bg-gray-800 border-gray-700 text-gray-400 hover:text-gray-200"
                  }`}
                >
                  {METRIC_LABELS[m]}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">
              Creatives ({selectedCreatives.length} selected)
            </label>
            <div className="space-y-1 max-h-48 overflow-y-auto pr-1">
              {mockCreatives.map((c) => (
                <label
                  key={c.id}
                  className="flex items-center gap-3 p-2 rounded-lg hover:bg-gray-800 cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={selectedCreatives.includes(c.id)}
                    onChange={() => toggleCreative(c.id)}
                    className="accent-violet-500"
                  />
                  <span className="font-mono text-xs text-gray-300 truncate">{c.name}</span>
                  <span
                    className={`ml-auto text-xs font-semibold shrink-0 ${
                      c.roas >= 3 ? "text-green-400" : c.roas >= 2 ? "text-yellow-400" : "text-red-400"
                    }`}
                  >
                    {c.roas}x
                  </span>
                </label>
              ))}
            </div>
          </div>
        </div>

        <div className="p-5 border-t border-gray-800 flex gap-3 justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-xl text-sm text-gray-400 hover:text-gray-200 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleCreate}
            disabled={!name.trim() || selectedCreatives.length === 0 || loading}
            className="px-4 py-2 rounded-xl text-sm font-semibold bg-violet-600 hover:bg-violet-500 text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2"
          >
            {loading && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            Create Report
          </button>
        </div>
      </div>
    </div>
  );
}

export default function ReportsPage() {
  const [reports, setReports] = useState<Report[]>([]);
  const [loading, setLoading] = useState(true);
  const [showDialog, setShowDialog] = useState(false);

  useEffect(() => {
    fetch("/api/reports")
      .then((r) => r.json())
      .then((data) => setReports(Array.isArray(data) ? data : []))
      .finally(() => setLoading(false));
  }, []);

  const handleDelete = async (id: string) => {
    await fetch(`/api/reports/${id}`, { method: "DELETE" });
    setReports((prev) => prev.filter((r) => r.id !== id));
  };

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Share2 className="w-5 h-5 text-violet-400" />
            <h1 className="text-2xl font-bold text-white">Shareable Reports</h1>
          </div>
          <p className="text-gray-400 text-sm">
            Share performance data with your creative team — no login required
          </p>
        </div>
        <button
          onClick={() => setShowDialog(true)}
          className="flex items-center gap-2 px-4 py-2 rounded-xl bg-violet-600 hover:bg-violet-500 text-white text-sm font-semibold transition-colors"
        >
          <Plus className="w-4 h-4" />
          New Report
        </button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center h-48 text-gray-600 gap-2">
          <Loader2 className="w-5 h-5 animate-spin" />
          <span>Loading reports…</span>
        </div>
      ) : (
        <div className="space-y-3">
          {reports.map((report) => {
            const creatives = mockCreatives.filter((c) => report.creativeIds.includes(c.id));
            const avgRoas =
              creatives.length
                ? Math.round((creatives.reduce((s, c) => s + c.roas, 0) / creatives.length) * 100) / 100
                : 0;

            return (
              <div
                key={report.id}
                className="bg-gray-900 border border-gray-800 rounded-2xl p-5 hover:border-gray-700 transition-colors"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <h3 className="font-semibold text-white truncate">{report.name}</h3>
                    <p className="text-gray-500 text-xs mt-0.5">
                      {formatDate(report.periodFrom)} → {formatDate(report.periodTo)} ·{" "}
                      {report.creativeIds.length} creatives · avg ROAS{" "}
                      <span
                        className={`font-semibold ${
                          avgRoas >= 3 ? "text-green-400" : avgRoas >= 2 ? "text-yellow-400" : "text-red-400"
                        }`}
                      >
                        {avgRoas}x
                      </span>
                    </p>
                    <div className="flex flex-wrap gap-1.5 mt-2">
                      {report.metrics.map((m) => (
                        <span
                          key={m}
                          className="text-[10px] px-2 py-0.5 rounded-full bg-gray-800 text-gray-400 border border-gray-700"
                        >
                          {METRIC_LABELS[m]}
                        </span>
                      ))}
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <span className="flex items-center gap-1 text-xs text-gray-600">
                      <Eye className="w-3.5 h-3.5" />
                      {report.views}
                    </span>
                    <CopyButton id={report.id} />
                    <a
                      href={`/share/${report.id}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-violet-900/40 hover:bg-violet-900/70 text-violet-300 text-xs font-medium border border-violet-800/50 transition-colors"
                    >
                      <ExternalLink className="w-3.5 h-3.5" />
                      View
                    </a>
                    <button
                      onClick={() => handleDelete(report.id)}
                      className="p-1.5 rounded-lg text-gray-600 hover:text-red-400 hover:bg-gray-800 transition-colors"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            );
          })}

          {reports.length === 0 && (
            <div className="flex flex-col items-center justify-center h-48 text-gray-600 gap-2">
              <Share2 className="w-8 h-8" />
              <p>No reports yet. Create one to share with your team.</p>
            </div>
          )}
        </div>
      )}

      {showDialog && (
        <NewReportDialog
          onClose={() => setShowDialog(false)}
          onAdd={(r) => setReports((prev) => [r, ...prev])}
        />
      )}
    </div>
  );
}
