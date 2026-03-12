"use client";

import { HelpCircle } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { METRIC_DEFINITIONS } from "@/lib/metric-definitions";
import { useState } from "react";

interface MetricInfoButtonProps {
  metricKey: string;
  className?: string;
}

export function MetricInfoButton({ metricKey, className = "" }: MetricInfoButtonProps) {
  const [open, setOpen] = useState(false);
  const def = METRIC_DEFINITIONS[metricKey];
  if (!def) return null;

  return (
    <>
      <button
        onClick={(e) => { e.stopPropagation(); setOpen(true); }}
        className={`inline-flex items-center justify-center w-3.5 h-3.5 rounded-full text-gray-600 hover:text-violet-400 transition-colors shrink-0 ${className}`}
        title={`Comment est calculé ${def.label} ?`}
        aria-label={`Info sur ${def.label}`}
      >
        <HelpCircle className="w-3.5 h-3.5" />
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="bg-gray-950 border border-gray-800 text-white max-w-md">
          <DialogHeader>
            <DialogTitle className="text-white flex items-center gap-2">
              <span className="w-6 h-6 rounded-lg bg-violet-600/20 flex items-center justify-center shrink-0">
                <HelpCircle className="w-3.5 h-3.5 text-violet-400" />
              </span>
              {def.label}
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4 text-sm">
            <p className="text-gray-300 leading-relaxed">{def.description}</p>

            <div className="bg-gray-900 border border-gray-800 rounded-xl p-3 space-y-1">
              <p className="text-[11px] uppercase tracking-widest text-gray-500 font-semibold">Formule</p>
              <p className="text-violet-300 font-mono text-sm leading-relaxed">{def.formula}</p>
            </div>

            {def.benchmark && (
              <div className="bg-emerald-950/30 border border-emerald-900/40 rounded-xl p-3 space-y-1">
                <p className="text-[11px] uppercase tracking-widest text-emerald-600 font-semibold">Benchmark</p>
                <p className="text-emerald-300 text-sm">{def.benchmark}</p>
              </div>
            )}

            {def.note && (
              <p className="text-xs text-gray-500 italic">{def.note}</p>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
