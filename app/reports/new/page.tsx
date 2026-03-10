"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useCreativesContext } from "@/lib/creatives-context";
import { createReport } from "@/lib/reports-store";
import { CreativeThumbnail } from "@/components/creative-thumbnail";
import { Creative } from "@/lib/mock-data";
import { ArrowLeft, Check, FileText } from "lucide-react";

// ── Step indicator ─────────────────────────────────────────────────────────────

function StepDot({ step, current, label }: { step: number; current: number; label: string }) {
  const done = step < current;
  const active = step === current;
  return (
    <div className="flex items-center gap-2">
      <div
        className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold transition-colors ${
          done
            ? "bg-violet-600 text-white"
            : active
            ? "bg-violet-600/30 border-2 border-violet-500 text-violet-300"
            : "bg-gray-800 border border-gray-700 text-gray-500"
        }`}
      >
        {done ? <Check className="w-3.5 h-3.5" /> : step}
      </div>
      <span
        className={`text-xs font-medium ${
          active ? "text-white" : done ? "text-gray-400" : "text-gray-600"
        }`}
      >
        {label}
      </span>
    </div>
  );
}

// ── Creative selector card ─────────────────────────────────────────────────────

function CreativeSelectCard({
  creative,
  selected,
  onToggle,
}: {
  creative: Creative;
  selected: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      onClick={onToggle}
      className={`relative text-left bg-[#111118] border rounded-2xl overflow-hidden transition-all ${
        selected
          ? "border-violet-500 ring-2 ring-violet-500/30"
          : "border-gray-800 hover:border-gray-600"
      }`}
    >
      {/* Checkmark overlay */}
      {selected && (
        <div className="absolute top-2 right-2 z-10 w-6 h-6 rounded-full bg-violet-600 flex items-center justify-center">
          <Check className="w-3.5 h-3.5 text-white" />
        </div>
      )}
      <CreativeThumbnail
        format={creative.format}
        thumbnailColor={creative.thumbnailColor}
        thumbnailUrl={creative.thumbnailUrl}
        videoUrl={creative.videoUrl}
        videoId={creative.videoId}
        className="h-28 w-full"
      />
      <div className="p-2.5">
        <p className="text-[11px] font-mono text-gray-300 truncate">{creative.name}</p>
        <div className="flex items-center justify-between mt-1">
          <span
            className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${
              creative.platform === "Meta"
                ? "bg-blue-900/60 text-blue-300"
                : "bg-pink-900/60 text-pink-300"
            }`}
          >
            {creative.platform}
          </span>
          <span
            className={`text-[11px] font-bold ${
              creative.roas >= 4
                ? "text-emerald-400"
                : creative.roas >= 2.5
                ? "text-blue-400"
                : creative.roas >= 1.5
                ? "text-amber-400"
                : "text-red-400"
            }`}
          >
            {creative.roas}x
          </span>
        </div>
      </div>
    </button>
  );
}

// ── Main wizard ───────────────────────────────────────────────────────────────

export default function NewReportPage() {
  const router = useRouter();
  const { creatives } = useCreativesContext();

  const [step, setStep] = useState(1);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [dateFrom, setDateFrom] = useState(
    new Date(Date.now() - 30 * 86_400_000).toISOString().split("T")[0]
  );
  const [dateTo, setDateTo] = useState(new Date().toISOString().split("T")[0]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  function toggleCreative(id: string) {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  }

  function selectAll() {
    setSelectedIds(creatives.map((c) => c.id));
  }

  function clearAll() {
    setSelectedIds([]);
  }

  function handleGenerate() {
    if (!title.trim() || selectedIds.length === 0) return;
    const report = createReport({
      title: title.trim(),
      description: description.trim() || undefined,
      dateRange: { from: dateFrom, to: dateTo },
      creativeIds: selectedIds,
    });
    router.push(`/reports/${report.id}`);
  }

  const canGoStep2 = title.trim().length > 0 && dateFrom && dateTo;
  const canGenerate = canGoStep2 && selectedIds.length > 0;

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link
          href="/reports"
          className="p-1.5 rounded-lg text-gray-500 hover:text-gray-300 hover:bg-gray-800 transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
        </Link>
        <div>
          <h1 className="text-2xl font-bold text-white">Create Report</h1>
          <p className="text-gray-400 text-sm mt-0.5">
            Build a shareable analytics snapshot for your team
          </p>
        </div>
      </div>

      {/* Step indicator */}
      <div className="flex items-center gap-6 bg-[#111118] border border-gray-800 rounded-2xl px-6 py-4">
        <StepDot step={1} current={step} label="Details" />
        <div className="flex-1 h-px bg-gray-800" />
        <StepDot step={2} current={step} label="Select Creatives" />
        <div className="flex-1 h-px bg-gray-800" />
        <StepDot step={3} current={step} label="Generate" />
      </div>

      {/* Step 1: Report name + date range */}
      {step === 1 && (
        <div className="bg-[#111118] border border-gray-800 rounded-2xl p-6 space-y-5">
          <div className="flex items-center gap-3 mb-1">
            <div className="w-9 h-9 rounded-xl bg-violet-500/20 flex items-center justify-center">
              <FileText className="w-4 h-4 text-violet-400" />
            </div>
            <div>
              <h2 className="font-semibold text-white">Report Details</h2>
              <p className="text-xs text-gray-500">Give your report a name and time window</p>
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1.5">
              Report Name <span className="text-violet-400">*</span>
            </label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Top Winners — March 2026"
              className="w-full bg-gray-900 border border-gray-700 rounded-xl px-3.5 py-2.5 text-sm text-gray-200 placeholder-gray-600 outline-none focus:border-violet-500 transition-colors"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1.5">
              Description <span className="text-gray-600">(optional)</span>
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Add context or notes for your team…"
              rows={2}
              className="w-full bg-gray-900 border border-gray-700 rounded-xl px-3.5 py-2.5 text-sm text-gray-200 placeholder-gray-600 outline-none focus:border-violet-500 transition-colors resize-none"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1.5">
                From <span className="text-violet-400">*</span>
              </label>
              <input
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                className="w-full bg-gray-900 border border-gray-700 rounded-xl px-3.5 py-2.5 text-sm text-gray-200 outline-none focus:border-violet-500 transition-colors"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1.5">
                To <span className="text-violet-400">*</span>
              </label>
              <input
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                className="w-full bg-gray-900 border border-gray-700 rounded-xl px-3.5 py-2.5 text-sm text-gray-200 outline-none focus:border-violet-500 transition-colors"
              />
            </div>
          </div>

          <div className="flex justify-end pt-2">
            <button
              onClick={() => setStep(2)}
              disabled={!canGoStep2}
              className="px-5 py-2 bg-violet-600 hover:bg-violet-500 text-white text-sm font-medium rounded-xl transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Next: Select Creatives
            </button>
          </div>
        </div>
      )}

      {/* Step 2: Creative selector */}
      {step === 2 && (
        <div className="bg-[#111118] border border-gray-800 rounded-2xl p-6 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="font-semibold text-white">Select Creatives</h2>
              <p className="text-xs text-gray-500 mt-0.5">
                {selectedIds.length} of {creatives.length} selected
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={selectAll}
                className="text-xs text-violet-400 hover:text-violet-300 px-2.5 py-1 rounded-lg hover:bg-violet-500/10 transition-colors"
              >
                Select all
              </button>
              <button
                onClick={clearAll}
                className="text-xs text-gray-500 hover:text-gray-300 px-2.5 py-1 rounded-lg hover:bg-gray-800 transition-colors"
              >
                Clear
              </button>
            </div>
          </div>

          {creatives.length === 0 && (
            <div className="flex items-center justify-center h-40 text-gray-600 text-sm">
              No creatives available. Connect an ad account to load data.
            </div>
          )}

          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 max-h-[50vh] overflow-y-auto pr-1">
            {creatives.map((c) => (
              <CreativeSelectCard
                key={c.id}
                creative={c}
                selected={selectedIds.includes(c.id)}
                onToggle={() => toggleCreative(c.id)}
              />
            ))}
          </div>

          <div className="flex items-center justify-between pt-2 border-t border-gray-800">
            <button
              onClick={() => setStep(1)}
              className="px-4 py-2 text-sm text-gray-400 hover:text-gray-200 transition-colors"
            >
              Back
            </button>
            <button
              onClick={() => setStep(3)}
              disabled={selectedIds.length === 0}
              className="px-5 py-2 bg-violet-600 hover:bg-violet-500 text-white text-sm font-medium rounded-xl transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Next: Review
            </button>
          </div>
        </div>
      )}

      {/* Step 3: Review + generate */}
      {step === 3 && (
        <div className="bg-[#111118] border border-gray-800 rounded-2xl p-6 space-y-5">
          <div>
            <h2 className="font-semibold text-white">Review & Generate</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              Confirm your report settings before saving
            </p>
          </div>

          <div className="space-y-3">
            <div className="flex items-start gap-3 p-4 bg-gray-900 rounded-xl border border-gray-800">
              <div className="flex-1 min-w-0">
                <p className="text-[11px] text-gray-500 uppercase tracking-wide">Report Name</p>
                <p className="text-sm font-semibold text-white mt-0.5 truncate">{title}</p>
              </div>
            </div>

            {description && (
              <div className="p-4 bg-gray-900 rounded-xl border border-gray-800">
                <p className="text-[11px] text-gray-500 uppercase tracking-wide mb-0.5">Description</p>
                <p className="text-sm text-gray-300">{description}</p>
              </div>
            )}

            <div className="grid grid-cols-2 gap-3">
              <div className="p-4 bg-gray-900 rounded-xl border border-gray-800">
                <p className="text-[11px] text-gray-500 uppercase tracking-wide">Date Range</p>
                <p className="text-sm text-white mt-0.5">
                  {new Date(dateFrom).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                  {" – "}
                  {new Date(dateTo).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                </p>
              </div>
              <div className="p-4 bg-gray-900 rounded-xl border border-gray-800">
                <p className="text-[11px] text-gray-500 uppercase tracking-wide">Creatives</p>
                <p className="text-sm text-white mt-0.5">{selectedIds.length} selected</p>
              </div>
            </div>
          </div>

          <div className="flex items-center justify-between pt-2 border-t border-gray-800">
            <button
              onClick={() => setStep(2)}
              className="px-4 py-2 text-sm text-gray-400 hover:text-gray-200 transition-colors"
            >
              Back
            </button>
            <button
              onClick={handleGenerate}
              disabled={!canGenerate}
              className="flex items-center gap-2 px-5 py-2 bg-violet-600 hover:bg-violet-500 text-white text-sm font-semibold rounded-xl transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <FileText className="w-4 h-4" />
              Generate Report
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
